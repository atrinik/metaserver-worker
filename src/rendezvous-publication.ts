import type { InternalRendezvousPublication } from "./rendezvous-contract";

interface PublishedGenerationRecord {
  readonly rendezvous_generation: string;
}

interface PublicationMatchRecord {
  readonly matches: number;
}

export interface PublisherReplayState {
  readonly lastSequence: string;
  readonly nonceSeen: boolean;
}

interface PublisherReplayRecord {
  readonly last_sequence: string;
  readonly nonce_seen: number;
}

export interface PublicationPersistenceResult {
  readonly accepted: boolean;
  readonly visibleChanged: boolean;
}

const TOKEN_GENERATION = /^[0-9a-f]{64}$/;
const COMPAT_AUTH_KEY_SENTINEL = "0".repeat(128);

export async function readPublishedGeneration(
  db: D1Database,
  serverId: string,
): Promise<string | null> {
  const record = await db.prepare(
    "SELECT rendezvous_generation FROM servers WHERE server_id = ?",
  ).bind(serverId).first<PublishedGenerationRecord>();
  if (record === null) {
    return null;
  }
  if (!TOKEN_GENERATION.test(record.rendezvous_generation)) {
    throw new Error("Published rendezvous generation is invalid");
  }
  return record.rendezvous_generation;
}

export async function readPublisherReplayState(
  db: D1Database,
  serverId: string,
  profile: "classic-v1" | "game-v1",
  nonce: string,
): Promise<PublisherReplayState | null> {
  const record = await db.prepare(
    `SELECT replay.last_sequence,
            EXISTS (
              SELECT 1
                FROM publisher_nonces AS nonces
               WHERE nonces.server_id = replay.server_id
                 AND nonces.profile = replay.profile
                 AND nonces.nonce = ?
            ) AS nonce_seen
       FROM publisher_replay AS replay
      WHERE replay.server_id = ? AND replay.profile = ?`,
  ).bind(nonce, serverId, profile).first<PublisherReplayRecord>();
  if (record === null) {
    return null;
  }
  return {
    lastSequence: record.last_sequence,
    nonceSeen: record.nonce_seen === 1,
  };
}

export async function persistRendezvousPublication(
  db: D1Database,
  publication: InternalRendezvousPublication,
): Promise<PublicationPersistenceResult> {
  return publication.publisherAuthentication === "signed-certificate-v1"
    ? persistSignedPublication(db, publication)
    : persistCompatibilityPublication(db, publication);
}

async function persistSignedPublication(
  db: D1Database,
  publication: InternalRendezvousPublication,
): Promise<PublicationPersistenceResult> {
  const sequence = publication.publisherSequence;
  const nonce = publication.publisherNonce;
  const nonceExpiresAt = publication.publisherNonceExpiresAt;
  if (sequence === null || nonce === null || nonceExpiresAt === null) {
    throw new Error("Signed publication omitted replay metadata");
  }

  const persisted = await db.batch([
    db.prepare(
      `INSERT INTO publisher_replay
         (server_id, profile, last_sequence, last_nonce, commit_token,
          updated_at)
       SELECT ?, ?, ?, ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM publisher_nonces
           WHERE server_id = ? AND profile = ? AND nonce = ?
        )
       ON CONFLICT(server_id, profile) DO UPDATE SET
         last_sequence = excluded.last_sequence,
         last_nonce = excluded.last_nonce,
         commit_token = excluded.commit_token,
         updated_at = excluded.updated_at
       WHERE (
          length(excluded.last_sequence) > length(last_sequence) OR
          (
            length(excluded.last_sequence) = length(last_sequence) AND
            excluded.last_sequence > last_sequence
          )
       ) AND NOT EXISTS (
          SELECT 1 FROM publisher_nonces
           WHERE server_id = excluded.server_id
             AND profile = excluded.profile
             AND nonce = excluded.last_nonce
       )`,
    ).bind(
      publication.serverId,
      publication.directoryProfile,
      sequence,
      nonce,
      publication.commitToken,
      publication.now,
      publication.serverId,
      publication.directoryProfile,
      nonce,
    ),
    db.prepare(
      `INSERT INTO publisher_nonces
         (server_id, profile, nonce, expires_at, created_at)
       SELECT ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM publisher_replay
           WHERE server_id = ? AND profile = ? AND commit_token = ?
        )`,
    ).bind(
      publication.serverId,
      publication.directoryProfile,
      nonce,
      nonceExpiresAt,
      publication.now,
      publication.serverId,
      publication.directoryProfile,
      publication.commitToken,
    ),
    db.prepare(
      `INSERT INTO server_owners
         (server_id, auth_key, current_ip, ip_changed_at, created_at,
          updated_at, rendezvous_generation, authentication_kind)
       SELECT ?, ?, '', ?, ?, ?, ?, 'signed-certificate-v1'
        WHERE EXISTS (
          SELECT 1 FROM publisher_replay
           WHERE server_id = ? AND profile = ? AND commit_token = ?
        )
       ON CONFLICT(server_id) DO UPDATE SET
         auth_key = excluded.auth_key,
         current_ip = '',
         ip_changed_at = CASE
           WHEN server_owners.current_ip <> '' THEN excluded.ip_changed_at
           ELSE server_owners.ip_changed_at
         END,
         updated_at = excluded.updated_at,
         rendezvous_generation = excluded.rendezvous_generation,
         authentication_kind = excluded.authentication_kind`,
    ).bind(
      publication.serverId,
      COMPAT_AUTH_KEY_SENTINEL,
      publication.now,
      publication.now,
      publication.now,
      publication.generation,
      publication.serverId,
      publication.directoryProfile,
      publication.commitToken,
    ),
    visibleRevisionStatement(db, publication, true),
    visibleOutboxStatement(db, publication, true),
    serverUpsertStatement(db, publication, true),
  ]);

  requireBatchResults(persisted, 6);
  const accepted = changes(persisted, 0) === 1;
  if (!accepted) {
    if (persisted.some((_, index) => index > 0 && changes(persisted, index) !== 0)) {
      throw new Error("Rejected replay mutated publication state");
    }
    return { accepted: false, visibleChanged: false };
  }
  for (const index of [1, 2, 5]) {
    if (changes(persisted, index) !== 1) {
      throw new Error("Signed publication did not persist required state");
    }
  }
  const revisionChanges = changes(persisted, 3);
  if (revisionChanges !== changes(persisted, 4) || revisionChanges > 1) {
    throw new Error("Directory revision and outbox diverged");
  }
  return { accepted: true, visibleChanged: revisionChanges === 1 };
}

