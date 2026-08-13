import {
  normalizeIpAddress,
  SERVER_SIGNAL_CANDIDATE_KINDS,
} from "./protocol";
import { isCanonicalHostname } from "./hostname";
import { isDirectoryText, isGameDirectoryText } from "./directory-state";
import type { DirectoryProfile } from "./directory-state";
import type { DirectCandidateKind } from "./protocol";
import type { RendezvousRole } from "./routes";

/**
 * This contract is deliberately incompatible with the original internal
 * Durable Object request, which used `/` and `X-Atrinik-Role`. During a
 * rolling deployment, either version therefore fails closed instead of
 * silently entering the legacy broadcast implementation.
 */
export const INTERNAL_RENDEZVOUS_URL = "https://rendezvous.internal/v2";
export const INTERNAL_RENDEZVOUS_PUBLISH_URL =
  "https://rendezvous.internal/v2/publish";
export const INTERNAL_DIRECTORY_CHANGED_HEADER =
  "X-Atrinik-Directory-Changed";
export const INTERNAL_RENDEZVOUS_ROLE_HEADER =
  "X-Atrinik-Rendezvous-V2-Role";
export const INTERNAL_RENDEZVOUS_PROTOCOL_HEADER =
  "X-Atrinik-Rendezvous-V2-Protocol";
export const INTERNAL_RENDEZVOUS_AUTHORIZATION_HEADER =
  "X-Atrinik-Rendezvous-V2-Authorization";
export const INTERNAL_RENDEZVOUS_GENERATION_HEADER =
  "X-Atrinik-Rendezvous-V2-Generation";
export const LEGACY_INTERNAL_RENDEZVOUS_ROLE_HEADER = "X-Atrinik-Role";
export const LEGACY_INTERNAL_RENDEZVOUS_V1_ROLE_HEADER =
  "X-Atrinik-Rendezvous-V1-Role";

// Public update fields can contain control characters which JSON.stringify()
// expands to six-byte escapes. The strict field maxima fit below this fixed
// private envelope even in that worst case.
const MAX_INTERNAL_PUBLICATION_BYTES = 4_096;

export const MAX_SIGNAL_BYTES = 512;
export const MAX_CLIENT_CANDIDATES = 1;
export const MAX_SERVER_CANDIDATES = 12;
export const MAX_COMPLETIONS = 1;
export const MAX_CLIENT_AUTHORIZATION_FRAMES = 2;
export const MAX_SERVER_AUTHORIZATION_FRAMES = 2;
export const MAX_AUTHORIZATION_SIGNAL_BYTES = MAX_SIGNAL_BYTES *
  (MAX_CLIENT_AUTHORIZATION_FRAMES + MAX_SERVER_AUTHORIZATION_FRAMES);
export const MAX_RENDEZVOUS_CLIENT_SOCKETS = 64;
export const RENDEZVOUS_ROLLING_WINDOW_MS = 24 * 60 * 60 * 1_000;
// The replay ledger is a storage/security horizon, not an ordinary admission
// quota. Reaching this emergency ceiling produces temporary unavailability.
export const MAX_RENDEZVOUS_REPLAY_ADMISSIONS = 100_000;
export const MAX_RENDEZVOUS_SESSION_SIGNAL_BYTES =
  MAX_AUTHORIZATION_SIGNAL_BYTES + MAX_SIGNAL_BYTES *
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
  authorizationFailed: {
    code: 4005,
    reason: "Rendezvous authorization failed",
  },
} as const;

