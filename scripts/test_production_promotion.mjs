// Copyright (C) 2026 Atrinik contributors
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  createProductionAuthority, promotionDigest, readPromotionEvidence,
  validatePromotionContext, validatePromotionEvidence, validatePromotionInputs,
  validatePromotionPlan, validatePromotionPredecessor, validatePromotionSource, runPromotionDelivery,
} from "./production-promotion.mjs";

const source = "a".repeat(40);
const controller = "b".repeat(40);
const currentMain = "c".repeat(40);
const digest = "d".repeat(64);
const repository = "atrinik/metaserver-worker";
const now = Date.parse("2026-10-11T20:00:00Z");
const versions = ["core-version", "publisher-version", "rendezvous-version"];
function fixture() {
  const inputs = { tag: "v4.31.0", source_sha: source, artifact_digest: digest,
    configuration_digest: digest, migration_digest: digest, expected_predecessor: promotionDigest(versions) };
  const environment = {
    GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REPOSITORY: repository,
    GITHUB_REF: "refs/heads/main", GITHUB_RUN_ATTEMPT: "1", GITHUB_RUN_ID: "1234",
    GITHUB_SHA: controller, GITHUB_WORKFLOW_SHA: controller,
    GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/promote-production.yml@refs/heads/main`,
    GITHUB_EVENT_PATH: "/provider/event.json", GITHUB_TOKEN: "fixture-only-secret",
    ATRINIK_DELIVERY_SOURCE_ROOT: "/selected", ATRINIK_PROMOTION_TAG: inputs.tag,
    ATRINIK_PROMOTION_SHA: source, ATRINIK_PROMOTION_ARTIFACT_DIGEST: digest,
    ATRINIK_PROMOTION_CONFIG_DIGEST: digest, ATRINIK_PROMOTION_MIGRATION_DIGEST: digest,
    ATRINIK_PROMOTION_PREDECESSOR: inputs.expected_predecessor,
  };
  const event = { inputs, repository: { full_name: repository }, ref: "refs/heads/main", sender: { id: 123 } };
  const evidence = {
    repo: { full_name: repository, default_branch: "main", fork: false },
    branch: { name: "main", protected: true, commit: { sha: currentMain } },
    run: { id: 1234, run_attempt: 1, event: "workflow_dispatch", head_branch: "main",
      head_sha: controller, path: ".github/workflows/promote-production.yml",
      repository: { full_name: repository }, head_repository: { full_name: repository },
      status: "in_progress", conclusion: null, actor: { id: 123, login: "operator" }, triggering_actor: { id: 123 },
      created_at: "2026-10-11T19:30:00Z" },
    release: { id: 7, tag_name: inputs.tag, immutable: true, draft: false, prerelease: false,
      published_at: "2026-10-10T12:00:00Z" }, tagSha: source,
    sourceComparison: { status: "ahead", merge_base_commit: { sha: source } },
    controllerComparison: { status: "ahead", merge_base_commit: { sha: controller } },
    checks: [{ path: ".github/workflows/check.yml", event: "push", head_branch: "main", head_sha: source,
      repository: { full_name: repository }, head_repository: { full_name: repository },
      status: "completed", conclusion: "success", updated_at: "2026-10-10T11:00:00Z" }],
    actorPermission: { permission: "admin", user: { id: 123 } },
    jobs: [{ name: "validate", run_id: 1234, run_attempt: 1, head_sha: controller,
      status: "completed", conclusion: "success" }],
    approvals: [{ state: "approved", user: { id: 456 }, environments: [{ id: 999, name: "production" }] }],
    protection: { id: 999, name: "production",
      deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
      protection_rules: [{ type: "required_reviewers", prevent_self_review: true, reviewers: [{ type: "User", reviewer: { id: 456 } }] }] },
  };
  return { inputs, environment, event, evidence, now };
}

function fakeFetch(f, mutate = () => {}) {
  return async (url, options) => {
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, "Bearer fixture-only-secret");
    assert(!url.includes("fixture-only-secret"));
    const path = new URL(url).pathname.replace(`/repos/${repository}`, "");
    const { evidence: e } = f;
    const routes = {
      "": e.repo, "/branches/main": e.branch, "/actions/runs/1234": e.run,
      "/releases/tags/v4.31.0": e.release,
      "/git/ref/tags/v4.31.0": { ref: "refs/tags/v4.31.0", object: { type: "commit", sha: e.tagSha } },
      [`/compare/${source}...main`]: e.sourceComparison,
      [`/compare/${controller}...main`]: e.controllerComparison,
      "/actions/workflows/check.yml/runs": { total_count: e.checks.length, workflow_runs: e.checks },
      "/environments/production": e.protection,
      "/actions/runs/1234/attempts/1/jobs": { total_count: e.jobs.length, jobs: e.jobs },
      "/actions/runs/1234/approvals": e.approvals,
      "/collaborators/operator/permission": e.actorPermission,
    };
    assert(Object.hasOwn(routes, path), path);
    let value = structuredClone(routes[path]);
    value = mutate(path, value) ?? value;
    return new Response(JSON.stringify(value), { status: 200 });
  };
}

test("selected source can lag both controller and newer main without replacement", () => {
  const f = fixture();
  assert.equal(validatePromotionContext(f.environment, f.event, source, false).source_sha, source);
  validatePromotionEvidence(f);
  validatePromotionPlan(f.inputs, { deploy: digest, configDigest: digest, migrationDigest: digest });
  validatePromotionPredecessor(f.inputs, versions);
});

for (const [name, modify] of [
  ["tag push", (f) => { f.environment.GITHUB_EVENT_NAME = "push"; }],
  ["fork", (f) => { f.environment.GITHUB_REPOSITORY = "attacker/metaserver-worker"; }],
  ["pull request", (f) => { f.environment.GITHUB_REF = "refs/pull/1/merge"; }],
  ["run replay", (f) => { f.environment.GITHUB_RUN_ATTEMPT = "2"; }],
  ["controller mismatch", (f) => { f.environment.GITHUB_WORKFLOW_SHA = source; }],
  ["input substitution", (f) => { f.environment.ATRINIK_PROMOTION_CONFIG_DIGEST = "e".repeat(64); }],
  ["unapproved field", (f) => { f.event.inputs.environment = "development"; }],
]) test(`rejects context: ${name}`, () => {
  const f = fixture(); modify(f);
  assert.throws(() => validatePromotionContext(f.environment, f.event, source, false));
});

test("rejects wrong or dirty selected checkout", () => {
  const f = fixture();
  assert.throws(() => validatePromotionContext(f.environment, f.event, controller, false));
  assert.throws(() => validatePromotionContext(f.environment, f.event, source, true));
});

for (const [name, modify] of [
  ["moved tag", (e) => { e.tagSha = controller; }],
  ["mutable release", (e) => { e.release.immutable = false; }],
  ["draft release", (e) => { e.release.draft = true; }],
  ["unvalidated source", (e) => { e.checks = []; }],
  ["PR-only validation", (e) => { e.checks[0].event = "pull_request"; }],
  ["validation after approval", (e) => { e.checks[0].updated_at = "2026-10-11T19:45:00Z"; }],
  ["source outside protected history", (e) => { e.sourceComparison.status = "diverged"; }],
  ["unprotected branch", (e) => { e.branch.protected = false; }],
  ["cancelled run", (e) => { e.run.status = "completed"; e.run.conclusion = "cancelled"; }],
  ["API run replay", (e) => { e.run.run_attempt = 2; }],
  ["wrong run", (e) => { e.run.id = 5678; }],
  ["different workflow", (e) => { e.run.path = ".github/workflows/release.yml"; }],
  ["stale queued dispatch", (e) => { e.run.created_at = "2026-10-11T18:00:00Z"; }],
  ["future dispatch", (e) => { e.run.created_at = "2026-10-11T21:00:00Z"; }],
  ["environment confusion", (e) => { e.protection.name = "development"; }],
  ["unprotected environment branches", (e) => { e.protection.deployment_branch_policy.protected_branches = false; }],
  ["admin bypass without approval", (e) => { e.approvals = []; }],
  ["wrong environment approval", (e) => { e.approvals[0].environments[0].id = 998; }],
  ["self-approved dispatch", (e) => { e.approvals[0].user.id = 123; }],
  ["rejected environment", (e) => { e.approvals[0].state = "rejected"; }],
  ["replayed validation", (e) => { e.jobs[0].run_attempt = 2; }],
  ["failed selected validation", (e) => { e.jobs[0].conclusion = "failure"; }],
  ["missing selected validation", (e) => { e.jobs = []; }],
  ["read-only operator", (e) => { e.actorPermission.permission = "read"; }],
]) test(`rejects live authority: ${name}`, () => {
  const f = fixture(); modify(f.evidence);
  assert.throws(() => validatePromotionEvidence(f));
});


test("solo operator manual approval needs no invented second-person gate", () => {
  const f = fixture();
  f.evidence.protection.protection_rules = [];
  f.evidence.approvals = [];
  validatePromotionEvidence(f);
  f.evidence.protection.protection_rules = [{ type: "required_reviewers", prevent_self_review: false,
    reviewers: [{ type: "User", reviewer: { id: 123 } }] }];
  f.evidence.approvals = [{ state: "approved", user: { id: 123 }, environments: [{ id: 999, name: "production" }] }];
  validatePromotionEvidence(f);
});

test("each artifact dimension and the queued predecessor are independently fenced", () => {
  const f = fixture();
  for (const key of ["deploy", "configDigest", "migrationDigest"]) {
    const plan = { deploy: digest, configDigest: digest, migrationDigest: digest };
    plan[key] = "e".repeat(64);
    assert.throws(() => validatePromotionPlan(f.inputs, plan));
  }
  assert.throws(() => validatePromotionPredecessor(f.inputs, [...versions].reverse()));
  assert.throws(() => validatePromotionPredecessor(f.inputs, ["new-version", ...versions.slice(1)]));
});

test("fresh authority is fetched on every fence; moved tag prevents the next mutation", async () => {
  const f = fixture(); let writerChecks = 0;
  const authority = await createProductionAuthority({ environment: f.environment, checkoutHead: source, dirty: false,
    readEvent: async () => JSON.stringify(f.event), fetcher: fakeFetch(f), now: () => now,
    writerFence: async () => { writerChecks += 1; } });
  assert.equal(authority.sourceSha, source);
  assert.equal(authority.executionId, "1234");
  await authority.fence();
  assert.equal(writerChecks, 2);
  f.evidence.tagSha = controller;
  await assert.rejects(authority.fence(), /tag/);
  assert.equal(writerChecks, 2);
});

test("dispatch expiry during writer inventory stops initial and subsequent authority handoff", async () => {
  const f = fixture();
  const created = Date.parse(f.evidence.run.created_at);
  let clock = created + 60 * 60 * 1000 - 1000;
  let sweepDuration = 2000;
  const options = { environment: f.environment, checkoutHead: source, dirty: false,
    readEvent: async () => JSON.stringify(f.event), fetcher: fakeFetch(f), now: () => clock,
    writerFence: async () => { clock += sweepDuration; } };
  await assert.rejects(createProductionAuthority(options), /freshness/);

  clock = created + 60 * 60 * 1000 - 1000;
  sweepDuration = 0;
  const authority = await createProductionAuthority(options);
  sweepDuration = 2000;
  let mutations = 0;
  await assert.rejects(async () => { await authority.fence(); mutations += 1; }, /freshness/);
  assert.equal(mutations, 0);
});

for (const [name, change] of [
  ["tag moved", (f) => { f.evidence.tagSha = controller; }],
  ["run cancelled", (f) => { f.evidence.run.status = "completed"; f.evidence.run.conclusion = "cancelled"; }],
  ["operator permission revoked", (f) => { f.evidence.actorPermission.permission = "read"; }],
]) test(`refreshes GitHub authority after writer sweep: ${name}`, async () => {
  const f = fixture();
  let mutateDuringSweep = false;
  const options = { environment: f.environment, checkoutHead: source, dirty: false,
    readEvent: async () => JSON.stringify(f.event), fetcher: fakeFetch(f), now: () => now,
    writerFence: async () => { if (mutateDuringSweep) change(f); } };
  const authority = await createProductionAuthority(options);
  mutateDuringSweep = true;
  let mutations = 0;
  await assert.rejects(async () => { await authority.fence(); mutations += 1; });
  assert.equal(mutations, 0);
});

test("writer fence failure denies authority before delivery", async () => {
  const f = fixture();
  await assert.rejects(createProductionAuthority({ environment: f.environment, checkoutHead: source, dirty: false,
    readEvent: async () => JSON.stringify(f.event), fetcher: fakeFetch(f), now: () => now,
    writerFence: async () => { throw new Error("old writer active"); } }), /old writer active/);
});

test("annotated tags are peeled with a bounded exact commit check", async () => {
  const f = fixture(); const base = fakeFetch(f, (path, value) => path.startsWith("/git/ref/") ?
    { ...value, object: { type: "tag", sha: controller } } : value);
  const fetcher = async (url, options) => url.endsWith(`/git/tags/${controller}`) ?
    new Response(JSON.stringify({ object: { type: "commit", sha: source } })) : base(url, options);
  const evidence = await readPromotionEvidence(f.environment, f.inputs, fetcher);
  assert.equal(evidence.tagSha, source);
  await assert.rejects(readPromotionEvidence(f.environment, f.inputs, async (url, options) =>
    url.endsWith(`/git/tags/${controller}`) ? new Response(JSON.stringify({ object: { type: "tag", sha: controller } })) :
      base(url, options)), /resolve/);
});

test("API errors do not reflect credential contents; oversized/incomplete responses fail", async () => {
  const f = fixture();
  await assert.rejects(readPromotionEvidence(f.environment, f.inputs, async () => {
    throw new Error(f.environment.GITHUB_TOKEN);
  }), (error) => !error.message.includes(f.environment.GITHUB_TOKEN));
  await assert.rejects(readPromotionEvidence(f.environment, f.inputs, async () => new Response("x".repeat(2_000_001))));
  await assert.rejects(readPromotionEvidence(f.environment, f.inputs, fakeFetch(f, (path, value) =>
    path === "/actions/workflows/check.yml/runs" ? { ...value, total_count: 101 } : value)), /incomplete/);
});


for (const [name, rules] of [["missing", undefined], ["null", null], ["object", {}],
  ["null entry", [null]], ["array entry", [[]]], ["missing type", [{}]],
  ["unknown type", [{ type: "unknown" }]], ["duplicate rule", [{ type: "branch_policy" }, { type: "branch_policy" }]]])
  test(`rejects incomplete environment protection rules: ${name}`, () => {
    const f = fixture(); f.evidence.protection.protection_rules = rules;
    assert.throws(() => validatePromotionEvidence(f));
  });

for (const [name, modify] of [
  ["missing self-review flag", (rule) => { delete rule.prevent_self_review; }],
  ["null self-review flag", (rule) => { rule.prevent_self_review = null; }],
  ["string self-review flag", (rule) => { rule.prevent_self_review = "false"; }],
  ["missing reviewers", (rule) => { delete rule.reviewers; }],
  ["empty reviewers", (rule) => { rule.reviewers = []; }],
  ["malformed reviewer", (rule) => { rule.reviewers = [null]; }],
]) test(`rejects malformed configured reviewer policy: ${name}`, () => {
  const f = fixture(); modify(f.evidence.protection.protection_rules[0]);
  f.evidence.approvals[0].user.id = f.event.sender.id;
  assert.throws(() => validatePromotionEvidence(f));
});

for (const path of ["/actions/workflows/check.yml/runs", "/actions/runs/1234/attempts/1/jobs"])
  for (const [name, count] of [["missing", undefined], ["null", null], ["negative", -1],
    ["negative zero", -0], ["string", "1"], ["fractional", 1.5], ["unsafe", Number.MAX_SAFE_INTEGER + 1],
    ["underreported", 0], ["overreported", 2], ["truncated", 101]])
    test(`rejects malformed or incomplete inventory ${path}: ${name}`, async () => {
      const f = fixture();
      // JSON.stringify canonicalizes -0 to 0, which still contradicts the one returned row.
      await assert.rejects(readPromotionEvidence(f.environment, f.inputs,
        fakeFetch(f, (actualPath, value) => actualPath === path ? { ...value, total_count: count } : value)), /incomplete/);
    });

test("source preflight authenticates immutable source before selected checkout or execution", async () => {
  const f = fixture();
  // The selected source has not been checked out or executed; its validation
  // job is currently in progress. No deployment secret is required here.
  delete f.environment.ATRINIK_DELIVERY_SOURCE_ROOT;
  f.evidence.jobs[0].status = "in_progress";
  f.evidence.jobs[0].conclusion = null;
  f.evidence.approvals = [];
  assert.equal(await validatePromotionSource({ environment: f.environment,
    readEvent: async () => JSON.stringify(f.event), fetcher: fakeFetch(f), now: () => now }), source);
});

for (const [name, modify] of [
  ["arbitrary PR revision", (f) => { f.evidence.sourceComparison.status = "diverged"; }],
  ["mutable release", (f) => { f.evidence.release.immutable = false; }],
  ["missing source validation", (f) => { f.evidence.checks = []; }],
  ["tag and input mismatch", (f) => { f.evidence.tagSha = controller; }],
  ["unauthorized operator", (f) => { f.evidence.actorPermission.permission = "read"; }],
]) test(`source preflight denies untrusted dispatch before npm execution: ${name}`, async () => {
  const f = fixture(); modify(f);
  await assert.rejects(validatePromotionSource({ environment: f.environment,
    readEvent: async () => JSON.stringify(f.event), fetcher: fakeFetch(f), now: () => now }));
});

test("promotion wrapper preserves bounded engine failure and recovery evidence", async () => {
  const records = [];
  const underlying = new Error("SECRET-CREDENTIAL private-provider-id raw command output");
  const safe = { outcome: "production-delivery-stopped", reason: "unexpected-internal-error",
    sourceSha: source, deployableDigest: digest, failedRole: "active:publisher",
    completedRoles: ["staged:core", "staged:publisher", "staged:rendezvous"], recoveryOutcome: "disabled-core-proven" };
  const exitCode = await runPromotionDelivery({ environment: { ATRINIK_DELIVERY_SOURCE_ROOT: "/selected" },
    loadDelivery: async () => ({
      runDelivery: async (options) => {
        assert.deepEqual(options, { target: "production", sourceRoot: "/selected", mode: "deploy" });
        throw underlying;
      },
      currentDeliveryFailureRecord: (error) => { assert.equal(error, underlying); return safe; },
    }), reportFailure: (record) => records.push(record) });
  assert.equal(exitCode, 1);
  assert.deepEqual(records.map((record) => JSON.parse(record)), [safe]);
  assert.doesNotMatch(records[0], /SECRET|private-provider|raw command/u);
});

test("promotion wrapper fails closed without a trusted engine failure reporter", async () => {
  let deliveries = 0; const records = [];
  assert.equal(await runPromotionDelivery({ loadDelivery: async () => ({ runDelivery: () => { deliveries += 1; } }),
    reportFailure: (record) => records.push(JSON.parse(record)) }), 1);
  assert.equal(deliveries, 0);
  assert.equal(records[0].reason, "authority-or-delivery-verification-failed");
  assert.equal(await runPromotionDelivery({ loadDelivery: async () => { throw new Error("SECRET import failure"); },
    reportFailure: (record) => assert.doesNotMatch(record, /SECRET/u) }), 1);
});

test("dry run is credential-free and cannot invoke deployment or network", () => {
  const f = fixture();
  const env = Object.fromEntries(Object.entries(f.environment).filter(([name]) => name.startsWith("ATRINIK_PROMOTION_")));
  const result = spawnSync(process.execPath, ["scripts/production-promotion.mjs", "--dry-run"], { env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).mutation, false);
  assert.throws(() => validatePromotionInputs({ ...f.inputs, tag: "$(false)" }));
});

test("workflow has a single manual serialized writer and credentials only in execution step", async () => {
  const workflow = await readFile(new URL("../.github/workflows/promote-production.yml", import.meta.url), "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^  (?:push|release|pull_request|workflow_call):/mu);
  assert.match(workflow, /group: metaserver-production-promotion\n  cancel-in-progress: false/u);
  assert.match(workflow, /environment: production/u);
  const [validation, promotion] = workflow.split("  promote:");
  assert.doesNotMatch(validation, /secrets\.|CLOUDFLARE_API_TOKEN/u);
  const [preparation, execution] = promotion.split("      - name: Verify authority and promote");
  assert.doesNotMatch(preparation, /secrets\./u);
  assert.match(execution, /ATRINIK_DELIVERY_RESOURCE_POLICY: \$\{\{ secrets\.ATRINIK_DELIVERY_RESOURCE_POLICY \}\}/u);
  assert.match(execution, /ATRINIK_DELIVERY_RESOURCE_READ_TOKEN: \$\{\{ secrets\.ATRINIK_DELIVERY_RESOURCE_READ_TOKEN \}\}/u);
  assert.match(execution, /uses: \.\/controller\/\.github\/actions\/promote-production/u);
  assert.match(execution, /ATRINIK_PRODUCTION_RECOVERY_PUBLIC_KEY: \$\{\{ vars\.ATRINIK_PRODUCTION_RECOVERY_PUBLIC_KEY \}\}/u);
  const action = await readFile(new URL("../.github/actions/promote-production/action.yml", import.meta.url), "utf8");
  assert.match(action, /using: node24/u);
  assert.match(action, /main: \.\.\/\.\.\/\.\.\/scripts\/production-promotion-action\.mjs/u);
  const entry = await readFile(new URL("./production-promotion-action.mjs", import.meta.url), "utf8");
  assert.match(entry, /import \{ runPromotionDelivery \} from "\.\/production-promotion\.mjs"/u);
  assert.match(entry, /process\.exitCode = await runPromotionDelivery\(\)/u);
  assert.doesNotMatch(execution, /npm (?:ci|run check)/u);
  assert.match(promotion, /path: controller/u);
  assert.match(promotion, /path: selected/u);
  assert.doesNotMatch(workflow, /ref: \$\{\{ inputs\.source_sha \}\}/u);
  for (const job of [validation, promotion]) {
    assert.match(job, /package-manager-cache: false/u);
    assert.match(job, /ref: \$\{\{ steps\.source\.outputs\.source_sha \}\}/u);
    const preflight = job.indexOf("run: node controller/scripts/production-promotion.mjs --validate-source");
    assert(preflight >= 0 && preflight < job.indexOf("path: selected"));
    assert(preflight < job.indexOf("run: npm install"));
  }
  assert.doesNotMatch(promotion, /contents: write|id-token: write/u);
});

test("retirement handoff refreshes full source authority without repeating the slow provider sweep", async () => {
  for (const change of [
    f => { f.evidence.tagSha = controller; },
    f => { f.evidence.run.status = "completed"; f.evidence.run.conclusion = "cancelled"; },
    f => { f.evidence.actorPermission.permission = "read"; },
  ]) {
    const f = fixture(); let sweeps = 0;
    const authority = await createProductionAuthority({ environment: f.environment, checkoutHead: source, dirty: false,
      readEvent: async () => JSON.stringify(f.event), fetcher: fakeFetch(f), now: () => now,
      writerFence: async () => { sweeps++; } });
    await authority.authorize(); assert.equal(sweeps, 1);
    change(f); let writes = 0;
    await assert.rejects(async () => { await authority.authorize(); writes++; });
    assert.equal(writes, 0); assert.equal(sweeps, 1);
  }
});