async function persistCompatibilityPublication(
  db: D1Database,
  publication: InternalRendezvousPublication,
): Promise<PublicationPersistenceResult> {
  const persisted = await db.batch([
    db.prepare(
      `UPDATE server_owners
          SET current_ip = '',
              ip_changed_at = CASE WHEN current_ip <> '' THEN ? ELSE ip_changed_at END,
              updated_at = ?,
              rendezvous_generation = ?
        WHERE server_id = ? AND authentication_kind = 'compat-key-v1'`,
    ).bind(
      publication.now,
      publication.now,
      publication.generation,
      publication.serverId,
    ),
    visibleRevisionStatement(db, publication, false),
    visibleOutboxStatement(db, publication, false),
    serverUpsertStatement(db, publication, false),
  ]);
  requireBatchResults(persisted, 4);
  if (changes(persisted, 0) !== 1 || changes(persisted, 3) !== 1) {
    throw new Error("Compatibility publication did not persist required state");
  }
  const revisionChanges = changes(persisted, 1);
  if (revisionChanges !== changes(persisted, 2) || revisionChanges > 1) {
    throw new Error("Directory revision and outbox diverged");
  }
  return { accepted: true, visibleChanged: revisionChanges === 1 };
}

function visibleRevisionStatement(
  db: D1Database,
  publication: InternalRendezvousPublication,
  signed: boolean,
): D1PreparedStatement {
  return db.prepare(
    `UPDATE directory_revisions
        SET revision = revision + 1, updated_at = ?
      WHERE profile = ?
        ${signed ? signedCommitGuard() : ""}
        AND ${visibleContentChangedPredicate()}`,
  ).bind(
    publication.now,
    publication.directoryProfile,
    ...(signed ? signedGuardBindings(publication) : []),
    ...visiblePredicateBindings(publication),
  );
}

function visibleOutboxStatement(
  db: D1Database,
  publication: InternalRendezvousPublication,
  signed: boolean,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO directory_outbox (profile, revision, created_at)
     SELECT profile, revision, ?
       FROM directory_revisions
      WHERE profile = ?
        ${signed ? signedCommitGuard() : ""}
        AND ${visibleContentChangedPredicate()}`,
  ).bind(
    publication.now,
    publication.directoryProfile,
    ...(signed ? signedGuardBindings(publication) : []),
    ...visiblePredicateBindings(publication),
  );
}

function serverUpsertStatement(
  db: D1Database,
  publication: InternalRendezvousPublication,
  signed: boolean,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO servers
       (server_id, source_ip, name, players_count, version, text_comment,
        last_seen, is_public, quic_host, quic_port, quic_cert_sha256,
        password_required, rendezvous_token_hash, rendezvous_generation,
        directory_fingerprint)
     SELECT ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE ${signed ? `EXISTS (
        SELECT 1 FROM publisher_replay
         WHERE server_id = ? AND profile = ? AND commit_token = ?
      )` : `EXISTS (
        SELECT 1 FROM server_owners
         WHERE server_id = ? AND rendezvous_generation = ?
           AND authentication_kind = 'compat-key-v1'
      )`}
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
       rendezvous_token_hash = excluded.rendezvous_token_hash,
       rendezvous_generation = excluded.rendezvous_generation,
       directory_fingerprint = excluded.directory_fingerprint`,
  ).bind(
    publication.serverId,
    publication.name,
    publication.playersCount,
    publication.version,
    publication.textComment,
    publication.now,
    publication.isPublic ? 1 : 0,
    publication.quicHost,
    publication.quicPort,
    publication.quicCertSha256,
    publication.passwordRequired ? 1 : 0,
    publication.tokenHash,
    publication.generation,
    publication.directoryFingerprint,
    ...(signed
      ? signedGuardBindings(publication)
      : [publication.serverId, publication.generation]),
  );
}

