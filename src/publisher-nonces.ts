/** Combined replay rows and slots reserved for eventual route revocations. */
export const PUBLISHER_NONCE_CAPACITY = 131072;
export const PUBLISHER_NONCE_CLEANUP_BATCH = 32;

/** Only internal SQL expressions, never request text, may supply growth. */
export function publisherNonceCapacity(growth = "1"): string {
  // Zero growth is only available to an effective first revocation. Allow it
  // even while a populated pre-capacity database drains its retained history.
  return `((${growth}) = 0 OR
    (SELECT count(*) FROM publisher_nonces) +
    (SELECT count(*) FROM access_routes WHERE state IN ('reserved','active')) +
    (${growth}) <= ${PUBLISHER_NONCE_CAPACITY})`;
}

/** Reclaim only expired evidence, in the same transaction as new admission. */
export function cleanupPublisherNonces(db: D1Database, now: number): D1PreparedStatement {
  return db.prepare(`DELETE FROM publisher_nonces WHERE (server_id,profile,nonce) IN (
    SELECT server_id,profile,nonce FROM publisher_nonces WHERE expires_at<=?
    ORDER BY expires_at LIMIT ${PUBLISHER_NONCE_CLEANUP_BATCH})`).bind(now);
}
