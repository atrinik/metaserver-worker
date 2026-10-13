// Copyright (C) 2026 Atrinik contributors
import test from "node:test";
import { createProductionReadPacer } from "./production-read-pacing.mjs";
import { retirementFailureDiagnostic, callerObservationFailureDiagnostic } from "./production-retirement-diagnostics.mjs";
import { virtualClock } from "./production-test-clock.mjs";
import { orchestrateDelivery, deliveryFailureRecord, prepareBootstrapCallerHandoff, verifyCallerActivationHandoff } from "./production-delivery.mjs";
import assert from "node:assert/strict";
import { mkdtemp, chmod, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { verifyRecoveryArtifactProof } from "./production-recovery-artifacts.mjs";
import { callerRetirementSecrets, callerRetirementBody, callerRetirementBodyV3, observeSecretFreeCaller, callerRetirementDigest, verifyCallerRetirementPost,
  retireCallerSecrets, observeCallerRetirement, createCallerRetirementPatch,
  createCallerRetirementRecorder, parseCallerRetirementModules } from "./production-caller-retirement.mjs";
import { parseCallerRetirementQualification, loadCallerRetirementQualification, requireCallerRetirementQualification } from "./production-retirement-qualification.mjs";
import { fixtureQualification, qualificationDocument, qualificationBytes } from "./fixtures/retirement-qualification.mjs";
const qualification = await fixtureQualification();
const accountId = "a".repeat(32), hash = "b".repeat(64), source = "c".repeat(40);
const oldId = "00000000-0000-0000-0000-000000000001", newId = "00000000-0000-0000-0000-000000000002";
function serviceEnvironment(name = "atrinik-metaserver-publisher") {
  return { environment: "production", script_tag: accountId,
    created_on: "1970-01-01T00:00:00.000Z", modified_on: "1970-01-01T00:00:00.500Z",
    script: { created_on: "1970-01-01T00:00:00.000Z", modified_on: "1970-01-01T00:00:00.500Z",
      id: name, tag: accountId, tags: [], deployment_id: "", tail_consumers: null, logpush: false,
      observability: { enabled: true, head_sampling_rate: 1, redact_query_string: false,
        logs: { enabled: true, destinations: [], head_sampling_rate: 1, persist: true, invocation_logs: false },
        traces: { enabled: false, destinations: [], persist: true, head_sampling_rate: 1 } },
      has_assets: false, has_modules: true, etag: hash, handlers: ["fetch"], last_deployed_from: "wrangler",
      compatibility_date: "2026-10-01", compatibility_flags: ["nodejs_compat"], usage_model: "standard" } };
}
function baseline(role = "publisher") {
  const rows = [
    ...callerRetirementSecrets.map((name) => ({ name, type: "secret_text" })),
    { name: "COORDINATOR", type: "service", service: "atrinik-metaserver", entrypoint: role === "publisher" ? "PublisherCoordinator" : "RendezvousCoordinator" },
    ...(role === "publisher" ? ["PUBLISH_ENABLED", "GAME_PUBLISH_ENABLED"] : ["RENDEZVOUS_ENABLED"])
      .map((name) => ({ name, type: "plain_text", text: "disabled" })),
  ];
  return { accountId, tag: accountId, name: `atrinik-metaserver-${role}`, activeVersion: oldId, latestVersion: oldId, deploymentId: oldId,
    settings: { bindings: rows, annotations: { "workers/tag": source, "workers/message": `atrinik-delivery-v1 source=${source} deploy=${hash} migration=${hash} horizon=16 control=${hash} role=${role} phase=staged`, "workers/triggered_by": "version_upload" }, compatibility_date: "2026-10-01" },
    resources: { bindings: structuredClone(rows), script: { etag: hash, handlers: ["fetch"] } },
    code: { etag: hash, modules: [{ name: `${role}.js`, type: "application/javascript+module", sha256: hash, bytes: 100 }] },
    control: { environment: serviceEnvironment(`atrinik-metaserver-${role}`), routes: [], domains: [] },
    peers: { workers: [{ name: "core", signingSecrets: [...callerRetirementSecrets] }], namespaces: [] }, capturedAt: 1000 };
}
function retired(before = baseline()) {
  const after = structuredClone(before);
  for (const f of ["settings", "resources"]) after[f].bindings = after[f].bindings.filter((b) => b.type !== "secret_text");
  after.settings.annotations["workers/triggered_by"] = "secret";
  after.activeVersion = after.latestVersion = after.deploymentId = newId;
  return after;
}
function harness(overrides = {}) {
  const before = baseline(), after = retired(before), events = [];
  let reads = 0, writes = 0, intent;
  return { events, before, after, get intent() { return intent; }, get writes() { return writes; },
    options: { qualification, role: "publisher", now: () => 1000, fence: async () => events.push("fence"), authorize: async () => events.push("authorize"),
      read: async () => { events.push("read"); return ++reads < 3 ? before : after; },
      verifyStaged: async () => { events.push("verify"); return true; },
      recordIntent: async (v) => { events.push("intent"); intent = v; },
      patch: async () => { events.push("patch"); writes++; }, recordReceipt: async () => events.push("receipt"), ...overrides } };
}
test("single retirement orders durable intent, read/fence, authority, mutation and strict receipt", async () => {
  const h = harness(); const result = await retireCallerSecrets(h.options);
  assert.equal(h.writes, 1); assert.equal(result.receipt.status, "observed-disabled-caller-secrets-retired");
  assert.deepEqual(h.events, ["fence", "read", "verify", "intent", "fence", "read", "verify", "authorize", "patch", "read", "verify", "fence", "receipt"]);
});
test("bulk-secret body contains only the exact null-deletion pair", () => {
  const before = baseline(); before.settings.annotations.custom = "retained";
  assert.deepEqual(callerRetirementBody("publisher", before), {
    secrets: { SOURCE_TAG_KEY_CURRENT: null, SOURCE_TAG_KEY_PREVIOUS: null },
  });
});
for (const [name, change] of [
  ["old required key IDs", (s) => s.settings.bindings.push({ name: "SOURCE_TAG_KEY_CURRENT_ID", type: "plain_text", text: "old" })],
  ["enabled circuit", (s) => { s.settings.bindings.find((b) => b.name === "PUBLISH_ENABLED").text = "enabled"; }],
  ["stale latest", (s) => { s.latestVersion = newId; }],
  ["wrong caller", (s) => { s.name = "atrinik-metaserver-development-publisher"; }],
  ["missing code proof", (s) => { s.code.modules = []; }],
  ["unknown secret", (s) => { s.settings.bindings[0].name = "UNEXPECTED"; }],
  ["secret values", (s) => { s.settings.bindings[0].text = "never-allowed"; }],
  ["not staged", (s) => { s.settings.annotations["workers/message"] = s.settings.annotations["workers/message"].replace("phase=staged", "phase=active"); }],
]) test(`${name} stops before mutation`, async () => {
  const bad = baseline(); change(bad); const h = harness({ read: async () => bad });
  await assert.rejects(retireCallerSecrets(h.options)); assert.equal(h.writes, 0); assert.equal(h.intent, undefined);
});
for (const [name, change] of [
  ["partial deletion", (s) => s.settings.bindings.push({ name: callerRetirementSecrets[0], type: "secret_text" })],
  ["code change", (s) => { s.code.modules[0].sha256 = "d".repeat(64); }],
  ["peer change", (s) => { s.peers.workers[0].signingSecrets = []; }],
  ["provider field", (s) => { s.settings.new_field = true; }],
  ["extra annotation", (s) => { s.settings.annotations.extra = "changed"; }],
  ["tag lost", (s) => { delete s.settings.annotations["workers/tag"]; }],
  ["unchanged active version", (s) => { s.activeVersion = s.latestVersion = oldId; }],
]) test(`${name} cannot become a successful receipt`, () => {
  const before = baseline(), after = retired(before); change(after);
  assert.throws(() => verifyCallerRetirementPost("publisher", before, after));
});
test("wrong role and noop fail", () => {
  assert.throws(() => callerRetirementBody("core", baseline()));
  assert.throws(() => verifyCallerRetirementPost("publisher", baseline(), baseline()));
});
test("consumed intent cannot dispatch", async () => {
  const h = harness({ recordIntent: async () => { throw Object.assign(Error("consumed"), { code: "EEXIST" }); } });
  await assert.rejects(retireCallerSecrets(h.options)); assert.equal(h.writes, 0);
});
test("effective-retention proof must pass before the caller PATCH boundary", async () => {
  const context = { repository: "atrinik/metaserver-worker", runId: "1", runAttempt: "1",
    controllerSha: source, sourceSha: source, deployableDigest: hash };
  for (const [minimumRetentionDays, duration, accepted] of [
    [90, 90 * 86400000 - 281000, false],
    [89, 90 * 86400000 - 281000, true],
    [89, 89 * 86400000, true],
    [89, 89 * 86400000 - 1, false],
  ]) {
    const h = harness({ recordIntent: async () => verifyRecoveryArtifactProof({
      artifactId: 101, artifactName: "intent", archiveDigest: hash, context, now: () => 1000,
      minimumRetentionDays, metadata: { id: 101, name: "intent", digest: `sha256:${hash}`, expired: false,
        workflow_run: { id: 1, head_sha: source }, created_at: new Date(1000).toISOString(),
        expires_at: new Date(1000 + duration).toISOString() },
    }) });
    if (accepted) await retireCallerSecrets(h.options);
    else await assert.rejects(retireCallerSecrets(h.options), /effective retention/u);
    assert.equal(h.writes, accepted ? 1 : 0);
    assert.equal(h.events.includes("authorize"), accepted);
  }
});
test("post-intent drift and final authority failure prevent mutation", async () => {
  let reads = 0;
  const h = harness({ read: async () => { const s = baseline(); if (++reads === 2) s.peers.extra = true; return s; } });
  await assert.rejects(retireCallerSecrets(h.options)); assert.equal(h.writes, 0); assert.ok(h.intent);
  const a = harness({ authorize: async () => { throw Error("expired"); } });
  await assert.rejects(retireCallerSecrets(a.options)); assert.equal(a.writes, 0); assert.ok(a.intent);
});
test("stale read or long final authority check cannot dispatch", async () => {
  const stale = harness({ now: () => 12000 }); await assert.rejects(retireCallerSecrets(stale.options)); assert.equal(stale.writes, 0);
  let clock = 1000;
  const h = harness({ now: () => clock, authorize: async () => { clock = 12000; } });
  await assert.rejects(retireCallerSecrets(h.options)); assert.equal(h.writes, 0);
});
test("unknown patch outcome and failed receipt never retry", async () => {
  let calls = 0;
  const h = harness({ patch: async () => { calls++; throw Error("unknown"); } });
  await assert.rejects(retireCallerSecrets(h.options)); assert.equal(calls, 1);
  const receipt = harness({ recordReceipt: async () => { throw Error("disk"); } });
  await assert.rejects(retireCallerSecrets(receipt.options)); assert.equal(receipt.writes, 1);
});
test("read-only recovery binds original intent and rejects partial states", async () => {
  const h = harness(); await retireCallerSecrets(h.options);
  const args = { role: "publisher", before: h.before, intent: h.intent, read: async () => h.after, fence: async () => {}, verifyStaged: async () => true, now: () => 1000 };
  assert.equal((await observeCallerRetirement(args)).originalReceiptCreated, false);
  await assert.rejects(observeCallerRetirement({ ...args, intent: { ...h.intent, role: "rendezvous" } }));
  await assert.rejects(observeCallerRetirement({ ...args, read: async () => h.before }));
});
test("v3 intent binds the full endpoint, exact request, and captured predecessor", async () => {
  const h = harness(); await retireCallerSecrets(h.options);
  assert.equal(h.intent.schema, "atrinik-production-caller-retirement-v3");
  assert.equal(h.intent.endpoint, `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/atrinik-metaserver-publisher/secrets-bulk`);
  assert.deepEqual(h.intent.before, h.before);
  assert.equal(h.intent.beforeDigest, callerRetirementDigest(h.before));
  assert.equal(h.intent.bodyDigest, callerRetirementDigest(h.intent.body));
  assert.equal(Object.hasOwn(h.intent, "settingsDigest"), false);
  const { schema, before, beforeDigest, providerQualificationDigest, requestDigest, ...request } = h.intent;
  assert.equal(providerQualificationDigest, qualification.digest);
  assert.equal(requestDigest, callerRetirementDigest(request));
});
for (const [name, change] of [
  ["schema", (i) => { i.schema = "atrinik-production-caller-retirement-v2"; }],
  ["before digest", (i) => { i.beforeDigest = hash; }],
  ["before timestamp", (i) => { i.before.capturedAt = 999; }],
  ["missing before timestamp", (i) => { delete i.before.capturedAt; }],
  ["endpoint", (i) => { i.endpoint = i.endpoint.replace("secrets-bulk", "settings"); }],
  ["body digest", (i) => { i.bodyDigest = hash; }],
  ["request digest", (i) => { i.requestDigest = hash; }],
  ["qualification digest", (i) => { delete i.providerQualificationDigest; }],
  ["version_tags", (i) => { i.body.version_tags = {}; }],
  ["extra field", (i) => { i.unexpected = true; }],
]) test(`v3 recovery rejects substituted ${name} before any read`, async () => {
  const h = harness(); await retireCallerSecrets(h.options);
  const intent = structuredClone(h.intent); change(intent); let reads = 0;
  await assert.rejects(observeCallerRetirement({ role: "publisher", before: h.before, intent,
    read: async () => { reads++; return h.after; }, fence: async () => {}, verifyStaged: async () => true, now: () => 1000 }));
  assert.equal(reads, 0);
});
test("historical v1 settings digest remains read-only and cannot be relabeled as bulk deletion", async () => {
  const before = baseline(), beforeDocument = structuredClone(before); delete beforeDocument.capturedAt;
  const annotations = structuredClone(before.settings.annotations); delete annotations["workers/triggered_by"];
  const settings = { bindings: before.settings.bindings.filter((b) => !callerRetirementSecrets.includes(b.name)), annotations };
  const intent = { schema: "atrinik-production-caller-retirement-v1", role: "publisher", accountId,
    name: before.name, method: "PATCH", path: `/workers/scripts/${before.name}/settings`,
    before: beforeDocument, beforeDigest: callerRetirementDigest(beforeDocument), settingsDigest: callerRetirementDigest(settings) };
  let reads = 0;
  const options = { role: "publisher", before, intent, read: async () => { reads++; return retired(before); }, fence: async () => {}, verifyStaged: async () => true, now: () => 1000 };
  await assert.rejects(observeCallerRetirement(options), /historical intent lacks authenticated observation timestamp/u);
  const inventedBefore = { ...before, capturedAt: 900 };
  await assert.rejects(observeCallerRetirement({ ...options, before: inventedBefore }), /historical intent lacks authenticated observation timestamp/u);
  assert.equal(reads, 0);
  await assert.rejects(observeCallerRetirement({ ...options, before: beforeDocument }));
  await assert.rejects(observeCallerRetirement({ ...options, intent: { ...intent, settingsDigest: callerRetirementDigest(callerRetirementBody("publisher", before)) } }));
  const patch = createCallerRetirementPatch({ qualification, accountId, token: "fixture", role: "publisher", fetcher: async () => { throw Error("must not fetch"); } });
  await assert.rejects(patch(intent));
});
test("provider-accepted settings shape retaining both secrets never produces a receipt", async () => {
  const before = baseline(), after = structuredClone(before);
  after.activeVersion = after.latestVersion = after.deploymentId = newId;
  after.settings.annotations["workers/triggered_by"] = "upload";
  after.resources.script.last_deployed_from = "api";
  after.control.environment.script.last_deployed_from = "api";
  let reads = 0, receipts = 0;
  const h = harness({ read: async () => ++reads < 3 ? before : after, recordReceipt: async () => { receipts++; } });
  await assert.rejects(retireCallerSecrets(h.options), e => retirementFailureDiagnostic(e).phase === "postverify");
  assert.equal(h.writes, 1); assert.equal(receipts, 0);
});
for (const field of ["settings", "resources"]) test(`zero secrets only in ${field} cannot prove retirement`, () => {
  const before = baseline(), after = retired(before);
  after[field === "settings" ? "resources" : "settings"].bindings = structuredClone(before.settings.bindings);
  assert.throws(() => verifyCallerRetirementPost("publisher", before, after));
});
for (const trigger of ["upload", "version_upload", undefined]) test(`operation annotation ${trigger} cannot prove retirement`, () => {
  const before = baseline(), after = retired(before); after.settings.annotations["workers/triggered_by"] = trigger;
  assert.throws(() => verifyCallerRetirementPost("publisher", before, after));
});
test("private durable recorder allows only one concurrent role claim and binds receipt", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "retirement-test-")); await chmod(directory, 0o700);
  try {
    const a = createCallerRetirementRecorder({ directory, role: "publisher" });
    const results = await Promise.allSettled([a.recordIntent({ role: "publisher", pin: hash }), a.recordIntent({ role: "publisher", pin: hash })]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    await assert.rejects(a.recordReceipt({ role: "publisher", pin: "wrong" }));
    await a.recordReceipt({ role: "publisher", pin: hash, status: "complete" });
    assert.equal(JSON.parse(await readFile(path.join(directory, "caller-retirement-publisher.receipt.json"))).pin, hash);
    await assert.rejects(a.recordIntent({ role: "publisher", pin: hash }));
  } finally { await rm(directory, { recursive: true }); }
});
async function requestFixture(role = "publisher") {
  const h = harness({ role, read: async () => baseline(role), patch: async () => { throw Error("fixture stop"); } });
  await assert.rejects(retireCallerSecrets(h.options));
  const { schema, before, beforeDigest, providerQualificationDigest, ...request } = h.intent;
  return request;
}
test("bounded merge-patch transport is pinned and consumed even on network ambiguity", async () => {
  let calls = 0;
  const patch = createCallerRetirementPatch({ qualification, accountId, token: "test-token", role: "publisher", fetcher: async (url, options) => {
    calls++; assert.equal(url, `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/atrinik-metaserver-publisher/secrets-bulk`);
    assert.equal(options.method, "PATCH"); assert.equal(options.redirect, "error");
    assert.equal(options.headers["Content-Type"], "application/merge-patch+json");
    assert.equal(options.headers.Authorization, "Bearer test-token");
    assert.deepEqual(JSON.parse(options.body), callerRetirementBodyV3("publisher", baseline()));
    throw Error("network uncertainty");
  } });
  const request = await requestFixture();
  await assert.rejects(patch({ ...request, role: "rendezvous" })); assert.equal(calls, 0);
  await assert.rejects(patch(request)); await assert.rejects(patch(request)); assert.equal(calls, 1);
});
for (const [name, change] of [
  ["wrong account", (r) => { r.accountId = "d".repeat(32); }],
  ["wrong role", (r) => { r.role = "rendezvous"; }],
  ["wrong Worker", (r) => { r.name = "atrinik-metaserver-development-publisher"; }],
  ["settings endpoint", (r) => { r.endpoint = r.endpoint.replace("secrets-bulk", "settings"); }],
  ["different account endpoint", (r) => { r.endpoint = r.endpoint.replace(accountId, "d".repeat(32)); }],
  ["wrong method", (r) => { r.method = "PUT"; }],
  ["wrong content type", (r) => { r.contentType = "application/json"; }],
  ["annotations injection", (r) => { r.body.annotations = { "workers/tag": source }; }],
  ["version_tags injection", (r) => { r.body.version_tags = { "workers/tag": source }; }],
  ["undefined injection", (r) => { r.body.version_tags = undefined; }],
  ["wrong secret name", (r) => { delete r.body.secrets.SOURCE_TAG_KEY_PREVIOUS; r.body.secrets.UNRELATED = null; }],
  ["partial pair", (r) => { delete r.body.secrets.SOURCE_TAG_KEY_PREVIOUS; }],
  ["secret replacement", (r) => { r.body.secrets.SOURCE_TAG_KEY_PREVIOUS = { type: "secret_text", text: "forbidden" }; }],
  ["extra secret", (r) => { r.body.secrets.UNRELATED = null; }],
  ["extra request field", (r) => { r.unexpected = true; }],
  ["body digest substitution", (r) => { r.bodyDigest = hash; }],
  ["request digest substitution", (r) => { r.requestDigest = hash; }],
]) test(`${name} cannot dispatch the bulk-secret request`, async () => {
  let calls = 0;
  const request = await requestFixture(); change(request);
  // Even a recomputed request digest cannot widen the fixed operation contract.
  const { requestDigest, ...content } = request;
  if (!name.includes("digest")) request.requestDigest = callerRetirementDigest(content);
  const patch = createCallerRetirementPatch({ qualification, accountId, token: "fixture", role: "publisher",
    fetcher: async () => { calls++; return Response.json({ success: true }); } });
  await assert.rejects(patch(request)); assert.equal(calls, 0);
});
test("accepted bulk-secret response still consumes exactly one request", async () => {
  let calls = 0;
  const patch = createCallerRetirementPatch({ qualification, accountId, token: "fixture", role: "publisher",
    fetcher: async () => { calls++; return Response.json({ success: true }); } });
  const request = await requestFixture(); await patch(request); await assert.rejects(patch(request));
  assert.equal(calls, 1);
});
test("module parser hashes every binary part and rejects duplicates", async () => {
  const form = new FormData(); form.append("main.js", new Blob(["export default{}"], { type: "application/javascript+module" }), "main.js");
  form.append("helper.wasm", new Blob([new Uint8Array([1, 2, 3])], { type: "application/wasm" }), "helper.wasm");
  const r = new Response(form), code = await parseCallerRetirementModules(Buffer.from(await r.arrayBuffer()), r.headers.get("content-type"), `"${hash}"`);
  assert.equal(code.modules.length, 2); assert.deepEqual(code.modules.map((m) => m.name), ["helper.wasm", "main.js"]);
  form.append("main.js", new Blob(["duplicate"]), "main.js"); const duplicate = new Response(form);
  await assert.rejects(parseCallerRetirementModules(Buffer.from(await duplicate.arrayBuffer()), duplicate.headers.get("content-type"), `"${hash}"`));
});

