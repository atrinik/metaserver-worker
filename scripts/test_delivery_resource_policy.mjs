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
      bindings.push({ type: "plain_text", name: "PUBLISH_ENABLED", text: "false" });
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
    vars: Object.fromEntries(worker.variables.map((v) => [v.binding, v.value])),
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

for (const target of ["development", "production"]) {
  for (const change of ["modify", "add", "remove"]) test(`${target} rejects non-target plaintext ${change}`, async () => {
    const { policy, observed } = fixture();
    const other = policy.cohorts.find(c => c.environment !== target);
    const bindings = observed.get(other.workers[0].name).settings.bindings;
    if (change === "modify") bindings.find(b => b.name === "PUBLISH_ENABLED").text = "true";
    if (change === "add") bindings.push({ type: "plain_text", name: "SOURCE_TAG_KEY_ID_CURRENT", text: "unexpected" });
    if (change === "remove") bindings.splice(bindings.findIndex(b => b.name === "PUBLISH_ENABLED"), 1);
    await assert.rejects(assertResourcePolicyLive(policy, { target, accountId,
      readWorker: async (_account, name) => observed.get(name) }), /provider.*drift/);
  });
}
test("target plaintext follows delivery config while missing policy inventories fail closed", () => {
  const { policy, configs } = fixture();
  configs[0].vars.PUBLISH_ENABLED = "true";
  assert.doesNotThrow(() => validateResourceConfigurations(policy, "development", configs));
  delete policy.cohorts[0].workers[0].variables;
  assert.throws(() => validateResourcePolicy(policy, "development", accountId), /schema/);
});

test("target staged circuits may change while origin and non-target plaintext stay pinned", async () => {
  const { policy, observed, configs } = fixture();
  observed.get("atrinik-metaserver-development").settings.bindings.find(b => b.name === "PUBLISH_ENABLED").text = "true";
  configs[0].vars.PUBLISH_ENABLED = "true";
  assert.doesNotThrow(() => validateResourceConfigurations(policy, "development", configs));
  await assertResourcePolicyLive(policy, { target: "development", accountId,
    readWorker: async (_account, name) => observed.get(name) });
  observed.get("atrinik-metaserver-development").settings.bindings.find(b => b.name === "CLASSIC_DIRECTORY_PUBLIC_ORIGIN").text = "https://drift.invalid";
  await assert.rejects(assertResourcePolicyLive(policy, { target: "development", accountId,
    readWorker: async (_account, name) => observed.get(name) }), /provider.*drift/);
});

// A bootstrap is a reviewed transition from observed old authority, never a
// replacement policy that pretends the future graph already exists.
import { createHash } from "node:crypto";
import { createResourcePolicyFence } from "./delivery-resource-policy.mjs";
import { productionAccessRate, legacyCallerSecrets, validateRateBootstrap,
  compareBootstrapInventory, projectNativeRates } from "./production-rate-bootstrap.mjs";
