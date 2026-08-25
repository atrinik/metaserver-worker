import { WorkerEntrypoint } from "cloudflare:workers";

import type { CoreEnv } from "./core-env";
import {
  RENDEZVOUS_TERMINAL_OUTCOMES,
} from "./rendezvous-contract";
import type { RendezvousTerminalOutcome } from "./rendezvous-contract";
import { normalizeRendezvousTerminalOutcome } from "./rendezvous-metrics";
import { constantTimeEqual } from "./protocol";

export const RENDEZVOUS_HEALTH_SCHEMA = "rendezvous-health-v1";
export const INTERNAL_RENDEZVOUS_HEALTH_URL =
  "https://internal.atrinik.invalid/v1/rendezvous-health";
export const RENDEZVOUS_HEALTH_WINDOW_SECONDS = 300;
export const RENDEZVOUS_HEALTH_FRESHNESS_SECONDS =
  RENDEZVOUS_HEALTH_WINDOW_SECONDS;
export const RENDEZVOUS_HEALTH_MAX_COUNTER = 1_000_000;
export const RENDEZVOUS_HEALTH_MAX_REQUEST_BYTES = 512;

const MAX_TIMESTAMP = 9_007_199_254_740_991;
const MAX_OBSERVATION_GENERATION = MAX_TIMESTAMP;
const AUTHORIZATION_HEADER = "Authorization";
const AUTHORIZATION_PATTERN = /^Bearer (.+)$/;
const HEALTH_REQUEST_HEADERS = new Set([
  "authorization",
  "content-length",
  "content-type",
  "host",
  "transfer-encoding",
]);
const HEALTH_RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json",
  "X-Content-Type-Options": "nosniff",
} as const;

export type RendezvousHealthCanaryType = "route" | "end_to_end";
export type RendezvousHealthCanaryRoute = "reachable" | "failed";
export type RendezvousHealthCanarySignal =
  | "not_observed"
  | "passed"
  | "failed";

export interface RendezvousHealthCanaryObservation {
  readonly type: RendezvousHealthCanaryType;
  readonly route: RendezvousHealthCanaryRoute;
  readonly authenticatedControl: RendezvousHealthCanarySignal;
  readonly recentAdmission: RendezvousHealthCanarySignal;
}

export type RendezvousHealthStatus =
  | "healthy"
  | "failed"
  | "stale"
  | "no_usable_observation";

export interface RendezvousHealthSnapshot {
  readonly schema: typeof RENDEZVOUS_HEALTH_SCHEMA;
  readonly observation_generation: number;
  readonly source_timestamp: number | null;
  readonly observation_window: {
    readonly started_at: number | null;
    readonly duration_seconds: typeof RENDEZVOUS_HEALTH_WINDOW_SECONDS;
    readonly ended_at: number | null;
  };
  readonly freshness: {
    readonly state: "fresh" | "stale" | "no_observation";
    readonly age_seconds: number | null;
    readonly maximum_age_seconds: typeof RENDEZVOUS_HEALTH_FRESHNESS_SECONDS;
  };
  readonly status: RendezvousHealthStatus;
  readonly recent_authenticated_admissions: number;
  readonly recent_sessions: {
    readonly total: number;
    readonly outcomes: Readonly<Record<RendezvousTerminalOutcome, number>>;
  };
  readonly canary: {
    readonly type: "none" | RendezvousHealthCanaryType;
    readonly route: "not_observed" | RendezvousHealthCanaryRoute;
    readonly authenticated_control: RendezvousHealthCanarySignal;
    readonly recent_admission: RendezvousHealthCanarySignal;
    readonly observed_at: number | null;
  };
  readonly reason:
    | "no_observation"
    | "malformed_observation"
    | "stale_source"
    | "canary_failed"
    | "canary_passed"
    | "authenticated_admission"
    | "completed_session"
    | "no_positive_evidence";
}

