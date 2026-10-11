import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { AccessRoutePayload } from "../src/access-route-auth";
import { mutateAccessRoute } from "../src/access-route-state";
import { PUBLISHER_NONCE_CAPACITY, PUBLISHER_NONCE_CLEANUP_BATCH } from "../src/publisher-nonces";
import { persistRendezvousPublication } from "../src/rendezvous-publication";

const now = 1800000000;
const owner = "1".repeat(64);
const filler = "f".repeat(64);
const initial: AccessRoutePayload = {
  schema: "atrinik-access-route-v1", profile: "classic", serverId: owner,
  certificate: "AA==", operation: "result", requestId: "2".repeat(32),
  tokenId: "3".repeat(32), tokenRevision: "1", index: "4".repeat(64),
  reservationId: null, expiresAt: null,
};
const mutate = (payload: AccessRoutePayload, sequence: number, time = now) => mutateAccessRoute(env.DB, {
  payload, sequence: String(sequence), nonce: sequence.toString(16).padStart(32, "0"),
  nonceExpiresAt: time + 86400,
}, time);
const count = () => env.DB.prepare("SELECT count(*) AS n FROM publisher_nonces").first<number>("n");
const sequence = () => env.DB.prepare("SELECT last_sequence FROM publisher_replay WHERE server_id=? AND profile='classic-v3'")
  .bind(owner).first<string>("last_sequence");

async function seedNonces(rows: number, expiresAt = now + 86400, offset = 100) {
  await env.DB.prepare(`WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM n WHERE value<?)
    INSERT INTO publisher_nonces(server_id,profile,nonce,expires_at,created_at)
    SELECT ?,'game-v2',printf('%032x',value+?),?,? FROM n`)
    .bind(rows, filler, offset, expiresAt, now - 86400).run();
}

async function liveRoute() {
  await env.DB.prepare(`INSERT INTO access_routes(route_index,profile,server_id,token_id,token_revision,
    state,expires_at,reservation_id,reserved_until,created_at,revoked_at)
    VALUES(?,'classic',?,?,'1','active',NULL,NULL,?,?,NULL)`)
    .bind(initial.index, owner, initial.tokenId, now + 60, now).run();
}

beforeEach(async () => {
  await env.DB.batch(["access_grants", "access_route_receipts", "access_routes", "publisher_replay"].map(
    (table) => env.DB.prepare(`DELETE FROM ${table}`)));
  await env.DB.batch([
    env.DB.prepare("UPDATE publisher_nonce_capacity SET maximum_rows=?").bind(PUBLISHER_NONCE_CAPACITY),
    env.DB.prepare(`INSERT INTO publisher_replay VALUES(?,'classic-v3','1',?,?,?)`)
      .bind(owner, "1".repeat(32), "1".repeat(64), now),
    env.DB.prepare(`INSERT INTO publisher_replay VALUES(?,'game-v2','1',?,?,?)`)
      .bind(filler, "1".repeat(32), "1".repeat(64), now),
  ]);
});

