import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { promisify } from "node:util";
import {
  ReviewEnvironmentError,
  describeBranchCheckFailure,
  materializeReviewConfiguration,
  validateAutomaticReview,
  validateCheckedInContract,
  validateContract,
  validateLiveApproval,
  validateProductionIsolation,
  validateReviewBuildEntrypoint,
  validateReviewRootEntrypoint,
  validateSourceCoordinates,
} from "./review-environment.mjs";

const root = resolve(import.meta.dirname, "..");
const execFileAsync = promisify(execFile);
const review = JSON.parse(await readFile(resolve(root, "deployment/workers-builds-review.json"), "utf8"));
const production = JSON.parse(await readFile(resolve(root, "deployment/workers-builds-production.json"), "utf8"));
const configurations = await Promise.all([
  "wrangler.jsonc", "wrangler.publisher.jsonc", "wrangler.rendezvous.jsonc",
].map(async (path) => JSON.parse(await readFile(resolve(root, path), "utf8"))));
const coordinationSchema = await readFile(resolve(root, "deployment/review-coordination-v1.sql"), "utf8");
const coordinationOperations = JSON.parse(await readFile(resolve(root,
  "deployment/review-coordination-operations-v1.json"), "utf8"));
const reviewRootPackage = JSON.parse(await readFile(resolve(root,
  "deployment/review-check/package.json"), "utf8"));

function changed(change) {
  const value = structuredClone(review);
  change(value);
  return value;
}

test("accepts the checked-in isolated review contract", async () => {
  assert.equal((await validateCheckedInContract()).selectedMode,
    "single-core-project-production-plus-build-only-preview-trigger");
});

test("reserves main exclusively for the production contract", () => {
  assert.equal(production.productionBranch, "main");
  assert.equal(production.deployCommand, "npm run deploy:production");
  assert.ok(review.automaticReview.previewBranchExcludes.includes("main"));
  assert.equal(review.liveCanary.source.branch, "same-repository-non-main");
  for (const candidate of [
    changed((value) => value.automaticReview.previewBranchExcludes = []),
    changed((value) => value.liveCanary.source.branch = "main"),
    changed((value) => value.automaticReview.buildCommand = "cd ../.. && npm run review:build"),
    changed((value) => value.automaticReview.deployCommand = "cd ../.. && npm run review:validate"),
    changed((value) => value.automaticReview.accountBoundary.productionAccountReuse = false),
    changed((value) => value.automaticReview.rootDirectory = "deployment/review-check"),
    changed((value) => value.automaticReview.accountBoundary.buildIdentityProductionTriggerEnvironmentReachable = true),
    changed((value) => value.automaticReview.providerTopology.mode = "two-workers"),
    changed((value) => value.automaticReview.providerTopology.maximumTriggersPerWorker = 1),
    changed((value) => value.automaticReview.project = "atrinik-metaserver-review-check"),
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
    (value) => value.membershipReadRepair.requiredUserPermissions.pop(),
    (value) => value.membershipReadRepair.accountOwnedTokenSupported = true,
    (value) => value.membershipReadRepair.wrapperMutation = false,
    (value) => value.membershipSecretRecovery.requiredUserPermissions.pop(),
    (value) => value.membershipSecretRecovery.lostTokenId = "0".repeat(32),
    (value) => value.tokenAuthority.productionRead = true,
    (value) => value.localValidation.workersDev = true,
    (value) => value.localValidation.configSha256 = "0".repeat(64),
    (value) => value.costPolicy.maximumMonthlyReviewBuildMinutes = 3000,
    (value) => value.controlPlaneOperator.credentialBuildReadable = true,
    (value) => value.controlPlaneOperator.guards.pop(),
  ]) {
    const value = structuredClone(review.automaticReview);
    mutate(value);
    assert.throws(() => validateAutomaticReview(value), ReviewEnvironmentError);
  }
});

test("review trigger delegates to the exact sanitized repository entrypoint", () => {
  assert.equal(Buffer.byteLength(review.automaticReview.buildCommand, "utf8"), 13);
  assert.equal(review.automaticReview.buildCommand, "npm run build");
  validateReviewRootEntrypoint(reviewRootPackage);
  for (const mutate of [
    (value) => value.scripts.build = "cd ../.. && npm run review:build",
    (value) => value.scripts.validate = "npm run review:validate",
    (value) => value.scripts["reject-sentinel"] = "true",
    (value) => value.private = false,
  ]) {
    const value = structuredClone(reviewRootPackage);
    mutate(value);
    assert.throws(() => validateReviewRootEntrypoint(value), ReviewEnvironmentError);
  }
  const valid = { "review:build": `${production.installCommand} && npm run review:branch` };
  validateReviewBuildEntrypoint(valid, production);
  assert.match(production.installCommand,
    /env -i HOME="\$HOME" PATH="\$PATH"/u);
  for (const command of [
    "npm ci --ignore-scripts && npm run review:branch",
    `${production.installCommand} && npm run review:validate`,
    `${production.installCommand.replace("env -i ", "")} && npm run review:branch`,
  ]) assert.throws(() => validateReviewBuildEntrypoint({ "review:build": command }, production),
    ReviewEnvironmentError);
  const tooLong = structuredClone(review.automaticReview);
  tooLong.buildCommand = `npm run build ${"x".repeat(64)}`;
  assert.throws(() => validateAutomaticReview(tooLong), ReviewEnvironmentError);
});

