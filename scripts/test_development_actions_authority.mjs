// Copyright (C) 2026 Atrinik contributors
import assert from "node:assert/strict";
import test from "node:test";
import { createDevelopmentAuthority, validateDevelopmentContext,
  validateDevelopmentEvidence } from "./development-actions-authority.mjs";
import { deliveryFailureReason } from "./delivery-failure-reasons.mjs";
const sha = "a".repeat(40);
const repository = { full_name: "atrinik/metaserver-worker" };
const now = Date.parse("2026-10-11T12:00:00Z");
function fixture() {
  const environment = { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "workflow_run",
    GITHUB_REPOSITORY: repository.full_name, GITHUB_REF: "refs/heads/main", GITHUB_RUN_ID: "12",
    GITHUB_RUN_ATTEMPT: "1", GITHUB_SHA: sha, GITHUB_WORKFLOW_SHA: sha,
    GITHUB_WORKFLOW_REF: `${repository.full_name}/.github/workflows/deploy-development.yml@refs/heads/main`,
    ATRINIK_DEVELOPMENT_SHA: sha };
  const check = { id: 11, path: ".github/workflows/check.yml", event: "push", head_branch: "main",
    head_sha: sha, status: "completed", conclusion: "success", repository, head_repository: repository,
    updated_at: "2026-10-11T11:57:00Z" };
  const run = { id: 12, run_attempt: 1, event: "workflow_run", head_branch: "main", head_sha: sha,
    path: ".github/workflows/deploy-development.yml", status: "in_progress", conclusion: null,
    repository, head_repository: repository, created_at: "2026-10-11T11:58:00Z" };
  const event = { repository, action: "completed", workflow_run: check };
  const evidence = { repo: { ...repository, fork: false, default_branch: "main" },
    branch: { name: "main", protected: true, commit: { sha } }, run, check,
    jobs: [{ name: "verify", run_id: 11, head_sha: sha, status: "completed", conclusion: "success" }],
    deployJobs: [{ name: "deploy", run_id: 12, head_sha: sha, status: "in_progress", conclusion: null }],
    activeRuns: [run], protection: { name: "development",
      deployment_branch_policy: { protected_branches: true, custom_branch_policies: false } } };
  return { environment, event, evidence };
}

test("DEV requires exact successful same-repository current-main workflow identity", () => {
  const { environment, event, evidence } = fixture();
  assert.equal(validateDevelopmentContext(environment, event, sha, false), sha);
  assert.doesNotThrow(() => validateDevelopmentEvidence(environment, event, evidence, now));
  for (const change of [
    (value) => { value.GITHUB_EVENT_NAME = "push"; },
    (value) => { value.GITHUB_RUN_ATTEMPT = "2"; },
    (value) => { value.GITHUB_REPOSITORY = "fork/metaserver-worker"; },
    (value) => { value.GITHUB_SHA = "b".repeat(40); },
  ]) {
    const bad = structuredClone(environment); change(bad);
    assert.throws(() => validateDevelopmentContext(bad, event, sha, false));
  }
  assert.throws(() => validateDevelopmentContext(environment, event, sha, true));
});

test("DEV rejects supersession, forged Check success, competing writers and stale runs", () => {
  const { environment, event, evidence } = fixture();
  for (const change of [
    (value) => { value.branch.commit.sha = "b".repeat(40); },
    (value) => { value.branch.protected = false; },
    (value) => { value.check.path = ".github/workflows/other.yml"; },
    (value) => { value.check.head_repository = { full_name: "fork/metaserver-worker" }; },
    (value) => { value.jobs[0].conclusion = "failure"; },
    (value) => { value.jobs.push({ ...value.jobs[0] }); },
    (value) => { value.activeRuns.push({ ...value.run, id: 13 }); },
    (value) => { value.deployJobs[0].status = "completed"; },
    (value) => { value.run.created_at = "2026-10-11T09:00:00Z"; },
    (value) => { value.protection.deployment_branch_policy.protected_branches = false; },
  ]) {
    const bad = structuredClone(evidence); change(bad);
    assert.throws(() => validateDevelopmentEvidence(environment, event, bad, now));
  }
});

test("DEV authority rejections carry only their fixed branded reason", () => {
  const { environment, event, evidence } = fixture();
  const reason = (action) => {
    try { action(); } catch (error) { return deliveryFailureReason(error); }
    assert.fail("expected rejection");
  };
  assert.equal(reason(() => validateDevelopmentContext(environment, event, sha, true)),
    "development-authority-context-rejected");
  for (const [expected, change] of [
    ["development-authority-run-fence-rejected", (value) => { value.branch.commit.sha = "b".repeat(40); }],
    ["development-authority-check-rejected", (value) => { value.jobs[0].conclusion = "failure"; }],
    ["development-authority-concurrent-writer", (value) => { value.activeRuns.push({ ...value.run, id: 13 }); }],
    ["development-authority-environment-rejected", (value) => { value.protection.name = "production"; }],
  ]) {
    const bad = structuredClone(evidence); change(bad);
    assert.equal(reason(() => validateDevelopmentEvidence(environment, event, bad, now)), expected);
  }
});

test("local and fork attempts fail before GitHub or provider reads", async () => {
  let called = false;
  await assert.rejects(createDevelopmentAuthority({ environment: {}, checkoutHead: sha, dirty: false,
    readEvent: async () => JSON.stringify(fixture().event),
    fetcher: async () => { called = true; throw new Error("unexpected read"); },
    writerFence: async () => { called = true; },
  }));
  assert.equal(called, false);
});

