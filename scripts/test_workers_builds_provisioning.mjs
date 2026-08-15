import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  automaticReviewEnvironmentSpec,
  automaticReviewTriggerSpec,
  boundedResponseText,
  createPrivateDirectory,
  loadSnapshot,
  materializeProductionConfigurations,
  productionEnvironmentSpec,
  productionTriggerSpec,
  provisioningSetupPlan,
  readPrivateValue,
  validateAutomaticReviewEnvironment,
  validateBuildTokenInventory,
  validateCheckedInProvisioning,
  validateConfiguredBuildsSnapshot,
  validateFreshBuildsSnapshot,
  validateNoActiveBuilds,
  validateNoDeployHooks,
  validateProductionControlPlane,
  validateTriggerSnapshot,
} from "./workers-builds-provisioning.mjs";
import { validateBuildEnvironment } from "./production-delivery.mjs";

const root = resolve(import.meta.dirname, "..");
const production = JSON.parse(await readFile(resolve(root,
  "deployment/workers-builds-production.json"), "utf8"));
const review = JSON.parse(await readFile(resolve(root,
  "deployment/workers-builds-review.json"), "utf8"));
const bases = await Promise.all([
  "wrangler.jsonc", "wrangler.publisher.jsonc", "wrangler.rendezvous.jsonc",
].map(async (path) => JSON.parse(await readFile(resolve(root, path), "utf8"))));
const accountId = "a".repeat(32);
const scriptTag = "b".repeat(32);
const reviewScriptTag = "d".repeat(32);
const resourceUuid = "11111111-1111-4111-8111-111111111111";
const reviewTriggerUuid = "22222222-2222-4222-8222-222222222222";
const reviewTokenUuid = "33333333-3333-4333-8333-333333333333";

function envelope(result) {
  return { success: true, result };
}

function bindings(config) {
  return [
    ...Object.entries(config.vars ?? {}).map(([name, text]) => ({ name, type: "plain_text", text:
      name === "DIRECTORY_CACHE_ZONE_ID" ? "c".repeat(32) : text })),
    ...(config.secrets?.required ?? []).map((name) => ({ name, type: "secret_text" })),
    ...(config.d1_databases ?? []).map(({ binding: name }) => ({
      name, type: "d1", id: resourceUuid, database_id: resourceUuid,
    })),
    ...(config.r2_buckets ?? []).map(({ binding: name, bucket_name }) => ({
      name, type: "r2_bucket", bucket_name,
    })),
    ...(config.analytics_engine_datasets ?? []).map(({ binding: name, dataset }) => ({
      name, type: "analytics_engine", dataset,
    })),
    ...(config.ratelimits ?? []).map(({ name, namespace_id, simple }) => ({
      name, type: "ratelimit", namespace_id, simple,
    })),
    ...(config.durable_objects?.bindings ?? []).map(({ name, class_name }) => ({
      name, type: "durable_object_namespace", class_name, namespace_id: resourceUuid,
    })),
    ...(config.services ?? []).map(({ binding: name, service, entrypoint }) => ({
      name, type: "service", service, entrypoint, environment: "production",
    })),
  ];
}

function snapshot(config) {
  return {
    settings: envelope({ compatibility_date: config.compatibility_date,
      compatibility_flags: config.compatibility_flags ?? [], bindings: bindings(config),
      observability: config.observability }),
    subdomain: envelope({ enabled: false, previews_enabled: false }),
    schedules: envelope({ schedules: (config.triggers?.crons ?? []).map((cron) => ({ cron })) }),
    routes: envelope([]),
    scriptSettings: envelope({ logpush: null, tail_consumers: [] }),
  };
}

function triggerCoordinates() {
  return { externalScriptId: scriptTag, repositoryConnectionUuid: resourceUuid,
    buildTokenUuid: resourceUuid };
}

