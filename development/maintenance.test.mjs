import assert from 'node:assert/strict';
import test from 'node:test';
import { enabled, MAINTENANCE_MARKER, MaintenanceScheduler, STATE_KEY, nextCleanup, nextReconciliation } from './maintenance.ts';

const valid = { DEVELOPMENT_MAINTENANCE: MAINTENANCE_MARKER, PUBLISH_ENABLED: 'enabled', RENDEZVOUS_ENABLED: 'enabled', GAME_PUBLISH_ENABLED: 'disabled',
  PUBLISH_HOSTNAME: 'publish.dev.meta.atrinik.org', RENDEZVOUS_HOSTNAME: 'rendezvous.dev.meta.atrinik.org',
  CLASSIC_DIRECTORY_PUBLIC_ORIGIN: 'https://classic.dev.meta.atrinik.org', GAME_DIRECTORY_PUBLIC_ORIGIN: 'https://game.dev.meta.atrinik.org',
  DIRECTORY_CACHE_ZONE_ID: '0123456789abcdef0123456789abcdef' };
class Storage {
  value; alarm; fail = false;
  async get(key) { assert.equal(key, STATE_KEY); return structuredClone(this.value); }
  async put(key, value) { assert.equal(key, STATE_KEY); this.value = structuredClone(value); }
  async delete(key) { assert.equal(key, STATE_KEY); this.value = undefined; return true; }
  async setAlarm(value) { this.alarm = value; }
  async deleteAlarm() { this.alarm = undefined; }
  async transaction(callback) {
    if (this.fail) throw Error('fixture storage failure');
    const value = structuredClone(this.value), alarm = this.alarm;
    try { return await callback(this); } catch (e) { this.value = value; this.alarm = alarm; throw e; }
  }
}
function fixture() {
  const f = { storage: new Storage(), env: { ...valid }, now: Date.UTC(2026, 9, 5, 10, 16), calls: [], fail: false };
  f.work = async (cron, time) => { assert(f.storage.alarm > f.now, 'recovery alarm armed before work'); f.calls.push({ cron, time }); if (f.fail) throw Error('fixture'); };
  f.scheduler = () => new MaintenanceScheduler(f.storage, () => enabled(f.env), f.work, () => f.now);
  f.instance = f.scheduler();
  return f;
}

