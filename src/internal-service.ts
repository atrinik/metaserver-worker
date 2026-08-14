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

const SOURCE_TAG = /^v1\.[A-Za-z0-9_-]{1,32}\.[A-Za-z0-9_-]{43}$/;
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

export type ActorAliases = readonly [current: string, previous: string];

export type RendezvousAdmissionAliases =
  | { readonly source: null; readonly pair: ActorAliases }
  | { readonly source: null; readonly pair: null };

/** Convert the required two-key source-tag result into a strict RPC tuple. */
export function actorAliases(values: readonly string[]): ActorAliases {
  const [current, previous, unexpected] = values;
  if (
    current === undefined ||
    previous === undefined ||
    unexpected !== undefined ||
    current === previous ||
    !SOURCE_TAG.test(current) ||
    !SOURCE_TAG.test(previous)
  ) {
    throw new Error("Source-tag key ring produced an invalid alias set");
  }
  return Object.freeze([current, previous]);
}

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

/** Build a source-scrubbed rendezvous request with fixed internal aliases. */
export function rendezvousServiceRequest(
  request: Request,
  role: RendezvousRole,
  aliases: RendezvousAdmissionAliases,
): Request {
  assertNoInternalServiceHeaders(request.headers);
  if (role === "client" && request.headers.has("Authorization")) {
    throw new HttpError("bad_request");
  }
  const additions = new Headers();
  if (role === "client") {
    if (aliases.source !== null || aliases.pair === null) {
      throw new HttpError("bad_request");
    }
    additions.set(INTERNAL_PAIR_TAG_HEADER, aliases.pair[0]);
    additions.set(INTERNAL_PAIR_TAG_PREVIOUS_HEADER, aliases.pair[1]);
  } else {
    if (aliases.source !== null || aliases.pair !== null) {
      throw new HttpError("bad_request");
    }
  }
  const allowlist = role === "server"
    ? [...RENDEZVOUS_FORWARD_HEADERS, "Authorization"]
    : RENDEZVOUS_FORWARD_HEADERS;
  return copyRequest(request, allowlist, additions);
}

/**
 * Read and remove the internal alias envelope before the request reaches D1 or
 * a RendezvousRoom. Only the named rendezvous coordinator may call this.
 */
export function consumeRendezvousAdmissionAliases(
  request: Request,
  role: RendezvousRole,
): { readonly request: Request; readonly aliases: RendezvousAdmissionAliases } {
  const allowedHeaders = role === "server"
    ? [
      ...RENDEZVOUS_FORWARD_HEADERS,
      "Authorization",
      INTERNAL_SOURCE_TAG_HEADER,
      INTERNAL_SOURCE_TAG_PREVIOUS_HEADER,
    ]
    : [
      ...RENDEZVOUS_FORWARD_HEADERS,
      INTERNAL_PAIR_TAG_HEADER,
      INTERNAL_PAIR_TAG_PREVIOUS_HEADER,
    ];
  assertExactHeaderNames(request.headers, allowedHeaders);
  // A v1.11.2 caller still supplies the compatibility-era source aliases.
  // Validate and scrub that bridge envelope, but never return or persist it.
  // The provider-first v1.12 caller omits both headers.
  if (
    role === "server" &&
    (request.headers.has(INTERNAL_SOURCE_TAG_HEADER) ||
      request.headers.has(INTERNAL_SOURCE_TAG_PREVIOUS_HEADER))
  ) {
    readAliasPair(
      request.headers,
      INTERNAL_SOURCE_TAG_HEADER,
      INTERNAL_SOURCE_TAG_PREVIOUS_HEADER,
    );
  }
  const pair = role === "client"
    ? readAliasPair(
      request.headers,
      INTERNAL_PAIR_TAG_HEADER,
      INTERNAL_PAIR_TAG_PREVIOUS_HEADER,
    )
    : null;
  if (
    role === "server" &&
    (request.headers.has(INTERNAL_PAIR_TAG_HEADER) ||
      request.headers.has(INTERNAL_PAIR_TAG_PREVIOUS_HEADER))
  ) {
    throw new HttpError("bad_request");
  }

  const headers = new Headers(request.headers);
  for (const name of INTERNAL_HEADERS) {
    headers.delete(name);
  }
  return Object.freeze({
    request: new Request(request.url, {
      method: request.method,
      headers,
      redirect: "manual",
    }),
    aliases: role === "client"
      ? Object.freeze({ source: null, pair: requireAliases(pair) })
      : Object.freeze({ source: null, pair: null }),
  });
}

function requireAliases(value: ActorAliases | null): ActorAliases {
  if (value === null) {
    throw new HttpError("bad_request");
  }
  return value;
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

async function readBoundedResponseBody(response: Response): Promise<string> {
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
      if (total > MAXIMUM_DYNAMIC_RESPONSE_BYTES) {
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

function readAliasPair(
  headers: Headers,
  currentName: string,
  previousName: string,
): ActorAliases {
  const current = headers.get(currentName);
  const previous = headers.get(previousName);
  if (
    current === null ||
    previous === null ||
    current === previous ||
    !SOURCE_TAG.test(current) ||
    !SOURCE_TAG.test(previous)
  ) {
    throw new HttpError("bad_request");
  }
  return Object.freeze([current, previous]);
}
