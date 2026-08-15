import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  ReviewEnvironmentError,
  describeBranchCheckFailure,
  materializeReviewConfiguration,
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
const coordinationSchema = await readFile(resolve(root, "deployment/review-coordination-v1.sql"), "utf8");
const coordinationOperations = JSON.parse(await readFile(resolve(root,
  "deployment/review-coordination-operations-v1.json"), "utf8"));

function changed(change) {
  const value = structuredClone(review);
  change(value);
  return value;
}

test("accepts the checked-in isolated review contract", async () => {
  assert.equal((await validateCheckedInContract()).selectedMode,
    "single-connection-build-only-plus-operator-live-canary");
});

test("reserves main exclusively for the production contract", () => {
  assert.equal(production.productionBranch, "main");
  assert.equal(production.deployCommand, "npm run deploy:production");
  assert.ok(review.automaticReview.previewBranchExcludes.includes("main"));
  assert.equal(review.liveCanary.source.branch, "same-repository-non-main");
  for (const candidate of [
    changed((value) => value.automaticReview.previewBranchExcludes = []),
    changed((value) => value.liveCanary.source.branch = "main"),
    changed((value) => value.automaticReview.productionDeployCommand = "npm run review:validate"),
    changed((value) => value.automaticReview.accountBoundary.productionAccountReuse = false),
    changed((value) => value.automaticReview.accountBoundary.buildIdentityProductionProjectSettingsReachable = true),
    changed((value) => value.automaticReview.providerBuildTimeoutMinutes = 30),
    changed((value) => value.automaticReview.checkCommandTimeoutMinutes = 20),
  ]) assert.throws(() => validateContract(candidate, production, configurations), ReviewEnvironmentError);
});

test("automatic review has no bindings, routes, secrets, or deployable version", () => {
  validateAutomaticReview(review.automaticReview);
  for (const mutate of [
    (value) => value.bindings.push("DB"),
    (value) => value.routes.push("review.example"),
    (value) => value.protectedInputs.push("CLOUDFLARE_API_TOKEN"),
    (value) => value.result.branchCreatesWorkerVersion = true,
    (value) => value.result.reviewUrl = "https://public.workers.dev",
    (value) => value.tokenAuthority.accountPermissions.push("Workers Scripts:Read"),
    (value) => value.tokenAuthority.productionRead = true,
    (value) => value.bootstrap.workersDev = true,
    (value) => value.bootstrap.configSha256 = "0".repeat(64),
    (value) => value.costPolicy.maximumMonthlyReviewBuildMinutes = 3000,
    (value) => value.controlPlaneOperator.credentialBuildReadable = true,
    (value) => value.controlPlaneOperator.guards.pop(),
  ]) {
    const value = structuredClone(review.automaticReview);
    mutate(value);
    assert.throws(() => validateAutomaticReview(value), ReviewEnvironmentError);
  }
});

test("same-repository non-main source coordinates are exact", () => {
  const valid = { branch: "feat/review-safe", sha: "a".repeat(40),
    buildUuid: "11111111-1111-4111-8111-111111111111" };
  assert.deepEqual(validateSourceCoordinates(valid), {
    branch: valid.branch, sha: valid.sha, buildUuid: valid.buildUuid,
  });
  for (const patch of [
    { branch: "main" },
    { branch: "review-build-only-sentinel" },
    { branch: "../main" },
    { sha: "not-a-sha" },
    { buildUuid: "not-a-uuid" },
  ]) assert.throws(() => validateSourceCoordinates({ ...valid, ...patch }), ReviewEnvironmentError);
});

