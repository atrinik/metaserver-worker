export const DIRECTORY_PROFILES = ["classic-v1", "game-v1"] as const;
export type DirectoryProfile = typeof DIRECTORY_PROFILES[number];

export const MAX_DIRECTORY_ENTRIES_PER_PROFILE = 512;
const TEXT_ENCODER = new TextEncoder();

export function isDirectoryText(
  value: unknown,
  maximumBytes: number,
  allowEmpty: boolean,
): value is string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    TEXT_ENCODER.encode(value).byteLength > maximumBytes ||
    /[\u0000-\u001f\u007f\ufffe\uffff]/.test(value)
  ) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index);
    if (current >= 0xd800 && current <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (
        index + 1 >= value.length ||
        next < 0xdc00 ||
        next > 0xdfff
      ) {
        return false;
      }
      index += 1;
    } else if (current >= 0xdc00 && current <= 0xdfff) {
      return false;
    }
  }
  return true;
}

interface ExpiryBatchResult {
  readonly expiredEntries: number;
  readonly visibleChanged: boolean;
}

interface ExpiryCommitRecord {
  readonly expired_entries: number;
  readonly visible_revision: number | null;
}

/**
 * Expire one bounded profile cohort as an authoritative visible transition.
 *
 * The schema caps each profile at 512 presence rows, so one transaction can
 * remove the complete expired set without an unbounded query or a partially
 * visible multi-batch transition. Revision and outbox predicates observe the
 * old visible entry set; private/orphan presence removal is revision-neutral.
 */
