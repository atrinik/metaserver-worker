import { RENDEZVOUS_COOLDOWN_POLICY_MAXIMUMS } from "./config";
import {
  boundedRetryAfter,
  isD1ProgrammingOrIntegrityFailure,
  RequestBudgetExceeded,
  RequestControlUnavailable,
} from "./rate-limit";

const MAXIMUM_BURST_LIMIT =
  RENDEZVOUS_COOLDOWN_POLICY_MAXIMUMS.rendezvousClientPairBurstLimit;
const MAXIMUM_WINDOW_SECONDS =
  RENDEZVOUS_COOLDOWN_POLICY_MAXIMUMS.rendezvousClientPairWindowSeconds;
const MAXIMUM_INITIAL_COOLDOWN_SECONDS =
  RENDEZVOUS_COOLDOWN_POLICY_MAXIMUMS
    .rendezvousClientPairInitialCooldownSeconds;
const MAXIMUM_COOLDOWN_SECONDS =
  RENDEZVOUS_COOLDOWN_POLICY_MAXIMUMS
    .rendezvousClientPairMaximumCooldownSeconds;
const MAXIMUM_RESET_SECONDS =
  RENDEZVOUS_COOLDOWN_POLICY_MAXIMUMS.rendezvousClientPairResetSeconds;
const MAXIMUM_NOW = Number.MAX_SAFE_INTEGER - MAXIMUM_RESET_SECONDS;
const ATTEMPT_ID = /^[0-9a-f]{32}$/;
const VERSIONED_ACTOR_KEY = /^v1\.[A-Za-z0-9_-]{1,32}\.[A-Za-z0-9_-]{43}$/;

export interface RendezvousPairCooldownRequest {
  readonly actorKeys:
    | readonly [current: string]
    | readonly [current: string, previous: string];
  readonly now: number;
  readonly burstLimit: number;
  readonly windowSeconds: number;
  readonly initialCooldownSeconds: number;
  readonly maximumCooldownSeconds: number;
  readonly resetSeconds: number;
  readonly attemptId?: string;
}

export interface RendezvousPairAdmission {
  readonly admitted: true;
  readonly count: number;
  readonly remaining: number;
  readonly windowEndsAt: number;
}

interface PairStateRow {
  readonly attempt_present: number;
  readonly recent_count: number;
  readonly row_count: number;
  readonly minimum_blocked_until: number | null;
  readonly maximum_blocked_until: number | null;
  readonly minimum_penalty_level: number | null;
  readonly maximum_penalty_level: number | null;
  readonly minimum_last_burst_at: number | null;
  readonly maximum_last_burst_at: number | null;
  readonly minimum_expires_at: number | null;
  readonly maximum_expires_at: number | null;
}

/**
 * Atomically admit one eligible canonical client attempt or apply the exact
 * source/server cooldown. The 21st request in a rolling 60-second cohort
 * starts the first cooldown; the first 20 remain admitted.
 */
