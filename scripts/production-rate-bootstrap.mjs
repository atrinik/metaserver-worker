// Copyright (C) 2026 Atrinik contributors
import { createHash } from "node:crypto";
// A single reviewed native binding transition, never a generic resource provisioner.
export const productionAccessRate = Object.freeze({ name: "ACCESS_ROUTE_RATE_LIMITER",
  namespace_id: "1008", simple: Object.freeze({ limit: 16, period: 60 }) });
export const productionAccessResource = Object.freeze({ binding: productionAccessRate.name,
  type: "rate-limit", id: productionAccessRate.namespace_id });
const fail = () => { throw new Error("delivery resource isolation: production rate bootstrap rejected"); };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const sorted = values => [...values].sort((a, b) => JSON.stringify(canonical(a)).localeCompare(JSON.stringify(canonical(b))));
function keys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !same(Object.keys(value).sort(), [...expected].sort())) fail();
}
export function projectNativeRates(bindings) {
  if (!Array.isArray(bindings) || bindings.some(v => !v || typeof v.name !== "string" || typeof v.type !== "string") ||
      new Set(bindings.map(v => v.name)).size !== bindings.length) fail();
  return sorted(bindings.filter(v => v.type === "ratelimit").map(v => {
    const rate = { name: v.name, namespace_id: String(v.namespace_id), simple: v.simple };
    validateRate(rate); return rate;
  }));
}
function validateRate(rate) {
  keys(rate, ["name", "namespace_id", "simple"]); keys(rate.simple, ["limit", "period"]);
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(rate.name) || !/^[1-9][0-9]{0,19}$/u.test(rate.namespace_id) ||
      !Number.isSafeInteger(rate.simple.limit) || rate.simple.limit < 1 || ![10, 60].includes(rate.simple.period)) fail();
}
export function validateRateBootstrap(policy, target, { sourceSha, expectedPredecessor } = {}) {
  const bootstrap = policy.productionBootstrap;
  if (bootstrap === undefined) return null;
  const alreadyProvisioned = bootstrap?.nativeRateAlreadyProvisioned;
  keys(bootstrap, ["schema", "sourceSha", "expectedPredecessor", "predecessorVersions", "workers", "nativeInventoryScope", "dispatchNamespaces", "recovery",
    ...(alreadyProvisioned === undefined ? [] : ["nativeRateAlreadyProvisioned"])]);
  if (target !== "production" || bootstrap.schema !== "production-core-and-callers-bootstrap-v1" ||
      (alreadyProvisioned !== undefined && alreadyProvisioned !== true) ||
      !/^[0-9a-f]{40}$/u.test(bootstrap.sourceSha) || !/^[0-9a-f]{64}$/u.test(bootstrap.expectedPredecessor) ||
      (sourceSha !== undefined && sourceSha !== bootstrap.sourceSha) ||
      (expectedPredecessor !== undefined && expectedPredecessor !== bootstrap.expectedPredecessor) ||
      !Array.isArray(bootstrap.workers) || bootstrap.workers.length < 3 || bootstrap.workers.length > 100) fail();
  if (!Array.isArray(bootstrap.predecessorVersions) || bootstrap.predecessorVersions.length !== 3 ||
      bootstrap.predecessorVersions.some(v => !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(v)) ||
      createHash("sha256").update(JSON.stringify(bootstrap.predecessorVersions)).digest("hex") !== bootstrap.expectedPredecessor) fail();
  const minimumRetention = bootstrap.recovery?.minimumEffectiveRetentionDays;
  keys(bootstrap.recovery, minimumRetention === undefined ? ["recipientSpkiSha256", "retentionDays"] :
    ["recipientSpkiSha256", "retentionDays", "minimumEffectiveRetentionDays"]);
  if (bootstrap.nativeInventoryScope !== "ordinary-workers" || bootstrap.dispatchNamespaces !== "unassessed" ||
      !/^[0-9a-f]{64}$/u.test(bootstrap.recovery.recipientSpkiSha256) || bootstrap.recovery.retentionDays !== 90 ||
      (minimumRetention !== undefined && minimumRetention !== 89)) fail();
  const names = new Set(), tags = new Set();
  let provisionedRates = 0;
  for (const worker of bootstrap.workers) {
    keys(worker, ["name", "tag", "rates"]);
    if (!/^[a-z0-9_][a-z0-9_-]{0,127}$/u.test(worker.name) || !/^[0-9a-f]{32}$/u.test(worker.tag) ||
        names.has(worker.name) || tags.has(worker.tag) || !Array.isArray(worker.rates) || worker.rates.length > 100) fail();
    names.add(worker.name); tags.add(worker.tag);
    const bindings = new Set();
    for (const rate of worker.rates) {
      validateRate(rate);
      if (bindings.has(rate.name)) fail();
      if (rate.namespace_id === "1008" ||
          (worker.name === "atrinik-metaserver" && rate.name === productionAccessRate.name)) {
        if (!alreadyProvisioned || worker.name !== "atrinik-metaserver" ||
            !same(rate, productionAccessRate) || ++provisionedRates !== 1) fail();
      }
      bindings.add(rate.name);
    }
  }
  if (alreadyProvisioned && provisionedRates !== 1) fail();
  const production = policy.cohorts.find(c => c.environment === "production");
  for (const caller of production.workers.slice(1)) {
    const empty = caller.secrets.length === 0;
    if (!(alreadyProvisioned && empty) && !same([...caller.secrets].sort(), [...legacyCallerSecrets])) fail();
    const keyNames = ["SOURCE_TAG_KEY_CURRENT_ID", "SOURCE_TAG_KEY_PREVIOUS_ID"];
    const keyBindings = caller.variables.filter(v => keyNames.includes(v.binding));
    const keyIds = keyNames
      .map(binding => caller.variables.find(v => v.binding === binding)?.value);
    if (empty && keyBindings.length !== 0) fail();
    if (alreadyProvisioned && keyBindings.length === 0) {
      // Absence is approved baseline authority, never a runtime fallback after
      // a failed retirement. Every caller still requires fresh disabled staging.
      const circuits = caller.role === "publisher" ? ["PUBLISH_ENABLED", "GAME_PUBLISH_ENABLED"] : ["RENDEZVOUS_ENABLED"];
      if (circuits.some(binding => caller.variables.find(v => v.binding === binding)?.value !== "disabled")) fail();
    } else if (keyBindings.length !== 2 || keyIds.some(v => !/^[A-Za-z0-9_-]{1,32}$/u.test(v ?? "")) ||
      keyIds[0] === keyIds[1]) fail();
  }
  for (const cohort of policy.cohorts.filter(c => c.accountId === production.accountId)) {
    for (const worker of cohort.workers) {
      const expected = bootstrap.workers.find(v => v.name === worker.name);
      if (!expected || !same(sorted(worker.resources.filter(v => v.type === "rate-limit")),
        sorted(expected.rates.map(v => ({ binding: v.name, type: "rate-limit", id: v.namespace_id }))))) fail();
    }
  }
  return bootstrap;
}
export const legacyCallerSecrets = Object.freeze(["SOURCE_TAG_KEY_CURRENT", "SOURCE_TAG_KEY_PREVIOUS"]);
// Derive once from the approved policy, not from a post-PATCH observation.
// Counts describe genuine intent/receipt artifacts; an observation creates none.
export function bootstrapCallerDispositions(policy, target, authority = {}) {
  if (!validateRateBootstrap(policy, target, authority)) return Object.freeze({});
  return Object.freeze(Object.fromEntries(policy.cohorts.find(c => c.environment === target).workers
    .filter(w => w.role !== "core").map(w => [w.role, Object.freeze({
      role: w.role, operation: w.secrets.length === 0 ? "observe-secret-free" : "retire-pair",
      baselineSecrets: Object.freeze([...w.secrets].sort()),
      retirementArtifacts: w.secrets.length === 0 ? 0 : 2,
    })])));
}
export function bootstrapDesiredWorker(worker, bootstrap) {
  if (!bootstrap) return worker;
  if (worker.name === "atrinik-metaserver") return { ...worker,
    resources: bootstrap.nativeRateAlreadyProvisioned ? [...worker.resources] : [...worker.resources, productionAccessResource] };
  if (["atrinik-metaserver-publisher", "atrinik-metaserver-rendezvous"].includes(worker.name)) return { ...worker, secrets: [] };
  return worker;
}
export function validateBootstrapConfiguration(bootstrap, configs) {
  if (!bootstrap) return;
  const rate = configs[0]?.ratelimits?.find(v => v.name === productionAccessRate.name);
  if (!same(rate, productionAccessRate)) fail();
  for (const [index, config] of configs.entries()) {
    const expected = bootstrap.workers.find(v => v.name === config.name);
    if (!expected || !same(sorted(config.ratelimits ?? []), sorted(index === 0 && !bootstrap.nativeRateAlreadyProvisioned
      ? [...expected.rates, productionAccessRate] : expected.rates))) fail();
  }
}
export function compareBootstrapInventory(bootstrap, inventory, phase) {
  if (!["baseline", "uploading", "added"].includes(phase) || !Array.isArray(inventory)) fail();
  const base = sorted(bootstrap.workers.map(w => ({ ...w, rates: sorted(w.rates) })));
  const added = sorted(bootstrap.workers.map(w => ({ ...w,
    rates: sorted(w.name === "atrinik-metaserver" && !bootstrap.nativeRateAlreadyProvisioned
      ? [...w.rates, productionAccessRate] : w.rates) })));
  const observed = sorted(inventory.map(w => ({ ...w, rates: sorted(w.rates) })));
  if (phase !== "baseline" && same(observed, added)) return "added";
  if (phase !== "added" && same(observed, base)) return "baseline";
  fail();
}