export const RENDEZVOUS_TERMINAL_OUTCOMES = Object.freeze([
  "completed",
  "client_disconnected",
  "session_expired",
  "protocol_error",
  "server_unavailable",
  "server_replaced",
  "authorization_failed",
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

export interface AuthInitSignal {
  readonly type: "auth_init";
  readonly version: 1;
  readonly ticket: string;
  readonly invite_id: string;
}

export interface AuthChallengeSignal {
  readonly type: "auth_challenge";
  readonly version: 1;
  readonly ticket: string;
  readonly challenge: string;
}

export interface AuthProofSignal {
  readonly type: "auth_proof";
  readonly version: 1;
  readonly ticket: string;
  readonly proof: string;
}

export interface AuthResultSignal {
  readonly type: "auth_result";
  readonly version: 1;
  readonly ticket: string;
  readonly authorized: boolean;
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
  | AuthInitSignal
  | AuthChallengeSignal
  | AuthProofSignal
  | AuthResultSignal
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
const HEX_32 = /^[0-9a-f]{32}$/;
const PUBLISH_SEQUENCE = /^[1-9][0-9]{0,19}$/;
const UINT64_MAXIMUM = 18_446_744_073_709_551_615n;
const PUBLISH_NONCE_RETENTION_SECONDS = 86_400;
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
const AUTH_INIT_KEYS = ["type", "version", "ticket", "invite_id"] as const;
const AUTH_CHALLENGE_KEYS = [
  "type", "version", "ticket", "challenge",
] as const;
const AUTH_PROOF_KEYS = ["type", "version", "ticket", "proof"] as const;
const AUTH_RESULT_KEYS = [
  "type", "version", "ticket", "authorized",
] as const;

export interface InternalRendezvousUpgrade {
  readonly role: RendezvousRole;
  readonly inviteProtocol: boolean;
  readonly authorizationRequired: boolean;
  readonly generation: string;
}

interface InternalPublicationBase {
  readonly serverId: string;
  readonly publisherSequence: string;
  readonly publisherNonce: string;
  readonly publisherNonceExpiresAt: number;
  readonly commitToken: string;
  readonly expectedGeneration: string | null;
  readonly generation: string;
  readonly tokenHash: string;
  readonly now: number;
  readonly visibilityCutoff: number;
  readonly name: string;
  readonly isPublic: boolean;
  readonly quicHost: string;
  readonly quicPort: number;
  readonly quicCertSha256: string;
  readonly passwordRequired: boolean;
  readonly directoryFingerprint: string;
}

export interface InternalClassicPublication extends InternalPublicationBase {
  readonly directoryProfile: "classic-v1";
  readonly playersCount: number;
  readonly version: string;
  readonly textComment: string;
}

export interface InternalGamePublication extends InternalPublicationBase {
  readonly directoryProfile: "game-v1";
  readonly description: string;
  readonly region: string | null;
  readonly protocolMajor: 1;
  readonly protocolMinor: number;
  readonly contentId: string;
  readonly contentRevisionSha256: string;
  readonly playersOnline: number;
  readonly playersCapacity: number;
  readonly status: "online" | "full" | "maintenance";
}

export type InternalRendezvousPublication =
  | InternalClassicPublication
  | InternalGamePublication;

const INTERNAL_PUBLICATION_BASE_KEYS = [
  "serverId",
  "directoryProfile",
  "publisherSequence",
  "publisherNonce",
  "publisherNonceExpiresAt",
  "commitToken",
  "expectedGeneration",
  "generation",
  "tokenHash",
  "now",
  "visibilityCutoff",
  "name",
  "isPublic",
  "quicHost",
  "quicPort",
  "quicCertSha256",
  "passwordRequired",
  "directoryFingerprint",
] as const;

const INTERNAL_CLASSIC_PUBLICATION_KEYS = [
  ...INTERNAL_PUBLICATION_BASE_KEYS,
  "playersCount",
  "version",
  "textComment",
] as const;

const INTERNAL_GAME_PUBLICATION_KEYS = [
  ...INTERNAL_PUBLICATION_BASE_KEYS,
  "description",
  "region",
  "protocolMajor",
  "protocolMinor",
  "contentId",
  "contentRevisionSha256",
  "playersOnline",
  "playersCapacity",
  "status",
] as const;

const GAME_REGION = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const GAME_CONTENT_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

/**
 * Validates the private Worker-to-Durable-Object WebSocket upgrade. Public
 * requests must never be able to select a room role through this function.
 */
export function validateInternalRendezvousUpgrade(
  request: Request,
): InternalRendezvousUpgrade | null {
  if (
    request.url !== INTERNAL_RENDEZVOUS_URL ||
    request.method !== "GET" ||
    request.body !== null ||
    request.headers.get("Upgrade") !== "websocket" ||
    request.headers.has(LEGACY_INTERNAL_RENDEZVOUS_ROLE_HEADER) ||
    request.headers.has(LEGACY_INTERNAL_RENDEZVOUS_V1_ROLE_HEADER) ||
    FORBIDDEN_BODY_HEADERS.some((name) => request.headers.has(name))
  ) {
    return null;
  }

  const role = request.headers.get(INTERNAL_RENDEZVOUS_ROLE_HEADER);
  const protocol = request.headers.get(INTERNAL_RENDEZVOUS_PROTOCOL_HEADER);
  const authorization = request.headers.get(
    INTERNAL_RENDEZVOUS_AUTHORIZATION_HEADER,
  );
  const generation = request.headers.get(
    INTERNAL_RENDEZVOUS_GENERATION_HEADER,
  );
  if (
    (role !== "client" && role !== "server") ||
    (protocol !== "none" && protocol !== "classic-invite-v1") ||
    (authorization !== "not-required" && authorization !== "required") ||
    generation === null ||
    !HEX_64.test(generation)
  ) {
    return null;
  }
  const inviteProtocol = protocol === "classic-invite-v1";
  const authorizationRequired = authorization === "required";
  if (
    (role === "server" && authorizationRequired) ||
    (role === "client" && inviteProtocol !== authorizationRequired)
  ) {
    return null;
  }
  return { role, inviteProtocol, authorizationRequired, generation };
}

/**
 * Validates the private Worker-to-room publication commit. The body contains
 * only already-validated directory fields and a token hash; it never contains
 * an ownership key, OTP, raw rendezvous token, invite, or candidate endpoint.
 */
export async function validateInternalRendezvousPublication(
  request: Request,
): Promise<InternalRendezvousPublication | null> {
  if (
    request.url !== INTERNAL_RENDEZVOUS_PUBLISH_URL ||
    request.method !== "POST" ||
    request.body === null ||
    request.headers.get("Content-Type") !== "application/json" ||
    request.headers.has("Upgrade") ||
    request.headers.has(INTERNAL_RENDEZVOUS_ROLE_HEADER) ||
    request.headers.has(INTERNAL_RENDEZVOUS_PROTOCOL_HEADER) ||
    request.headers.has(INTERNAL_RENDEZVOUS_AUTHORIZATION_HEADER) ||
    request.headers.has(INTERNAL_RENDEZVOUS_GENERATION_HEADER) ||
    request.headers.has(LEGACY_INTERNAL_RENDEZVOUS_ROLE_HEADER) ||
    request.headers.has(LEGACY_INTERNAL_RENDEZVOUS_V1_ROLE_HEADER) ||
    request.headers.has("Content-Encoding") ||
    request.headers.has("Transfer-Encoding")
  ) {
    return null;
  }

  const body = await request.text();
  if (
    body.length > MAX_INTERNAL_PUBLICATION_BYTES ||
    new TextEncoder().encode(body).byteLength > MAX_INTERNAL_PUBLICATION_BYTES
  ) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (
    !isJsonObject(parsed) ||
    typeof parsed.serverId !== "string" ||
    !HEX_64.test(parsed.serverId) ||
    (parsed.directoryProfile !== "classic-v1" &&
      parsed.directoryProfile !== "game-v1") ||
    !isPublisherReplayMetadata(parsed) ||
    typeof parsed.commitToken !== "string" ||
    !HEX_64.test(parsed.commitToken) ||
    (parsed.expectedGeneration !== null &&
      (typeof parsed.expectedGeneration !== "string" ||
        !HEX_64.test(parsed.expectedGeneration))) ||
    typeof parsed.generation !== "string" ||
    !HEX_64.test(parsed.generation) ||
    typeof parsed.tokenHash !== "string" ||
    !HEX_64.test(parsed.tokenHash) ||
    !isBoundedInteger(parsed.now, 0, Number.MAX_SAFE_INTEGER) ||
    !isBoundedInteger(parsed.visibilityCutoff, 0, parsed.now) ||
    !isDirectoryText(parsed.name, 80, false) ||
    typeof parsed.isPublic !== "boolean" ||
    !isPort(parsed.quicPort) ||
    !isCanonicalPublicationEndpoint(parsed.quicHost, parsed.quicPort) ||
    typeof parsed.quicCertSha256 !== "string" ||
    parsed.quicCertSha256 !== parsed.serverId ||
    typeof parsed.passwordRequired !== "boolean" ||
    typeof parsed.directoryFingerprint !== "string" ||
    !HEX_64.test(parsed.directoryFingerprint)
  ) {
    return null;
  }

  const common = {
    serverId: parsed.serverId,
    publisherSequence: parsed.publisherSequence,
    publisherNonce: parsed.publisherNonce,
    publisherNonceExpiresAt: parsed.publisherNonceExpiresAt,
    commitToken: parsed.commitToken,
    expectedGeneration: parsed.expectedGeneration,
    generation: parsed.generation,
    tokenHash: parsed.tokenHash,
    now: parsed.now,
    visibilityCutoff: parsed.visibilityCutoff,
    name: parsed.name,
    isPublic: parsed.isPublic,
    quicHost: parsed.quicHost,
    quicPort: parsed.quicPort,
    quicCertSha256: parsed.quicCertSha256,
    passwordRequired: parsed.passwordRequired,
    directoryFingerprint: parsed.directoryFingerprint,
  } as const;

  if (parsed.directoryProfile === "classic-v1") {
    if (
      !hasExactKeys(parsed, INTERNAL_CLASSIC_PUBLICATION_KEYS) ||
      !isBoundedInteger(parsed.playersCount, 0, 4_294_967_295) ||
      !isDirectoryText(parsed.version, 32, false) ||
      !isDirectoryText(parsed.textComment, 256, true)
    ) {
      return null;
    }
    return {
      ...common,
      directoryProfile: "classic-v1",
      playersCount: parsed.playersCount,
      version: parsed.version,
      textComment: parsed.textComment,
    };
  }

  if (
    !hasExactKeys(parsed, INTERNAL_GAME_PUBLICATION_KEYS) ||
    !isGameDirectoryText(parsed.name, 80, false) ||
    !isGameDirectoryText(parsed.description, 512, true) ||
    (parsed.region !== null &&
      (typeof parsed.region !== "string" || !GAME_REGION.test(parsed.region))) ||
    parsed.protocolMajor !== 1 ||
    !isBoundedInteger(parsed.protocolMinor, 0, 65_535) ||
    typeof parsed.contentId !== "string" ||
    !GAME_CONTENT_ID.test(parsed.contentId) ||
    typeof parsed.contentRevisionSha256 !== "string" ||
    !HEX_64.test(parsed.contentRevisionSha256) ||
    !isBoundedInteger(parsed.playersOnline, 0, 100_000) ||
    !isBoundedInteger(parsed.playersCapacity, 1, 100_000) ||
    parsed.playersOnline > parsed.playersCapacity ||
    (parsed.status !== "online" && parsed.status !== "full" &&
      parsed.status !== "maintenance") ||
    (parsed.status === "online" &&
      parsed.playersOnline >= parsed.playersCapacity) ||
    (parsed.status === "full" &&
      parsed.playersOnline !== parsed.playersCapacity) ||
    (parsed.status === "maintenance" && parsed.playersOnline !== 0)
  ) {
    return null;
  }

  return {
    ...common,
    directoryProfile: "game-v1",
    description: parsed.description,
    region: parsed.region,
    protocolMajor: 1,
    protocolMinor: parsed.protocolMinor,
    contentId: parsed.contentId,
    contentRevisionSha256: parsed.contentRevisionSha256,
    playersOnline: parsed.playersOnline,
    playersCapacity: parsed.playersCapacity,
    status: parsed.status,
  };
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
  const serialized = serializeRendezvousSignal(signal);
  if (isAuthorizationSignal(signal) && message !== serialized) {
    return { ok: false, error: "unsupported_signal" };
  }
  return {
    ok: true,
    signal,
    serialized,
    bytes,
  };
}

/**
 * Produces the stable property order consumed by existing classic peers.
 */
export function serializeRendezvousSignal(signal: RendezvousSignal): string {
  switch (signal.type) {
    case "auth_init":
      return JSON.stringify({
        type: signal.type,
        version: signal.version,
        ticket: signal.ticket,
        invite_id: signal.invite_id,
      });
    case "auth_challenge":
      return JSON.stringify({
        type: signal.type,
        version: signal.version,
        ticket: signal.ticket,
        challenge: signal.challenge,
      });
    case "auth_proof":
      return JSON.stringify({
        type: signal.type,
        version: signal.version,
        ticket: signal.ticket,
        proof: signal.proof,
      });
    case "auth_result":
      return JSON.stringify({
        type: signal.type,
        version: signal.version,
        ticket: signal.ticket,
        authorized: signal.authorized,
      });
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
  if (fields.type === "auth_init") {
    if (
      !hasExactKeys(fields, AUTH_INIT_KEYS) ||
      fields.version !== 1 ||
      !isTicket(fields.ticket) ||
      !isInviteId(fields.invite_id)
    ) {
      return null;
    }
    return {
      type: "auth_init",
      version: 1,
      ticket: fields.ticket,
      invite_id: fields.invite_id,
    };
  }
  if (fields.type === "auth_challenge") {
    if (
      !hasExactKeys(fields, AUTH_CHALLENGE_KEYS) ||
      fields.version !== 1 ||
      !isTicket(fields.ticket) ||
      !isTicket(fields.challenge)
    ) {
      return null;
    }
    return {
      type: "auth_challenge",
      version: 1,
      ticket: fields.ticket,
      challenge: fields.challenge,
    };
  }
  if (fields.type === "auth_proof") {
    if (
      !hasExactKeys(fields, AUTH_PROOF_KEYS) ||
      fields.version !== 1 ||
      !isTicket(fields.ticket) ||
      !isTicket(fields.proof)
    ) {
      return null;
    }
    return {
      type: "auth_proof",
      version: 1,
      ticket: fields.ticket,
      proof: fields.proof,
    };
  }
  if (fields.type === "auth_result") {
    if (
      !hasExactKeys(fields, AUTH_RESULT_KEYS) ||
      fields.version !== 1 ||
      !isTicket(fields.ticket) ||
      typeof fields.authorized !== "boolean"
    ) {
      return null;
    }
    return {
      type: "auth_result",
      version: 1,
      ticket: fields.ticket,
      authorized: fields.authorized,
    };
  }
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

function isBoundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function isBoundedString(
  value: unknown,
  minimumLength: number,
  maximumLength: number,
): value is string {
  return typeof value === "string" && value.length >= minimumLength &&
    value.length <= maximumLength;
}

function isCanonicalPublicationEndpoint(
  host: unknown,
  port: number,
): host is string {
  return host === ""
    ? port === 1
    : isCanonicalHostname(host);
}

type ValidPublisherReplayMetadata = {
  readonly directoryProfile: DirectoryProfile;
  readonly publisherSequence: string;
  readonly publisherNonce: string;
  readonly publisherNonceExpiresAt: number;
};

function isPublisherReplayMetadata(
  value: Record<string, unknown>,
): value is Record<string, unknown> & ValidPublisherReplayMetadata {
  if (
    typeof value.publisherSequence !== "string" ||
    !PUBLISH_SEQUENCE.test(value.publisherSequence) ||
    typeof value.publisherNonce !== "string" ||
    !HEX_32.test(value.publisherNonce) ||
    /^0+$/.test(value.publisherNonce) ||
    !isBoundedInteger(value.now, 0, Number.MAX_SAFE_INTEGER) ||
    !isBoundedInteger(
      value.publisherNonceExpiresAt,
      value.now,
      Number.MAX_SAFE_INTEGER,
    ) ||
    value.publisherNonceExpiresAt !==
      value.now + PUBLISH_NONCE_RETENTION_SECONDS
  ) {
    return false;
  }
  try {
    const sequence = BigInt(value.publisherSequence);
    return sequence > 0n && sequence <= UINT64_MAXIMUM;
  } catch {
    return false;
  }
}

function isTicket(value: unknown): value is string {
  return typeof value === "string" && HEX_64.test(value);
}

function isInviteId(value: unknown): value is string {
  return typeof value === "string" && HEX_32.test(value);
}

function isAuthorizationSignal(
  signal: RendezvousSignal,
): signal is AuthInitSignal | AuthChallengeSignal | AuthProofSignal | AuthResultSignal {
  return signal.type === "auth_init" || signal.type === "auth_challenge" ||
    signal.type === "auth_proof" || signal.type === "auth_result";
}

function isServerSignalCandidateKind(
  value: unknown,
): value is ServerSignalCandidateKind {
  return typeof value === "string" &&
    (SERVER_SIGNAL_CANDIDATE_KINDS as readonly string[]).includes(value);
}
