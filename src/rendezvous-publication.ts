import type { DirectoryProfile } from "./directory-state";
import { gameDirectoryServerJsonByteLength } from "./directory-artifacts";
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

export async function readPublishedGeneration(
  db: D1Database,
  profile: DirectoryProfile,
  serverId: string,
): Promise<string | null> {
  const record = await db.prepare(
    `SELECT rendezvous_generation
       FROM server_presence
      WHERE profile = ? AND server_id = ?`,
  ).bind(profile, serverId).first<PublishedGenerationRecord>();
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
  profile: DirectoryProfile,
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
  return persistSignedPublication(db, publication);
}

async function persistSignedPublication(
  db: D1Database,
  publication: InternalRendezvousPublication,
): Promise<PublicationPersistenceResult> {
  const sequence = publication.publisherSequence;
  const nonce = publication.publisherNonce;
  const nonceExpiresAt = publication.publisherNonceExpiresAt;

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
        WHERE ${signedCommitGuard()}`,
    ).bind(
      publication.serverId,
      publication.directoryProfile,
      nonce,
      nonceExpiresAt,
      publication.now,
      ...signedGuardBindings(publication),
    ),
    presenceMutation(db, publication),
    visibleRevisionStatement(db, publication),
    visibleOutboxStatement(db, publication),
    directoryEntryMutation(db, publication),
    publicationAssertion(db, publication),
  ]);

  requireBatchResults(persisted, 7);
  const accepted = changes(persisted, 0) === 1;
  if (!accepted) {
    if (persisted.some((_, index) => index > 0 && changes(persisted, index) !== 0)) {
      throw new Error("Rejected replay mutated publication state");
    }
    return { accepted: false, visibleChanged: false };
  }
  if (changes(persisted, 1) !== 1) {
    throw new Error("Signed publication did not persist required state");
  }
  if (changes(persisted, 6) !== 0) {
    throw new Error("Signed publication assertion produced durable state");
  }
  requireDirectoryMutationResults(persisted, publication, 5, 2);
  return publicationResult(persisted, 3, 4);
}

function publicationResult(
  results: readonly D1Result<unknown>[],
  revisionIndex: number,
  outboxIndex: number,
): PublicationPersistenceResult {
  const revisionChanges = changes(results, revisionIndex);
  const outboxChanges = changes(results, outboxIndex);
  if (
    revisionChanges > 1 ||
    (revisionChanges === 0 && outboxChanges !== 0) ||
    (revisionChanges === 1 && (outboxChanges < 1 || outboxChanges > 2))
  ) {
    throw new Error("Directory revision and outbox diverged");
  }
  return { accepted: true, visibleChanged: revisionChanges === 1 };
}

function requireDirectoryMutationResults(
  results: readonly D1Result<unknown>[],
  publication: InternalRendezvousPublication,
  entryIndex: number,
  presenceIndex: number,
): void {
  for (const index of [entryIndex, presenceIndex]) {
    const value = changes(results, index);
    const required = index === presenceIndex ||
      publication.isPublic;
    if (
      value > 1 ||
      (required && value !== 1)
    ) {
      throw new Error("Publication did not persist its directory state");
    }
  }
}

function visibleRevisionStatement(
  db: D1Database,
  publication: InternalRendezvousPublication,
): D1PreparedStatement {
  return db.prepare(
    `UPDATE directory_revisions
        SET revision = (
              SELECT presence.publication_visible_revision
                FROM server_presence AS presence
               WHERE presence.profile = directory_revisions.profile
                 AND presence.server_id = ?
                 AND presence.publication_commit_token = ?
            ),
            updated_at = max(updated_at, ?)
      WHERE profile = ?
        AND EXISTS (
          SELECT 1 FROM server_presence AS presence
           WHERE presence.profile = directory_revisions.profile
             AND presence.server_id = ?
             AND presence.publication_commit_token = ?
             AND presence.publication_visible_revision =
                 directory_revisions.revision + 1
        )`,
  ).bind(
    publication.serverId,
    publication.commitToken,
    publication.now,
    publication.directoryProfile,
    publication.serverId,
    publication.commitToken,
  );
}

function visibleOutboxStatement(
  db: D1Database,
  publication: InternalRendezvousPublication,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO directory_outbox (profile, revision, created_at)
     SELECT revisions.profile, revisions.revision, ?
       FROM directory_revisions AS revisions
       JOIN server_presence AS presence
         ON presence.profile = revisions.profile
        AND presence.server_id = ?
      WHERE revisions.profile = ?
        AND presence.publication_commit_token = ?
        AND presence.publication_visible_revision = revisions.revision
        AND presence.publication_visible_revision =
            presence.publication_base_revision + 1`,
  ).bind(
    publication.now,
    publication.serverId,
    publication.directoryProfile,
    publication.commitToken,
  );
}