function readerFixture() {
  const names = ["atrinik-metaserver", "atrinik-metaserver-publisher", "atrinik-metaserver-rendezvous",
    "atrinik-metaserver-development", "atrinik-metaserver-development-publisher", "atrinik-metaserver-development-rendezvous"];
  let requests = 0;
  const fetcher = async (url, options) => {
    requests++; assert.equal(options.method, "GET"); assert.equal(options.redirect, "error");
    const suffix = new URL(url).pathname.split(`/accounts/${accountId}`)[1];
    let result;
    if (suffix === "/workers/scripts") result = names.map((id) => ({ id, tag: accountId }));
    else if (suffix.endsWith("/namespaces")) return Response.json({ success: true, result: [], result_info: { page: 1, per_page: 1000, total_count: 0, count: 0 } });
    else if (suffix.endsWith("/content/v2")) {
      const form = new FormData(); form.append("index.js", new Blob(["export default{}"], { type: "application/javascript+module" }), "index.js");
      return new Response(form, { headers: { etag: `"${hash}"` } });
    } else if (suffix.endsWith("/settings")) result = baseline().settings;
    else if (suffix.endsWith("/deployments")) result = { deployments: [{ id: oldId, versions: [{ version_id: oldId, percentage: 100 }] }] };
    else if (suffix.endsWith("/versions")) result = { items: [{ id: oldId }] };
    else if (suffix.endsWith(`/versions/${oldId}`)) result = { id: oldId, resources: baseline().resources };
    else if (suffix.endsWith("/routes") || suffix.endsWith("/domains") || suffix.endsWith("/schedules")) result = [];
    else if (suffix.endsWith("/environments/production")) result = serviceEnvironment(suffix.split("/")[3]);
    else result = { enabled: false, previews_enabled: false };
    return Response.json({ success: true, result });
  };
  return { fetcher, get requests() { return requests; } };
}

