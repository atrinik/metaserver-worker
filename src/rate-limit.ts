const SECONDS_PER_DAY = 86_400;
const MAXIMUM_BUDGET = 1_000_000;
const MAXIMUM_RETRY_AFTER_SECONDS = SECONDS_PER_DAY;

const AUTHENTICATED_SERVER_ACTOR_KEY = /^[0-9a-f]{64}$/;
const VERSIONED_ACTOR_KEY = /^v1\.[A-Za-z0-9_-]{1,32}\.[A-Za-z0-9_-]{43}$/;

export const REQUEST_BUDGET_SCOPES = [
  "compat-status",
  "compat-directory",
  "compat-otp",
  "compat-update-source",
  "compat-update-server",
  "publish-server",
  "publish-game-server",
  "rendezvous-client-source",
  "rendezvous-client-source-server",
  "rendezvous-server-source",
  "rendezvous-server",
] as const;

export type RequestBudgetScope = typeof REQUEST_BUDGET_SCOPES[number];
export type RequestControlScope =
  | "global"
  | "rendezvous-client-pair-cooldown"
  | RequestBudgetScope;

export const REQUEST_LIMIT_REASONS = [
  "burst_limit_exceeded",
  "cooldown_active",
  "request_budget_exceeded",
] as const;

export type RequestLimitReason = typeof REQUEST_LIMIT_REASONS[number];

export type RequestControlDependency = "d1" | "native-rate-limit";

export interface FixedWindow {
  readonly startAt: number;
  readonly endAt: number;
}

export interface FixedWindowBudgetRequest {
  readonly actorKey: string;
  readonly scope: RequestBudgetScope;
  readonly limit: number;
  readonly now: number;
  readonly window: FixedWindow;
}

export interface AliasedFixedWindowBudgetRequest {
  readonly actorKeys:
    | readonly [current: string]
    | readonly [current: string, previous: string];
  readonly scope: RequestBudgetScope;
  readonly limit: number;
  readonly now: number;
  readonly window: FixedWindow;
}

export interface RequestBudgetAdmission {
  readonly scope: RequestBudgetScope;
  readonly count: number;
  readonly limit: number;
  readonly remaining: number;
  readonly resetAt: number;
}

interface RequestBudgetRow {
  actor_key: string;
  request_count: number;
  expires_at: number;
}

interface RequestBudgetStateRow {
  row_count: number;
  maximum_count: number | null;
  minimum_expiry: number | null;
  maximum_expiry: number | null;
}

export interface RequestBudgetExceededOptions {
  readonly scope: RequestControlScope;
  readonly reason: RequestLimitReason;
  readonly retryAfterSeconds: number;
  readonly resetAt: number | null;
  readonly limit: number | null;
}

/**
 * A transport-independent rejection that an HTTP adapter can render as a 429.
 * It intentionally contains no actor key or other request identity.
 */
export class RequestBudgetExceeded extends Error {
  readonly scope: RequestControlScope;
  readonly reason: RequestLimitReason;
  readonly retryAfterSeconds: number;
  readonly resetAt: number | null;
  readonly limit: number | null;

  constructor(options: RequestBudgetExceededOptions) {
    super("Request budget exceeded");
    this.name = "RequestBudgetExceeded";
    this.scope = options.scope;
    this.reason = options.reason;
    this.retryAfterSeconds = clampRetryAfter(options.retryAfterSeconds);
    this.resetAt = options.resetAt;
    this.limit = options.limit;
  }
}

/**
 * A fail-closed dependency failure that an HTTP adapter can render as a
 * bounded temporary-unavailability response. The cause is retained for local
 * diagnostics but must never be serialized into a public response or metric.
 */
export class RequestControlUnavailable extends Error {
  constructor(
    readonly dependency: RequestControlDependency,
    cause: unknown,
  ) {
    super("Request control dependency is unavailable", { cause });
    this.name = "RequestControlUnavailable";
  }
}

/**
 * Return the UTC calendar-day window containing a Unix timestamp in seconds.
 */