function directoryEntryMutation(
  db: D1Database,
  publication: InternalRendezvousPublication,
): D1PreparedStatement {
  if (!publication.isPublic) {
    return db.prepare(
      `DELETE FROM directory_entries
        WHERE profile = ? AND server_id = ?
          ${publicationPresenceGuard("AND")}`,
    ).bind(
      publication.directoryProfile,
      publication.serverId,
      ...publicationPresenceBindings(publication),
    );
  }
  if (publication.directoryProfile === "game-v1") {
    const gameJsonBytes = gamePublicationJsonByteLength(publication);
    return db.prepare(
      `INSERT INTO directory_entries
         (profile, server_id, name, players_count, version, text_comment,
          description, region, protocol_major, protocol_minor, content_id,
          content_revision_sha256, players_online, players_capacity, status,
          game_json_bytes, hostname, port, quic_cert_sha256, password_required,
          directory_fingerprint)
       SELECT ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE ${publicationPresenceGuard()}
       ON CONFLICT(profile, server_id) DO UPDATE SET
         name = excluded.name,
         players_count = NULL,
         version = NULL,
         text_comment = NULL,
         description = excluded.description,
         region = excluded.region,
         protocol_major = excluded.protocol_major,
         protocol_minor = excluded.protocol_minor,
         content_id = excluded.content_id,
         content_revision_sha256 = excluded.content_revision_sha256,
         players_online = excluded.players_online,
         players_capacity = excluded.players_capacity,
         status = excluded.status,
         game_json_bytes = excluded.game_json_bytes,
         hostname = excluded.hostname,
         port = excluded.port,
         quic_cert_sha256 = excluded.quic_cert_sha256,
         password_required = excluded.password_required,
         directory_fingerprint = excluded.directory_fingerprint`,
    ).bind(
      publication.directoryProfile,
      publication.serverId,
      publication.name,
      publication.description,
      publication.region,
      publication.protocolMajor,
      publication.protocolMinor,
      publication.contentId,
      publication.contentRevisionSha256,
      publication.playersOnline,
      publication.playersCapacity,
      publication.status,
      gameJsonBytes,
      publication.quicHost === "" ? null : publication.quicHost,
      publication.quicHost === "" ? null : publication.quicPort,
      publication.quicCertSha256,
      publication.passwordRequired ? 1 : 0,
      publication.directoryFingerprint,
      ...publicationPresenceBindings(publication),
    );
  }
  return db.prepare(
    `INSERT INTO directory_entries
       (profile, server_id, name, players_count, version, text_comment,
        hostname, port, quic_cert_sha256, password_required,
        directory_fingerprint)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE ${publicationPresenceGuard()}
     ON CONFLICT(profile, server_id) DO UPDATE SET
       name = excluded.name,
       players_count = excluded.players_count,
       version = excluded.version,
       text_comment = excluded.text_comment,
       hostname = excluded.hostname,
       port = excluded.port,
       quic_cert_sha256 = excluded.quic_cert_sha256,
       password_required = excluded.password_required,
       directory_fingerprint = excluded.directory_fingerprint`,
  ).bind(
    publication.directoryProfile,
    publication.serverId,
    publication.name,
    publication.playersCount,
    publication.version,
    publication.textComment,
    publication.quicHost === "" ? null : publication.quicHost,
    publication.quicHost === "" ? null : publication.quicPort,
    publication.quicCertSha256,
    publication.passwordRequired ? 1 : 0,
    publication.directoryFingerprint,
    ...publicationPresenceBindings(publication),
  );
}

