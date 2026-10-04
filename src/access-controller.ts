import type { CoreEnv } from "./core-env";
import { accessRouteIndex } from "./access-crypto";
import { authenticateAccessRoute } from "./access-route-auth";
import type { AccessProfile } from "./access-route-auth";
import { parseAccessResolveRequest } from "./access-resolve";
import { mutateAccessRoute } from "./access-route-state";
import { consumeAccessBudget } from "./access-budget";
import { issueAccessGrant } from "./access-grants";
import { requiredSourceTagKeyRing } from "./privacy";
import { randomToken } from "./protocol";
import { readBoundedPublishBody } from "./publisher-auth";
import { HttpError } from "./http";
import { enforceNativeBurst } from "./rate-limit";
import { INTERNAL_ACCESS_PROBE_URL, INTERNAL_ACCESS_REVOKE_URL } from "./access-rendezvous";
import { INTERNAL_RENDEZVOUS_GENERATION_HEADER } from "./rendezvous-contract";

const PRIVATE_HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
export function accessUnavailable(): Response {
  return Response.json({ error: { code: "access_unavailable" } }, { status: 404, headers: PRIVATE_HEADERS });
}
export function accessRoomName(profile: AccessProfile, serverId: string): string {
  return profile === "classic" ? serverId : `game-v2:${serverId}`;
}

export async function handleAccessRouteMutation(
  request: Request, env: CoreEnv, profile: AccessProfile, serverId: string,
  authority: string, now: number,
): Promise<Response> {
  const authenticated = await authenticateAccessRoute(request,
    await readBoundedPublishBody(request, 4096), profile, serverId, authority, now);
  if (await env.DB.prepare("SELECT 1 AS denied FROM server_denials WHERE server_id=?")
      .bind(serverId).first<number>("denied") === 1) throw new HttpError("forbidden");
  // Dedicated quota avoids starving the first reserve/activate pair behind the
  // separately bounded publication required to bring a locked server online.
  await enforceNativeBurst(env.ACCESS_ROUTE_RATE_LIMITER, serverId, "publish-server");
  await consumeAccessBudget(env.DB, profile, serverId, "routes", now);
  const result = await mutateAccessRoute(env.DB, authenticated, now);
  if (result.outcome === "revoked") {
    const generation = await env.DB.prepare("SELECT rendezvous_generation FROM server_presence WHERE profile=? AND server_id=?")
      .bind(profile === "classic" ? "classic-v3" : "game-v2", serverId).first<string>("rendezvous_generation");
    if (generation !== null) {
      // D1 denial is already authoritative. Delivery failure cannot undo it;
      // each subsequent candidate dispatch independently rechecks the receipt.
      try { await env.RENDEZVOUS.getByName(accessRoomName(profile, serverId)).fetch(new Request(
        INTERNAL_ACCESS_REVOKE_URL, { headers: { [INTERNAL_RENDEZVOUS_GENERATION_HEADER]: generation } },
      )); } catch { /* The terminal route remains denied. */ }
    }
  }
  return Response.json(result, { headers: PRIVATE_HEADERS });
}

export async function handleAccessResolve(
  request: Request, env: CoreEnv, now: number, freshness: number,
): Promise<Response> {
  const parsed = parseAccessResolveRequest(await readBoundedPublishBody(request, 512));
  const index = await accessRouteIndex(parsed.routeCapability);
  try {
    const eligible = await env.DB.prepare(`SELECT route.profile,route.server_id,presence.rendezvous_generation
      FROM access_routes route JOIN server_presence presence ON presence.server_id=route.server_id
        AND presence.profile=CASE route.profile WHEN 'classic' THEN 'classic-v3' ELSE 'game-v2' END
      WHERE route.route_index=? AND route.state='active' AND (route.expires_at IS NULL OR route.expires_at>?)
        AND presence.access_required=1 AND presence.last_seen>?
        AND NOT EXISTS(SELECT 1 FROM server_denials WHERE server_id=route.server_id)`).bind(index, now, now - freshness)
      .first<{ profile: AccessProfile; server_id: string; rendezvous_generation: string }>();
    if (eligible === null || eligible.profile !== "classic") return accessUnavailable();
    await consumeAccessBudget(env.DB, eligible.profile, eligible.server_id, "resolve", now);
    const probe = await env.RENDEZVOUS.getByName(accessRoomName(eligible.profile, eligible.server_id)).fetch(new Request(
      INTERNAL_ACCESS_PROBE_URL, { headers: { [INTERNAL_RENDEZVOUS_GENERATION_HEADER]: eligible.rendezvous_generation } },
    ));
    await probe.body?.cancel();
    if (probe.status !== 204) return accessUnavailable();
    const grant = randomToken();
    const tags = await (await requiredSourceTagKeyRing(env)).accessGrantTags(
      env.RENDEZVOUS_HOSTNAME, eligible.profile, eligible.server_id, grant, parsed.clientNonce);
    const target = await issueAccessGrant(env.DB, index, parsed.clientNonce, tags,
      eligible.rendezvous_generation, now, freshness);
    if (target === null) return accessUnavailable();
    return Response.json({ schema: "atrinik-access-resolved-v1", profile: target.profile,
      serverId: target.server_id, certificate: target.certificate, name: target.name,
      accessRequired: true, generation: target.generation, clientNonce: parsed.clientNonce,
      grant, expiresAt: String(target.expires_at),
      ...(target.hostname === null ? {} : { endpoint: { hostname: target.hostname, port: target.port } }),
    }, { headers: PRIVATE_HEADERS });
  } catch (error) {
    if (error instanceof HttpError && error.code === "rate_limited") throw error;
    return accessUnavailable();
  }
}
