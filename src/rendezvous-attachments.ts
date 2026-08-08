import { RENDEZVOUS_POLICY_MAXIMUMS } from "./config";
import {
  MAX_CLIENT_CANDIDATES,
  MAX_CLIENT_AUTHORIZATION_FRAMES,
  MAX_COMPLETIONS,
  MAX_RENDEZVOUS_SESSION_SIGNAL_BYTES,
  MAX_SERVER_CANDIDATES,
  MAX_SERVER_AUTHORIZATION_FRAMES,
  MAX_TERMINAL_CLOSE_ATTEMPTS,
  RENDEZVOUS_TERMINAL_OUTCOMES,
  TERMINAL_CLOSE_RETRY_HORIZON_MS,
} from "./rendezvous-contract";
import type { RendezvousTerminalOutcome } from "./rendezvous-contract";

export const ATTACHMENT_VERSION = 2;
export const MAX_RETAINED_TICKETS =
  RENDEZVOUS_POLICY_MAXIMUMS.rendezvousClientRollingLimit;
export const MAX_SESSION_MS =
  RENDEZVOUS_POLICY_MAXIMUMS.rendezvousClientSessionSeconds * 1_000;

const HEX_64 = /^[0-9a-f]{64}$/;
const CONNECTION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type ClientStage =
  | "awaiting_candidate"
  | "candidate_exchange"
  | "terminal";
export type TicketStage = "active" | "terminal";
export type AuthorizationState =
  | "not_required"
  | "awaiting_init"
  | "awaiting_challenge"
  | "awaiting_proof"
  | "awaiting_result"
  | "authorized"
  | "terminal";
export type TicketAuthorizationState =
  | "not_required"
  | "awaiting_challenge"
  | "awaiting_proof"
  | "awaiting_result"
  | "authorized"
  | "denied";

export interface ClientAttachment {
  readonly v: typeof ATTACHMENT_VERSION;
  readonly role: "client";
  readonly controlId: string;
  readonly generation: string;
  readonly connectionId: string;
  readonly admissionId: number;
  readonly openedAt: number;
  readonly expiresAt: number;
  ticket: string | null;
  ticketDigest: string | null;
  stage: ClientStage;
  authorization: AuthorizationState;
  clientAuthorizationFrames: number;
  serverAuthorizationFrames: number;
  clientCandidates: number;
  serverCandidates: number;
  completionCount: number;
  signalBytes: number;
  framesForwarded: number;
  summaryEmitted: boolean;
  terminalOutcome: RendezvousTerminalOutcome | null;
  terminalCloseAttempts: number;
}

export interface TicketState {
  readonly ticketDigest: string;
  readonly clientConnectionId: string;
  readonly openedAt: number;
  readonly expiresAt: number;
  stage: TicketStage;
  authorization: TicketAuthorizationState;
  clientAuthorizationFrames: number;
  serverAuthorizationFrames: number;
  serverCandidates: number;
  completionCount: number;
  signalBytes: number;
}

export interface ServerAttachment {
  readonly v: typeof ATTACHMENT_VERSION;
  readonly role: "server";
  current: boolean;
  readonly inviteProtocol: boolean;
  readonly controlId: string;
  readonly generation: string;
  readonly openedAt: number;
  tickets: TicketState[];
}

export type RendezvousAttachment = ClientAttachment | ServerAttachment;

export type StoredTicketState = [
  ticketDigest: string,
  clientConnectionId: string,
  openedAt: number,
  expiresAt: number,
  stage: 0 | 1,
  serverCandidates: number,
  completionCount: number,
  signalBytes: number,
  authorization: 0 | 2 | 3 | 4 | 5 | 6,
  clientAuthorizationFrames: number,
  serverAuthorizationFrames: number,
];

export interface StoredClientAttachment {
  readonly v: typeof ATTACHMENT_VERSION;
  readonly r: "c";
  readonly c: string;
  readonly g: string;
  readonly i: string;
  readonly a: number;
  readonly o: number;
  readonly x: number;
  readonly t: string | null;
  readonly d: string | null;
  readonly s: 0 | 1 | 2;
  readonly p: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  readonly h: number;
  readonly j: number;
  readonly n: number;
  readonly q: number;
  readonly z: number;
  readonly b: number;
  readonly f: number;
  readonly m: boolean;
  readonly y: number | null;
  readonly k: number;
}

