import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  ReviewEnvironmentError,
  validateAutomaticReview,
  validateCheckedInContract,
  validateContract,
  validateLiveApproval,
  validateProductionIsolation,
  validateSourceCoordinates,
} from "./review-environment.mjs";

const root = resolve(import.meta.dirname, "..");
const review = JSON.parse(await readFile(resolve(root, "deployment/workers-builds-review.json"), "utf8"));
const production = JSON.parse(await readFile(resolve(root, "deployment/workers-builds-production.json"), "utf8"));
const configurations = await Promise.all([
  "wrangler.jsonc", "wrangler.publisher.jsonc", "wrangler.rendezvous.jsonc",
].map(async (path) => JSON.parse(await readFile(resolve(root, path), "utf8"))));

function changed(change) {
  const value = structuredClone(review);
  change(value);
  return value;
}

test("accepts the checked-in isolated review contract", async () => {
  assert.equal((await validateCheckedInContract()).selectedMode,
    "build-only-plus-explicit-reusable-live-canary");
});

test("reserves main exclusively for the production contract", () => {
  assert.equal(production.productionBranch, "main");
  assert.equal(production.deployCommand, "npm run deploy:production");
  assert.ok(review.automaticReview.previewBranchExcludes.includes("main"));
  assert.notEqual(review.liveCanary.productionBranch, "main");
  for (const candidate of [
    changed((value) => value.automaticReview.previewBranchExcludes = ["review-build-only-sentinel"]),
    changed((value) => value.liveCanary.productionBranch = "main"),
    changed((value) => value.automaticReview.productionDeployCommand = "npm run deploy:production"),
    changed((value) => value.automaticReview.accountBoundary.productionAccountReuse = true),
    changed((value) => value.automaticReview.maximumBuildMinutes = 60),
  ]) assert.throws(() => validateContract(candidate, production, configurations), ReviewEnvironmentError);
});

test("automatic review has no bindings, routes, secrets, or deployable version", () => {
  validateAutomaticReview(review.automaticReview);
  for (const mutate of [
    (value) => value.bindings.push("DB"),
    (value) => value.routes.push("review.example"),
    (value) => value.protectedInputs.push("CLOUDFLARE_API_TOKEN"),
    (value) => value.result.workerVersion = true,
    (value) => value.result.reviewUrl = "https://public.workers.dev",
  ]) {
    const value = structuredClone(review.automaticReview);
    mutate(value);
    assert.throws(() => validateAutomaticReview(value), ReviewEnvironmentError);
  }
});

test("same-repository non-main source coordinates are exact", () => {
  const valid = { branch: "feat/review-safe", sha: "a".repeat(40),
    buildUuid: "11111111-1111-4111-8111-111111111111", event: "push", fork: false };
  assert.deepEqual(validateSourceCoordinates(valid), {
    branch: valid.branch, sha: valid.sha, buildUuid: valid.buildUuid,
  });
  for (const patch of [
    { branch: "main" },
    { branch: "review-build-only-sentinel" },
    { branch: "../main" },
    { sha: "not-a-sha" },
    { buildUuid: "not-a-uuid" },
    { event: "pull_request" },
    { fork: true },
  ]) assert.throws(() => validateSourceCoordinates({ ...valid, ...patch }), ReviewEnvironmentError);
});

test("live review requires an explicit matching SHA and rejects forks/main", () => {
  const valid = { branch: "fix/live-proof", sha: "b".repeat(40), approvedSha: "b".repeat(40), fork: false };
  assert.deepEqual(validateLiveApproval(valid), { branch: valid.branch, sha: valid.sha });
  for (const patch of [
    { branch: "main" }, { branch: "review-live-canary-sentinel" },
    { approvedSha: "c".repeat(40) }, { fork: true },
  ]) assert.throws(() => validateLiveApproval({ ...valid, ...patch }), ReviewEnvironmentError);
});

test("rejects production Worker, D1, R2, analytics, rate, hostname, and binding reachability", () => {
  const injections = [
    (value) => value.liveCanary.resources.workers[0].name = production.workers[0].name,
    (value) => value.liveCanary.resources.d1.name = configurations[0].d1_databases[0].database_name,
    (value) => value.liveCanary.resources.r2[0].name = configurations[0].r2_buckets[0].bucket_name,
    (value) => value.liveCanary.resources.analytics[0].name = configurations[0].analytics_engine_datasets[0].dataset,
    (value) => value.liveCanary.resources.rateLimits[0].namespace = configurations[0].ratelimits[0].namespace_id,
    (value) => value.liveCanary.resources.hostnames.dynamic[0] = "publish.meta.atrinik.org",
    (value) => value.liveCanary.resources.workers[1].serviceBindings = ["COORDINATOR:atrinik-metaserver#PublisherCoordinator"],
  ];
  for (const inject of injections) {
    const value = changed(inject);
    assert.throws(() => validateProductionIsolation(value, production, configurations),
      /production identifier|production/u);
  }
});

test("requires every isolated owner, resource ceiling, circuit, and cleanup guard", () => {
  for (const candidate of [
    changed((value) => value.liveCanary.maximumConcurrentCohorts = 2),
    changed((value) => value.liveCanary.maximumLiveWindowMinutes = 60),
    changed((value) => value.liveCanary.accountBoundary.productionAccountReuse = true),
    changed((value) => value.liveCanary.resourceCeilings.rateLimitNamespaces = 4),
    changed((value) => value.liveCanary.resources.rendezvousClientRateLimit.productionNamespaceReuse = true),
    changed((value) => value.liveCanary.resources.secrets.productionValueReuse = true),
    changed((value) => value.liveCanary.resources.hostnames.productionDnsAuthority = true),
    changed((value) => value.liveCanary.resources.observability.destinations = ["production-tail"]),
    changed((value) => value.liveCanary.dataPolicy.productionCopies = true),
    changed((value) => value.liveCanary.cleanup.guards.pop()),
  ]) assert.throws(() => validateContract(candidate, production, configurations), ReviewEnvironmentError);
});

test("defines executable migration, fixture, binding, stale, canary, and cleanup boundaries", () => {
  const plan = review.liveCanary.testPlan;
  for (const required of ["migration", "fixture", "service-bindings", "stale", "canaries", "expire"])
    assert.ok(plan.some((step) => step.includes(required)), `missing ${required} step`);
  assert.equal(review.liveCanary.cleanup.partialFailure,
    "stop-record-completed-prefix-leave-circuits-disabled-retry-from-readback");
  assert.equal(review.liveCanary.cleanup.automaticOnBranchEvent, false);
});

test("documents reviewer events and never falls through during provider outage", () => {
  const behavior = review.reviewerBehavior;
  for (const key of ["sameRepositoryPullRequest", "forkPullRequest", "rebaseOrForcePush", "rename",
    "mergeOrClose", "reopen", "overlap", "providerOutage", "manualEscape", "commentPolicy", "logPolicy"])
    assert.equal(typeof behavior[key], "string");
  assert.match(behavior.providerOutage, /no-production-fallback/u);
  assert.match(behavior.commentPolicy, /no-privileged-github-actions/u);
});
