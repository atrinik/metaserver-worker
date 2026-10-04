import { classifyAccessRoute, ACCESS_RENDEZVOUS_SUBPROTOCOL } from "./routes";
import { accessResolveServiceRequest, validateAccessServiceResponse } from "./internal-service";
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
      const access = classifyAccessRoute(routeInputFromRequest(request), control.authority, "rendezvous");
      if (access !== null) {
        diagnosticRoute = "rendezvous-client";
        assertNoInternalServiceHeaders(request.headers);
        enforceCircuitBreaker(env.RENDEZVOUS_ENABLED, control.routeDisabledRetrySeconds);
        const privacy = createRequestPrivacyContext(request, {
          keys: await requiredSourceTagKeyRing(env), namespace: control.authority,
        });
        if (access.kind === "access-resolve") {
          // Existing ten/minute global ingress is stricter than resolve's thirty/minute ceiling.
          await enforceNativeBurstAliases(env.GLOBAL_RATE_LIMITER,
            actorAliases(await privacy.tags(SourceTagPurpose.GlobalIngress)), "global");
          return await validateAccessServiceResponse(await env.COORDINATOR.fetch(accessResolveServiceRequest(request)), "resolve");
        }
        if (access.kind !== "access-rendezvous" || access.profile !== "classic") throw new HttpError("service_disabled");
        await enforceNativeBurstAliases(env.RENDEZVOUS_CLIENT_RATE_LIMITER,
          actorAliases(await privacy.tags(SourceTagPurpose.RendezvousClientGlobal)), "rendezvous-client-source");
        const pair = actorAliases(await privacy.serverTags(SourceTagPurpose.RendezvousClientServer, access.serverId));
        return await validateRendezvousServiceResponse(await env.COORDINATOR.fetch(
          rendezvousServiceRequest(request, "client", { source: null, pair })), ACCESS_RENDEZVOUS_SUBPROTOCOL);
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
      const privacy = createRequestPrivacyContext(request, {
        keys: await requiredSourceTagKeyRing(env),
        namespace: control.authority,
      });
      if (route.role === "client") {
        const source = actorAliases(await privacy.tags(
          SourceTagPurpose.RendezvousClientGlobal,
        ));
        await enforceNativeBurstAliases(
          env.RENDEZVOUS_CLIENT_RATE_LIMITER,
          source,
          "rendezvous-client-source",
        );
      } else {
        await enforceNativeBurstAliases(
          env.GLOBAL_RATE_LIMITER,
          actorAliases(await privacy.tags(SourceTagPurpose.GlobalIngress)),
          "global",
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
          route.role === "client"
            ? { source: null, pair: requirePair(pair) }
            : { source: null, pair: null },
        )),
        route.subprotocol,
      );
    } catch (error) {
      return handleRequestError(error, diagnosticRoute, "rendezvous-edge");
    }
  },
} satisfies ExportedHandler<RendezvousEnv>;

function requirePair(
  pair: readonly [string, string] | null,
): readonly [string, string] {
  if (pair === null) {
    throw new Error("Client rendezvous omitted pair aliases");
  }
  return pair;
}