export function utcDayWindow(now: number): FixedWindow {
  requireNonNegativeInteger(now, "now");
  const startAt = Math.floor(now / SECONDS_PER_DAY) * SECONDS_PER_DAY;
  if (startAt > Number.MAX_SAFE_INTEGER - SECONDS_PER_DAY) {
    throw new RangeError("now is too large to form a complete UTC day");
  }
  return { startAt, endAt: startAt + SECONDS_PER_DAY };
}

/**
 * Calculate a safe integer Retry-After value for a known fixed-window reset.
 */
export function boundedRetryAfter(resetAt: number, now: number): number {
  requireNonNegativeInteger(resetAt, "resetAt");
  requireNonNegativeInteger(now, "now");
  return clampRetryAfter(resetAt - now);
}

/**
 * Check a fast, per-location Workers Rate Limiting binding before durable work.
 * Exact daily accounting is provided separately by consumeFixedWindowBudget.
 */
export async function enforceNativeBurst(
  limiter: RateLimit,
  actorKey: string,
  scope: RequestControlScope,
  periodSeconds: 10 | 60 = 60,
): Promise<void> {
  requireActorKey(actorKey);
  requireControlScope(scope);
  if (periodSeconds !== 10 && periodSeconds !== 60) {
    throw new TypeError("periodSeconds must be 10 or 60");
  }

  const result = await executeDependency(
    "native-rate-limit",
    () => limiter.limit({ key: `${scope}.${actorKey}` }),
  );
  if (!result.success) {
    throw new RequestBudgetExceeded({
      scope,
      reason: "burst_limit_exceeded",
      retryAfterSeconds: periodSeconds,
      resetAt: null,
      limit: null,
    });
  }
}

/**
 * Conservatively check every active source-tag alias against a native binding.
 *
 * The Workers Rate Limiting API accepts one key per call and is not atomic
 * across aliases. A later alias can therefore reject after an earlier alias
 * was charged. This deliberately favors fail-closed burst protection; exact
 * rotation accounting is provided by the mirrored D1 budget instead.
 */
export async function enforceNativeBurstAliases(
  limiter: RateLimit,
  actorKeys:
    | readonly [current: string]
    | readonly [current: string, previous: string],
  scope: RequestControlScope,
  periodSeconds: 10 | 60 = 60,
): Promise<void> {
  const aliases = normalizeActorAliases(actorKeys);
  for (const actorKey of aliases) {
    await enforceNativeBurst(limiter, actorKey, scope, periodSeconds);
  }
}

/**
 * Atomically consume one request from an exact fixed-window D1 budget.
 *
 * The conditional UPSERT performs the capacity check and increment as one
 * SQLite write. Once the count reaches the limit, the WHERE clause prevents
 * further mutations; rejected calls therefore cannot inflate the counter.
 */
export async function consumeFixedWindowBudget(
  database: D1Database,
  request: FixedWindowBudgetRequest,
): Promise<RequestBudgetAdmission> {
  return consumeAliasedFixedWindowBudget(database, {
    actorKeys: [request.actorKey],
    scope: request.scope,
    limit: request.limit,
    now: request.now,
    window: request.window,
  });
}

/**
 * Atomically consume one request for a current/previous source-tag alias set.
 *
 * Every alias is written with the same counter. This carries an active window
 * across key rotation without charging one logical request twice. When
 * overlapping deployments leave equal-expiry aliases at different counts,
 * advancing from their maximum conservatively heals the divergence. Expiry
 * divergence fails closed because it crosses fixed-window boundaries.
 */