test('exact development marker, circuits, origins and syntactic zone required', () => {
  assert(enabled(valid));
  for (const field of Object.keys(valid)) assert.equal(enabled({ ...valid, [field]: 'wrong' }), false, field);
  assert.equal(enabled({}), false);
  assert(enabled({ ...valid, DIRECTORY_CACHE_ZONE_ID: 'fedcba9876543210fedcba9876543210' }));
  for (const zone of ['', 'a'.repeat(31), 'a'.repeat(33), 'A'.repeat(32), null]) {
    assert.equal(enabled({ ...valid, DIRECTORY_CACHE_ZONE_ID: zone }), false);
  }
});
test('UTC minute17 and five-minute future boundaries', () => {
  assert.equal(nextCleanup(Date.UTC(2026,9,5,23,16,59)), Date.UTC(2026,9,5,23,17));
  assert.equal(nextCleanup(Date.UTC(2026,9,5,23,17)), Date.UTC(2026,9,6,0,17));
  assert.equal(nextReconciliation(Date.UTC(2026,9,5,10,20)), Date.UTC(2026,9,5,10,25));
});
test('start persists bounded identity-free state and arms first reconciliation', async () => {
  const f=fixture(); await f.instance.start();
  assert.deepEqual(f.storage.value, { version:1, reconciliation:{due:f.now+1,attempts:0},cleanup:{due:Date.UTC(2026,9,5,10,17),attempts:0} });
  assert.equal(f.storage.alarm,f.now+1); assert.equal(f.calls.length,0);
});
test('repeated concurrent starts coalesce without postponing the due task', async () => {
  const f=fixture(); await Promise.all(Array.from({length:50},()=>f.instance.start()));
  const due=f.storage.value.reconciliation.due; f.now+=5; await f.instance.start();
  assert.equal(f.storage.value.reconciliation.due,due);
});
test('initial and recurring reconciliation use unchanged five-minute handler', async () => {
  const f=fixture(); await f.instance.start(); f.now+=1; await f.instance.alarm();
  assert.deepEqual(f.calls.map(v=>v.cron),['*/5 * * * *']);
  assert.equal(f.storage.value.reconciliation.due,Date.UTC(2026,9,5,10,20));
});
test('UTC17 cleanup uses original hourly handler', async () => {
  const f=fixture(); await f.instance.start(); f.now=Date.UTC(2026,9,5,10,17); await f.instance.alarm();
  assert.deepEqual(f.calls.map(v=>v.cron),['*/5 * * * *','17 * * * *']);
  assert.equal(f.storage.value.cleanup.due,Date.UTC(2026,9,5,11,17));
});
test('long catch-up executes each task at most once and skips missed periods', async () => {
  const f=fixture(); await f.instance.start(); f.now+=7*86400000; await f.instance.alarm();
  assert.equal(f.calls.length,2); assert(f.storage.value.cleanup.due>f.now); assert(f.storage.value.reconciliation.due>f.now);
});
test('bounded retry state survives object restart', async () => {
  const f=fixture(); await f.instance.start(); f.fail=true; f.now+=1; await f.instance.alarm();
  assert.equal(f.storage.value.reconciliation.attempts,1); assert.equal(f.storage.value.reconciliation.due,f.now+60000);
  f.instance=f.scheduler(); f.now+=60000; await f.instance.alarm();
  assert.equal(f.storage.value.reconciliation.attempts,2);
  f.instance=f.scheduler(); f.now+=60000; await f.instance.alarm();
  assert.equal(f.storage.value.reconciliation.attempts,0); assert.equal(f.storage.value.reconciliation.due,nextReconciliation(f.now));
});
test('crash after prearm retains future alarm and retry budget', async () => {
  const f=fixture(); await f.instance.start(); f.now+=1;
  let release; f.work=()=>new Promise(r=>{release=r;}); f.instance=f.scheduler();
  const pending=f.instance.alarm(); await new Promise(r=>setImmediate(r));
  assert.equal(f.storage.value.reconciliation.attempts,1); assert.equal(f.storage.alarm,Math.min(f.now+60000,f.storage.value.cleanup.due));
  release(); await pending;
});
test('concurrent alarm and authenticated nudges never overlap external work', async () => {
  const f=fixture(); await f.instance.start(); f.now+=1;
  let release, active=0, count=0; f.work=async()=>{active++;count++;assert.equal(active,1); await new Promise(r=>{release=r;});active--;};
  f.instance=f.scheduler();const pending=f.instance.alarm(); await new Promise(r=>setImmediate(r));
  const peers=[f.instance.alarm(),f.instance.start(),f.instance.alarm()]; release(); await Promise.all([pending,...peers]); assert.equal(count,1);
});
test('closed alarm disarms and clears state; later authenticated start reinitializes', async () => {
  const f=fixture(); await f.instance.start(); f.env.PUBLISH_ENABLED='disabled';await f.instance.alarm();
  assert.equal(f.storage.value,undefined);assert.equal(f.storage.alarm,undefined);assert.equal(f.calls.length,0);
  f.env.PUBLISH_ENABLED='enabled';f.now+=5000;await f.instance.start();assert.equal(f.storage.value.reconciliation.due,f.now+1);
});
test('invalid environment resets without external work', async () => {
  const f=fixture();await f.instance.start();f.env.PUBLISH_HOSTNAME='publish.meta.atrinik.org';f.now+=1;await f.instance.alarm();assert.equal(f.storage.alarm,undefined);assert.equal(f.calls.length,0);
});
test('malformed state fails closed and never accepts identity fields', async () => {
  const f=fixture();f.storage.value={version:1,serverId:'forbidden'};await assert.rejects(f.instance.alarm());assert.equal(f.storage.value,undefined);assert.equal(f.calls.length,0);
});
test('each malformed persisted field fails closed on restart without work', async () => {
  for (const malformed of [null, [], 42, { version: 2 },
    { version: 1, reconciliation: { due: 1, attempts: 3 }, cleanup: { due: 1, attempts: 0 } },
    { version: 1, reconciliation: { due: -1, attempts: 0 }, cleanup: { due: 1, attempts: 0 } },
    { version: 1, reconciliation: { due: 1, attempts: 0, identity: 'forbidden' }, cleanup: { due: 1, attempts: 0 } },
  ]) {
    const f = fixture();
    f.storage.value = malformed;
    await assert.rejects(f.instance.start(), /Invalid development maintenance state/);
    assert.equal(f.storage.value, undefined);
    assert.equal(f.storage.alarm, undefined);
    assert.equal(f.calls.length, 0);
  }
});
test('uninitialized alarm never creates maintenance or performs work', async () => {
  const f = fixture();
  await f.instance.alarm();
  assert.equal(f.storage.value, undefined);
  assert.equal(f.storage.alarm, undefined);
  assert.equal(f.calls.length, 0);
});
test('gate closure between awaited maintenance operations stops the next task', async () => {
  const f = fixture();
  await f.instance.start();
  f.now = Date.UTC(2026, 9, 5, 10, 17);
  f.work = async (cron) => {
    f.calls.push(cron);
    f.env.DEVELOPMENT_MAINTENANCE = 'disabled';
  };
  f.instance = f.scheduler();
  await f.instance.alarm();
  assert.deepEqual(f.calls, ['*/5 * * * *']);
  assert.equal(f.storage.value, undefined);
  assert.equal(f.storage.alarm, undefined);
});
test('storage prearm failure prevents all external side effects', async () => {
  const f=fixture();await f.instance.start();f.now+=1;f.storage.fail=true;await assert.rejects(f.instance.alarm());assert.equal(f.calls.length,0);
});
test('success resets retry budget and preserves original handler failure isolation', async () => {
  const f=fixture();await f.instance.start();f.now+=1;f.fail=true;await f.instance.alarm();f.now+=60000;f.fail=false;await f.instance.alarm();assert.equal(f.storage.value.reconciliation.attempts,0);assert.equal(f.storage.value.cleanup.attempts,0);
});

test('alarm consumed while bootstrap persistence finishes still runs and rearms', async () => {
  const f=fixture();const original=f.storage.transaction.bind(f.storage);let release;let initial=true;
  f.storage.transaction=async callback=>{await original(callback);if(initial){initial=false;await new Promise(r=>{release=r;});}};
  const start=f.instance.start();await new Promise(r=>setImmediate(r));assert(f.storage.alarm);f.now+=2;f.storage.alarm=undefined;
  const alarm=f.instance.alarm();release();await Promise.all([start,alarm]);assert.equal(f.calls.length,1);assert(f.storage.alarm>f.now);
});
