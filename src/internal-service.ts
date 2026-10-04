import { isCanonicalHostname } from "./hostname";
import {
  HTTP_ERROR_CODES,
  HTTP_RATE_LIMIT_REASONS,
  HttpError,
  httpErrorResponse,
} from "./http";
import type {
  AllowedMethod,
  HttpErrorCode,
  HttpRateLimitReason,
} from "./http";
import type { RendezvousRole } from "./routes";
import { isValidPublisherSequence } from "./publisher-auth";

export const INTERNAL_SOURCE_TAG_HEADER =
  "Atrinik-Internal-Source-Tag";
export const INTERNAL_SOURCE_TAG_PREVIOUS_HEADER =
  "Atrinik-Internal-Source-Tag-Previous";
export const INTERNAL_PAIR_TAG_HEADER =
  "Atrinik-Internal-Pair-Tag";
export const INTERNAL_PAIR_TAG_PREVIOUS_HEADER =
  "Atrinik-Internal-Pair-Tag-Previous";

const INTERNAL_HEADERS = Object.freeze([
  INTERNAL_SOURCE_TAG_HEADER,
  INTERNAL_SOURCE_TAG_PREVIOUS_HEADER,
  INTERNAL_PAIR_TAG_HEADER,
  INTERNAL_PAIR_TAG_PREVIOUS_HEADER,
] as const);
const PUBLISH_FORWARD_HEADERS = Object.freeze([
  "Atrinik-Publish-Sequence",
  "Atrinik-Server-ID",
  "Content-Digest",
  "Content-Length",
  "Content-Type",
  "Host",
  "Signature",
  "Signature-Input",
] as const);
const RENDEZVOUS_FORWARD_HEADERS = Object.freeze([
  "Connection",
  "Host",
  "Sec-WebSocket-Key",
  "Sec-WebSocket-Protocol",
  "Sec-WebSocket-Version",
  "Upgrade",
] as const);
const MAXIMUM_DYNAMIC_RESPONSE_BYTES = 2_048;
const MAXIMUM_DYNAMIC_SERVICE_MILLISECONDS = 15_000;
const HTTP_ERROR_CODE_SET = new Set<string>(HTTP_ERROR_CODES);
const HTTP_RATE_LIMIT_REASON_SET = new Set<string>(HTTP_RATE_LIMIT_REASONS);
const FIXED_RENDEZVOUS_ERRORS = Object.freeze([
  {
    body: "Invalid server ID\n",
    headers: {},
    status: 400,
  },
  {
    body: "Invalid WebSocket subprotocol\n",
    headers: {},
    status: 400,
  },
  {
    body: "Invalid rendezvous token\n",
    headers: { "WWW-Authenticate": "Bearer" },
    status: 401,
  },
  {
    body: "Server is offline\n",
    headers: {},
    status: 404,
  },
  {
    body: "WebSocket upgrade required\n",
    headers: { Upgrade: "websocket" },
    status: 426,
  },
  {
    body: "Protected rendezvous authorization is unavailable\n",
    headers: { "Retry-After": "300" },
    status: 503,
  },
  {
    body: "Rendezvous server unavailable\n",
    headers: { "Retry-After": "5" },
    status: 503,
  },
  {
    body: "Rendezvous room is full\n",
    headers: { "Retry-After": "15" },
    status: 503,
  },
  {
    body: "Rendezvous room unavailable\n",
    headers: { "Retry-After": "60" },
    status: 503,
  },
] as const);

/**
 * Build the publisher service-binding request from a fixed header allowlist.
 * Request-source and browser state cannot cross into the storage-owning Worker.
 */
export function publisherServiceRequest(request: Request): Request {
  assertNoInternalServiceHeaders(request.headers);
  return copyRequest(request, PUBLISH_FORWARD_HEADERS);
}

/**
 * Validate the publisher edge envelope and remove the exact chunked transport
 * marker Workerd adds when a Service Binding carries a streaming body.
 */
