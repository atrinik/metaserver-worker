import type { AccessRoutePayload } from "./access-route-auth";
import { randomToken, sha256Hex } from "./protocol";

const RETENTION_SECONDS = 90 * 86400;
export type AccessRouteOutcome = "reserved" | "active" | "revoked" | "conflict" |
  "expired" | "not_found" | "unavailable";
export interface AccessRouteResult {
  readonly schema: "atrinik-access-route-result-v1";
  readonly requestId: string;
  readonly outcome: AccessRouteOutcome;
  readonly reservationId: string | null;
  readonly reservationExpiresAt: string | null;
  readonly tokenRevision: string;
}
interface Receipt {
  request_digest: string;
  tuple_digest: string;
  outcome: AccessRouteOutcome;
  reservation_id: string | null;
  reservation_expires_at: number | null;
  token_revision: string;
}
interface SignedMutation {
  readonly payload: AccessRoutePayload;
  readonly sequence: string;
  readonly nonce: string;
  readonly nonceExpiresAt: number;
}

/**
 * Authenticated business mutation and its receipt share one D1 transaction.
 * The publisher replay row is the transaction fence; no preceding JS read
 * authorizes a write. Request retries require a fresh signature and sequence.
 */
export async function mutateAccessRoute(
  db: D1Database, authenticated: SignedMutation, now: number,
): Promise<AccessRouteResult> {
  const p = authenticated.payload;
  const profile = p.profile === "classic" ? "classic-v3" : "game-v2";
  const commit = randomToken();
  const handle = randomToken().slice(0, 32);
  const requestDigest = await sha256Hex(JSON.stringify(p));
  const { operation: _operation, ...tuple } = p;
  const tupleDigest = await sha256Hex(JSON.stringify(tuple));
  const expiry = p.expiresAt === null ? null : Number(p.expiresAt);
  const fence = `EXISTS (SELECT 1 FROM publisher_replay WHERE server_id = ? AND
    profile = ? AND commit_token = ? AND last_sequence = ? AND last_nonce = ?)`;
  const fenceValues = [p.serverId, profile, commit, authenticated.sequence, authenticated.nonce];
  const receiptFence = `EXISTS (SELECT 1 FROM access_route_receipts WHERE profile = ? AND
    server_id = ? AND request_id = ? AND commit_token = ? AND outcome = ?)`;
  const receiptValues = (outcome: AccessRouteOutcome) => [p.profile, p.serverId, p.requestId, commit, outcome];

  const statements = [db.prepare(
    `INSERT INTO publisher_replay(server_id, profile, last_sequence, last_nonce, commit_token, updated_at)
     SELECT ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (
       SELECT 1 FROM publisher_nonces WHERE server_id = ? AND profile = ? AND nonce = ?
     ) ON CONFLICT(server_id, profile) DO UPDATE SET
       last_sequence = excluded.last_sequence, last_nonce = excluded.last_nonce,
       commit_token = excluded.commit_token, updated_at = excluded.updated_at
     WHERE (length(excluded.last_sequence) > length(last_sequence) OR
       (length(excluded.last_sequence) = length(last_sequence) AND excluded.last_sequence > last_sequence))
       AND NOT EXISTS (SELECT 1 FROM publisher_nonces WHERE server_id = excluded.server_id
         AND profile = excluded.profile AND nonce = excluded.last_nonce)`,
  ).bind(p.serverId, profile, authenticated.sequence, authenticated.nonce, commit, now,
    p.serverId, profile, authenticated.nonce),
  db.prepare(`INSERT INTO publisher_nonces(server_id,profile,nonce,expires_at,created_at)
    SELECT ?,?,?,?,? WHERE ${fence}`).bind(p.serverId, profile, authenticated.nonce,
      authenticated.nonceExpiresAt, now, ...fenceValues)];

  if (p.operation !== "result") {
    // Capacity reserves one eventual revocation receipt for every nonterminal
    // row. Converting a live row to a tombstone plus receipt leaves the sum
    // unchanged, including when every other receipt slot has been consumed.
    statements.push(db.prepare(
      `WITH input AS (SELECT ? AS profile, ? AS server_id, ? AS request_id,
          ? AS request_digest, ? AS tuple_digest, ? AS operation, ? AS token_id,
          ? AS token_revision, ? AS route_index, ? AS handle, ? AS expires_at,
          ? AS now, ? AS new_handle),
       state AS (SELECT input.*, r.profile AS old_profile, r.server_id AS old_server,
          r.token_id AS old_token, r.token_revision AS old_revision, r.state AS old_state,
          r.reservation_id AS old_handle, r.reserved_until AS old_until,
          r.expires_at AS old_expiry,
          EXISTS(SELECT 1 FROM access_routes t WHERE t.profile=input.profile AND
            t.server_id=input.server_id AND t.token_id=input.token_id AND
            t.route_index<>input.route_index) AS token_conflict
          FROM input LEFT JOIN access_routes r ON r.route_index=input.route_index),
       decision AS (SELECT state.*, CASE
          WHEN token_conflict OR (old_profile IS NOT NULL AND
            (old_profile<>profile OR old_server<>server_id OR old_token<>token_id)) THEN 'conflict'
          WHEN operation='reserve' AND old_profile IS NOT NULL THEN 'conflict'
          WHEN operation='reserve' AND expires_at IS NOT NULL AND expires_at<=now THEN 'expired'
          WHEN operation='reserve' AND NOT EXISTS (
            SELECT 1 FROM server_presence WHERE profile=? AND server_id=state.server_id
          ) THEN 'unavailable'
          WHEN operation='reserve' AND (
            (SELECT count(*) FROM access_routes)>=65536 OR
            (SELECT count(*) FROM access_routes WHERE profile=state.profile AND server_id=state.server_id)>=4096 OR
            (SELECT count(*) FROM access_routes WHERE profile=state.profile AND server_id=state.server_id
              AND state IN ('reserved','active'))>=1024) THEN 'unavailable'
          WHEN operation='reserve' THEN 'reserved'
          WHEN operation='activate' AND old_profile IS NULL THEN 'not_found'
          WHEN operation='activate' AND (old_revision<>token_revision OR old_handle<>handle OR
            old_expiry IS NOT expires_at) THEN 'conflict'
          WHEN operation='activate' AND (old_state='expired' OR old_until<=now OR
            (old_expiry IS NOT NULL AND old_expiry<=now)) THEN 'expired'
          WHEN operation='activate' AND old_state<>'reserved' THEN 'conflict'
          WHEN operation='activate' THEN 'active'
          WHEN operation='revoke' AND old_profile IS NULL AND (
            (SELECT count(*) FROM access_routes)>=65536 OR
            (SELECT count(*) FROM access_routes WHERE profile=state.profile AND server_id=state.server_id)>=4096)
            THEN 'unavailable'
          WHEN operation='revoke' THEN 'revoked'
          ELSE 'unavailable' END AS result FROM state),
       budget AS (SELECT decision.*, CASE WHEN result='reserved' THEN 2
          WHEN result='revoked' AND old_state IN ('reserved','active') THEN 0 ELSE 1 END AS growth
          FROM decision)
       INSERT INTO access_route_receipts(profile,server_id,request_id,request_digest,tuple_digest,
          operation,token_id,outcome,reservation_id,reservation_expires_at,token_revision,
          commit_token,created_at,expires_at)
       SELECT profile,server_id,request_id,request_digest,tuple_digest,operation,token_id,result,
          CASE WHEN result='reserved' THEN new_handle ELSE old_handle END,
          CASE WHEN result='reserved' THEN now+60 ELSE old_until END,
          CASE WHEN result='revoked' AND old_revision IS NOT NULL AND
            (length(old_revision)>length(token_revision) OR
             (length(old_revision)=length(token_revision) AND old_revision>token_revision))
            THEN old_revision ELSE token_revision END, ?, now, now+?
       FROM budget WHERE ${fence}
        AND NOT EXISTS (SELECT 1 FROM access_route_receipts WHERE profile=budget.profile
          AND server_id=budget.server_id AND request_id=budget.request_id)
        AND (SELECT count(*) FROM access_route_receipts) +
          (SELECT count(*) FROM access_routes WHERE state IN ('reserved','active')) + growth <=65536
        AND (SELECT count(*) FROM access_route_receipts WHERE profile=budget.profile AND server_id=budget.server_id) +
          (SELECT count(*) FROM access_routes WHERE profile=budget.profile AND server_id=budget.server_id
            AND state IN ('reserved','active')) + growth <=4096`,
    ).bind(p.profile, p.serverId, p.requestId, requestDigest, tupleDigest, p.operation,
      p.tokenId, p.tokenRevision, p.index, p.reservationId, expiry, now, handle,
      profile, commit, RETENTION_SECONDS, ...fenceValues));
    statements.push(db.prepare(
      `INSERT INTO access_routes(route_index,profile,server_id,token_id,token_revision,state,
          expires_at,reservation_id,reserved_until,created_at,revoked_at)
       SELECT ?,?,?,?,?, 'reserved',?,?,?, ?,NULL WHERE ${receiptFence}`,
    ).bind(p.index, p.profile, p.serverId, p.tokenId, p.tokenRevision, expiry, handle,
      now + 60, now, ...receiptValues("reserved")));
    statements.push(db.prepare(
      `UPDATE access_routes SET state='active' WHERE route_index=? AND ${receiptFence}`,
    ).bind(p.index, ...receiptValues("active")));
    statements.push(db.prepare(
      `INSERT INTO access_routes(route_index,profile,server_id,token_id,token_revision,state,
          expires_at,reservation_id,reserved_until,created_at,revoked_at)
       SELECT ?,?,?,?,?, 'revoked',?,?,?, ?,? WHERE ${receiptFence}
       ON CONFLICT(route_index) DO UPDATE SET state='revoked',
         token_revision=CASE WHEN length(excluded.token_revision)>length(token_revision) OR
           (length(excluded.token_revision)=length(token_revision) AND excluded.token_revision>token_revision)
           THEN excluded.token_revision ELSE token_revision END,
         revoked_at=coalesce(revoked_at, excluded.revoked_at)`,
    ).bind(p.index, p.profile, p.serverId, p.tokenId, p.tokenRevision, expiry,
      p.reservationId, now + 60, now, now, ...receiptValues("revoked")));
    statements.push(db.prepare(
      `DELETE FROM access_grants WHERE route_index=? AND ${receiptFence}`,
    ).bind(p.index, ...receiptValues("revoked")));
    // Expired pending rows become terminal; expiry can never be undone by a
    // delayed activation or a later wall-clock regression.
    statements.push(db.prepare(
      `UPDATE access_routes SET state='expired', revoked_at=? WHERE route_index=?
        AND state IN ('reserved','active') AND ${receiptFence}`,
    ).bind(now, p.index, ...receiptValues("expired")));
  }
  statements.push(db.prepare(`SELECT request_digest,tuple_digest,outcome,reservation_id,
    reservation_expires_at,token_revision FROM access_route_receipts
    WHERE profile=? AND server_id=? AND request_id=? AND ${fence}`).bind(
      p.profile, p.serverId, p.requestId, ...fenceValues));
  const results = await db.batch(statements);
  if (results.some((result) => !result.success)) throw new Error("Access transaction failed");
  if (results[0].meta.changes !== 1 || results[1].meta.changes !== 1) {
    throw new Error("Access publisher replay rejected");
  }
  const receipt = results.at(-1)!.results[0] as Receipt | undefined;
  if (receipt === undefined) return result(p, p.operation === "result" ? "not_found" : "unavailable");
  if ((p.operation === "result" ? receipt.tuple_digest !== tupleDigest : receipt.request_digest !== requestDigest)) {
    return result(p, "conflict");
  }
  return { schema: "atrinik-access-route-result-v1", requestId: p.requestId,
    outcome: receipt.outcome, reservationId: receipt.reservation_id,
    reservationExpiresAt: receipt.reservation_expires_at === null ? null : String(receipt.reservation_expires_at),
    tokenRevision: receipt.token_revision };
}
function result(p: AccessRoutePayload, outcome: AccessRouteOutcome): AccessRouteResult {
  return { schema: "atrinik-access-route-result-v1", requestId: p.requestId, outcome,
    reservationId: null, reservationExpiresAt: null, tokenRevision: p.tokenRevision };
}

