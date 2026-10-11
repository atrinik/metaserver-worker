// Copyright (C) 2026 Atrinik contributors
import assert from "node:assert/strict";
import test from "node:test";
import { projectWorkerResources, validateResourcePolicy, parseResourcePolicy, resourcePolicyDigest,
  validateResourceConfigurations, assertResourcePolicyLive, resourcePolicyReader } from "./delivery-resource-policy.mjs";

const accountId = "a".repeat(32);
function fixture() {
  const observed = new Map();
  const cohorts = ["production", "development"].map((environment, coordinate) => {
    const core = environment === "production" ? "atrinik-metaserver" : "atrinik-metaserver-development";
    return { environment, accountId, workers: ["core", "publisher", "rendezvous"].map((role, index) => {
      const name = index ? `${core}-${role}` : core;
      const bindings = index === 0 ? [
        { type: "d1", name: "DB", id: `database-${environment}` },
        { type: "r2_bucket", name: "DIRECTORY", bucket_name: `directory-${environment}` },
        { type: "durable_object_namespace", name: "ROOM", namespace_id: `namespace-${environment}`,
          class_name: "Room", script_name: core },
        { type: "analytics_engine", name: "METRICS", dataset: `metrics_${environment}` },
        { type: "plain_text", name: "CLASSIC_DIRECTORY_PUBLIC_ORIGIN", text: `https://classic.${environment}.invalid` },
        { type: "secret_text", name: "SOURCE_TAG_KEY_CURRENT" },
      ] : [{ type: "service", name: "COORDINATOR", service: core,
        entrypoint: role === "publisher" ? "PublisherCoordinator" : "RendezvousCoordinator" },
      { type: "plain_text", name: role === "publisher" ? "PUBLISH_HOSTNAME" : "RENDEZVOUS_HOSTNAME",
        text: `${role}.${environment}.invalid` }];
      bindings.push({ type: "ratelimit", name: "RATE", namespace_id: String(1000 + coordinate * 10 + index) });
      const live = { settings: { bindings }, routes: [], domains: index ? [{ hostname: `${role}.${environment}.invalid`, service: name, environment: "production" }] : [] };
      observed.set(name, live);
      return projectWorkerResources({ name, role, ...live });
    }) };
  });
  const policy = { schema: "atrinik-delivery-resources-v1", cohorts };
  const configs = cohorts[1].workers.map((worker) => ({
    name: worker.name, account_id: accountId,
    d1_databases: worker.resources.filter((v) => v.type === "d1").map((v) => ({ binding: v.binding, database_id: v.id })),
    r2_buckets: worker.resources.filter((v) => v.type === "r2").map((v) => ({ binding: v.binding, bucket_name: v.id })),
    analytics_engine_datasets: worker.resources.filter((v) => v.type === "analytics").map((v) => ({ binding: v.binding, dataset: v.id })),
    durable_objects: { bindings: worker.resources.filter((v) => v.type === "durable-object")
      .map((v) => ({ name: v.binding, class_name: v.className })) },
    ratelimits: worker.resources.filter((v) => v.type === "rate-limit").map((v) => ({ name: v.binding, namespace_id: v.id })),
    services: worker.services,
    vars: Object.fromEntries(worker.origins.map((v) => [v.binding, v.value])),
    secrets: { required: worker.secrets }, routes: worker.routes.map((pattern) => ({ pattern, custom_domain: true })),
  }));
  return { policy, observed, configs };
}

test("policy binds all resource types and desired configurations to their existing cohort", () => {
  const { policy, configs } = fixture();
  assert.doesNotThrow(() => validateResourcePolicy(policy, "development", accountId));
  assert.doesNotThrow(() => validateResourceConfigurations(policy, "development", configs));
  const projected = policy.cohorts[1].workers[0].resources;
  assert.deepEqual(projected.find((v) => v.type === "durable-object"), {
    binding: "ROOM", type: "durable-object", id: "namespace-development",
    owner: "atrinik-metaserver-development", className: "Room",
  });
  const reorder = { cohorts: policy.cohorts, schema: policy.schema };
  assert.equal(resourcePolicyDigest(policy), resourcePolicyDigest(reorder));
  assert.deepEqual(parseResourcePolicy(JSON.stringify(policy), "development", accountId), policy);
});

