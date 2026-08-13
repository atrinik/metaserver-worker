import type { RendezvousReplayTags } from "./privacy";
import {
  MAX_RENDEZVOUS_REPLAY_ADMISSIONS,
  RENDEZVOUS_ROLLING_WINDOW_MS,
} from "./rendezvous-contract";

const CURRENT_SCHEMA_VERSION = 1;
const REPLAY_PRUNE_BATCH_SIZE = 256;
const MAX_ACCEPTED_AT_MS =
  Number.MAX_SAFE_INTEGER - RENDEZVOUS_ROLLING_WINDOW_MS;
const REPLAY_TAG_PATTERN =
  /^v1\.([A-Za-z0-9_-]{1,32})\.[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

const CREATE_MIGRATION_TABLE_SQL =
  `CREATE TABLE IF NOT EXISTS _rendezvous_schema_migrations (
     version INTEGER PRIMARY KEY CHECK (
       typeof(version) = 'integer' AND version >= 1
     )
   )`;

const CREATE_ADMISSIONS_V1_SQL =
  `CREATE TABLE rendezvous_admissions (
     id INTEGER PRIMARY KEY CHECK (id >= 1),
     accepted_at_ms INTEGER NOT NULL CHECK (
       typeof(accepted_at_ms) = 'integer' AND
       accepted_at_ms BETWEEN 0 AND 9007199168340991
     ),
     ticket_replay_tag_current TEXT CHECK (
       ticket_replay_tag_current IS NULL OR (
         length(ticket_replay_tag_current) BETWEEN 48 AND 79 AND
         substr(ticket_replay_tag_current, 1, 3) = 'v1.' AND
         instr(substr(ticket_replay_tag_current, 4), '.') BETWEEN 2 AND 33 AND
         substr(
           ticket_replay_tag_current,
           4,
           instr(substr(ticket_replay_tag_current, 4), '.') - 1
         ) NOT GLOB '*[^A-Za-z0-9_-]*' AND
         length(substr(
           ticket_replay_tag_current,
           4 + instr(substr(ticket_replay_tag_current, 4), '.')
         )) = 43 AND
         substr(
           ticket_replay_tag_current,
           4 + instr(substr(ticket_replay_tag_current, 4), '.')
         ) NOT GLOB '*[^A-Za-z0-9_-]*' AND
         substr(ticket_replay_tag_current, -1) GLOB '[AEIMQUYcgkosw048]'
       )
     ),
     ticket_replay_tag_previous TEXT CHECK (
       ticket_replay_tag_previous IS NULL OR (
         length(ticket_replay_tag_previous) BETWEEN 48 AND 79 AND
         substr(ticket_replay_tag_previous, 1, 3) = 'v1.' AND
         instr(substr(ticket_replay_tag_previous, 4), '.') BETWEEN 2 AND 33 AND
         substr(
           ticket_replay_tag_previous,
           4,
           instr(substr(ticket_replay_tag_previous, 4), '.') - 1
         ) NOT GLOB '*[^A-Za-z0-9_-]*' AND
         length(substr(
           ticket_replay_tag_previous,
           4 + instr(substr(ticket_replay_tag_previous, 4), '.')
         )) = 43 AND
         substr(
           ticket_replay_tag_previous,
           4 + instr(substr(ticket_replay_tag_previous, 4), '.')
         ) NOT GLOB '*[^A-Za-z0-9_-]*' AND
         substr(ticket_replay_tag_previous, -1) GLOB '[AEIMQUYcgkosw048]'
       )
     ),
     CHECK (
       (
         ticket_replay_tag_current IS NULL AND
         ticket_replay_tag_previous IS NULL
       ) OR (
         ticket_replay_tag_current IS NOT NULL AND
         ticket_replay_tag_previous IS NOT NULL AND
         ticket_replay_tag_current <> ticket_replay_tag_previous AND
         substr(
           ticket_replay_tag_current,
           4,
           instr(substr(ticket_replay_tag_current, 4), '.') - 1
         ) <> substr(
           ticket_replay_tag_previous,
           4,
           instr(substr(ticket_replay_tag_previous, 4), '.') - 1
         )
       )
     )
   )`;

interface SchemaMigration {
  readonly version: number;
  apply(sql: SqlStorage): void;
}

const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = Object.freeze([
  {
    version: 1,
    apply(sql: SqlStorage): void {
      sql.exec(CREATE_ADMISSIONS_V1_SQL);
      sql.exec(
        `CREATE INDEX rendezvous_admissions_accepted_at
           ON rendezvous_admissions (accepted_at_ms, id)`,
      );
      sql.exec(
        `CREATE UNIQUE INDEX rendezvous_admissions_replay_current
           ON rendezvous_admissions (ticket_replay_tag_current)
           WHERE ticket_replay_tag_current IS NOT NULL`,
      );
      sql.exec(
        `CREATE UNIQUE INDEX rendezvous_admissions_replay_previous
           ON rendezvous_admissions (ticket_replay_tag_previous)
           WHERE ticket_replay_tag_previous IS NOT NULL`,
      );
    },
  },
]);

type AdmissionStorage = Pick<
  DurableObjectStorage,
  "sql" | "transactionSync"
>;

type AdmissionRow = {
  readonly id: number;
  readonly accepted_at_ms: number;
  readonly ticket_replay_tag_current: string | null;
  readonly ticket_replay_tag_previous: string | null;
};

export type RendezvousAdmissionConsumeResult =
  | {
      readonly accepted: true;
      readonly admissionId: number;
    }
  | {
      readonly accepted: false;
      readonly reason: "maintenance_backlog" | "storage_capacity";
    };

export type RendezvousAdmissionClaimResult =
  | { readonly claimed: true }
  | {
      readonly claimed: false;
      readonly reason: "missing" | "already_claimed" | "replay";
    };

export class RendezvousAdmissionStoreError extends Error {
  constructor(readonly code: "unsupported_schema" | "corrupt_schema") {
    super(
      code === "unsupported_schema"
        ? "Unsupported rendezvous admission schema"
        : "Corrupt rendezvous admission schema",
    );
    this.name = "RendezvousAdmissionStoreError";
  }
}

/**
 * Synchronous, per-room admission and replay state. Call initialize() inside
 * the room's blockConcurrencyWhile() initialization callback.
 */
export class RendezvousAdmissionStore {
  constructor(
    private readonly storage: AdmissionStorage,
    private readonly maximumRetained = MAX_RENDEZVOUS_REPLAY_ADMISSIONS,
  ) {
    if (
      !Number.isSafeInteger(maximumRetained) ||
      maximumRetained < 1 ||
      maximumRetained > MAX_RENDEZVOUS_REPLAY_ADMISSIONS
    ) {
      throw new RangeError("Invalid rendezvous replay storage ceiling");
    }
  }

  initialize(): void {
    this.storage.transactionSync(() => {
      const sql = this.storage.sql;
      assertMigrationDefinitions();
      sql.exec(CREATE_MIGRATION_TABLE_SQL);

      const versions = sql.exec<{ version: number }>(
        "SELECT version FROM _rendezvous_schema_migrations ORDER BY version",
      ).toArray();
      assertMigrationHistory(versions);

      for (
        let index = versions.length;
        index < SCHEMA_MIGRATIONS.length;
        index += 1
      ) {
        const migration = SCHEMA_MIGRATIONS[index];
        if (migration === undefined) {
          throw corruptSchema();
        }
        migration.apply(sql);
        sql.exec(
          "INSERT INTO _rendezvous_schema_migrations (version) VALUES (?)",
          migration.version,
        );
      }

      assertStoredRows(sql);
    });
  }

  consume(nowMs: number): RendezvousAdmissionConsumeResult {
    assertNow(nowMs);

    return this.storage.transactionSync(() => {
      const sql = this.storage.sql;
      const prune = pruneBefore(
        sql,
        nowMs - RENDEZVOUS_ROLLING_WINDOW_MS,
      );
      if (prune.backlog) {
        return { accepted: false, reason: "maintenance_backlog" };
      }

      const { count } = sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM rendezvous_admissions",
      ).one();
      assertRetainedCount(count);

      if (count >= this.maximumRetained) {
        return { accepted: false, reason: "storage_capacity" };
      }

      const inserted = sql.exec<{ id: number }>(
        `INSERT INTO rendezvous_admissions (accepted_at_ms)
         VALUES (?) RETURNING id`,
        nowMs,
      ).toArray();
      const row = inserted[0];
      if (
        inserted.length !== 1 ||
        row === undefined ||
        !isAdmissionId(row.id)
      ) {
        throw corruptSchema();
      }
      return { accepted: true, admissionId: row.id };
    });
  }

  /** Release only a reservation that has not acquired replay tags. */
  release(admissionId: number): boolean {
    assertAdmissionId(admissionId);
    return this.storage.transactionSync(() =>
      this.storage.sql.exec<{ id: number }>(
        `DELETE FROM rendezvous_admissions
          WHERE id = ?
            AND ticket_replay_tag_current IS NULL
            AND ticket_replay_tag_previous IS NULL
        RETURNING id`,
        admissionId,
      ).toArray().length === 1
    );
  }

  prune(nowMs: number): number {
    assertNow(nowMs);
    return this.storage.transactionSync(() =>
      pruneBefore(
        this.storage.sql,
        nowMs - RENDEZVOUS_ROLLING_WINDOW_MS,
      ).deleted
    );
  }

  claimReplayTags(
    admissionId: number,
    tags: RendezvousReplayTags,
  ): RendezvousAdmissionClaimResult {
    assertAdmissionId(admissionId);
    const [current, previous] = tags;
    assertReplayTagPair(current, previous);

    return this.storage.transactionSync(() => {
      const sql = this.storage.sql;
      const rows = sql.exec<AdmissionRow>(
        `SELECT id, accepted_at_ms, ticket_replay_tag_current,
                ticket_replay_tag_previous
           FROM rendezvous_admissions
          WHERE id = ?`,
        admissionId,
      ).toArray();
      const row = rows[0];
      if (rows.length === 0 || row === undefined) {
        return { claimed: false, reason: "missing" };
      }
      if (rows.length !== 1) {
        throw corruptSchema();
      }
      assertStoredRow(row);
      if (row.ticket_replay_tag_current !== null) {
        return { claimed: false, reason: "already_claimed" };
      }

      const collision = sql.exec<{ id: number }>(
        `SELECT id
           FROM rendezvous_admissions
          WHERE ticket_replay_tag_current IN (?, ?)
             OR ticket_replay_tag_previous IN (?, ?)
          ORDER BY id
          LIMIT 1`,
        current,
        previous,
        current,
        previous,
      ).toArray();
      if (collision.length !== 0) {
        return { claimed: false, reason: "replay" };
      }

      const updated = sql.exec<{ id: number }>(
        `UPDATE rendezvous_admissions
            SET ticket_replay_tag_current = ?,
                ticket_replay_tag_previous = ?
          WHERE id = ?
            AND ticket_replay_tag_current IS NULL
            AND ticket_replay_tag_previous IS NULL
        RETURNING id`,
        current,
        previous,
        admissionId,
      ).toArray();
      if (updated.length !== 1 || updated[0]?.id !== admissionId) {
        throw corruptSchema();
      }
      return { claimed: true };
    });
  }

  earliestRetainedExpiryMs(): number | null {
    return this.storage.transactionSync(() => {
      const rows = this.storage.sql.exec<{ accepted_at_ms: number }>(
        `SELECT accepted_at_ms
           FROM rendezvous_admissions
          ORDER BY accepted_at_ms, id
          LIMIT 1`,
      ).toArray();
      const row = rows[0];
      if (row === undefined) {
        return null;
      }
      if (rows.length !== 1) {
        throw corruptSchema();
      }
      assertAcceptedAt(row.accepted_at_ms);
      return row.accepted_at_ms + RENDEZVOUS_ROLLING_WINDOW_MS;
    });
  }
}