export function consumePublisherCoordinatorRequest(request: Request): Request {
  validatePublisherCoordinatorRequest(request);
  const headers = new Headers(request.headers);
  headers.delete("Transfer-Encoding");
  return new Request(request.url, {
    method: request.method,
    headers,
    redirect: "manual",
    signal: request.signal,
    ...(request.body === null ? {} : { body: request.body }),
  });
}

/** Validate the fixed Service Binding envelope without consuming its body. */
export function validatePublisherCoordinatorRequest(request: Request): void {
  assertExactHeaderNames(request.headers, [
    ...PUBLISH_FORWARD_HEADERS,
    "Transfer-Encoding",
  ]);
  const transferEncoding = request.headers.get("Transfer-Encoding");
  if (transferEncoding !== null && transferEncoding !== "chunked") {
    throw new HttpError("bad_request");
  }
}

/** Build a rendezvous envelope containing only transport/authentication headers. */
export function rendezvousServiceRequest(request: Request, role: RendezvousRole): Request {
  assertNoInternalServiceHeaders(request.headers);
  if (role === "client" && request.headers.has("Authorization")) throw new HttpError("bad_request");
  return copyRequest(request, role === "server"
    ? [...RENDEZVOUS_FORWARD_HEADERS, "Authorization"] : RENDEZVOUS_FORWARD_HEADERS);
}

/** Reject all requester metadata, including retired source/pair alias envelopes. */
export function consumeRendezvousCoordinatorRequest(request: Request, role: RendezvousRole): Request {
  assertExactHeaderNames(request.headers, role === "server"
    ? [...RENDEZVOUS_FORWARD_HEADERS, "Authorization"] : RENDEZVOUS_FORWARD_HEADERS);
  return new Request(request.url, {method: request.method, headers: request.headers, redirect: "manual"});
}


/** Validate and reconstruct one bounded, canonical publisher response. */
export async function validatePublisherServiceResponse(
  response: Response,
): Promise<Response> {
  if (
    response.status === 101 ||
    response.webSocket !== null ||
    (response.status !== 200 && response.status < 400) ||
    (response.status >= 300 && response.status <= 399) ||
    response.headers.has("Location")
  ) {
    return rejectUnsafeDynamicResponse(response);
  }

  let body: string;
  try {
    body = await readBoundedResponseBody(response);
  } catch {
    return rejectUnsafeDynamicResponse(response);
  }
  if (response.status === 200) {
    const parsed = parseJsonRecord(body);
    const token = parsed?.rendezvousToken;
    const canonical = typeof token === "string" && /^[0-9a-f]{64}$/.test(token)
      ? JSON.stringify({ status: "ok", rendezvousToken: token })
      : null;
    const headers = jsonResponseHeaders();
    if (
      canonical === null ||
      body !== canonical ||
      !serviceResponseHeadersEqual(response.headers, headers, body)
    ) {
      return rejectUnsafeDynamicResponse(response);
    }
    return new Response(canonical, { status: 200, headers });
  }

  if (response.status === 409) {
    const parsed = parseJsonRecord(body);
    const error = isRecord(parsed?.error) ? parsed.error : null;
    const minimum = error?.minimumNextSequence;
    const canonical = error?.code === "publish_replay" &&
        typeof minimum === "string" &&
        isValidPublisherSequence(minimum)
      ? JSON.stringify({
        error: { code: "publish_replay", minimumNextSequence: minimum },
      })
      : error?.code === "publish_sequence_exhausted" &&
          Object.keys(error).length === 1
      ? JSON.stringify({ error: { code: "publish_sequence_exhausted" } })
      : null;
    const headers = jsonResponseHeaders();
    if (
      canonical !== null &&
      body === canonical &&
      serviceResponseHeadersEqual(response.headers, headers, body)
    ) {
      return new Response(canonical, { status: 409, headers });
    }
  }

  if (response.status === 410) {
    const canonical = JSON.stringify({ error: { code: "profile_retired" } });
    const headers = jsonResponseHeaders();
    if (
      body === canonical &&
      serviceResponseHeadersEqual(response.headers, headers, body)
    ) {
      return new Response(canonical, { status: 410, headers });
    }
  }

  const error = await canonicalHttpErrorResponse(response, body);
  if (error !== null) {
    return error;
  }
  return rejectUnsafeDynamicResponse(response);
}