/** Fixed batches; callers schedule another bounded pass when expiry is backlogged. */
export async function cleanupAccessState(db: D1Database, now: number): Promise<void> {
  await db.batch([
    db.prepare(`DELETE FROM access_grants WHERE tag_current IN (
      SELECT tag_current FROM access_grants WHERE expires_at<=? LIMIT 256)`).bind(now),
    db.prepare(`UPDATE access_routes SET state='expired', revoked_at=?
      WHERE route_index IN (SELECT route_index FROM access_routes
        WHERE (state='reserved' AND reserved_until<=?) OR
          (state='active' AND expires_at IS NOT NULL AND expires_at<=?) LIMIT 256)`).bind(now, now, now),
    db.prepare(`DELETE FROM access_route_receipts WHERE (profile,server_id,request_id) IN (
      SELECT profile,server_id,request_id FROM access_route_receipts WHERE expires_at<=? LIMIT 256)`).bind(now),
    db.prepare(`DELETE FROM access_routes WHERE route_index IN (
      SELECT route_index FROM access_routes route WHERE state IN ('revoked','expired') AND revoked_at<=?
        AND NOT EXISTS(SELECT 1 FROM access_route_receipts receipt WHERE receipt.profile=route.profile
          AND receipt.server_id=route.server_id AND receipt.token_id=route.token_id) LIMIT 256)`).bind(now - RETENTION_SECONDS),
  ]);
}