function signedCommitGuard(): string {
  return `AND EXISTS (
    SELECT 1 FROM publisher_replay
     WHERE server_id = ? AND profile = ? AND commit_token = ?
  )`;
}

function signedGuardBindings(
  publication: InternalRendezvousPublication,
): readonly [string, "classic-v1" | "game-v1", string] {
  return [
    publication.serverId,
    publication.directoryProfile,
    publication.commitToken,
  ];
}

function visibleContentChangedPredicate(): string {
  return `(
    (? = 1 AND NOT EXISTS (
      SELECT 1 FROM servers
       WHERE server_id = ?
         AND is_public = 1
         AND last_seen >= ?
         AND directory_fingerprint = ?
    )) OR
    (? = 0 AND EXISTS (
      SELECT 1 FROM servers
       WHERE server_id = ?
         AND is_public = 1
         AND last_seen >= ?
    ))
  )`;
}

function visiblePredicateBindings(
  publication: InternalRendezvousPublication,
): readonly [number, string, number, string, number, string, number] {
  const isPublic = publication.isPublic ? 1 : 0;
  return [
    isPublic,
    publication.serverId,
    publication.visibilityCutoff,
    publication.directoryFingerprint,
    isPublic,
    publication.serverId,
    publication.visibilityCutoff,
  ];
}

function requireBatchResults(
  results: readonly D1Result<unknown>[],
  expected: number,
): void {
  if (results.length !== expected || results.some((result) => !result.success)) {
    throw new Error("Publication transaction returned an invalid result");
  }
}

function changes(results: readonly D1Result<unknown>[], index: number): number {
  const value = results[index]?.meta.changes;
  if (!Number.isSafeInteger(value) || value === undefined || value < 0) {
    throw new Error("Publication transaction returned an invalid change count");
  }
  return value;
}

export async function rendezvousPublicationMatches(
  db: D1Database,
  publication: InternalRendezvousPublication,
): Promise<boolean> {
  const signedJoin = publication.publisherAuthentication ===
      "signed-certificate-v1"
    ? `JOIN publisher_replay AS replay
         ON replay.server_id = servers.server_id
        AND replay.profile = ?`
    : "";
  const signedPredicate = publication.publisherAuthentication ===
      "signed-certificate-v1"
    ? `AND replay.last_sequence = ?
       AND replay.last_nonce = ?
       AND replay.commit_token = ?
       AND EXISTS (
         SELECT 1 FROM publisher_nonces AS nonces
          WHERE nonces.server_id = replay.server_id
            AND nonces.profile = replay.profile
            AND nonces.nonce = replay.last_nonce
       )`
    : "";
  const record = await db.prepare(
    `SELECT COUNT(*) AS matches
       FROM servers AS servers
       JOIN server_owners AS owners USING (server_id)
       ${signedJoin}
      WHERE servers.server_id = ?
        AND owners.authentication_kind = ?
        AND owners.current_ip = ''
        AND owners.updated_at = ?
        AND owners.rendezvous_generation = ?
        AND servers.source_ip = ''
        AND servers.name = ?
        AND servers.players_count = ?
        AND servers.version = ?
        AND servers.text_comment = ?
        AND servers.last_seen = ?
        AND servers.is_public = ?
        AND servers.quic_host = ?
        AND servers.quic_port = ?
        AND servers.quic_cert_sha256 = ?
        AND servers.password_required = ?
        AND servers.rendezvous_token_hash = ?
        AND servers.rendezvous_generation = ?
        AND servers.directory_fingerprint = ?
        ${signedPredicate}`,
  ).bind(
    ...(publication.publisherAuthentication === "signed-certificate-v1"
      ? [publication.directoryProfile]
      : []),
    publication.serverId,
    publication.publisherAuthentication,
    publication.now,
    publication.generation,
    publication.name,
    publication.playersCount,
    publication.version,
    publication.textComment,
    publication.now,
    publication.isPublic ? 1 : 0,
    publication.quicHost,
    publication.quicPort,
    publication.quicCertSha256,
    publication.passwordRequired ? 1 : 0,
    publication.tokenHash,
    publication.generation,
    publication.directoryFingerprint,
    ...(publication.publisherAuthentication === "signed-certificate-v1"
      ? [
        publication.publisherSequence,
        publication.publisherNonce,
        publication.commitToken,
      ]
      : []),
  ).first<PublicationMatchRecord>();
  return record?.matches === 1;
}
