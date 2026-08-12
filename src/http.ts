const MAX_RETRY_AFTER_SECONDS = 86_400;
const DEFAULT_RETRY_AFTER_SECONDS = 60;

const HTTP_ERROR_DEFINITIONS = {
  ambiguous_header: {
    status: 400,
    message: "A security-critical request header is ambiguous.",
  },
  bad_request: {
    status: 400,
    message: "The request is invalid.",
  },
  body_required: {
    status: 400,
    message: "A request body is required.",
  },
  invalid_server_id: {
    status: 400,
    message: "The server ID is invalid.",
  },
  invalid_target: {
    status: 400,
    message: "The request target is invalid.",
  },
  unexpected_body: {
    status: 400,
    message: "A request body is not allowed.",
  },
  unexpected_query: {
    status: 400,
    message: "The request query is invalid.",
  },
  unauthorized: {
    status: 401,
    message: "Authentication failed.",
  },
  forbidden: {
    status: 403,
    message: "The request is forbidden.",
  },
  not_found: {
    status: 404,
    message: "The requested resource does not exist.",
  },
  method_not_allowed: {
    status: 405,
    message: "The request method is not allowed.",
  },
  conflict: {
    status: 409,
    message: "The request conflicts with existing state.",
  },
  payload_too_large: {
    status: 413,
    message: "The request body is too large.",
  },
  unsupported_media_type: {
    status: 415,
    message: "The request content type is not supported.",
  },
  misdirected_request: {
    status: 421,
    message: "The request authority is not served here.",
  },
  rate_limited: {
    status: 429,
    message: "The request budget has been exhausted.",
  },
  upgrade_required: {
    status: 426,
    message: "A WebSocket upgrade is required.",
  },
  service_disabled: {
    status: 503,
    message: "This service is temporarily unavailable.",
  },
  request_control_unavailable: {
    status: 503,
    message: "Request admission is temporarily unavailable.",
  },
  internal_error: {
    status: 500,
    message: "An internal error occurred.",
  },
} as const;

export type HttpErrorCode = keyof typeof HTTP_ERROR_DEFINITIONS;
export const HTTP_ERROR_CODES = Object.freeze(
  Object.keys(HTTP_ERROR_DEFINITIONS) as HttpErrorCode[],
);
export type AllowedMethod = "GET" | "HEAD" | "POST";
export const HTTP_RATE_LIMIT_REASONS = [
  "global_burst",
  "compat_status_daily",
  "compat_directory_burst",
  "compat_directory_daily",
  "compat_otp_burst",
  "compat_otp_daily",
  "compat_update_source_burst",
  "compat_update_source_daily",
  "compat_update_server_burst",
  "compat_update_server_daily",
  "rendezvous_client_burst",
  "rendezvous_client_pair_cooldown",
  "rendezvous_client_source_daily",
  "rendezvous_client_pair_daily",
  "rendezvous_server_source_daily",
  "rendezvous_server_burst",
  "rendezvous_server_daily",
  "publish_burst",
  "publish_daily",
  "request_budget_exceeded",
] as const;
export type HttpRateLimitReason = typeof HTTP_RATE_LIMIT_REASONS[number];

export interface HttpErrorOptions {
  readonly allow?: readonly AllowedMethod[];
  readonly rateLimitReason?: HttpRateLimitReason;
  readonly retryAfterSeconds?: number;
}

/**
 * A bounded public error. Messages and status codes come from the fixed table;
 * callers cannot accidentally echo request data, credentials, or internal
 * exception text into a response.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly allow: readonly AllowedMethod[];
  readonly rateLimitReason: HttpRateLimitReason | null;
  readonly retryAfterSeconds: number | null;

  constructor(
    readonly code: HttpErrorCode,
    options: HttpErrorOptions = {},
  ) {
    const definition = HTTP_ERROR_DEFINITIONS[code];
    super(definition.message);
    this.name = "HttpError";
    this.status = definition.status;
    this.allow = code === "method_not_allowed"
      ? normalizeAllowedMethods(options.allow ?? [])
      : [];
    this.rateLimitReason = code === "rate_limited"
      ? options.rateLimitReason ?? "request_budget_exceeded"
      : null;
    this.retryAfterSeconds = shouldIncludeRetryAfter(code)
      ? boundedRetryAfter(options.retryAfterSeconds)
      : null;
  }
}

export interface HttpErrorBody {
  readonly error: {
    readonly code: HttpErrorCode;
    readonly message: string;
    readonly reason?: HttpRateLimitReason;
    readonly retry_after_seconds?: number;
  };
}

export function httpErrorResponse(error: HttpError): Response {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });

  if (error.allow.length > 0) {
    headers.set("Allow", error.allow.join(", "));
  }
  if (error.retryAfterSeconds !== null) {
    headers.set("Retry-After", String(error.retryAfterSeconds));
  }
  if (error.code === "upgrade_required") {
    headers.set("Upgrade", "websocket");
  }

  const errorBody: {
    code: HttpErrorCode;
    message: string;
    reason?: HttpRateLimitReason;
    retry_after_seconds?: number;
  } = {
    code: error.code,
    message: error.message,
  };
  if (
    error.rateLimitReason !== null &&
    error.retryAfterSeconds !== null
  ) {
    errorBody.reason = error.rateLimitReason;
    errorBody.retry_after_seconds = error.retryAfterSeconds;
  }
  const body: HttpErrorBody = {
    error: {
      ...errorBody,
    },
  };
  return Response.json(body, { status: error.status, headers });
}

/**
 * Route switches are deliberately strict: only the exact value "enabled"
 * opens a route. Missing, misspelled, padded, or differently-cased values all
 * fail closed.
 */
export function circuitBreakerEnabled(value: string | undefined): boolean {
  return value === "enabled";
}

export function enforceCircuitBreaker(
  value: string | undefined,
  retryAfterSeconds = DEFAULT_RETRY_AFTER_SECONDS,
): void {
  if (!circuitBreakerEnabled(value)) {
    throw new HttpError("service_disabled", { retryAfterSeconds });
  }
}

export function boundedRetryAfter(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_RETRY_AFTER_SECONDS;
  }

  return Math.min(
    MAX_RETRY_AFTER_SECONDS,
    Math.max(1, Math.ceil(value)),
  );
}

function shouldIncludeRetryAfter(code: HttpErrorCode): boolean {
  return code === "rate_limited" ||
    code === "service_disabled" ||
    code === "request_control_unavailable";
}

function normalizeAllowedMethods(
  methods: readonly AllowedMethod[],
): readonly AllowedMethod[] {
  const order: readonly AllowedMethod[] = ["GET", "HEAD", "POST"];
  return order.filter((method) => methods.includes(method));
}