/** Validate a complete exact WebSocket or bounded fixed error envelope. */
export async function validateRendezvousServiceResponse(
  response: Response,
  requestedSubprotocol: string | null,
): Promise<Response> {
  if (response.status === 101) {
    const headers = new Headers({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    if (requestedSubprotocol !== null) {
      headers.set("Sec-WebSocket-Protocol", requestedSubprotocol);
    }
    if (
      response.webSocket === null ||
      response.body !== null ||
      !serviceResponseHeadersEqual(response.headers, headers, null)
    ) {
      return rejectUnsafeDynamicResponse(response);
    }
    return new Response(null, {
      status: 101,
      headers,
      webSocket: response.webSocket,
    });
  }

  if (
    response.webSocket !== null ||
    response.status < 400 ||
    response.status >= 600 ||
    (response.status >= 300 && response.status <= 399) ||
    response.headers.has("Location")
  ) {
    return rejectUnsafeDynamicResponse(response);
  }
  let body: string;
  try {
    body = await readBoundedResponseBody(response);
  } catch {
    return rejectUnsafeDynamicResponse(response);
  }

  if (response.headers.get("Content-Type") === "application/json; charset=utf-8") {
    const error = await canonicalHttpErrorResponse(response, body);
    if (error !== null) {
      return error;
    }
  }

  for (const fixed of FIXED_RENDEZVOUS_ERRORS) {
    if (fixed.status !== response.status || fixed.body !== body) {
      continue;
    }
    const headers = new Headers({
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      ...fixed.headers,
    });
    if (serviceResponseHeadersEqual(response.headers, headers, body)) {
      return new Response(body, { status: response.status, headers });
    }
  }
  return rejectUnsafeDynamicResponse(response);
}

async function readBoundedResponseBody(response: Response, maximumBytes = MAXIMUM_DYNAMIC_RESPONSE_BYTES): Promise<string> {
  if (response.body === null) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error("Dynamic response exceeded its time ceiling")),
      MAXIMUM_DYNAMIC_SERVICE_MILLISECONDS,
    );
  });
  try {
    for (;;) {
      const result = await Promise.race([reader.read(), deadline]);
      if (result.done) {
        break;
      }
      total += result.value.byteLength;
      if (total > maximumBytes) {
        cancelReader(reader);
        throw new Error("Dynamic response exceeded its byte ceiling");
      }
      chunks.push(result.value);
    }
  } catch (error) {
    cancelReader(reader);
    throw error;
  } finally {
    if (timeout !== null) {
      clearTimeout(timeout);
    }
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: false,
  }).decode(bytes);
}

async function rejectUnsafeDynamicResponse(response: Response): Promise<never> {
  try {
    response.webSocket?.close(1011, "Invalid upstream response");
  } catch {
    // The public side is still replaced with one fixed error response.
  }
  try {
    const cancellation = response.body?.cancel();
    void cancellation?.catch(() => undefined);
  } catch {
    // A consumed or locked body cannot be reused and remains undisclosed.
  }
  throw new Error("Dynamic service returned an unsafe response");
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void reader.cancel().catch(() => undefined);
  } catch {
    // Cancellation is best-effort; the public failure is already bounded.
  }
}

function parseJsonRecord(body: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonResponseHeaders(): Headers {
  return new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "application/json",
    "X-Content-Type-Options": "nosniff",
  });
}

function headersEqual(actual: Headers, expected: Headers): boolean {
  const actualEntries = [...actual.entries()];
  const expectedEntries = [...expected.entries()];
  if (actualEntries.length !== expectedEntries.length) {
    return false;
  }
  return expectedEntries.every(
    ([name, value]) => actual.get(name) === value,
  );
}

/**
 * Cloudflare's production Service Binding transport may attach its healthy
 * status marker, and Workerd may compute a fixed body's length. Accept only
 * those exact values; every other header remains subject to the allowlist.
 */