export interface StoredServerAttachment {
  readonly v: typeof ATTACHMENT_VERSION;
  readonly r: "s";
  readonly u: boolean;
  readonly p: boolean;
  readonly c: string;
  readonly g: string;
  readonly o: number;
  readonly t: StoredTicketState[];
}

export type StoredRendezvousAttachment =
  | StoredClientAttachment
  | StoredServerAttachment;

/**
 * Decode the untrusted structured-clone value stored by WebSocket hibernation.
 * The boundary is pure so every accepted persisted shape can be tested without
 * a Durable Object or WebSocket instance.
 */
export function decodeRendezvousAttachment(
  value: unknown,
): RendezvousAttachment | null {
  if (!isRecord(value) || value.v !== ATTACHMENT_VERSION) {
    return null;
  }
  return value.r === "c"
    ? decodeClientAttachment(value)
    : value.r === "s"
      ? decodeServerAttachment(value)
      : null;
}

export function encodeRendezvousAttachment(
  attachment: ClientAttachment,
): StoredClientAttachment;
export function encodeRendezvousAttachment(
  attachment: ServerAttachment,
): StoredServerAttachment;
export function encodeRendezvousAttachment(
  attachment: RendezvousAttachment,
): StoredRendezvousAttachment;
export function encodeRendezvousAttachment(
  attachment: RendezvousAttachment,
): StoredRendezvousAttachment {
  return attachment.role === "client"
    ? encodeClientAttachment(attachment)
    : encodeServerAttachment(attachment);
}

export function readAttachment(
  socket: WebSocket,
): RendezvousAttachment | null {
  let value: unknown;
  try {
    value = socket.deserializeAttachment();
  } catch {
    return null;
  }
  return decodeRendezvousAttachment(value);
}

export function readClientAttachment(
  socket: WebSocket,
): ClientAttachment | null {
  const attachment = readAttachment(socket);
  return attachment?.role === "client" ? attachment : null;
}

export function readServerAttachment(
  socket: WebSocket,
): ServerAttachment | null {
  const attachment = readAttachment(socket);
  return attachment?.role === "server" ? attachment : null;
}

export function writeAttachment(
  socket: WebSocket,
  attachment: RendezvousAttachment,
): void {
  socket.serializeAttachment(encodeRendezvousAttachment(attachment));
}

export function tryWriteAttachment(
  socket: WebSocket,
  attachment: RendezvousAttachment,
): boolean {
  try {
    writeAttachment(socket, attachment);
    return true;
  } catch {
    // Callers that require a durable transition can distinguish this from a
    // successful write and decide whether a completed transport close is
    // sufficient or the current platform event must fail.
    return false;
  }
}

