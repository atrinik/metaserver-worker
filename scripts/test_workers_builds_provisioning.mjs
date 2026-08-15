import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  automaticReviewEnvironmentSpec,
  automaticReviewTriggerSpec,
  boundedResponseText,
  combineProviderPages,
  combineWorkerVersionPages,
  createPrivateDirectory,
  loadSnapshot,
  materializeProductionConfigurations,
  productionEnvironmentSpec,
  productionTriggerSpec,
  publicStagedProofSummary,
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
  validateProductionActivationSnapshot,
  validateProductionRuntimeProof,
  validateRepositoryConnectionOwnerProof,
  validateReviewedSourceCoordinates,
  validateSentinelRefAbsence,
  validateSnapshotManifest,
  validateSetupPlan,
  validateStableProviderPasses,
  validateStagedBuildsSnapshot,
  validateStagedProof,
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
const reviewBootstrapConfig = JSON.parse(await readFile(resolve(root,
  review.automaticReview.bootstrap.configPath), "utf8"));
const accountId = "a".repeat(32);
const scriptTag = "b".repeat(32);
const reviewScriptTag = "d".repeat(32);
const resourceUuid = "11111111-1111-4111-8111-111111111111";
const reviewTriggerUuid = "22222222-2222-4222-8222-222222222222";
const reviewTokenUuid = "33333333-3333-4333-8333-333333333333";

function envelope(result) {
  return Array.isArray(result) ? { success: true, result, result_info: {
    page: 1, total_pages: 1, total_count: result.length, exhaustive: true,
  } } : { success: true, result };
}

