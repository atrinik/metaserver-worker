import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorizeTransitionOperation, applyTransitionStep, createTransitionPlan, nextTransitionOperation,
  normalizeTransitionTrigger, runTransitionCli, transitionDigest, validateProductionWriterFence,
  verifyTransitionJournal } from "./deployment-environment-transition.mjs";
import { assertProductionPromotionWriterFence } from "./production-writer-fence.mjs";
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = Date.parse("2026-10-11T12:00:00Z");
const clone = structuredClone;
function fixture() {
  const coordinates = { accountId: "a".repeat(32), productionTriggerUuid: id(1), reviewTriggerUuid: id(2),
    developmentBuildTokenUuid: id(5), repositoryConnectionUuid: id(6),
    developmentTokenProofDigest: "b".repeat(64), workers: Object.fromEntries(
      ["production", "development"].map((target, index) => [target,
        ["core", "publisher", "rendezvous"].map((role, n) => ({ role,
          name: `atrinik-metaserver${index ? "-development" : ""}${role === "core" ? "" : `-${role}`}`,
          tag: String(index * 3 + n + 1).repeat(32) }))])) };
  const connection = { repo_connection_uuid: id(6), provider_type: "github", provider_account_name: "atrinik",
    repo_name: "metaserver-worker" };
  const production = { trigger_uuid: id(1), external_script_id: "1".repeat(32), build_token_uuid: id(3),
    trigger_name: "Production", root_directory: "", build_command: "npm ci", deploy_command: "npm run deploy:production",
    branch_includes: ["main"], branch_excludes: [], path_includes: ["*"], path_excludes: [],
    build_caching_enabled: false, repo_connection: connection };
  const review = { ...clone(production), trigger_uuid: id(2), build_token_uuid: id(4), trigger_name: "Review",
    root_directory: "/deployment/review-check", build_command: "npm run build", deploy_command: "npm run validate",
    branch_includes: ["*"], branch_excludes: ["main"] };
  const snapshot = { capturedAt: new Date(now).toISOString(), accountId: coordinates.accountId, complete: true,
    stable: true, workers: clone(coordinates.workers), productionTriggers: [production, review], developmentTriggers: [],
    developmentTokenProofDigest: coordinates.developmentTokenProofDigest,
    productionBuilds: [], activeVersions: Object.fromEntries(Object.values(coordinates.workers).flat().map((w, n) =>
      [w.name, id(10 + n)])), environments: { [id(1)]: { PROD_SECRET: { is_secret: true, value: null } },
      [id(2)]: { SKIP_DEPENDENCY_INSTALL: { is_secret: false, value: "1" } } } };
  snapshot.otherWorkers = Object.fromEntries(Object.values(coordinates.workers).flat().slice(1)
    .map((w) => [w.tag, { triggers: [], builds: [] }]));
  return { snapshot, coordinates, now };
}
function simulate(op, snapshot, plan) {
  if (op.phase === "fence-production") snapshot.productionTriggers[0].branch_excludes = ["*"];
  if (op.phase === "cancel-production-build") snapshot.productionBuilds.find((b) => b.build_uuid === op.buildUuid).status = "stopped";

}
function fencePolicy(plan) {
  const c = plan.coordinates;
  return { accountId: c.accountId, scriptName: "atrinik-metaserver", externalScriptId: "1".repeat(32),
    workers: c.workers.production, developmentWorkers: c.workers.development, productionTriggerUuid: c.productionTriggerUuid, reviewTriggerUuid: c.reviewTriggerUuid,
    productionTriggerDigest: transitionDigest({ ...plan.predecessorProduction, branch_excludes: ["*"] }),
    reviewTriggerDigest: transitionDigest(plan.review),
    productionEnvironmentDigest: transitionDigest(plan.productionEnvironments[id(1)]),
    reviewEnvironmentDigest: transitionDigest(plan.productionEnvironments[id(2)]) };
}
test("transition fences PROD and drains in-flight writer with durable evidence", async () => {
  const f = fixture(), plan = createTransitionPlan(f), records = [], operations = [];
  f.snapshot.productionBuilds = [{ build_uuid: id(30), status: "running", trigger: clone(f.snapshot.productionTriggers[0]) }];
  let time = now;
  for (let n = 0; n < 7; ++n) {
    f.snapshot.capturedAt = new Date(time).toISOString();
    const result = await applyTransitionStep({ plan, snapshot: f.snapshot, records, now: time,
      append: async (record) => { assert.equal(record.sequence, records.length); },
      execute: async (op) => { assert.equal(records.at(-1).event, "intent"); operations.push(op.phase); simulate(op, f.snapshot, plan); } });
    time += 1000;
    if (result.phase === "complete") break;
  }
  assert.deepEqual(operations, ["fence-production", "cancel-production-build"]);
  assert.equal(verifyTransitionJournal(records, plan), null);
  assert.equal(validateProductionWriterFence({ triggers: f.snapshot.productionTriggers,
    builds: f.snapshot.productionBuilds, environments: f.snapshot.environments }, fencePolicy(plan)).mutation, false);
  const before = records.length;
  assert.equal((await applyTransitionStep({ plan, snapshot: f.snapshot, records, now: time,
    append: async () => assert.fail("no-op wrote"), execute: async () => assert.fail("no-op mutated") })).phase, "complete");
  assert.equal(records.length, before);
});
for (const [name, mutate] of [
  ["wrong account", (s) => { s.accountId = "f".repeat(32); }],
  ["wrong environment", (s) => { s.workers.development[0].name = "atrinik-metaserver"; }],
  ["stale", (s) => { s.capturedAt = new Date(now - 30_001).toISOString(); }],
  ["future", (s) => { s.capturedAt = new Date(now + 1).toISOString(); }],
  ["incomplete", (s) => { s.complete = false; }],
  ["unstable", (s) => { s.stable = false; }],
  ["active PROD changed", (s) => { s.activeVersions["atrinik-metaserver"] = id(90); }],
  ["review changed", (s) => { s.productionTriggers[1].deploy_command = "wrangler deploy"; }],
  ["PROD token changed", (s) => { s.productionTriggers[0].build_token_uuid = id(90); }],
  ["PROD env changed", (s) => { s.environments[id(1)].OTHER = { is_secret: true, value: null }; }],
  ["secret disclosure", (s) => { s.environments[id(1)].PROD_SECRET.value = "never-print"; }],
  ["deleted trigger", (s) => { s.productionTriggers[0].deleted_on = new Date(now).toISOString(); }],
]) test(`rejects ${name} before a write`, async () => {
  const f = fixture(), plan = createTransitionPlan(f); mutate(f.snapshot);
  await assert.rejects(applyTransitionStep({ plan, snapshot: f.snapshot, records: [], now,
    append: async () => assert.fail("journal wrote"), execute: async () => assert.fail("mutated") }));
});
test("uncertain write never repeats; exact later readback recovers its intent", async () => {
  const f = fixture(), plan = createTransitionPlan(f), records = [];
  await assert.rejects(applyTransitionStep({ plan, snapshot: f.snapshot, records, now,
    append: async () => {}, execute: async () => { throw new Error("network lost"); } }), /network lost/);
  f.snapshot.capturedAt = new Date(now + 1000).toISOString();
  await assert.rejects(applyTransitionStep({ plan, snapshot: f.snapshot, records, now: now + 1000,
    append: async () => {}, execute: async () => assert.fail("retried") }), /unresolved prior intent/);
  f.snapshot.productionTriggers[0].branch_excludes = ["*"];
  await applyTransitionStep({ plan, snapshot: f.snapshot, records, now: now + 1000,
    append: async () => {}, execute: async () => assert.fail("recovery mutated") });
});
test("journal tampering is rejected", async () => {
  const f = fixture(), plan = createTransitionPlan(f), records = [];
  await applyTransitionStep({ plan, snapshot: f.snapshot, records, now, append: async () => {}, execute: async () => {} });
  records[0].operation.body.branch_excludes = [];
  assert.throws(() => verifyTransitionJournal(records, plan), /integrity/);
});
test("unknown in-flight PROD identity and competing DEV or caller writer are rejected", () => {
  const f = fixture(), plan = createTransitionPlan(f);
  f.snapshot.productionTriggers[0].branch_excludes = ["*"];
  f.snapshot.productionBuilds.push({ build_uuid: id(99), status: "running", trigger: { trigger_uuid: id(99) } });
  assert.throws(() => nextTransitionOperation({ plan, snapshot: f.snapshot, now }), /identity/);
  f.snapshot.productionBuilds = [];
  f.snapshot.otherWorkers["4".repeat(32)].triggers.push({ trigger_uuid: id(99) });
  assert.throws(() => nextTransitionOperation({ plan, snapshot: f.snapshot, now }), /competing/);
});
test("promotion fence rejects even digest-authorized unsafe review commands or environments", () => {
  const f = fixture(), plan = createTransitionPlan(f), policy = fencePolicy(plan);
  f.snapshot.productionTriggers[0].branch_excludes = ["*"];
  f.snapshot.productionTriggers[1].deploy_command = "wrangler deploy";
  policy.reviewTriggerDigest = transitionDigest(normalizeTransitionTrigger(f.snapshot.productionTriggers[1]));
  assert.throws(() => validateProductionWriterFence({ triggers: f.snapshot.productionTriggers,
    builds: [], environments: f.snapshot.environments }, policy), /review trigger/);
});
test("promotion HTTP adapter reads stable exhaustive inventories and performs no mutations", async () => {
  const f = fixture(), plan = createTransitionPlan(f), policy = fencePolicy(plan);
  f.snapshot.productionTriggers[0].branch_excludes = ["*"];
  const environment = { CLOUDFLARE_ACCOUNT_ID: f.coordinates.accountId,
    ATRINIK_PRODUCTION_BUILDS_READ_TOKEN: "private-test-token", ATRINIK_PRODUCTION_WRITER_FENCE_POLICY: JSON.stringify(policy) };
  const calls = [];
  const fetcher = async (url, options) => {
    assert.equal(options.method, undefined); calls.push(url);
    let result;
    if (url.includes("/workers/scripts")) result = [...policy.workers, ...policy.developmentWorkers].map((w) => ({ id: w.name, tag: w.tag }));
    else if (url.includes("/environment_variables")) result = f.snapshot.environments[url.split("/").at(-2)];
    else if (url.endsWith(`/workers/${policy.externalScriptId}/triggers`)) result = f.snapshot.productionTriggers;
    else result = [];
    return new Response(JSON.stringify({ success: true, errors: [], result,
      result_info: { page: 1, count: result.length, total_count: result.length, total_pages: 1 } }));
  };
  assert.equal((await assertProductionPromotionWriterFence({ environment, fetcher })).mutation, false);
  assert.equal(calls.length, 30);
  await assert.rejects(assertProductionPromotionWriterFence({ environment,
    fetcher: async () => new Response(JSON.stringify({ success: true, result: [{ bad: true }] })) }),
    /production writer fence could not be verified/);
});