test("live review requires an exact clean GitHub SHA", () => {
  const valid = { branch: "fix/live-proof", sha: "b".repeat(40),
    runUuid: "22222222-2222-4222-8222-222222222222", githubMatches: true,
    checkoutClean: true, mainReachable: false };
  assert.deepEqual(validateLiveApproval(valid), {
    branch: valid.branch, sha: valid.sha, runUuid: valid.runUuid,
  });
  for (const patch of [
    { branch: "main" },
    { branch: "review-build-only-sentinel" },
    { sha: "not-a-sha" }, { runUuid: "not-a-uuid" },
    { runUuid: "22222222-2222-1222-8222-222222222222" },
    { runUuid: "22222222-2222-4222-7222-222222222222" },
    { githubMatches: false }, { checkoutClean: false }, { mainReachable: true },
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
    changed((value) => value.liveCanary.maximumMutationMinutes = 20),
    changed((value) => value.liveCanary.stalePolicy.failSafeClosure = "requires-live-lease"),
    changed((value) => value.liveCanary.stalePolicy.boundedRuntimeCleanup = "unbounded-alarm"),
    changed((value) => value.liveCanary.accountBoundary.productionAccountReuse = true),
    changed((value) => value.liveCanary.credentialBoundary.productionAccount = true),
    changed((value) => value.liveCanary.resourceCeilings.rateLimitNamespaces = 4),
    changed((value) => value.liveCanary.resources.rendezvousClientRateLimit.productionNamespaceReuse = true),
    changed((value) => value.liveCanary.resources.secrets.productionValueReuse = true),
    changed((value) => value.liveCanary.resources.hostnames.productionDnsAuthority = true),
    changed((value) => value.liveCanary.resources.observability.destinations = ["production-tail"]),
    changed((value) => value.liveCanary.access.policy.decision = "allow"),
    changed((value) => value.liveCanary.access.serviceToken.duration = "forever"),
    changed((value) => value.liveCanary.configurationMaterialization.core.workersDev = false),
    changed((value) => value.liveCanary.dataPolicy.productionCopies = true),
    changed((value) => value.liveCanary.dataPolicy.rendezvousReplayValidityHours = 25),
    changed((value) => value.liveCanary.cleanup.guards.pop()),
    changed((value) => value.liveCanary.resources.analytics[0].owner = "publisher"),
    changed((value) => value.liveCanary.resources.analytics[0].binding = "WRONG"),
    changed((value) => value.liveCanary.resources.coordinationD1.columns.pop()),
    changed((value) => value.liveCanary.resources.coordinationD1.acquire = "unfenced-insert"),
    changed((value) => value.liveCanary.resources.rateLimits[0].namespaceId = "review-rate-name"),
    changed((value) => value.liveCanary.resources.rateLimits[0].simple.limit = 99),
    changed((value) => value.liveCanary.resources.rateLimits[0].owner = "rendezvous"),
    changed((value) => value.liveCanary.resources.rateLimits[0].binding = "WRONG"),
    changed((value) => value.liveCanary.resources.rendezvousClientRateLimit.owner = "core"),
    changed((value) => value.liveCanary.resources.rendezvousClientRateLimit.binding = "WRONG"),
  ]) assert.throws(() => validateContract(candidate, production, configurations), ReviewEnvironmentError);
});

test("materializes every role circuit for closed and live-window stages", () => {
  const roles = ["core", "publisher", "rendezvous"];
  const outside = roles.map((role, index) => materializeReviewConfiguration(
    configurations[index], role, review.liveCanary.configurationMaterialization, false));
  const inside = roles.map((role, index) => materializeReviewConfiguration(
    configurations[index], role, review.liveCanary.configurationMaterialization, true));
  assert.deepEqual(outside.map(({ vars }) => [vars.PUBLISH_ENABLED, vars.GAME_PUBLISH_ENABLED,
    vars.RENDEZVOUS_ENABLED]), [
    ["disabled", "disabled", "disabled"], ["disabled", "disabled", undefined],
    [undefined, undefined, "disabled"],
  ]);
  assert.deepEqual(inside.map(({ vars }) => [vars.PUBLISH_ENABLED, vars.GAME_PUBLISH_ENABLED,
    vars.RENDEZVOUS_ENABLED]), [
    ["enabled", "enabled", "enabled"], ["enabled", "enabled", undefined],
    [undefined, undefined, "enabled"],
  ]);
  assert.equal(inside[1].services[0].service, "atrinik-metaserver-review-canary");
  assert.equal(inside[2].services[0].service, "atrinik-metaserver-review-canary");
});

