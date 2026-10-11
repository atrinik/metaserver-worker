import { classifyAccessRoute } from "./routes";
import { validateAccessServiceResponse } from "./internal-service";
import { publisherEdgeConfiguration } from "./config";
import type { DiagnosticRoute } from "./diagnostics";
import { enforceCircuitBreaker } from "./http";
import {
  assertNoInternalServiceHeaders,
  publisherServiceRequest,
  validatePublisherServiceResponse,
} from "./internal-service";
import { enforceSharedIngress } from "./rate-limit";
import { handleRequestError } from "./request-errors";
import {
  classifyCanonicalPublisherRoute,
  routeInputFromRequest,
} from "./routes";

export default {
  async fetch(request: Request, env: PublisherEnv): Promise<Response> {
    let diagnosticRoute: DiagnosticRoute = "unclassified";
    try {
      const control = publisherEdgeConfiguration(env);
      const access = classifyAccessRoute(routeInputFromRequest(request), control.authority, "publisher");
      if (access?.kind === "access-routes") {
        diagnosticRoute = access.profile === "classic" ? "publish-classic" : "publish-game";
        assertNoInternalServiceHeaders(request.headers);
        enforceCircuitBreaker(access.profile === "classic" ? env.PUBLISH_ENABLED : env.GAME_PUBLISH_ENABLED,
          control.routeDisabledRetrySeconds);
        await enforceSharedIngress(env.GLOBAL_RATE_LIMITER, "publisher");
        return await validateAccessServiceResponse(await env.COORDINATOR.fetch(publisherServiceRequest(request)), "routes");
      }
      const route = classifyCanonicalPublisherRoute(
        routeInputFromRequest(request),
        control.authority,
      );
      diagnosticRoute = route.generation === "classic"
        ? "publish-classic"
        : "publish-game";
      assertNoInternalServiceHeaders(request.headers);

      enforceCircuitBreaker(
        route.generation === "classic"
          ? env.PUBLISH_ENABLED
          : env.GAME_PUBLISH_ENABLED,
        control.routeDisabledRetrySeconds,
      );
      await enforceSharedIngress(env.GLOBAL_RATE_LIMITER, "publisher");

      return await validatePublisherServiceResponse(
        await env.COORDINATOR.fetch(publisherServiceRequest(request)),
      );
    } catch (error) {
      return handleRequestError(error, diagnosticRoute, "publisher");
    }
  },
} satisfies ExportedHandler<PublisherEnv>;