test("reader verifies all six Workers/modules and complete global namespaces twice", async () => {
  const { createCallerRetirementReader } = await import("./production-caller-retirement.mjs");
  const fixture = readerFixture();
  const fetcher = fixture.fetcher;
  const read = createCallerRetirementReader({ accountId, token: "test-token", role: "publisher", fetcher, now: () => 1000 });
  const value = await read(); assert.equal(value.peers.workers.length, 5); assert.deepEqual(value.peers.namespaces, []);
  assert.equal(value.code.modules.length, 1); assert.equal(value.capturedAt, 1000); assert.equal(fixture.requests, 124);
  const incomplete = createCallerRetirementReader({ accountId, token: "test-token", role: "publisher", now: () => 1000,
    fetcher: async (url, options) => url.includes("/namespaces") ? Response.json({ success: true, result: [], result_info: { page: 1, count: 0, total_count: 1001, per_page: 1000, total_pages: 2 } }) : fetcher(url, options) });
  await assert.rejects(incomplete());
});


test("realistic service metadata allows only bounded modification times and API provenance", () => {
  const before = baseline(), after = retired(before);
  after.capturedAt = 2000;
  after.control.environment.modified_on = "1970-01-01T00:00:01.500000Z";
  after.control.environment.script.modified_on = "1970-01-01T00:00:01.500000Z";
  after.control.environment.script.last_deployed_from = "api";
  assert.equal(verifyCallerRetirementPost("publisher", before, after), after);
});
test("active resources accept only the service-consistent Wrangler to API transition", () => {
  const before = baseline(); before.resources.script.last_deployed_from = "wrangler";
  const after = retired(before); after.resources.script.last_deployed_from = "api";
  assert.throws(() => verifyCallerRetirementPost("publisher", before, after));
  after.control.environment.script.last_deployed_from = "api";
  verifyCallerRetirementPost("publisher", before, after);
  after.resources.script.last_deployed_from = "dash";
  assert.throws(() => verifyCallerRetirementPost("publisher", before, after));
});
test("unknown existing resource metadata remains exact", () => {
  const before = baseline(); before.resources.script.future = { enabled: false };
  const after = retired(before); verifyCallerRetirementPost("publisher", before, after);
  after.resources.script.future.enabled = true;
  assert.throws(() => verifyCallerRetirementPost("publisher", before, after));
});
test("post observation cannot precede the timestamped predecessor", () => {
  const before = baseline(), after = retired(before); after.capturedAt = 999;
  assert.throws(() => verifyCallerRetirementPost("publisher", before, after));
});
for (const coordinate of ["activeVersion", "deploymentId"]) test(`service identifier tracks exact fresh ${coordinate}`, () => {
  const before = baseline();
  before.deploymentId = "00000000-0000-0000-0000-000000000003";
  before.control.environment.script.deployment_id = before[coordinate];
  const after = retired(before);
  after.deploymentId = "00000000-0000-0000-0000-000000000004";
  after.control.environment.script.deployment_id = after[coordinate];
  verifyCallerRetirementPost("publisher", before, after);
  after.control.environment.script.deployment_id = after[coordinate === "activeVersion" ? "deploymentId" : "activeVersion"];
  assert.throws(() => verifyCallerRetirementPost("publisher", before, after));
});
for (const [name, change] of [
  ["unknown environment field", (s) => { s.control.environment.unknown = true; }],
  ["unknown script field", (s) => { s.control.environment.script.unknown = true; }],
  ["runtime flag", (s) => { s.control.environment.script.compatibility_flags.push("unsafe"); }],
  ["observability runtime", (s) => { s.control.environment.script.observability.logs.invocation_logs = true; }],
  ["created time", (s) => { s.control.environment.created_on = "1970-01-01T00:00:00.100Z"; }],
  ["pre-window modification", (s) => { s.control.environment.modified_on = "1970-01-01T00:00:00.900Z"; }],
  ["future modification", (s) => { s.control.environment.modified_on = "1970-01-01T00:00:01.001Z"; }],
  ["invalid modification", (s) => { s.control.environment.modified_on = "2026-02-30T00:00:00Z"; }],
  ["mismatched deployment identifier", (s) => { s.control.environment.script.deployment_id = "00000000-0000-0000-0000-000000000009"; }],
  ["empty identifier unexpectedly gained authority", (s) => { s.control.environment.script.deployment_id = s.activeVersion; }],
  ["unexpected deployment client", (s) => { s.control.environment.script.last_deployed_from = "dash"; }],
  ["script identity", (s) => { s.control.environment.script.id = "other"; }],
  ["peer service timestamp", (s) => { s.peers.workers[0].modified_on = "1970-01-01T00:00:01.000Z"; }],
]) test(`${name} remains outside service metadata transition`, () => {
  const before = baseline(), after = retired(before); change(after);
  assert.throws(() => verifyCallerRetirementPost("publisher", before, after));
});
test("unrecognized existing provider fields must remain byte-semantically exact", () => {
  const before = baseline(); before.control.environment.script.future = { enabled: false };
  const after = retired(before); verifyCallerRetirementPost("publisher", before, after);
  after.control.environment.script.future.enabled = true;
  assert.throws(() => verifyCallerRetirementPost("publisher", before, after));
});