function bootstrapFixture() {
  const value = fixture();
  const { policy, observed } = value;
  for (const worker of policy.cohorts[0].workers) {
    const live = observed.get(worker.name);
    live.settings.bindings.find(v => v.name === "PUBLISH_ENABLED").text = "disabled";
    for (const binding of live.settings.bindings.filter(v => v.type === "ratelimit")) binding.simple = { limit: 16, period: 60 };
    if (worker.role === "core") {
      live.settings.bindings.push(...["GAME_PUBLISH_ENABLED", "RENDEZVOUS_ENABLED"]
        .map(name => ({ type: "plain_text", name, text: "disabled" })));
    } else {
      live.settings.bindings.push(...legacyCallerSecrets.map(name => ({ name, type: "secret_text" })),
        ...["SOURCE_TAG_KEY_CURRENT_ID", "SOURCE_TAG_KEY_PREVIOUS_ID"].map((name, i) => ({ name, type: "plain_text", text: `epoch-${i}` })));
    }
    Object.assign(worker, projectWorkerResources({ name: worker.name, role: worker.role, ...live }));
  }
  for (const live of observed.values()) for (const binding of live.settings.bindings)
    if (binding.type === "ratelimit") binding.simple = { limit: 16, period: 60 };
  const versions = [1, 2, 3].map(n => `${String(n).repeat(8)}-aaaa-bbbb-cccc-${String(n).repeat(12)}`);
  const bootstrap = policy.productionBootstrap = {
    schema: "production-core-and-callers-bootstrap-v1", sourceSha: "1".repeat(40),
    expectedPredecessor: createHash("sha256").update(JSON.stringify(versions)).digest("hex"),
    predecessorVersions: versions,
    nativeInventoryScope: "ordinary-workers", dispatchNamespaces: "unassessed",
    recovery: { recipientSpkiSha256: "4".repeat(64), retentionDays: 90 },
    workers: [...observed].map(([name, live], index) => ({ name,
      tag: (index + 1).toString(16).repeat(32), rates: projectNativeRates(live.settings.bindings) })),
  };
  const inventory = () => bootstrap.workers.map(worker => ({ ...worker,
    rates: projectNativeRates(observed.get(worker.name).settings.bindings) }));
  const readWorker = Object.assign(async (_account, name) => observed.get(name), { rateInventory: async () => inventory() });
  const options = { target: "production", accountId, readWorker, sourceSha: bootstrap.sourceSha,
    expectedPredecessor: bootstrap.expectedPredecessor };
  const gate = () => createResourcePolicyFence(policy, options);
  const add = () => observed.get("atrinik-metaserver").settings.bindings.push({ type: "ratelimit", ...structuredClone(productionAccessRate) });
  const retire = role => { const live = observed.get(`atrinik-metaserver-${role}`);
    live.settings.bindings = live.settings.bindings.filter(v => v.type !== "secret_text"); };
  return { ...value, bootstrap, inventory, options, gate, add, retire };
}

test("bootstrap binds source and approved predecessor and requires an observed old authority graph", () => {
  const { policy, bootstrap, options } = bootstrapFixture();
  assert.doesNotThrow(() => validateResourcePolicy(policy, "production", accountId));
  assert.throws(() => validateResourcePolicy(policy, "development", accountId));
  assert.throws(() => createResourcePolicyFence(policy, { ...options, sourceSha: "2".repeat(40) }));
  assert.throws(() => createResourcePolicyFence(policy, { ...options, expectedPredecessor: "2".repeat(64) }));
  assert.throws(() => createResourcePolicyFence(policy, { ...options, sourceSha: undefined }));
  const previous = resourcePolicyDigest(policy);
  bootstrap.sourceSha = "3".repeat(40);
  assert.notEqual(resourcePolicyDigest(policy), previous);
  bootstrap.predecessorVersions.reverse();
  assert.throws(() => validateResourcePolicy(policy, "production", accountId));
});

test("bootstrap cannot grant another namespace, omit an account peer or relax caller authority", () => {
  for (const change of [
    x => { x.bootstrap.nativeInventoryScope = "entire-account"; },
    x => { x.bootstrap.dispatchNamespaces = "absent"; },
    x => { x.bootstrap.recovery.retentionDays = 1; },
    x => { x.bootstrap.workers[0].rates.push({ ...productionAccessRate }); },
    x => { x.bootstrap.workers.pop(); },
    x => { x.policy.cohorts[0].workers[1].secrets.push("EXTRA"); },
    x => { x.policy.cohorts[0].workers[1].variables = x.policy.cohorts[0].workers[1].variables.filter(v => !v.binding.endsWith("_ID")); },
    x => { x.bootstrap.workers[1].tag = x.bootstrap.workers[0].tag; },
    x => { x.policy.cohorts[0].workers[0].resources.push({ binding: "WRONG", type: "rate-limit", id: "1008" }); },
  ]) { const x = bootstrapFixture(); change(x); assert.throws(() => validateResourcePolicy(x.policy, "production", accountId)); }
});

