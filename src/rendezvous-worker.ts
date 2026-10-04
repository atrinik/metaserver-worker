import { classifyAccessRoute, ACCESS_RENDEZVOUS_SUBPROTOCOL } from "./routes";
import { accessResolveServiceRequest, validateAccessServiceResponse } from "./internal-service";
import { rendezvousEdgeConfiguration } from "./config";
import type { DiagnosticRoute } from "./diagnostics";
import { enforceCircuitBreaker, HttpError } from "./http";
import {
  assertNoInternalServiceHeaders,
  rendezvousServiceRequest,
  validateRendezvousServiceResponse,
} from "./internal-service";
import { enforceSharedIngress } from "./rate-limit";
import { handleRequestError } from "./request-errors";
import {
  classifyCanonicalRendezvousRoute,
  routeInputFromRequest,
} from "./routes";

export default {
  async fetch(request: Request, env: RendezvousEnv): Promise<Response> {
    let diagnosticRoute: DiagnosticRoute = "unclassified";
    try {
      const control = rendezvousEdgeConfiguration(env);
      const access = classifyAccessRoute(routeInputFromRequest(request), control.authority, "rendezvous");
      if (access !== null) {
        diagnosticRoute = "rendezvous-client";
        assertNoInternalServiceHeaders(request.headers);
        enforceCircuitBreaker(env.RENDEZVOUS_ENABLED, control.routeDisabledRetrySeconds);
        if (access.kind === "access-resolve") {
          await enforceSharedIngress(env.GLOBAL_RATE_LIMITER, "resolve");
          return await validateAccessServiceResponse(await env.COORDINATOR.fetch(accessResolveServiceRequest(request)), "resolve");
        }
        if (access.kind !== "access-rendezvous" || access.profile !== "classic") throw new HttpError("service_disabled");
        await enforceSharedIngress(env.RENDEZVOUS_CLIENT_RATE_LIMITER, "rendezvous-client");
        return await validateRendezvousServiceResponse(await env.COORDINATOR.fetch(
          rendezvousServiceRequest(request, "client")), ACCESS_RENDEZVOUS_SUBPROTOCOL);
      }
      const route = classifyCanonicalRendezvousRoute(
        routeInputFromRequest(request),
        control.authority,
      );
      diagnosticRoute = route.role === "client"
        ? "rendezvous-client"
        : "rendezvous-server";
      if (route.generation !== "classic") {
        throw new HttpError("service_disabled", { retryAfterSeconds: 300 });
      }
      assertNoInternalServiceHeaders(request.headers);

      enforceCircuitBreaker(
        env.RENDEZVOUS_ENABLED,
        control.routeDisabledRetrySeconds,
      );
      await enforceSharedIngress(route.role === "client"
        ? env.RENDEZVOUS_CLIENT_RATE_LIMITER : env.GLOBAL_RATE_LIMITER,
        route.role === "client" ? "rendezvous-client" : "rendezvous-server");

      return await validateRendezvousServiceResponse(
        await env.COORDINATOR.fetch(rendezvousServiceRequest(
          request,
          route.role,
        )),
        route.subprotocol,
      );
    } catch (error) {
      return handleRequestError(error, diagnosticRoute, "rendezvous-edge");
    }
  },
} satisfies ExportedHandler<RendezvousEnv>;