export async function consumeRendezvousPairCooldown(
  database: D1Database,
  request: RendezvousPairCooldownRequest,
): Promise<RendezvousPairAdmission> {
  const actorKeys = normalizeAliases(request.actorKeys);
  requireInteger(request.now, "now", 0, MAXIMUM_NOW);
  requireInteger(
    request.burstLimit,
    "burstLimit",
    1,
    MAXIMUM_BURST_LIMIT,
  );
  requireInteger(
    request.windowSeconds,
    "windowSeconds",
    1,
    MAXIMUM_WINDOW_SECONDS,
  );
  requireInteger(
    request.initialCooldownSeconds,
    "initialCooldownSeconds",
    1,
    MAXIMUM_INITIAL_COOLDOWN_SECONDS,
  );
  requireInteger(
    request.maximumCooldownSeconds,
    "maximumCooldownSeconds",
    request.initialCooldownSeconds,
    MAXIMUM_COOLDOWN_SECONDS,
  );
  requireInteger(
    request.resetSeconds,
    "resetSeconds",
    request.maximumCooldownSeconds,
    MAXIMUM_RESET_SECONDS,
  );
  const attemptId = request.attemptId ?? crypto.randomUUID().replaceAll("-", "");
  if (!ATTEMPT_ID.test(attemptId)) {
    throw new TypeError("attemptId must be 32 lowercase hexadecimal characters");
  }
  const previous = actorKeys[1] ?? null;
  const maximumPenaltyLevel = Math.ceil(Math.log2(
    request.maximumCooldownSeconds / request.initialCooldownSeconds,
  ));
  const windowStartsAfter = request.now - request.windowSeconds;
  const attemptExpiresAt = request.now + request.windowSeconds;

  let results: D1Result[];
  try {
    results = await database.batch([
      database.prepare(
        `WITH aliases(actor_key) AS (
           SELECT ?1 UNION SELECT ?2 WHERE ?2 IS NOT NULL
         ), active AS (
           SELECT 1
             FROM rendezvous_pair_cooldowns AS c
             JOIN aliases AS a ON a.actor_key = c.actor_key
            WHERE c.blocked_until > ?3
            LIMIT 1
         ), recent AS (
           SELECT COUNT(DISTINCT p.attempt_id) AS attempt_count
             FROM rendezvous_pair_attempts AS p
             JOIN aliases AS a ON a.actor_key = p.actor_key
            WHERE p.attempted_at > ?4
              AND p.expires_at > ?3
         )
         INSERT INTO rendezvous_pair_attempts
           (actor_key, attempt_id, attempted_at, expires_at)
         SELECT a.actor_key, ?5, ?3, ?6
           FROM aliases AS a
           CROSS JOIN recent
          WHERE NOT EXISTS (SELECT 1 FROM active)
            AND recent.attempt_count < ?7
         ON CONFLICT(actor_key, attempt_id) DO NOTHING`,
      ).bind(
        actorKeys[0],
        previous,
        request.now,
        windowStartsAfter,
        attemptId,
        attemptExpiresAt,
        request.burstLimit,
      ),
      database.prepare(
        `WITH aliases(actor_key) AS (
           SELECT ?1 UNION SELECT ?2 WHERE ?2 IS NOT NULL
         ), prior AS (
           SELECT c.blocked_until, c.penalty_level, c.last_burst_at,
                  c.expires_at
             FROM rendezvous_pair_cooldowns AS c
             JOIN aliases AS a ON a.actor_key = c.actor_key
            ORDER BY c.blocked_until DESC, c.last_burst_at DESC,
                     c.penalty_level DESC
            LIMIT 1
         ), recent AS (
           SELECT COUNT(DISTINCT p.attempt_id) AS attempt_count
             FROM rendezvous_pair_attempts AS p
             JOIN aliases AS a ON a.actor_key = p.actor_key
            WHERE p.attempted_at > ?4
              AND p.expires_at > ?3
         ), admitted AS (
           SELECT 1
             FROM rendezvous_pair_attempts AS p
             JOIN aliases AS a ON a.actor_key = p.actor_key
            WHERE p.attempt_id = ?5
            LIMIT 1
         ), desired(blocked_until, penalty_level, last_burst_at, expires_at) AS (
           SELECT blocked_until, penalty_level, last_burst_at, expires_at
             FROM prior
            WHERE blocked_until > ?3
           UNION ALL
           SELECT ?3 + MIN(?8 * (1 << CASE
                    WHEN prior.last_burst_at IS NULL OR
                         ?3 - prior.last_burst_at >= ?9 THEN 0
                    ELSE MIN(prior.penalty_level + 1, ?10)
                  END), ?11),
                  CASE
                    WHEN prior.last_burst_at IS NULL OR
                         ?3 - prior.last_burst_at >= ?9 THEN 0
                    ELSE MIN(prior.penalty_level + 1, ?10)
                  END,
                  ?3,
                  ?3 + ?9
             FROM recent
             LEFT JOIN prior ON 1
            WHERE NOT EXISTS (
                    SELECT 1 FROM prior WHERE blocked_until > ?3
                  )
              AND NOT EXISTS (SELECT 1 FROM admitted)
              AND recent.attempt_count >= ?7
         )
         INSERT INTO rendezvous_pair_cooldowns
           (actor_key, blocked_until, penalty_level, last_burst_at, expires_at)
         SELECT a.actor_key, d.blocked_until, d.penalty_level,
                d.last_burst_at, d.expires_at
           FROM aliases AS a CROSS JOIN desired AS d
          WHERE 1
         ON CONFLICT(actor_key) DO UPDATE SET
           blocked_until = excluded.blocked_until,
           penalty_level = excluded.penalty_level,
           last_burst_at = excluded.last_burst_at,
           expires_at = excluded.expires_at
         WHERE rendezvous_pair_cooldowns.blocked_until <> excluded.blocked_until
            OR rendezvous_pair_cooldowns.penalty_level <> excluded.penalty_level
            OR rendezvous_pair_cooldowns.last_burst_at <> excluded.last_burst_at
            OR rendezvous_pair_cooldowns.expires_at <> excluded.expires_at`,
      ).bind(
        actorKeys[0],
        previous,
        request.now,
        windowStartsAfter,
        attemptId,
        attemptExpiresAt,
        request.burstLimit,
        request.initialCooldownSeconds,
        request.resetSeconds,
        maximumPenaltyLevel,
        request.maximumCooldownSeconds,
      ),
      database.prepare(
        `WITH aliases(actor_key) AS (
           SELECT ?1 UNION SELECT ?2 WHERE ?2 IS NOT NULL
         )
         DELETE FROM rendezvous_pair_attempts
          WHERE actor_key IN (SELECT actor_key FROM aliases)
            AND EXISTS (
              SELECT 1
                FROM rendezvous_pair_cooldowns AS c
                JOIN aliases AS a ON a.actor_key = c.actor_key
               WHERE c.blocked_until > ?3
            )`,
      ).bind(actorKeys[0], previous, request.now),
      database.prepare(
        `WITH aliases(actor_key) AS (
           SELECT ?1 UNION SELECT ?2 WHERE ?2 IS NOT NULL
         ), attempts AS (
           SELECT COUNT(DISTINCT CASE WHEN p.attempt_id = ?4
                                      THEN p.actor_key END) AS attempt_present,
                  COUNT(DISTINCT CASE WHEN p.attempted_at > ?5 AND
                                           p.expires_at > ?3
                                      THEN p.attempt_id END) AS recent_count
             FROM rendezvous_pair_attempts AS p
             JOIN aliases AS a ON a.actor_key = p.actor_key
         ), cooldown AS (
           SELECT COUNT(c.actor_key) AS row_count,
                  MIN(c.blocked_until) AS minimum_blocked_until,
                  MAX(c.blocked_until) AS maximum_blocked_until,
                  MIN(c.penalty_level) AS minimum_penalty_level,
                  MAX(c.penalty_level) AS maximum_penalty_level,
                  MIN(c.last_burst_at) AS minimum_last_burst_at,
                  MAX(c.last_burst_at) AS maximum_last_burst_at,
                  MIN(c.expires_at) AS minimum_expires_at,
                  MAX(c.expires_at) AS maximum_expires_at
             FROM rendezvous_pair_cooldowns AS c
             JOIN aliases AS a ON a.actor_key = c.actor_key
         )
         SELECT attempts.*, cooldown.* FROM attempts CROSS JOIN cooldown`,
      ).bind(
        actorKeys[0],
        previous,
        request.now,
        attemptId,
        windowStartsAfter,
      ),
    ]);
  } catch (error) {
    if (isD1ProgrammingOrIntegrityFailure(error)) {
      throw error;
    }
    throw new RequestControlUnavailable("d1", error);
  }

  const final = results[3]?.results?.[0] as PairStateRow | undefined;
  if (results.length !== 4 || final === undefined) {
    throw new Error("Rendezvous cooldown transaction returned no state");
  }
  validateState(final, actorKeys.length, request.maximumCooldownSeconds);

  if (
    final.maximum_blocked_until !== null &&
    final.maximum_blocked_until > request.now
  ) {
    if (final.row_count !== actorKeys.length ||
      final.minimum_blocked_until !== final.maximum_blocked_until ||
      final.minimum_penalty_level !== final.maximum_penalty_level ||
      final.minimum_last_burst_at !== final.maximum_last_burst_at ||
      final.minimum_expires_at !== final.maximum_expires_at) {
      throw new Error("Rendezvous cooldown aliases are divergent");
    }
    throw new RequestBudgetExceeded({
      scope: "rendezvous-client-pair-cooldown",
      reason: "cooldown_active",
      retryAfterSeconds: boundedRetryAfter(
        final.maximum_blocked_until,
        request.now,
      ),
      resetAt: final.maximum_blocked_until,
      limit: request.burstLimit,
    });
  }

  if (final.attempt_present !== actorKeys.length) {
    throw new Error("Rendezvous cooldown admission produced a partial alias set");
  }
  if (results[0]?.meta.changes !== actorKeys.length) {
    throw new Error("Rendezvous cooldown attempt ID was not newly inserted");
  }
  return Object.freeze({
    admitted: true,
    count: final.recent_count,
    remaining: request.burstLimit - final.recent_count,
    windowEndsAt: attemptExpiresAt,
  });
}

