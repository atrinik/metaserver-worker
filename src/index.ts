import { WorkerEntrypoint } from "cloudflare:workers";

import type { CoreEnv } from "./core-env";

import {
  enforceCircuitBreaker,
  HttpError,
  httpErrorResponse,
} from "./http";
import {
  publisherCoordinatorConfiguration,
  rendezvousCoordinatorConfiguration,
  rendezvousPolicyConfiguration,
  scheduledMaintenanceConfiguration,
} from "./config";
import type {
  PublisherCoordinatorConfiguration,
  RendezvousCoordinatorConfiguration,
} from "./config";
import {
  DIRECTORY_PROFILES,
  expireDirectoryEntries,
} from "./directory-state";
import { DirectoryBuilder } from "./directory-builder";
import { logBlacklistMatch, logUnexpectedError } from "./diagnostics";
import type { BlacklistRoute, DiagnosticRoute } from "./diagnostics";
import {
  consumePublisherCoordinatorRequest,
  consumeRendezvousAdmissionAliases,
} from "./internal-service";
import type { RendezvousAdmissionAliases } from "./internal-service";
import { cleanupExpiredState } from "./maintenance";
import {
  randomToken,
  RequestError,
  sha256Hex,
} from "./protocol";
import {
  authenticateClassicPublish,
  authenticateGamePublish,
  isValidPublisherSequence,
  readBoundedPublishBody,
} from "./publisher-auth";
import {
  consumeFixedWindowBudget,
  enforceNativeBurst,
  utcDayWindow,
} from "./rate-limit";
import { handleRequestError } from "./request-errors";
import { openRendezvous, RendezvousRoom } from "./rendezvous";
import { consumeRendezvousPairCooldown } from "./rendezvous-cooldown";
import {
  INTERNAL_DIRECTORY_CHANGED_HEADER,
  INTERNAL_RENDEZVOUS_PUBLISH_URL,
} from "./rendezvous-contract";
import type { InternalRendezvousPublication } from "./rendezvous-contract";
import { readPublishedGeneration } from "./rendezvous-publication";
import {
  classifyCanonicalPublisherRoute,
  classifyCanonicalRendezvousRoute,
  routeInputFromRequest,
} from "./routes";
import type { CanonicalDynamicRoute } from "./routes";

export { DirectoryBuilder, RendezvousRoom };

/** Narrow internal publisher capability for the domainless publisher edge. */
export class PublisherCoordinator extends WorkerEntrypoint<CoreEnv> {
  async fetch(request: Request): Promise<Response> {
    return handlePublisherCoordinatorRequest(request, this.env, this.ctx);
  }
}

/** Narrow internal rendezvous capability for the domainless WebSocket edge. */
export class RendezvousCoordinator extends WorkerEntrypoint<CoreEnv> {
  async fetch(request: Request): Promise<Response> {
    return handleRendezvousCoordinatorRequest(request, this.env);
  }
}

export default {
  async scheduled(
    controller: ScheduledController,
    env: CoreEnv,
    _ctx: ExecutionContext,
  ): Promise<void> {
    try {
      const now = Math.floor(Date.now() / 1_000);
      const control = scheduledMaintenanceConfiguration(env);
      if (controller.cron === "*/5 * * * *") {
        const builds = await Promise.allSettled(
          DIRECTORY_PROFILES.map((profile) =>
            env.DIRECTORY_BUILDER.getByName(profile).reconcile()
          ),
        );
        if (builds.some((build) => build.status === "rejected")) {
          throw new Error("Static directory reconciliation failed");
        }
        return;
      }
      const listingCutoff = now - control.listingTtlSeconds;
      for (const profile of DIRECTORY_PROFILES) {
        await expireDirectoryEntries(env.DB, profile, listingCutoff, now);
      }
      const cleanup = await cleanupExpiredState(env.DB, {
        requestBudgetsAtOrBefore: now,
        rendezvousPairAtOrBefore: now,
        publisherNoncesAtOrBefore: now,
      }, {
        batchSize: 1_000,
        maximumBatches: 8,
      });
      if (cleanup.backloggedTargets.length > 0) {
        throw new Error(
          "Expired state cleanup exceeded its bounded run limit",
        );
      }
    } catch {
      logUnexpectedError("scheduled", "maintenance_failure");
      throw new Error("Scheduled maintenance failed");
    }
  },
} satisfies ExportedHandler<CoreEnv>;

