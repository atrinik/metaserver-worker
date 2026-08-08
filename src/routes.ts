import { HttpError } from "./http";
import { isCanonicalHostname } from "./hostname";

export const PUBLISH_AUTHORITY = "publish.meta.atrinik.org";
export const RENDEZVOUS_AUTHORITY = "rendezvous.meta.atrinik.org";
export const COMPATIBILITY_AUTHORITY = "meta.atrinik.org";
export const PUBLISH_MAX_BODY_BYTES = 65_536;
export const COMPATIBILITY_UPDATE_MAX_BODY_BYTES = 100_000;

const SERVER_ID = /^[0-9a-f]{64}$/;
const MAX_REQUEST_TARGET_BYTES = 2_048;
const CRITICAL_HEADERS = [
  "authorization",
  "connection",
  "content-digest",
  "content-encoding",
  "content-length",
  "content-type",
  "host",
  "sec-websocket-key",
  "sec-websocket-protocol",
  "sec-websocket-version",
  "signature",
  "signature-input",
  "transfer-encoding",
  "upgrade",
] as const;

export type ProtocolGeneration = "game-protocol-1" | "classic";
export type RendezvousRole = "client" | "server";

export interface RouteInput {
  /**
   * Absolute request target to classify. `routeInputFromRequest()` supplies the
   * platform-normalized `Request.url`; pure fixtures may supply raw spellings
   * to exercise the grammar that must also be enforced at the edge.
   */
  readonly target: string;
  readonly method: string;
  readonly headers: Headers;
  readonly hasBody: boolean;
}

export type CanonicalDynamicRoute =
  | {
      readonly kind: "publish";
      readonly generation: ProtocolGeneration;
      readonly serverId: string;
      readonly authority: typeof PUBLISH_AUTHORITY;
      readonly maximumBodyBytes: typeof PUBLISH_MAX_BODY_BYTES;
    }
  | {
      readonly kind: "rendezvous";
      readonly generation: ProtocolGeneration;
      readonly serverId: string;
      readonly role: RendezvousRole;
      readonly authority: typeof RENDEZVOUS_AUTHORITY;
    };

export type CompatibilityRoute =
  | {
      readonly kind: "compatibility-status";
      readonly generation: "classic";
    }
  | {
      readonly kind: "compatibility-directory";
      readonly generation: "classic";
    }
  | {
      readonly kind: "compatibility-otp";
      readonly generation: "classic";
    }
  | {
      readonly kind: "compatibility-update";
      readonly generation: "classic";
      readonly maximumBodyBytes: typeof COMPATIBILITY_UPDATE_MAX_BODY_BYTES;
    }
  | {
      readonly kind: "compatibility-rendezvous";
      readonly generation: "classic";
      readonly serverId: string;
      readonly role: RendezvousRole;
    };

interface ParsedTarget {
  readonly authority: string;
  readonly path: string;
  readonly query: string | null;
}

export function routeInputFromRequest(request: Request): RouteInput {
  return {
    target: request.url,
    method: request.method,
    headers: request.headers,
    hasBody: request.body !== null,
  };
}

/**
 * Classifies only the final dynamic API. Static directory authorities and all
 * compatibility paths intentionally remain unreachable through this function.
 */
export function classifyCanonicalRoute(
  input: RouteInput,
): CanonicalDynamicRoute {
  rejectAmbiguousCriticalHeaders(input.headers);
  const target = parseTarget(input.target);

  if (target.authority === PUBLISH_AUTHORITY) {
    enforceHostHeader(input.headers, PUBLISH_AUTHORITY);
    return classifyPublisher(input, target);
  }
  if (target.authority === RENDEZVOUS_AUTHORITY) {
    enforceHostHeader(input.headers, RENDEZVOUS_AUTHORITY);
    return classifyRendezvous(input, target);
  }

  throw new HttpError("misdirected_request");
}

/**
 * Models the currently deployed classic routes without making them aliases of
 * the canonical services. Callers must opt into compatibility dispatch and can
 * remove it independently at the end of the cutover window.
 */
