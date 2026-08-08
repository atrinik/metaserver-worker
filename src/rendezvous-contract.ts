import {
  normalizeIpAddress,
  SERVER_SIGNAL_CANDIDATE_KINDS,
} from "./protocol";
import type { DirectCandidateKind } from "./protocol";
import type { RendezvousRole } from "./routes";

/**
 * This contract is deliberately incompatible with the original internal
 * Durable Object request, which used `/` and `X-Atrinik-Role`. During a
 * rolling deployment, either version therefore fails closed instead of
 * silently entering the legacy broadcast implementation.
 */
export const INTERNAL_RENDEZVOUS_URL = "https://rendezvous.internal/v1";
export const INTERNAL_RENDEZVOUS_ROLE_HEADER =
  "X-Atrinik-Rendezvous-V1-Role";
export const LEGACY_INTERNAL_RENDEZVOUS_ROLE_HEADER = "X-Atrinik-Role";

export const MAX_SIGNAL_BYTES = 512;
export const MAX_CLIENT_CANDIDATES = 1;
export const MAX_SERVER_CANDIDATES = 12;
export const MAX_COMPLETIONS = 1;
export const MAX_RENDEZVOUS_CLIENT_SOCKETS = 64;
export const RENDEZVOUS_ROLLING_WINDOW_MS = 24 * 60 * 60 * 1_000;
export const MAX_RENDEZVOUS_SESSION_SIGNAL_BYTES =
  MAX_SIGNAL_BYTES *
    (MAX_CLIENT_CANDIDATES + MAX_SERVER_CANDIDATES + MAX_COMPLETIONS);

/**
 * A terminal socket is already unable to signal. These four teardown-only
 * retries bound the exceptional case where WebSocket.close() keeps throwing,
 * while avoiding a self-sustaining alarm loop.
 */
export const TERMINAL_CLOSE_RETRY_OFFSETS_MS = Object.freeze([
  0,
  1_000,
  3_000,
  7_000,
] as const);
export const MAX_TERMINAL_CLOSE_ATTEMPTS =
  TERMINAL_CLOSE_RETRY_OFFSETS_MS.length;
export const TERMINAL_CLOSE_RETRY_HORIZON_MS =
  TERMINAL_CLOSE_RETRY_OFFSETS_MS[
    TERMINAL_CLOSE_RETRY_OFFSETS_MS.length - 1
  ];

export const MAX_WEBSOCKET_CLOSE_REASON_BYTES = 123;
export const NORMAL_RENDEZVOUS_CLOSE = {
  code: 1000,
  reason: "Rendezvous complete",
} as const;
export const RENDEZVOUS_CLOSE = {
  protocolError: {
    code: 4000,
    reason: "Invalid rendezvous message",
  },
  sessionExpired: {
    code: 4001,
    reason: "Rendezvous session expired",
  },
  serverUnavailable: {
    code: 4002,
    reason: "Rendezvous server unavailable",
  },
  internalError: {
    code: 4003,
    reason: "Rendezvous internal error",
  },
  serverReplaced: {
    code: 4004,
    reason: "Rendezvous server replaced",
  },
} as const;

export const RENDEZVOUS_TERMINAL_OUTCOMES = Object.freeze([
  "completed",
  "client_disconnected",
  "session_expired",
  "protocol_error",
  "server_unavailable",
  "server_replaced",
  "internal_error",
] as const);

export type RendezvousTerminalOutcome =
  (typeof RENDEZVOUS_TERMINAL_OUTCOMES)[number];

export interface ClientCandidateSignal {
  readonly type: "client_candidate";
  readonly host: string;
  readonly port: number;
  readonly ticket: string;
}

export type ServerSignalCandidateKind = Extract<
  DirectCandidateKind,
  "lan" | "ipv6" | "mapped" | "srflx"
>;

export interface ServerCandidateSignal {
  readonly type: "server_candidate";
  readonly host: string;
  readonly port: number;
  readonly kind: ServerSignalCandidateKind;
  readonly ticket: string;
}

export interface CompleteSignal {
  readonly type: "complete";
  readonly ticket: string;
}

export type RendezvousSignal =
  | ClientCandidateSignal
  | ServerCandidateSignal
  | CompleteSignal;

export type RendezvousSignalParseError =
  | "binary"
  | "too_large"
  | "invalid_json"
  | "unsupported_signal";

export type RendezvousSignalParseResult =
  | {
      readonly ok: true;
      readonly signal: RendezvousSignal;
      /** Canonical JSON to send to the peer. */
      readonly serialized: string;
      /** UTF-8 bytes consumed by the untrusted input, including whitespace. */
      readonly bytes: number;
    }
  | {
      readonly ok: false;
      readonly error: RendezvousSignalParseError;
    };