for (const latency of [0, 1000, 2000]) test(`actual six-Worker double snapshot completes at ${latency}ms response latency under original deadlines`, async (t) => {
  const { createCallerRetirementReader } = await import("./production-caller-retirement.mjs");
  const clock = virtualClock(), fixture = readerFixture(), starts = [];
  t.mock.method(AbortSignal, "timeout", ms => clock.timeout(ms));
  const fetcher = createProductionReadPacer({ ...clock, fetcher: async (url, options) => {
    starts.push(clock.now()); await clock.wait(latency, options.signal); return fixture.fetcher(url, options);
  } });
  const read = createCallerRetirementReader({ accountId, token: "fixture", role: "publisher", fetcher, now: clock.now });
  const result = await clock.run(read);
  assert.equal(result.peers.workers.length, 5);
  assert.equal(fixture.requests, 124); assert.equal(starts.length, 124);
  assert.ok(clock.now() >= 123 * 334); assert.ok(clock.now() < 120000);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 334);
});

test("actual reader tail network timeout reports current-read and never PATCHes", async (t) => {
  const { createCallerRetirementReader } = await import("./production-caller-retirement.mjs");
  const clock = virtualClock(), fixture = readerFixture();
  t.mock.method(AbortSignal, "timeout", ms => clock.timeout(ms));
  const fetcher = createProductionReadPacer({ ...clock, fetcher: async (url, options) => {
    await clock.wait(3000, options.signal); return fixture.fetcher(url, options);
  } });
  const read = createCallerRetirementReader({ accountId, token: "fixture", role: "publisher", fetcher, now: clock.now });
  let reads = 0;
  const h = harness({ read: () => ++reads === 1 ? baseline() : read() });
  await assert.rejects(clock.run(() => retireCallerSecrets(h.options)), e => {
    const diagnostic = retirementFailureDiagnostic(e);
    assert.equal(diagnostic.phase, "current-read"); assert.equal(diagnostic.category, "deadline-expired");
    assert.equal(diagnostic.mutationState, "not-invoked"); return true;
  });
  assert.equal(h.writes, 0); assert.ok(h.intent);
});