test("cross-cohort sharing rejects D1, R2, DO, analytics, rate limit and domain identities", () => {
  for (const type of ["d1", "r2", "durable-object", "analytics", "rate-limit"]) {
    const { policy } = fixture();
    const production = policy.cohorts[0].workers[0].resources.find((v) => v.type === type);
    policy.cohorts[1].workers[0].resources.find((v) => v.type === type).id = production.id;
    assert.throws(() => validateResourcePolicy(policy, "development", accountId), /shared/u);
  }
  const { policy } = fixture();
  policy.cohorts[1].workers[1].routes = policy.cohorts[0].workers[1].routes;
  assert.throws(() => validateResourcePolicy(policy, "development", accountId), /shared/u);
});

test("same-cohort purpose sharing and cross-cohort owner/service authority fail closed", () => {
  for (const change of [
    (policy) => { const core = policy.cohorts[1].workers[0]; core.resources.push({ ...core.resources.find((v) => v.type === "r2"), binding: "PRIVATE" }); },
    (policy) => { policy.cohorts[1].workers[0].resources.find((v) => v.type === "durable-object").owner = "atrinik-metaserver"; },
    (policy) => { policy.cohorts[1].workers[1].services[0].service = "atrinik-metaserver"; },
    (policy) => { policy.cohorts[1].workers[1].resources.push({ binding: "HIDDEN", type: "d1", id: "another" }); },
  ]) {
    const { policy } = fixture(); change(policy);
    assert.throws(() => validateResourcePolicy(policy, "development", accountId));
  }
});

test("configs cannot rebind a correct Worker name to another cohort or new resources", () => {
  for (const change of [
    (configs) => { configs[0].d1_databases[0].database_id = "database-production"; },
    (configs) => { configs[0].r2_buckets[0].bucket_name = "new-not-adopted"; },
    (configs) => { configs[0].durable_objects.bindings[0].class_name = "ReplacementRoom"; },
    (configs) => { configs[0].analytics_engine_datasets[0].dataset = "metrics_production"; },
    (configs) => { configs[1].ratelimits[0].namespace_id = "1001"; },
    (configs) => { configs[1].routes[0].pattern = "publisher.production.invalid"; },
  ]) {
    const { policy, configs } = fixture(); change(configs);
    assert.throws(() => validateResourceConfigurations(policy, "development", configs), /differs/u);
  }
});

test("fresh observations are mandatory and policy changes cannot authorize adoption", async () => {
  const { policy, observed } = fixture();
  let reads = 0;
  const readWorker = async (_account, name) => { reads += 1; return observed.get(name); };
  await assertResourcePolicyLive(policy, { target: "development", accountId, readWorker });
  assert.equal(reads, 6);
  await assertResourcePolicyLive(policy, { target: "development", accountId, readWorker });
  assert.equal(reads, 12);
  observed.get("atrinik-metaserver").settings.bindings.find((v) => v.type === "r2_bucket").bucket_name = "directory-development";
  await assert.rejects(assertResourcePolicyLive(policy, { target: "development", accountId, readWorker }), /provider.*drift/u);
  const next = fixture();
  next.policy.cohorts[1].workers[0].resources.find((v) => v.type === "d1").id = "new-database";
  await assert.rejects(assertResourcePolicyLive(next.policy, { target: "development", accountId,
    readWorker: async (_account, name) => next.observed.get(name) }), /provider.*drift/u);
});

