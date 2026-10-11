// Copyright (C) 2026 Atrinik contributors
import { createHash } from "node:crypto";

const roles = ["core", "publisher", "rendezvous"];
const originBindings = ["CLASSIC_DIRECTORY_PUBLIC_ORIGIN", "GAME_DIRECTORY_PUBLIC_ORIGIN",
  "PUBLISH_HOSTNAME", "RENDEZVOUS_HOSTNAME"];
const resourceTypes = new Set(["d1", "r2", "durable-object", "analytics", "rate-limit"]);
const fail = (message) => { throw new Error(`delivery resource isolation: ${message}`); };
const sorted = (values) => [...values].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
export function canonicalResourcePolicy(value) {
  if (Array.isArray(value)) return value.map(canonicalResourcePolicy);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort()
    .map((key) => [key, canonicalResourcePolicy(value[key])]));
  return value;
}
const same = (a, b) => JSON.stringify(canonicalResourcePolicy(a)) === JSON.stringify(canonicalResourcePolicy(b));
const nonempty = (value) => typeof value === "string" && value.length > 0 && value.length <= 512;
function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join() !== [...keys].sort().join()) fail("inventory schema drift");
}
function unique(values) { return new Set(values).size === values.length; }
function originHost(binding, value) {
  if (!nonempty(value)) fail("origin value missing");
  if (binding.endsWith("_HOSTNAME")) {
    if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u.test(value)) fail("hostname authority invalid");
    return value;
  }
  let url;
  try { url = new URL(value); } catch { fail("directory origin invalid"); }
  if (url.protocol !== "https:" || url.origin !== value || url.username || url.password)
    fail("directory origin authority invalid");
  return url.hostname;
}

// Unknown binding types fail closed: ignoring a newly introduced stateful binding
// would let a configuration escape the disjoint-resource policy.
export function projectWorkerResources({ name, role, settings, routes, domains }) {
  if (!Array.isArray(settings?.bindings) || !Array.isArray(routes) || !Array.isArray(domains) ||
      routes.length !== 0) fail("complete settings and domain-only routes required");
  const resources = [], services = [], origins = [], secrets = [];
  if (!unique(settings.bindings.map((value) => value.name))) fail("duplicate live binding");
  for (const binding of settings.bindings) {
    const base = { binding: binding.name };
    switch (binding.type) {
      case "d1": resources.push({ ...base, type: "d1", id: binding.id }); break;
      case "r2_bucket": resources.push({ ...base, type: "r2", id: binding.bucket_name }); break;
      case "analytics_engine": resources.push({ ...base, type: "analytics", id: binding.dataset }); break;
      case "ratelimit": resources.push({ ...base, type: "rate-limit", id: String(binding.namespace_id) }); break;
      case "durable_object_namespace":
        if (binding.environment !== undefined && binding.environment !== "production")
          fail("cross-environment Durable Object binding");
        resources.push({ ...base, type: "durable-object", id: binding.namespace_id,
          owner: binding.script_name ?? name, className: binding.class_name }); break;
      case "service":
        if (binding.environment !== undefined && binding.environment !== "production")
          fail("cross-environment Service Binding");
        services.push({ ...base, service: binding.service, entrypoint: binding.entrypoint }); break;
      case "plain_text":
        if (originBindings.includes(binding.name)) origins.push({ ...base, value: binding.text }); break;
      case "secret_text": secrets.push(binding.name); break;
      default: fail("unrecognized live binding authority");
    }
  }
  return { name, role, resources: sorted(resources), services: sorted(services), origins: sorted(origins),
    routes: domains.map((value) => value.hostname).sort(), secrets: secrets.sort() };
}

