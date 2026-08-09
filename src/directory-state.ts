export const DIRECTORY_PROFILES = ["classic-v1", "game-v1"] as const;
export type DirectoryProfile = typeof DIRECTORY_PROFILES[number];

export const MAX_DIRECTORY_ENTRIES_PER_PROFILE = 512;
const TEXT_ENCODER = new TextEncoder();

interface DirectoryRevisionRecord {
  readonly revision: number;
  readonly updated_at: number;
}

export interface DirectoryRevision {
  readonly revision: number;
  readonly updatedAt: number;
}

interface DirectoryArtifactPublicationRecord {
  readonly published_revision: number;
  readonly generation: number;
  readonly generated_at: number;
  readonly expires_at: number;
  readonly model_sha256: string;
  readonly html_sha256: string;
  readonly xml_sha256: string;
  readonly json_sha256: string;
  readonly manifest_sha256: string;
  readonly html_bytes: number;
  readonly xml_bytes: number;
  readonly json_bytes: number;
  readonly manifest_bytes: number;
  readonly published_at: number;
}

export interface DirectoryArtifactPublication {
  readonly publishedRevision: number;
  readonly generation: number;
  readonly generatedAt: number;
  readonly expiresAt: number;
  readonly modelSha256: string;
  readonly htmlSha256: string;
  readonly xmlSha256: string;
  readonly jsonSha256: string;
  readonly manifestSha256: string;
  readonly htmlBytes: number;
  readonly xmlBytes: number;
  readonly jsonBytes: number;
  readonly manifestBytes: number;
  readonly publishedAt: number;
}

