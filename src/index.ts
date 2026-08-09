import {
  enforceCircuitBreaker,
  HttpError,
  httpErrorResponse,
} from "./http";
import type { HttpRateLimitReason } from "./http";
import {
  rendezvousPolicyConfiguration,
  requestControlConfiguration,
  RequestControlConfigurationError,
} from "./config";
import type { RequestControlConfiguration } from "./config";
import {
  DIRECTORY_PROFILES,
  expireDirectoryEntries,
} from "./directory-state";
import { DirectoryBuilder } from "./directory-builder";
import { isCanonicalHostname } from "./hostname";
import {
  logBlacklistMatch,
  logRequestRejected,
  logUnexpectedError,
} from "./diagnostics";
import type { DiagnosticRoute } from "./diagnostics";
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
  readBoundedPublishBody,
} from "./publisher-auth";
import {
  consumeAliasedFixedWindowBudget,
  consumeFixedWindowBudget,
  enforceNativeBurst,
  enforceNativeBurstAliases,
  RequestBudgetExceeded,
  RequestControlUnavailable,
  utcDayWindow,
} from "./rate-limit";
import type { RequestBudgetScope } from "./rate-limit";
import { openRendezvous, RendezvousRoom } from "./rendezvous";
import {
  INTERNAL_DIRECTORY_CHANGED_HEADER,
  INTERNAL_RENDEZVOUS_PUBLISH_URL,
} from "./rendezvous-contract";
import type { InternalRendezvousPublication } from "./rendezvous-contract";
import { readPublishedGeneration } from "./rendezvous-publication";
import {
  classifyCanonicalRoute,
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

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    let diagnosticRoute: DiagnosticRoute = "unclassified";
    try {
      const hostname = new URL(request.url).hostname.toLowerCase();
      if (hostname === PUBLISH_AUTHORITY || hostname === RENDEZVOUS_AUTHORITY) {
        const route = classifyCanonicalRoute(routeInputFromRequest(request));
        diagnosticRoute = canonicalRouteDiagnosticName(route);
        if (route.kind !== "publish" || route.generation !== "classic") {
          throw new HttpError("service_disabled", {
            retryAfterSeconds: 300,
          });
        }
        const control = requestControlConfiguration(env);
        enforceCircuitBreaker(
          env.PUBLISH_ENABLED,
          control.routeDisabledRetrySeconds,
        );
        const privacy = createRequestPrivacyContext(request, {
          keys: await requiredSourceTagKeyRing(env),
          namespace: PUBLISH_AUTHORITY,
        });
        await enforceNativeBurstAliases(
          env.GLOBAL_RATE_LIMITER,
          actorAliases(await privacy.tags(SourceTagPurpose.GlobalIngress)),
          "global",
        );
        return await publishClassicServer(
          request,
          env,
          route,
          control,
          Math.floor(Date.now() / 1_000),
          ctx,
        );
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
    env: Env,
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
} satisfies ExportedHandler<Env>;

function canonicalRouteDiagnosticName(
  route: CanonicalDynamicRoute,
): DiagnosticRoute {
  if (route.kind === "publish") {
    return route.generation === "classic" ? "publish-classic" : "publish-game";
  }
  return "unclassified";
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
  env: Env,
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
  env: Env,
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

async function openCompatibilityRendezvous(
  request: Request,
  env: Env,
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
  env: Env,
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
  env: Env,
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
  env: Env,
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
  env: Env,
  route: Extract<CanonicalDynamicRoute, { kind: "publish" }>,
  control: RequestControlConfiguration,
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

  await enforceBlacklist(env, route.serverId, sourceAddress(request));
  await enforceAuthenticatedPublishBudget(
    env,
    route.serverId,
    control.publishServerDaily,
    now,
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

async function commitRendezvousPublication(
  env: Env,
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
  env: Env,
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
    !/^[1-9][0-9]{0,19}$/.test(error.minimumNextSequence)
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
  env: Env,
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
  env: Env,
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
  env: Env,
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
    logBlacklistMatch(dimension);
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
  env: Env,
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

function handleRequestError(
  error: unknown,
  route: DiagnosticRoute,
): Response {
  if (error instanceof RequestBudgetExceeded) {
    const reason = rateLimitReason(error);
    const httpError = new HttpError("rate_limited", {
      rateLimitReason: reason,
      retryAfterSeconds: error.retryAfterSeconds,
    });
    return httpErrorResponse(httpError);
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
      "fetch",
      "request_control_dependency",
      error.dependency,
    );
    return httpErrorResponse(new HttpError("request_control_unavailable", {
      retryAfterSeconds: 60,
    }));
  }

  if (error instanceof RequestControlConfigurationError) {
    logUnexpectedError("fetch", "request_control_configuration");
    return httpErrorResponse(new HttpError("request_control_unavailable", {
      retryAfterSeconds: 60,
    }));
  }

  if (error instanceof SourceTagConfigurationError) {
    logUnexpectedError("fetch", "source_tag_configuration");
    return httpErrorResponse(new HttpError("request_control_unavailable", {
      retryAfterSeconds: 60,
    }));
  }

  if (error instanceof RequestError) {
    const httpError = requestErrorToHttpError(error);
    logRequestRejected(route, httpError.code, httpError.status);
    return httpErrorResponse(httpError);
  }

  logUnexpectedError("fetch", "unhandled_exception");
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
      return burst ? "publish_burst" : "publish_daily";
    case "rendezvous-client-source":
      return burst
        ? "rendezvous_client_burst"
        : "rendezvous_client_source_daily";
    case "rendezvous-client-source-server":
      return "rendezvous_client_pair_daily";
    case "rendezvous-server-source":
      return "rendezvous_server_source_daily";
    case "rendezvous-server":
      return burst
        ? "rendezvous_server_burst"
        : "rendezvous_server_daily";
  }
}
