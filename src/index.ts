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
  requestControlConfiguration,
} from "./config";
import type {
  PublisherCoordinatorConfiguration,
  RendezvousCoordinatorConfiguration,
  RequestControlConfiguration,
} from "./config";
import {
  DIRECTORY_PROFILES,
  expireDirectoryEntries,
} from "./directory-state";
import { DirectoryBuilder } from "./directory-builder";
import { isCanonicalHostname } from "./hostname";
import {
  logBlacklistMatch,
  logUnexpectedError,
} from "./diagnostics";
import type { DiagnosticRoute } from "./diagnostics";
import {
  consumePublisherCoordinatorRequest,
  consumeRendezvousAdmissionAliases,
} from "./internal-service";
import type { RendezvousAdmissionAliases } from "./internal-service";
import { cleanupExpiredState } from "./maintenance";
import {
  createRequestPrivacyContext,
  requiredSourceTagKeyRing,
  SourceTagPurpose,
  SourceTagConfigurationError,
} from "./privacy";
import type {
  RequestPrivacyContext,
  UnscopedSourceTagPurpose,
} from "./privacy";
import {
  constantTimeEqual,
  deriveStoredKey,
  deriveUpdateProof,
  escapeXml,
  formatOtpResponse,
  normalizeIpAddress,
  parseUpdatePayload,
  randomToken,
  RequestError,
  sha256Hex,
} from "./protocol";
import {
  authenticateClassicPublish,
  isValidPublisherSequence,
  readBoundedPublishBody,
} from "./publisher-auth";
import {
  consumeAliasedFixedWindowBudget,
  consumeFixedWindowBudget,
  enforceNativeBurst,
  enforceNativeBurstAliases,
  utcDayWindow,
} from "./rate-limit";
import type { RequestBudgetScope } from "./rate-limit";
import { handleRequestError } from "./request-errors";
import { openRendezvous, RendezvousRoom } from "./rendezvous";
import {
  INTERNAL_DIRECTORY_CHANGED_HEADER,
  INTERNAL_RENDEZVOUS_PUBLISH_URL,
} from "./rendezvous-contract";
import type { InternalRendezvousPublication } from "./rendezvous-contract";
import { readPublishedGeneration } from "./rendezvous-publication";
import {
  classifyCanonicalRoute,
  classifyCanonicalPublisherRoute,
  classifyCanonicalRendezvousRoute,
  classifyCompatibilityRoute,
  PUBLISH_AUTHORITY,
  RENDEZVOUS_AUTHORITY,
  routeInputFromRequest,
} from "./routes";
import type { CanonicalDynamicRoute, CompatibilityRoute } from "./routes";
import type {
  DirectoryServerRecord,
  OwnerAuthRecord,
  UpdatePayload,
} from "./types";

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
  async fetch(
    request: Request,
    env: CoreEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    let diagnosticRoute: DiagnosticRoute = "unclassified";
    try {
      const hostname = new URL(request.url).hostname.toLowerCase();
      if (hostname === PUBLISH_AUTHORITY || hostname === RENDEZVOUS_AUTHORITY) {
        const route = classifyCanonicalRoute(routeInputFromRequest(request));
        diagnosticRoute = canonicalRouteDiagnosticName(route);
        throw new HttpError("misdirected_request");
      }

      const control = requestControlConfiguration(env);
      const route = classifyCompatibilityRoute(
        routeInputFromRequest(request),
        control.compatibilityHostname,
      );
      diagnosticRoute = routeDiagnosticName(route);
      enforceRouteCircuitBreaker(route, env, control);
      if (route.kind === "compatibility-rendezvous") {
        // Reject malformed room-only policy before source-tag derivation,
        // native counters, D1 budgets, server lookup, or a Durable Object
        // invocation. The room parses the same environment independently as
        // the final authority across a rolling deployment.
        rendezvousPolicyConfiguration(env);
      }

      const privacy = createRequestPrivacyContext(request, {
        keys: await requiredSourceTagKeyRing(env),
        namespace: control.compatibilityHostname,
      });
      await enforceNativeBurstAliases(
        env.GLOBAL_RATE_LIMITER,
        actorAliases(await privacy.tags(SourceTagPurpose.GlobalIngress)),
        "global",
      );

      const now = Math.floor(Date.now() / 1_000);
      switch (route.kind) {
        case "compatibility-status":
          await consumeAliasedFixedWindowBudget(env.DB, {
            actorKeys: actorAliases(await privacy.tags(
              SourceTagPurpose.CompatStatus,
            )),
            scope: "compat-status",
            limit: control.compatibilityStatusDaily,
            now,
            window: utcDayWindow(now),
          });
          return Response.json(
            { service: "Atrinik metaserver", status: "ok" },
            {
              headers: {
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
              },
            },
          );
        case "compatibility-directory":
          await enforceAnonymousBudget(
            env,
            privacy,
            SourceTagPurpose.CompatDirectory,
            env.DIRECTORY_RATE_LIMITER,
            "compat-directory",
            control.compatibilityDirectoryDaily,
            now,
          );
          return await listDirectServers(
            env,
            now,
            control.listingTtlSeconds,
          );
        case "compatibility-otp":
          await enforceAnonymousBudget(
            env,
            privacy,
            SourceTagPurpose.CompatOtp,
            env.OTP_RATE_LIMITER,
            "compat-otp",
            control.compatibilityOtpDaily,
            now,
          );
          return await issueOtp(
            env,
            privacy,
            control.otpTtlSeconds,
            now,
          );
        case "compatibility-update":
          await enforceAnonymousBudget(
            env,
            privacy,
            SourceTagPurpose.CompatUpdate,
            env.UPDATE_RATE_LIMITER,
            "compat-update-source",
            control.compatibilityUpdateSourceDaily,
            now,
          );
          return await updateServer(
            request,
            env,
            privacy,
            control,
            route.maximumBodyBytes,
            now,
            ctx,
          );
        case "compatibility-rendezvous":
          return await openCompatibilityRendezvous(
            request,
            env,
            privacy,
            route,
            control,
            now,
          );
      }
    } catch (error) {
      return handleRequestError(error, diagnosticRoute);
    }
  },

  async scheduled(
    controller: ScheduledController,
    env: CoreEnv,
    _ctx: ExecutionContext,
  ): Promise<void> {
    try {
      const now = Math.floor(Date.now() / 1_000);
      const control = requestControlConfiguration(env);
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
      const staleCutoff = now - control.staleDataRetentionSeconds;
      const cleanup = await cleanupExpiredState(env.DB, {
        serversBefore: staleCutoff,
        oneTimeTokensAtOrBefore: now,
        rateLimitsBefore: now - 86_400,
        requestBudgetsAtOrBefore: now,
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
    if (route.generation !== "classic") {
      throw new HttpError("service_disabled", { retryAfterSeconds: 300 });
    }
    enforceCircuitBreaker(
      env.PUBLISH_ENABLED,
      control.routeDisabledRetrySeconds,
    );
    return await publishClassicServer(
      internal,
      env,
      route,
      control,
      Math.floor(Date.now() / 1_000),
      ctx,
    );
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

function routeDiagnosticName(route: CompatibilityRoute): DiagnosticRoute {
  switch (route.kind) {
    case "compatibility-status":
      return "compat-status";
    case "compatibility-directory":
      return "compat-directory";
    case "compatibility-otp":
      return "compat-otp";
    case "compatibility-update":
      return "compat-update";
    case "compatibility-rendezvous":
      return route.role === "client"
        ? "compat-rendezvous-client"
        : "compat-rendezvous-server";
  }
}

function enforceRouteCircuitBreaker(
  route: CompatibilityRoute,
  env: CoreEnv,
  control: RequestControlConfiguration,
): void {
  switch (route.kind) {
    case "compatibility-status":
      enforceCircuitBreaker(
        env.COMPAT_STATUS_ENABLED,
        control.routeDisabledRetrySeconds,
      );
      return;
    case "compatibility-directory":
      enforceCircuitBreaker(
        env.COMPAT_DIRECTORY_ENABLED,
        control.routeDisabledRetrySeconds,
      );
      return;
    case "compatibility-otp":
      enforceCircuitBreaker(
        env.COMPAT_OTP_ENABLED,
        control.routeDisabledRetrySeconds,
      );
      return;
    case "compatibility-update":
      enforceCircuitBreaker(
        env.COMPAT_UPDATE_ENABLED,
        control.routeDisabledRetrySeconds,
      );
      return;
    case "compatibility-rendezvous":
      enforceCircuitBreaker(
        env.COMPAT_RENDEZVOUS_ENABLED,
        control.routeDisabledRetrySeconds,
      );
      return;
  }
}

async function enforceAnonymousBudget(
  env: CoreEnv,
  privacy: RequestPrivacyContext,
  purpose: UnscopedSourceTagPurpose,
  limiter: RateLimit,
  scope: RequestBudgetScope,
  dailyLimit: number,
  now: number,
): Promise<void> {
  const tags = await privacy.tags(purpose);
  await enforceNativeBurstAliases(limiter, actorAliases(tags), scope);
  await consumeAliasedFixedWindowBudget(env.DB, {
    actorKeys: actorAliases(tags),
    scope,
    limit: dailyLimit,
    now,
    window: utcDayWindow(now),
  });
}

function actorAliases(
  actorKeys: readonly string[],
): readonly [current: string] | readonly [current: string, previous: string] {
  const current = actorKeys[0];
  if (current === undefined || actorKeys.length > 2) {
    throw new Error("Source-tag key ring produced an invalid alias set");
  }
  const previous = actorKeys[1];
  return previous === undefined ? [current] : [current, previous];
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
    if (aliases.pair === null) {
      throw new Error("Client rendezvous omitted pair admission aliases");
    }
    await consumeAliasedFixedWindowBudget(env.DB, {
      actorKeys: aliases.source,
      scope: "rendezvous-client-source",
      limit: control.compatibilityRendezvousClientSourceDaily,
      now,
      window: utcDayWindow(now),
    });
    await consumeAliasedFixedWindowBudget(env.DB, {
      actorKeys: aliases.pair,
      scope: "rendezvous-client-source-server",
      limit: control.compatibilityRendezvousClientPairDaily,
      now,
      window: utcDayWindow(now),
    });
  } else {
    if (aliases.pair !== null) {
      throw new Error("Server rendezvous included pair admission aliases");
    }
    await consumeAliasedFixedWindowBudget(env.DB, {
      actorKeys: aliases.source,
      scope: "rendezvous-server-source",
      limit: control.compatibilityRendezvousServerSourceDaily,
      now,
      window: utcDayWindow(now),
    });
  }

  return openRendezvous(request, env, route.serverId, route.role, {
    listingTtlSeconds: control.listingTtlSeconds,
    async serverAuthenticated(): Promise<void> {
      await enforceNativeBurst(
        env.RENDEZVOUS_SERVER_RATE_LIMITER,
        route.serverId,
        "rendezvous-server",
      );
      await consumeFixedWindowBudget(env.DB, {
        actorKey: route.serverId,
        scope: "rendezvous-server",
        limit: control.compatibilityRendezvousServerDaily,
        now,
        window: utcDayWindow(now),
      });
    },
  });
}

async function openCompatibilityRendezvous(
  request: Request,
  env: CoreEnv,
  privacy: RequestPrivacyContext,
  route: Extract<CompatibilityRoute, { kind: "compatibility-rendezvous" }>,
  control: RequestControlConfiguration,
  now: number,
): Promise<Response> {
  if (route.role === "client") {
    await enforceAnonymousBudget(
      env,
      privacy,
      SourceTagPurpose.RendezvousClientGlobal,
      env.RENDEZVOUS_CLIENT_RATE_LIMITER,
      "rendezvous-client-source",
      control.compatibilityRendezvousClientSourceDaily,
      now,
    );
    await consumeAliasedFixedWindowBudget(env.DB, {
      actorKeys: actorAliases(await privacy.serverTags(
        SourceTagPurpose.RendezvousClientServer,
        route.serverId,
      )),
      scope: "rendezvous-client-source-server",
      limit: control.compatibilityRendezvousClientPairDaily,
      now,
      window: utcDayWindow(now),
    });
  } else {
    await consumeAliasedFixedWindowBudget(env.DB, {
      actorKeys: actorAliases(await privacy.tags(
        SourceTagPurpose.RendezvousServer,
      )),
      scope: "rendezvous-server-source",
      limit: control.compatibilityRendezvousServerSourceDaily,
      now,
      window: utcDayWindow(now),
    });
  }

  return openRendezvous(request, env, route.serverId, route.role, {
    listingTtlSeconds: control.listingTtlSeconds,
    async serverAuthenticated(): Promise<void> {
      await enforceNativeBurst(
        env.RENDEZVOUS_SERVER_RATE_LIMITER,
        route.serverId,
        "rendezvous-server",
      );
      await consumeFixedWindowBudget(env.DB, {
        actorKey: route.serverId,
        scope: "rendezvous-server",
        limit: control.compatibilityRendezvousServerDaily,
        now,
        window: utcDayWindow(now),
      });
    },
  });
}

async function listDirectServers(
  env: CoreEnv,
  now: number,
  listingTtlSeconds: number,
): Promise<Response> {
  const cutoff = now - listingTtlSeconds;
  const result = await env.DB.prepare(
    `SELECT entries.server_id, entries.name, entries.players_count,
            entries.version, entries.text_comment, entries.hostname,
            entries.port, entries.quic_cert_sha256,
            entries.password_required
       FROM directory_entries AS entries
       JOIN server_presence AS presence
         ON presence.profile = entries.profile
        AND presence.server_id = entries.server_id
      WHERE entries.profile = 'classic-v1'
        AND presence.last_seen > ?
      ORDER BY entries.name COLLATE NOCASE, entries.server_id`,
  )
    .bind(cutoff)
    .all<DirectoryServerRecord>();

  const body = result.results.map((server) => {
    if (
      (server.hostname === null) !== (server.port === null) ||
      (server.hostname !== null &&
        (!isCanonicalHostname(server.hostname) ||
          server.port === null ||
          !Number.isSafeInteger(server.port) ||
          server.port < 1 ||
          server.port > 65_535))
    ) {
      throw new Error("Stored directory endpoint is invalid");
    }
    const directEndpoint = server.hostname === null
      ? ""
      : `<Address>${escapeXml(server.hostname)}</Address>` +
        `<Port>${server.port}</Port>`;

    return (
      "<Server>" +
      `<Id>${escapeXml(server.server_id)}</Id>` +
      `<Name>${escapeXml(server.name)}</Name>` +
      `<PlayersCount>${server.players_count}</PlayersCount>` +
      `<Version>${escapeXml(server.version)}</Version>` +
      `<TextComment>${escapeXml(server.text_comment || "No description.")}</TextComment>` +
      directEndpoint +
      `<CertificateSha256>${server.quic_cert_sha256}</CertificateSha256>` +
      `<PasswordRequired>${server.password_required === 1 ? "true" : "false"}</PasswordRequired>` +
      "</Server>"
    );
  }).join("");

  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><Servers protocol="3">${body}</Servers>`,
    {
      headers: {
        "Cache-Control": "public, max-age=5",
        "Content-Type": "application/xml; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

async function issueOtp(
  env: CoreEnv,
  privacy: RequestPrivacyContext,
  otpTtlSeconds: number,
  now: number,
): Promise<Response> {
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const sourceTags = await privacy.tags(SourceTagPurpose.CompatOtp);
  const currentSourceTag = sourceTags[0];
  const previousSourceTag = sourceTags[1];
  if (
    currentSourceTag === undefined ||
    previousSourceTag === undefined ||
    currentSourceTag === previousSourceTag
  ) {
    throw new SourceTagConfigurationError(
      "OTP issuance requires two distinct source-tag keys",
    );
  }
  const expiresAt = now + otpTtlSeconds;
  await env.DB.prepare(
    `INSERT INTO one_time_tokens
       (token_hash, source_ip, expires_at, created_at, source_tag,
        source_tag_previous)
     VALUES (?, '', ?, ?, ?, ?)`,
  )
    .bind(
      tokenHash,
      expiresAt,
      now,
      currentSourceTag,
      previousSourceTag,
    )
    .run();

  return new Response(formatOtpResponse(token), {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function updateServer(
  request: Request,
  env: CoreEnv,
  privacy: RequestPrivacyContext,
  control: RequestControlConfiguration,
  maximumBodyBytes: number,
  now: number,
  ctx: ExecutionContext,
): Promise<Response> {
  const payload = parseUpdatePayload(await readUpdateForm(
    request,
    maximumBodyBytes,
  ));
  const sourceIp = sourceAddress(request);
  await enforceBlacklist(env, payload.serverId, sourceIp);

  let owner = await env.DB.prepare(
    `SELECT auth_key, authentication_kind
       FROM server_owners WHERE server_id = ?`,
  )
    .bind(payload.serverId)
    .first<OwnerAuthRecord>();
  let provisionalOwner: { readonly authKey: string; readonly createdAt: number } |
    null = null;

  if (owner !== null) {
    if (payload.registration) {
      await authenticateCompatibilityRegistration(payload, owner);
    } else {
      await authenticateExistingOwner(payload, owner);
    }
    await enforceAuthenticatedUpdateBudget(
      env,
      payload.serverId,
      control.compatibilityUpdateServerDaily,
      now,
    );
    await consumeOtp(
      env,
      payload.otp,
      privacy,
      Math.floor(Date.now() / 1_000),
    );
  } else {
    if (!payload.registration) {
      throw new RequestError(
        "The server identity has no ownership record; explicit registration is required",
        409,
      );
    }
    await consumeOtp(
      env,
      payload.otp,
      privacy,
      Math.floor(Date.now() / 1_000),
    );

    const storedKey = await deriveStoredKey(payload.key, payload.serverId);
    const insertion = await env.DB.prepare(
      `INSERT OR IGNORE INTO server_owners
         (server_id, auth_key, current_ip, ip_changed_at, created_at, updated_at)
       VALUES (?, ?, '', ?, ?, ?)`,
    )
      .bind(payload.serverId, storedKey, now, now, now)
      .run();

    owner = await env.DB.prepare(
      `SELECT auth_key, authentication_kind
         FROM server_owners WHERE server_id = ?`,
    )
      .bind(payload.serverId)
      .first<OwnerAuthRecord>();

    if (owner === null) {
      throw new Error("Owner registration was not persisted");
    }
    if (!insertion.meta.changes &&
        !await constantTimeEqual(storedKey, owner.auth_key)) {
      throw new RequestError("Invalid metaserver key", 401);
    }
    if (insertion.meta.changes === 1) {
      provisionalOwner = { authKey: storedKey, createdAt: now };
    }
  }

  const rendezvousToken = randomToken();
  const rendezvousTokenHash = await sha256Hex(rendezvousToken);
  const rendezvousGeneration = randomToken();
  const expectedGeneration = await readPublishedGeneration(
    env.DB,
    "classic-v1",
    payload.serverId,
  );
  const publication = {
    serverId: payload.serverId,
    directoryProfile: "classic-v1",
    publisherAuthentication: "compat-key-v1",
    publisherSequence: null,
    publisherNonce: null,
    publisherNonceExpiresAt: null,
    commitToken: randomToken(),
    expectedGeneration,
    generation: rendezvousGeneration,
    tokenHash: rendezvousTokenHash,
    now,
    visibilityCutoff: now - control.listingTtlSeconds,
    name: payload.name,
    playersCount: payload.playersCount,
    version: payload.version,
    textComment: payload.textComment,
    isPublic: payload.isPublic,
    // Compatibility updates carry numeric endpoints. Keep accepting their
    // legacy wire shape during the sunset, but never promote a discovered IP
    // into the explicit persisted hostname field.
    quicHost: "",
    quicPort: 1,
    quicCertSha256: payload.quicCertSha256,
    passwordRequired: payload.passwordRequired,
    directoryFingerprint: await classicDirectoryFingerprint({
      serverId: payload.serverId,
      name: payload.name,
      playersCount: payload.playersCount,
      version: payload.version,
      textComment: payload.textComment,
      quicHost: "",
      quicPort: 1,
      quicCertSha256: payload.quicCertSha256,
      passwordRequired: payload.passwordRequired,
    }),
  } satisfies InternalRendezvousPublication;
  let committed: Response;
  try {
    committed = await commitRendezvousPublication(env, publication);
  } catch (error) {
    await rollbackProvisionalOwner(
      env.DB,
      payload.serverId,
      provisionalOwner,
    );
    throw error;
  }
  if (committed.status !== 204) {
    await committed.body?.cancel();
    await rollbackProvisionalOwner(
      env.DB,
      payload.serverId,
      provisionalOwner,
    );
  }
  if (committed.status === 409) {
    throw new HttpError("service_disabled", { retryAfterSeconds: 5 });
  }
  if (committed.status !== 204) {
    throw new Error("Rendezvous publication did not commit");
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

async function rollbackProvisionalOwner(
  db: D1Database,
  serverId: string,
  provisional: { readonly authKey: string; readonly createdAt: number } | null,
): Promise<void> {
  if (provisional === null) {
    return;
  }
  const removed = await db.prepare(
    `DELETE FROM server_owners
      WHERE server_id = ? AND auth_key = ?
        AND authentication_kind = 'compat-key-v1'
        AND current_ip = ''
        AND created_at = ? AND updated_at = ?
        AND rendezvous_generation = ?
        AND NOT EXISTS (
          SELECT 1 FROM server_presence WHERE server_id = ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM publisher_replay WHERE server_id = ?
        )`,
  ).bind(
    serverId,
    provisional.authKey,
    provisional.createdAt,
    provisional.createdAt,
    "0".repeat(64),
    serverId,
    serverId,
  ).run();
  if (removed.meta.changes === 1) {
    return;
  }
  const stranded = await db.prepare(
    `SELECT COUNT(*) AS count FROM server_owners AS owners
      WHERE owners.server_id = ? AND owners.auth_key = ?
        AND owners.authentication_kind = 'compat-key-v1'
        AND owners.current_ip = ''
        AND owners.created_at = ? AND owners.updated_at = ?
        AND owners.rendezvous_generation = ?
        AND NOT EXISTS (
          SELECT 1 FROM server_presence WHERE server_id = owners.server_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM publisher_replay WHERE server_id = owners.server_id
        )`,
  ).bind(
    serverId,
    provisional.authKey,
    provisional.createdAt,
    provisional.createdAt,
    "0".repeat(64),
  ).first<number>("count");
  if (stranded !== 0) {
    throw new Error("Provisional owner rollback did not complete");
  }
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
  );
  await enforceServerIdentityBlacklist(env, route.serverId);

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

async function commitRendezvousPublication(
  env: CoreEnv,
  publication: InternalRendezvousPublication,
): Promise<Response> {
  return env.RENDEZVOUS.getByName(publication.serverId).fetch(
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

async function enforceAuthenticatedUpdateBudget(
  env: CoreEnv,
  serverId: string,
  dailyLimit: number,
  now: number,
): Promise<void> {
  await enforceNativeBurst(
    env.PUBLISH_IDENTITY_RATE_LIMITER,
    serverId,
    "compat-update-server",
  );
  await consumeFixedWindowBudget(env.DB, {
    actorKey: serverId,
    scope: "compat-update-server",
    limit: dailyLimit,
    now,
    window: utcDayWindow(now),
  });
}

async function enforceAuthenticatedPublishBudget(
  env: CoreEnv,
  serverId: string,
  dailyLimit: number,
  now: number,
): Promise<void> {
  await enforceNativeBurst(
    env.PUBLISH_IDENTITY_RATE_LIMITER,
    serverId,
    "publish-server",
  );
  await consumeFixedWindowBudget(env.DB, {
    actorKey: serverId,
    scope: "publish-server",
    limit: dailyLimit,
    now,
    window: utcDayWindow(now),
  });
}

async function readUpdateForm(
  request: Request,
  maximum: number,
): Promise<FormData> {
  const rawLength = request.headers.get("Content-Length");
  if (rawLength !== null &&
      (!/^\d+$/.test(rawLength) || Number(rawLength) > maximum)) {
    throw new RequestError("Update request is too large", 413);
  }

  if (request.body === null) {
    throw new RequestError("Missing update body");
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > maximum) {
      try {
        await reader.cancel();
      } catch {
        // Cancellation is best-effort; it must not replace the stable 413.
      }
      throw new RequestError("Update request is too large", 413);
    }
    chunks.push(value);
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return await new Request(request.url, {
      method: "POST",
      headers: request.headers,
      body,
    }).formData();
  } catch {
    throw new RequestError("Malformed update body");
  }
}

async function enforceBlacklist(
  env: CoreEnv,
  serverId: string,
  sourceIp: string,
): Promise<void> {
  const match = await env.DB.prepare(
    `SELECT CASE
              WHEN ?1 GLOB pattern THEN 'server_identity'
              ELSE 'request_source'
            END AS dimension
       FROM server_blacklist
      WHERE ?1 GLOB pattern OR ?2 GLOB pattern
      LIMIT 1`,
  )
    .bind(serverId, sourceIp)
    .first<{ dimension: string }>();

  if (match !== null) {
    const dimension = match.dimension;
    if (
      dimension !== "server_identity" &&
      dimension !== "request_source"
    ) {
      throw new Error("Blacklist query returned an invalid dimension");
    }
    logBlacklistMatch("compat-update", dimension);
    throw new RequestError("The server is blacklisted", 403);
  }
}

async function enforceServerIdentityBlacklist(
  env: CoreEnv,
  serverId: string,
): Promise<void> {
  const matched = await env.DB.prepare(
    `SELECT 1 AS matched
       FROM server_blacklist
      WHERE ? GLOB pattern
      LIMIT 1`,
  ).bind(serverId).first<number>("matched");
  if (matched !== null) {
    logBlacklistMatch("publish-classic", "server_identity");
    throw new RequestError("The server is blacklisted", 403);
  }
}

async function authenticateExistingOwner(
  payload: UpdatePayload,
  owner: OwnerAuthRecord,
): Promise<void> {
  if (owner.authentication_kind !== "compat-key-v1") {
    throw new RequestError("Invalid metaserver key", 401);
  }
  const expected = await deriveUpdateProof(
    payload.otp,
    owner.auth_key,
    payload.cotp,
  );
  if (!await constantTimeEqual(expected, payload.key)) {
    throw new RequestError("Invalid metaserver key", 401);
  }
}

async function authenticateCompatibilityRegistration(
  payload: UpdatePayload,
  owner: OwnerAuthRecord,
): Promise<void> {
  if (owner.authentication_kind !== "compat-key-v1") {
    throw new RequestError("Invalid metaserver key", 401);
  }
  const expected = await deriveStoredKey(payload.key, payload.serverId);
  if (!await constantTimeEqual(expected, owner.auth_key)) {
    throw new RequestError("Invalid metaserver key", 401);
  }
}

async function consumeOtp(
  env: CoreEnv,
  token: string,
  privacy: RequestPrivacyContext,
  now: number,
): Promise<void> {
  const tokenHash = await sha256Hex(token);
  const sourceTags = actorAliases(
    await privacy.tags(SourceTagPurpose.CompatOtp),
  );
  const tagged = await env.DB.prepare(
    `DELETE FROM one_time_tokens
      WHERE token_hash = ?1
        AND (
          source_tag IN (?2, ?3) OR
          source_tag_previous IN (?2, ?3)
        )
        AND expires_at > ?4
      RETURNING token_hash`,
  )
    .bind(tokenHash, sourceTags[0], sourceTags[1] ?? sourceTags[0], now)
    .first<string>("token_hash");
  if (tagged !== null) {
    return;
  }

  const legacy = await env.DB.prepare(
    `SELECT source_ip
      FROM one_time_tokens
      WHERE token_hash = ?
        AND source_tag IS NULL
        AND source_tag_previous IS NULL
        AND expires_at > ?`,
  )
    .bind(tokenHash, now)
    .first<string>("source_ip");
  if (legacy === null || !privacy.matchesLegacySourceAddress(legacy)) {
    throw new RequestError("Invalid or expired one-time token", 401);
  }

  const consumedLegacy = await env.DB.prepare(
    `DELETE FROM one_time_tokens
      WHERE token_hash = ?
        AND source_tag IS NULL
        AND source_tag_previous IS NULL
        AND source_ip = ?
        AND expires_at > ?
      RETURNING token_hash`,
  )
    .bind(tokenHash, legacy, now)
    .first<string>("token_hash");
  if (consumedLegacy === null) {
    throw new RequestError("Invalid or expired one-time token", 401);
  }
}

function sourceAddress(request: Request): string {
  const address = request.headers.get("CF-Connecting-IP");
  if (address === null) {
    throw new RequestError("The source address is unavailable", 400);
  }
  try {
    return normalizeIpAddress(address);
  } catch {
    throw new RequestError("The source address is invalid", 400);
  }
}