export function classifyCompatibilityRoute(
  input: RouteInput,
  expectedAuthority = COMPATIBILITY_AUTHORITY,
): CompatibilityRoute {
  rejectAmbiguousCriticalHeaders(input.headers);
  const authority = validateCompatibilityAuthority(expectedAuthority);
  const target = parseTarget(input.target);
  if (target.authority !== authority) {
    throw new HttpError("misdirected_request");
  }
  enforceHostHeader(input.headers, authority);

  switch (target.path) {
    case "/":
      enforceMethod(input.method, "GET");
      enforceNoQuery(target.query);
      enforceNoBody(input);
      enforceNoUpgrade(input.headers);
      return { kind: "compatibility-status", generation: "classic" };
    case "/v2/servers":
      enforceMethod(input.method, "GET");
      enforceNoQuery(target.query);
      enforceNoBody(input);
      enforceNoUpgrade(input.headers);
      return { kind: "compatibility-directory", generation: "classic" };
    case "/index.wsgi/otp":
      enforceMethod(input.method, "GET");
      enforceNoQuery(target.query);
      enforceNoBody(input);
      enforceNoUpgrade(input.headers);
      return { kind: "compatibility-otp", generation: "classic" };
    case "/index.wsgi/update":
      enforceMethod(input.method, "POST");
      enforceNoQuery(target.query);
      enforceCompatibilityUpdateBody(input);
      enforceNoUpgrade(input.headers);
      return {
        kind: "compatibility-update",
        generation: "classic",
        maximumBodyBytes: COMPATIBILITY_UPDATE_MAX_BODY_BYTES,
      };
    default:
      return classifyCompatibilityRendezvous(input, target);
  }
}

function validateCompatibilityAuthority(value: string): string {
  if (!isCanonicalHostname(value)) {
    throw new HttpError("misdirected_request");
  }
  return value;
}

function classifyPublisher(
  input: RouteInput,
  target: ParsedTarget,
): CanonicalDynamicRoute {
  const route = matchCanonicalServerPath(target.path, true);
  if (route === null) {
    throw new HttpError("not_found");
  }

  enforceMethod(input.method, "POST");
  enforceNoQuery(target.query);
  enforceNoUpgrade(input.headers);
  enforcePublisherBody(input);
  return {
    kind: "publish",
    generation: route.generation,
    serverId: route.serverId,
    authority: PUBLISH_AUTHORITY,
    maximumBodyBytes: PUBLISH_MAX_BODY_BYTES,
  };
}

function classifyRendezvous(
  input: RouteInput,
  target: ParsedTarget,
): CanonicalDynamicRoute {
  const route = matchCanonicalServerPath(target.path, false);
  if (route === null) {
    throw new HttpError("not_found");
  }

  enforceMethod(input.method, "GET");
  const role = parseRendezvousRole(target.query);
  enforceNoBody(input);
  enforceWebSocketUpgrade(input.headers);
  return {
    kind: "rendezvous",
    generation: route.generation,
    serverId: route.serverId,
    role,
    authority: RENDEZVOUS_AUTHORITY,
  };
}

function classifyCompatibilityRendezvous(
  input: RouteInput,
  target: ParsedTarget,
): CompatibilityRoute {
  const match = /^\/v2\/rendezvous\/([^/]+)$/.exec(target.path);
  if (match === null) {
    throw new HttpError("not_found");
  }
  const serverId = validateServerId(match[1]);

  enforceMethod(input.method, "GET");
  const role = parseRendezvousRole(target.query);
  enforceNoBody(input);
  enforceWebSocketUpgrade(input.headers);
  return {
    kind: "compatibility-rendezvous",
    generation: "classic",
    serverId,
    role,
  };
}

function parseTarget(target: string): ParsedTarget {
  if (
    target.length === 0 ||
    new TextEncoder().encode(target).byteLength > MAX_REQUEST_TARGET_BYTES ||
    !/^[\x21-\x7e]+$/.test(target) ||
    target.includes("\\")
  ) {
    throw new HttpError("invalid_target");
  }

  const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(#.*)?$/.exec(
    target,
  );
  if (match === null || match[1] !== "https" || match[5] !== undefined) {
    throw new HttpError("invalid_target");
  }

  const rawAuthority = match[2];
  const path = match[3];
  if (
    rawAuthority.length === 0 ||
    rawAuthority.includes("@") ||
    rawAuthority.includes(":") ||
    path.length === 0 ||
    !path.startsWith("/") ||
    path.includes("%") ||
    path.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new HttpError("invalid_target");
  }

  return {
    authority: rawAuthority.toLowerCase(),
    path,
    query: match[4] ?? null,
  };
}

function matchCanonicalServerPath(
  path: string,
  publish: boolean,
): { readonly generation: ProtocolGeneration; readonly serverId: string } | null {
  const suffix = publish ? "/publish" : "";
  const game = new RegExp(`^/v1/servers/([^/]+)${suffix}$`).exec(path);
  if (game !== null) {
    return {
      generation: "game-protocol-1",
      serverId: validateServerId(game[1]),
    };
  }

  const classic = new RegExp(
    `^/v1/classic/servers/([^/]+)${suffix}$`,
  ).exec(path);
  if (classic !== null) {
    return {
      generation: "classic",
      serverId: validateServerId(classic[1]),
    };
  }
  return null;
}