export async function expireDirectoryEntries(
  database: D1Database,
  profile: DirectoryProfile,
  cutoff: number,
  now: number,
): Promise<ExpiryBatchResult> {
  requireTimestamp(cutoff, "cutoff");
  requireTimestamp(now, "now");
  if (cutoff > now) {
    throw new RangeError("cutoff must not exceed now");
  }

  const commitToken = randomCommitToken();
  const results = await database.batch([
    database.prepare(
      `INSERT INTO directory_expiry_commits
         (profile, commit_token, cutoff, committed_at, base_revision,
          visible_revision, expired_entries, expired_presence)
       SELECT revisions.profile, ?, ?, ?, revisions.revision,
              CASE WHEN visible.expired_entries > 0
                THEN revisions.revision + 1 ELSE NULL END,
              visible.expired_entries, stale.expired_presence
         FROM directory_revisions AS revisions
         JOIN (
           SELECT count(*) AS expired_entries
             FROM directory_entries AS entries
             JOIN server_presence AS presence
               ON presence.profile = entries.profile
              AND presence.server_id = entries.server_id
            WHERE entries.profile = ? AND presence.last_seen < ?
         ) AS visible
         JOIN (
           SELECT count(*) AS expired_presence
             FROM server_presence
            WHERE profile = ? AND last_seen < ?
         ) AS stale
        WHERE revisions.profile = ?
       ON CONFLICT(profile) DO UPDATE SET
         commit_token = excluded.commit_token,
         cutoff = excluded.cutoff,
         committed_at = excluded.committed_at,
         base_revision = excluded.base_revision,
         visible_revision = excluded.visible_revision,
         expired_entries = excluded.expired_entries,
         expired_presence = excluded.expired_presence`,
    ).bind(
      commitToken,
      cutoff,
      now,
      profile,
      cutoff,
      profile,
      cutoff,
      profile,
    ),
    database.prepare(
      `UPDATE directory_revisions
          SET revision = (
                SELECT visible_revision FROM directory_expiry_commits
                 WHERE profile = ? AND commit_token = ?
              ),
              updated_at = ?
        WHERE profile = ?
          AND EXISTS (
            SELECT 1 FROM directory_expiry_commits AS expiry
             WHERE expiry.profile = directory_revisions.profile
               AND expiry.commit_token = ?
               AND expiry.visible_revision = directory_revisions.revision + 1
          )`,
    ).bind(profile, commitToken, now, profile, commitToken),
    database.prepare(
      `INSERT INTO directory_outbox (profile, revision, created_at)
       SELECT revisions.profile, revisions.revision, ?
         FROM directory_revisions AS revisions
         JOIN directory_expiry_commits AS expiry USING (profile)
        WHERE revisions.profile = ? AND expiry.commit_token = ?
          AND expiry.visible_revision = revisions.revision
          AND expiry.visible_revision = expiry.base_revision + 1`,
    ).bind(now, profile, commitToken),
    database.prepare(
      `DELETE FROM directory_entries
        WHERE profile = ? AND server_id IN (
          SELECT server_id FROM server_presence
           WHERE profile = ? AND last_seen < ?
        )`,
    ).bind(profile, profile, cutoff),
    database.prepare(
      `DELETE FROM server_presence
        WHERE profile = ? AND last_seen < ?`,
    ).bind(profile, cutoff),
    database.prepare(
      `INSERT INTO directory_transaction_assertions (assertion)
       SELECT 0
        WHERE NOT EXISTS (
          SELECT 1
            FROM directory_expiry_commits AS expiry
            JOIN directory_revisions AS revisions USING (profile)
           WHERE expiry.profile = ? AND expiry.commit_token = ?
             AND expiry.cutoff = ? AND expiry.committed_at = ?
             AND NOT EXISTS (
               SELECT 1 FROM server_presence
                WHERE profile = expiry.profile AND last_seen < expiry.cutoff
             )
             AND NOT EXISTS (
               SELECT 1
                 FROM directory_entries AS entries
                 JOIN server_presence AS presence
                   ON presence.profile = entries.profile
                  AND presence.server_id = entries.server_id
                WHERE entries.profile = expiry.profile
                  AND presence.last_seen < expiry.cutoff
             )
             AND (
               (
                 expiry.visible_revision IS NULL AND
                 expiry.expired_entries = 0 AND
                 revisions.revision = expiry.base_revision
               ) OR (
                 expiry.visible_revision = expiry.base_revision + 1 AND
                 expiry.expired_entries > 0 AND
                 revisions.revision = expiry.visible_revision AND
                 EXISTS (
                   SELECT 1 FROM directory_outbox AS outbox
                    WHERE outbox.profile = expiry.profile
                      AND outbox.revision = expiry.visible_revision
                      AND outbox.created_at = expiry.committed_at
                 )
               )
             )
        )`,
    ).bind(profile, commitToken, cutoff, now),
    database.prepare(
      `SELECT expired_entries, visible_revision
         FROM directory_expiry_commits
        WHERE profile = ? AND commit_token = ?`,
    ).bind(profile, commitToken),
  ]);
  requireResults(results, 7);
  const commit = exactExpiryCommit(results[6]);
  const revisionChanges = changes(results, 1);
  const outboxChanges = changes(results, 2);
  const assertionChanges = changes(results, 5);
  if (
    revisionChanges > 1 ||
    revisionChanges !== outboxChanges ||
    assertionChanges !== 0 ||
    (commit.expired_entries === 0) !== (revisionChanges === 0) ||
    commit.expired_entries > MAX_DIRECTORY_ENTRIES_PER_PROFILE
  ) {
    throw new Error("Directory expiry transaction violated its invariants");
  }
  return Object.freeze({
    expiredEntries: commit.expired_entries,
    visibleChanged: commit.visible_revision !== null,
  });
}

function exactExpiryCommit(
  result: D1Result<unknown>,
): ExpiryCommitRecord {
  if (result.results.length !== 1) {
    throw new Error("Directory expiry returned an invalid commit marker");
  }
  const record = result.results[0] as Partial<ExpiryCommitRecord>;
  if (
    !Number.isSafeInteger(record.expired_entries) ||
    (record.visible_revision !== null &&
      !Number.isSafeInteger(record.visible_revision))
  ) {
    throw new Error("Directory expiry returned an invalid commit marker");
  }
  return record as ExpiryCommitRecord;
}

function randomCommitToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function requireResults(
  results: readonly D1Result<unknown>[],
  expected: number,
): void {
  if (results.length !== expected || results.some((result) => !result.success)) {
    throw new Error("Directory expiry returned an invalid transaction result");
  }
}

function changes(results: readonly D1Result<unknown>[], index: number): number {
  const value = results[index]?.meta.changes;
  if (value === undefined || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Directory expiry returned an invalid change count");
  }
  return value;
}

function requireTimestamp(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}