test("coordination SQL enforces acquisition, generation, state, expiry, and release CAS", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(coordinationSchema);
  const statements = Object.fromEntries(Object.entries(coordinationOperations.statements)
    .map(([name, sql]) => [name, database.prepare(sql)]));
  const shaA = "a".repeat(40);
  const shaB = "b".repeat(40);
  const runA = "11111111-1111-4111-8111-111111111111";
  const runB = "22222222-2222-4222-8222-222222222222";
  const namespaceA = `review-canary-fixture-${shaA}-${runA}`;
  const namespaceB = `review-canary-fixture-${shaB}-${runB}`;
  assert.equal(statements.acquireFresh.all(shaA, runA, namespaceA, 1800).length, 1);
  assert.equal(statements.acquireFresh.all(shaB, runB, namespaceB, 1800).length, 0);
  assert.equal(statements.enable.all(runA, 1).length, 1);
  assert.equal(statements.renew.all(runA, 0, 1800).length, 0);
  const renewed = statements.renew.all(runA, 1, 1800);
  assert.equal(renewed[0].lease_generation, 2);
  assert.equal(statements.release.all(runA, 2).length, 0);
  assert.equal(statements.beginDrain.all(runA, 2).length, 1);
  assert.equal(statements.proveDisabled.all(runA, 2).length, 1);
  assert.equal(statements.release.all(runA, 1).length, 0);
  assert.equal(statements.release.all(runA, 2).length, 1);
  assert.throws(() => statements.acquireFresh.all(shaA, "not-a-valid-uuid-value-at-all-000000", namespaceA, 1800));
  const shortHex = "11111111-1111-4111-8111-11111111111-";
  assert.throws(() => statements.acquireFresh.all(shaA, shortHex,
    `review-canary-fixture-${shaA}-${shortHex}`, 1800));
  const leadingExtraHyphen = "-1111111-1111-4111-8111-111111111111";
  assert.throws(() => statements.acquireFresh.all(shaA, leadingExtraHyphen,
    `review-canary-fixture-${shaA}-${leadingExtraHyphen}`, 1800));
  const wrongVersion = "11111111-1111-1111-8111-111111111111";
  assert.throws(() => statements.acquireFresh.all(shaA, wrongVersion,
    `review-canary-fixture-${shaA}-${wrongVersion}`, 1800));
  const wrongVariant = "11111111-1111-4111-7111-111111111111";
  assert.throws(() => statements.acquireFresh.all(shaA, wrongVariant,
    `review-canary-fixture-${shaA}-${wrongVariant}`, 1800));
  assert.equal(statements.acquireFresh.all(shaA, runA, namespaceA, 1801).length, 0);
  assert.equal(statements.acquireFresh.all(shaA, runA, namespaceA, 1).length, 0);
  assert.equal(coordinationOperations.leaseDurationSeconds, 1800);
  assert.equal(coordinationOperations.maximumLeaseProofAgeSeconds, 5);
  assert.equal(coordinationOperations.maximumForwardMutationSeconds, 120);
  assert.equal(coordinationOperations.minimumRecoveryReserveSeconds, 300);
  assert.ok(coordinationOperations.maximumLeaseProofAgeSeconds +
    coordinationOperations.maximumForwardMutationSeconds +
    coordinationOperations.minimumRecoveryReserveSeconds <
    coordinationOperations.leaseDurationSeconds);
  assert.equal(statements.acquireFresh.all(shaA, runA, namespaceA, 1800).length, 1);
  assert.equal(statements.renew.all(runA, 1, 1).length, 0);
  assert.equal(statements.enable.all(runA, 1).length, 1);
  database.exec("UPDATE review_runs SET lease_expires_at = unixepoch() - 1");
  assert.equal(statements.reclaimExpired.all(shaB, runB, namespaceB, 1800).length, 0);
  assert.equal(statements.proveDisabled.all(runA, 1).length, 1);
  const reclaimed = statements.reclaimExpired.all(shaB, runB, namespaceB, 1800);
  assert.equal(reclaimed.length, 1);
  assert.equal(reclaimed[0].run_uuid, runB);
  assert.equal(reclaimed[0].lease_generation, 2);
  database.close();
});

test("defines executable migration, fixture, binding, stale, canary, and cleanup boundaries", () => {
  const plan = review.liveCanary.testPlan;
  for (const required of ["migration", "fixture", "service-bindings", "loss", "canaries", "drain"])
    assert.ok(plan.some((step) => step.includes(required)), `missing ${required} step`);
  assert.equal(review.liveCanary.cleanup.partialFailure,
    "stop-record-completed-prefix-leave-circuits-disabled-retry-from-readback");
  assert.equal(review.liveCanary.cleanup.automaticOnBranchEvent, false);
});

test("branch diagnostics identify a bounded stage without exposing output", () => {
  const secret = "never-emit-this-value";
  const exit = describeBranchCheckFailure("typecheck", {
    code: 2, stdout: `compiler output ${secret}`, stderr: "failed",
  });
  assert.match(exit, /stage typecheck failed: kind=exit code=2/u);
  assert.match(exit, /stdoutBytes=37 stderrBytes=6/u);
  assert.doesNotMatch(exit, new RegExp(secret, "u"));
  assert.match(describeBranchCheckFailure("test", { killed: true }), /kind=timeout/u);
  assert.match(describeBranchCheckFailure("test:admin", {
    code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
  }), /kind=output-limit/u);
  assert.match(describeBranchCheckFailure("deploy:dry-run", { signal: "SIGTERM" }), /kind=signal/u);
  assert.throws(() => describeBranchCheckFailure("arbitrary-command", {}), ReviewEnvironmentError);
});

test("documents reviewer events and never falls through during provider outage", () => {
  const behavior = review.reviewerBehavior;
  for (const key of ["sameRepositoryPullRequest", "forkPullRequest", "rebaseOrForcePush", "rename",
    "mergeOrClose", "reopen", "overlap", "providerOutage", "manualEscape", "commentPolicy", "logPolicy"])
    assert.equal(typeof behavior[key], "string");
  assert.match(behavior.providerOutage, /no-production-fallback/u);
  assert.match(behavior.commentPolicy, /no-privileged-github-actions/u);
});
