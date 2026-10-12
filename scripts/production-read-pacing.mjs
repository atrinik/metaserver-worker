// Copyright (C) 2026 Atrinik contributors
import { setTimeout as delay } from "node:timers/promises";

const transportFailures = new WeakMap();
const statuses = new Set([401, 403, 404, 408, 409, 429, 500, 502, 503, 504]);
const object = value => value !== null && ["object", "function"].includes(typeof value);

function rejected(category, transportState, status) {
  const error = new Error("production control-plane read stopped");
  transportFailures.set(error, Object.freeze({ category, transportState,
    ...(statuses.has(status) ? { httpStatus: status } : {}) }));
  return error;
}

// Only our private brand is accepted. Never inspect arbitrary messages, names,
// status properties, headers, bodies, or cause getters.
export function productionReadFailure(error) {
  return object(error) ? transportFailures.get(error) ?? null : null;
}

function governed(input, options) {
  const url = new URL(input instanceof Request ? input.url : input);
  const method = options?.method ?? (input instanceof Request ? input.method : "GET");
  return method === "GET" && url.origin === "https://api.cloudflare.com" &&
    /^\/client\/v4\/accounts\/[a-f0-9]{32}(?:\/|$)/u.test(url.pathname);
}

// One instance per controller execution, shared across credentials and readers.
// No burst credit, retries, cache, credential partition, or global fetch patch.
// External clients and Wrangler subprocess requests remain outside this budget.
export function createProductionReadPacer({ fetcher = fetch,
  now = () => performance.now(), wait = (ms, signal) => delay(ms, undefined, { signal }) } = {}) {
  let tail = Promise.resolve(), pending = 0, lastLaunch = -Infinity, lastClock = -Infinity, stopped = false;
  const clock = () => {
    const value = now();
    if (!Number.isFinite(value) || value < lastClock)
      throw rejected("clock-invalid", "not-dispatched");
    lastClock = value;
    return value;
  };
  return async (input, options) => {
    if (!governed(input, options)) return fetcher(input, options);
    if (stopped) throw rejected("rate-limited", "not-dispatched");
    if (pending >= 128) throw rejected("queue-bound", "not-dispatched");
    const signal = options?.signal ?? (input instanceof Request ? input.signal : undefined);
    const previous = tail;
    let release;
    tail = new Promise(resolve => { release = resolve; });
    pending++;
    let dispatched = false;
    try {
      await previous;
      if (stopped) throw rejected("rate-limited", "not-dispatched");
      if (signal?.aborted) throw rejected("deadline-expired", "not-dispatched");
      let remaining = lastLaunch + 334 - clock();
      while (remaining > 0) {
        await wait(remaining, signal);
        if (stopped) throw rejected("rate-limited", "not-dispatched");
        if (signal?.aborted) throw rejected("deadline-expired", "not-dispatched");
        remaining = lastLaunch + 334 - clock();
      }
      if (signal?.aborted) throw rejected("deadline-expired", "not-dispatched");
      lastLaunch = clock();
      dispatched = true;
      const result = fetcher(input, options);
      // Admission covers dispatch, not the response/body lifetime. Concurrent
      // readers retain their original request deadlines, including queue time.
      release();
      const response = await result;
      if (!response.ok) {
        const error = rejected(response.status === 429 ? "rate-limited" : "http-rejected",
          "response-received", response.status);
        if (response.status === 429) stopped = true;
        void response.body?.cancel().catch(() => {});
        throw error;
      }
      return response;
    } catch (error) {
      if (productionReadFailure(error)) throw error;
      throw rejected(signal?.aborted ? "deadline-expired" : "transport-failed",
        dispatched ? "dispatched-outcome-unknown" : "not-dispatched");
    } finally {
      pending--;
      release();
    }
  };
}