export async function consumeAliasedFixedWindowBudget(
  database: D1Database,
  request: AliasedFixedWindowBudgetRequest,
): Promise<RequestBudgetAdmission> {
  const actorKeys = normalizeActorAliases(request.actorKeys);
  requireBudgetScope(request.scope);
  requireIntegerInRange(request.limit, "limit", 1, MAXIMUM_BUDGET);
  requireNonNegativeInteger(request.now, "now");
  validateWindow(request.window, request.now);

  const previousActorKey = actorKeys[1] ?? null;
  const admitted = await executeDependency(
    "d1",
    () => database.prepare(
      `WITH aliases(actor_key) AS (
     SELECT ?1
       UNION
       SELECT ?2 WHERE ?2 IS NOT NULL
     ), state AS (
       SELECT COALESCE(MAX(b.request_count), 0) AS current_count,
              COALESCE(MAX(
                CASE WHEN b.expires_at <> ?6 THEN 1 ELSE 0 END
              ), 0) AS expiry_mismatch
         FROM aliases AS a
         LEFT JOIN request_budgets AS b
           ON b.actor_key = a.actor_key
          AND b.scope = ?3
          AND b.window_start = ?4
     ), admission(next_count) AS (
       SELECT current_count + 1
         FROM state
        WHERE current_count < ?5
          AND expiry_mismatch = 0
     )
     INSERT INTO request_budgets
       (actor_key, scope, window_start, request_count, expires_at)
     SELECT a.actor_key, ?3, ?4, admission.next_count, ?6
       FROM aliases AS a
       CROSS JOIN admission
      WHERE 1
     ON CONFLICT(actor_key, scope, window_start) DO UPDATE SET
       request_count = excluded.request_count
     WHERE request_budgets.expires_at = excluded.expires_at
     RETURNING actor_key, request_count, expires_at`,
    )
      .bind(
        actorKeys[0],
        previousActorKey,
        request.scope,
        request.window.startAt,
        request.limit,
        request.window.endAt,
      )
      .all<RequestBudgetRow>(),
  );

  if (admitted.results.length === actorKeys.length) {
    const counts = new Set(admitted.results.map((row) => row.request_count));
    const expiries = new Set(admitted.results.map((row) => row.expires_at));
    const returnedActors = new Set(
      admitted.results.map((row) => row.actor_key),
    );
    if (
      counts.size !== 1 ||
      expiries.size !== 1 ||
      returnedActors.size !== actorKeys.length ||
      actorKeys.some((actorKey) => !returnedActors.has(actorKey))
    ) {
      throw new Error("Request budget aliases produced inconsistent rows");
    }

    const admittedCount = admitted.results[0]?.request_count;
    const expiresAt = admitted.results[0]?.expires_at;
    if (admittedCount === undefined || expiresAt === undefined) {
      throw new Error("Request budget admission returned no durable row");
    }
    return {
      scope: request.scope,
      count: admittedCount,
      limit: request.limit,
      remaining: request.limit - admittedCount,
      resetAt: expiresAt,
    };
  }

  if (admitted.results.length !== 0) {
    throw new Error("Request budget admission returned a partial alias set");
  }

  const state = await executeDependency(
    "d1",
    () => database.prepare(
      `SELECT COUNT(*) AS row_count,
            MAX(request_count) AS maximum_count,
            MIN(expires_at) AS minimum_expiry,
            MAX(expires_at) AS maximum_expiry
       FROM request_budgets
      WHERE actor_key IN (?1, ?2)
        AND scope = ?3
        AND window_start = ?4`,
    )
      .bind(
        actorKeys[0],
        previousActorKey ?? actorKeys[0],
        request.scope,
        request.window.startAt,
      )
      .first<RequestBudgetStateRow>(),
  );

  if (
    state === null ||
    state.row_count < 1 ||
    state.row_count > actorKeys.length ||
    state.maximum_count === null ||
    state.minimum_expiry !== request.window.endAt ||
    state.maximum_expiry !== request.window.endAt
  ) {
    throw new Error("Request budget aliases are divergent");
  }
  if (state.maximum_count < request.limit) {
    throw new Error("Request budget admission failed below its limit");
  }

  throw new RequestBudgetExceeded({
    scope: request.scope,
    reason: "request_budget_exceeded",
    retryAfterSeconds: boundedRetryAfter(request.window.endAt, request.now),
    resetAt: request.window.endAt,
    limit: request.limit,
  });
}

export function isRequestActorKey(value: string): boolean {
  if (value.length < 8 || value.length > 128) {
    return false;
  }
  return AUTHENTICATED_SERVER_ACTOR_KEY.test(value) ||
    VERSIONED_ACTOR_KEY.test(value);
}