function decodeClientAttachment(
  value: Record<string, unknown>,
): ClientAttachment | null {
  if (
    !hasExactKeys(value, [
      "v", "r", "c", "g", "i", "a", "o", "x", "t", "d", "s", "p", "h",
      "j", "n", "q", "z", "b", "f", "m", "y", "k",
    ]) ||
    value.v !== ATTACHMENT_VERSION ||
    value.r !== "c" ||
    !isConnectionId(value.c) ||
    !isHex64(value.g) ||
    !isConnectionId(value.i) ||
    !isPositiveInteger(value.a) ||
    !isTimestamp(value.o) ||
    !isTimestamp(value.x) ||
    value.x <= value.o ||
    value.x - value.o > MAX_SESSION_MS ||
    !isClientStage(value.s) ||
    !isAuthorizationState(value.p) ||
    !isBoundedInteger(value.h, 0, MAX_CLIENT_AUTHORIZATION_FRAMES) ||
    !isBoundedInteger(value.j, 0, MAX_SERVER_AUTHORIZATION_FRAMES) ||
    !isBoundedInteger(value.n, 0, MAX_CLIENT_CANDIDATES) ||
    !isBoundedInteger(value.q, 0, MAX_SERVER_CANDIDATES) ||
    !isBoundedInteger(value.z, 0, MAX_COMPLETIONS) ||
    !isBoundedInteger(
      value.b,
      0,
      MAX_RENDEZVOUS_SESSION_SIGNAL_BYTES,
    ) ||
    !isBoundedInteger(
      value.f,
      0,
      MAX_CLIENT_AUTHORIZATION_FRAMES + MAX_SERVER_AUTHORIZATION_FRAMES +
        MAX_CLIENT_CANDIDATES + MAX_SERVER_CANDIDATES + MAX_COMPLETIONS,
    ) ||
    typeof value.m !== "boolean" ||
    !isBoundedInteger(value.k, 0, MAX_TERMINAL_CLOSE_ATTEMPTS) ||
    value.x > Number.MAX_SAFE_INTEGER - TERMINAL_CLOSE_RETRY_HORIZON_MS
  ) {
    return null;
  }

  const terminalOutcome = decodeTerminalOutcome(value.y);
  const authorization = decodeAuthorizationState(value.p);
  if (
    authorization === null ||
    (value.y !== null && terminalOutcome === null) ||
    (value.s === 2) !== (terminalOutcome !== null)
  ) {
    return null;
  }

  let ticket: string | null;
  let ticketDigest: string | null;
  if (value.t === null && value.d === null) {
    ticket = null;
    ticketDigest = null;
  } else if (isHex64(value.t) && isHex64(value.d)) {
    ticket = value.t;
    ticketDigest = value.d;
  } else {
    return null;
  }

  const ticketIsNull = ticket === null;
  const acceptedFrames = value.h + value.j + value.n + value.q + value.z;
  if (
    !authorizationFrameCountsAreValid(authorization, value.h, value.j) ||
    value.f > acceptedFrames ||
    (acceptedFrames === 0) !== (value.b === 0) ||
    (value.z === MAX_COMPLETIONS && value.s !== 2) ||
    (value.s === 0 && (value.n !== 0 || value.q !== 0 || value.z !== 0)) ||
    (value.s === 1 &&
      (ticketIsNull || value.n !== MAX_CLIENT_CANDIDATES || value.z !== 0)) ||
    (value.s === 2 && !ticketIsNull) ||
    ((value.s === 2) !== (authorization === "terminal")) ||
    (value.s !== 2 && value.k !== 0) ||
    (authorization === "awaiting_init" &&
      (value.s !== 0 || !ticketIsNull || acceptedFrames !== 0)) ||
    (authorization === "not_required" &&
      ((value.s === 0 && !ticketIsNull) ||
        (value.s === 1 && ticketIsNull))) ||
    ((authorization === "awaiting_challenge" ||
      authorization === "awaiting_proof" ||
      authorization === "awaiting_result") &&
      (value.s !== 0 || ticketIsNull)) ||
    (authorization === "authorized" && ticketIsNull) ||
    (value.s === 1 &&
      authorization !== "not_required" && authorization !== "authorized")
  ) {
    return null;
  }

  return {
    v: ATTACHMENT_VERSION,
    role: "client",
    controlId: value.c,
    generation: value.g,
    connectionId: value.i,
    admissionId: value.a,
    openedAt: value.o,
    expiresAt: value.x,
    ticket,
    ticketDigest,
    stage: decodeClientStage(value.s),
    authorization,
    clientAuthorizationFrames: value.h,
    serverAuthorizationFrames: value.j,
    clientCandidates: value.n,
    serverCandidates: value.q,
    completionCount: value.z,
    signalBytes: value.b,
    framesForwarded: value.f,
    summaryEmitted: value.m,
    terminalOutcome,
    terminalCloseAttempts: value.k,
  };
}

function decodeServerAttachment(
  value: Record<string, unknown>,
): ServerAttachment | null {
  if (
    !hasExactKeys(value, ["v", "r", "u", "p", "c", "g", "o", "t"]) ||
    value.v !== ATTACHMENT_VERSION ||
    value.r !== "s" ||
    typeof value.u !== "boolean" ||
    typeof value.p !== "boolean" ||
    !isConnectionId(value.c) ||
    !isHex64(value.g) ||
    !isTimestamp(value.o) ||
    !Array.isArray(value.t) ||
    value.t.length > MAX_RETAINED_TICKETS ||
    !value.t.every(isStoredTicketState)
  ) {
    return null;
  }

  const tickets = value.t.map(decodeTicketState);
  if (
    new Set(tickets.map(({ ticketDigest }) => ticketDigest)).size !==
      tickets.length ||
    new Set(tickets.map(({ clientConnectionId }) => clientConnectionId)).size !==
      tickets.length
  ) {
    return null;
  }
  return {
    v: ATTACHMENT_VERSION,
    role: "server",
    current: value.u,
    inviteProtocol: value.p,
    controlId: value.c,
    generation: value.g,
    openedAt: value.o,
    tickets,
  };
}

