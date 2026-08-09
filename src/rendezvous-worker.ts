import { rendezvousEdgeConfiguration } from "./config";
import type { DiagnosticRoute } from "./diagnostics";
import { enforceCircuitBreaker, HttpError } from "./http";
import {
  actorAliases,
  assertNoInternalServiceHeaders,
  rendezvousServiceRequest,
  validateRendezvousServiceResponse,
} from "./internal-service";
import {
  createRequestPrivacyContext,
  requiredSourceTagKeyRing,
  SourceTagPurpose,
} from "./privacy";
import { enforceNativeBurstAliases } from "./rate-limit";
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
      const privacy = createRequestPrivacyContext(request, {
        keys: await requiredSourceTagKeyRing(env),
        namespace: control.authority,
      });
      await enforceNativeBurstAliases(
        env.GLOBAL_RATE_LIMITER,
        actorAliases(await privacy.tags(SourceTagPurpose.GlobalIngress)),
        "global",
      );

      const source = route.role === "client"
        ? actorAliases(await privacy.tags(
          SourceTagPurpose.RendezvousClientGlobal,
        ))
        : actorAliases(await privacy.tags(SourceTagPurpose.RendezvousServer));
      if (route.role === "client") {
        await enforceNativeBurstAliases(
          env.RENDEZVOUS_CLIENT_RATE_LIMITER,
          source,
          "rendezvous-client-source",
        );
      }
      const pair = route.role === "client"
        ? actorAliases(await privacy.serverTags(
          SourceTagPurpose.RendezvousClientServer,
          route.serverId,
        ))
        : null;

      return await validateRendezvousServiceResponse(
        await env.COORDINATOR.fetch(rendezvousServiceRequest(
          request,
          route.role,
          { source, pair },
        )),
        route.subprotocol,
      );
    } catch (error) {
      return handleRequestError(error, diagnosticRoute, "rendezvous-edge");
    }
  },
} satisfies ExportedHandler<RendezvousEnv>;
