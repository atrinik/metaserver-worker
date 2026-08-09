import type { HttpErrorCode } from "./http";
import type { RequestControlDependency } from "./rate-limit";

export type DiagnosticRoute =
  | "unclassified"
  | "compat-status"
  | "compat-directory"
  | "compat-otp"
  | "compat-update"
  | "publish-classic"
  | "publish-game"
  | "rendezvous-client"
  | "rendezvous-server"
  | "compat-rendezvous-client"
  | "compat-rendezvous-server";

export type BlacklistDimension = "server_identity" | "request_source";
export type BlacklistRoute = "compat-update" | "publish-classic";
export type DiagnosticHandler =
  | "fetch"
  | "publisher"
  | "rendezvous-edge"
  | "coordinator"
  | "scheduled"
  | "rendezvous";
export type UnexpectedErrorCode =
  | "request_control_dependency"
  | "request_control_configuration"
  | "source_tag_configuration"
  | "maintenance_failure"
  | "unhandled_exception";

/**
 * Emit only closed, low-cardinality fields. Callers must never add request
 * values, actor tags, authentication material, exception text, or candidates.
 */
export function logRequestRejected(
  route: DiagnosticRoute,
  code: HttpErrorCode,
  status: number,
): void {
  console.warn({ event: "request_rejected", route, code, status });
}

export function logBlacklistMatch(
  route: BlacklistRoute,
  dimension: BlacklistDimension,
): void {
  console.warn({
    event: "blacklist_match",
    route,
    dimension,
  });
}

export function logUnexpectedError(
  handler: DiagnosticHandler,
  code: UnexpectedErrorCode,
  dependency?: RequestControlDependency,
): void {
  const event: {
    event: "unexpected_error";
    handler: DiagnosticHandler;
    code: UnexpectedErrorCode;
    dependency?: RequestControlDependency;
  } = { event: "unexpected_error", handler, code };
  if (dependency !== undefined) {
    event.dependency = dependency;
  }
  console.error(event);
}
