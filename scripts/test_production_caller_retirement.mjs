// Copyright (C) 2026 Atrinik contributors
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, chmod, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { callerRetirementSecrets, callerRetirementSettings, verifyCallerRetirementPost,
  retireCallerSecrets, observeCallerRetirement, createCallerRetirementPatch,
  createCallerRetirementRecorder, parseCallerRetirementModules } from "./production-caller-retirement.mjs";
const accountId = "a".repeat(32), hash = "b".repeat(64), source = "c".repeat(40);
const oldId = "00000000-0000-0000-0000-000000000001", newId = "00000000-0000-0000-0000-000000000002";
function baseline(role = "publisher") {
  const rows = [
    ...callerRetirementSecrets.map((name) => ({ name, type: "secret_text" })),
    { name: "COORDINATOR", type: "service", service: "atrinik-metaserver", entrypoint: role === "publisher" ? "PublisherCoordinator" : "RendezvousCoordinator" },
    ...(role === "publisher" ? ["PUBLISH_ENABLED", "GAME_PUBLISH_ENABLED"] : ["RENDEZVOUS_ENABLED"])
      .map((name) => ({ name, type: "plain_text", text: "disabled" })),
  ];
  return { accountId, name: `atrinik-metaserver-${role}`, activeVersion: oldId, latestVersion: oldId, deploymentId: oldId,
    settings: { bindings: rows, annotations: { "workers/tag": source, "workers/message": `atrinik-delivery-v1 source=${source} deploy=${hash} migration=${hash} horizon=16 control=${hash} role=${role} phase=staged`, "workers/triggered_by": "version_upload" }, compatibility_date: "2026-10-01" },
    resources: { bindings: structuredClone(rows), script: { etag: hash, handlers: ["fetch"] } },
    code: { etag: hash, modules: [{ name: `${role}.js`, type: "application/javascript+module", sha256: hash, bytes: 100 }] },
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

test("reader verifies all six Workers/modules and complete global namespaces twice", async () => {
  const { createCallerRetirementReader } = await import("./production-caller-retirement.mjs");
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
    else result = { stable: true };
    return Response.json({ success: true, result });
  };
  const read = createCallerRetirementReader({ accountId, token: "test-token", role: "publisher", fetcher, now: () => 1000 });
  const value = await read(); assert.equal(value.peers.workers.length, 5); assert.deepEqual(value.peers.namespaces, []);
  assert.equal(value.code.modules.length, 1); assert.equal(value.capturedAt, 1000); assert.equal(requests, 124);
  const incomplete = createCallerRetirementReader({ accountId, token: "test-token", role: "publisher", now: () => 1000,
    fetcher: async (url, options) => url.includes("/namespaces") ? Response.json({ success: true, result: [], result_info: { page: 1, count: 0, total_count: 1001, per_page: 1000, total_pages: 2 } }) : fetcher(url, options) });
  await assert.rejects(incomplete());
});