export interface DirectoryArtifactCommit extends DirectoryArtifactPublication {
  readonly profile: DirectoryProfile;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const ZERO_SHA256 = "0".repeat(64);

export async function readDirectoryRevision(
  database: D1Database,
  profile: DirectoryProfile,
): Promise<DirectoryRevision> {
  const record = await database.prepare(
    `SELECT revision, updated_at
       FROM directory_revisions
      WHERE profile = ?`,
  ).bind(profile).first<DirectoryRevisionRecord>();
  if (
    record === null ||
    !Number.isSafeInteger(record.revision) ||
    record.revision < 0 ||
    !Number.isSafeInteger(record.updated_at) ||
    record.updated_at < 0
  ) {
    throw new Error("Directory revision state is invalid");
  }
  return Object.freeze({
    revision: record.revision,
    updatedAt: record.updated_at,
  });
}

export async function readDirectoryArtifactPublication(
  database: D1Database,
  profile: DirectoryProfile,
): Promise<DirectoryArtifactPublication> {
  const record = await database.prepare(
    `SELECT published_revision, generation, generated_at, expires_at,
            model_sha256, html_sha256, xml_sha256, json_sha256,
            manifest_sha256, html_bytes, xml_bytes, json_bytes,
            manifest_bytes, published_at
       FROM directory_artifact_publications
      WHERE profile = ?`,
  ).bind(profile).first<DirectoryArtifactPublicationRecord>();
  return exactArtifactPublication(record);
}

export async function readDirectoryArtifactHistory(
  database: D1Database,
  profile: DirectoryProfile,
): Promise<readonly number[]> {
  const result = await database.prepare(
    `SELECT generation FROM directory_artifact_history
      WHERE profile = ? ORDER BY generation`,
  ).bind(profile).all<{ generation?: unknown }>();
  if (!result.success || result.results.length > 8) {
    throw new Error("Directory artifact history is invalid");
  }
  const generations = result.results.map((record) => record.generation);
  if (!generations.every((generation, index) =>
    Number.isSafeInteger(generation) && (generation as number) >= 1 &&
    (index === 0 ||
      (generations[index - 1] as number) < (generation as number))
  )) {
    throw new Error("Directory artifact history is invalid");
  }
  return Object.freeze(generations as number[]);
}

/**
 * Checkpoint a fully verified public generation and acknowledge only the D1
 * revisions represented by it. The final assertion executes inside the D1
 * batch, so an ignored write rolls back the checkpoint and outbox deletion.
 */
export async function commitDirectoryArtifactPublication(
  database: D1Database,
  commit: DirectoryArtifactCommit,
): Promise<void> {
  validateArtifactCommit(commit);
  const commitToken = randomCommitToken();
  const results = await database.batch([
    database.prepare(
      `INSERT INTO directory_artifact_commits
         (profile, commit_token, revision, generation, committed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(profile) DO UPDATE SET
         commit_token = excluded.commit_token,
         revision = excluded.revision,
         generation = excluded.generation,
         committed_at = excluded.committed_at`,
    ).bind(
      commit.profile,
      commitToken,
      commit.publishedRevision,
      commit.generation,
      commit.publishedAt,
    ),
    database.prepare(
      `UPDATE directory_artifact_publications
          SET published_revision = ?, generation = ?, generated_at = ?,
              expires_at = ?, model_sha256 = ?, html_sha256 = ?,
              xml_sha256 = ?, json_sha256 = ?, manifest_sha256 = ?,
              html_bytes = ?, xml_bytes = ?, json_bytes = ?,
              manifest_bytes = ?, published_at = ?
        WHERE profile = ?
          AND EXISTS (
            SELECT 1 FROM directory_revisions AS revision
             WHERE revision.profile = directory_artifact_publications.profile
               AND revision.revision = ?
          ) AND (
          (generation < ? AND published_revision <= ? AND
           (generation = 0 OR published_revision < ? OR model_sha256 = ?)) OR
          (generation = ? AND published_revision = ? AND generated_at = ? AND
           expires_at = ? AND model_sha256 = ? AND html_sha256 = ? AND
           xml_sha256 = ? AND json_sha256 = ? AND manifest_sha256 = ? AND
           html_bytes = ? AND xml_bytes = ? AND json_bytes = ? AND
           manifest_bytes = ? AND published_at = ?)
        )`,
    ).bind(
      commit.publishedRevision,
      commit.generation,
      commit.generatedAt,
      commit.expiresAt,
      commit.modelSha256,
      commit.htmlSha256,
      commit.xmlSha256,
      commit.jsonSha256,
      commit.manifestSha256,
      commit.htmlBytes,
      commit.xmlBytes,
      commit.jsonBytes,
      commit.manifestBytes,
      commit.publishedAt,
      commit.profile,
      commit.publishedRevision,
      commit.generation,
      commit.publishedRevision,
      commit.publishedRevision,
      commit.modelSha256,
      commit.generation,
      commit.publishedRevision,
      commit.generatedAt,
      commit.expiresAt,
      commit.modelSha256,
      commit.htmlSha256,
      commit.xmlSha256,
      commit.jsonSha256,
      commit.manifestSha256,
      commit.htmlBytes,
      commit.xmlBytes,
      commit.jsonBytes,
      commit.manifestBytes,
      commit.publishedAt,
    ),
    database.prepare(
      `DELETE FROM directory_artifact_history
        WHERE profile = ?
          AND NOT EXISTS (
            SELECT 1 FROM directory_artifact_history AS current
             WHERE current.profile = ? AND current.generation = ?
          )
          AND generation NOT IN (
            SELECT generation FROM directory_artifact_history AS retained
             WHERE retained.profile = ?
             ORDER BY generation DESC LIMIT 7
          )
          AND EXISTS (
            SELECT 1 FROM directory_artifact_publications AS publication
             WHERE publication.profile = directory_artifact_history.profile
               AND publication.generation = ?
               AND publication.published_revision = ?
          )`,
    ).bind(
      commit.profile,
      commit.profile,
      commit.generation,
      commit.profile,
      commit.generation,
      commit.publishedRevision,
    ),
    database.prepare(
      `INSERT INTO directory_artifact_history
         (profile, generation, committed_at)
       SELECT ?, ?, ? WHERE EXISTS (
         SELECT 1 FROM directory_artifact_publications AS publication
          WHERE publication.profile = ? AND publication.generation = ?
            AND publication.published_revision = ?
       )
       ON CONFLICT(profile, generation) DO UPDATE SET
         committed_at = excluded.committed_at`,
    ).bind(
      commit.profile,
      commit.generation,
      commit.publishedAt,
      commit.profile,
      commit.generation,
      commit.publishedRevision,
    ),
    database.prepare(
      `DELETE FROM directory_outbox
        WHERE profile = ? AND revision <= ?
          AND EXISTS (
            SELECT 1 FROM directory_artifact_publications AS publication
             WHERE publication.profile = directory_outbox.profile
               AND publication.generation = ?
               AND publication.published_revision = ?
          )`,
    ).bind(
      commit.profile,
      commit.publishedRevision,
      commit.generation,
      commit.publishedRevision,
    ),
    database.prepare(
      `INSERT INTO directory_transaction_assertions (assertion)
       SELECT 0 WHERE NOT EXISTS (
         SELECT 1
           FROM directory_artifact_commits AS marker
           JOIN directory_artifact_publications AS publication USING (profile)
           JOIN directory_revisions AS revision USING (profile)
          WHERE marker.profile = ? AND marker.commit_token = ?
            AND marker.revision = ? AND marker.generation = ?
            AND publication.published_revision = marker.revision
            AND publication.generation = marker.generation
            AND publication.generated_at = ?
            AND publication.expires_at = ?
            AND publication.model_sha256 = ?
            AND publication.html_sha256 = ?
            AND publication.xml_sha256 = ?
            AND publication.json_sha256 = ?
            AND publication.manifest_sha256 = ?
            AND publication.html_bytes = ?
            AND publication.xml_bytes = ?
            AND publication.json_bytes = ?
            AND publication.manifest_bytes = ?
            AND publication.published_at = ?
            AND revision.revision = publication.published_revision
            AND EXISTS (
              SELECT 1 FROM directory_artifact_history AS history
               WHERE history.profile = marker.profile
                 AND history.generation = marker.generation
                 AND history.committed_at = publication.published_at
            )
            AND (
              SELECT count(*) FROM directory_artifact_history AS history
               WHERE history.profile = marker.profile
            ) <= 8
            AND NOT EXISTS (
              SELECT 1 FROM directory_outbox AS outbox
               WHERE outbox.profile = marker.profile
                 AND outbox.revision <= marker.revision
            )
       )`,
    ).bind(
      commit.profile,
      commitToken,
      commit.publishedRevision,
      commit.generation,
      commit.generatedAt,
      commit.expiresAt,
      commit.modelSha256,
      commit.htmlSha256,
      commit.xmlSha256,
      commit.jsonSha256,
      commit.manifestSha256,
      commit.htmlBytes,
      commit.xmlBytes,
      commit.jsonBytes,
      commit.manifestBytes,
      commit.publishedAt,
    ),
  ]);
  if (
    results.length !== 6 ||
    results.some((result) => !result.success) ||
    changes(results, 0) !== 1 ||
    changes(results, 1) > 1 ||
    changes(results, 5) !== 0
  ) {
    throw new Error("Directory artifact checkpoint violated its invariants");
  }
}

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
            WHERE entries.profile = ? AND presence.last_seen <= ?
         ) AS visible
         JOIN (
           SELECT count(*) AS expired_presence
             FROM server_presence
            WHERE profile = ? AND last_seen <= ?
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
              updated_at = max(updated_at, ?)
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
           WHERE profile = ? AND last_seen <= ?
        )`,
    ).bind(profile, profile, cutoff),
    database.prepare(
      `DELETE FROM server_presence
        WHERE profile = ? AND last_seen <= ?`,
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
                WHERE profile = expiry.profile AND last_seen <= expiry.cutoff
             )
             AND NOT EXISTS (
               SELECT 1
                 FROM directory_entries AS entries
                 JOIN server_presence AS presence
                   ON presence.profile = entries.profile
                  AND presence.server_id = entries.server_id
                WHERE entries.profile = expiry.profile
                  AND presence.last_seen <= expiry.cutoff
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
                 ) AND NOT EXISTS (
                   SELECT 1 FROM directory_outbox AS obsolete
                    WHERE obsolete.profile = expiry.profile
                      AND obsolete.revision <> expiry.visible_revision
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
    (revisionChanges === 0 && outboxChanges !== 0) ||
    (revisionChanges === 1 && (outboxChanges < 1 || outboxChanges > 2)) ||
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

function exactArtifactPublication(
  record: DirectoryArtifactPublicationRecord | null,
): DirectoryArtifactPublication {
  if (record === null) {
    throw new Error("Directory artifact publication state is missing");
  }
  for (const value of [
    record.published_revision,
    record.generation,
    record.generated_at,
    record.expires_at,
    record.html_bytes,
    record.xml_bytes,
    record.json_bytes,
    record.manifest_bytes,
    record.published_at,
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("Directory artifact publication state is invalid");
    }
  }
  for (const digest of [
    record.model_sha256,
    record.html_sha256,
    record.xml_sha256,
    record.json_sha256,
    record.manifest_sha256,
  ]) {
    if (!SHA256_HEX.test(digest)) {
      throw new Error("Directory artifact publication state is invalid");
    }
  }
  if (
    (record.generation === 0 &&
      (record.published_revision !== 0 || record.generated_at !== 0 ||
        record.expires_at !== 0 ||
        record.published_at !== 0 || record.html_bytes !== 0 ||
        record.xml_bytes !== 0 || record.json_bytes !== 0 ||
        record.manifest_bytes !== 0 || record.model_sha256 !== ZERO_SHA256 ||
        record.html_sha256 !== ZERO_SHA256 ||
        record.xml_sha256 !== ZERO_SHA256 ||
        record.json_sha256 !== ZERO_SHA256 ||
        record.manifest_sha256 !== ZERO_SHA256)) ||
    (record.generation > 0 &&
      (record.generated_at > record.published_at ||
        record.published_at >= record.expires_at ||
        record.html_bytes === 0 || record.xml_bytes === 0 ||
        record.json_bytes === 0 || record.manifest_bytes === 0))
  ) {
    throw new Error("Directory artifact publication state is invalid");
  }
  return Object.freeze({
    publishedRevision: record.published_revision,
    generation: record.generation,
    generatedAt: record.generated_at,
    expiresAt: record.expires_at,
    modelSha256: record.model_sha256,
    htmlSha256: record.html_sha256,
    xmlSha256: record.xml_sha256,
    jsonSha256: record.json_sha256,
    manifestSha256: record.manifest_sha256,
    htmlBytes: record.html_bytes,
    xmlBytes: record.xml_bytes,
    jsonBytes: record.json_bytes,
    manifestBytes: record.manifest_bytes,
    publishedAt: record.published_at,
  });
}

function validateArtifactCommit(commit: DirectoryArtifactCommit): void {
  if (!DIRECTORY_PROFILES.includes(commit.profile)) {
    throw new RangeError("Invalid directory artifact profile");
  }
  for (const value of [
    commit.publishedRevision,
    commit.generation,
    commit.generatedAt,
    commit.expiresAt,
    commit.htmlBytes,
    commit.xmlBytes,
    commit.jsonBytes,
    commit.manifestBytes,
    commit.publishedAt,
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError("Invalid directory artifact checkpoint");
    }
  }
  if (
    commit.generation < 1 ||
    commit.generatedAt > commit.publishedAt ||
    commit.publishedAt >= commit.expiresAt
  ) {
    throw new RangeError("Invalid directory artifact checkpoint");
  }
  for (const digest of [
    commit.modelSha256,
    commit.htmlSha256,
    commit.xmlSha256,
    commit.jsonSha256,
    commit.manifestSha256,
  ]) {
    if (!SHA256_HEX.test(digest)) {
      throw new RangeError("Invalid directory artifact checkpoint");
    }
  }
  if (
    commit.htmlBytes < 1 || commit.htmlBytes > 4_194_304 ||
    commit.xmlBytes < 1 || commit.xmlBytes > 4_194_304 ||
    commit.jsonBytes < 1 || commit.jsonBytes > 4_194_304 ||
    commit.manifestBytes < 1 || commit.manifestBytes > 262_144
  ) {
    throw new RangeError("Invalid directory artifact checkpoint");
  }
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