function serviceResponseHeadersEqual(
  actual: Headers,
  expected: Headers,
  body: string | null,
): boolean {
  const actualCopy = new Headers(actual);
  const expectedCopy = new Headers(expected);

  const workerStatus = actualCopy.get("CF-Worker-Status");
  if (workerStatus !== null && workerStatus !== "ok") {
    return false;
  }
  actualCopy.delete("CF-Worker-Status");
  if (expectedCopy.has("CF-Worker-Status")) {
    return false;
  }

  if (body !== null) {
    const length = String(new TextEncoder().encode(body).byteLength);
    for (const headers of [actualCopy, expectedCopy]) {
      const contentLength = headers.get("Content-Length");
      if (contentLength !== null && contentLength !== length) {
        return false;
      }
      headers.delete("Content-Length");
    }
  }
  return headersEqual(actualCopy, expectedCopy);
}

function isAllowedMethod(value: string): value is AllowedMethod {
  return value === "GET" || value === "HEAD" || value === "POST";
}

async function canonicalHttpErrorResponse(
  response: Response,
  body: string,
): Promise<Response | null> {
  const parsed = parseJsonRecord(body);
  const error = isRecord(parsed?.error) ? parsed.error : null;
  const code = error?.code;
  if (typeof code !== "string" || !HTTP_ERROR_CODE_SET.has(code)) {
    return null;
  }
  if (error === null) {
    return null;
  }
  const reason = error.reason;
  const retry = error.retry_after_seconds;
  const allow = response.headers.get("Allow")?.split(", ") ?? [];
  const canonical = httpErrorResponse(new HttpError(code as HttpErrorCode, {
    allow: allow.filter(isAllowedMethod),
    rateLimitReason: typeof reason === "string" &&
        HTTP_RATE_LIMIT_REASON_SET.has(reason)
      ? reason as HttpRateLimitReason
      : undefined,
    retryAfterSeconds: typeof retry === "number" && Number.isSafeInteger(retry)
      ? retry
      : undefined,
  }));
  if (
    canonical.status !== response.status ||
    !serviceResponseHeadersEqual(response.headers, canonical.headers, body)
  ) {
    return null;
  }
  const canonicalText = await canonical.text();
  return body === canonicalText
    ? new Response(canonicalText, {
      status: response.status,
      headers: canonical.headers,
    })
    : null;
}

export function assertNoInternalServiceHeaders(headers: Headers): void {
  if (INTERNAL_HEADERS.some((name) => headers.has(name))) {
    throw new HttpError("bad_request");
  }
}

function assertExactHeaderNames(
  headers: Headers,
  allowedNames: readonly string[],
): void {
  const allowed = new Set(allowedNames.map((name) => name.toLowerCase()));
  for (const [name] of headers) {
    if (!allowed.has(name.toLowerCase())) {
      throw new HttpError("bad_request");
    }
  }
}

function copyRequest(
  request: Request,
  allowlist: readonly string[],
  additions?: Headers,
): Request {
  const headers = new Headers();
  for (const name of allowlist) {
    const value = request.headers.get(name);
    if (value !== null) {
      headers.set(name, value);
    }
  }
  additions?.forEach((value, name) => headers.set(name, value));
  return new Request(request.url, {
    method: request.method,
    headers,
    redirect: "manual",
    signal: AbortSignal.any([
      request.signal,
      AbortSignal.timeout(MAXIMUM_DYNAMIC_SERVICE_MILLISECONDS),
    ]),
    ...(request.body === null ? {} : { body: request.body }),
  });
}

export function accessResolveServiceRequest(request: Request): Request {
  assertNoInternalServiceHeaders(request.headers);
  return copyRequest(request, ["Content-Type", "Content-Length", "Host"]);
}
export function consumeAccessResolveCoordinatorRequest(request: Request): Request {
  assertExactHeaderNames(request.headers, ["Content-Type", "Content-Length", "Host", "Transfer-Encoding"]);
  const encoding = request.headers.get("Transfer-Encoding");
  if (encoding !== null && encoding !== "chunked") throw new HttpError("bad_request");
  const headers = new Headers(request.headers);
  headers.delete("Transfer-Encoding");
  return new Request(request.url, { method: request.method, headers, redirect: "manual", body: request.body });
}

