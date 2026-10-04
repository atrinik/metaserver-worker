import { describe, expect, it, vi } from "vitest";
import { classifyAccessRoute } from "../src/routes";
import rendezvousWorker from "../src/rendezvous-worker";

const authority="rendezvous.example.test";
const capability="a".repeat(64), nonce="b".repeat(64);
const body=JSON.stringify({schema:"atrinik-access-resolve-v1",routeCapability:capability,clientNonce:nonce});
const target=`https://${authority}/v1/access/resolve`;
function environment(fetch: (request:Request)=>Promise<Response>) {
  const limit=vi.fn(async()=>({success:true}));
  return {limit,env:{COORDINATOR:{fetch},GLOBAL_RATE_LIMITER:{limit},RENDEZVOUS_CLIENT_RATE_LIMITER:{limit},
    RENDEZVOUS_HOSTNAME:authority,RENDEZVOUS_ENABLED:"enabled",ROUTE_DISABLED_RETRY_SECONDS:"300",
    SOURCE_TAG_KEY_CURRENT_ID:"current",SOURCE_TAG_KEY_CURRENT:"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    SOURCE_TAG_KEY_PREVIOUS_ID:"previous",SOURCE_TAG_KEY_PREVIOUS:"AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE"} as unknown as RendezvousEnv};
}
describe("private access edge ingress",()=>{
  it("charges source admission before lookup and forwards only a bounded POST body",async()=>{
    const fetch=vi.fn(async(request:Request)=>{
      expect(request.url).toBe(target); expect(request.url).not.toContain(capability);
      expect(request.headers.has("CF-Connecting-IP")).toBe(false);
      expect([...request.headers.keys()].sort()).toEqual(["content-type"]);
      expect(await request.text()).toBe(body);
      return Response.json({error:{code:"access_unavailable"}},{status:404,headers:{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
    });
    const configured=environment(fetch);
    const response=await rendezvousWorker.fetch(new Request(target,{method:"POST",headers:{"Content-Type":"application/json","CF-Connecting-IP":"192.0.2.10"},body}),configured.env);
    expect(response.status).toBe(404); expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(fetch).toHaveBeenCalledTimes(1); expect(configured.limit).toHaveBeenCalled();
    expect(configured.limit.mock.invocationCallOrder[0]).toBeLessThan(fetch.mock.invocationCallOrder[0]);
  });
  it("rejects secret-bearing URL and browser credential alternatives before dispatch",async()=>{
    const fetch=vi.fn(async()=>new Response(null,{status:500})); const configured=environment(fetch);
    for(const request of [
      new Request(`${target}?routeCapability=${capability}`),
      new Request(`${target}/${capability}`,{method:"POST",headers:{"Content-Type":"application/json"},body}),
      new Request(target,{method:"GET"}),new Request(target,{method:"HEAD"}),
      new Request(target,{method:"POST",headers:{"Content-Type":"application/json",Cookie:"access=secret"},body}),
    ]) {const response=await rendezvousWorker.fetch(request,configured.env);
      expect(response.status).toBeGreaterThanOrEqual(400); expect(await response.text()).not.toContain(capability);}
    expect(fetch).not.toHaveBeenCalled(); expect(configured.limit).not.toHaveBeenCalled();
  });
  it("rejects method, body, profile and websocket protocol ambiguity",()=>{
    const input={target,method:"POST",headers:new Headers({"Content-Type":"application/json"}),hasBody:true};
    expect(classifyAccessRoute(input,authority,"rendezvous")?.kind).toBe("access-resolve");
    for(const change of [
      {method:"PUT"},{target:target+"?x=1"},{hasBody:false},
      {headers:new Headers({"Content-Type":"application/json","Content-Length":"513"})},
      {headers:new Headers({"Content-Type":"application/json","Content-Encoding":"gzip"})},
      {target:`https://${authority}/v1/access/servers/Classic/${capability}/routes`},
      {target:`https://${authority}/v1/access/rendezvous/classic/${capability}`,method:"GET",hasBody:false,
        headers:new Headers({Upgrade:"websocket","Sec-WebSocket-Protocol":"atrinik-access-rendezvous-v1, other"})},
    ]) expect(()=>classifyAccessRoute({...input,...change},authority,"rendezvous")).toThrow();
  });
});