export async function handlePublisherCoordinatorRequest(
  request: Request,
  env: CoreEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  let diagnosticRoute: DiagnosticRoute = "unclassified";
  try {
    const internal = consumePublisherCoordinatorRequest(request);
    const control = publisherCoordinatorConfiguration(env);
    const route = classifyCanonicalPublisherRoute(
      routeInputFromRequest(internal),
      control.authority,
    );
    diagnosticRoute = canonicalRouteDiagnosticName(route);
    enforceCircuitBreaker(
      route.generation === "classic"
        ? env.PUBLISH_ENABLED
        : env.GAME_PUBLISH_ENABLED,
      control.routeDisabledRetrySeconds,
    );
    const now = Math.floor(Date.now() / 1_000);
    return route.generation === "classic"
      ? await publishClassicServer(internal, env, route, control, now, ctx)
      : await publishGameServer(internal, env, route, control, now, ctx);
  } catch (error) {
    return handleRequestError(error, diagnosticRoute, "coordinator");
  }
}

export async function handleRendezvousCoordinatorRequest(
  request: Request,
  env: CoreEnv,
): Promise<Response> {
  let diagnosticRoute: DiagnosticRoute = "unclassified";
  try {
    const control = rendezvousCoordinatorConfiguration(env);
    const route = classifyCanonicalRendezvousRoute(
      routeInputFromRequest(request),
      control.authority,
    );
    diagnosticRoute = canonicalRouteDiagnosticName(route);
    if (route.generation !== "classic") {
      throw new HttpError("service_disabled", { retryAfterSeconds: 300 });
    }
    enforceCircuitBreaker(
      env.RENDEZVOUS_ENABLED,
      control.routeDisabledRetrySeconds,
    );
    // The room independently parses this same policy across rolling deploys.
    rendezvousPolicyConfiguration(env);
    const internal = consumeRendezvousAdmissionAliases(request, route.role);
    return await openCanonicalRendezvous(
      internal.request,
      env,
      route,
      internal.aliases,
      control,
      Math.floor(Date.now() / 1_000),
    );
  } catch (error) {
    return handleRequestError(error, diagnosticRoute, "coordinator");
  }
}

function canonicalRouteDiagnosticName(
  route: CanonicalDynamicRoute,
): DiagnosticRoute {
  if (route.kind === "publish") {
    return route.generation === "classic" ? "publish-classic" : "publish-game";
  }
  return route.role === "client" ? "rendezvous-client" : "rendezvous-server";
}

async function openCanonicalRendezvous(
  request: Request,
  env: CoreEnv,
  route: Extract<CanonicalDynamicRoute, { kind: "rendezvous" }>,
  aliases: RendezvousAdmissionAliases,
  control: RendezvousCoordinatorConfiguration,
  now: number,
): Promise<Response> {
  if (route.role === "client") {
    if (aliases.pair === null || aliases.source !== null) {
      throw new Error("Client rendezvous omitted pair admission aliases");
    }
  } else {
    if (aliases.pair !== null || aliases.source !== null) {
      throw new Error("Server rendezvous included pair admission aliases");
    }
  }

  return openRendezvous(request, env, route.serverId, route.role, {
    listingTtlSeconds: control.listingTtlSeconds,
    async clientEligible(): Promise<void> {
      if (aliases.pair === null) {
        throw new Error("Client rendezvous omitted pair admission aliases");
      }
      await consumeRendezvousPairCooldown(env.DB, {
        actorKeys: aliases.pair,
        now,
        burstLimit: control.rendezvousClientPairBurstLimit,
        windowSeconds: control.rendezvousClientPairWindowSeconds,
        initialCooldownSeconds:
          control.rendezvousClientPairInitialCooldownSeconds,
        maximumCooldownSeconds:
          control.rendezvousClientPairMaximumCooldownSeconds,
        resetSeconds: control.rendezvousClientPairResetSeconds,
      });
    },
    async serverAuthenticated(): Promise<void> {
      await enforceNativeBurst(
        env.RENDEZVOUS_SERVER_RATE_LIMITER,
        route.serverId,
        "rendezvous-server",
      );
      await consumeFixedWindowBudget(env.DB, {
        actorKey: route.serverId,
        scope: "rendezvous-server",
        limit: control.rendezvousServerDaily,
        now,
        window: utcDayWindow(now),
      });
    },
  });
}

