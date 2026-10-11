import { afterEach, describe, expect, it, vi } from "vitest";
const handler = vi.hoisted(() => vi.fn());
const diagnostic = vi.hoisted(() => vi.fn());
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class { env: any;ctx:any;constructor(ctx:any,env:any){this.ctx=ctx;this.env=env;} },
  DurableObject: class {ctx:any;env:any;constructor(ctx:any,env:any){this.ctx=ctx;this.env=env;}},
}));
vi.mock("../src/index",()=>({default:{scheduled:vi.fn()},handlePublisherCoordinatorRequest:handler,
  DirectoryBuilder:class{},DirectoryReconciliation:class{},RendezvousRoom:class{},RendezvousCoordinator:class{},RendezvousHealth:class{}}));
vi.mock("../src/diagnostics",()=>({logUnexpectedError:diagnostic}));
import { DevelopmentMaintenance, PublisherCoordinator } from "./core";
import { MAINTENANCE_MARKER, MAINTENANCE_NAME } from "./maintenance";
const valid={DEVELOPMENT_MAINTENANCE:MAINTENANCE_MARKER,PUBLISH_ENABLED:"enabled",RENDEZVOUS_ENABLED:"enabled",GAME_PUBLISH_ENABLED:"disabled",
  PUBLISH_HOSTNAME:"publish.dev.meta.atrinik.org",RENDEZVOUS_HOSTNAME:"rendezvous.dev.meta.atrinik.org",CLASSIC_DIRECTORY_PUBLIC_ORIGIN:"https://classic.dev.meta.atrinik.org",
  GAME_DIRECTORY_PUBLIC_ORIGIN:"https://game.dev.meta.atrinik.org",DIRECTORY_CACHE_ZONE_ID:"0123456789abcdef0123456789abcdef"};
function request(path="/v3/classic/servers/"+"a".repeat(64)+"/publish") {return new Request("https://publish.dev.meta.atrinik.org"+path,{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});}
function fixture(status=200){const pending:Promise<unknown>[]=[];const start=vi.fn(async()=>{});const getByName=vi.fn(()=>({start}));const ctx={waitUntil:(p:Promise<unknown>)=>pending.push(p)};
  const env={...valid,DEVELOPMENT_MAINTENANCE_DO:{getByName}};handler.mockResolvedValue(new Response(null,{status}));
  return {pending,start,getByName,ctx,env,instance:()=>new PublisherCoordinator(ctx as never,env as never)};}
afterEach(()=>{vi.clearAllMocks();vi.useRealTimers();});
describe("development-only publisher bootstrap",()=>{
  it("delegates unchanged authenticated handler then constant-name bootstrap",async()=>{const f=fixture();const r=request();expect((await f.instance().fetch(r)).status).toBe(200);await Promise.all(f.pending);expect(handler).toHaveBeenCalledWith(r,f.env,f.ctx);expect(f.getByName).toHaveBeenCalledWith(MAINTENANCE_NAME);expect(f.start).toHaveBeenCalledTimes(1);});
  it.each([400,401,403,409,429,503])("reject status %s never starts maintenance",async status=>{const f=fixture(status);await f.instance().fetch(request());expect(f.start).not.toHaveBeenCalled();});
  it.each(["/v2/servers/"+"a".repeat(64)+"/publish","/v3/classic/servers/"+"a".repeat(64)+"/access/routes","/admin"])('other route %s never starts',async path=>{const f=fixture();await f.instance().fetch(request(path));expect(f.start).not.toHaveBeenCalled();});
  it("closed or production environment never bootstraps",async()=>{for(const key of Object.keys(valid)){const f=fixture();(f.env as any)[key]="wrong";await f.instance().fetch(request());expect(f.start).not.toHaveBeenCalled();}});
  it("synchronous binding throw preserves committed response and redacts diagnostics",async()=>{const f=fixture();f.getByName.mockImplementation(()=>{throw Error("private fixture detail");});expect((await f.instance().fetch(request())).status).toBe(200);await Promise.all(f.pending);expect(diagnostic).toHaveBeenCalledWith("scheduled","maintenance_failure");});
  it("waitUntil and diagnostic throws preserve committed response",async()=>{const f=fixture();f.ctx.waitUntil=()=>{throw Error("context");};diagnostic.mockImplementation(()=>{throw Error("logger");});expect((await f.instance().fetch(request())).status).toBe(200);});
  it("bootstrap has a five-second deadline",async()=>{vi.useFakeTimers();const f=fixture();f.start.mockImplementation(()=>new Promise(()=>{}));await f.instance().fetch(request());await vi.advanceTimersByTimeAsync(5000);await Promise.all(f.pending);expect(diagnostic).toHaveBeenCalled();});
  it("foreign Durable Object identity rejects before storage access",()=>{const storage=new Proxy({}, {get(){throw Error("storage accessed");}});expect(()=>new DevelopmentMaintenance({id:{name:"foreign"},storage} as never,valid as never)).toThrow("Invalid development maintenance identity");});
});