test("a slow durable append expires the operation before execution", async () => {
  const f = fixture(), plan = createTransitionPlan(f), records = [];
  let elapsed = 0;
  await assert.rejects(applyTransitionStep({ plan, snapshot: f.snapshot, records, now, clock: () => elapsed,
    append: async () => { elapsed = 31_000; }, execute: async () => assert.fail("expired execution") }), /freshness/);
  assert.equal(records.length, 1);
});
test("fresh transport authorization rejects intervening provider and local drift", async () => {
  const f = fixture(), plan = createTransitionPlan(f), op = nextTransitionOperation({ plan, snapshot: f.snapshot, now });
  const current = clone(f.snapshot); current.capturedAt = new Date(now + 1000).toISOString();
  assert.equal(authorizeTransitionOperation({ plan, operation: op, snapshot: current, now: now + 1000 }).mutation, false);
  current.productionTriggers[1].deploy_command = "changed";
  assert.throws(() => authorizeTransitionOperation({ plan, operation: op, snapshot: current, now: now + 1000 }), /peer/);
  await assert.rejects(applyTransitionStep({ plan, snapshot: f.snapshot, records: [], now,
    append: async () => { f.snapshot.productionTriggers[1].deploy_command = "changed"; },
    execute: async () => assert.fail("changed execution") }), /peer/);
});
test("failed journal persistence prevents execution", async () => {
  const f = fixture(), plan = createTransitionPlan(f);
  await assert.rejects(applyTransitionStep({ plan, snapshot: f.snapshot, records: [], now,
    append: async () => { throw new Error("fsync failed"); }, execute: async () => assert.fail("undurable execution") }), /fsync/);
});