function withConnection(spec) {
  return { ...structuredClone(spec), trigger_uuid: resourceUuid, deleted_on: null,
    repo_connection: {
    repo_connection_uuid: spec.repo_connection_uuid, provider_type: "github",
    provider_account_id: "6371603", provider_account_name: "atrinik",
    repo_id: "1324297032", repo_name: "metaserver-worker",
  } };
}

function buildTokenInventory() {
  return envelope([
    { build_token_name: "Atrinik metaserver production", build_token_uuid: resourceUuid,
      cloudflare_token_id: "production-token-id", owner_type: "user" },
    { build_token_name: "Atrinik metaserver review check", build_token_uuid: reviewTokenUuid,
      cloudflare_token_id: "review-token-id", owner_type: "user" },
  ]);
}

test("accepts the checked-in provisioning composition", async () => {
  assert.equal((await validateCheckedInProvisioning()).production.productionBranch, "main");
});

test("enforces owner-only no-follow private inputs and snapshots", async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), "atrinik-builds-provisioning-"));
  await chmod(temporary, 0o700);
  try {
    const valuePath = resolve(temporary, "value");
    await writeFile(valuePath, "private-value\n", { mode: 0o600 });
    assert.equal(await readPrivateValue(valuePath, "test value"), "private-value");
    await chmod(valuePath, 0o640);
    await assert.rejects(readPrivateValue(valuePath, "test value"), /private regular file/u);
    await chmod(valuePath, 0o600);
    const linkedValue = resolve(temporary, "value-link");
    await symlink(valuePath, linkedValue);
    await assert.rejects(readPrivateValue(linkedValue, "test value"), /without following links/u);

    const snapshot = resolve(temporary, "snapshot");
    await mkdir(snapshot, { mode: 0o700 });
    const snapshotFile = resolve(snapshot, "provider.json");
    await writeFile(snapshotFile, '{"success":true,"result":[]}\n', { mode: 0o600 });
    assert.deepEqual(await loadSnapshot(snapshot, "provider.json"), {
      success: true, result: [],
    });
    await chmod(snapshotFile, 0o604);
    await assert.rejects(loadSnapshot(snapshot, "provider.json"), /bounded private regular file/u);

    const output = resolve(temporary, "new-output");
    await createPrivateDirectory(output);
    const outputMetadata = await lstat(output);
    assert.equal(outputMetadata.mode & 0o777, 0o700);
    await assert.rejects(createPrivateDirectory(output), /already exists/u);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("bounds provider response bodies before retaining them", async () => {
  assert.equal(await boundedResponseText(new Response("provider"), "test"), "provider");
  await assert.rejects(boundedResponseText(
    new Response("x".repeat(1024 * 1024 + 1)), "test"), /response limit/u);
});

test("materializes bounded production documents only from live private coordinates", () => {
  const snapshots = bases.map(snapshot);
  const configurations = materializeProductionConfigurations({
    contract: production, bases, snapshots, accountId,
  });
  assert.equal(configurations[0].account_id, accountId);
  assert.equal(configurations[0].d1_databases[0].database_id, resourceUuid);
  assert.equal(configurations[0].vars.DIRECTORY_CACHE_ZONE_ID, "c".repeat(32));
  assert.deepEqual(configurations[1].routes,
    [{ pattern: "publish.meta.atrinik.org", custom_domain: true }]);
  assert.deepEqual(configurations[2].routes,
    [{ pattern: "rendezvous.meta.atrinik.org", custom_domain: true }]);
  assert.equal(configurations[0].vars.PUBLISH_ENABLED, "disabled");

  for (const mutate of [
    (values) => values[0].subdomain.result.enabled = true,
    (values) => values[0].settings.result.bindings = values[0].settings.result.bindings
      .filter(({ name }) => name !== "SOURCE_TAG_KEY_CURRENT"),
    (values) => values[0].settings.result.bindings.push({
      name: "UNREVIEWED_DB", type: "d1", id: resourceUuid,
    }),
    (values) => one(values[0].settings.result.bindings, "PUBLISH_ENABLED").text = "typo",
    (values) => one(values[0].settings.result.bindings, "RENDEZVOUS").class_name = "WrongRoom",
    (values) => one(values[0].settings.result.bindings, "DB").id = "not-a-uuid",
    (values) => one(values[0].settings.result.bindings, "DB").database_id =
      "44444444-4444-4444-8444-444444444444",
    (values) => one(values[1].settings.result.bindings, "COORDINATOR").service = "atrinik-metaserver-wrong",
    (values) => one(values[1].settings.result.bindings, "COORDINATOR").environment = "preview",
    (values) => values[0].settings.result.compatibility_date = "2026-08-04",
  ]) {
    const changed = structuredClone(snapshots);
    mutate(changed);
    assert.throws(() => materializeProductionConfigurations({
      contract: production, bases, snapshots: changed, accountId,
    }));
  }
});

function one(values, name) {
  return values.find((value) => value.name === name);
}

test("validates production domains, schedules, and observability boundaries", () => {
  const snapshots = bases.map(snapshot);
  const configurations = materializeProductionConfigurations({
    contract: production, bases, snapshots, accountId,
  });
  const domains = envelope([
    { hostname: "publish.meta.atrinik.org", service: "atrinik-metaserver-publisher",
      zone_id: "c".repeat(32), zone_name: "atrinik.org" },
    { hostname: "rendezvous.meta.atrinik.org", service: "atrinik-metaserver-rendezvous",
      zone_id: "c".repeat(32), zone_name: "atrinik.org" },
    { hostname: "unrelated.example", service: "unrelated" },
  ]);
  assert.doesNotThrow(() => validateProductionControlPlane({
    contract: production, configurations, snapshots, domains,
  }));
  const changed = structuredClone(snapshots);
  changed[0].settings.result.observability.logs.destinations = ["external"];
  assert.throws(() => validateProductionControlPlane({
    contract: production, configurations, snapshots: changed, domains,
  }), /observability destination/u);
  const samplingDrift = structuredClone(snapshots);
  samplingDrift[1].settings.result.observability.logs.head_sampling_rate = 0.5;
  assert.throws(() => validateProductionControlPlane({
    contract: production, configurations, snapshots: samplingDrift, domains,
  }), /observability configuration/u);
  const routeDrift = structuredClone(snapshots);
  routeDrift[2].routes.result.push({ pattern: "rendezvous.meta.atrinik.org/*" });
  assert.throws(() => validateProductionControlPlane({
    contract: production, configurations, snapshots: routeDrift, domains,
  }), /alternate production route/u);
  const wrongZone = structuredClone(domains);
  wrongZone.result[0].zone_id = "d".repeat(32);
  assert.throws(() => validateProductionControlPlane({
    contract: production, configurations, snapshots, domains: wrongZone,
  }), /zone authority/u);
});

test("pins production and build-only review trigger shapes", () => {
  const productionSpec = productionTriggerSpec(production, triggerCoordinates());
  const reviewSpec = automaticReviewTriggerSpec(review, triggerCoordinates());
  assert.deepEqual(productionSpec.branch_includes, ["main"]);
  assert.deepEqual(productionSpec.path_includes, ["*"]);
  assert.deepEqual(reviewSpec.branch_includes, ["*"]);
  assert.deepEqual(reviewSpec.branch_excludes, ["main", "review-build-only-sentinel"]);
  assert.doesNotThrow(() => validateTriggerSnapshot(withConnection(productionSpec),
    productionSpec, "production"));
  assert.doesNotThrow(() => validateTriggerSnapshot(withConnection(reviewSpec),
    reviewSpec, "review"));
  const changed = withConnection(reviewSpec);
  changed.branch_excludes = [];
  assert.throws(() => validateTriggerSnapshot(changed, reviewSpec, "review"), /branch_excludes/u);
  assert.throws(() => productionTriggerSpec(production, {
    ...triggerCoordinates(), externalScriptId: resourceUuid,
  }), /script tag/u);
});

test("pins exact secret classifications and bounded values", () => {
  const values = Object.fromEntries(Object.values(production.protectedInputs)
    .map((name) => [name, `${name}-value`]));
  const desired = productionEnvironmentSpec(production, values);
  assert.equal(desired.SKIP_DEPENDENCY_INSTALL.is_secret, false);
  for (const name of Object.values(production.protectedInputs))
    assert.equal(desired[name].is_secret, true);
  const readback = structuredClone(desired);
  for (const name of Object.values(production.protectedInputs)) readback[name].value = null;
  assert.doesNotThrow(() => validateBuildEnvironment(production, readback));
  delete values[production.protectedInputs.coreConfigVariable];
  assert.throws(() => productionEnvironmentSpec(production, values), /missing/u);
});

test("keeps the automatic review build environment value-only and exact", () => {
  const expected = automaticReviewEnvironmentSpec(review);
  assert.deepEqual(expected, { SKIP_DEPENDENCY_INSTALL: { is_secret: false, value: "1" } });
  assert.doesNotThrow(() => validateAutomaticReviewEnvironment({
    SKIP_DEPENDENCY_INSTALL: { ...expected.SKIP_DEPENDENCY_INSTALL,
      created_on: "2026-08-15T08:00:00Z" },
  }, review));
  assert.throws(() => validateAutomaticReviewEnvironment({ ...expected,
    UNREVIEWED: { is_secret: true, value: null } }, review), /inventory/u);
  assert.throws(() => validateAutomaticReviewEnvironment({
    SKIP_DEPENDENCY_INSTALL: { ...expected.SKIP_DEPENDENCY_INSTALL,
      created_on: "not-a-timestamp" },
  }, review), /bootstrap/u);
});

test("proves a fresh setup has no competing trigger, Deploy Hook, or active build", () => {
  const projects = production.workers.map(({ role }) => role);
  const result = validateFreshBuildsSnapshot({
    production, review,
    scripts: envelope(production.workers.map(({ name }, index) =>
      ({ id: name, tag: String(index + 1).repeat(32) }))),
    triggers: projects.map((label) => [label, envelope([])]),
    deployHooks: projects.map((label) => [label, envelope([])]),
    builds: projects.map((label) => [label, envelope([
      { status: "stopped", build_outcome: "success" },
    ])]),
  });
  assert.equal(result.reviewBootstrapPresent, false);
  const scriptsWithReview = structuredClone(envelope(production.workers.map(({ name }, index) =>
    ({ id: name, tag: String(index + 1).repeat(32) }))));
  scriptsWithReview.result.push({ id: review.automaticReview.project, tag: reviewScriptTag });
  assert.throws(() => validateFreshBuildsSnapshot({
    production, review, scripts: scriptsWithReview,
    triggers: projects.map((label) => [label, envelope([])]),
    deployHooks: projects.map((label) => [label, envelope([])]),
    builds: projects.map((label) => [label, envelope([])]),
  }), /cannot adopt a pre-existing review bootstrap/u);
  assert.throws(() => validateNoActiveBuilds(envelope([
    { status: "running", build_uuid: resourceUuid },
  ]), "core"), /active Workers Build/u);
  assert.throws(() => validateFreshBuildsSnapshot({
    production, review,
    scripts: envelope(production.workers.map(({ name }, index) =>
      ({ id: name, tag: String(index + 1).repeat(32) }))),
    triggers: projects.map((label, index) => [label,
      envelope(index === 0 ? [{ trigger_uuid: resourceUuid }] : [])]),
    deployHooks: projects.map((label) => [label, envelope([])]),
    builds: projects.map((label) => [label, envelope([])]),
  }), /competing Workers Builds trigger/u);
});

test("plans inert setup, separately gated activation, and ordered rollback", () => {
  const plan = provisioningSetupPlan(production, review);
  assert.equal(plan.mutation, false);
  assert.deepEqual(plan.repositoryConnection, {
    provider_account_id: "6371603", provider_account_name: "atrinik",
    provider_type: "github", repo_id: "1324297032", repo_name: "metaserver-worker",
  });
  assert.equal(new Set(plan.setupOperations.map(({ id }) => id)).size,
    plan.setupOperations.length);
  assert.match(plan.setupOperations.find(({ id }) => id === "preflight").action,
    /sentinel-branch-absence/u);
  const triggerCreates = plan.setupOperations.filter(({ action }) => action === "post-inert-trigger");
  assert.equal(triggerCreates.length, 2);
  for (const { request } of triggerCreates) {
    assert.deepEqual(request.body.branch_includes,
      [review.automaticReview.productionBranch]);
    assert.ok(!request.body.branch_includes.includes("main"));
  }
  assert.deepEqual(plan.reviewActivation.request.body.branch_includes,
    review.automaticReview.previewBranchIncludes);
  assert.equal(plan.reviewActivation.request.method, "PATCH");
  assert.deepEqual(plan.reviewActivation.request.path, {
    template: "/builds/triggers/{trigger_uuid}",
    resultReference: "review-trigger-staged.trigger_uuid",
  });
  assert.deepEqual(plan.productionActivation.request.body.branch_includes, ["main"]);
  assert.equal(plan.productionActivation.request.method, "PATCH");
  assert.deepEqual(plan.productionActivation.request.path, {
    template: "/builds/triggers/{trigger_uuid}",
    resultReference: "production-trigger-staged.trigger_uuid",
  });
  assert.equal(plan.productionActivation.request.body.root_directory, "/");
  assert.match(plan.productionActivation.initialGate, /fails-closed/u);
  assert.deepEqual(plan.credentialAuthority.productionLeaseToken.accountPermissions,
    ["Workers Builds Configuration:Edit"]);
  assert.deepEqual(plan.credentialAuthority.controlPlaneOperator.providerAccountPermissions,
    ["Workers Builds Configuration:Edit", "Workers Scripts:Read"]);
  assert.equal(plan.credentialAuthority.controlPlaneOperator.contractPermission,
    "Workers CI Write");
  assert.deepEqual(plan.credentialAuthority.reviewBootstrapToken.accountPermissions,
    ["Workers Scripts:Edit"]);
  assert.equal(plan.credentialAuthority.reviewBootstrapToken.credentialBuildReadable, false);
  assert.equal(plan.credentialAuthority.reviewBuildToken.productionWrite, false);
  assert.ok(plan.credentialAuthority.productionBuildToken.forbiddenAuthority.includes("D1:Edit"));
  assert.match(plan.partialFailure.policy, /ambiguous-response/u);
  assert.match(plan.partialFailure.productionWorkerPolicy, /never-delete/u);
  assert.equal(plan.rollbackOperations[0],
    "restore-production-trigger-to-inert-sentinel-before-cancelling-exact-active-builds");
  assert.equal(plan.rollbackOperations.at(-1),
    "prove-three-production-workers-and-website-app-selection-unchanged");
  assert.match(plan.rollbackOperations.find((operation) =>
    operation.includes("repository-connection")), /only-if-private-journal-proves-created/u);
  const requestPaths = plan.setupOperations.flatMap(({ request }) => request ?
    [typeof request.path === "string" ? request.path : JSON.stringify(request.path)] : []);
  assert.ok(requestPaths.some((path) => path.includes("environment_variables") &&
    path.includes("trigger_uuid")));
  assert.ok(requestPaths.every((path) => !path.includes("deploy_hooks") &&
    !path.includes("/builds/builds")));
  assert.ok(plan.privateInputs.every((name) => name.endsWith("_FILE")));
  assert.ok(plan.privateInputs.includes("ATRINIK_REVIEW_BOOTSTRAP_API_TOKEN_FILE"));
  assert.ok(plan.setupOperations.filter(({ mutation }) => mutation)
    .every(({ actor, action }) => actor && action));
});

test("proves one serialized production trigger and one isolated review trigger", () => {
  const productionSpec = withConnection(productionTriggerSpec(production, triggerCoordinates()));
  const reviewSpec = withConnection(automaticReviewTriggerSpec(review, {
    externalScriptId: reviewScriptTag,
    repositoryConnectionUuid: resourceUuid,
    buildTokenUuid: reviewTokenUuid,
  }));
  reviewSpec.trigger_uuid = reviewTriggerUuid;
  const values = Object.fromEntries(Object.values(production.protectedInputs)
    .map((name) => [name, `${name}-value`]));
  const productionEnvironment = productionEnvironmentSpec(production, values);
  for (const name of Object.values(production.protectedInputs))
    productionEnvironment[name].value = null;
  const automaticEnvironment = automaticReviewEnvironmentSpec(review);
  const result = validateConfiguredBuildsSnapshot({
    production,
    review,
    scripts: envelope([
      { id: production.workers[0].name, tag: scriptTag },
      { id: review.automaticReview.project, tag: reviewScriptTag },
    ]),
    productionTriggers: envelope([productionSpec]),
    productionEnvironment: envelope(productionEnvironment),
    reviewTriggers: envelope([reviewSpec]),
    reviewEnvironment: envelope(automaticEnvironment),
    buildTokens: buildTokenInventory(),
    nonEntrypointTriggers: production.workers.slice(1)
      .map(({ role }) => [role, envelope([])]),
    deployHooks: [...production.workers.map(({ role }) => role), "review"]
      .map((label) => [label, envelope([])]),
  });
  assert.equal(result.mutation, false);

  assert.throws(() => validateConfiguredBuildsSnapshot({
    production,
    review,
    scripts: envelope([
      { id: production.workers[0].name, tag: scriptTag },
      { id: review.automaticReview.project, tag: reviewScriptTag },
    ]),
    productionTriggers: envelope([productionSpec]),
    productionEnvironment: envelope(productionEnvironment),
    reviewTriggers: envelope([reviewSpec]),
    reviewEnvironment: envelope(automaticEnvironment),
    buildTokens: buildTokenInventory(),
    nonEntrypointTriggers: [["publisher", envelope([productionSpec])],
      ["rendezvous", envelope([])]],
    deployHooks: [...production.workers.map(({ role }) => role), "review"]
      .map((label) => [label, envelope([])]),
  }), /independent Builds trigger/u);
  assert.throws(() => validateConfiguredBuildsSnapshot({
    production, review, scripts: envelope([
      { id: production.workers[0].name, tag: scriptTag },
      { id: review.automaticReview.project, tag: reviewScriptTag },
    ]),
    productionTriggers: envelope([productionSpec]),
    productionEnvironment: envelope(productionEnvironment),
    reviewTriggers: envelope([reviewSpec]),
    reviewEnvironment: envelope(automaticEnvironment),
    buildTokens: buildTokenInventory(),
    nonEntrypointTriggers: [], deployHooks: [],
  }), /inventory is incomplete/u);
  assert.throws(() => validateBuildTokenInventory(envelope([
    { ...buildTokenInventory().result[0], build_token_uuid: reviewTokenUuid },
  ]), [
    { uuid: resourceUuid, name: "Atrinik metaserver production" },
    { uuid: reviewTokenUuid, name: "Atrinik metaserver review check" },
  ]), /missing or ambiguous/u);
  assert.throws(() => validateNoDeployHooks(envelope([{ deploy_hook_uuid: resourceUuid }]),
    "production"), /Deploy Hook/u);
});
