import { publisherEdgeConfiguration } from "./config";
import type { DiagnosticRoute } from "./diagnostics";
import { enforceCircuitBreaker } from "./http";
import {
  actorAliases,
  assertNoInternalServiceHeaders,
  publisherServiceRequest,
  validatePublisherServiceResponse,
} from "./internal-service";
import {
  createRequestPrivacyContext,
  requiredSourceTagKeyRing,
  SourceTagPurpose,
} from "./privacy";
import { enforceNativeBurstAliases } from "./rate-limit";
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
      const privacy = createRequestPrivacyContext(request, {
        keys: await requiredSourceTagKeyRing(env),
        namespace: control.authority,
      });
      await enforceNativeBurstAliases(
        env.GLOBAL_RATE_LIMITER,
        actorAliases(await privacy.tags(SourceTagPurpose.GlobalIngress)),
        "global",
      );

      return await validatePublisherServiceResponse(
        await env.COORDINATOR.fetch(publisherServiceRequest(request)),
      );
    } catch (error) {
      return handleRequestError(error, diagnosticRoute, "publisher");
    }
  },
} satisfies ExportedHandler<PublisherEnv>;
