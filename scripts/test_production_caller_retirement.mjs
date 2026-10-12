// Copyright (C) 2026 Atrinik contributors
import test from "node:test";
import { createProductionReadPacer } from "./production-read-pacing.mjs";
import { retirementFailureDiagnostic } from "./production-retirement-diagnostics.mjs";
import { virtualClock } from "./production-test-clock.mjs";
import { orchestrateDelivery, deliveryFailureRecord } from "./production-delivery.mjs";
import assert from "node:assert/strict";
import { mkdtemp, chmod, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { verifyRecoveryArtifactProof } from "./production-recovery-artifacts.mjs";
import { callerRetirementSecrets, callerRetirementSettings, verifyCallerRetirementPost,
  retireCallerSecrets, observeCallerRetirement, createCallerRetirementPatch,
  createCallerRetirementRecorder, parseCallerRetirementModules } from "./production-caller-retirement.mjs";
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
    options: { role: "publisher", now: () => 1000, fence: async () => events.push("fence"), authorize: async () => events.push("authorize"),
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
test("multipart settings removes only pair and retains every mutable annotation", () => {
  const before = baseline(); before.settings.annotations.custom = "retained";
  const settings = callerRetirementSettings("publisher", before);
  assert.equal(settings.annotations.custom, "retained");
  assert.equal(settings.annotations["workers/message"], before.settings.annotations["workers/message"]);
  assert.equal(Object.hasOwn(settings.annotations, "workers/triggered_by"), false);
  assert.equal(settings.bindings.some((b) => b.type === "secret_text"), false);
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
  assert.throws(() => callerRetirementSettings("core", baseline()));
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
test("bounded multipart transport is pinned and consumed even on network ambiguity", async () => {
  let calls = 0;
  const patch = createCallerRetirementPatch({ accountId, token: "test-token", role: "publisher", fetcher: async (url, options) => {
    calls++; assert.equal(url, `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/atrinik-metaserver-publisher/settings`);
    assert.equal(options.method, "PATCH"); assert.equal(options.redirect, "error");
    assert.deepEqual(JSON.parse(await options.body.get("settings").text()), callerRetirementSettings("publisher", baseline()));
    throw Error("network uncertainty");
  } });
  const request = { accountId, role: "publisher", name: "atrinik-metaserver-publisher", settings: callerRetirementSettings("publisher", baseline()) };
  await assert.rejects(patch({ ...request, role: "rendezvous" })); assert.equal(calls, 0);
  await assert.rejects(patch(request)); await assert.rejects(patch(request)); assert.equal(calls, 1);
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
    const patch = createCallerRetirementPatch({ accountId, token: "fixture", role: "publisher", fetcher });
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
    patch: createCallerRetirementPatch({ accountId, token: "fixture", role: "publisher", fetcher: async () => {
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
