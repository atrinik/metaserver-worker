const DEFAULT_BATCH_SIZE = 1_000;
const DEFAULT_MAXIMUM_BATCHES = 8;
const MAXIMUM_BATCH_SIZE = 1_000;
const MAXIMUM_BATCHES = 8;

export const MAINTENANCE_TARGETS = [
  "servers",
  "one_time_tokens",
  "rate_limits",
  "request_budgets",
  "publisher_nonces",
] as const;

export type MaintenanceTarget = typeof MAINTENANCE_TARGETS[number];

export interface MaintenanceCutoffs {
  readonly serversBefore: number;
  readonly oneTimeTokensAtOrBefore: number;
  readonly rateLimitsBefore: number;
  readonly requestBudgetsAtOrBefore: number;
  readonly publisherNoncesAtOrBefore: number;
}

export interface MaintenanceOptions {
  readonly batchSize?: number;
  readonly maximumBatches?: number;
}

export interface MaintenanceTargetResult {
  readonly deletedRows: number;
  readonly executedBatches: number;
  readonly hasMore: boolean;
}

export interface MaintenanceResult {
  readonly targets: Readonly<Record<MaintenanceTarget, MaintenanceTargetResult>>;
  readonly backloggedTargets: readonly MaintenanceTarget[];
}

interface MutableTargetState {
  deletedRows: number;
  executedBatches: number;
  active: boolean;
  hasMore: boolean;
}

interface MaintenanceStatement {
  readonly target: MaintenanceTarget;
  readonly cutoff: number;
  readonly deleteSql: string;
  readonly probeSql: string;
}

/**
 * Delete every expirable state class in bounded, round-robin batches.
 *
 * At production bounds this performs at most 40 deletes and five probes.
 * Round-robin ordering keeps a backlog in one legacy table from starving
 * cleanup of newer state.
 */
export async function cleanupExpiredState(
  database: D1Database,
  cutoffs: MaintenanceCutoffs,
  options: MaintenanceOptions = {},
): Promise<MaintenanceResult> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const maximumBatches = options.maximumBatches ?? DEFAULT_MAXIMUM_BATCHES;
  requireInteger(batchSize, "batchSize", 1, MAXIMUM_BATCH_SIZE);
  requireInteger(
    maximumBatches,
    "maximumBatches",
    1,
    MAXIMUM_BATCHES,
  );

  const statements = maintenanceStatements(cutoffs);
  const states = new Map<MaintenanceTarget, MutableTargetState>(
    MAINTENANCE_TARGETS.map((target) => [target, {
      deletedRows: 0,
      executedBatches: 0,
      active: true,
      hasMore: false,
    }]),
  );

  for (let batchIndex = 0; batchIndex < maximumBatches; batchIndex += 1) {
    const activeStatements = statements.filter((statement) =>
      requireState(states, statement.target).active
    );
    if (activeStatements.length === 0) {
      break;
    }
    const results = await database.batch(activeStatements.map((statement) =>
      database.prepare(statement.deleteSql)
        .bind(statement.cutoff, batchSize)
    ));
    if (results.length !== activeStatements.length) {
      throw new Error("Maintenance batch returned an invalid result count");
    }
    for (const [index, statement] of activeStatements.entries()) {
      const state = requireState(states, statement.target);
      const result = results[index];
      if (result === undefined) {
        throw new Error("Maintenance batch omitted a result");
      }
      if (!result.success) {
        throw new Error("Maintenance delete reported failure");
      }
      const changes = result.meta.changes;
      if (!Number.isSafeInteger(changes) || changes < 0 || changes > batchSize) {
        throw new Error("Maintenance delete returned an invalid row count");
      }
      state.deletedRows += changes;
      state.executedBatches += 1;
      if (changes < batchSize) {
        state.active = false;
      }
    }
  }

  for (const statement of statements) {
    const state = requireState(states, statement.target);
    if (!state.active) {
      continue;
    }
    state.hasMore = await database.prepare(statement.probeSql)
      .bind(statement.cutoff)
      .first<number>("present") !== null;
  }

  const targets = Object.fromEntries(MAINTENANCE_TARGETS.map((target) => {
    const state = requireState(states, target);
    return [target, Object.freeze({
      deletedRows: state.deletedRows,
      executedBatches: state.executedBatches,
      hasMore: state.hasMore,
    })];
  })) as Record<MaintenanceTarget, MaintenanceTargetResult>;
  const backloggedTargets = MAINTENANCE_TARGETS.filter(
    (target) => targets[target].hasMore,
  );
  return Object.freeze({
    targets: Object.freeze(targets),
    backloggedTargets: Object.freeze(backloggedTargets),
  });
}

