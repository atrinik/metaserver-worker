import { RequestControlConfigurationError } from "./config";
import {
  logRequestRejected,
  logUnexpectedError,
} from "./diagnostics";
import type { DiagnosticHandler, DiagnosticRoute } from "./diagnostics";
import {
  HttpError,
  httpErrorResponse,
} from "./http";
import type { HttpRateLimitReason } from "./http";
import { SourceTagConfigurationError } from "./privacy";
import { RequestError } from "./protocol";
import {
  RequestBudgetExceeded,
  RequestControlUnavailable,
} from "./rate-limit";

/**
 * Convert every public request failure to a fixed, redacted response. The
 * handler and route values are closed diagnostic dimensions; callers must not
 * pass request data, actor tags, credentials, or exception text.
 */
export function handleRequestError(
  error: unknown,
  route: DiagnosticRoute,
  handler: DiagnosticHandler = "fetch",
): Response {
  if (error instanceof RequestBudgetExceeded) {
    return httpErrorResponse(new HttpError("rate_limited", {
      rateLimitReason: rateLimitReason(error),
      retryAfterSeconds: error.retryAfterSeconds,
    }));
  }

  if (error instanceof HttpError) {
    if (
      error.code !== "not_found" &&
      error.code !== "rate_limited" &&
      error.code !== "service_disabled"
    ) {
      logRequestRejected(route, error.code, error.status);
    }
    return httpErrorResponse(error);
  }

  if (error instanceof RequestControlUnavailable) {
    logUnexpectedError(
      handler,
      "request_control_dependency",
      error.dependency,
    );
    return httpErrorResponse(new HttpError("request_control_unavailable", {
      retryAfterSeconds: 60,
    }));
  }

  if (error instanceof RequestControlConfigurationError) {
    logUnexpectedError(handler, "request_control_configuration");
    return httpErrorResponse(new HttpError("request_control_unavailable", {
      retryAfterSeconds: 60,
    }));
  }

  if (error instanceof SourceTagConfigurationError) {
    logUnexpectedError(handler, "source_tag_configuration");
    return httpErrorResponse(new HttpError("request_control_unavailable", {
      retryAfterSeconds: 60,
    }));
  }

  if (error instanceof RequestError) {
    const httpError = requestErrorToHttpError(error);
    logRequestRejected(route, httpError.code, httpError.status);
    return httpErrorResponse(httpError);
  }

  logUnexpectedError(handler, "unhandled_exception");
  return httpErrorResponse(new HttpError("internal_error"));
}

function requestErrorToHttpError(error: RequestError): HttpError {
  switch (error.status) {
    case 400:
      return new HttpError("bad_request");
    case 401:
      return new HttpError("unauthorized");
    case 403:
      return new HttpError("forbidden");
    case 404:
      return new HttpError("not_found");
    case 409:
      return new HttpError("conflict");
    case 413:
      return new HttpError("payload_too_large");
    default:
      return new HttpError("internal_error");
  }
}

function rateLimitReason(error: RequestBudgetExceeded): HttpRateLimitReason {
  const burst = error.reason === "burst_limit_exceeded";
  switch (error.scope) {
    case "global":
      return "global_burst";
    case "compat-status":
      return "compat_status_daily";
    case "compat-directory":
      return burst ? "compat_directory_burst" : "compat_directory_daily";
    case "compat-otp":
      return burst ? "compat_otp_burst" : "compat_otp_daily";
    case "compat-update-source":
      return burst
        ? "compat_update_source_burst"
        : "compat_update_source_daily";
    case "compat-update-server":
      return burst
        ? "compat_update_server_burst"
        : "compat_update_server_daily";
    case "publish-server":
    case "publish-game-server":
      return burst ? "publish_burst" : "publish_daily";
    case "rendezvous-client-source":
      return burst
        ? "rendezvous_client_burst"
        : "rendezvous_client_source_daily";
    case "rendezvous-client-source-server":
      return "rendezvous_client_pair_daily";
    case "rendezvous-client-pair-cooldown":
      return "rendezvous_client_pair_cooldown";
    case "rendezvous-server-source":
      return "rendezvous_server_source_daily";
    case "rendezvous-server":
      return burst
        ? "rendezvous_server_burst"
        : "rendezvous_server_daily";
  }
}
