import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { mutateAccessRoute } from "../src/access-route-state";
import type { AccessRoutePayload } from "../src/access-route-auth";
import { issueAccessGrant, redeemAccessGrant, isAccessRedemptionLive } from "../src/access-grants";
import { requiredSourceTagKeyRing } from "../src/privacy";

const now = 1800000000;
const server = "1".repeat(64);
const generation = "a".repeat(64);
const nonce = "b".repeat(64);
const grant = "c".repeat(64);
const initial: AccessRoutePayload = { schema: "atrinik-access-route-v1", profile: "classic",
  serverId: server, certificate: "AA==", operation: "reserve", requestId: "1".repeat(32),
  tokenId: "2".repeat(32), tokenRevision: "1", index: "3".repeat(64), reservationId: null, expiresAt: null };
async function owner(serverId = server) {
  await env.DB.prepare(`INSERT INTO publisher_replay(server_id,profile,last_sequence,last_nonce,commit_token,updated_at)
    VALUES(?,'classic-v3','1',?,?,?)`).bind(serverId, "0".repeat(31) + "1", "0".repeat(64), now).run();
  await env.DB.prepare(`INSERT INTO server_presence(profile,server_id,last_seen,rendezvous_token_hash,
    rendezvous_generation,certificate,name,hostname,port,access_required)
    VALUES('classic-v3',?,?,?,?,?,'Private fixture',NULL,NULL,1)`)
    .bind(serverId, now, "d".repeat(64), generation, "AA==").run();
}
const mutate = (payload: AccessRoutePayload, sequence: number, time = now) => mutateAccessRoute(env.DB, {
  payload, sequence: String(sequence), nonce: sequence.toString(16).padStart(32, "0"), nonceExpiresAt: time + 86400,
}, time);
const change = (operation: AccessRoutePayload["operation"], id: number, reservationId: string | null) => ({
  ...initial, operation, requestId: id.toString(16).padStart(32, "0"), reservationId,
});