test("full double-snapshot 120-second expiry still prevents PATCH despite successful individual reads", async (t) => {
  const { createCallerRetirementReader } = await import("./production-caller-retirement.mjs");
  const clock = virtualClock(), fixture = readerFixture();
  t.mock.method(AbortSignal, "timeout", ms => clock.timeout(ms));
  const fetcher = createProductionReadPacer({ ...clock, fetcher: async (url, options) => {
    if (url.includes("/namespaces?")) {
      await clock.wait(10000, options.signal);
      const page = Number(new URL(url).searchParams.get("page"));
      return Response.json({ success: true,
        result: Array.from({ length: 1000 }, (_, i) => ({ id: String((page - 1) * 1000 + i) })),
        result_info: { page, per_page: 1000, total_count: 5000, total_pages: 5, count: 1000 } });
    }
    return fixture.fetcher(url, options);
  } });
  const read = createCallerRetirementReader({ accountId, token: "fixture", role: "publisher", fetcher, now: clock.now });
  let reads = 0;
  const h = harness({ read: () => ++reads === 1 ? baseline() : read() });
  await assert.rejects(clock.run(() => retireCallerSecrets(h.options)), e => {
    assert.equal(retirementFailureDiagnostic(e).phase, "current-read");
    return /read expired/u.test(e.message);
  });
  assert.ok(clock.now() > 120000); assert.equal(h.writes, 0); assert.ok(h.intent);
});

