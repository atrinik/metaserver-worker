import type { AccessProfile } from "./access-route-auth";
import type { RendezvousReplayTags } from "./privacy";

interface ResolvedTarget {
  profile: AccessProfile;
  server_id: string;
  certificate: string;
  name: string;
  hostname: string | null;
  port: number | null;
  generation: string;
  expires_at: number;
}
export interface GrantRedemption {
  route_index: string;
  token_revision: string;
  generation: string;
  expires_at: number;
  redemption_id: string;
}
const PROFILE_JOIN = `presence.profile=CASE route.profile WHEN 'classic' THEN 'classic-v3' ELSE 'game-v2' END
  AND presence.server_id=route.server_id`;

/** All grants are created only for a current protected signed target. */
export async function issueAccessGrant(
  db: D1Database, index: string, clientNonce: string, tags: RendezvousReplayTags,
  expectedGeneration: string, now: number, freshness: number,
): Promise<ResolvedTarget | null> {
  const results = await db.batch([
    db.prepare(`DELETE FROM access_grants WHERE tag_current IN (
      SELECT tag_current FROM access_grants WHERE expires_at<=? LIMIT 256)`).bind(now),
    db.prepare(`UPDATE access_routes SET state='expired', revoked_at=?
      WHERE route_index=? AND state='active' AND expires_at IS NOT NULL AND expires_at<=?`).bind(now, index, now),
    db.prepare(`INSERT INTO access_grants(tag_current,tag_previous,route_index,profile,server_id,
      token_revision,generation,client_nonce,expires_at,redemption_id)
      SELECT ?,?,route.route_index,route.profile,route.server_id,route.token_revision,
        presence.rendezvous_generation,?,?,NULL
      FROM access_routes route JOIN server_presence presence ON ${PROFILE_JOIN}
      WHERE route.route_index=? AND route.state='active' AND
        (route.expires_at IS NULL OR route.expires_at>?) AND presence.last_seen>?
        AND presence.access_required=1 AND presence.rendezvous_generation=?
        AND presence.certificate IS NOT NULL AND presence.name IS NOT NULL
        AND (SELECT count(*) FROM access_grants)<32768
        AND (SELECT count(*) FROM access_grants WHERE profile=route.profile AND server_id=route.server_id)<32
        AND NOT EXISTS(SELECT 1 FROM access_grants WHERE tag_current IN (?,?) OR tag_previous IN (?,?))`
    ).bind(tags[0], tags[1], clientNonce, now + 15, index, now, now - freshness,
      expectedGeneration, ...tags, ...tags),
    db.prepare(`SELECT route.profile,route.server_id,presence.certificate,presence.name,
      presence.hostname,presence.port,grant_row.generation,grant_row.expires_at
      FROM access_grants grant_row JOIN access_routes route ON route.route_index=grant_row.route_index
      JOIN server_presence presence ON ${PROFILE_JOIN}
      WHERE grant_row.tag_current=? AND grant_row.tag_previous=?
        AND grant_row.client_nonce=? AND grant_row.generation=? AND grant_row.expires_at=?`
    ).bind(...tags, clientNonce, expectedGeneration, now + 15),
  ]);
  if (results.some((result) => !result.success)) throw new Error("Access grant transaction failed");
  if (results[2].meta.changes !== 1) return null;
  return (results[3].results[0] as unknown as ResolvedTarget | undefined) ?? null;
}

/** One conditional write is the linearization point shared with revocation. */
export async function redeemAccessGrant(
  db: D1Database, profile: AccessProfile, serverId: string, generation: string,
  clientNonce: string, tags: RendezvousReplayTags, redemptionId: string,
  now: number, freshness: number,
): Promise<GrantRedemption | null> {
  const row = await db.prepare(`UPDATE access_grants SET redemption_id=?
    WHERE profile=? AND server_id=? AND generation=? AND client_nonce=?
      AND expires_at>? AND redemption_id IS NULL
      AND (tag_current IN (?,?) OR tag_previous IN (?,?))
      AND EXISTS(SELECT 1 FROM access_routes route JOIN server_presence presence ON ${PROFILE_JOIN}
        WHERE route.route_index=access_grants.route_index AND route.state='active'
          AND route.token_revision=access_grants.token_revision AND
          (route.expires_at IS NULL OR route.expires_at>?) AND presence.access_required=1
          AND presence.last_seen>? AND presence.rendezvous_generation=access_grants.generation)
    RETURNING route_index,token_revision,generation,expires_at,redemption_id`).bind(
      redemptionId, profile, serverId, generation, clientNonce, now, ...tags, ...tags,
      now, now - freshness,
    ).first<GrantRedemption>();
  return row;
}

/** Recheck before every bounded candidate dispatch, including lost revoke events. */
export async function isAccessRedemptionLive(
  db: D1Database, redemptionId: string, generation: string, now: number, freshness: number,
): Promise<boolean> {
  const live = await db.prepare(`SELECT 1 AS live FROM access_grants grant_row
    JOIN access_routes route ON route.route_index=grant_row.route_index
    JOIN server_presence presence ON ${PROFILE_JOIN}
    WHERE grant_row.redemption_id=? AND grant_row.generation=? AND grant_row.expires_at>?
      AND route.state='active' AND route.token_revision=grant_row.token_revision
      AND (route.expires_at IS NULL OR route.expires_at>?) AND presence.access_required=1
      AND presence.last_seen>? AND presence.rendezvous_generation=grant_row.generation`).bind(
        redemptionId, generation, now, now, now - freshness,
      ).first<number>("live");
  return live === 1;
}