interface StoredRendezvousHealthRow {
  readonly singleton: unknown;
  readonly observation_generation: unknown;
  readonly window_started_at: unknown;
  readonly source_timestamp: unknown;
  readonly authenticated_admissions: unknown;
  readonly session_completed: unknown;
  readonly session_client_disconnected: unknown;
  readonly session_expired: unknown;
  readonly session_protocol_error: unknown;
  readonly session_server_unavailable: unknown;
  readonly session_server_replaced: unknown;
  readonly session_authorization_failed: unknown;
  readonly session_internal_error: unknown;
  readonly canary_type: unknown;
  readonly canary_route: unknown;
  readonly canary_authenticated_control: unknown;
  readonly canary_recent_admission: unknown;
  readonly canary_observed_at: unknown;
}

const SESSION_COLUMNS = [
  "session_completed",
  "session_client_disconnected",
  "session_expired",
  "session_protocol_error",
  "session_server_unavailable",
  "session_server_replaced",
  "session_authorization_failed",
  "session_internal_error",
] as const;

const RESET_WINDOW = `(
  excluded.source_timestamp < rendezvous_health_observations.window_started_at OR
  excluded.source_timestamp >=
    rendezvous_health_observations.window_started_at + ${RENDEZVOUS_HEALTH_WINDOW_SECONDS}
)`;

const UPSERT_OBSERVATION = `
INSERT INTO rendezvous_health_observations (
  singleton,
  observation_generation,
  window_started_at,
  source_timestamp,
  authenticated_admissions,
  session_completed,
  session_client_disconnected,
  session_expired,
  session_protocol_error,
  session_server_unavailable,
  session_server_replaced,
  session_authorization_failed,
  session_internal_error,
  canary_type,
  canary_route,
  canary_authenticated_control,
  canary_recent_admission,
  canary_observed_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(singleton) DO UPDATE SET
  observation_generation = CASE
    WHEN rendezvous_health_observations.observation_generation >=
      ${MAX_OBSERVATION_GENERATION}
    THEN 1
    ELSE rendezvous_health_observations.observation_generation + 1
  END,
  window_started_at = CASE
    WHEN ${RESET_WINDOW} THEN excluded.window_started_at
    ELSE rendezvous_health_observations.window_started_at
  END,
  source_timestamp = excluded.source_timestamp,
  authenticated_admissions = CASE
    WHEN ${RESET_WINDOW} THEN excluded.authenticated_admissions
    ELSE MIN(
      ${RENDEZVOUS_HEALTH_MAX_COUNTER},
      rendezvous_health_observations.authenticated_admissions +
        excluded.authenticated_admissions
    )
  END,
  session_completed = CASE
    WHEN ${RESET_WINDOW} THEN excluded.session_completed
    ELSE MIN(
      ${RENDEZVOUS_HEALTH_MAX_COUNTER},
      rendezvous_health_observations.session_completed + excluded.session_completed
    )
  END,
  session_client_disconnected = CASE
    WHEN ${RESET_WINDOW} THEN excluded.session_client_disconnected
    ELSE MIN(
      ${RENDEZVOUS_HEALTH_MAX_COUNTER},
      rendezvous_health_observations.session_client_disconnected +
        excluded.session_client_disconnected
    )
  END,
  session_expired = CASE
    WHEN ${RESET_WINDOW} THEN excluded.session_expired
    ELSE MIN(
      ${RENDEZVOUS_HEALTH_MAX_COUNTER},
      rendezvous_health_observations.session_expired + excluded.session_expired
    )
  END,
  session_protocol_error = CASE
    WHEN ${RESET_WINDOW} THEN excluded.session_protocol_error
    ELSE MIN(
      ${RENDEZVOUS_HEALTH_MAX_COUNTER},
      rendezvous_health_observations.session_protocol_error +
        excluded.session_protocol_error
    )
  END,
  session_server_unavailable = CASE
    WHEN ${RESET_WINDOW} THEN excluded.session_server_unavailable
    ELSE MIN(
      ${RENDEZVOUS_HEALTH_MAX_COUNTER},
      rendezvous_health_observations.session_server_unavailable +
        excluded.session_server_unavailable
    )
  END,
  session_server_replaced = CASE
    WHEN ${RESET_WINDOW} THEN excluded.session_server_replaced
    ELSE MIN(
      ${RENDEZVOUS_HEALTH_MAX_COUNTER},
      rendezvous_health_observations.session_server_replaced +
        excluded.session_server_replaced
    )
  END,
  session_authorization_failed = CASE
    WHEN ${RESET_WINDOW} THEN excluded.session_authorization_failed
    ELSE MIN(
      ${RENDEZVOUS_HEALTH_MAX_COUNTER},
      rendezvous_health_observations.session_authorization_failed +
        excluded.session_authorization_failed
    )
  END,
  session_internal_error = CASE
    WHEN ${RESET_WINDOW} THEN excluded.session_internal_error
    ELSE MIN(
      ${RENDEZVOUS_HEALTH_MAX_COUNTER},
      rendezvous_health_observations.session_internal_error +
        excluded.session_internal_error
    )
  END,
  canary_type = CASE
    WHEN ${RESET_WINDOW} OR excluded.canary_type <> 'none'
    THEN excluded.canary_type
    ELSE rendezvous_health_observations.canary_type
  END,
  canary_route = CASE
    WHEN ${RESET_WINDOW} OR excluded.canary_type <> 'none'
    THEN excluded.canary_route
    ELSE rendezvous_health_observations.canary_route
  END,
  canary_authenticated_control = CASE
    WHEN ${RESET_WINDOW} OR excluded.canary_type <> 'none'
    THEN excluded.canary_authenticated_control
    ELSE rendezvous_health_observations.canary_authenticated_control
  END,
  canary_recent_admission = CASE
    WHEN ${RESET_WINDOW} OR excluded.canary_type <> 'none'
    THEN excluded.canary_recent_admission
    ELSE rendezvous_health_observations.canary_recent_admission
  END,
  canary_observed_at = CASE
    WHEN ${RESET_WINDOW} OR excluded.canary_type <> 'none'
    THEN excluded.canary_observed_at
    ELSE rendezvous_health_observations.canary_observed_at
  END
`;

