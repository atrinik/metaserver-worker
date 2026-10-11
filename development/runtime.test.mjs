import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
const name='development-maintenance-v1';
const code=await build({stdin:{contents:`
import {DevelopmentMaintenance} from './development/core.ts';
export class FixtureMaintenance extends DevelopmentMaintenance {
 async inspect(){return {state:await this.ctx.storage.get('development-maintenance:v1'),alarm:await this.ctx.storage.getAlarm(),name:this.ctx.id.name};}
 async close(){this.env.PUBLISH_ENABLED='disabled';await super.alarm();}
 async reopen(){this.env.PUBLISH_ENABLED='enabled';await super.start();}
}
export default {async fetch(request,env){const path=new URL(request.url).pathname;const stub=env.DEVELOPMENT_MAINTENANCE_DO.getByName(path==='/foreign'?'foreign':'development-maintenance-v1');
 if(path==='/start'||path==='/foreign')await stub.start();else if(path==='/close')await stub.close();else if(path==='/reopen')await stub.reopen();return Response.json(await stub.inspect());}}
`,resolveDir:process.cwd(),sourcefile:'development-runtime-fixture.ts'},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['cloudflare:workers'],logLevel:'silent'});

test('real SQLite DO transaction/alarm/restart/closed-reopen/name fencing',async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({name:'development-alarm-fixture',modules:true,script:code.outputFiles[0].text,compatibilityDate:'2026-08-05',compatibilityFlags:['nodejs_compat'],
  durableObjects:{DEVELOPMENT_MAINTENANCE_DO:{className:'FixtureMaintenance',useSQLite:true}},
  bindings:{DEVELOPMENT_MAINTENANCE:'classic-development-alarms-v1',PUBLISH_ENABLED:'enabled',RENDEZVOUS_ENABLED:'enabled',GAME_PUBLISH_ENABLED:'disabled',PUBLISH_HOSTNAME:'publish.dev.meta.atrinik.org',RENDEZVOUS_HOSTNAME:'rendezvous.dev.meta.atrinik.org',CLASSIC_DIRECTORY_PUBLIC_ORIGIN:'https://classic.dev.meta.atrinik.org',GAME_DIRECTORY_PUBLIC_ORIGIN:'https://game.dev.meta.atrinik.org',DIRECTORY_CACHE_ZONE_ID:'0123456789abcdef0123456789abcdef',LISTING_TTL_SECONDS:'14400'},
 }));
 try {
  const fetch=async p=>{const r=await mf.dispatchFetch('https://fixture.test'+p);assert.equal(r.status,200);return r.json();};
  let observed=await fetch('/start');assert.equal(observed.name,name);assert.equal(observed.state.version,1);assert(observed.alarm);
  // Initial real alarm invokes the original handler; intentionally absent
  // DirectoryBuilder makes it fail and retain its already-persisted retry.
  for(let i=0;i<200&&observed.state.reconciliation.attempts===0;i++){await new Promise(r=>setTimeout(r,25));observed=await fetch('/inspect');}
  assert.equal(observed.state.reconciliation.attempts,1);assert(observed.alarm>Date.now());
  const before=observed;
  await mf.unsafeEvictDurableObject('development-alarm-fixture','FixtureMaintenance',{name});
  observed=await fetch('/inspect');assert.deepEqual(observed,before);
  observed=await fetch('/close');assert.equal(observed.state,undefined);assert.equal(observed.alarm,null);
  observed=await fetch('/reopen');assert.equal(observed.state.version,1);assert(observed.alarm);
  const foreign=await mf.dispatchFetch('https://fixture.test/foreign');assert.equal(foreign.status,500);
 } finally {await mf.dispose();}
});