/** Closed, size-bounded capability responses; never forwards arbitrary headers. */
export async function validateAccessServiceResponse(
  response: Response, kind: "routes" | "resolve",
): Promise<Response> {
  if (response.status === 101 || response.webSocket !== null || response.status < 200 ||
      (response.status >= 300 && response.status < 400) || response.headers.has("Location")) {
    return rejectUnsafeDynamicResponse(response);
  }
  let body: string;
  try { body = await readBoundedResponseBody(response, kind === "resolve" ? 8192 : 1024); }
  catch { return rejectUnsafeDynamicResponse(response); }
  const headers = jsonResponseHeaders();
  if (response.status === 404 && body === '{"error":{"code":"access_unavailable"}}' &&
      serviceResponseHeadersEqual(response.headers, headers, body)) {
    return new Response(body, { status: 404, headers });
  }
  if (response.status !== 200) {
    const error = await canonicalHttpErrorResponse(response, body);
    return error ?? rejectUnsafeDynamicResponse(response);
  }
  const value = parseJsonRecord(body);
  let canonical: string | null = null;
  const hash = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
  const id = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
  const decimal = (value: unknown): value is string => typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value);
  if (value !== null && kind === "routes" && value.schema === "atrinik-access-route-result-v1" &&
      id(value.requestId) && ["reserved","active","revoked","conflict","expired","not_found","unavailable"].includes(value.outcome as string) &&
      (value.reservationId === null || id(value.reservationId)) &&
      (value.reservationExpiresAt === null || (decimal(value.reservationExpiresAt) && BigInt(value.reservationExpiresAt)<=253402300799n)) && decimal(value.tokenRevision) && BigInt(value.tokenRevision) <= 18446744073709551615n) {
    canonical = JSON.stringify({ schema: value.schema, requestId: value.requestId, outcome: value.outcome,
      reservationId: value.reservationId, reservationExpiresAt: value.reservationExpiresAt, tokenRevision: value.tokenRevision });
  }
  if (value !== null && kind === "resolve" && value.schema === "atrinik-access-resolved-v1" &&
      (value.profile === "classic" || value.profile === "game") && hash(value.serverId) &&
      typeof value.certificate === "string" && value.certificate.length > 0 && value.certificate.length <= 2732 &&
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.certificate) &&
      typeof value.name === "string" && new TextEncoder().encode(value.name).byteLength <= 80 &&
      value.name.length > 0 && !/[\x00-\x1f\x7f]/.test(value.name) &&
      value.accessRequired === true && hash(value.generation) && hash(value.clientNonce) &&
      hash(value.grant) && decimal(value.expiresAt) && BigInt(value.expiresAt)<=253402300799n) {
    let endpoint: { hostname: string; port: number } | undefined;
    if (value.endpoint !== undefined) {
      const candidate = value.endpoint;
      if (!isRecord(candidate) || typeof candidate.hostname !== "string" ||
          !isCanonicalHostname(candidate.hostname) ||
          typeof candidate.port !== "number" || !Number.isInteger(candidate.port) || candidate.port < 1 || candidate.port > 65535 ||
          Object.keys(candidate).join(",") !== "hostname,port") return rejectUnsafeDynamicResponse(response);
      endpoint = { hostname: candidate.hostname, port: candidate.port };
    }
    canonical = JSON.stringify({ schema: value.schema, profile: value.profile, serverId: value.serverId,
      certificate: value.certificate, name: value.name, accessRequired: true, generation: value.generation,
      clientNonce: value.clientNonce, grant: value.grant, expiresAt: value.expiresAt,
      ...(endpoint === undefined ? {} : { endpoint }), });
  }
  if (canonical === null || canonical !== body || !serviceResponseHeadersEqual(response.headers, headers, body)) {
    return rejectUnsafeDynamicResponse(response);
  }
  return new Response(body, { headers });
}