test("every retirement boundary has closed diagnostics without changing write ordering", async () => {
  for (const [phase, key, nth] of [["initial-fence","fence",1],["initial-read","read",1],
    ["initial-staged-proof","verifyStaged",1],["intent-proof","recordIntent",1],
    ["post-intent-fence","fence",2],["current-read","read",2],["staged-proof","verifyStaged",2],
    ["final-authority","authorize",1],["patch","patch",1],["post-read","read",3],
    ["postverify","verifyStaged",3],["post-fence","fence",3],["receipt-proof","recordReceipt",1]]) {
    const h = harness(), original = h.options[key]; let calls = 0;
    h.options[key] = async (...args) => { if (++calls === nth) throw Error("private-token/body/url"); return original(...args); };
    await assert.rejects(retireCallerSecrets(h.options), error => {
      const diagnostic = retirementFailureDiagnostic(error);
      assert.equal(diagnostic.phase, phase);
      assert.equal(diagnostic.category, "verification-failed");
      assert.equal(JSON.stringify(diagnostic).includes("private"), false);
      assert.equal(diagnostic.mutationState, phase === "patch" ? "dispatched-outcome-unknown" :
        ["post-read","postverify","post-fence","receipt-proof"].includes(phase) ? "response-accepted" : "not-invoked");
      return true;
    });
    assert.ok(h.writes <= 1);
  }
});

test("comparison and freshness rejections are distinct; causes cannot forge or leak diagnostics", async () => {
  let reads = 0;
  const h = harness({ read: async () => { const value = baseline(); if (++reads === 2) value.peers.changed = true; return value; } });
  let branded;
  await assert.rejects(retireCallerSecrets(h.options), e => { branded = e; return retirementFailureDiagnostic(e).phase === "current-compare"; });
  let clock = 1000;
  const expired = harness({ now: () => clock, authorize: async () => { clock = 12000; } });
  await assert.rejects(retireCallerSecrets(expired.options), e => retirementFailureDiagnostic(e).phase === "freshness");
  assert.equal(expired.writes, 0);
  const hostile = { get cause() { throw Error("getter must not execute"); }, phase: "patch", mutationState: "response-accepted" };
  assert.equal(retirementFailureDiagnostic(hostile), null);
  assert.equal(retirementFailureDiagnostic(Object.create({ cause: branded })), null);
  assert.deepEqual(retirementFailureDiagnostic({ cause: { cause: { cause: branded } } }), retirementFailureDiagnostic(branded));
  assert.equal(retirementFailureDiagnostic({ cause: { cause: { cause: { cause: branded } } } }), null);
  assert.equal(retirementFailureDiagnostic(new Proxy({}, { getOwnPropertyDescriptor() { throw Error("private"); } })), null);
});

test("PATCH diagnostics distinguish pre-dispatch validation, attempted transport, and received response", async () => {
  for (const [state, fetcher, wrongAccount] of [
    ["not-dispatched", async () => { throw Error("must not fetch"); }, true],
    ["dispatched-outcome-unknown", async () => { throw Error("private token"); }, false],
    ["response-received", async () => Response.json({ success: false, errors: ["private provider text"] }, { status: 429 }), false],
  ]) {
    const patch = createCallerRetirementPatch({ qualification, accountId, token: "fixture", role: "publisher", fetcher });
    const h = harness({ patch: request => patch({ ...request, ...(wrongAccount ? { accountId: "wrong" } : {}) }) });
    await assert.rejects(retireCallerSecrets(h.options), e => {
      assert.equal(retirementFailureDiagnostic(e).phase, "patch");
      assert.equal(retirementFailureDiagnostic(e).mutationState, state);
      assert.equal(JSON.stringify(retirementFailureDiagnostic(e)).includes("private"), false);
      return true;
    });
  }
});