describe("aggregate authenticated publisher nonce capacity", () => {
  it("linearizes cross-profile result traffic at the final slot without advancing rejected replay", async () => {
    await seedNonces(PUBLISHER_NONCE_CAPACITY - 1);
    const results = await Promise.allSettled([
      mutate(initial, 2),
      mutate({ ...initial, profile: "game", serverId: filler }, 2),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(await count()).toBe(PUBLISHER_NONCE_CAPACITY);
    const before = await sequence();
    await expect(mutate(initial, 3)).rejects.toMatchObject({ code: "conflict" });
    expect(await sequence()).toBe(before);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM access_route_receipts").first<number>("n")).toBe(0);
    await expect(seedNonces(1, now + 86400, PUBLISHER_NONCE_CAPACITY + 1000)).rejects.toThrow();
  }, 60000);

  it("reserves two slots before reserve, but permits one result slot", async () => {
    await seedNonces(PUBLISHER_NONCE_CAPACITY - 1);
    await expect(mutate({ ...initial, operation: "reserve" }, 2)).rejects.toMatchObject({ code: "conflict" });
    expect(await sequence()).toBe("1");
    expect((await mutate(initial, 2)).outcome).toBe("not_found");
    expect(await count()).toBe(PUBLISHER_NONCE_CAPACITY);
  }, 60000);

  it("keeps the reserved revocation slot unavailable to result, collision, and reused receipt requests", async () => {
    await liveRoute();
    await seedNonces(PUBLISHER_NONCE_CAPACITY - 1);
    await expect(mutate(initial, 2)).rejects.toThrow();
    await expect(mutate({ ...initial, operation: "revoke", tokenId: "a".repeat(32) }, 2)).rejects.toThrow();
    await env.DB.prepare(`INSERT INTO access_route_receipts VALUES(
      'classic',?,?,?,?,'revoke',?,'conflict',NULL,NULL,'1',?,?,?)`)
      .bind(owner, initial.requestId, "a".repeat(64), "b".repeat(64), initial.tokenId,
        "c".repeat(64), now, now + 86400).run();
    await expect(mutate({ ...initial, operation: "revoke" }, 2)).rejects.toThrow();
    expect(await sequence()).toBe("1");
    expect((await mutate({ ...initial, operation: "revoke", requestId: "5".repeat(32) }, 2)).outcome).toBe("revoked");
    expect(await count()).toBe(PUBLISHER_NONCE_CAPACITY);
    expect(await env.DB.prepare("SELECT state FROM access_routes WHERE route_index=?")
      .bind(initial.index).first<string>("state")).toBe("revoked");
    await expect(mutate({ ...initial, operation: "revoke", requestId: "6".repeat(32) }, 3)).rejects.toThrow();
  }, 60000);

  it("reclaims at most one fixed batch and preserves unexpired replay evidence", async () => {
    await seedNonces(PUBLISHER_NONCE_CAPACITY - 40);
    await seedNonces(40, now, PUBLISHER_NONCE_CAPACITY + 1000);
    expect((await mutate(initial, 2)).outcome).toBe("not_found");
    expect(await count()).toBe(PUBLISHER_NONCE_CAPACITY - PUBLISHER_NONCE_CLEANUP_BATCH + 1);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM publisher_nonces WHERE expires_at<=?")
      .bind(now).first<number>("n")).toBe(40 - PUBLISHER_NONCE_CLEANUP_BATCH);
    await expect(mutateAccessRoute(env.DB, {
      payload: initial, sequence: "3", nonce: "2".padStart(32, "0"), nonceExpiresAt: now + 86400,
    }, now)).rejects.toThrow();
    expect(await sequence()).toBe("2");
  }, 60000);

  it("permits zero-growth revocation while grandfathered populated history drains", async () => {
    await liveRoute();
    // Equivalent to migration 0016 applied with cap+1 retained nonces and
    // one preexisting live route; the Python upgrade test proves that value.
    await env.DB.prepare("UPDATE publisher_nonce_capacity SET maximum_rows=?")
      .bind(PUBLISHER_NONCE_CAPACITY + 2).run();
    await seedNonces(PUBLISHER_NONCE_CAPACITY + 1);
    await expect(mutate(initial, 2)).rejects.toThrow();
    expect((await mutate({ ...initial, operation: "revoke" }, 2)).outcome).toBe("revoked");
    expect(await count()).toBe(PUBLISHER_NONCE_CAPACITY + 2);
    await expect(mutate(initial, 3)).rejects.toThrow();
    expect(await sequence()).toBe("2");
  }, 60000);

  it("applies the same capacity and bounded reclamation to signed publications", async () => {
    await seedNonces(PUBLISHER_NONCE_CAPACITY);
    const publication = {
      certificate: "AQ==", serverId: owner, publisherSequence: "2", publisherNonce: "2".repeat(32),
      publisherNonceExpiresAt: now + 86400, commitToken: "2".repeat(64), expectedGeneration: null,
      generation: "3".repeat(64), tokenHash: "4".repeat(64), now, visibilityCutoff: now - 600,
      name: "Private fixture", isPublic: false, quicHost: "", quicPort: 1, quicCertSha256: owner,
      authorizationRequired: true, directoryFingerprint: "5".repeat(64), directoryProfile: "classic-v3",
      playersCount: 0, version: "4.0.0", textComment: "",
    } as const;
    expect(await persistRendezvousPublication(env.DB, publication)).toEqual({ accepted: false, visibleChanged: false });
    expect(await sequence()).toBe("1");
    expect(await env.DB.prepare("SELECT count(*) AS n FROM server_presence").first<number>("n")).toBe(0);
    await env.DB.prepare(`UPDATE publisher_nonces SET expires_at=? WHERE nonce IN (
      SELECT nonce FROM publisher_nonces LIMIT 40)`).bind(now).run();
    expect(await persistRendezvousPublication(env.DB, publication)).toEqual({ accepted: true, visibleChanged: false });
    expect(await count()).toBe(PUBLISHER_NONCE_CAPACITY - PUBLISHER_NONCE_CLEANUP_BATCH + 1);
    expect(await sequence()).toBe("2");
  }, 60000);
});