const HEX_64 = /^[0-9a-f]{64}$/;
const FORBIDDEN_BODY_HEADERS = [
  "Content-Length",
  "Content-Type",
  "Content-Encoding",
  "Transfer-Encoding",
] as const;
const CLIENT_CANDIDATE_KEYS = ["type", "host", "port", "ticket"] as const;
const SERVER_CANDIDATE_KEYS = [
  "type",
  "host",
  "port",
  "kind",
  "ticket",
] as const;
const COMPLETE_KEYS = ["type", "ticket"] as const;

/**
 * Validates the private Worker-to-Durable-Object WebSocket upgrade. Public
 * requests must never be able to select a room role through this function.
 */
export function validateInternalRendezvousUpgrade(
  request: Request,
): RendezvousRole | null {
  if (
    request.url !== INTERNAL_RENDEZVOUS_URL ||
    request.method !== "GET" ||
    request.body !== null ||
    request.headers.get("Upgrade") !== "websocket" ||
    request.headers.has(LEGACY_INTERNAL_RENDEZVOUS_ROLE_HEADER) ||
    FORBIDDEN_BODY_HEADERS.some((name) => request.headers.has(name))
  ) {
    return null;
  }

  const role = request.headers.get(INTERNAL_RENDEZVOUS_ROLE_HEADER);
  return role === "client" || role === "server" ? role : null;
}

/**
 * Parses one signaling frame without allocating in proportion to an
 * over-limit string. Every successful result is normalized and safe to
 * serialize for the classic client/server parsers.
 */
export function parseRendezvousSignal(
  message: string | ArrayBuffer,
): RendezvousSignalParseResult {
  if (typeof message !== "string") {
    return { ok: false, error: "binary" };
  }

  // A UTF-8 encoding cannot contain fewer bytes than this many UTF-16 code
  // units. Rejecting here prevents TextEncoder from copying a huge frame.
  if (message.length > MAX_SIGNAL_BYTES) {
    return { ok: false, error: "too_large" };
  }
  const bytes = new TextEncoder().encode(message).byteLength;
  if (bytes > MAX_SIGNAL_BYTES) {
    return { ok: false, error: "too_large" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return { ok: false, error: "invalid_json" };
  }
  if (!isJsonObject(parsed)) {
    return { ok: false, error: "unsupported_signal" };
  }

  const signal = parseSignalObject(parsed);
  if (signal === null) {
    return { ok: false, error: "unsupported_signal" };
  }
  return {
    ok: true,
    signal,
    serialized: serializeRendezvousSignal(signal),
    bytes,
  };
}

/**
 * Produces the stable property order consumed by existing classic peers.
 */
export function serializeRendezvousSignal(signal: RendezvousSignal): string {
  switch (signal.type) {
    case "client_candidate":
      return JSON.stringify({
        type: signal.type,
        host: signal.host,
        port: signal.port,
        ticket: signal.ticket,
      });
    case "server_candidate":
      return JSON.stringify({
        type: signal.type,
        host: signal.host,
        port: signal.port,
        kind: signal.kind,
        ticket: signal.ticket,
      });
    case "complete":
      return JSON.stringify({
        type: signal.type,
        ticket: signal.ticket,
      });
  }
}

function parseSignalObject(
  fields: Record<string, unknown>,
): RendezvousSignal | null {
  if (fields.type === "complete") {
    if (!hasExactKeys(fields, COMPLETE_KEYS) || !isTicket(fields.ticket)) {
      return null;
    }
    return { type: "complete", ticket: fields.ticket };
  }

  if (
    fields.type !== "client_candidate" &&
    fields.type !== "server_candidate"
  ) {
    return null;
  }
  if (
    typeof fields.host !== "string" ||
    !isPort(fields.port) ||
    !isTicket(fields.ticket)
  ) {
    return null;
  }

  let host: string;
  try {
    host = normalizeIpAddress(fields.host);
  } catch {
    return null;
  }

  if (fields.type === "client_candidate") {
    if (!hasExactKeys(fields, CLIENT_CANDIDATE_KEYS)) {
      return null;
    }
    return {
      type: "client_candidate",
      host,
      port: fields.port,
      ticket: fields.ticket,
    };
  }

  if (
    !hasExactKeys(fields, SERVER_CANDIDATE_KEYS) ||
    !isServerSignalCandidateKind(fields.kind)
  ) {
    return null;
  }
  return {
    type: "server_candidate",
    host,
    port: fields.port,
    kind: fields.kind,
    ticket: fields.ticket,
  };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key));
}

function isPort(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 65_535;
}

function isTicket(value: unknown): value is string {
  return typeof value === "string" && HEX_64.test(value);
}

function isServerSignalCandidateKind(
  value: unknown,
): value is ServerSignalCandidateKind {
  return typeof value === "string" &&
    (SERVER_SIGNAL_CANDIDATE_KINDS as readonly string[]).includes(value);
}