function assertMigrationDefinitions(): void {
  if (SCHEMA_MIGRATIONS.length !== CURRENT_SCHEMA_VERSION) {
    throw corruptSchema();
  }
  for (const [index, migration] of SCHEMA_MIGRATIONS.entries()) {
    if (migration.version !== index + 1) {
      throw corruptSchema();
    }
  }
}

function assertMigrationHistory(
  rows: readonly { readonly version: number }[],
): void {
  for (const row of rows) {
    if (!Number.isSafeInteger(row.version) || row.version < 1) {
      throw corruptSchema();
    }
    if (row.version > CURRENT_SCHEMA_VERSION) {
      throw new RendezvousAdmissionStoreError("unsupported_schema");
    }
  }
  for (const [index, row] of rows.entries()) {
    if (row.version !== index + 1) {
      throw corruptSchema();
    }
  }
}

function assertStoredRows(sql: SqlStorage): void {
  const { count } = sql.exec<{ count: number }>(
    "SELECT COUNT(*) AS count FROM rendezvous_admissions",
  ).one();
  assertRetainedCount(count);

  const integrity = sql.exec<{ quick_check: string }>(
    "PRAGMA quick_check(1)",
  ).toArray();
  if (integrity.length !== 1 || integrity[0]?.quick_check !== "ok") {
    throw corruptSchema();
  }

  // The two partial unique indexes cover duplicates within each alias column.
  // Probe cross-column collisions in SQLite so cold start returns at most one
  // row instead of materializing the complete replay ledger in Worker memory.
  const collision = sql.exec<{ invalid: number }>(
    `SELECT 1 AS invalid
       FROM (
         SELECT ticket_replay_tag_current AS replay_tag
           FROM rendezvous_admissions
          WHERE ticket_replay_tag_current IS NOT NULL
         UNION ALL
         SELECT ticket_replay_tag_previous AS replay_tag
           FROM rendezvous_admissions
          WHERE ticket_replay_tag_previous IS NOT NULL
       )
      GROUP BY replay_tag
     HAVING COUNT(*) > 1
      LIMIT 1`,
  ).toArray();
  if (collision.length !== 0) {
    throw corruptSchema();
  }
}

