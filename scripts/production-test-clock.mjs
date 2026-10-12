// Copyright (C) 2026 Atrinik contributors
import assert from "node:assert/strict";

export function virtualClock() {
  let time = 0, events = [];
  const schedule = (ms, resolve) => { events.push({ at: time + ms, resolve }); };
  const wait = (ms, signal) => new Promise((resolve, reject) => {
    const aborted = () => reject(new Error("private abort reason"));
    if (signal?.aborted) { aborted(); return; }
    signal?.addEventListener("abort", aborted, { once: true });
    schedule(ms, () => { signal?.removeEventListener("abort", aborted); resolve(); });
  });
  return { now: () => time, wait,
    timeout(ms) { const c = new AbortController(); schedule(ms, () => c.abort()); return c.signal; },
    async run(operation) {
      let settled = false, value, error;
      Promise.resolve().then(operation).then(v => { value = v; settled = true; }, e => { error = e; settled = true; });
      for (let turns = 0; !settled && turns < 20000; turns++) {
        await new Promise(setImmediate);
        if (settled) break;
        const next = Math.min(...events.map(e => e.at));
        if (!Number.isFinite(next)) continue;
        time = next;
        const ready = events.filter(e => e.at <= time);
        events = events.filter(e => e.at > time);
        for (const event of ready) event.resolve();
      }
      assert.equal(settled, true, "virtual operation exceeded turn bound");
      if (error) throw error;
      return value;
    },
  };
}