test("active review builds require immutable safe launch commands and token, not merely current trigger UUID", () => {
  const f = fixture(), plan = createTransitionPlan(f), policy = fencePolicy(plan);
  f.snapshot.productionTriggers[0].branch_excludes = ["*"];
  const build = { build_uuid: id(95), status: "running", trigger: clone(plan.review),
    build_trigger_metadata: { build_token_uuid: plan.review.build_token_uuid, build_command: "npm run build",
      deploy_command: "npm run validate", root_directory: "/deployment/review-check", branch: "feature/test",
      provider_type: "github", provider_account_name: "atrinik", repo_name: "metaserver-worker" } };
  const input = { triggers: f.snapshot.productionTriggers, builds: [build], environments: f.snapshot.environments };
  assert.equal(validateProductionWriterFence(input, policy).mutation, false);
  build.trigger.build_token_uuid = plan.predecessorProduction.build_token_uuid;
  assert.throws(() => validateProductionWriterFence(input, policy), /launch authority/);
  build.trigger = clone(plan.review);
  build.build_trigger_metadata.deploy_command = "npm run deploy:production";
  assert.throws(() => validateProductionWriterFence(input, policy), /launch authority/);
});

test("rejects role swaps even with otherwise valid environment name sets", () => {
  const f = fixture();
  [f.coordinates.workers.production[0].role, f.coordinates.workers.production[1].role] = ["publisher", "core"];
  f.snapshot.workers = clone(f.coordinates.workers);
  assert.throws(() => createTransitionPlan(f), /role identity/);
});

test("CLI concurrent intent emission has one winner and preserves immutable receipt on replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "metaserver-transition-test-"));
  try {
    const f = fixture(); f.now = Date.now(); f.snapshot.capturedAt = new Date(f.now - 1000).toISOString();
    const plan = createTransitionPlan(f), input = join(directory, "input.json"), journalPath = join(directory, "journal");
    await writeFile(input, JSON.stringify({ plan, snapshot: f.snapshot, journalPath, records: [] }), { mode: 0o600 });
    const results = await Promise.allSettled([runTransitionCli(["--next", input, join(directory, "a.json")]),
      runTransitionCli(["--next", input, join(directory, "b.json")])]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.find((r) => r.status === "fulfilled").value.mutation, false);
    const receipt = await readFile(`${journalPath}.0.json`, "utf8");
    assert.equal(JSON.parse(receipt).event, "intent");
    await assert.rejects(runTransitionCli(["--next", input, join(directory, "replay.json")]));
    assert.equal(await readFile(`${journalPath}.0.json`, "utf8"), receipt);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