for (const stage of ["post-intent-fence", "patch", "post-read"]) test(`failed disabled-core recovery retains original ${stage} diagnostic`, async () => {
  let calls = 0, fences = 0, reads = 0, patches = 0;
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts`;
  const paced = createProductionReadPacer({ fetcher: async () => {
    calls++; return new Response("private provider response", { status: 429 });
  } });
  const h = harness({
    fence: async () => { if (++fences === 2 && stage === "post-intent-fence") await paced(url); },
    read: async () => { if (++reads === 3 && stage === "post-read") await paced(url); return baseline(); },
    patch: createCallerRetirementPatch({ qualification, accountId, token: "fixture", role: "publisher", fetcher: async () => {
      patches++;
      if (stage === "patch") throw Error("private network ambiguity");
      return Response.json({ success: true });
    } }),
  });
  const noop = async () => {};
  await assert.rejects(orchestrateDelivery({ workers: ["core", "publisher", "rendezvous"], decision: "deploy",
    fence: noop, deployStaged: noop, readbackStaged: () => retireCallerSecrets(h.options),
    recover: () => paced(url),
  }), error => {
    const evidence = { sourceSha: null, deployableDigest: null, failedRole: "retirement:publisher", completedRoles: [], recoveryOutcome: "failed" };
    const record = deliveryFailureRecord(error, evidence);
    assert.match(record.reason, /disabled-circuit recovery was not proven/u);
    assert.equal(record.recoveryOutcome, "failed");
    assert.equal(record.retirement.phase, stage);
    assert.equal(record.retirement.mutationState, stage === "patch" ? "dispatched-outcome-unknown" :
      stage === "post-read" ? "response-accepted" : "not-invoked");
    if (stage !== "patch") {
      assert.equal(record.retirement.category, "rate-limited");
      assert.equal(record.retirement.httpStatus, 429);
      assert.equal(record.retirement.readTransportState, "response-received");
    }
    assert.equal(JSON.stringify(record).includes("private"), false);
    return true;
  });
  assert.equal(patches, stage === "post-intent-fence" ? 0 : 1);
  assert.equal(calls, 1); assert.ok(h.intent);
});

test("historical v2 byte contract remains readable and cannot dispatch through the v3 transport", async () => {
  const before = baseline(), after = retired(before);
  const body = callerRetirementBody("publisher", before);
  const request = { role: "publisher", accountId, name: before.name, method: "PATCH",
    endpoint: `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${before.name}/secrets-bulk`,
    contentType: "application/merge-patch+json", body, bodyDigest: callerRetirementDigest(body) };
  request.requestDigest = callerRetirementDigest(request);
  const intent = { schema: "atrinik-production-caller-retirement-v2", ...request,
    before: structuredClone(before), beforeDigest: callerRetirementDigest(before) };
  assert.equal(JSON.stringify(body), '{"secrets":{"SOURCE_TAG_KEY_CURRENT":null,"SOURCE_TAG_KEY_PREVIOUS":null}}');
  const args = { role: "publisher", before, intent, read: async () => after,
    fence: async () => {}, verifyStaged: async () => true, now: () => 1000 };
  assert.equal((await observeCallerRetirement(args)).originalReceiptCreated, false);
  for (const change of [i => { delete i.before.capturedAt; }, i => { i.before.capturedAt++; },
    i => { i.body.version_tags = callerRetirementBodyV3("publisher", before).version_tags; }]) {
    const invalid = structuredClone(intent); change(invalid);
    await assert.rejects(observeCallerRetirement({ ...args, intent: invalid, read: () => assert.fail("must reject before read") }));
  }
  let calls = 0;
  const patch = createCallerRetirementPatch({ qualification, accountId, role: "publisher", token: "fixture", fetcher: () => { calls++; } });
  await assert.rejects(patch(request)); assert.equal(calls, 0);
});

test("v3 emits only exact selected stage tags with deterministic bytes and bounded data properties", async () => {
  const request = await requestFixture();
  const expected = `{"secrets":{"SOURCE_TAG_KEY_CURRENT":null,"SOURCE_TAG_KEY_PREVIOUS":null},"version_tags":${JSON.stringify({
    "workers/tag": source, "workers/message": baseline().settings.annotations["workers/message"],
  })}}`;
  let calls = 0;
  const patch = createCallerRetirementPatch({ qualification, accountId, role: "publisher", token: "fixture", fetcher: async (_url, options) => {
    calls++; assert.equal(options.body, expected); return Response.json({ success: true, errors: [], result: {} });
  } });
  for (const change of [
    r => { delete r.body.version_tags; },
    r => { delete r.body.version_tags["workers/tag"]; },
    r => { delete r.body.version_tags["workers/message"]; },
    r => { r.body.version_tags["workers/tag"] = "d".repeat(40); },
    r => { r.body.version_tags["workers/message"] += "changed"; },
    r => { r.body.version_tags["workers/triggered_by"] = "secret"; },
    r => { r.body.version_tags.extra = undefined; },
    r => { r.body.version_tags["workers/message"] = "x".repeat(1025); },
    r => { Object.defineProperty(r.body.version_tags, "workers/message", { get: () => assert.fail("getter invoked") }); },
    r => { Object.defineProperty(r.body, "version_tags", { get: () => assert.fail("getter invoked") }); },
    r => { Object.defineProperty(r, "body", { get: () => assert.fail("getter invoked") }); },
  ]) { const invalid = structuredClone(request); change(invalid); await assert.rejects(patch(invalid)); }
  assert.equal(calls, 0); await patch(request); assert.equal(calls, 1);
});

function stagedEmpty(role = "publisher") {
  const snapshot = baseline(role);
  for (const field of ["settings", "resources"]) snapshot[field].bindings = snapshot[field].bindings.filter(b => b.type !== "secret_text");
  snapshot.resources.script.last_deployed_from = "wrangler";
  return snapshot;
}
for (const role of ["publisher", "rendezvous"]) test(`empty ${role} observation rejects partial projections, new authority and source drift`, async () => {
  for (const change of [
    s => { s.settings.bindings.push({ name: callerRetirementSecrets[0], type: "secret_text" }); },
    s => { s.resources.bindings.push({ name: callerRetirementSecrets[0], type: "secret_text" }); },
    s => { for (const field of ["settings", "resources"]) s[field].bindings.push({ name: "OTHER", type: "secret_text" }); },
    s => { for (const field of ["settings", "resources"]) s[field].bindings.push({ name: "SOURCE_TAG_KEY_CURRENT_ID", type: "plain_text", text: "old" }); },
    s => { for (const field of ["settings", "resources"]) s[field].bindings.find(b => b.type === "plain_text").text = "enabled"; },
    s => { s.settings.annotations["workers/triggered_by"] = "secret"; },
    s => { delete s.settings.annotations["workers/message"]; },
    s => { s.code.modules = []; },
    s => { s.latestVersion = newId; },
  ]) {
    const snapshot = stagedEmpty(role); change(snapshot);
    await assert.rejects(observeSecretFreeCaller({ role, read: async () => snapshot, fence: async () => {},
      verifyStaged: async () => true, now: () => 1000 }), error => {
      assert.equal(retirementFailureDiagnostic(error), null);
      assert.deepEqual(callerObservationFailureDiagnostic(error), { phase: "staged-observation", mutationState: "not-invoked" }); return true;
    });
  }
});

for (const emptyRoles of [["publisher"], ["rendezvous"], ["publisher", "rendezvous"]])
  for (const failure of [null, "last-version-race", "pair-patch-failed"])
    test(`full orchestration empty=${emptyRoles.join("+")} failure=${failure}`, async () => {
      const workers = ["core", "publisher", "rendezvous"].map(role => ({ role }));
      const active = new Map(), proofs = new Map(), apiHandoffRoles = new Set();
      const events = [], artifacts = [], patches = [], observations = [];
      const noop = async () => {};
      let caught;
      try {
        await orchestrateDelivery({ workers, decision: "deploy", fence: noop,
          deployStaged: async ({ role }) => {
            events.push(`stage:${role}`);
            if (role !== "core") {
              const snapshot = emptyRoles.includes(role) ? stagedEmpty(role) : baseline(role);
              snapshot.resources.script.last_deployed_from = "wrangler";
              active.set(role, snapshot);
            }
            if (failure === "last-version-race" && role === "rendezvous") {
              const publisher = active.get("publisher"); publisher.activeVersion = publisher.latestVersion = "00000000-0000-0000-0000-000000000009";
            }
          },
          readbackStaged: async ({ role }) => {
            if (role === "core") return;
            const empty = emptyRoles.includes(role), disposition = { role,
              operation: empty ? "observe-secret-free" : "retire-pair", retirementArtifacts: empty ? 0 : 2,
              baselineSecrets: empty ? [] : [...callerRetirementSecrets] };
            const read = async () => structuredClone(active.get(role));
            const proof = await prepareBootstrapCallerHandoff({ role, disposition, apiHandoffRoles,
              observe: async () => { observations.push(role); return observeSecretFreeCaller({ role, read,
                fence: noop, verifyStaged: async () => true, now: () => 1000 }); },
              retire: () => retireCallerSecrets({ qualification, role, read, fence: noop, authorize: noop, now: () => 1000,
                verifyStaged: async () => true,
                recordIntent: async i => { artifacts.push(`${role}:intent`); assert.equal(i.schema, "atrinik-production-caller-retirement-v3"); },
                recordReceipt: async () => { artifacts.push(`${role}:receipt`); },
                patch: async request => {
                  patches.push(role); assert.deepEqual(request.body, callerRetirementBodyV3(role, active.get(role)));
                  const snapshot = retired(active.get(role));
                  snapshot.resources.script.last_deployed_from = snapshot.control.environment.script.last_deployed_from = "api";
                  active.set(role, snapshot);
                  if (failure === "pair-patch-failed") throw Error("unknown consumed outcome");
                },
              }), confirm: () => events.push(`confirm:${role}`),
              verify: async () => ({ versionId: active.get(role).activeVersion }),
            });
            proofs.set(role, proof);
          }, verifyStaged: noop,
          deployActive: async ({ role }) => {
            if (role !== "core") await verifyCallerActivationHandoff({ role, proof: proofs.get(role),
              verify: async () => { events.push(`last-version:${role}`); return { versionId: active.get(role).activeVersion }; },
              authorize: async () => events.push(`authorize:${role}`) });
            events.push(`activate:${role}`);
          }, readbackActive: noop, verifyFinal: noop, reconcileDirectories: noop, canaries: noop, recover: noop,
        });
      } catch (error) { caught = error; }
      const failedPair = failure === "pair-patch-failed" && emptyRoles.length !== 2;
      assert.equal(Boolean(caught), failure === "last-version-race" || failedPair);
      if (!failedPair) assert.deepEqual(events.filter(v => v.startsWith("stage:")), ["stage:core", "stage:publisher", "stage:rendezvous"]);
      for (const role of emptyRoles) {
        assert.equal(patches.includes(role), false); assert.equal(artifacts.some(v => v.startsWith(`${role}:`)), false);
        assert.equal(events.includes(`confirm:${role}`), false);
      }
      assert.equal(new Set(patches).size, patches.length); // no retry after a consumed pair attempt
      if (failedPair) {
        assert.deepEqual(artifacts, [`${patches[0]}:intent`]);
        assert.equal(observations.includes(patches[0]), false); // no dynamic fallback
      } else {
        assert.equal(artifacts.length, 2 * (2 - emptyRoles.length));
        assert.equal(observations.length, emptyRoles.length);
      }
      if (caught) {
        assert.equal(events.some(v => v.startsWith("activate:")), false);
        if (failure === "last-version-race" && emptyRoles.includes("publisher")) {
          assert.equal(retirementFailureDiagnostic(caught), null);
          assert.deepEqual(callerObservationFailureDiagnostic(caught), { phase: "activation", mutationState: "not-invoked" });
        }
      } else for (const role of ["publisher", "rendezvous"]) {
        const index = events.indexOf(`activate:${role}`);
        assert.deepEqual(events.slice(index - 2, index), [`last-version:${role}`, `authorize:${role}`]);
      }
    });

test("unqualified, unbranded or wrong-account v3 cannot create an intent or dispatch", async () => {
  const parsed = parseCallerRetirementQualification(qualificationBytes(qualificationDocument()), { accountId, now: () => 1000 });
  const wrongAccount = await fixtureQualification({ accountId: "d".repeat(32) });
  for (const proof of [undefined, null, true, { digest: qualification.digest }, parsed, structuredClone(qualification), wrongAccount]) {
    const h = harness({ qualification: proof });
    await assert.rejects(retireCallerSecrets(h.options), /qualification/u);
    assert.equal(h.intent, undefined); assert.equal(h.writes, 0);
    assert.equal(h.events.includes("intent"), false); assert.equal(h.events.includes("patch"), false);
    let calls = 0;
    assert.throws(() => createCallerRetirementPatch({ accountId, token: "fixture", role: "publisher",
      qualification: proof, fetcher: async () => { calls++; } }), /qualification/u);
    assert.equal(calls, 0);
  }
  assert(Object.isFrozen(qualification));
  assert.equal(requireCallerRetirementQualification(qualification, accountId), qualification.digest);
});

test("fixed checked null qualification blocks live loading without input or environment overrides", async () => {
  const actual = JSON.parse(await readFile(new URL("../deployment/caller-retirement-provider-qualification.json", import.meta.url)));
  assert.equal(actual.qualification, null);
  await assert.rejects(loadCallerRetirementQualification({ accountId,
    document: qualificationDocument(), path: "/tmp/never-trusted-qualification.json" }), /qualification/u);
});

for (const [name, change] of [
  ["null", d => { d.qualification = null; }],
  ["schema", d => { d.schema = "invented-v2"; }],
  ["unbound account", d => { d.qualification.accountIdSha256 = "9".repeat(64); }],
  ["endpoint", d => { d.qualification.contract.endpoint += "?alternate=1"; }],
  ["method", d => { d.qualification.contract.method = "PUT"; }],
  ["content type", d => { d.qualification.contract.contentType = "application/json"; }],
  ["extra request key", d => { d.qualification.contract.bodyKeys.push("other"); }],
  ["partial null pair", d => { d.qualification.contract.secretNames.pop(); }],
  ["replacement operation", d => { d.qualification.contract.secretOperation = "replace"; }],
  ["missing message map", d => { d.qualification.contract.versionTagKeys.pop(); }],
  ["provider trigger map", d => { d.qualification.contract.versionTagKeys.push("workers/triggered_by"); }],
  ["cleanup absent", d => { d.qualification.result.status = "canary-measured"; }],
  ["mapping false", d => { d.qualification.result.mappingObserved = false; }],
  ["production authority", d => { d.qualification.result.productionAuthorized = true; }],
  ["broader scope", d => { d.qualification.result.scope = "production"; }],
  ["missing raw evidence", d => { delete d.qualification.evidence.requestSha256; }],
  ["invalid raw digest", d => { d.qualification.evidence.afterSha256 = "not-a-sha"; }],
  ["review missing", d => { delete d.qualification.review; }],
  ["review mismatch", d => { d.qualification.review.resultSha256 = "9".repeat(64); }],
  ["review before measurement", d => { d.qualification.measuredAt = "1970-01-01T00:00:02.000Z"; }],
  ["future review", d => { d.qualification.review.reviewedAt = "1970-01-01T00:00:02.000Z"; }],
  ["unknown fields", d => { d.qualification.review.independentlyApproved = true; }],
]) test(`qualification rejects ${name} before writer can receive a capability`, async () => {
  const document = qualificationDocument(); change(document);
  let writers = 0;
  await assert.rejects(async () => {
    const proof = await fixtureQualification({ document });
    writers++;
    return retireCallerSecrets(harness({ qualification: proof }).options);
  }, /qualification/u);
  assert.equal(writers, 0);
});

for (const name of Object.keys(qualificationDocument().qualification.result.measurement))
  test(`qualification requires actual successful ${name}`, async () => {
    const document = qualificationDocument(); document.qualification.result.measurement[name] = false;
    await assert.rejects(fixtureQualification({ document }), /qualification/u);
  });

test("qualification loader bounds regular source data and rejects ambiguous encodings", async () => {
  for (const args of [
    { bytes: Buffer.from("{") }, { bytes: Buffer.alloc(16385, 32) }, { regular: false }, { size: 1 },
    { bytes: Buffer.from('{"schema":"wrong","schema":"atrinik-caller-retirement-provider-qualification-v1","qualification":null}') },
  ]) await assert.rejects(fixtureQualification(args), /qualification/u);
  const digestBefore = qualification.digest;
  const document = qualificationDocument(), changed = structuredClone(document);
  changed.qualification.review.recordSha256 = "7".repeat(64);
  const proof = await fixtureQualification({ document: changed });
  assert.notEqual(proof.digest, digestBefore);
  document.qualification.accountIdSha256 = "9".repeat(64);
  assert.equal(requireCallerRetirementQualification(qualification, accountId), digestBefore);
});