async function publishClassicServer(
  request: Request,
  env: CoreEnv,
  route: Extract<CanonicalDynamicRoute, { kind: "publish" }>,
  control: PublisherCoordinatorConfiguration,
  now: number,
  ctx: ExecutionContext,
): Promise<Response> {
  const body = await readBoundedPublishBody(request, route.maximumBodyBytes);
  const authenticated = await authenticateClassicPublish(
    request,
    body,
    route.serverId,
    route.authority,
    now,
  );

  await enforceAuthenticatedPublishBudget(
    env,
    route.serverId,
    control.publishServerDaily,
    now,
    "classic-v1",
  );
  await enforceServerIdentityBlacklist(
    env,
    route.serverId,
    "publish-classic",
  );

  const payload = authenticated.payload;
  const rendezvousToken = randomToken();
  const publication = {
    serverId: route.serverId,
    directoryProfile: "classic-v1",
    publisherAuthentication: "signed-certificate-v1",
    publisherSequence: authenticated.sequence,
    publisherNonce: authenticated.nonce,
    publisherNonceExpiresAt: authenticated.nonceExpiresAt,
    commitToken: randomToken(),
    expectedGeneration: await readPublishedGeneration(
      env.DB,
      "classic-v1",
      route.serverId,
    ),
    generation: randomToken(),
    tokenHash: await sha256Hex(rendezvousToken),
    now,
    visibilityCutoff: now - control.listingTtlSeconds,
    name: payload.name,
    playersCount: payload.playersCount,
    version: payload.version,
    textComment: payload.textComment,
    isPublic: payload.public,
    quicHost: payload.hostname ?? "",
    quicPort: payload.port ?? 1,
    quicCertSha256: route.serverId,
    passwordRequired: payload.passwordRequired,
    directoryFingerprint: await classicDirectoryFingerprint({
      serverId: route.serverId,
      name: payload.name,
      playersCount: payload.playersCount,
      version: payload.version,
      textComment: payload.textComment,
      quicHost: payload.hostname ?? "",
      quicPort: payload.port ?? 1,
      quicCertSha256: route.serverId,
      passwordRequired: payload.passwordRequired,
    }),
  } satisfies InternalRendezvousPublication;
  const committed = await commitRendezvousPublication(env, publication);
  if (committed.status === 409) {
    const conflict = await readPublishReplayConflict(committed);
    if (conflict !== null) {
      return Response.json(
        { error: conflict },
        {
          status: 409,
          headers: {
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          },
        },
      );
    }
    throw new HttpError("service_disabled", { retryAfterSeconds: 5 });
  }
  if (committed.status !== 204) {
    await committed.body?.cancel();
    throw new Error("Signed publication did not commit");
  }
  scheduleDirectoryReconciliation(env, ctx, committed, "classic-v1");
  return Response.json(
    { status: "ok", rendezvousToken },
    {
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

async function publishGameServer(
  request: Request,
  env: CoreEnv,
  route: Extract<CanonicalDynamicRoute, { kind: "publish" }>,
  control: PublisherCoordinatorConfiguration,
  now: number,
  ctx: ExecutionContext,
): Promise<Response> {
  const body = await readBoundedPublishBody(request, route.maximumBodyBytes);
  const authenticated = await authenticateGamePublish(
    request,
    body,
    route.serverId,
    route.authority,
    now,
  );
  await enforceAuthenticatedPublishBudget(
    env,
    route.serverId,
    control.publishServerDaily,
    now,
    "game-v1",
  );
  await enforceServerIdentityBlacklist(env, route.serverId, "publish-game");

  const payload = authenticated.payload;
  const rendezvousToken = randomToken();
  const publication = {
    serverId: route.serverId,
    directoryProfile: "game-v1",
    publisherAuthentication: "signed-certificate-v1",
    publisherSequence: authenticated.sequence,
    publisherNonce: authenticated.nonce,
    publisherNonceExpiresAt: authenticated.nonceExpiresAt,
    commitToken: randomToken(),
    expectedGeneration: await readPublishedGeneration(
      env.DB,
      "game-v1",
      route.serverId,
    ),
    generation: randomToken(),
    tokenHash: await sha256Hex(rendezvousToken),
    now,
    visibilityCutoff: now - control.listingTtlSeconds,
    name: payload.name,
    description: payload.description,
    region: payload.region ?? null,
    protocolMajor: 1,
    protocolMinor: payload.protocol.minor,
    contentId: payload.content.id,
    contentRevisionSha256: payload.content.revisionSha256,
    playersOnline: payload.players.online,
    playersCapacity: payload.players.capacity,
    status: payload.status,
    isPublic: payload.public,
    quicHost: payload.endpoint?.hostname ?? "",
    quicPort: payload.endpoint?.port ?? 1,
    quicCertSha256: route.serverId,
    passwordRequired: payload.passwordRequired,
    directoryFingerprint: await gameDirectoryFingerprint({
      serverId: route.serverId,
      name: payload.name,
      description: payload.description,
      region: payload.region ?? null,
      protocolMinor: payload.protocol.minor,
      contentId: payload.content.id,
      contentRevisionSha256: payload.content.revisionSha256,
      playersOnline: payload.players.online,
      playersCapacity: payload.players.capacity,
      status: payload.status,
      quicHost: payload.endpoint?.hostname ?? "",
      quicPort: payload.endpoint?.port ?? 1,
      passwordRequired: payload.passwordRequired,
    }),
  } satisfies InternalRendezvousPublication;
  const committed = await commitRendezvousPublication(env, publication);
  if (committed.status === 409) {
    const conflict = await readPublishReplayConflict(committed);
    if (conflict !== null) {
      return Response.json(
        { error: conflict },
        {
          status: 409,
          headers: {
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          },
        },
      );
    }
    throw new HttpError("service_disabled", { retryAfterSeconds: 5 });
  }
  if (committed.status !== 204) {
    await committed.body?.cancel();
    throw new Error("Game publication did not commit");
  }
  scheduleDirectoryReconciliation(env, ctx, committed, "game-v1");
  return Response.json(
    { status: "ok", rendezvousToken },
    {
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

async function commitRendezvousPublication(
  env: CoreEnv,
  publication: InternalRendezvousPublication,
): Promise<Response> {
  const roomName = publication.directoryProfile === "classic-v1"
    ? publication.serverId
    : `game-v1:${publication.serverId}`;
  return env.RENDEZVOUS.getByName(roomName).fetch(
    new Request(INTERNAL_RENDEZVOUS_PUBLISH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(publication),
    }),
  );
}

function scheduleDirectoryReconciliation(
  env: CoreEnv,
  ctx: ExecutionContext,
  response: Response,
  profile: typeof DIRECTORY_PROFILES[number],
): void {
  const changed = response.headers.get(INTERNAL_DIRECTORY_CHANGED_HEADER);
  // A previous Room version returns a headerless 204. The D1 commit is already
  // authoritative at this boundary, so any value other than an exact neutral
  // marker is treated conservatively as work instead of turning success into a
  // public error during rolling replacement.
  if (changed !== "0") {
    ctx.waitUntil(
      env.DIRECTORY_BUILDER.getByName(profile).nudge().then(
        () => undefined,
        () => undefined,
      ),
    );
  }
}

async function readPublishReplayConflict(
  response: Response,
): Promise<{ readonly code: "publish_replay"; readonly minimumNextSequence: string } | null> {
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    !("error" in parsed) ||
    typeof parsed.error !== "object" ||
    parsed.error === null ||
    Array.isArray(parsed.error)
  ) {
    return null;
  }
  const error = parsed.error as Record<string, unknown>;
  if (
    Object.keys(error).length !== 2 ||
    error.code !== "publish_replay" ||
    typeof error.minimumNextSequence !== "string" ||
    !isValidPublisherSequence(error.minimumNextSequence)
  ) {
    return null;
  }
  return {
    code: "publish_replay",
    minimumNextSequence: error.minimumNextSequence,
  };
}

interface ClassicDirectoryFingerprintInput {
  readonly serverId: string;
  readonly name: string;
  readonly playersCount: number;
  readonly version: string;
  readonly textComment: string;
  readonly quicHost: string;
  readonly quicPort: number;
  readonly quicCertSha256: string;
  readonly passwordRequired: boolean;
}

interface GameDirectoryFingerprintInput {
  readonly serverId: string;
  readonly name: string;
  readonly description: string;
  readonly region: string | null;
  readonly protocolMinor: number;
  readonly contentId: string;
  readonly contentRevisionSha256: string;
  readonly playersOnline: number;
  readonly playersCapacity: number;
  readonly status: "online" | "full" | "maintenance";
  readonly quicHost: string;
  readonly quicPort: number;
  readonly passwordRequired: boolean;
}

async function classicDirectoryFingerprint(
  input: ClassicDirectoryFingerprintInput,
): Promise<string> {
  return sha256Hex(JSON.stringify({
    schema: "atrinik-classic-directory-entry-v1",
    serverId: input.serverId,
    name: input.name,
    playersCount: input.playersCount,
    version: input.version,
    textComment: input.textComment,
    passwordRequired: input.passwordRequired,
    certificateSha256: input.quicCertSha256,
    ...(input.quicHost === ""
      ? {}
      : { hostname: input.quicHost, port: input.quicPort }),
  }));
}

async function gameDirectoryFingerprint(
  input: GameDirectoryFingerprintInput,
): Promise<string> {
  return sha256Hex(JSON.stringify({
    schema: "atrinik-game-directory-entry-v1",
    serverId: input.serverId,
    certificateSha256: input.serverId,
    name: input.name,
    description: input.description,
    ...(input.region === null ? {} : { region: input.region }),
    protocol: { major: 1, minor: input.protocolMinor },
    content: {
      id: input.contentId,
      revisionSha256: input.contentRevisionSha256,
    },
    players: {
      online: input.playersOnline,
      capacity: input.playersCapacity,
    },
    status: input.status,
    passwordRequired: input.passwordRequired,
    ...(input.quicHost === ""
      ? {}
      : { endpoint: { hostname: input.quicHost, port: input.quicPort } }),
  }));
}

async function enforceAuthenticatedPublishBudget(
  env: CoreEnv,
  serverId: string,
  dailyLimit: number,
  now: number,
  profile: "classic-v1" | "game-v1",
): Promise<void> {
  const scope = profile === "classic-v1"
    ? "publish-server"
    : "publish-game-server";
  await enforceNativeBurst(
    env.PUBLISH_IDENTITY_RATE_LIMITER,
    serverId,
    scope,
  );
  await consumeFixedWindowBudget(env.DB, {
    actorKey: serverId,
    scope,
    limit: dailyLimit,
    now,
    window: utcDayWindow(now),
  });
}

async function enforceServerIdentityBlacklist(
  env: CoreEnv,
  serverId: string,
  route: BlacklistRoute,
): Promise<void> {
  const matched = await env.DB.prepare(
    `SELECT 1 AS matched
       FROM server_blacklist
      WHERE ? GLOB pattern
      LIMIT 1`,
  ).bind(serverId).first<number>("matched");
  if (matched !== null) {
    logBlacklistMatch(route, "server_identity");
    throw new RequestError("The server is blacklisted", 403);
  }
}