export function validateResourcePolicy(policy, target, accountId) {
  exactKeys(policy, ["schema", "cohorts"]);
  if (policy.schema !== "atrinik-delivery-resources-v1" || !Array.isArray(policy.cohorts) ||
      policy.cohorts.length < 2 || policy.cohorts.length > 3 ||
      !unique(policy.cohorts.map((value) => value.environment)) ||
      !policy.cohorts.some((value) => value.environment === "production") ||
      !policy.cohorts.some((value) => value.environment === "development")) fail("complete cohort inventory required");
  const ownership = new Map();
  const resourceIdentities = new Set();
  const own = (key, environment) => {
    if (ownership.has(key) && ownership.get(key) !== environment) fail("resource shared across environments");
    ownership.set(key, environment);
  };
  for (const cohort of policy.cohorts) {
    exactKeys(cohort, ["environment", "accountId", "workers"]);
    if (!["production", "development", "review"].includes(cohort.environment) ||
        !/^[0-9a-f]{32}$/u.test(cohort.accountId ?? "") || !Array.isArray(cohort.workers) ||
        cohort.workers.length !== 3 || !same(cohort.workers.map((worker) => worker.role), roles) ||
        !unique(cohort.workers.map((worker) => worker.name))) fail("cohort identity invalid");
    for (const worker of cohort.workers) {
      exactKeys(worker, ["name", "role", "resources", "services", "origins", "routes", "secrets"]);
      if (!nonempty(worker.name) || !/^[a-z0-9][a-z0-9-]*$/u.test(worker.name) ||
          [worker.resources, worker.services, worker.origins, worker.routes, worker.secrets].some((v) => !Array.isArray(v)))
        fail("Worker inventory invalid");
      own(`${cohort.accountId}:worker:${worker.name}`, cohort.environment);
      if (!unique(worker.resources.map((value) => value.binding)) ||
          !unique(worker.services.map((value) => value.binding)) ||
          !unique(worker.origins.map((value) => value.binding)) || !unique(worker.secrets) ||
          !unique(worker.routes)) fail("duplicate inventory authority");
      for (const resource of worker.resources) {
        exactKeys(resource, resource.type === "durable-object"
          ? ["binding", "type", "id", "owner", "className"] : ["binding", "type", "id"]);
        if (!resourceTypes.has(resource.type) || !nonempty(resource.binding) || !nonempty(resource.id))
          fail("resource identity incomplete");
        if (resource.type === "durable-object" &&
            (resource.owner !== cohort.workers[0].name || !nonempty(resource.className)))
          fail("Durable Object owner or class invalid");
        if (worker.role !== "core" && resource.type !== "rate-limit") fail("caller gained state authority");
        const identity = `${cohort.accountId}:${resource.type}:${resource.id}`;
        if (resourceIdentities.has(identity)) fail("resource purpose or environment is shared");
        resourceIdentities.add(identity);
        own(identity, cohort.environment);
      }
      for (const service of worker.services) {
        exactKeys(service, ["binding", "service", "entrypoint"]);
        if (worker.role === "core" || service.service !== cohort.workers[0].name ||
            service.binding !== "COORDINATOR" ||
            service.entrypoint !== (worker.role === "publisher" ? "PublisherCoordinator" : "RendezvousCoordinator"))
          fail("Service Binding escapes cohort");
      }
      if (worker.services.length !== (worker.role === "core" ? 0 : 1)) fail("Service Binding inventory incomplete");
      for (const origin of worker.origins) {
        exactKeys(origin, ["binding", "value"]);
        if (!originBindings.includes(origin.binding)) fail("unknown origin binding");
        own(`hostname:${originHost(origin.binding, origin.value)}`, cohort.environment);
      }
      for (const route of worker.routes) own(`hostname:${originHost("PUBLISH_HOSTNAME", route)}`, cohort.environment);
      if (worker.secrets.some((value) => !nonempty(value))) fail("secret name invalid");
      // Older, unpromoted production may retain obsolete caller secret names.
      // Observing those names never authorizes installing them on this target.
      if (cohort.environment === target && worker.role !== "core" && worker.secrets.length)
        fail("target callers retain signing or other secret authority");
    }
  }
  const cohort = policy.cohorts.find((value) => value.environment === target);
  if (!cohort || cohort.accountId !== accountId) fail("target account differs from inventory");
  return cohort;
}

export function parseResourcePolicy(document, target, accountId) {
  if (typeof document !== "string" || Buffer.byteLength(document) > 48 * 1024)
    fail("private inventory missing or oversized");
  let policy;
  try { policy = JSON.parse(document); } catch { fail("private inventory is not JSON"); }
  validateResourcePolicy(policy, target, accountId);
  return policy;
}
export function resourcePolicyDigest(policy) {
  return createHash("sha256").update(JSON.stringify(canonicalResourcePolicy(policy))).digest("hex");
}