function freshSnapshotManifest(sourceSha = "a".repeat(40)) {
  const now = new Date().toISOString();
  return { accountId, sourceSha, startedAt: now, completedAt: now,
    productionContractSha256: createHash("sha256").update(JSON.stringify(production)).digest("hex"),
    reviewContractSha256: createHash("sha256").update(JSON.stringify(review)).digest("hex") };
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

function freshBoundary() {
  return {
    accountId,
    sourceSha: "a".repeat(40),
    buildTokens: envelope([]),
    accountTriggers: envelope([]),
    sentinelProof: {
      repository: {
        provider_account_id: "6371603", provider_account_name: "atrinik",
        provider_type: "github", repo_id: "1324297032", repo_name: "metaserver-worker",
      },
      branch: `review-build-only-sentinel-${"a".repeat(32)}`,
      refs: [],
      capturedAt: new Date().toISOString(),
    },
    repositoryConnectionProof: {
      source: "cloudflare-owner-ui-readback", accountId,
      connectionPreexisting: true, websitePreserved: true,
      githubApp: { appId: 85455, installationId: 152311798,
        evidenceLocation: "atrinik/metaserver-worker#56-private-provider-evidence",
        repositorySelection: "selected", selectedRepositories: [
          { fullName: "atrinik/metaserver-worker", id: 1324297032 },
          { fullName: "atrinik/website", id: 1327107093 },
        ] },
      mainProtection: { repository: "atrinik/metaserver-worker", defaultBranch: "main",
        sha: "a".repeat(40), requiresPullRequest: true, allowsDeletion: false,
        allowsForcePush: false },
      repository: {
        provider_account_id: "6371603", provider_account_name: "atrinik",
        provider_type: "github", repo_id: "1324297032", repo_name: "metaserver-worker",
      },
      capturedAt: new Date().toISOString(),
    },
  };
}

function configuredBoundary(productionSpec, reviewSpec) {
  const versionId = "44444444-4444-4444-8444-444444444444";
  return {
    accountId,
    sourceSha: "a".repeat(40),
    accountTriggers: envelope([productionSpec, reviewSpec]),
    reviewBootstrapConfig,
    reviewBootstrapState: {
      settings: envelope({ compatibility_date: reviewBootstrapConfig.compatibility_date,
        compatibility_flags: [], bindings: [], observability: { enabled: false } }),
      subdomain: envelope({ enabled: false, previews_enabled: false }),
      schedules: envelope({ schedules: [] }),
      routes: envelope([]),
      scriptSettings: envelope({ logpush: null, tail_consumers: [] }),
      deployments: envelope({ deployments: [{ versions: [
        { version_id: versionId, percentage: 100 },
      ] }] }),
      versions: envelope([{ id: versionId }]),
      activeVersion: envelope({ id: versionId, annotations: {
        "workers/tag": "atrinik-review-bootstrap",
        "workers/message": `config=${review.automaticReview.bootstrap.configSha256} source=${review.automaticReview.bootstrap.sourceSha256}`,
      }, resources: { bindings: [], script_runtime: { exports: {} } } }),
      builds: envelope([]),
      buildLimits: envelope({ has_reached_build_minutes_limit: false }),
      buildUsageProof: { source: "cloudflare-owner-build-usage-readback", accountId,
        capturedAt: new Date().toISOString(), monthlyMinutesUsed: 0,
        alertAtMinutes: 800, disableAtMinutes: 1000 },
      uploadProof: { source: "wrangler-clean-reviewed-source-upload",
        capturedAt: new Date().toISOString(), cleanCheckout: true,
        sourceRevision: "a".repeat(40), sourceSha256: review.automaticReview.bootstrap.sourceSha256,
        configSha256: review.automaticReview.bootstrap.configSha256, versionId,
        command: ["node_modules/.bin/wrangler", "deploy", "--config",
          review.automaticReview.bootstrap.configPath, "--tag", "atrinik-review-bootstrap",
          "--message", `config=${review.automaticReview.bootstrap.configSha256} source=${review.automaticReview.bootstrap.sourceSha256}`] },
    },
    tokenAuthorityProofs: [
      { kind: "production", source: "cloudflare-owner-token-policy-readback",
        capturedAt: new Date().toISOString(), modifiedOn: "2026-08-15T00:00:00.000Z",
        accountId, sourceSha: "a".repeat(40),
        tokenId: "production-token-id", userPermissions: [],
        accountPermissions: ["D1:Read", "Workers Scripts:Edit"],
        accountResources: [accountId], zonePermissions: [], zoneResources: [] },
      { kind: "review", source: "cloudflare-owner-token-policy-readback",
        capturedAt: new Date().toISOString(), modifiedOn: "2026-08-15T00:00:00.000Z",
        accountId, sourceSha: "a".repeat(40),
        tokenId: "review-token-id", userPermissions: ["User Details:Read"],
        accountPermissions: [], accountResources: [], zonePermissions: [], zoneResources: [] },
    ],
  };
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
    const outside = resolve(temporary, "outside.json");
    await writeFile(outside, '{"secret":true}\n', { mode: 0o600 });
    await assert.rejects(loadSnapshot(snapshot, "../outside.json"), /safe JSON basename/u);
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

test("combines only stable exhaustive provider pages", () => {
  const combined = combineProviderPages([
    { success: true, result: [{ build_uuid: resourceUuid }], result_info: {
      page: 1, total_pages: 2, total_count: 2 } },
    { success: true, result: [{ build_uuid: reviewTriggerUuid }], result_info: {
      page: 2, total_pages: 2, total_count: 2 } },
  ], "builds", ({ build_uuid }) => build_uuid);
  assert.equal(combined.result_info.exhaustive, true);
  assert.equal(combined.result.length, 2);
  assert.throws(() => combineProviderPages([
    { success: true, result: [{ build_uuid: resourceUuid }], result_info: {
      page: 1, total_pages: 2, total_count: 2 } },
  ], "builds", ({ build_uuid }) => build_uuid), /changed during readback/u);
  assert.throws(() => combineProviderPages([
    { success: true, result: [{ build_uuid: resourceUuid }], result_info: {
      page: 1, total_pages: 2, total_count: 2 } },
    { success: true, result: [{ build_uuid: resourceUuid }], result_info: {
      page: 2, total_pages: 2, total_count: 2 } },
  ], "builds", ({ build_uuid }) => build_uuid), /duplicated/u);
});

test("normalizes the official nested Worker versions pagination shape", () => {
  const combined = combineWorkerVersionPages([
    { success: true, result: { items: [{ id: resourceUuid }] }, result_info: {
      page: 1, total_pages: 2, total_count: 2 } },
    { success: true, result: { items: [{ id: reviewTriggerUuid }] }, result_info: {
      page: 2, total_pages: 2, total_count: 2 } },
  ]);
  assert.deepEqual(combined.result.map(({ id }) => id), [resourceUuid, reviewTriggerUuid]);
  assert.equal(combined.result_info.exhaustive, true);
  assert.throws(() => combineWorkerVersionPages([
    { success: true, result: [{ id: resourceUuid }], result_info: {
      page: 1, total_pages: 1, total_count: 1 } },
  ]), /version inventory is malformed/u);
});

test("rejects equal-count provider replacement between complete passes", () => {
  assert.throws(() => validateStableProviderPasses(
    envelope([{ build_uuid: resourceUuid }]),
    envelope([{ build_uuid: reviewTriggerUuid }]), "builds"), /changed between complete passes/u);
});

test("requires an exact private random absent staging ref", () => {
  const proof = freshBoundary().sentinelProof;
  assert.equal(validateSentinelRefAbsence(proof).outcome, "staging-sentinel-ref-absent");
  assert.throws(() => validateSentinelRefAbsence({ ...proof,
    branch: "review-build-only-sentinel" }), /malformed/u);
  assert.throws(() => validateSentinelRefAbsence({ ...proof,
    refs: [{ ref: `refs/heads/${proof.branch}` }] }), /exists or its absence/u);
  assert.throws(() => validateSentinelRefAbsence({ ...proof,
    capturedAt: "2026-08-15T00:00:00Z" }, Date.parse("2026-08-15T00:06:00Z")), /stale/u);
});

test("binds provider snapshots to a fresh exact reviewed source", () => {
  const sourceSha = "a".repeat(40);
  const now = Date.parse("2026-08-15T12:00:00.000Z");
  const productionContractSha256 = createHash("sha256")
    .update(JSON.stringify(production)).digest("hex");
  const reviewContractSha256 = createHash("sha256")
    .update(JSON.stringify(review)).digest("hex");
  const manifest = { accountId, sourceSha, productionContractSha256, reviewContractSha256,
    startedAt: "2026-08-15T11:59:00.000Z", completedAt: "2026-08-15T12:00:00.000Z" };
  assert.doesNotThrow(() => validateSnapshotManifest(manifest,
    { accountId, sourceSha, production, review }, now));
  assert.throws(() => validateSnapshotManifest({ ...manifest,
    completedAt: "2026-08-15T11:50:00.000Z" },
  { accountId, sourceSha, production, review }, now), /snapshot manifest is stale/u);
});

test("requires the reviewed source to be clean HEAD and live current main", () => {
  const sha = "a".repeat(40);
  assert.equal(validateReviewedSourceCoordinates({ expected: sha, head: sha,
    currentMain: sha, dirty: "" }), sha);
  assert.throws(() => validateReviewedSourceCoordinates({ expected: sha, head: sha,
    currentMain: "b".repeat(40), dirty: "" }), /clean current GitHub main/u);
  assert.throws(() => validateReviewedSourceCoordinates({ expected: sha, head: sha,
    currentMain: sha, dirty: " M README.md\n" }), /clean current GitHub main/u);
});

test("requires fresh owner proof for the unreadable shared repository connection", () => {
  const proof = freshBoundary().repositoryConnectionProof;
  assert.doesNotThrow(() => validateRepositoryConnectionOwnerProof(proof, accountId,
    "a".repeat(40)));
  assert.throws(() => validateRepositoryConnectionOwnerProof({ ...proof,
    websitePreserved: false }, accountId, "a".repeat(40)), /owner proof drift/u);
  assert.throws(() => validateRepositoryConnectionOwnerProof({ ...proof,
    capturedAt: "2026-08-14T00:00:00Z" }, accountId, "a".repeat(40),
    Date.parse("2026-08-15T00:00:01Z")), /stale/u);
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

test("proves one active production topology and an exact migration prefix", () => {
  const configurations = materializeProductionConfigurations({
    contract: production, bases, snapshots: bases.map(snapshot), accountId,
  });
  const versionIds = production.workers.map((_, index) =>
    `${String(index + 1).repeat(8)}-${String(index + 1).repeat(4)}-4${String(index + 1).repeat(3)}-8${String(index + 1).repeat(3)}-${String(index + 1).repeat(12)}`);
  const deployments = versionIds.map((versionId) => envelope({ deployments: [{
    versions: [{ version_id: versionId, percentage: 100 }],
  }] }));
  const activeVersions = configurations.map((config, index) => envelope({
    id: versionIds[index], resources: { bindings: bindings(config), script_runtime: {
      compatibility_date: config.compatibility_date,
      compatibility_flags: config.compatibility_flags ?? [], exports: config.exports ?? {},
    } },
  }));
  const migrationNames = Array.from({ length: 10 }, (_, index) =>
    `${String(index + 1).padStart(4, "0")}_migration.sql`);
  const result = validateProductionRuntimeProof({ contract: production, configurations,
    deployments, activeVersions,
    migrationEnvelope: envelope([{ results: migrationNames.slice(0, 9)
      .map((name, index) => ({ id: index + 1, name })) }]),
    migrationNames });
  assert.deepEqual(result.pendingMigrations, [migrationNames[9]]);
  const drift = structuredClone(activeVersions);
  drift[0].result.resources.script_runtime.exports.Unreviewed = { type: "worker" };
  assert.throws(() => validateProductionRuntimeProof({ contract: production, configurations,
    deployments, activeVersions: drift,
    migrationEnvelope: envelope([{ results: migrationNames.slice(0, 9)
      .map((name, index) => ({ id: index + 1, name })) }]),
    migrationNames }), /exports reconciliation/u);
  const bindingDrift = structuredClone(activeVersions);
  bindingDrift[0].result.resources.bindings.pop();
  assert.throws(() => validateProductionRuntimeProof({ contract: production, configurations,
    deployments, activeVersions: bindingDrift,
    migrationEnvelope: envelope([{ results: migrationNames.slice(0, 9)
      .map((name, index) => ({ id: index + 1, name })) }]),
    migrationNames }), /binding inventory/u);
  const wrongLedgerIds = migrationNames.slice(0, 9)
    .map((name, index) => ({ id: index + 1, name }));
  wrongLedgerIds[3].id = 3;
  assert.throws(() => validateProductionRuntimeProof({ contract: production, configurations,
    deployments, activeVersions,
    migrationEnvelope: envelope([{ results: wrongLedgerIds }]), migrationNames }),
  /ledger sequence/u);
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
    ...freshBoundary(),
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
    ...freshBoundary(),
    production, review, scripts: scriptsWithReview,
    triggers: projects.map((label) => [label, envelope([])]),
    deployHooks: projects.map((label) => [label, envelope([])]),
    builds: projects.map((label) => [label, envelope([])]),
  }), /cannot adopt a pre-existing review bootstrap/u);
  assert.throws(() => validateNoActiveBuilds(envelope([
    { status: "running", build_uuid: resourceUuid },
  ]), "core"), /active Workers Build/u);
  assert.throws(() => validateFreshBuildsSnapshot({
    ...freshBoundary(),
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
    /sentinel-ref-absence/u);
  const triggerCreates = plan.setupOperations.filter(({ action }) =>
    action === "post-inert-trigger-with-zero-resource-token");
  assert.equal(triggerCreates.length, 2);
  for (const { request } of triggerCreates) {
    assert.deepEqual(request.body.branch_includes,
      [{ privateFileEnvironment: "ATRINIK_STAGING_SENTINEL_BRANCH_FILE" }]);
    assert.ok(!request.body.branch_includes.includes("main"));
  }
  const productionStaged = triggerCreates.find(({ id }) => id === "production-trigger-staged");
  assert.equal(productionStaged.request.body.build_token_uuid.resultReference,
    "review-build-token.build_token_uuid");
  assert.deepEqual(plan.reviewActivation.request.body.branch_includes,
    review.automaticReview.previewBranchIncludes);
  assert.equal(plan.reviewActivation.request.method, "PATCH");
  assert.deepEqual(plan.reviewActivation.request.path, {
    template: "/builds/triggers/{trigger_uuid}",
    resultReference: "review-trigger-staged.trigger_uuid",
  });
  assert.deepEqual(plan.productionActivation.request.body.branch_includes, ["main"]);
  assert.equal(plan.productionActivation.request.body.build_token_uuid.resultReference,
    "production-build-token.build_token_uuid");
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
    operation.includes("repository-connection")), /retain-shared/u);
  const requestPaths = plan.setupOperations.flatMap(({ request }) => request ?
    [typeof request.path === "string" ? request.path : JSON.stringify(request.path)] : []);
  assert.ok(requestPaths.some((path) => path.includes("environment_variables") &&
    path.includes("trigger_uuid")));
  assert.ok(requestPaths.every((path) => !path.includes("deploy_hooks") &&
    !path.includes("/builds/builds")));
  assert.ok(plan.privateInputs.every((name) => name.endsWith("_FILE")));
  assert.ok(plan.privateInputs.includes("ATRINIK_REVIEW_BOOTSTRAP_API_TOKEN_FILE"));
  assert.ok(plan.privateInputs.includes("ATRINIK_STAGING_SENTINEL_REFS_FILE"));
  assert.ok(plan.setupOperations.filter(({ mutation }) => mutation)
    .every(({ actor, action }) => actor && action));
  assert.equal(validateSetupPlan(plan), plan);
  const dangling = structuredClone(plan);
  dangling.productionActivation.request.body.build_token_uuid.resultReference =
    "missing-token.build_token_uuid";
  assert.throws(() => validateSetupPlan(dangling), /dangling or forward/u);
  const missingField = structuredClone(plan);
  delete missingField.setupOperations.find(({ id }) => id === "production-script")
    .produces.script_tag;
  assert.throws(() => validateSetupPlan(missingField), /producer schema/u);
  const apiFieldDrift = structuredClone(plan);
  apiFieldDrift.setupOperations.find(({ id }) => id === "production-script")
    .produces.script_tag.sourceField = "script_tag";
  assert.throws(() => validateSetupPlan(apiFieldDrift), /producer schema/u);
  const missingSentinel = structuredClone(plan);
  missingSentinel.setupOperations = missingSentinel.setupOperations.filter(({ id }) =>
    id !== "sentinel-recheck-before-production-trigger");
  assert.throws(() => validateSetupPlan(missingSentinel), /operation set, order/u);
  const reordered = structuredClone(plan);
  [reordered.setupOperations[6], reordered.setupOperations[7]] =
    [reordered.setupOperations[7], reordered.setupOperations[6]];
  assert.throws(() => validateSetupPlan(reordered), /operation set, order/u);
  const unsafeSelector = structuredClone(plan);
  unsafeSelector.setupOperations.find(({ id }) => id === "production-trigger-staged")
    .request.body.branch_includes = ["main"];
  assert.throws(() => validateSetupPlan(unsafeSelector), /complete setup plan schema drift/u);
  const unsafeActivation = structuredClone(plan);
  unsafeActivation.productionActivation.request.method = "DELETE";
  assert.throws(() => validateSetupPlan(unsafeActivation), /complete setup plan schema drift/u);
  const missingStagedEdge = structuredClone(plan);
  delete missingStagedEdge.reviewActivation.precondition;
  assert.throws(() => validateSetupPlan(missingStagedEdge), /complete setup plan schema drift/u);
  const rollbackDrift = structuredClone(plan);
  rollbackDrift.rollbackOperations.pop();
  assert.throws(() => validateSetupPlan(rollbackDrift), /complete setup plan schema drift/u);
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
  const validArguments = () => ({
    ...configuredBoundary(productionSpec, reviewSpec),
    sourceSha: "a".repeat(40),
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
  const result = validateConfiguredBuildsSnapshot(validArguments());
  assert.equal(result.mutation, false);
  const unrelated = validArguments();
  unrelated.accountTriggers.result.push({ trigger_uuid: "55555555-5555-4555-8555-555555555555",
    repo_connection: { provider_type: "github", provider_account_id: "6371603",
      repo_id: "unrelated-repository" } });
  unrelated.accountTriggers.result_info.total_count = 3;
  assert.doesNotThrow(() => validateConfiguredBuildsSnapshot(unrelated));

  for (const mutate of [
    (value) => value.reviewBootstrapState.settings.result.bindings.push({
      name: "UNREVIEWED", type: "plain_text", text: "1" }),
    (value) => value.reviewBootstrapState.routes.result.push({ pattern: "unexpected.example" }),
    (value) => { value.reviewBootstrapState.versions.result.push({ id: resourceUuid });
      value.reviewBootstrapState.versions.result_info.total_count = 2; },
    (value) => value.reviewBootstrapState.activeVersion.result.annotations["workers/tag"] = "wrong",
    (value) => { value.reviewBootstrapState.uploadProof.sourceRevision = "b".repeat(40); },
    (value) => { value.reviewBootstrapState.builds.result.push({
      build_uuid: resourceUuid, status: "running" });
      value.reviewBootstrapState.builds.result_info.total_count = 1; },
    (value) => value.reviewBootstrapState.buildLimits.result.has_reached_build_minutes_limit = true,
    (value) => { value.reviewBootstrapState.buildLimits.result.has_reached_build_minutes_limit = null; },
    (value) => { value.reviewBootstrapState.buildUsageProof.monthlyMinutesUsed = 800; },
    (value) => value.tokenAuthorityProofs[1].accountPermissions.push("Workers Scripts:Edit"),
    (value) => { value.tokenAuthorityProofs[1].capturedAt = "2026-08-15T00:00:00.000Z"; },
    (value) => { value.tokenAuthorityProofs[1].modifiedOn = "2999-01-01T00:00:00.000Z"; },
    (value) => { value.tokenAuthorityProofs[1].accountId = "b".repeat(32); },
    (value) => { value.tokenAuthorityProofs[1].sourceSha = "b".repeat(40); },
    (value) => { value.accountTriggers.result.push({
      trigger_uuid: "55555555-5555-4555-8555-555555555555",
      repo_connection: productionSpec.repo_connection });
      value.accountTriggers.result_info.total_count = 3; },
  ]) {
    const changed = validArguments();
    mutate(changed);
    assert.throws(() => validateConfiguredBuildsSnapshot(changed));
  }

  const reusedTokens = buildTokenInventory();
  reusedTokens.result[1].cloudflare_token_id = reusedTokens.result[0].cloudflare_token_id;
  const reusedBoundary = configuredBoundary(productionSpec, reviewSpec);
  reusedBoundary.tokenAuthorityProofs[1].tokenId = reusedBoundary.tokenAuthorityProofs[0].tokenId;
  assert.throws(() => validateConfiguredBuildsSnapshot({
    ...reusedBoundary, production, review,
    scripts: envelope([{ id: production.workers[0].name, tag: scriptTag },
      { id: review.automaticReview.project, tag: reviewScriptTag }]),
    productionTriggers: envelope([productionSpec]), productionEnvironment: envelope(productionEnvironment),
    reviewTriggers: envelope([reviewSpec]), reviewEnvironment: envelope(automaticEnvironment),
    buildTokens: reusedTokens,
    nonEntrypointTriggers: production.workers.slice(1).map(({ role }) => [role, envelope([])]),
    deployHooks: [...production.workers.map(({ role }) => role), "review"]
      .map((label) => [label, envelope([])]),
  }), /reuse one underlying/u);

  const publicBootstrap = configuredBoundary(productionSpec, reviewSpec);
  publicBootstrap.reviewBootstrapState.subdomain.result.enabled = true;
  assert.throws(() => validateConfiguredBuildsSnapshot({
    ...publicBootstrap, production, review,
    scripts: envelope([{ id: production.workers[0].name, tag: scriptTag },
      { id: review.automaticReview.project, tag: reviewScriptTag }]),
    productionTriggers: envelope([productionSpec]), productionEnvironment: envelope(productionEnvironment),
    reviewTriggers: envelope([reviewSpec]), reviewEnvironment: envelope(automaticEnvironment),
    buildTokens: buildTokenInventory(),
    nonEntrypointTriggers: production.workers.slice(1).map(({ role }) => [role, envelope([])]),
    deployHooks: [...production.workers.map(({ role }) => role), "review"]
      .map((label) => [label, envelope([])]),
  }), /public or preview URL/u);

  assert.throws(() => validateConfiguredBuildsSnapshot({
    ...configuredBoundary(productionSpec, reviewSpec),
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
    ...configuredBoundary(productionSpec, reviewSpec),
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

test("proves both triggers are inert before either activation", () => {
  const sentinelProof = freshBoundary().sentinelProof;
  const productionSpec = withConnection(productionTriggerSpec(production, {
    ...triggerCoordinates(), buildTokenUuid: reviewTokenUuid,
  }));
  productionSpec.branch_includes = [sentinelProof.branch];
  const reviewSpec = withConnection(automaticReviewTriggerSpec(review, {
    externalScriptId: reviewScriptTag, repositoryConnectionUuid: resourceUuid,
    buildTokenUuid: reviewTokenUuid,
  }));
  reviewSpec.trigger_uuid = reviewTriggerUuid;
  reviewSpec.branch_includes = [sentinelProof.branch];
  reviewSpec.branch_excludes = ["main"];
  const values = Object.fromEntries(Object.values(production.protectedInputs)
    .map((name) => [name, `${name}-value`]));
  const productionEnvironment = productionEnvironmentSpec(production, values);
  for (const name of Object.values(production.protectedInputs))
    productionEnvironment[name].value = null;
  const arguments_ = {
    ...configuredBoundary(productionSpec, reviewSpec), production, review, sentinelProof,
    snapshotManifest: freshSnapshotManifest(),
    scripts: envelope([{ id: production.workers[0].name, tag: scriptTag },
      { id: review.automaticReview.project, tag: reviewScriptTag }]),
    productionTriggers: envelope([productionSpec]),
    productionEnvironment: envelope(productionEnvironment),
    reviewTriggers: envelope([reviewSpec]),
    reviewEnvironment: envelope(automaticReviewEnvironmentSpec(review)),
    nonEntrypointTriggers: production.workers.slice(1)
      .map(({ role }) => [role, envelope([])]),
    buildTokens: buildTokenInventory(),
    deployHooks: [...production.workers.map(({ role }) => role), "review"]
      .map((label) => [label, envelope([])]),
    builds: [...production.workers.map(({ role }) => [role, envelope([])]),
      ["review", envelope([])]],
  };
  const stagedProof = validateStagedBuildsSnapshot(arguments_);
  assert.equal(stagedProof.stagedTriggerCount, 2);
  assert.match(stagedProof.proof_digest, /^[0-9a-f]{64}$/u);
  assert.equal(Object.hasOwn(publicStagedProofSummary(stagedProof), "accountId"), false);
  assert.equal(validateStagedProof(stagedProof, stagedProof).proof_digest,
    stagedProof.proof_digest);
  assert.throws(() => validateStagedProof({ ...stagedProof, proof_digest: "0".repeat(64) },
    stagedProof), /staged activation proof/u);
  const staleProof = { ...stagedProof, capturedAt: "2026-08-15T00:00:00.000Z" };
  assert.throws(() => validateStagedProof(staleProof, staleProof,
    Date.parse("2026-08-15T00:06:00.000Z")), /staged activation proof/u);
  const active = structuredClone(arguments_);
  active.productionTriggers.result[0].branch_includes = ["main"];
  assert.throws(() => validateStagedBuildsSnapshot(active), /trigger branch_includes drift/u);
  const wrongToken = structuredClone(arguments_);
  wrongToken.productionTriggers.result[0].build_token_uuid = resourceUuid;
  assert.throws(() => validateStagedBuildsSnapshot(wrongToken), /zero-resource review token/u);
  const splitConnection = structuredClone(arguments_);
  splitConnection.reviewTriggers.result[0].repo_connection.repo_connection_uuid =
    "66666666-6666-4666-8666-666666666666";
  assert.throws(() => validateStagedBuildsSnapshot(splitConnection),
    /journaled repository connection/u);
  const callerTrigger = structuredClone(arguments_);
  callerTrigger.nonEntrypointTriggers[0][1].result.push({ trigger_uuid: resourceUuid,
    repo_connection: { provider_type: "gitlab", repo_id: "unrelated" } });
  callerTrigger.nonEntrypointTriggers[0][1].result_info.total_count = 1;
  assert.throws(() => validateStagedBuildsSnapshot(callerTrigger),
    /independent staged Builds trigger/u);
  const reviewActive = structuredClone(arguments_);
  const finalReview = withConnection(automaticReviewTriggerSpec(review, {
    externalScriptId: reviewScriptTag, repositoryConnectionUuid: resourceUuid,
    buildTokenUuid: reviewTokenUuid,
  }));
  finalReview.trigger_uuid = reviewTriggerUuid;
  reviewActive.reviewTriggers = envelope([finalReview]);
  assert.throws(() => validateStagedBuildsSnapshot(reviewActive), /branch_includes drift/u);
  assert.throws(() => validateProductionActivationSnapshot(reviewActive),
    /disposable review result proof/u);
  const buildUuid = "77777777-7777-4777-8777-777777777777";
  const reviewCommitSha = "b".repeat(40);
  const branch = "review/issue-56-provider-proof";
  const reviewBuild = { build_uuid: buildUuid, status: "stopped", build_outcome: "success",
    trigger: { trigger_uuid: reviewTriggerUuid }, build_trigger_metadata: {
      branch, commit_hash: reviewCommitSha, build_token_uuid: reviewTokenUuid } };
  reviewActive.reviewBootstrapState.builds = envelope([reviewBuild]);
  reviewActive.builds = reviewActive.builds.map(([label, value]) =>
    [label, label === "review" ? envelope([reviewBuild]) : value]);
  reviewActive.reviewResultProof = {
    source: "cloudflare-github-disposable-review-readback",
    repository: "atrinik/metaserver-worker", branch, reviewCommitSha, buildUuid,
    triggerUuid: reviewTriggerUuid, buildTokenUuid: reviewTokenUuid,
    branchDeleted: true, cleanupProven: true,
    evidenceLocation: "atrinik/metaserver-worker#56-private-provider-evidence",
    capturedAt: new Date().toISOString(), githubCheck: {
      name: "Cloudflare Workers Builds", conclusion: "success", commitSha: reviewCommitSha,
      detailsUrl: "https://dash.cloudflare.com/example/builds/77777777-7777-4777-8777-777777777777",
    },
  };
  const productionProof = validateProductionActivationSnapshot(reviewActive);
  assert.equal(productionProof.outcome, "workers-builds-production-activation-snapshot-valid");
  assert.match(productionProof.proof_digest, /^[0-9a-f]{64}$/u);
  const failedReview = structuredClone(reviewActive);
  failedReview.reviewBootstrapState.builds.result[0].build_outcome = "fail";
  assert.throws(() => validateProductionActivationSnapshot(failedReview),
    /disposable review result proof/u);
  const wrongReviewSha = structuredClone(reviewActive);
  wrongReviewSha.reviewResultProof.reviewCommitSha = "c".repeat(40);
  assert.throws(() => validateProductionActivationSnapshot(wrongReviewSha),
    /disposable review result proof/u);
});