function validateWindow(window: FixedWindow, now: number): void {
  requireNonNegativeInteger(window.startAt, "window.startAt");
  requireNonNegativeInteger(window.endAt, "window.endAt");
  const duration = window.endAt - window.startAt;
  requireIntegerInRange(
    duration,
    "window duration",
    1,
    SECONDS_PER_DAY,
  );
  if (now < window.startAt || now >= window.endAt) {
    throw new RangeError("now must fall within the fixed window");
  }
}

function requireActorKey(actorKey: string): void {
  if (!isRequestActorKey(actorKey)) {
    throw new TypeError("actorKey must be an opaque versioned tag or server identity");
  }
}

function normalizeActorAliases(
  actorKeys:
    | readonly [current: string]
    | readonly [current: string, previous: string],
): readonly [current: string] | readonly [current: string, previous: string] {
  if (actorKeys.length < 1 || actorKeys.length > 2) {
    throw new TypeError("actorKeys must contain one or two actor aliases");
  }

  const unique = [...new Set(actorKeys)];
  for (const actorKey of unique) {
    requireActorKey(actorKey);
  }
  if (
    unique.length === 2 &&
    unique.some((actorKey) => !VERSIONED_ACTOR_KEY.test(actorKey))
  ) {
    throw new TypeError("Only versioned source tags may have actor aliases");
  }

  const current = unique[0];
  if (current === undefined) {
    throw new TypeError("actorKeys must contain an actor key");
  }
  const previous = unique[1];
  return previous === undefined ? [current] : [current, previous];
}

function requireBudgetScope(scope: string): asserts scope is RequestBudgetScope {
  if (!REQUEST_BUDGET_SCOPES.some((candidate) => candidate === scope)) {
    throw new TypeError("Unknown request-budget scope");
  }
}

function requireControlScope(scope: string): asserts scope is RequestControlScope {
  if (scope !== "global" && scope !== "rendezvous-client-pair-cooldown") {
    requireBudgetScope(scope);
  }
}

function requireNonNegativeInteger(value: number, name: string): void {
  requireIntegerInRange(value, name, 0, Number.MAX_SAFE_INTEGER);
}

function requireIntegerInRange(
  value: number,
  name: string,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
}

function clampRetryAfter(seconds: number): number {
  if (!Number.isFinite(seconds)) {
    return MAXIMUM_RETRY_AFTER_SECONDS;
  }
  return Math.max(
    1,
    Math.min(MAXIMUM_RETRY_AFTER_SECONDS, Math.ceil(seconds)),
  );
}

async function executeDependency<T>(
  dependency: RequestControlDependency,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (dependency === "d1" && isD1ProgrammingOrIntegrityFailure(error)) {
      throw error;
    }
    throw new RequestControlUnavailable(dependency, error);
  }
}

/**
 * D1 has no stable typed error-code API. Prove only narrow caller-owned
 * programming/schema/integrity failures from documented prefixes and SQLite
 * diagnostics; unknown and operational failures remain fail-closed 503s.
 */
export function isD1ProgrammingOrIntegrityFailure(error: unknown): boolean {
  if (
    error instanceof TypeError ||
    error instanceof RangeError ||
    error instanceof SyntaxError
  ) {
    return true;
  }

  const detail = errorMessages(error).join("\n").toLowerCase();
  return [
    "d1_type_error:",
    "d1_columnnotfound:",
    "d1_column_notfound:",
    "sqlite_constraint",
    "constraint failed",
    "no such table",
    "no such column",
    "syntax error",
    "no sql statements detected",
  ].some((marker) => detail.includes(marker));
}

function errorMessages(error: unknown): readonly string[] {
  const messages: string[] = [];
  const visited = new Set<unknown>();
  let candidate: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (
      candidate === null ||
      (typeof candidate !== "object" && typeof candidate !== "function") ||
      visited.has(candidate)
    ) {
      break;
    }
    visited.add(candidate);
    if (candidate instanceof Error) {
      messages.push(candidate.message);
      candidate = candidate.cause;
      continue;
    }
    const record = candidate as { message?: unknown; cause?: unknown };
    if (typeof record.message === "string") {
      messages.push(record.message);
    }
    candidate = record.cause;
  }
  return messages;
}