function isStoredTicketState(value: unknown): value is StoredTicketState {
  if (!Array.isArray(value) || value.length !== 11) {
    return false;
  }
  if (!hasExactKeys(value, [
    "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10",
  ])) {
    return false;
  }
  const [digest, connectionId, openedAt, expiresAt, stage,
    serverCandidates, completionCount, signalBytes, authorizationCode,
    clientAuthorizationFrames, serverAuthorizationFrames] = value;
  const authorization = decodeTicketAuthorizationState(authorizationCode);
  return isHex64(digest) &&
    isConnectionId(connectionId) &&
    isTimestamp(openedAt) &&
    isTimestamp(expiresAt) &&
    expiresAt > openedAt &&
    expiresAt - openedAt <= MAX_SESSION_MS &&
    isTicketStage(stage) &&
    isBoundedInteger(serverCandidates, 0, MAX_SERVER_CANDIDATES) &&
    isBoundedInteger(completionCount, 0, MAX_COMPLETIONS) &&
    !(stage === 0 && completionCount !== 0) &&
    authorization !== null &&
    ticketAuthorizationFrameCountsAreValid(
      authorization,
      clientAuthorizationFrames,
      serverAuthorizationFrames,
    ) &&
    !(stage === 0 && authorization === "denied") &&
    !((authorization === "awaiting_challenge" ||
      authorization === "awaiting_proof" ||
      authorization === "awaiting_result" ||
      authorization === "denied") &&
      (serverCandidates !== 0 || completionCount !== 0)) &&
    isBoundedInteger(
      signalBytes,
      1,
      MAX_RENDEZVOUS_SESSION_SIGNAL_BYTES,
    );
}

function decodeTicketState(value: StoredTicketState): TicketState {
  const authorization = decodeTicketAuthorizationState(value[8]);
  if (authorization === null) {
    throw new Error("Invalid stored rendezvous authorization state");
  }
  return {
    ticketDigest: value[0],
    clientConnectionId: value[1],
    openedAt: value[2],
    expiresAt: value[3],
    stage: value[4] === 0 ? "active" : "terminal",
    serverCandidates: value[5],
    completionCount: value[6],
    signalBytes: value[7],
    authorization,
    clientAuthorizationFrames: value[9],
    serverAuthorizationFrames: value[10],
  };
}

function encodeClientAttachment(
  attachment: ClientAttachment,
): StoredClientAttachment {
  return {
    v: ATTACHMENT_VERSION,
    r: "c",
    c: attachment.controlId,
    g: attachment.generation,
    i: attachment.connectionId,
    a: attachment.admissionId,
    o: attachment.openedAt,
    x: attachment.expiresAt,
    t: attachment.ticket,
    d: attachment.ticketDigest,
    s: encodeClientStage(attachment.stage),
    p: encodeAuthorizationState(attachment.authorization),
    h: attachment.clientAuthorizationFrames,
    j: attachment.serverAuthorizationFrames,
    n: attachment.clientCandidates,
    q: attachment.serverCandidates,
    z: attachment.completionCount,
    b: attachment.signalBytes,
    f: attachment.framesForwarded,
    m: attachment.summaryEmitted,
    y: attachment.terminalOutcome === null
      ? null
      : encodeTerminalOutcome(attachment.terminalOutcome),
    k: attachment.terminalCloseAttempts,
  };
}

function encodeServerAttachment(
  attachment: ServerAttachment,
): StoredServerAttachment {
  return {
    v: ATTACHMENT_VERSION,
    r: "s",
    u: attachment.current,
    p: attachment.inviteProtocol,
    c: attachment.controlId,
    g: attachment.generation,
    o: attachment.openedAt,
    t: attachment.tickets.map((ticket): StoredTicketState => [
      ticket.ticketDigest,
      ticket.clientConnectionId,
      ticket.openedAt,
      ticket.expiresAt,
      ticket.stage === "active" ? 0 : 1,
      ticket.serverCandidates,
      ticket.completionCount,
      ticket.signalBytes,
      encodeTicketAuthorizationState(ticket.authorization),
      ticket.clientAuthorizationFrames,
      ticket.serverAuthorizationFrames,
    ]),
  };
}

function encodeClientStage(stage: ClientStage): 0 | 1 | 2 {
  return stage === "awaiting_candidate" ? 0 :
    stage === "candidate_exchange" ? 1 : 2;
}

function decodeClientStage(stage: 0 | 1 | 2): ClientStage {
  return stage === 0 ? "awaiting_candidate" :
    stage === 1 ? "candidate_exchange" : "terminal";
}