function maintenanceStatements(
  cutoffs: MaintenanceCutoffs,
): readonly MaintenanceStatement[] {
  for (const [name, value] of Object.entries(cutoffs)) {
    requireInteger(value, name, 0, Number.MAX_SAFE_INTEGER);
  }
  return [
    {
      target: "servers",
      cutoff: cutoffs.serversBefore,
      deleteSql: `DELETE FROM servers
        WHERE server_id IN (
          SELECT server_id FROM servers
           WHERE last_seen < ?1
           ORDER BY last_seen
           LIMIT ?2
        )`,
      probeSql: "SELECT 1 AS present FROM servers WHERE last_seen < ? LIMIT 1",
    },
    {
      target: "one_time_tokens",
      cutoff: cutoffs.oneTimeTokensAtOrBefore,
      deleteSql: `DELETE FROM one_time_tokens
        WHERE token_hash IN (
          SELECT token_hash FROM one_time_tokens
           WHERE expires_at <= ?1
           ORDER BY expires_at
           LIMIT ?2
        )`,
      probeSql:
        "SELECT 1 AS present FROM one_time_tokens WHERE expires_at <= ? LIMIT 1",
    },
    {
      target: "rate_limits",
      cutoff: cutoffs.rateLimitsBefore,
      deleteSql: `DELETE FROM rate_limits
        WHERE (source_ip, scope) IN (
          SELECT source_ip, scope FROM rate_limits
           WHERE window_start < ?1
           ORDER BY window_start
           LIMIT ?2
        )`,
      probeSql:
        "SELECT 1 AS present FROM rate_limits WHERE window_start < ? LIMIT 1",
    },
    {
      target: "request_budgets",
      cutoff: cutoffs.requestBudgetsAtOrBefore,
      deleteSql: `DELETE FROM request_budgets
        WHERE (actor_key, scope, window_start) IN (
          SELECT actor_key, scope, window_start FROM request_budgets
           WHERE expires_at <= ?1
           ORDER BY expires_at
           LIMIT ?2
        )`,
      probeSql:
        "SELECT 1 AS present FROM request_budgets WHERE expires_at <= ? LIMIT 1",
    },
    {
      target: "publisher_nonces",
      cutoff: cutoffs.publisherNoncesAtOrBefore,
      deleteSql: `DELETE FROM publisher_nonces
        WHERE (server_id, profile, nonce) IN (
          SELECT server_id, profile, nonce FROM publisher_nonces
           WHERE expires_at <= ?1
           ORDER BY expires_at
           LIMIT ?2
        )`,
      probeSql:
        "SELECT 1 AS present FROM publisher_nonces WHERE expires_at <= ? LIMIT 1",
    },
  ];
}

function requireState(
  states: ReadonlyMap<MaintenanceTarget, MutableTargetState>,
  target: MaintenanceTarget,
): MutableTargetState {
  const state = states.get(target);
  if (state === undefined) {
    throw new Error("Maintenance target has no state");
  }
  return state;
}

function requireInteger(
  value: number,
  name: string,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${name} must be an integer from ${minimum} to ${maximum}`,
    );
  }
}