test("bootstrap starts disabled, admits only its own addition, and never returns to missing namespace", async () => {
  const x = bootstrapFixture(); const gate = x.gate();
  assert.throws(() => gate.beginCoreUpload());
  await gate.fence(); gate.beginCoreUpload();
  await gate.fence(); // failed upload before any remote effect can still recover disabled
  assert.throws(() => gate.confirmCoreAdded());
  x.add(); await gate.fence(); gate.confirmCoreAdded();
  x.observed.get("atrinik-metaserver").settings.bindings.pop();
  await assert.rejects(gate.fence());
  const next = bootstrapFixture(); next.add();
  await assert.rejects(next.gate().fence()); // existing native binding is not an initial bootstrap
  const enabled = bootstrapFixture();
  enabled.observed.get("atrinik-metaserver").settings.bindings.find(v => v.name === "PUBLISH_ENABLED").text = "true";
  await assert.rejects(enabled.gate().fence());
});

test("bootstrap fences every peer and only consumes exact caller secret retirements", async () => {
  const x = bootstrapFixture(); const gate = x.gate();
  await gate.fence(); gate.beginCoreUpload(); x.add(); await gate.fence();
  x.retire("publisher"); await assert.rejects(gate.fence());
  gate.beginCallerRetirement("publisher"); await gate.fence();
  gate.confirmCallerRetired("publisher"); await gate.fence();
  assert.throws(() => gate.beginCallerRetirement("publisher"));
  const caller = x.observed.get("atrinik-metaserver-publisher");
  caller.settings.bindings.push({ type: "secret_text", name: legacyCallerSecrets[0] });
  await assert.rejects(gate.fence()); caller.settings.bindings.pop();
  gate.beginCallerRetirement("rendezvous");
  const peer = x.observed.get("atrinik-metaserver-development");
  peer.settings.bindings.find(v => v.name === "PUBLISH_ENABLED").text = "true";
  await assert.rejects(gate.fence());
});

test("ambiguous retirement can preserve a partial subset for disabled recovery, but never extra authority", async () => {
  const x = bootstrapFixture(); const gate = x.gate();
  await gate.fence(); gate.beginCoreUpload(); x.add(); await gate.fence();
  gate.beginCallerRetirement("publisher");
  const caller = x.observed.get("atrinik-metaserver-publisher");
  caller.settings.bindings = caller.settings.bindings.filter(v => v.name !== legacyCallerSecrets[0]);
  await gate.fence();
  caller.settings.bindings.push({ type: "secret_text", name: "NEW_SECRET" });
  await assert.rejects(gate.fence());
});

test("reconciliation requires completed native addition and both zero-secret callers", async () => {
  const x = bootstrapFixture(); const gate = createResourcePolicyFence(x.policy, { ...x.options, completedBootstrap: true });
  await assert.rejects(gate.fence()); x.add();
  await assert.rejects(gate.fence()); x.retire("publisher");
  await assert.rejects(gate.fence()); x.retire("rendezvous"); await gate.fence();
});

test("bootstrap rejects a new or replaced global Worker and a peer collision even outside governed cohorts", () => {
  const { bootstrap, inventory } = bootstrapFixture();
  const collision = inventory(); collision.push({ name: "unmanaged-peer", tag: "f".repeat(32), rates: [productionAccessRate] });
  assert.throws(() => compareBootstrapInventory(bootstrap, collision, "baseline"));
  const replaced = inventory(); replaced[0].tag = "f".repeat(32);
  assert.throws(() => compareBootstrapInventory(bootstrap, replaced, "baseline"));
  const changed = structuredClone(inventory()); changed[1].rates[0].simple.limit++;
  assert.throws(() => compareBootstrapInventory(bootstrap, changed, "baseline"));
});