function normalizeAliases(
  actorKeys: RendezvousPairCooldownRequest["actorKeys"],
): readonly [string] | readonly [string, string] {
  if (actorKeys.length < 1 || actorKeys.length > 2) {
    throw new TypeError("actorKeys must contain one or two aliases");
  }
  const unique = [...new Set(actorKeys)];
  if (unique.some((actorKey) => !VERSIONED_ACTOR_KEY.test(actorKey))) {
    throw new TypeError("actorKeys must be opaque versioned tags");
  }
  const current = unique[0];
  if (current === undefined) {
    throw new TypeError("actorKeys must not be empty");
  }
  const previous = unique[1];
  return previous === undefined ? [current] : [current, previous];
}

function validateState(
  state: PairStateRow,
  aliasCount: number,
  maximumCooldownSeconds: number,
): void {
  for (const [name, value] of Object.entries(state)) {
    if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error(`Rendezvous cooldown returned invalid ${name}`);
    }
  }
  if (
    state.attempt_present > aliasCount ||
    state.recent_count > MAXIMUM_BURST_LIMIT ||
    state.row_count > aliasCount ||
    (state.minimum_blocked_until === null) !==
      (state.maximum_blocked_until === null) ||
    (state.minimum_penalty_level === null) !==
      (state.maximum_penalty_level === null) ||
    (state.minimum_last_burst_at === null) !==
      (state.maximum_last_burst_at === null) ||
    (state.minimum_expires_at === null) !== (state.maximum_expires_at === null)
  ) {
    throw new Error("Rendezvous cooldown returned invalid state");
  }
  if (
    state.minimum_blocked_until !== null &&
    state.minimum_last_burst_at !== null &&
    state.maximum_blocked_until !== null &&
    state.maximum_blocked_until - state.minimum_last_burst_at >
      maximumCooldownSeconds
  ) {
    throw new Error("Rendezvous cooldown exceeded the configured maximum");
  }
}

function requireInteger(
  value: number,
  name: string,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
}
