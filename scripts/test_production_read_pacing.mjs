// Copyright (C) 2026 Atrinik contributors
import test from "node:test";
import assert from "node:assert/strict";
import { createProductionReadPacer, productionReadFailure } from "./production-read-pacing.mjs";

const url = `https://api.cloudflare.com/client/v4/accounts/${"a".repeat(32)}/workers/scripts`;

import { virtualClock } from "./production-test-clock.mjs";

test("shared FIFO paces 3400 reads across credentials with no catch-up bursts", async () => {
  const clock = virtualClock(), starts = [];
  const paced = createProductionReadPacer({ ...clock, fetcher: async (_url, options) => {
    starts.push(clock.now());
    assert.ok(options.headers.Authorization);
    await clock.wait(100);
    return new Response("ok");
  } });
  await clock.run(async () => {
    for (let batch = 0; batch < 34; batch++)
      await Promise.all(Array.from({ length: 100 }, (_, i) => paced(url, {
        headers: { Authorization: `fixture-${i % 3}` },
      })));
  });
  assert.equal(starts.length, 3400);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 334);
  assert.ok(clock.now() < 30 * 60 * 1000);
  assert.ok(clock.now() < 60 * 60 * 1000);
  for (let i = 900; i < starts.length; i++) assert.ok(starts[i] - starts[i - 900] > 300000);
});

test("54 concurrent reads retain queue-inclusive 20-second deadlines with 2-second responses", async () => {
  const clock = virtualClock(), starts = [];
  const paced = createProductionReadPacer({ ...clock, fetcher: async (_url, options) => {
    starts.push(clock.now()); await clock.wait(2000, options.signal); return new Response("ok");
  } });
  await clock.run(() => Promise.all(Array.from({ length: 54 }, () => paced(url, { signal: clock.timeout(20000) }))));
  assert.equal(starts.length, 54);
  assert.equal(clock.now(), 53 * 334 + 2000);
});

test("expired queued requests never dispatch and slots release", async () => {
  const clock = virtualClock(); let calls = 0;
  const paced = createProductionReadPacer({ ...clock, fetcher: async () => { calls++; return new Response("ok"); } });
  const result = await clock.run(() => Promise.allSettled(Array.from({ length: 70 }, () => paced(url, { signal: clock.timeout(20000) }))));
  assert.equal(calls, 60);
  for (const row of result.slice(60)) assert.deepEqual(productionReadFailure(row.reason), { category: "deadline-expired", transportState: "not-dispatched" });
  await clock.run(() => paced(url)); assert.equal(calls, 61);
});

test("429 closes queued and future GETs without retry or raw header reflection", async () => {
  const clock = virtualClock(); let calls = 0;
  const paced = createProductionReadPacer({ ...clock, fetcher: async () => {
    calls++; return new Response("private provider body", { status: 429, headers: { "retry-after": "private-token", Ratelimit: "private-policy" } });
  } });
  const result = await clock.run(() => Promise.allSettled(Array.from({ length: 54 }, () => paced(url))));
  assert.equal(calls, 1);
  assert.deepEqual(productionReadFailure(result[0].reason), { category: "rate-limited", transportState: "response-received", httpStatus: 429 });
  for (const row of result.slice(1)) assert.deepEqual(productionReadFailure(row.reason), { category: "rate-limited", transportState: "not-dispatched" });
  await assert.rejects(paced(url)); assert.equal(calls, 1);
});

test("queue bound, backward clock and early wakeup cannot create unpaced dispatch", async () => {
  const clock = virtualClock(); let calls = 0;
  const paced = createProductionReadPacer({ ...clock, fetcher: async () => { calls++; return new Response("ok"); } });
  const result = await clock.run(() => Promise.allSettled(Array.from({ length: 129 }, () => paced(url))));
  assert.equal(calls, 128); assert.equal(productionReadFailure(result[128].reason).category, "queue-bound");
  let now = 1000;
  const backwards = createProductionReadPacer({ now: () => now, fetcher: async () => new Response("ok") });
  await backwards(url); now = 999;
  await assert.rejects(backwards(url), e => productionReadFailure(e).category === "clock-invalid");
  let ticks = 0, launched = 0;
  const early = createProductionReadPacer({ now: () => ticks, wait: async ms => { ticks += Math.min(100, ms); }, fetcher: async () => { launched++; return new Response("ok"); } });
  await early(url); await early(url); assert.equal(ticks, 334); assert.equal(launched, 2);
});

test("GitHub, non-account endpoints and writes pass through with identity intact", async () => {
  let calls = 0;
  const paced = createProductionReadPacer({ now: () => { throw Error("not governed"); }, fetcher: async (input, options) => {
    calls++; return { input, options };
  } });
  for (const [input, method] of [["https://api.github.com/repos/example/repo", "GET"],
    ["https://api.cloudflare.com/client/v4/user/tokens/verify", "GET"], [url, "PATCH"], [url, "POST"], [url, "DELETE"]]) {
    const options = { method, signal: AbortSignal.abort() };
    const result = await paced(input, options);
    assert.equal(result.input, input); assert.equal(result.options, options);
  }
  assert.equal(calls, 5);
});