export class RendezvousHealth extends WorkerEntrypoint<CoreEnv> {
  async fetch(request: Request): Promise<Response> {
    return handleRendezvousHealthRequest(request, this.env);
  }
}

export async function handleRendezvousHealthRequest(
  request: Request,
  env: Pick<CoreEnv, "DB" | "RENDEZVOUS_HEALTH_EXPORT_TOKEN">,
  now = currentTimestamp(),
): Promise<Response> {
  if (!isExactHealthRequest(request) ||
      !await isAuthorizedHealthRequest(request, env.RENDEZVOUS_HEALTH_EXPORT_TOKEN)) {
    return fixedHealthError(403, "Forbidden\n");
  }

  if (request.method === "GET") {
    if (request.body !== null) {
      return fixedHealthError(400, "Malformed health request\n");
    }
    try {
      return jsonHealthResponse(await readRendezvousHealthSnapshot(env.DB, now));
    } catch {
      return fixedHealthError(503, "Health observation unavailable\n");
    }
  }

  if (request.method !== "POST" ||
      request.headers.get("Content-Type") !== "application/json") {
    return fixedHealthError(400, "Malformed health request\n");
  }
  const canary = await readHealthCanary(request);
  if (canary === null) {
    return fixedHealthError(400, "Malformed health request\n");
  }
  try {
    await recordRendezvousHealthCanary(env.DB, canary, now);
    return new Response(null, {
      status: 204,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return fixedHealthError(503, "Health observation unavailable\n");
  }
}

export async function recordRendezvousAuthenticatedAdmission(
  db: Pick<D1Database, "prepare">,
  now = currentTimestamp(),
): Promise<void> {
  await upsertObservation(db, now, 1, null, null);
}

export async function recordRendezvousSessionObservation(
  db: Pick<D1Database, "prepare">,
  outcome: unknown,
  now = currentTimestamp(),
): Promise<void> {
  await upsertObservation(
    db,
    now,
    0,
    normalizeRendezvousTerminalOutcome(outcome),
    null,
  );
}

export async function recordRendezvousHealthCanary(
  db: Pick<D1Database, "prepare">,
  canary: RendezvousHealthCanaryObservation,
  now = currentTimestamp(),
): Promise<void> {
  const normalized = canary.type === "route"
    ? normalizeRendezvousHealthCanary({
      type: canary.type,
      route: canary.route,
    })
    : normalizeRendezvousHealthCanary({
      type: canary.type,
      route: canary.route,
      authenticated_control: canary.authenticatedControl,
      recent_admission: canary.recentAdmission,
    });
  if (normalized === null) {
    throw new RangeError("Invalid rendezvous health canary");
  }
  await upsertObservation(db, now, 0, null, normalized);
}

export function normalizeRendezvousHealthCanary(
  value: unknown,
): RendezvousHealthCanaryObservation | null {
  if (!isRecord(value)) {
    return null;
  }
  const type = value.type;
  const route = value.route;
  const authenticatedControl = value.authenticated_control;
  const recentAdmission = value.recent_admission;
  const keys = new Set(Object.keys(value));
  if (type === "route") {
    if (
      !hasOnlyKeys(keys, ["type", "route"]) ||
      (route !== "reachable" && route !== "failed")
    ) {
      return null;
    }
    return {
      type,
      route,
      authenticatedControl: "not_observed",
      recentAdmission: "not_observed",
    };
  }
  if (type !== "end_to_end" ||
      !hasOnlyKeys(keys, [
        "type",
        "route",
        "authenticated_control",
        "recent_admission",
      ]) ||
      (route !== "reachable" && route !== "failed")) {
    return null;
  }
  if (route === "failed") {
    return authenticatedControl === "not_observed" &&
        recentAdmission === "not_observed"
      ? {
        type,
        route,
        authenticatedControl,
        recentAdmission,
      }
      : null;
  }
  if (
    !isCanarySignal(authenticatedControl) ||
    authenticatedControl === "not_observed" ||
    !isCanarySignal(recentAdmission) ||
    recentAdmission === "not_observed"
  ) {
    return null;
  }
  return {
    type,
    route,
    authenticatedControl,
    recentAdmission,
  };
}

export async function readRendezvousHealthSnapshot(
  db: Pick<D1Database, "prepare">,
  now = currentTimestamp(),
): Promise<RendezvousHealthSnapshot> {
  const row = await db.prepare(
    `SELECT singleton, observation_generation, window_started_at,
            source_timestamp, authenticated_admissions,
            session_completed, session_client_disconnected, session_expired,
            session_protocol_error, session_server_unavailable,
            session_server_replaced, session_authorization_failed,
            session_internal_error, canary_type, canary_route,
            canary_authenticated_control, canary_recent_admission,
            canary_observed_at
       FROM rendezvous_health_observations
      WHERE singleton = 1`,
  ).first<StoredRendezvousHealthRow>();
  if (row === null) {
    return emptySnapshot("no_observation");
  }
  const normalized = normalizeStoredRow(row, now);
  if (normalized === null) {
    return emptySnapshot("malformed_observation");
  }
  return snapshotFromStoredRow(normalized, now);
}

interface NormalizedStoredRow {
  readonly observationGeneration: number;
  readonly windowStartedAt: number;
  readonly sourceTimestamp: number;
  readonly authenticatedAdmissions: number;
  readonly sessions: Readonly<Record<RendezvousTerminalOutcome, number>>;
  readonly canary: {
    readonly type: "none" | RendezvousHealthCanaryType;
    readonly route: "not_observed" | RendezvousHealthCanaryRoute;
    readonly authenticatedControl: RendezvousHealthCanarySignal;
    readonly recentAdmission: RendezvousHealthCanarySignal;
    readonly observedAt: number | null;
  };
}

async function upsertObservation(
  db: Pick<D1Database, "prepare">,
  now: number,
  authenticatedAdmissions: number,
  outcome: RendezvousTerminalOutcome | null,
  canary: RendezvousHealthCanaryObservation | null,
): Promise<void> {
  const timestamp = requireTimestamp(now);
  const sessionDeltas = Object.fromEntries(
    SESSION_COLUMNS.map((column) => [
      column,
      outcome !== null && column === sessionColumn(outcome) ? 1 : 0,
    ]),
  ) as Record<(typeof SESSION_COLUMNS)[number], number>;
  const canaryValues = canary === null
    ? ["none", "not_observed", "not_observed", "not_observed", 0]
    : [
      canary.type,
      canary.route,
      canary.authenticatedControl,
      canary.recentAdmission,
      timestamp,
    ];
  await db.prepare(UPSERT_OBSERVATION).bind(
    1,
    1,
    timestamp,
    timestamp,
    boundedCounter(authenticatedAdmissions),
    sessionDeltas.session_completed,
    sessionDeltas.session_client_disconnected,
    sessionDeltas.session_expired,
    sessionDeltas.session_protocol_error,
    sessionDeltas.session_server_unavailable,
    sessionDeltas.session_server_replaced,
    sessionDeltas.session_authorization_failed,
    sessionDeltas.session_internal_error,
    ...canaryValues,
  ).run();
}

function sessionColumn(
  outcome: RendezvousTerminalOutcome,
): (typeof SESSION_COLUMNS)[number] {
  return `session_${outcome}` as (typeof SESSION_COLUMNS)[number];
}

function normalizeStoredRow(
  row: StoredRendezvousHealthRow,
  now: number,
): NormalizedStoredRow | null {
  const timestamp = safeTimestamp(now);
  const observationGeneration = boundedStoredInteger(
    row.observation_generation,
    MAX_OBSERVATION_GENERATION,
  );
  const windowStartedAt = boundedStoredInteger(row.window_started_at, MAX_TIMESTAMP);
  const sourceTimestamp = boundedStoredInteger(row.source_timestamp, MAX_TIMESTAMP);
  const authenticatedAdmissions = boundedStoredInteger(
    row.authenticated_admissions,
    RENDEZVOUS_HEALTH_MAX_COUNTER,
  );
  if (
    timestamp === null || row.singleton !== 1 || observationGeneration === null ||
    observationGeneration < 1 || windowStartedAt === null ||
    sourceTimestamp === null || sourceTimestamp < windowStartedAt ||
    sourceTimestamp > timestamp ||
    sourceTimestamp - windowStartedAt >= RENDEZVOUS_HEALTH_WINDOW_SECONDS ||
    authenticatedAdmissions === null
  ) {
    return null;
  }

  const sessionEntries = SESSION_COLUMNS.map((column) => [
    column.slice("session_".length) as RendezvousTerminalOutcome,
    boundedStoredInteger(row[column], RENDEZVOUS_HEALTH_MAX_COUNTER),
  ] as const);
  if (sessionEntries.some(([, value]) => value === null)) {
    return null;
  }
  const sessions = Object.fromEntries(sessionEntries) as Record<
    RendezvousTerminalOutcome,
    number
  >;
  const canary = normalizeStoredCanary(row);
  if (canary === null) {
    return null;
  }
  return {
    observationGeneration,
    windowStartedAt,
    sourceTimestamp,
    authenticatedAdmissions,
    sessions,
    canary,
  };
}

function normalizeStoredCanary(
  row: StoredRendezvousHealthRow,
): NormalizedStoredRow["canary"] | null {
  const type = row.canary_type;
  const route = row.canary_route;
  const authenticatedControl = row.canary_authenticated_control;
  const recentAdmission = row.canary_recent_admission;
  const observedAt = boundedStoredInteger(row.canary_observed_at, MAX_TIMESTAMP);
  if (type === "none") {
    return route === "not_observed" &&
        authenticatedControl === "not_observed" &&
        recentAdmission === "not_observed" &&
        observedAt === 0
      ? {
        type,
        route,
        authenticatedControl,
        recentAdmission,
        observedAt: null,
      }
      : null;
  }
  if (type !== "route" && type !== "end_to_end" || observedAt === null) {
    return null;
  }
  if (type === "route") {
    return route === "reachable" || route === "failed"
      ? {
        type,
        route,
        authenticatedControl: "not_observed",
        recentAdmission: "not_observed",
        observedAt,
      }
      : null;
  }
  if (!isCanarySignal(authenticatedControl) ||
      !isCanarySignal(recentAdmission) ||
      (route === "failed" &&
        (authenticatedControl !== "not_observed" ||
          recentAdmission !== "not_observed")) ||
      (route === "reachable" &&
        (authenticatedControl === "not_observed" ||
          recentAdmission === "not_observed"))) {
    return null;
  }
  return route === "reachable" || route === "failed"
    ? { type, route, authenticatedControl, recentAdmission, observedAt }
    : null;
}

function snapshotFromStoredRow(
  row: NormalizedStoredRow,
  now: number,
): RendezvousHealthSnapshot {
  const age = now - row.sourceTimestamp;
  const fresh = age <= RENDEZVOUS_HEALTH_FRESHNESS_SECONDS;
  const sessions = Object.freeze({ ...row.sessions });
  const canary = Object.freeze({
    type: row.canary.type,
    route: row.canary.route,
    authenticated_control: row.canary.authenticatedControl,
    recent_admission: row.canary.recentAdmission,
    observed_at: row.canary.observedAt,
  });
  const canaryFailed = row.canary.route === "failed" ||
    row.canary.authenticatedControl === "failed" ||
    row.canary.recentAdmission === "failed";
  const canaryPassed = row.canary.type === "end_to_end" &&
    row.canary.route === "reachable" &&
    row.canary.authenticatedControl === "passed" &&
    row.canary.recentAdmission === "passed";
  const hasAuthenticatedAdmission = row.authenticatedAdmissions > 0;
  const hasCompletedSession = row.sessions.completed > 0;
  let status: RendezvousHealthStatus;
  let reason: RendezvousHealthSnapshot["reason"];
  if (!fresh) {
    status = "stale";
    reason = "stale_source";
  } else if (canaryFailed) {
    status = "failed";
    reason = "canary_failed";
  } else if (canaryPassed) {
    status = "healthy";
    reason = "canary_passed";
  } else if (hasAuthenticatedAdmission) {
    status = "healthy";
    reason = "authenticated_admission";
  } else if (hasCompletedSession) {
    status = "healthy";
    reason = "completed_session";
  } else {
    status = "no_usable_observation";
    reason = "no_positive_evidence";
  }
  return {
    schema: RENDEZVOUS_HEALTH_SCHEMA,
    observation_generation: row.observationGeneration,
    source_timestamp: row.sourceTimestamp,
    observation_window: {
      started_at: row.windowStartedAt,
      duration_seconds: RENDEZVOUS_HEALTH_WINDOW_SECONDS,
      ended_at: Math.min(
        MAX_TIMESTAMP,
        row.windowStartedAt + RENDEZVOUS_HEALTH_WINDOW_SECONDS,
      ),
    },
    freshness: {
      state: fresh ? "fresh" : "stale",
      age_seconds: age,
      maximum_age_seconds: RENDEZVOUS_HEALTH_FRESHNESS_SECONDS,
    },
    status,
    recent_authenticated_admissions: row.authenticatedAdmissions,
    recent_sessions: {
      total: Object.values(sessions).reduce((total, count) => total + count, 0),
      outcomes: sessions,
    },
    canary,
    reason,
  };
}

function emptySnapshot(
  reason: "no_observation" | "malformed_observation",
): RendezvousHealthSnapshot {
  const outcomes = Object.freeze(Object.fromEntries(
    RENDEZVOUS_TERMINAL_OUTCOMES.map((outcome) => [outcome, 0]),
  )) as Readonly<Record<RendezvousTerminalOutcome, number>>;
  return {
    schema: RENDEZVOUS_HEALTH_SCHEMA,
    observation_generation: 0,
    source_timestamp: null,
    observation_window: {
      started_at: null,
      duration_seconds: RENDEZVOUS_HEALTH_WINDOW_SECONDS,
      ended_at: null,
    },
    freshness: {
      state: "no_observation",
      age_seconds: null,
      maximum_age_seconds: RENDEZVOUS_HEALTH_FRESHNESS_SECONDS,
    },
    status: "no_usable_observation",
    recent_authenticated_admissions: 0,
    recent_sessions: { total: 0, outcomes },
    canary: {
      type: "none",
      route: "not_observed",
      authenticated_control: "not_observed",
      recent_admission: "not_observed",
      observed_at: null,
    },
    reason,
  };
}

function isExactHealthRequest(request: Request): boolean {
  if (
    request.url !== INTERNAL_RENDEZVOUS_HEALTH_URL ||
    (request.method !== "GET" && request.method !== "POST")
  ) {
    return false;
  }
  for (const name of request.headers.keys()) {
    if (!HEALTH_REQUEST_HEADERS.has(name.toLowerCase())) {
      return false;
    }
  }
  const transferEncoding = request.headers.get("Transfer-Encoding");
  return transferEncoding === null || transferEncoding === "chunked";
}

async function isAuthorizedHealthRequest(
  request: Request,
  expectedToken: string,
): Promise<boolean> {
  const match = AUTHORIZATION_PATTERN.exec(
    request.headers.get(AUTHORIZATION_HEADER) ?? "",
  );
  return expectedToken.length > 0 && match !== null &&
    await constantTimeEqual(match[1]!, expectedToken);
}

async function readHealthCanary(
  request: Request,
): Promise<RendezvousHealthCanaryObservation | null> {
  const contentLength = request.headers.get("Content-Length");
  if (
    contentLength !== null &&
    (!/^\d+$/.test(contentLength) ||
      Number(contentLength) > RENDEZVOUS_HEALTH_MAX_REQUEST_BYTES)
  ) {
    return null;
  }
  const body = request.body;
  if (body === null) {
    return null;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      total += result.value.byteLength;
      if (total > RENDEZVOUS_HEALTH_MAX_REQUEST_BYTES) {
        void reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(result.value);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false,
    }).decode(bytes));
  } catch {
    return null;
  }
  return normalizeRendezvousHealthCanary(parsed);
}

function jsonHealthResponse(snapshot: RendezvousHealthSnapshot): Response {
  return new Response(JSON.stringify(snapshot), {
    status: 200,
    headers: HEALTH_RESPONSE_HEADERS,
  });
}

function fixedHealthError(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function currentTimestamp(): number {
  return requireTimestamp(Math.floor(Date.now() / 1_000));
}

function requireTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TIMESTAMP) {
    throw new RangeError("Invalid rendezvous health timestamp");
  }
  return value;
}

function safeTimestamp(value: number): number | null {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIMESTAMP
    ? value
    : null;
}

function boundedCounter(value: number): number {
  return Number.isSafeInteger(value) && value > 0
    ? Math.min(RENDEZVOUS_HEALTH_MAX_COUNTER, value)
    : 0;
}

function boundedStoredInteger(value: unknown, maximum: number): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) &&
      value >= 0 && value <= maximum
    ? value
    : null;
}

function isCanarySignal(value: unknown): value is RendezvousHealthCanarySignal {
  return value === "not_observed" || value === "passed" || value === "failed";
}

function hasOnlyKeys(
  keys: ReadonlySet<string>,
  expected: readonly string[],
): boolean {
  return keys.size === expected.length && expected.every((key) => keys.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