function assertStoredRow(row: AdmissionRow): void {
  if (!isAdmissionId(row.id)) {
    throw corruptSchema();
  }
  assertAcceptedAt(row.accepted_at_ms);
  if (
    row.ticket_replay_tag_current === null &&
    row.ticket_replay_tag_previous === null
  ) {
    return;
  }
  if (
    row.ticket_replay_tag_current === null ||
    row.ticket_replay_tag_previous === null ||
    !isReplayTagPair(
      row.ticket_replay_tag_current,
      row.ticket_replay_tag_previous,
    )
  ) {
    throw corruptSchema();
  }
}

interface PruneResult {
  readonly backlog: boolean;
  readonly deleted: number;
}

function pruneBefore(sql: SqlStorage, cutoffMs: number): PruneResult {
  const { count } = sql.exec<{ count: number }>(
    `SELECT COUNT(*) AS count
       FROM (
         SELECT id
           FROM rendezvous_admissions
          WHERE accepted_at_ms <= ?
          ORDER BY accepted_at_ms, id
          LIMIT ?
       )`,
    cutoffMs,
    REPLAY_PRUNE_BATCH_SIZE,
  ).one();
  if (
    !Number.isSafeInteger(count) ||
    count < 0 ||
    count > REPLAY_PRUNE_BATCH_SIZE
  ) {
    throw corruptSchema();
  }
  sql.exec(
    `DELETE FROM rendezvous_admissions
      WHERE id IN (
        SELECT id
          FROM rendezvous_admissions
         WHERE accepted_at_ms <= ?
         ORDER BY accepted_at_ms, id
         LIMIT ?
      )`,
    cutoffMs,
    REPLAY_PRUNE_BATCH_SIZE,
  );
  const backlog = sql.exec<{ present: number }>(
    `SELECT EXISTS(
       SELECT 1
         FROM rendezvous_admissions
        WHERE accepted_at_ms <= ?
        LIMIT 1
     ) AS present`,
    cutoffMs,
  ).one().present;
  if (backlog !== 0 && backlog !== 1) {
    throw corruptSchema();
  }
  return { backlog: backlog === 1, deleted: count };
}