test("review-root package delegates validation and sentinel rejection", async () => {
  const reviewRoot = resolve(root, "deployment/review-check");
  const childEnvironment = { ...process.env };
  delete childEnvironment.NODE_TEST_CONTEXT;
  const validated = await execFileAsync("npm", ["run", "validate"],
    { cwd: reviewRoot, encoding: "utf8", env: childEnvironment });
  assert.match(validated.stdout, /"outcome":"review-contract-valid"/u);
  await assert.rejects(execFileAsync("npm", ["run", "reject-sentinel"],
    { cwd: reviewRoot, encoding: "utf8", env: childEnvironment }), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /"reason":"reserved review sentinel never executes repository code"/u);
    return true;
  });
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
    changed((value) => value.liveCanary.resources.coordinationD1.controlColumns.pop()),
    changed((value) => value.liveCanary.resources.coordinationD1.acquire = "unfenced-insert"),
    changed((value) => value.liveCanary.resources.coordinationD1.quiesce = "delete-live-row"),
    changed((value) => value.liveCanary.resources.coordinationD1.teardownRecovery = "release-unexpired"),
    changed((value) => value.liveCanary.resources.coordinationD1.teardown = "delete-with-live-runner"),
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
  assert.equal(coordinationOperations.minimumQuiesceSeconds, 425);
  assert.equal(coordinationOperations.minimumDisabledDrainSeconds, 60);
  assert.deepEqual(coordinationOperations.operationActors.cleanupOperatorOnly,
    ["beginQuiesce", "proveDisabledExpiredForTeardown", "releaseExpiredForTeardown", "beginTeardown"]);
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
  const quiescing = statements.beginQuiesce.all();
  assert.equal(quiescing.length, 1);
  assert.equal(quiescing[0].mode, "quiescing");
  assert.equal(statements.renew.all(runB, 2, 1800).length, 0);
  assert.equal(statements.enable.all(runB, 2).length, 0);
  assert.equal(statements.acquireFresh.all(shaA, runA, namespaceA, 1800).length, 0);
  assert.equal(statements.releaseExpiredForTeardown.all(runB, 2).length, 0);
  assert.equal(statements.release.all(runB, 2).length, 1);
  assert.equal(statements.beginTeardown.all().length, 0);
  database.exec("UPDATE review_environment_control SET quiesced_at = unixepoch() - 425");
  const teardown = statements.beginTeardown.all();
  assert.equal(teardown.length, 1);
  assert.equal(teardown[0].mode, "teardown");
  assert.equal(statements.acquireFresh.all(shaA, runA, namespaceA, 1800).length, 0);
  assert.equal(statements.reclaimExpired.all(shaA, runA, namespaceA, 1800).length, 0);
  database.close();

  for (const abandonedState of ["disabled", "enabled", "draining"]) {
    const abandoned = new DatabaseSync(":memory:");
    abandoned.exec(coordinationSchema);
    const abandonedStatements = Object.fromEntries(Object.entries(coordinationOperations.statements)
      .map(([name, sql]) => [name, abandoned.prepare(sql)]));
    assert.equal(abandonedStatements.acquireFresh.all(shaA, runA, namespaceA, 1800).length, 1);
    if (abandonedState !== "disabled")
      assert.equal(abandonedStatements.enable.all(runA, 1).length, 1);
    if (abandonedState === "draining")
      assert.equal(abandonedStatements.beginDrain.all(runA, 1).length, 1);
    assert.equal(abandonedStatements.beginQuiesce.all().length, 1);
    abandoned.exec("UPDATE review_runs SET lease_expires_at = unixepoch() - 1");
    abandoned.exec("UPDATE review_environment_control SET quiesced_at = unixepoch() - 425");
    assert.equal(abandonedStatements.release.all(runA, 1).length, 0);
    if (abandonedState !== "disabled")
      assert.equal(abandonedStatements.releaseExpiredForTeardown.all(runA, 1).length, 0);
    const disabled = abandonedStatements.proveDisabledExpiredForTeardown.all(runA, 1);
    assert.equal(disabled.length, 1);
    assert.equal(disabled[0].state, "disabled");
    assert.equal(abandonedStatements.releaseExpiredForTeardown.all(runA, 1).length, 1);
    assert.equal(abandonedStatements.beginTeardown.all().length, 1);
    abandoned.close();
  }
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
