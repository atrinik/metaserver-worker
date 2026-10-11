import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleAccessResolve } from "../src/access-controller";
import { accessRouteIndex } from "../src/access-crypto";
import { validateAccessServiceResponse } from "../src/internal-service";
import { INTERNAL_RENDEZVOUS_URL, INTERNAL_RENDEZVOUS_ROLE_HEADER,
  INTERNAL_RENDEZVOUS_PROTOCOL_HEADER, INTERNAL_RENDEZVOUS_AUTHORIZATION_HEADER,
  INTERNAL_RENDEZVOUS_GENERATION_HEADER } from "../src/rendezvous-contract";
import fixture from "./fixtures/metaserver-classic-publisher-v3.json";

const now=1800000000, capability="a".repeat(64), nonce="b".repeat(64), generation="c".repeat(64);
const request=(routeCapability=capability) => new Request("https://rendezvous.meta.atrinik.org/v1/access/resolve",{
  method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({schema:"atrinik-access-resolve-v1",routeCapability,clientNonce:nonce})});
async function seed() {
  const index=await accessRouteIndex(capability);
  await env.DB.prepare(`INSERT INTO publisher_replay(server_id,profile,last_sequence,last_nonce,commit_token,updated_at)
    VALUES(?,'classic-v3','1',?,?,?)`).bind(fixture.server_id,"1".repeat(32),"0".repeat(64),now).run();
  await env.DB.prepare(`INSERT INTO server_presence(profile,server_id,last_seen,rendezvous_token_hash,
    rendezvous_generation,certificate,name,hostname,port,access_required)
    VALUES('classic-v3',?,?,?,?,?,'Private fixture','play.example.test',1730,1)`)
    .bind(fixture.server_id,now,"d".repeat(64),generation,fixture.certificate_der_base64).run();
  await env.DB.prepare(`INSERT INTO access_routes(route_index,profile,server_id,token_id,token_revision,
    state,expires_at,reservation_id,reserved_until,created_at,revoked_at)
    VALUES(?,'classic',?,?,'1','active',NULL,?,?,?,NULL)`)
    .bind(index,fixture.server_id,"e".repeat(32),"f".repeat(32),now+60,now).run();
  return index;
}
async function server() {
  const response=await env.RENDEZVOUS.getByName(fixture.server_id).fetch(new Request(INTERNAL_RENDEZVOUS_URL,{
    headers:{Upgrade:"websocket",[INTERNAL_RENDEZVOUS_ROLE_HEADER]:"server",
      [INTERNAL_RENDEZVOUS_PROTOCOL_HEADER]:"access-tokens-v1",[INTERNAL_RENDEZVOUS_AUTHORIZATION_HEADER]:"not-required",
      [INTERNAL_RENDEZVOUS_GENERATION_HEADER]:generation}}));
  expect(response.status).toBe(101); response.webSocket!.accept(); return response.webSocket!;
}
beforeEach(async()=>{
  vi.spyOn(Date,"now").mockReturnValue(now*1000);
  await env.DB.batch(["access_grants","access_route_receipts","access_routes","access_request_budgets","publisher_replay"].map(table=>env.DB.prepare(`DELETE FROM ${table}`)));
});
describe("private capability resolution",()=>{
  it("resolves private signed presence without a public directory row and stores only grant aliases",async()=>{
    await seed(); const control=await server();
    try {
      const response=await validateAccessServiceResponse(await handleAccessResolve(request(),env,now,14400),"resolve");
      expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("no-store");
      const result=await response.json<Record<string,unknown>>();
      expect(result).toMatchObject({schema:"atrinik-access-resolved-v1",profile:"classic",serverId:fixture.server_id,
        accessRequired:true,clientNonce:nonce,generation,expiresAt:String(now+15),endpoint:{hostname:"play.example.test",port:1730}});
      expect(result.grant).toMatch(/^[0-9a-f]{64}$/);
      const stored=JSON.stringify((await env.DB.prepare("SELECT * FROM access_grants").all()).results);
      expect(stored).not.toContain(result.grant); expect(stored).not.toContain(capability);
      expect(await env.DB.prepare("SELECT count(*) AS n FROM directory_entries").first<number>("n")).toBe(0);
    } finally {control.close(1000,"Test complete");}
  });
  it("returns one fixed denial for unknown, offline, revoked, expired and public-open targets",async()=>{
    const index=await seed();
    const denial=async()=>{const response=await handleAccessResolve(request(),env,now,14400);
      expect(response.status).toBe(404); expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.text()).toBe('{"error":{"code":"access_unavailable"}}');};
    const unknown=await handleAccessResolve(request("f".repeat(64)),env,now,14400);
    expect(await unknown.text()).toBe('{"error":{"code":"access_unavailable"}}'); await denial();
    const control=await server();
    try {
      await env.DB.prepare("UPDATE server_presence SET access_required=0 WHERE server_id=?").bind(fixture.server_id).run(); await denial();
      await env.DB.prepare("UPDATE server_presence SET access_required=1 WHERE server_id=?").bind(fixture.server_id).run();
      await env.DB.prepare("UPDATE access_routes SET expires_at=? WHERE route_index=?").bind(now,index).run(); await denial();
      const regressed=await handleAccessResolve(request(),env,now-1,14400); expect(regressed.status).toBe(404);
      await env.DB.prepare("UPDATE access_routes SET state='revoked' WHERE route_index=?").bind(index).run(); await denial();
    } finally {control.close(1000,"Test complete");}
  });
  it("rejects unsafe service responses without echoing capability material",async()=>{
    const headers={"Content-Type":"application/json","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"};
    const valid={schema:"atrinik-access-resolved-v1",profile:"classic",serverId:fixture.server_id,
      certificate:fixture.certificate_der_base64,name:"Private fixture",accessRequired:true,generation,
      clientNonce:nonce,grant:"d".repeat(64),expiresAt:String(now+15)};
    for(const response of [
      new Response(JSON.stringify({...valid,extra:capability}),{headers}),
      new Response(JSON.stringify(valid),{headers:{...headers,"Set-Cookie":`grant=${valid.grant}`}}),
      new Response(null,{status:302,headers:{Location:`https://example.test/${capability}`}}),
      new Response(JSON.stringify({...valid,endpoint:{hostname:"https://evil.test",port:1730}}),{headers}),
      new Response("x".repeat(8193),{headers}),
    ]) await expect(validateAccessServiceResponse(response,"resolve")).rejects.toThrow("Dynamic service returned an unsafe response");
  });
});
