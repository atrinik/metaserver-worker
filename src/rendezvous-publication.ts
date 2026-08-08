import type { InternalRendezvousPublication } from "./rendezvous-contract";

interface PublishedGenerationRecord {
  readonly rendezvous_generation: string;
}

interface PublicationMatchRecord {
  readonly matches: number;
}

const TOKEN_GENERATION = /^[0-9a-f]{64}$/;

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

export async function persistRendezvousPublication(
  db: D1Database,
  publication: InternalRendezvousPublication,
): Promise<void> {
  const persisted = await db.batch([
    db.prepare(
      `UPDATE server_owners
          SET current_ip = '',
              ip_changed_at = CASE WHEN current_ip <> '' THEN ? ELSE ip_changed_at END,
              updated_at = ?,
              rendezvous_generation = ?
        WHERE server_id = ?`,
    ).bind(
      publication.now,
      publication.now,
      publication.generation,
      publication.serverId,
    ),
    db.prepare(
      `INSERT INTO servers
         (server_id, source_ip, name, players_count, version, text_comment,
          last_seen, is_public, quic_host, quic_port, quic_cert_sha256,
          password_required, rendezvous_token_hash, rendezvous_generation)
       SELECT ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         FROM server_owners
        WHERE server_id = ? AND rendezvous_generation = ?
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
         rendezvous_generation = excluded.rendezvous_generation`,
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
      publication.serverId,
      publication.generation,
    ),
  ]);
  if (
    persisted.length !== 2 ||
    persisted.some((result) => !result.success) ||
    persisted.some((result) => result.meta.changes !== 1)
  ) {
    throw new Error("Server update did not persist every required mutation");
  }
}

export async function rendezvousPublicationMatches(
  db: D1Database,
  publication: InternalRendezvousPublication,
): Promise<boolean> {
  const record = await db.prepare(
    `SELECT COUNT(*) AS matches
       FROM servers AS servers
       JOIN server_owners AS owners USING (server_id)
      WHERE servers.server_id = ?
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
        AND servers.rendezvous_generation = ?`,
  ).bind(
    publication.serverId,
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
  ).first<PublicationMatchRecord>();
  return record?.matches === 1;
}