export function validateResourceConfigurations(policy, target, configs) {
  const cohort = validateResourcePolicy(policy, target, configs[0]?.account_id);
  if (configs.length !== 3) fail("target configuration cohort incomplete");
  for (const [index, config] of configs.entries()) {
    const expected = cohort.workers[index];
    const resources = [
      ...(config.d1_databases ?? []).map((v) => ({ binding: v.binding, type: "d1", id: v.database_id })),
      ...(config.r2_buckets ?? []).map((v) => ({ binding: v.binding, type: "r2", id: v.bucket_name })),
      ...(config.analytics_engine_datasets ?? []).map((v) => ({ binding: v.binding, type: "analytics", id: v.dataset })),
      ...(config.ratelimits ?? []).map((v) => ({ binding: v.name, type: "rate-limit", id: String(v.namespace_id) })),
      ...(config.durable_objects?.bindings ?? []).map((v) => {
        const previous = expected.resources.find((r) => r.type === "durable-object" && r.binding === v.name);
        if (!previous) fail("Durable Object namespace not previously inventoried");
        return { binding: v.name, type: "durable-object", id: previous.id,
          owner: v.script_name ?? config.name, className: v.class_name };
      }),
    ];
    const actual = { name: config.name, role: roles[index], resources: sorted(resources),
      services: sorted((config.services ?? []).map((v) => ({ binding: v.binding, service: v.service, entrypoint: v.entrypoint }))),
      origins: sorted(originBindings.filter((binding) => config.vars?.[binding] !== undefined)
        .map((binding) => ({ binding, value: config.vars[binding] }))),
      routes: (config.routes ?? []).map((v) => {
        if (v.custom_domain !== true) fail("target acquired a non-domain route");
        return v.pattern;
      }).sort(), secrets: [...(config.secrets?.required ?? [])].sort() };
    if (config.account_id !== cohort.accountId || !same(actual, normalizeWorker(expected)))
      fail("target configuration differs from existing resource inventory");
  }
}
function normalizeWorker(worker) {
  return { ...worker, resources: sorted(worker.resources), services: sorted(worker.services),
    origins: sorted(worker.origins), routes: [...worker.routes].sort(), secrets: [...worker.secrets].sort() };
}

export async function assertResourcePolicyLive(policy, { target, accountId, readWorker }) {
  validateResourcePolicy(policy, target, accountId);
  // All cohorts are re-read, so a policy edit alone cannot authorize moving a
  // resource and a previously disjoint non-target cannot silently adopt this one.
  for (const cohort of policy.cohorts) {
    for (const worker of cohort.workers) {
      const observed = await readWorker(cohort.accountId, worker.name);
      const actual = projectWorkerResources({ name: worker.name, role: worker.role, ...observed });
      if (!same(actual, normalizeWorker(worker))) fail("fresh provider resource inventory drift");
    }
  }
}

export function resourcePolicyReader(environment, fetcher = fetch) {
  const token = environment.ATRINIK_DELIVERY_RESOURCE_READ_TOKEN;
  if (!token) fail("read-only resource inventory token missing");
  const get = async (accountId, path) => {
    const response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`, {
      method: "GET", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok || !response.body) fail("resource readback rejected");
    const reader = response.body.getReader();
    const chunks = []; let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 2_000_000) { await reader.cancel(); fail("resource response exceeds bound"); }
      chunks.push(Buffer.from(value));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (body.success !== true || body.result === undefined) fail("resource response incomplete");
    if (body.result_info?.total_pages > 1 || body.result_info?.total_count > 100)
      fail("resource response pagination exceeds bound");
    return body.result;
  };
  return async (accountId, name) => {
    const worker = encodeURIComponent(name);
    const [settings, routes, domains] = await Promise.all([
      get(accountId, `/workers/scripts/${worker}/settings`),
      get(accountId, `/workers/services/${worker}/environments/production/routes?show_zonename=true`),
      get(accountId, `/workers/domains/records?page=0&per_page=100&service=${worker}&environment=production`),
    ]);
    return { settings, routes, domains };
  };
}