function assertNow(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_ACCEPTED_AT_MS) {
    throw new RangeError("Invalid rendezvous admission timestamp");
  }
}

function assertAcceptedAt(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_ACCEPTED_AT_MS) {
    throw corruptSchema();
  }
}

function assertRetainedCount(value: number): void {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_RENDEZVOUS_REPLAY_ADMISSIONS
  ) {
    throw corruptSchema();
  }
}

function assertAdmissionId(value: number): void {
  if (!isAdmissionId(value)) {
    throw new RangeError("Invalid rendezvous admission ID");
  }
}

function isAdmissionId(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}

function assertReplayTagPair(current: string, previous: string): void {
  if (!isReplayTagPair(current, previous)) {
    throw new RangeError("Invalid rendezvous replay tags");
  }
}

function isReplayTagPair(current: unknown, previous: unknown): boolean {
  if (typeof current !== "string" || typeof previous !== "string") {
    return false;
  }
  const currentMatch = REPLAY_TAG_PATTERN.exec(current);
  const previousMatch = REPLAY_TAG_PATTERN.exec(previous);
  return current !== previous &&
    currentMatch !== null &&
    previousMatch !== null &&
    currentMatch[1] !== previousMatch[1];
}

function corruptSchema(): RendezvousAdmissionStoreError {
  return new RendezvousAdmissionStoreError("corrupt_schema");
}