function encodeAuthorizationState(
  state: AuthorizationState,
): 0 | 1 | 2 | 3 | 4 | 5 | 6 {
  switch (state) {
    case "not_required":
      return 0;
    case "awaiting_init":
      return 1;
    case "awaiting_challenge":
      return 2;
    case "awaiting_proof":
      return 3;
    case "awaiting_result":
      return 4;
    case "authorized":
      return 5;
    case "terminal":
      return 6;
  }
}

function encodeTicketAuthorizationState(
  state: TicketAuthorizationState,
): 0 | 2 | 3 | 4 | 5 | 6 {
  switch (state) {
    case "not_required":
      return 0;
    case "awaiting_challenge":
      return 2;
    case "awaiting_proof":
      return 3;
    case "awaiting_result":
      return 4;
    case "authorized":
      return 5;
    case "denied":
      return 6;
  }
}

function decodeTicketAuthorizationState(
  value: unknown,
): TicketAuthorizationState | null {
  switch (value) {
    case 0:
      return "not_required";
    case 2:
      return "awaiting_challenge";
    case 3:
      return "awaiting_proof";
    case 4:
      return "awaiting_result";
    case 5:
      return "authorized";
    case 6:
      return "denied";
    default:
      return null;
  }
}

function decodeAuthorizationState(value: unknown): AuthorizationState | null {
  switch (value) {
    case 0:
      return "not_required";
    case 1:
      return "awaiting_init";
    case 2:
      return "awaiting_challenge";
    case 3:
      return "awaiting_proof";
    case 4:
      return "awaiting_result";
    case 5:
      return "authorized";
    case 6:
      return "terminal";
    default:
      return null;
  }
}

function authorizationFrameCountsAreValid(
  state: AuthorizationState,
  clientFrames: unknown,
  serverFrames: unknown,
): boolean {
  if (
    !isBoundedInteger(clientFrames, 0, MAX_CLIENT_AUTHORIZATION_FRAMES) ||
    !isBoundedInteger(serverFrames, 0, MAX_SERVER_AUTHORIZATION_FRAMES)
  ) {
    return false;
  }
  switch (state) {
    case "not_required":
    case "awaiting_init":
      return clientFrames === 0 && serverFrames === 0;
    case "awaiting_challenge":
      return clientFrames === 1 && serverFrames === 0;
    case "awaiting_proof":
      return clientFrames === 1 && serverFrames === 1;
    case "awaiting_result":
      return clientFrames === 2 && serverFrames === 1;
    case "authorized":
      return clientFrames === 2 && serverFrames === 2;
    case "terminal":
      return (clientFrames === 0 && serverFrames === 0) ||
        (clientFrames === 1 && serverFrames === 0) ||
        (clientFrames === 1 && serverFrames === 1) ||
        (clientFrames === 2 && serverFrames === 1) ||
        (clientFrames === 2 && serverFrames === 2);
  }
}

function ticketAuthorizationFrameCountsAreValid(
  state: TicketAuthorizationState | null,
  clientFrames: unknown,
  serverFrames: unknown,
): boolean {
  if (state === null) {
    return false;
  }
  if (state === "denied") {
    return clientFrames === 2 && serverFrames === 2;
  }
  return authorizationFrameCountsAreValid(
    state,
    clientFrames,
    serverFrames,
  );
}

function encodeTerminalOutcome(outcome: RendezvousTerminalOutcome): number {
  const code = RENDEZVOUS_TERMINAL_OUTCOMES.indexOf(outcome);
  if (code < 0) {
    throw new Error("Invalid rendezvous terminal outcome");
  }
  return code;
}

function decodeTerminalOutcome(
  value: unknown,
): RendezvousTerminalOutcome | null {
  if (value === null) {
    return null;
  }
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < 0 ||
    Number(value) >= RENDEZVOUS_TERMINAL_OUTCOMES.length
  ) {
    return null;
  }
  return RENDEZVOUS_TERMINAL_OUTCOMES[Number(value)] ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key));
}

function isHex64(value: unknown): value is string {
  return typeof value === "string" && HEX_64.test(value);
}

function isConnectionId(value: unknown): value is string {
  return typeof value === "string" && CONNECTION_ID.test(value);
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function isClientStage(value: unknown): value is 0 | 1 | 2 {
  return value === 0 || value === 1 || value === 2;
}

function isAuthorizationState(
  value: unknown,
): value is 0 | 1 | 2 | 3 | 4 | 5 | 6 {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 6;
}

function isTicketStage(value: unknown): value is 0 | 1 {
  return value === 0 || value === 1;
}

function isBoundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return Number.isSafeInteger(value) &&
    Number(value) >= minimum &&
    Number(value) <= maximum;
}