test("live DO namespace replacement and previously ignored binding authority fail closed", async () => {
  for (const change of [
    (settings) => { settings.bindings.find((v) => v.type === "durable_object_namespace").namespace_id = "new-namespace"; },
    (settings) => { settings.bindings.find((v) => v.type === "durable_object_namespace").script_name = "atrinik-metaserver"; },
    (settings) => { settings.bindings.push({ type: "kv_namespace", name: "UNREVIEWED", namespace_id: "hidden" }); },
  ]) {
    const { policy, observed } = fixture(); change(observed.get("atrinik-metaserver-development").settings);
    await assert.rejects(assertResourcePolicyLive(policy, { target: "development", accountId,
      readWorker: async (_account, name) => observed.get(name) }));
  }
});

test("target caller secrets are forbidden while unchanged legacy non-target names are observed", async () => {
  const { policy, observed } = fixture();
  policy.cohorts[0].workers[1].secrets.push("SOURCE_TAG_KEY_CURRENT");
  observed.get("atrinik-metaserver-publisher").settings.bindings.push({ type: "secret_text", name: "SOURCE_TAG_KEY_CURRENT" });
  await assertResourcePolicyLive(policy, { target: "development", accountId,
    readWorker: async (_account, name) => observed.get(name) });
  assert.throws(() => validateResourcePolicy(policy, "production", accountId), /callers retain/u);
  policy.cohorts[1].workers[1].secrets.push("SOURCE_TAG_KEY_CURRENT");
  assert.throws(() => validateResourcePolicy(policy, "development", accountId), /callers retain/u);
});

test("resource observer has GET-only bounded authority and rejects incomplete inventories", async () => {
  const { observed } = fixture();
  let calls = 0;
  const reader = resourcePolicyReader({ ATRINIK_DELIVERY_RESOURCE_READ_TOKEN: "read-only" }, async (url, options) => {
    assert.equal(options.method, "GET"); calls += 1;
    const path = new URL(url).pathname;
    const live = observed.get("atrinik-metaserver-development");
    return Response.json({ success: true, result: path.endsWith("/settings") ? live.settings : [], result_info: { total_pages: 1, count: path.endsWith("/settings") ? undefined : 0 } });
  });
  assert.deepEqual(await reader(accountId, "atrinik-metaserver-development"), observed.get("atrinik-metaserver-development"));
  assert.equal(calls, 3);
  const incomplete = resourcePolicyReader({ ATRINIK_DELIVERY_RESOURCE_READ_TOKEN: "read-only" },
    async () => Response.json({ success: true, result: [], result_info: { total_pages: 2 } }));
  await assert.rejects(incomplete(accountId, "atrinik-metaserver-development"), /pagination/u);
  assert.throws(() => resourcePolicyReader({}), /token missing/u);
});


test("non-target production and development identities cannot be replaced by clean decoys", () => {
  for (const target of ["production", "development"]) {
    const { policy } = fixture();
    const decoy = policy.cohorts.find((cohort) => cohort.environment !== target);
    decoy.workers[0].name = "clean-decoy-core";
    assert.throws(() => validateResourcePolicy(policy, target, accountId), /cohort identity/u);
  }
});

test("public domains filtering proves ownership and uses filtered count rather than global pages", async () => {
  const { observed } = fixture();
  const worker = "atrinik-metaserver-development-publisher";
  const live = observed.get(worker);
  const reader = resourcePolicyReader({ ATRINIK_DELIVERY_RESOURCE_READ_TOKEN: "read-only" }, async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/domains")) {
      assert.equal(parsed.searchParams.get("service"), worker);
      assert.equal(parsed.searchParams.get("environment"), "production");
      return Response.json({ success: true, result: live.domains,
        result_info: { count: 1, total_pages: 100, total_count: 2000 } });
    }
    return Response.json({ success: true, result: parsed.pathname.endsWith("/settings") ? live.settings : [] });
  });
  assert.deepEqual(await reader(accountId, worker), live);
  assert.throws(() => projectWorkerResources({ name: worker, role: "publisher", ...live,
    domains: [{ ...live.domains[0], service: "atrinik-metaserver-publisher" }] }), /domain-only/u);
});