function validateServerId(value: string): string {
  if (!SERVER_ID.test(value)) {
    throw new HttpError("invalid_server_id");
  }
  return value;
}

function enforceMethod(actual: string, expected: "GET" | "POST"): void {
  if (actual !== expected) {
    throw new HttpError("method_not_allowed", { allow: [expected] });
  }
}

function enforceNoQuery(query: string | null): void {
  if (query !== null) {
    throw new HttpError("unexpected_query");
  }
}

function parseRendezvousRole(query: string | null): RendezvousRole {
  if (query === "role=client") {
    return "client";
  }
  if (query === "role=server") {
    return "server";
  }
  throw new HttpError("unexpected_query");
}

function enforcePublisherBody(input: RouteInput): void {
  const contentType = input.headers.get("Content-Type");
  if (contentType !== "application/json") {
    throw new HttpError("unsupported_media_type");
  }
  if (
    input.headers.has("Content-Encoding") ||
    input.headers.has("Transfer-Encoding")
  ) {
    throw new HttpError("unsupported_media_type");
  }

  const length = declaredContentLength(input.headers);
  if (!input.hasBody || length === 0) {
    throw new HttpError("body_required");
  }
  if (length !== null && length > PUBLISH_MAX_BODY_BYTES) {
    throw new HttpError("payload_too_large");
  }
}

function enforceCompatibilityUpdateBody(input: RouteInput): void {
  const contentType = input.headers.get("Content-Type") ?? "";
  const isUrlEncoded = contentType === "application/x-www-form-urlencoded";
  const isMultipart = /^multipart\/form-data; boundary=[0-9A-Za-z'()+_\-./:=?]{1,70}$/.test(
    contentType,
  );
  if (!isUrlEncoded && !isMultipart) {
    throw new HttpError("unsupported_media_type");
  }
  if (
    input.headers.has("Content-Encoding") ||
    input.headers.has("Transfer-Encoding")
  ) {
    throw new HttpError("unsupported_media_type");
  }

  const length = declaredContentLength(input.headers);
  if (!input.hasBody || length === 0) {
    throw new HttpError("body_required");
  }
  if (length !== null && length > COMPATIBILITY_UPDATE_MAX_BODY_BYTES) {
    throw new HttpError("payload_too_large");
  }
}

function enforceNoBody(input: RouteInput): void {
  if (
    input.hasBody ||
    input.headers.has("Content-Length") ||
    input.headers.has("Content-Type") ||
    input.headers.has("Content-Encoding") ||
    input.headers.has("Transfer-Encoding")
  ) {
    throw new HttpError("unexpected_body");
  }
}

function declaredContentLength(headers: Headers): number | null {
  const raw = headers.get("Content-Length");
  if (raw === null) {
    return null;
  }
  if (!/^(0|[1-9]\d*)$/.test(raw)) {
    throw new HttpError("ambiguous_header");
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new HttpError("ambiguous_header");
  }
  return parsed;
}

function enforceNoUpgrade(headers: Headers): void {
  if (
    headers.has("Upgrade") ||
    headers.get("Connection")?.toLowerCase() === "upgrade"
  ) {
    throw new HttpError("bad_request");
  }
}

function enforceWebSocketUpgrade(headers: Headers): void {
  if (headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    throw new HttpError("upgrade_required");
  }

  const connection = headers.get("Connection");
  if (connection !== null && connection.toLowerCase() !== "upgrade") {
    throw new HttpError("upgrade_required");
  }
  const version = headers.get("Sec-WebSocket-Version");
  if (version !== null && version !== "13") {
    throw new HttpError("upgrade_required");
  }
  const key = headers.get("Sec-WebSocket-Key");
  if (key !== null && !/^[A-Za-z0-9+/]{22}==$/.test(key)) {
    throw new HttpError("upgrade_required");
  }
  if (headers.has("Sec-WebSocket-Protocol")) {
    throw new HttpError("bad_request");
  }
}

function enforceHostHeader(headers: Headers, expected: string): void {
  const host = headers.get("Host");
  if (host !== null && host.toLowerCase() !== expected) {
    throw new HttpError("misdirected_request");
  }
}

function rejectAmbiguousCriticalHeaders(headers: Headers): void {
  for (const name of CRITICAL_HEADERS) {
    const value = headers.get(name);
    if (value !== null && value.includes(",")) {
      throw new HttpError("ambiguous_header");
    }
  }
}