describe("private route D1 linearization", () => {
  beforeEach(async () => {
    await env.DB.batch(["access_grants", "access_route_receipts", "access_routes", "publisher_replay"].map(
      (table) => env.DB.prepare(`DELETE FROM ${table}`)));
  });
  it("does not allocate publisher state through token CRUD for an unregistered identity", async () => {
    await expect(mutate(initial,2)).rejects.toMatchObject({code:"conflict"});
    expect(await env.DB.prepare("SELECT count(*) AS n FROM publisher_replay").first<number>("n")).toBe(0);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM access_route_receipts").first<number>("n")).toBe(0);
  });
  it("requires reserve CAS, never resurrects revoked identities, and is idempotent only with fresh signatures", async () => {
    await owner();
    const reserved = await mutate(initial, 2);
    expect(reserved.outcome).toBe("reserved");
    expect(await mutate(initial, 3)).toEqual(reserved);
    expect(await mutate({ ...initial, operation: "result" }, 4)).toEqual(reserved);
    await expect(mutate(initial, 3)).rejects.toThrow();
    expect((await mutate({ ...initial, index: "4".repeat(64) }, 5)).outcome).toBe("conflict");
    expect((await mutate(change("activate", 6, reserved.reservationId), 6)).outcome).toBe("active");
    expect((await mutate({ ...change("revoke", 7, reserved.reservationId), tokenRevision: "2" }, 7)).outcome).toBe("revoked");
    expect((await mutate({ ...change("activate", 8, reserved.reservationId), tokenRevision: "3" }, 8)).outcome).toBe("revoked");
    expect((await mutate({ ...initial, requestId: "9".repeat(32), tokenRevision: "4" }, 9)).outcome).toBe("revoked");
  });
  it("retains revoke-before-reserve denial and global index collisions", async () => {
    await owner();
    await owner("f".repeat(64));
    expect((await mutate(change("revoke", 2, null), 2)).outcome).toBe("revoked");
    expect((await mutate(initial, 3)).outcome).toBe("revoked");
    expect((await mutate({ ...initial, serverId: "f".repeat(64) }, 2)).outcome).toBe("conflict");
  });
  it("does not activate expired reservations or reset their terminal expiry on clock regression", async () => {
    await owner();
    const reserved = await mutate(initial, 2);
    expect((await mutate(change("activate", 3, reserved.reservationId), 3, now + 60)).outcome).toBe("expired");
    expect((await mutate(change("activate", 4, reserved.reservationId), 4, now + 1)).outcome).toBe("expired");
  });
  it("consumes a grant once and makes committed revocation win over later redemption", async () => {
    await owner();
    const reserved = await mutate(initial, 2);
    await mutate(change("activate", 3, reserved.reservationId), 3);
    const keys = await requiredSourceTagKeyRing(env);
    const tags = await keys.accessGrantTags(env.RENDEZVOUS_HOSTNAME, "classic", server, grant, nonce);
    expect(await issueAccessGrant(env.DB, initial.index, nonce, tags, generation, now, 600)).not.toBeNull();
    const redemption = "e".repeat(64);
    expect(await redeemAccessGrant(env.DB, "classic", server, generation, nonce, tags, redemption, now, 600)).not.toBeNull();
    expect(await redeemAccessGrant(env.DB, "classic", server, generation, nonce, tags, "f".repeat(64), now, 600)).toBeNull();
    expect(await isAccessRedemptionLive(env.DB, redemption, generation, now, 600)).toBe(true);
    await mutate(change("revoke", 4, reserved.reservationId), 4);
    expect(await isAccessRedemptionLive(env.DB, redemption, generation, now, 600)).toBe(false);
    expect(await redeemAccessGrant(env.DB, "classic", server, generation, nonce, tags, "f".repeat(64), now, 600)).toBeNull();
  });
  it("reserves terminal receipt capacity against unrelated no-effect operations", async () => {
    await owner();
    const reserved = await mutate(initial,2);
    await mutate(change("activate",3,reserved.reservationId),3);
    await env.DB.prepare(`WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM n WHERE value<4093)
      INSERT INTO access_route_receipts(profile,server_id,request_id,request_digest,tuple_digest,
        operation,token_id,outcome,reservation_id,reservation_expires_at,token_revision,commit_token,created_at,expires_at)
      SELECT 'classic',?,printf('%032x',value+100),?,?,'revoke',?,'conflict',NULL,NULL,'1',?,?,? FROM n`)
      .bind(server,"a".repeat(64),"b".repeat(64),"c".repeat(32),"d".repeat(64),now,now+86400).run();
    expect(await env.DB.prepare("SELECT count(*) AS n FROM access_route_receipts").first<number>("n")).toBe(4095);
    expect((await mutate({...change("revoke",4,null),tokenId:"f".repeat(32),index:"f".repeat(64)},4)).outcome).toBe("unavailable");
    expect((await mutate(change("revoke",5,reserved.reservationId),5)).outcome).toBe("revoked");
    expect(await env.DB.prepare("SELECT count(*) AS n FROM access_route_receipts").first<number>("n")).toBe(4096);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM access_routes WHERE state IN ('active','reserved')").first<number>("n")).toBe(0);
    expect((await mutate(change("revoke",6,reserved.reservationId),6)).outcome).toBe("unavailable");
    expect((await mutate({...change("revoke",5,reserved.reservationId),operation:"result"},7)).outcome).toBe("revoked");
  });
  it("fences grant redemption by nonce, generation, expiry and observed expiry after clock regression", async () => {
    await owner(); const reserved=await mutate(initial,2); await mutate(change("activate",3,reserved.reservationId),3);
    const keys=await requiredSourceTagKeyRing(env);
    const tags=await keys.accessGrantTags(env.RENDEZVOUS_HOSTNAME,"classic",server,grant,nonce);
    await issueAccessGrant(env.DB,initial.index,nonce,tags,generation,now,600);
    expect(await redeemAccessGrant(env.DB,"classic",server,generation,"e".repeat(64),tags,"e".repeat(64),now,600)).toBeNull();
    expect(await redeemAccessGrant(env.DB,"classic",server,"e".repeat(64),nonce,tags,"e".repeat(64),now,600)).toBeNull();
    expect(await redeemAccessGrant(env.DB,"classic",server,generation,nonce,tags,"e".repeat(64),now+15,600)).toBeNull();
    expect(await redeemAccessGrant(env.DB,"classic",server,generation,nonce,tags,"e".repeat(64),now+1,600)).toBeNull();
  });

});