test("each DEV fence refreshes main after provider readback and refuses superseded source", async () => {
  const { environment, event, evidence } = fixture();
  environment.GITHUB_TOKEN = "test-only";
  let writerChecks = 0;
  const fetcher = async (url) => {
    const path = new URL(url).pathname.replace(`/repos/${repository.full_name}`, "");
    const routes = {
      "": evidence.repo, "/branches/main": evidence.branch, "/actions/runs/12": evidence.run,
      "/actions/runs/11": evidence.check, "/actions/runs/11/jobs": { total_count: 1, jobs: evidence.jobs },
      "/actions/runs/12/attempts/1/jobs": { total_count: 1, jobs: evidence.deployJobs },
      "/actions/workflows/deploy-development.yml/runs": { total_count: 1, workflow_runs: evidence.activeRuns },
      "/environments/development": evidence.protection,
    };
    assert.ok(Object.hasOwn(routes, path), path);
    return Response.json(routes[path]);
  };
  const authority = await createDevelopmentAuthority({ environment, checkoutHead: sha, dirty: false,
    readEvent: async () => JSON.stringify(event), fetcher, now: () => now,
    writerFence: async () => { writerChecks += 1; } });
  assert.equal(writerChecks, 1);
  await authority.fence(); assert.equal(writerChecks, 2);
  evidence.branch.commit.sha = "b".repeat(40);
  await assert.rejects(authority.fence(), /newest-main/u);
  assert.equal(writerChecks, 3);
});

test("slow provider writer readback cannot carry DEV authority past its deadline", async () => {
  const { environment, event, evidence } = fixture();
  environment.GITHUB_TOKEN = "test-only";
  let clock = Date.parse(evidence.run.created_at) + 59 * 60_000 + 59_000;
  const fetcher = async (url) => {
    const path = new URL(url).pathname.replace(`/repos/${repository.full_name}`, "");
    const routes = {
      "": evidence.repo, "/branches/main": evidence.branch, "/actions/runs/12": evidence.run,
      "/actions/runs/11": evidence.check, "/actions/runs/11/jobs": { total_count: 1, jobs: evidence.jobs },
      "/actions/runs/12/attempts/1/jobs": { total_count: 1, jobs: evidence.deployJobs },
      "/actions/workflows/deploy-development.yml/runs": { total_count: 1, workflow_runs: evidence.activeRuns },
      "/environments/development": evidence.protection,
    };
    return Response.json(routes[path]);
  };
  await assert.rejects(createDevelopmentAuthority({ environment, checkoutHead: sha, dirty: false,
    readEvent: async () => JSON.stringify(event), fetcher, now: () => clock,
    writerFence: async () => { clock += 2000; } }), /freshness/u);
});

function authorityFetch(evidence) {
  return async url => {
    const path = new URL(url).pathname.replace(`/repos/${repository.full_name}`, "");
    const routes = {
      "": evidence.repo, "/branches/main": evidence.branch, "/actions/runs/12": evidence.run,
      "/actions/runs/11": evidence.check, "/actions/runs/11/jobs": { total_count: 1, jobs: evidence.jobs },
      "/actions/runs/12/attempts/1/jobs": { total_count: 1, jobs: evidence.deployJobs },
      "/actions/workflows/deploy-development.yml/runs": { total_count: 1, workflow_runs: evidence.activeRuns },
      "/environments/development": evidence.protection,
    };
    return Response.json(routes[path]);
  };
}
test("DEV propagates drain completion and supports a strict final authority pass", async () => {
  const { environment, event, evidence } = fixture(); environment.GITHUB_TOKEN = "test-only";
  const seen = [];
  const authority = await createDevelopmentAuthority({ environment, checkoutHead: sha, dirty: false,
    readEvent: async () => JSON.stringify(event), fetcher: authorityFetch(evidence), now: () => now,
    writerFence: async (_input, options) => { seen.push(options.allowDrain); return { waited: options.allowDrain }; } });
  assert.deepEqual(await authority.fence(), { waited: true });
  assert.deepEqual(await authority.fence({ allowDrain: false }), { waited: false });
  assert.deepEqual(seen, [true, true, false]);
});
for (const [name, change] of [
  ["main", value => { value.branch.commit.sha = "b".repeat(40); }],
  ["run", value => { value.run.status = "completed"; }],
  ["Check source", value => { value.check.head_sha = "b".repeat(40); }],
  ["protection", value => { value.protection.deployment_branch_policy.protected_branches = false; }],
]) test(`DEV ${name} drift during drain blocks the mutation handoff`, async () => {
  const { environment, event, evidence } = fixture(); environment.GITHUB_TOKEN = "test-only";
  let draining = false, clock = now, mutations = 0;
  const authority = await createDevelopmentAuthority({ environment, checkoutHead: sha, dirty: false,
    readEvent: async () => JSON.stringify(event), fetcher: authorityFetch(evidence), now: () => clock,
    writerFence: async () => {
      if (draining) { clock += 5000; change(evidence); }
      return { waited: draining };
    } });
  draining = true;
  await assert.rejects(async () => { await authority.fence(); mutations++; });
  assert.equal(mutations, 0);
});