test("bootstrap desired configs differ only by exact core1008 and zero caller secrets", () => {
  const { policy, observed } = bootstrapFixture();
  const configs = policy.cohorts[0].workers.map(worker => ({
    name: worker.name, account_id: accountId,
    d1_databases: worker.resources.filter(v => v.type === "d1").map(v => ({ binding: v.binding, database_id: v.id })),
    r2_buckets: worker.resources.filter(v => v.type === "r2").map(v => ({ binding: v.binding, bucket_name: v.id })),
    analytics_engine_datasets: worker.resources.filter(v => v.type === "analytics").map(v => ({ binding: v.binding, dataset: v.id })),
    durable_objects: { bindings: worker.resources.filter(v => v.type === "durable-object").map(v => ({ name: v.binding, class_name: v.className })) },
    ratelimits: projectNativeRates(observed.get(worker.name).settings.bindings), services: worker.services,
    vars: Object.fromEntries(worker.variables.map(v => [v.binding, v.value])),
    secrets: { required: worker.role === "core" ? worker.secrets : [] }, routes: worker.routes.map(pattern => ({ pattern, custom_domain: true })),
  }));
  configs[0].ratelimits.push(structuredClone(productionAccessRate));
  validateResourceConfigurations(policy, "production", configs);
  for (const change of [
    c => { c[0].ratelimits.pop(); },
    c => { c[0].ratelimits.at(-1).namespace_id = "1009"; },
    c => { c[0].ratelimits.at(-1).simple.limit = 17; },
    c => { c[0].ratelimits[0].simple.limit = 17; },
    c => { c[1].secrets.required = [...legacyCallerSecrets]; },
    c => { c[0].r2_buckets[0].bucket_name = "replacement"; },
  ]) { const candidate = structuredClone(configs); change(candidate); assert.throws(() => validateResourceConfigurations(policy, "production", candidate)); }
});

function globalInventoryFetch(change = () => {}) {
  const names = ["first", "second"];
  const versions = names.map((_, i) => `${i + 1}0000000-aaaa-bbbb-cccc-000000000000`);
  return async (url, init) => {
    assert.equal(init.method, "GET"); assert.equal(init.redirect, "error"); assert.equal(init.body, undefined);
    const path = new URL(url).pathname.split(`/accounts/${accountId}`)[1];
    let result;
    if (path === "/workers/scripts") result = names.map((id, i) => ({ id, tag: `${i + 1}`.repeat(32) }));
    else {
      const [, name, endpoint, version] = /^\/workers\/scripts\/([^/]+)\/([^/]+)(?:\/(.*))?$/u.exec(path);
      const index = names.indexOf(name), id = versions[index];
      const bindings = [{ type: "ratelimit", name: "GLOBAL", namespace_id: `50${index}`, simple: { limit: 16, period: 60 } }];
      if (endpoint === "versions") result = version ? { id, resources: { bindings } } : { items: [{ id }] };
      else if (endpoint === "deployments") result = { deployments: [{ versions: [{ version_id: id, percentage: 100 }] }] };
      else if (endpoint === "settings") result = { bindings };
      else assert.fail("unexpected request");
    }
    const body = { success: true, result }; change(path, body);
    return Response.json(body);
  };
}

test("bootstrap provider reader proves ordinary Worker identities and sole active version rate bindings", async () => {
  const reader = resourcePolicyReader({ ATRINIK_DELIVERY_RESOURCE_READ_TOKEN: "fixture-only" }, globalInventoryFetch());
  const result = await reader.rateInventory(accountId);
  assert.equal(result.length, 2); assert.equal(result[1].rates[0].namespace_id, "501");
  for (const change of [
    (path, body) => { if (path.endsWith("/deployments")) body.result.deployments[0].versions[0].percentage = 50; },
    (path, body) => { if (path.endsWith("/deployments")) body.result.deployments[0].versions[0].version_id = "changed"; },
    (path, body) => { if (path.endsWith("/settings")) body.result.bindings[0].namespace_id = "1008"; },
    (path, body) => { if (path === "/workers/scripts") body.result_info = { total_pages: 2 }; },
    (path, body) => { if (path === "/workers/scripts") body.result_info = { total_count: 3 }; },
    (path, body) => { if (path === "/workers/scripts") body.result_info = { cursor: "next" }; },
    (path, body) => { if (path === "/workers/scripts") body.result.push(body.result[0]); },
  ]) {
    await assert.rejects(resourcePolicyReader({ ATRINIK_DELIVERY_RESOURCE_READ_TOKEN: "fixture-only" },
      globalInventoryFetch(change)).rateInventory(accountId));
  }
  let listReads = 0;
  await assert.rejects(resourcePolicyReader({ ATRINIK_DELIVERY_RESOURCE_READ_TOKEN: "fixture-only" }, globalInventoryFetch((path, body) => {
    if (path === "/workers/scripts" && ++listReads === 2) body.result.pop();
  })).rateInventory(accountId));
});