function presenceMutation(
  db: D1Database,
  publication: InternalRendezvousPublication,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO server_presence
       (profile, server_id, last_seen, rendezvous_token_hash,
        rendezvous_generation, publication_commit_token,
        publication_base_revision, publication_visible_revision)
     SELECT ?, ?, ?, ?, ?, ?, revisions.revision,
            CASE
              WHEN ${visibleContentChangedPredicate()}
              THEN revisions.revision + 1
              ELSE NULL
            END
      FROM directory_revisions AS revisions
      WHERE revisions.profile = ?
        AND ${signedCommitGuard()}
     ON CONFLICT(profile, server_id) DO UPDATE SET
       last_seen = excluded.last_seen,
       rendezvous_token_hash = excluded.rendezvous_token_hash,
       rendezvous_generation = excluded.rendezvous_generation,
       publication_commit_token = excluded.publication_commit_token,
       publication_base_revision = excluded.publication_base_revision,
       publication_visible_revision = excluded.publication_visible_revision`,
  ).bind(
    publication.directoryProfile,
    publication.serverId,
    publication.now,
    publication.tokenHash,
    publication.generation,
    publication.commitToken,
    ...visiblePredicateBindings(publication),
    publication.directoryProfile,
    ...signedGuardBindings(publication),
  );
}

function signedCommitGuard(prefix = ""): string {
  return `${prefix} EXISTS (
    SELECT 1 FROM publisher_replay
     WHERE server_id = ? AND profile = ? AND commit_token = ?
  )`;
}

function signedGuardBindings(
  publication: InternalRendezvousPublication,
): readonly [string, DirectoryProfile, string] {
  return [
    publication.serverId,
    publication.directoryProfile,
    publication.commitToken,
  ];
}

function publicationPresenceGuard(prefix = ""): string {
  return `${prefix} EXISTS (
    SELECT 1 FROM server_presence
     WHERE profile = ? AND server_id = ?
       AND publication_commit_token = ?
  )`;
}

function publicationPresenceBindings(
  publication: InternalRendezvousPublication,
): readonly [DirectoryProfile, string, string] {
  return [
    publication.directoryProfile,
    publication.serverId,
    publication.commitToken,
  ];
}

function visibleContentChangedPredicate(): string {
  return `(
    (? = 1 AND NOT EXISTS (
      SELECT 1
        FROM directory_entries AS entries
        JOIN server_presence AS presence
          ON presence.profile = entries.profile
         AND presence.server_id = entries.server_id
       WHERE entries.profile = ?
         AND entries.server_id = ?
         AND presence.last_seen > ?
         AND entries.directory_fingerprint = ?
    )) OR
    (? = 0 AND EXISTS (
      SELECT 1 FROM directory_entries
       WHERE profile = ? AND server_id = ?
    ))
  )`;
}

function visiblePredicateBindings(
  publication: InternalRendezvousPublication,
): readonly [number, DirectoryProfile, string, number, string, number, DirectoryProfile, string] {
  const isPublic = publication.isPublic ? 1 : 0;
  return [
    isPublic,
    publication.directoryProfile,
    publication.serverId,
    publication.visibilityCutoff,
    publication.directoryFingerprint,
    isPublic,
    publication.directoryProfile,
    publication.serverId,
  ];
}

interface SqlPredicate {
  readonly sql: string;
  readonly bindings: readonly unknown[];
}

function publicationAssertion(
  db: D1Database,
  publication: InternalRendezvousPublication,
): D1PreparedStatement {
  const accepted = {
    sql: signedCommitGuard(),
    bindings: signedGuardBindings(publication),
  };
  const predicates = [
    publicationAuthenticationPredicate(publication),
    publicationPresencePredicate(publication),
    publicationEntryPredicate(publication),
  ];
  return db.prepare(
    `INSERT INTO directory_transaction_assertions (assertion)
     SELECT 0
      WHERE ${accepted.sql}
        AND NOT (${predicates.map((predicate) => predicate.sql).join(" AND ")})`,
  ).bind(
    ...accepted.bindings,
    ...predicates.flatMap((predicate) => predicate.bindings),
  );
}

function publicationAuthenticationPredicate(
  publication: InternalRendezvousPublication,
): SqlPredicate {
  return {
    sql: `EXISTS (
      SELECT 1 FROM publisher_nonces AS nonces
       WHERE nonces.server_id = ? AND nonces.profile = ?
         AND nonces.nonce = ? AND nonces.expires_at = ?
    )`,
    bindings: [
      publication.serverId,
      publication.directoryProfile,
      publication.publisherNonce,
      publication.publisherNonceExpiresAt,
    ],
  };
}

function publicationPresencePredicate(
  publication: InternalRendezvousPublication,
): SqlPredicate {
  return {
    sql: `EXISTS (
      SELECT 1
        FROM server_presence AS presence
        JOIN directory_revisions AS revisions
          ON revisions.profile = presence.profile
       WHERE presence.profile = ? AND presence.server_id = ?
         AND presence.last_seen = ?
         AND presence.rendezvous_token_hash = ?
         AND presence.rendezvous_generation = ?
         AND presence.publication_commit_token = ?
         AND (
           (
             presence.publication_visible_revision IS NULL AND
             revisions.revision = presence.publication_base_revision
           ) OR (
             presence.publication_visible_revision =
                 presence.publication_base_revision + 1 AND
             revisions.revision = presence.publication_visible_revision AND
             EXISTS (
               SELECT 1 FROM directory_outbox AS outbox
                WHERE outbox.profile = presence.profile
                  AND outbox.revision = presence.publication_visible_revision
                  AND outbox.created_at = ?
             ) AND NOT EXISTS (
               SELECT 1 FROM directory_outbox AS obsolete
                WHERE obsolete.profile = presence.profile
                  AND obsolete.revision <>
                      presence.publication_visible_revision
             )
           )
         )
    )`,
    bindings: [
      publication.directoryProfile,
      publication.serverId,
      publication.now,
      publication.tokenHash,
      publication.generation,
      publication.commitToken,
      publication.now,
    ],
  };
}

function publicationEntryPredicate(
  publication: InternalRendezvousPublication,
): SqlPredicate {
  if (!publication.isPublic) {
    return {
      sql: `NOT EXISTS (
        SELECT 1 FROM directory_entries
         WHERE profile = ? AND server_id = ?
      )`,
      bindings: [publication.directoryProfile, publication.serverId],
    };
  }
  if (publication.directoryProfile === "game-v1") {
    const gameJsonBytes = gamePublicationJsonByteLength(publication);
    return {
      sql: `EXISTS (
        SELECT 1 FROM directory_entries AS entries
         WHERE entries.profile = ? AND entries.server_id = ?
           AND entries.name = ?
           AND entries.players_count IS NULL AND entries.version IS NULL
           AND entries.text_comment IS NULL
           AND entries.description = ? AND entries.region IS ?
           AND entries.protocol_major = ? AND entries.protocol_minor = ?
           AND entries.content_id = ?
           AND entries.content_revision_sha256 = ?
           AND entries.players_online = ? AND entries.players_capacity = ?
           AND entries.status = ?
           AND entries.game_json_bytes = ?
           AND entries.hostname IS ? AND entries.port IS ?
           AND entries.quic_cert_sha256 = ?
           AND entries.password_required = ?
           AND entries.directory_fingerprint = ?
      )`,
      bindings: [
        publication.directoryProfile,
        publication.serverId,
        publication.name,
        publication.description,
        publication.region,
        publication.protocolMajor,
        publication.protocolMinor,
        publication.contentId,
        publication.contentRevisionSha256,
        publication.playersOnline,
        publication.playersCapacity,
        publication.status,
        gameJsonBytes,
        publication.quicHost === "" ? null : publication.quicHost,
        publication.quicHost === "" ? null : publication.quicPort,
        publication.quicCertSha256,
        publication.passwordRequired ? 1 : 0,
        publication.directoryFingerprint,
      ],
    };
  }
  return {
    sql: `EXISTS (
      SELECT 1 FROM directory_entries AS entries
       WHERE entries.profile = ? AND entries.server_id = ?
         AND entries.name = ? AND entries.players_count = ?
         AND entries.version = ? AND entries.text_comment = ?
         AND entries.hostname IS ? AND entries.port IS ?
         AND entries.quic_cert_sha256 = ?
         AND entries.password_required = ?
         AND entries.directory_fingerprint = ?
    )`,
    bindings: [
      publication.directoryProfile,
      publication.serverId,
      publication.name,
      publication.playersCount,
      publication.version,
      publication.textComment,
      publication.quicHost === "" ? null : publication.quicHost,
      publication.quicHost === "" ? null : publication.quicPort,
      publication.quicCertSha256,
      publication.passwordRequired ? 1 : 0,
      publication.directoryFingerprint,
    ],
  };
}

function gamePublicationJsonByteLength(
  publication: Extract<
    InternalRendezvousPublication,
    { directoryProfile: "game-v1" }
  >,
): number {
  return gameDirectoryServerJsonByteLength({
    serverId: publication.serverId,
    certificateSha256: publication.quicCertSha256,
    name: publication.name,
    description: publication.description,
    ...(publication.region === null ? {} : { region: publication.region }),
    protocol: { major: 1, minor: publication.protocolMinor },
    content: {
      id: publication.contentId,
      revisionSha256: publication.contentRevisionSha256,
    },
    players: {
      online: publication.playersOnline,
      capacity: publication.playersCapacity,
    },
    status: publication.status,
    passwordRequired: publication.passwordRequired,
    ...(publication.quicHost === ""
      ? {}
      : {
        endpoint: {
          hostname: publication.quicHost,
          port: publication.quicPort,
        },
      }),
  });
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
  const replay = await db.prepare(
      `SELECT COUNT(*) AS matches
         FROM publisher_replay AS replay
        WHERE replay.server_id = ? AND replay.profile = ?
          AND replay.last_sequence = ?
          AND replay.last_nonce = ?
          AND replay.commit_token = ?
          AND EXISTS (
            SELECT 1 FROM publisher_nonces AS nonces
             WHERE nonces.server_id = replay.server_id
               AND nonces.profile = replay.profile
               AND nonces.nonce = replay.last_nonce
          )`,
    ).bind(
      publication.serverId,
      publication.directoryProfile,
      publication.publisherSequence,
      publication.publisherNonce,
      publication.commitToken,
    ).first<PublicationMatchRecord>();
  if (replay?.matches !== 1) {
    return false;
  }

  const committedPresence = publicationPresencePredicate(publication);
  const committed = await db.prepare(
    `SELECT COUNT(*) AS matches WHERE ${committedPresence.sql}`,
  ).bind(...committedPresence.bindings).first<PublicationMatchRecord>();
  if (committed?.matches !== 1) {
    return false;
  }

  const exactState = [publicationEntryPredicate(publication)];
  const record = await db.prepare(
    `SELECT COUNT(*) AS matches
      WHERE ${exactState.map((predicate) => predicate.sql).join(" AND ")}`,
  ).bind(
    ...exactState.flatMap((predicate) => predicate.bindings),
  ).first<PublicationMatchRecord>();
  return record?.matches === 1;
}
