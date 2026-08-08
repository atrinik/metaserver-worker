import {
  enforceCircuitBreaker,
  HttpError,
  httpErrorResponse,
} from "./http";
import type { HttpRateLimitReason } from "./http";
import {
  requestControlConfiguration,
  RequestControlConfigurationError,
} from "./config";
import type { RequestControlConfiguration } from "./config";
import {
  logBlacklistMatch,
  logRequestRejected,
  logUnexpectedError,
} from "./diagnostics";
import type { DiagnosticRoute } from "./diagnostics";
import { cleanupExpiredState } from "./maintenance";
import {
  createRequestPrivacyContext,
  parseSourceTagKeyRing,
  SourceTagPurpose,
  SourceTagConfigurationError,
} from "./privacy";
import type {
  RequestPrivacyContext,
  SourceTagKeyConfiguration,
  SourceTagKeyRing,
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
  classifyCompatibilityRoute,
  routeInputFromRequest,
} from "./routes";
import type { CompatibilityRoute } from "./routes";
import type {
  DirectoryServerRecord,
  OwnerAuthRecord,
  UpdatePayload,
} from "./types";

export { RendezvousRoom };

interface CachedSourceTagKeyRing extends SourceTagKeyConfiguration {
  readonly ring: SourceTagKeyRing;
}

let cachedSourceTagKeyRing: CachedSourceTagKeyRing | undefined;

export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    let diagnosticRoute: DiagnosticRoute = "unclassified";
    try {
      const control = requestControlConfiguration(env);
      const route = classifyCompatibilityRoute(
        routeInputFromRequest(request),
        control.compatibilityHostname,
      );
      diagnosticRoute = routeDiagnosticName(route);
      enforceRouteCircuitBreaker(route, env, control);

      const privacy = createRequestPrivacyContext(request, {
        keys: await sourceTagKeyRing(env),
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
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    try {
      const now = Math.floor(Date.now() / 1_000);
      const control = requestControlConfiguration(env);
      const staleCutoff = now - control.staleDataRetentionSeconds;
      const cleanup = await cleanupExpiredState(env.DB, {
        serversBefore: staleCutoff,
        oneTimeTokensAtOrBefore: now,
        rateLimitsBefore: now - 86_400,
        requestBudgetsAtOrBefore: now,
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

async function sourceTagKeyRing(env: Env): Promise<SourceTagKeyRing> {
  if (
    typeof env.SOURCE_TAG_KEY_PREVIOUS_ID !== "string" ||
    typeof env.SOURCE_TAG_KEY_PREVIOUS !== "string"
  ) {
    throw new SourceTagConfigurationError(
      "Current and previous source-tag keys are both required",
    );
  }
  const configuration: SourceTagKeyConfiguration = {
    currentKeyId: env.SOURCE_TAG_KEY_CURRENT_ID,
    currentSecret: env.SOURCE_TAG_KEY_CURRENT,
    previousKeyId: env.SOURCE_TAG_KEY_PREVIOUS_ID,
    previousSecret: env.SOURCE_TAG_KEY_PREVIOUS,
  };
  if (
    cachedSourceTagKeyRing !== undefined &&
    sameSourceTagKeyConfiguration(cachedSourceTagKeyRing, configuration)
  ) {
    return cachedSourceTagKeyRing.ring;
  }

  const ring = await parseSourceTagKeyRing(configuration);
  cachedSourceTagKeyRing = { ...configuration, ring };
  return ring;
}

function sameSourceTagKeyConfiguration(
  left: SourceTagKeyConfiguration,
  right: SourceTagKeyConfiguration,
): boolean {
  return left.currentKeyId === right.currentKeyId &&
    left.currentSecret === right.currentSecret &&
    left.previousKeyId === right.previousKeyId &&
    left.previousSecret === right.previousSecret;
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
    `SELECT server_id, name, players_count, version, text_comment,
            quic_host, quic_port, quic_cert_sha256,
            password_required
       FROM servers
      WHERE last_seen >= ?
        AND is_public = 1
      ORDER BY name COLLATE NOCASE, server_id`,
  )
    .bind(cutoff)
    .all<DirectoryServerRecord>();

  const body = result.results.map((server) =>
    "<Server>" +
    `<Id>${escapeXml(server.server_id)}</Id>` +
    `<Name>${escapeXml(server.name)}</Name>` +
    `<PlayersCount>${server.players_count}</PlayersCount>` +
    `<Version>${escapeXml(server.version)}</Version>` +
    `<TextComment>${escapeXml(server.text_comment || "No description.")}</TextComment>` +
    `<Address>${escapeXml(server.quic_host)}</Address>` +
    `<Port>${server.quic_port}</Port>` +
    `<CertificateSha256>${server.quic_cert_sha256}</CertificateSha256>` +
    `<PasswordRequired>${server.password_required === 1 ? "true" : "false"}</PasswordRequired>` +
    "</Server>"
  ).join("");

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
): Promise<Response> {
  const payload = parseUpdatePayload(await readUpdateForm(
    request,
    maximumBodyBytes,
  ));
  const sourceIp = sourceAddress(request);
  await enforceBlacklist(env, payload.serverId, sourceIp);

  let owner = await env.DB.prepare(
    "SELECT auth_key FROM server_owners WHERE server_id = ?",
  )
    .bind(payload.serverId)
    .first<OwnerAuthRecord>();

  if (owner !== null) {
    await authenticateExistingOwner(payload, owner);
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
      "SELECT auth_key FROM server_owners WHERE server_id = ?",
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
  }

  const rendezvousToken = randomToken();
  const rendezvousTokenHash = await sha256Hex(rendezvousToken);
  const persisted = await env.DB.batch([
    env.DB.prepare(
      `UPDATE server_owners
          SET current_ip = '',
              ip_changed_at = CASE WHEN current_ip <> '' THEN ? ELSE ip_changed_at END,
              updated_at = ?
        WHERE server_id = ?`,
    ).bind(now, now, payload.serverId),
    env.DB.prepare(
      `INSERT INTO servers
         (server_id, source_ip, name, players_count, version, text_comment,
          last_seen, is_public, quic_host, quic_port, quic_cert_sha256,
          password_required, rendezvous_token_hash)
       VALUES (?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(server_id) DO UPDATE SET
         source_ip = '',
         name = excluded.name,
         players_count = excluded.players_count,
         version = excluded.version,
         text_comment = excluded.text_comment,
         last_seen = excluded.last_seen,
         is_public = excluded.is_public,
         quic_host = excluded.quic_host,
         quic_port = excluded.quic_port,
         quic_cert_sha256 = excluded.quic_cert_sha256,
         password_required = excluded.password_required,
         rendezvous_token_hash = excluded.rendezvous_token_hash`,
    ).bind(
      payload.serverId,
      payload.name,
      payload.playersCount,
      payload.version,
      payload.textComment,
      now,
      payload.isPublic ? 1 : 0,
      payload.quicHost ?? "",
      payload.quicPort,
      payload.quicCertSha256,
      payload.passwordRequired ? 1 : 0,
      rendezvousTokenHash,
    ),
  ]);
  if (
    persisted.length !== 2 ||
    persisted.some((result) => !result.success) ||
    persisted.some((result) => result.meta.changes !== 1)
  ) {
    throw new Error("Server update did not persist every required mutation");
  }

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
  const expected = await deriveUpdateProof(
    payload.otp,
    owner.auth_key,
    payload.cotp,
  );
  if (!await constantTimeEqual(expected, payload.key)) {
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
