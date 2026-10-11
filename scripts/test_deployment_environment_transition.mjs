import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorizeTransitionOperation, applyTransitionStep, createTransitionPlan, nextTransitionOperation,
  normalizeTransitionTrigger, productionFencePatchBody, runTransitionCli, transitionDigest, validateProductionWriterFence,
  verifyTransitionJournal } from "./deployment-environment-transition.mjs";
import { assertProductionPromotionWriterFence, normalizeBuildEnvironment } from "./production-writer-fence.mjs";
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
      [w.name, id(10 + n)])), environments: { [id(1)]: { CLOUDFLARE_ACCOUNT_ID: { is_secret: true, value: null }, SKIP_DEPENDENCY_INSTALL: { is_secret: false, value: "1" } },
      [id(2)]: { SKIP_DEPENDENCY_INSTALL: { is_secret: false, value: "1" } } } };
  snapshot.otherWorkers = Object.fromEntries(Object.values(coordinates.workers).flat().slice(1)
    .map((w) => [w.tag, { triggers: [], builds: [] }]));
  return { snapshot, coordinates, now };
}
function simulate(op, snapshot, plan) {
  if (op.phase === "fence-production") Object.assign(snapshot.productionTriggers[0], { build_command: "exit 1", deploy_command: "exit 1" });
  if (op.phase === "cancel-production-build") snapshot.productionBuilds.find((b) => b.build_uuid === op.buildUuid).status = "stopped";

}
function fencePolicy(plan) {
  const c = plan.coordinates;
  return { accountId: c.accountId, scriptName: "atrinik-metaserver", externalScriptId: "1".repeat(32),
    workers: c.workers.production, developmentWorkers: c.workers.development, productionTriggerUuid: c.productionTriggerUuid, reviewTriggerUuid: c.reviewTriggerUuid,
    productionTriggerDigest: transitionDigest({ ...plan.predecessorProduction, build_command: "exit 1", deploy_command: "exit 1" }),
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
  ["secret disclosure", (s) => { s.environments[id(1)].CLOUDFLARE_ACCOUNT_ID.value = "never-print"; }],
  ["deleted trigger", (s) => { s.productionTriggers[0].deleted_on = new Date(now).toISOString(); }],
  ["deleted repository connection", (s) => {
    s.productionTriggers[0].repo_connection.deleted_on = new Date(now).toISOString();
  }],
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
  Object.assign(f.snapshot.productionTriggers[0], { build_command: "exit 1", deploy_command: "exit 1" });
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
  Object.assign(f.snapshot.productionTriggers[0], { build_command: "exit 1", deploy_command: "exit 1" });
  f.snapshot.productionBuilds.push({ build_uuid: id(99), status: "running", trigger: { trigger_uuid: id(99) } });
  assert.throws(() => nextTransitionOperation({ plan, snapshot: f.snapshot, now }), /identity/);
  f.snapshot.productionBuilds = [];
  f.snapshot.otherWorkers["4".repeat(32)].triggers.push({ trigger_uuid: id(99) });
  assert.throws(() => nextTransitionOperation({ plan, snapshot: f.snapshot, now }), /competing/);
});
test("promotion fence rejects even digest-authorized unsafe review commands or environments", () => {
  const f = fixture(), plan = createTransitionPlan(f), policy = fencePolicy(plan);
  Object.assign(f.snapshot.productionTriggers[0], { build_command: "exit 1", deploy_command: "exit 1" });
  f.snapshot.productionTriggers[1].deploy_command = "wrangler deploy";
  policy.reviewTriggerDigest = transitionDigest(normalizeTransitionTrigger(f.snapshot.productionTriggers[1]));
  assert.throws(() => validateProductionWriterFence({ triggers: f.snapshot.productionTriggers,
    builds: [], environments: f.snapshot.environments }, policy), /review trigger/);
});
test("promotion HTTP adapter reads stable exhaustive inventories and performs no mutations", async () => {
  const f = fixture(), plan = createTransitionPlan(f), policy = fencePolicy(plan);
  Object.assign(f.snapshot.productionTriggers[0], { build_command: "exit 1", deploy_command: "exit 1" });
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
  Object.assign(f.snapshot.productionTriggers[0], { build_command: "exit 1", deploy_command: "exit 1" });
  const build = { build_uuid: id(95), status: "running", trigger: clone(plan.review),
    build_trigger_metadata: { build_token_uuid: plan.review.build_token_uuid, build_command: "npm run build",
      deploy_command: "npm run validate", root_directory: "/deployment/review-check", branch: "feature/test",
      provider_type: "github", provider_account_name: "atrinik", repo_name: "metaserver-worker" } };
  const input = { triggers: f.snapshot.productionTriggers, builds: [build], environments: f.snapshot.environments };
  assert.throws(() => validateProductionWriterFence(input, policy), /in flight/);
  f.snapshot.productionBuilds = [build];
  assert.throws(() => nextTransitionOperation({ plan, snapshot: f.snapshot, now }), /in flight/);
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

test("normalization accepts null tombstones but rejects deleted repository connections even with matching field digests", () => {
  const f = fixture(), plan = createTransitionPlan(f), policy = fencePolicy(plan);
  Object.assign(f.snapshot.productionTriggers[0], { build_command: "exit 1", deploy_command: "exit 1" });
  f.snapshot.productionTriggers[0].repo_connection.deleted_on = null;
  assert.equal(validateProductionWriterFence({ triggers: f.snapshot.productionTriggers,
    builds: [], environments: f.snapshot.environments }, policy).mutation, false);
  f.snapshot.productionTriggers[0].repo_connection.deleted_on = new Date(now).toISOString();
  assert.throws(() => validateProductionWriterFence({ triggers: f.snapshot.productionTriggers,
    builds: [], environments: f.snapshot.environments }, policy), /deleted repository connection/);
  assert.throws(() => createTransitionPlan(f), /deleted repository connection/);
});

function inertFixture() {
  const f = fixture(), plan = createTransitionPlan(f), policy = fencePolicy(plan);
  policy.disposition = "retained-inert-builds";
  for (const trigger of f.snapshot.productionTriggers) {
    trigger.build_command = "exit 1";
    trigger.deploy_command = "exit 1";
    trigger.build_token_uuid = id(3);
  }
  f.snapshot.environments[id(1)] = {
    SKIP_DEPENDENCY_INSTALL: { is_secret: false, value: "1" },
    CLOUDFLARE_ACCOUNT_ID: { is_secret: true, value: null },
    ATRINIK_PRODUCTION_CORE_CONFIG: { is_secret: true, value: null },
    ATRINIK_PRODUCTION_PUBLISHER_CONFIG: { is_secret: true, value: null },
    ATRINIK_PRODUCTION_RENDEZVOUS_CONFIG: { is_secret: true, value: null },
    ATRINIK_PRODUCTION_CONTROL_PLANE_READY: { is_secret: true, value: null },
    ATRINIK_WORKERS_BUILDS_API_TOKEN: { is_secret: true, value: null },
  };
  f.snapshot.environments[id(2)].ATRINIK_WORKERS_BUILDS_API_TOKEN = { is_secret: true, value: null };
  const input = { triggers: f.snapshot.productionTriggers, builds: [], environments: f.snapshot.environments };
  const bind = () => {
    policy.productionTriggerDigest = transitionDigest(normalizeTransitionTrigger(input.triggers[0]));
    policy.reviewTriggerDigest = transitionDigest(normalizeTransitionTrigger(input.triggers[1]));
    policy.productionEnvironmentDigest = transitionDigest(input.environments[id(1)]);
    policy.reviewEnvironmentDigest = transitionDigest(input.environments[id(2)]);
  };
  bind();
  return { input, policy, bind };
}
test("explicit retained inert disposition accepts shared wrapper and only bounded encrypted legacy inputs", () => {
  const { input, policy } = inertFixture();
  assert.equal(input.triggers[0].build_token_uuid, input.triggers[1].build_token_uuid);
  assert.deepEqual(validateProductionWriterFence(input, policy), {
    outcome: "production-writer-fenced", disposition: "retained-inert-builds", mutation: false,
  });
  assert.throws(() => validateProductionWriterFence(input, { ...policy, disposition: undefined }));
  assert.throws(() => validateProductionWriterFence(input, { ...policy, disposition: "branch-only-paused" }), /unknown/);
});
for (const role of [0, 1]) {
  for (const command of ["build_command", "deploy_command"]) {
    for (const value of ["npm run validate", "exit 0", "exit 1; npm run deploy:production", " exit 1", "exit 1\nnpm ci"])
      test(`inert ${role} ${command} rejects ${JSON.stringify(value)} even with matching operator digest`, () => {
        const { input, policy, bind } = inertFixture(); input.triggers[role][command] = value; bind();
        assert.throws(() => validateProductionWriterFence(input, policy), /executable/);
      });
  }
  test(`inert ${role} rejects selector drift and caching even with new matching digests`, () => {
    const { input, policy, bind } = inertFixture(); input.triggers[role].branch_excludes = ["*"]; bind();
    assert.throws(() => validateProductionWriterFence(input, policy));
    input.triggers[role].branch_excludes = role === 0 ? [] : ["main"]; input.triggers[role].build_caching_enabled = true; bind();
    assert.throws(() => validateProductionWriterFence(input, policy), /executable|drift/);
  });
  test(`inert ${role} requires exact nonsecret dependency skip`, () => {
    const { input, policy, bind } = inertFixture(), environment = input.environments[id(role + 1)];
    for (const value of [undefined, { is_secret: true, value: null }, { is_secret: false, value: "0" }]) {
      if (value) environment.SKIP_DEPENDENCY_INSTALL = value; else delete environment.SKIP_DEPENDENCY_INSTALL;
      bind(); assert.throws(() => validateProductionWriterFence(input, policy), /environment/);
    }
  });
  for (const name of ["BASH_ENV", "ENV", "NODE_OPTIONS", "LD_PRELOAD", "PATH", "SHELL", "UNKNOWN_SECRET"])
    test(`inert ${role} rejects environment name ${name} even when encrypted and digest-bound`, () => {
      const { input, policy, bind } = inertFixture();
      input.environments[id(role + 1)][name] = { is_secret: true, value: null }; bind();
      assert.throws(() => validateProductionWriterFence(input, policy), /environment/);
    });
  test(`inert ${role} rejects queued, initializing or running work`, () => {
    const { input, policy } = inertFixture();
    for (const status of ["queued", "initializing", "running"])
      assert.throws(() => validateProductionWriterFence({ ...input, builds: [
        { build_uuid: id(200), status, trigger: input.triggers[role] },
      ] }, policy), /in flight/);
  });
}
test("inert disposition keeps exact trigger and environment digest checks", () => {
  const { input, policy } = inertFixture();
  input.triggers[0].trigger_name = "drift";
  assert.throws(() => validateProductionWriterFence(input, policy), /drift/);
  input.triggers[0].trigger_name = "Production";
  delete input.environments[id(1)].ATRINIK_PRODUCTION_CONTROL_PLANE_READY;
  assert.throws(() => validateProductionWriterFence(input, policy), /environment drift/);
});
test("HTTP read-only adapter retains the explicit inert disposition", async () => {
  const { input, policy } = inertFixture();
  const environment = { CLOUDFLARE_ACCOUNT_ID: policy.accountId, ATRINIK_PRODUCTION_BUILDS_READ_TOKEN: "test-token",
    ATRINIK_PRODUCTION_WRITER_FENCE_POLICY: JSON.stringify(policy) };
  const fetcher = async (url, options) => {
    assert.equal(options.method, undefined);
    let result;
    if (url.includes("/workers/scripts")) result = [...policy.workers, ...policy.developmentWorkers].map(w => ({ id: w.name, tag: w.tag }));
    else if (url.endsWith(`/workers/${policy.externalScriptId}/triggers`)) result = input.triggers;
    else if (url.includes("/environment_variables")) result = Object.fromEntries(
      Object.entries(input.environments[url.split("/").at(-2)]).map(([name, value]) =>
        [name, { ...value, created_on: "2026-10-11T12:00:00Z" }]));
    else result = [];
    return new Response(JSON.stringify({ success: true, errors: [], result }));
  };
  assert.equal((await assertProductionPromotionWriterFence({ environment, fetcher })).disposition, "retained-inert-builds");
});

test("normal transition emits only documented command fields and preserves saved configuration", () => {
  const f = fixture(), plan = createTransitionPlan(f), original = clone(f.snapshot.productionTriggers[0]);
  const op = nextTransitionOperation({ plan, snapshot: f.snapshot, now });
  assert.deepEqual(op.body, productionFencePatchBody(original));
  assert.deepEqual(op.body, { build_command: "exit 1", deploy_command: "exit 1" });
  assert.deepEqual(f.snapshot.productionTriggers[0], original);
  simulate(op, f.snapshot, plan);
  const { build_command: _build, deploy_command: _deploy, ...unchanged } = f.snapshot.productionTriggers[0];
  const { build_command: _oldBuild, deploy_command: _oldDeploy, ...predecessor } = original;
  assert.deepEqual(unchanged, predecessor);
});
test("branch-only pause cannot complete a normal transition or authorize a writer fence", async () => {
  const f = fixture(), plan = createTransitionPlan(f), records = [];
  await applyTransitionStep({ plan, snapshot: f.snapshot, records, now, append: async () => {}, execute: async () => {} });
  f.snapshot.productionTriggers[0].branch_excludes = ["*"];
  f.snapshot.capturedAt = new Date(now + 1000).toISOString();
  await assert.rejects(applyTransitionStep({ plan, snapshot: f.snapshot, records, now: now + 1000,
    append: async () => assert.fail("partial fence observed"), execute: async () => assert.fail("partial fence retried") }), /drift/);
  const policy = fencePolicy(plan);
  policy.productionTriggerDigest = transitionDigest(normalizeTransitionTrigger(f.snapshot.productionTriggers[0]));
  assert.throws(() => validateProductionWriterFence({ triggers: f.snapshot.productionTriggers, builds: [], environments: f.snapshot.environments }, policy), /drift/);
});
test("normal transition requires dependency skip and rejects production startup environment variables", () => {
  const f = fixture();delete f.snapshot.environments[id(1)].SKIP_DEPENDENCY_INSTALL;
  assert.throws(() => createTransitionPlan(f), /environment/);
  f.snapshot.environments[id(1)].SKIP_DEPENDENCY_INSTALL = { is_secret: false, value: "1" };
  f.snapshot.environments[id(1)].BASH_ENV = { is_secret: true, value: null };
  assert.throws(() => createTransitionPlan(f), /environment/);
});

test("normal transition and guard reject digest-bound branch or cache drift", () => {
  for (const mutate of [trigger => { trigger.branch_excludes = ["*"]; },
    trigger => { trigger.branch_includes = ["*"]; }, trigger => { trigger.build_caching_enabled = true; }]) {
    const f = fixture(); mutate(f.snapshot.productionTriggers[0]);
    assert.throws(() => createTransitionPlan(f), /predecessor/);
    const good = fixture(), plan = createTransitionPlan(good), policy = fencePolicy(plan);
    Object.assign(good.snapshot.productionTriggers[0], { build_command: "exit 1", deploy_command: "exit 1" });
    mutate(good.snapshot.productionTriggers[0]);
    policy.productionTriggerDigest = transitionDigest(normalizeTransitionTrigger(good.snapshot.productionTriggers[0]));
    assert.throws(() => validateProductionWriterFence({ triggers: good.snapshot.productionTriggers,
      builds: [], environments: good.snapshot.environments }, policy), /drift/);
  }
});
test("command-only completion preserves original main and review selectors", () => {
  const f = fixture(), plan = createTransitionPlan(f), op = nextTransitionOperation({ plan, snapshot: f.snapshot, now });
  simulate(op, f.snapshot, plan);
  assert.deepEqual(f.snapshot.productionTriggers.map(t => [t.branch_includes, t.branch_excludes]),
    [[["main"], []], [["*"], ["main"]]]);
  assert.equal(nextTransitionOperation({ plan, snapshot: f.snapshot, now }).phase, "complete");
});

function inertTransitionFixture() {
  const f = fixture();
  f.disposition = "retained-inert-builds";
  f.snapshot.productionTriggers[1].build_token_uuid = f.snapshot.productionTriggers[0].build_token_uuid;
  f.snapshot.environments[id(2)].ATRINIK_WORKERS_BUILDS_API_TOKEN = { is_secret: true, value: null };
  return f;
}
test("explicit retained inert transition seals both roles with exact command-only requests and reaches valid fence", async () => {
  const f = inertTransitionFixture(), plan = createTransitionPlan(f), records = [], phases = [];
  const original = clone(f.snapshot.productionTriggers);
  let clockNow = now;
  for (let step = 0; step < 3; step++) {
    f.snapshot.capturedAt = new Date(clockNow).toISOString();
    const result = await applyTransitionStep({ plan, snapshot: f.snapshot, records, now: clockNow,
      append: async () => {}, execute: async op => {
        phases.push(op.phase);
        assert.deepEqual(op.body, { build_command: "exit 1", deploy_command: "exit 1" });
        const target = op.phase === "fence-production" ? 0 : 1;
        assert.equal(op.path, `/accounts/${f.coordinates.accountId}/builds/triggers/${f.snapshot.productionTriggers[target].trigger_uuid}`);
        Object.assign(f.snapshot.productionTriggers[target], op.body);
      } });
    assert.equal(result.phase, step === 2 ? "complete" : "await-readback");
    clockNow += 1000;
  }
  assert.deepEqual(phases, ["fence-production", "fence-review"]);
  assert.equal(verifyTransitionJournal(records, plan), null);
  assert.deepEqual(f.snapshot.productionTriggers, original.map(t => ({ ...t, build_command: "exit 1", deploy_command: "exit 1" })));
  const policy = { ...fencePolicy(plan), disposition: plan.disposition,
    reviewTriggerDigest: transitionDigest(normalizeTransitionTrigger(f.snapshot.productionTriggers[1])) };
  assert.equal(validateProductionWriterFence({ triggers: f.snapshot.productionTriggers,
    builds: [], environments: f.snapshot.environments }, policy).disposition, "retained-inert-builds");
});
test("retained inert review uncertain write recovers only exact fresh readback, never repeats", async () => {
  const f = inertTransitionFixture(), plan = createTransitionPlan(f), records = [];
  Object.assign(f.snapshot.productionTriggers[0], { build_command: "exit 1", deploy_command: "exit 1" });
  await assert.rejects(applyTransitionStep({ plan, snapshot: f.snapshot, records, now,
    append: async () => {}, execute: async () => { throw new Error("uncertain"); } }), /uncertain/);
  f.snapshot.capturedAt = new Date(now + 1000).toISOString();
  await assert.rejects(applyTransitionStep({ plan, snapshot: f.snapshot, records, now: now + 1000,
    append: async () => assert.fail("unproven observation"), execute: async () => assert.fail("repeated") }), /unresolved/);
  Object.assign(f.snapshot.productionTriggers[1], { build_command: "exit 1", deploy_command: "exit 1" });
  assert.equal((await applyTransitionStep({ plan, snapshot: f.snapshot, records, now: now + 1000,
    append: async () => {}, execute: async () => assert.fail("repeated") })).phase, "complete");
});
test("retained inert phases reject new active builds, environment changes and peer drift before writes", async () => {
  for (const change of [
    f => { f.snapshot.productionBuilds.push({ build_uuid: id(400), status: "running", trigger: clone(f.snapshot.productionTriggers[1]) }); },
    f => { f.snapshot.environments[id(2)].ENV = { is_secret: true, value: null }; },
    f => { f.snapshot.productionTriggers[1].branch_excludes = []; },
    f => { f.snapshot.productionTriggers[1].build_token_uuid = id(444); },
  ]) {
    const f = inertTransitionFixture(), plan = createTransitionPlan(f);
    Object.assign(f.snapshot.productionTriggers[0], { build_command: "exit 1", deploy_command: "exit 1" });
    change(f);
    await assert.rejects(applyTransitionStep({ plan, snapshot: f.snapshot, records: [], now,
      append: async () => assert.fail("unsafe intent"), execute: async () => assert.fail("unsafe write") }));
  }
});
test("retained inert planning is explicit, rejects active predecessors and unsafe review inputs", () => {
  const f = inertTransitionFixture();
  assert.throws(() => createTransitionPlan({ ...f, disposition: undefined }), /predecessor/);
  assert.throws(() => createTransitionPlan({ ...f, disposition: "unknown" }), /disposition/);
  f.snapshot.productionBuilds.push({ build_uuid: id(400), status: "queued", trigger: clone(f.snapshot.productionTriggers[1]) });
  assert.throws(() => createTransitionPlan(f), /in flight/);
  f.snapshot.productionBuilds = [];
  f.snapshot.environments[id(2)].NODE_OPTIONS = { is_secret: true, value: null };
  assert.throws(() => createTransitionPlan(f), /environment/);
});


test("provider environment normalization strips only documented observation metadata", () => {
  const canonical = { SECRET: { is_secret: true, value: null }, PLAIN: { is_secret: false, value: "1" } };
  const response = Object.fromEntries(Object.entries(canonical).map(([name, item]) =>
    [name, { created_on: "2026-10-11T12:00:00.123456Z", ...item }]));
  assert.deepEqual(normalizeBuildEnvironment(response), canonical);
  assert.equal(transitionDigest(normalizeBuildEnvironment(response)), transitionDigest(canonical));
  assert.equal(response.SECRET.created_on, "2026-10-11T12:00:00.123456Z");
  response.PLAIN.value = "unexpected-new-value";
  assert.notEqual(transitionDigest(normalizeBuildEnvironment(response)), transitionDigest(canonical));
});

for (const [name, entry] of Object.entries({
  unknown: { is_secret: true, value: null, unexpected: true },
  undocumentedModified: { is_secret: true, value: null, modified_on: "2026-10-11T12:00:00Z" },
  malformedDate: { is_secret: true, value: null, created_on: "yesterday" },
  impossibleDate: { is_secret: true, value: null, created_on: "2026-13-01T12:00:00Z" },
  nullDate: { is_secret: true, value: null, created_on: null },
  secretExposure: { is_secret: true, value: "private-secret" },
  wrongClassification: { is_secret: "true", value: null },
  absentValue: { is_secret: true },
  nonstringPlain: { is_secret: false, value: 1 },
})) test(`environment normalization fails closed for ${name}`, () => {
  assert.throws(() => normalizeBuildEnvironment({ SECRET: entry }),
    error => error.message === "production writer fence could not be verified");
});

test("sealed environment validator rejects unnormalized metadata even with a matching digest", () => {
  const { input, policy } = inertFixture();
  input.environments[id(1)].SKIP_DEPENDENCY_INSTALL.created_on = "2026-10-11T12:00:00Z";
  policy.productionEnvironmentDigest = transitionDigest(input.environments[id(1)]);
  assert.throws(() => validateProductionWriterFence(input, policy), /redacted secret classifications/);
});
