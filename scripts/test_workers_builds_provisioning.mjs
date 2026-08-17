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
  credentialedSourceSha,
  credentialedProvisioningModes,
  createPrivateDirectory,
  initialBootstrapPredecessorConfiguration,
  issueReviewActivationAuthority,
  loadSnapshot,
  materializeProductionConfigurations,
  normalizeBuildsListPage,
  normalizeDomainListPage,
  normalizeTriggerListPage,
  productionEnvironmentSpec,
  productionTriggerSpec,
  publicStagedProofSummary,
  provisioningDryRunSummary,
  provisioningSetupPlan,
  readProductionSentinelProof,
  readCurrentMainProof,
  readProviderSnapshot,
  readPrivateValue,
  runProvisioningCli,
  validateAutomaticReviewEnvironment,
  validateBuildTokenInventory,
  validateCheckedInProvisioning,
  validateConfiguredBuildsSnapshot,
  validateCurrentMainProof,
  validateDistinctSentinelRefAbsence,
  validateFreshBuildsSnapshot,
  validateInitialBootstrapSnapshot,
  validateNoActiveBuilds,
  validateNoDeployHooks,
  validateProductionControlPlane,
  validateProductionActivationSnapshot,
  validateReviewActivationSnapshot,
  validateReviewActivationAuthority,
  validateReviewStagedEnvironmentSnapshotDirectory,
  validateReviewStagedEnvironmentReadback,
  validateReviewStagingRootAbsence,
  validateReviewStagingRootProofSequence,
  validateProductionRuntimeProof,
  validateRepositoryConnectionOwnerProof,
  validateRollbackProductionTriggerReadback,
  validateRollbackTriggerInventory,
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
const accountId = "a".repeat(32);
const scriptTag = "b".repeat(32);
const resourceUuid = "11111111-1111-4111-8111-111111111111";
const reviewTriggerUuid = "22222222-2222-4222-8222-222222222222";
const reviewTokenUuid = "33333333-3333-4333-8333-333333333333";

function envelope(result) {
  return Array.isArray(result) ? { success: true, result, result_info: {
    page: 1, total_pages: 1, total_count: result.length, exhaustive: true,
  } } : { success: true, result };
}

function authenticatedCurrentMainProof(sha = "a".repeat(40),
  capturedAt = new Date().toISOString()) {
  return {
    source: "authenticated-gh-api-current-main-readback",
    repository: { owner: "atrinik", name: "metaserver-worker" },
    endpoint: "repos/atrinik/metaserver-worker/git/ref/heads/main",
    ref: "refs/heads/main",
    sha,
    capturedAt,
    raw: {
      ref: "refs/heads/main",
      node_id: "REF_kwDOTu8rSLByZWZzL2hlYWRzL21haW4",
      url: "https://api.github.com/repos/atrinik/metaserver-worker/git/refs/heads/main",
      object: {
        sha,
        type: "commit",
        url: `https://api.github.com/repos/atrinik/metaserver-worker/git/commits/${sha}`,
      },
    },
  };
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
  const sentinelProof = (suffix) => ({
    repository: {
      provider_account_id: "6371603", provider_account_name: "atrinik",
      provider_type: "github", repo_id: "1324297032", repo_name: "metaserver-worker",
    },
    branch: `review-build-only-sentinel-${suffix.repeat(32)}`,
    refs: [],
    capturedAt: new Date().toISOString(),
  });
  return {
    accountId,
    sourceSha: "a".repeat(40),
    buildTokens: envelope([]),
    accountTriggers: envelope([]),
    productionSentinelProof: sentinelProof("a"),
    repositoryConnectionProof: {
      source: "cloudflare-owner-ui-readback", accountId,
      connectionPreexisting: true, websitePreserved: true,
      githubApp: { appId: 85455, installationId: 152311798,
        evidenceLocation: "atrinik/metaserver-worker#66-private-provider-evidence",
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
  return {
    accountId,
    sourceSha: "a".repeat(40),
    accountTriggers: envelope([productionSpec, reviewSpec]),
    reviewBuildState: {
      builds: envelope([]),
      buildLimits: envelope({ has_reached_build_minutes_limit: false }),
      buildUsageProof: { source: "cloudflare-owner-build-usage-readback", accountId,
        capturedAt: new Date().toISOString(), monthlyMinutesUsed: 0,
        alertAtMinutes: 800, disableAtMinutes: 1000 },
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

function reviewActivationAuthorityFixture(stagedProof = null) {
  const stagedCapturedAt = new Date().toISOString();
  stagedProof ??= {
    outcome: "workers-builds-staged-snapshot-valid", mutation: false, accountId,
    sourceSha: "a".repeat(40), stagedTriggerCount: 1, capturedAt: stagedCapturedAt,
    snapshotStartedAt: stagedCapturedAt, snapshotCompletedAt: stagedCapturedAt,
    proof_digest: "f".repeat(64),
  };
  const boundary = freshBoundary();
  const configured = configuredBoundary({}, {});
  const evidence = {
    stagedProof,
    repositoryConnectionProof: boundary.repositoryConnectionProof,
    productionSentinelProof: boundary.productionSentinelProof,
    tokenAuthorityProofs: configured.tokenAuthorityProofs,
    buildUsageProof: configured.reviewBuildState.buildUsageProof,
  };
  const proof = issueReviewActivationAuthority({ production, review, accountId,
    sourceSha: "a".repeat(40), ...evidence, currentStagedProof: stagedProof, tokenRows: {
      production: { cloudflare_token_id: "production-token-id" },
      review: { cloudflare_token_id: "review-token-id" },
    } });
  return { proof, evidence };
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

test("normalizes only an empty first Workers Builds page without metadata", () => {
  const rawEmpty = { success: true, result: [], errors: [], messages: [] };
  const normalized = normalizeBuildsListPage(rawEmpty, "triggers", 1);
  assert.deepEqual(normalized.result_info, { page: 1, total_pages: 1, total_count: 0 });
  assert.deepEqual(combineProviderPages([normalized], "triggers",
    ({ trigger_uuid: id }) => id).result, []);
  const paginated = { ...rawEmpty,
    result_info: { page: 1, total_pages: 1, total_count: 0 } };
  assert.equal(normalizeBuildsListPage(paginated, "build tokens", 1), paginated);
  assert.throws(() => normalizeBuildsListPage({ ...rawEmpty,
    result: [{ trigger_uuid: resourceUuid }] }, "triggers", 1),
  /Builds pagination metadata is malformed/u);
  assert.throws(() => normalizeBuildsListPage(rawEmpty, "builds", 2),
    /Builds pagination metadata is malformed/u);
  assert.throws(() => normalizeBuildsListPage({ success: true, result: null },
    "build tokens", 1), /provider readback failed/u);
});

test("normalizes only bounded metadata-free per-Worker trigger inventories", () => {
  const trigger = (trigger_uuid) => ({ trigger_uuid });
  const raw = (result) => ({ success: true, result, errors: [], messages: [] });
  for (const rows of [[], [trigger(resourceUuid)],
    [trigger(resourceUuid), trigger(reviewTriggerUuid)]]) {
    const normalized = normalizeTriggerListPage(raw(rows), "triggers", 1, 2);
    assert.deepEqual(normalized.result_info,
      { page: 1, total_pages: 1, total_count: rows.length });
    assert.deepEqual(combineProviderPages([normalized], "triggers",
      ({ trigger_uuid: id }) => id).result, rows);
  }
  const native = { ...raw([trigger(resourceUuid)]), result_info: {
    page: 1, total_pages: 1, total_count: 1,
  } };
  assert.equal(normalizeTriggerListPage(native, "triggers", 1, 2), native);
  assert.throws(() => normalizeTriggerListPage({ ...native, result_info: {
    ...native.result_info, total_count: 3,
  } }, "triggers", 1, 2), /trigger pagination metadata is malformed/u);

  const malformed = [
    { envelope: raw([trigger(resourceUuid), trigger(reviewTriggerUuid),
      trigger("22222222-2222-4222-8222-222222222222")]), page: 1, maximum: 2 },
    { envelope: raw([trigger(resourceUuid)]), page: 2, maximum: 2 },
    { envelope: { ...raw([trigger(resourceUuid)]), unexpected: true }, page: 1, maximum: 2 },
    { envelope: { ...raw([trigger(resourceUuid)]), errors: {} }, page: 1, maximum: 2 },
    { envelope: { ...raw([trigger(resourceUuid)]), messages: {} }, page: 1, maximum: 2 },
    { envelope: raw([trigger(resourceUuid)]), page: 1, maximum: 3 },
  ];
  for (const { envelope, page, maximum } of malformed)
    assert.throws(() => normalizeTriggerListPage(envelope, "triggers", page, maximum),
      /trigger pagination metadata is malformed/u);

  const duplicated = normalizeTriggerListPage(raw([
    trigger(resourceUuid), trigger(resourceUuid),
  ]), "triggers", 1, 2);
  assert.throws(() => combineProviderPages([duplicated], "triggers",
    ({ trigger_uuid: id }) => id), /duplicated/u);
  assert.throws(() => normalizeBuildsListPage(raw([trigger(resourceUuid)]),
    "builds", 1), /Builds pagination metadata is malformed/u);
});

test("normalizes only the exact empty native zero-page Workers Builds response", () => {
  const rawEmpty = { success: true, result: [], errors: [], messages: [], result_info: {
    page: 1, per_page: 200, count: 0, total_count: 0, total_pages: 0, next_page: false,
  } };
  const normalized = normalizeBuildsListPage(rawEmpty, "builds", 1);
  assert.deepEqual(normalized.result_info, { page: 1, total_pages: 1, total_count: 0 });
  assert.deepEqual(combineProviderPages([normalized], "builds",
    ({ build_uuid: id }) => id).result, []);

  const contradictions = [
    { result: [{ build_uuid: resourceUuid }] },
    { result_info: { ...rawEmpty.result_info, page: 2 } },
    { result_info: { ...rawEmpty.result_info, count: 1 } },
    { result_info: { ...rawEmpty.result_info, total_count: 1 } },
    { result_info: { ...rawEmpty.result_info, next_page: true } },
    { result_info: { ...rawEmpty.result_info, per_page: 0 } },
    { result_info: { ...rawEmpty.result_info, unexpected: false } },
  ];
  for (const contradiction of contradictions) {
    assert.throws(() => normalizeBuildsListPage({ ...rawEmpty, ...contradiction },
      "builds", 1), /Builds pagination metadata is malformed/u);
  }
  assert.throws(() => normalizeBuildsListPage(rawEmpty, "builds", 2),
    /Builds pagination metadata is malformed/u);
});

test("derives only coherent Custom Domains pagination metadata", () => {
  const rows = Array.from({ length: 5 }, (_, index) => ({
    hostname: `domain-${index}.invalid`, service: `worker-${index}`,
  }));
  const first = normalizeDomainListPage({ success: true, result: rows.slice(0, 3),
    result_info: { page: 1, per_page: 3, count: 3, total_count: 5 } },
  "domains page 1", 1);
  const second = normalizeDomainListPage({ success: true, result: rows.slice(3),
    result_info: { page: 2, per_page: 3, count: 2, total_count: 5 } },
  "domains page 2", 2);
  assert.equal(first.result_info.total_pages, 2);
  assert.equal(second.result_info.total_pages, 2);
  assert.equal(combineProviderPages([first, second], "domains",
    ({ hostname, service }) => `${hostname}\0${service}`).result.length, 5);
  const native = { success: true, result: rows, result_info: {
    page: 1, per_page: 5, count: 5, total_count: 5, total_pages: 1,
  } };
  assert.equal(normalizeDomainListPage(native, "domains", 1).result_info.total_pages, 1);
  assert.equal(normalizeDomainListPage({ success: true, result: [], result_info: {
    page: 1, per_page: 50, count: 0, total_count: 0,
  } }, "domains", 1).result_info.total_pages, 1);

  const driftingPageSize = [
    normalizeDomainListPage({ success: true, result: rows.concat(
      Array.from({ length: 30 }, (_, index) => ({
        hostname: `first-${index}.invalid`, service: `first-${index}`,
      }))), result_info: { page: 1, per_page: 35, count: 35, total_count: 100 } },
    "domains page 1", 1),
    normalizeDomainListPage({ success: true, result: Array.from({ length: 45 }, (_, index) => ({
      hostname: `second-${index}.invalid`, service: `second-${index}`,
    })), result_info: { page: 2, per_page: 45, count: 45, total_count: 100 } },
    "domains page 2", 2),
    normalizeDomainListPage({ success: true, result: Array.from({ length: 20 }, (_, index) => ({
      hostname: `third-${index}.invalid`, service: `third-${index}`,
    })), result_info: { page: 3, per_page: 40, count: 20, total_count: 100 } },
    "domains page 3", 3),
  ];
  assert.throws(() => combineProviderPages(driftingPageSize, "domains",
    ({ hostname, service }) => `${hostname}\0${service}`), /changed during readback/u);

  const malformed = [
    { success: true, result: rows },
    { ...native, result_info: { ...native.result_info, page: 2 } },
    { ...native, result_info: { ...native.result_info, count: 4 } },
    { ...native, result_info: { ...native.result_info, per_page: 0 } },
    { ...native, result_info: { ...native.result_info, total_count: 6 } },
    { ...native, result_info: { ...native.result_info, total_pages: 2 } },
    { ...native, result_info: { ...native.result_info, unexpected: true } },
  ];
  for (const envelope of malformed) {
    assert.throws(() => normalizeDomainListPage(envelope, "domains", 1),
      /domain pagination metadata is malformed/u);
  }
});

test("routes every Builds inventory through the empty-page adapter in each provider sweep",
  async () => {
    const workerNames = production.workers.map(({ name }) => name);
    const workerConfigs = new Map([
      ...production.workers.map((worker, index) => [worker.name, bases[index]]),
    ]);
    const workerTags = new Map(workerNames.map((name, index) =>
      [name, String(index + 1).repeat(32)]));
    const buildsReads = new Map();
    const domainReads = new Map();
    const providerPage = (result) => ({ success: true, result, errors: [], messages: [],
      result_info: { page: 1, total_pages: 1, total_count: result.length } });
    const domainRows = [
      { hostname: "publisher.invalid", service: "publisher-worker" },
      { hostname: "rendezvous.invalid", service: "rendezvous-worker" },
    ];
    const domainPage = (result) => ({ success: true, result, errors: [], messages: [],
      result_info: { page: 1, per_page: 50, count: result.length,
        total_count: result.length } });
    const coreTag = workerTags.get(production.workers[0].name);
    const driftPath = `/builds/workers/${coreTag}/builds`;
    const triggerPath = `/builds/workers/${coreTag}/triggers`;
    const fetchFixture = ({ malformedEndpoint, buildHistoryDriftAt, domainHistoryDriftAt,
      retiredReviewWorker = false, triggerRows = [], triggerHistoryDriftAt,
      triggerHistoryDriftRows = [], metadataFreeNonTriggerPath,
      localBuildsReads = new Map(), localDomainReads = new Map() } = {}) =>
      async (rawUrl, init = {}) => {
      const url = new URL(rawUrl);
      const accountPrefix = `/client/v4/accounts/${accountId}`;
      assert.equal(url.pathname.startsWith(accountPrefix), true);
      const path = url.pathname.slice(accountPrefix.length);
      let body;
      if (init.method === "POST") {
        assert.match(path, /^\/d1\/database\/[^/]+\/query$/u);
        body = { success: true, result: [{ results: [] }] };
      } else if (path === "/workers/scripts") {
        body = { success: true, result: [
          ...workerNames.map((name) => ({ id: name, tag: workerTags.get(name) })),
          ...(retiredReviewWorker ? [{ id: review.automaticReview.localValidation.workerName,
            tag: "d".repeat(32) }] : []),
        ] };
      } else if (/\/settings$/u.test(path)) {
        const name = decodeURIComponent(path.split("/")[3]);
        body = envelope({ bindings: bindings(workerConfigs.get(name)) });
      } else if (/\/subdomain$/u.test(path)) {
        body = envelope({ enabled: false, previews_enabled: false });
      } else if (/\/schedules$/u.test(path)) {
        body = envelope({ schedules: [] });
      } else if (/\/environments\/production\/routes$/u.test(path)) {
        body = envelope([]);
      } else if (/\/script-settings$/u.test(path)) {
        body = envelope({ logpush: null, tail_consumers: [] });
      } else if (/\/deployments$/u.test(path)) {
        body = envelope({ deployments: [{ versions: [{
          percentage: 100, version_id: resourceUuid,
        }] }] });
      } else if (/\/versions\/[0-9a-f-]+$/u.test(path)) {
        body = envelope({ id: resourceUuid });
      } else if (/\/versions$/u.test(path)) {
        body = malformedEndpoint === "versions"
          ? { success: true, result: { items: [] } }
          : { success: true, result: { items: [] }, result_info: {
            page: 1, count: 0, per_page: 50, total_count: 0,
          } };
      } else if (/^\/builds\/workers\/[^/]+\/(deploy_hooks|triggers|builds)$/u.test(path) ||
          path === "/builds/tokens") {
        buildsReads.set(path, (buildsReads.get(path) ?? 0) + 1);
        localBuildsReads.set(path, (localBuildsReads.get(path) ?? 0) + 1);
        const read = localBuildsReads.get(path);
        if (path === triggerPath) {
          body = { success: true,
            result: read === triggerHistoryDriftAt ? triggerHistoryDriftRows : triggerRows,
            errors: [], messages: [] };
        } else if (path === metadataFreeNonTriggerPath) {
          body = { success: true, result: [{ build_uuid: resourceUuid }],
            errors: [], messages: [] };
        } else body = path === driftPath && read === buildHistoryDriftAt
          ? providerPage([{ build_uuid: resourceUuid }])
          : { success: true, result: [], errors: [], messages: [], result_info: {
            page: 1, per_page: 200, count: 0, total_count: 0, total_pages: 0,
            next_page: false,
          } };
      } else if (/^\/builds\/triggers\/[0-9a-f-]+\/environment_variables$/u.test(path)) {
        body = envelope({});
      } else if (path === "/workers/domains") {
        domainReads.set(path, (domainReads.get(path) ?? 0) + 1);
        localDomainReads.set(path, (localDomainReads.get(path) ?? 0) + 1);
        body = malformedEndpoint === "domains"
          ? { success: true, result: [] }
          : domainPage(localDomainReads.get(path) === domainHistoryDriftAt
            ? [...domainRows, { hostname: "changed.invalid", service: "changed-worker" }]
            : domainRows);
      } else if (path === "/builds/account/limits") {
        body = envelope({ has_reached_build_minutes_limit: false });
      } else {
        assert.fail(`unexpected provider fixture path: ${path}`);
      }
      return new Response(JSON.stringify(body), { status: 200,
        headers: { "content-type": "application/json" } });
    };
    const runReadback = async (suffix, fixture) => {
      const temporary = await mkdtemp(resolve(tmpdir(), `atrinik-builds-readback-${suffix}-`));
      try {
        return await readProviderSnapshot({ accountId, token: "test-token",
          productionReadToken: "test-read-token", outputDirectory: resolve(temporary, "snapshot"),
          production, review, sourceSha: "a".repeat(40), fetchImpl: fixture });
      } finally { await rm(temporary, { recursive: true, force: true }); }
    };
    const result = await runReadback("valid", fetchFixture());
    assert.equal(result.mutation, false);
    for (const name of workerNames) {
      assert.equal(buildsReads.get(`/builds/workers/${name}/deploy_hooks`), 3);
      assert.equal(buildsReads.get(`/builds/workers/${workerTags.get(name)}/builds`), 3);
      assert.equal(buildsReads.get(`/builds/workers/${workerTags.get(name)}/triggers`), 9);
    }
    assert.equal(buildsReads.get("/builds/tokens"), 3);
    assert.equal(domainReads.get("/workers/domains"), 3);
    for (const rows of [
      [{ trigger_uuid: resourceUuid }],
      [{ trigger_uuid: resourceUuid }, { trigger_uuid: reviewTriggerUuid }],
    ]) {
      const reads = new Map();
      const bounded = await runReadback(`bounded-triggers-${rows.length}`,
        fetchFixture({ triggerRows: rows, localBuildsReads: reads }));
      assert.equal(bounded.mutation, false);
      assert.equal(reads.get(triggerPath), 9);
    }
    const orderedTriggers = [
      { trigger_uuid: resourceUuid }, { trigger_uuid: reviewTriggerUuid },
    ];
    await assert.rejects(runReadback("trigger-pass-drift", fetchFixture({
      triggerRows: orderedTriggers, triggerHistoryDriftAt: 2,
      triggerHistoryDriftRows: [...orderedTriggers].reverse(),
    })), /triggers provider inventory changed between complete passes/u);
    await assert.rejects(runReadback("trigger-sweep-drift", fetchFixture({
      triggerRows: orderedTriggers, triggerHistoryDriftAt: 7,
      triggerHistoryDriftRows: [{ trigger_uuid: "33333333-3333-4333-8333-333333333333" },
        orderedTriggers[1]],
    })), /triggers changed between complete provider sweeps/u);
    await assert.rejects(runReadback("metadata-free-non-trigger", fetchFixture({
      metadataFreeNonTriggerPath: driftPath,
    })), /Builds pagination metadata is malformed/u);
    await assert.rejects(runReadback("domains", fetchFixture({ malformedEndpoint: "domains" })),
      /domain pagination metadata is malformed/u);
    await assert.rejects(runReadback("versions", fetchFixture({ malformedEndpoint: "versions" })),
      /version pagination metadata is malformed/u);
    await assert.rejects(runReadback("retired-review-worker",
      fetchFixture({ retiredReviewWorker: true })), /retired review Worker/u);
    await assert.rejects(runReadback("pass-drift", fetchFixture({ buildHistoryDriftAt: 2 })),
      /builds provider inventory changed between complete passes/u);
    await assert.rejects(runReadback("sweep-drift", fetchFixture({ buildHistoryDriftAt: 3 })),
      /builds changed between complete provider sweeps/u);
    await assert.rejects(runReadback("domain-pass-drift",
      fetchFixture({ domainHistoryDriftAt: 2 })),
    /domains provider inventory changed between complete passes/u);
    await assert.rejects(runReadback("domain-sweep-drift",
      fetchFixture({ domainHistoryDriftAt: 3 })),
    /domains changed between complete provider sweeps/u);
  });

test("normalizes the official nested Worker versions pagination shape", () => {
  const combined = combineWorkerVersionPages([
    { success: true, result: { items: [{ id: resourceUuid }] }, result_info: {
      page: 1, count: 1, per_page: 1, total_count: 2 } },
    { success: true, result: { items: [{ id: reviewTriggerUuid }] }, result_info: {
      page: 2, count: 1, per_page: 1, total_count: 2 } },
  ]);
  assert.deepEqual(combined.result.map(({ id }) => id), [resourceUuid, reviewTriggerUuid]);
  assert.equal(combined.result_info.exhaustive, true);
  const onePage = combineWorkerVersionPages([
    { success: true, result: { items: [{ id: resourceUuid }] }, result_info: {
      page: 1, count: 1, per_page: 50, total_count: 1 } },
  ]);
  assert.deepEqual(onePage.result.map(({ id }) => id), [resourceUuid]);
  const empty = combineWorkerVersionPages([
    { success: true, result: { items: [] }, result_info: {
      page: 1, count: 0, per_page: 50, total_count: 0 } },
  ]);
  assert.deepEqual(empty.result, []);
  assert.throws(() => combineWorkerVersionPages([
    { success: true, result: [{ id: resourceUuid }], result_info: {
      page: 1, count: 1, per_page: 50, total_count: 1 } },
  ]), /version pagination metadata is malformed/u);
  assert.throws(() => combineWorkerVersionPages([
    { success: true, result: { items: [{ id: resourceUuid }] }, result_info: {
      page: 1, count: 0, per_page: 50, total_count: 1 } },
  ]), /pagination metadata is malformed/u);
  assert.throws(() => combineWorkerVersionPages([
    { success: true, result: { items: [{ id: resourceUuid }] }, result_info: {
      page: 1, count: 1, per_page: 50, total_count: 1, total_pages: 2 } },
  ]), /pagination metadata is malformed/u);
  assert.throws(() => combineWorkerVersionPages([
    { success: true, result: { items: [] }, result_info: {
      page: 1, count: 0, per_page: 1, total_count: 2 } },
    { success: true, result: { items: [{ id: resourceUuid }, { id: reviewTriggerUuid }] },
      result_info: { page: 2, count: 2, per_page: 1, total_count: 2 } },
  ]), /pagination metadata is malformed/u);
  assert.throws(() => combineWorkerVersionPages([
    { success: true, result: { items: [{ id: resourceUuid }] }, result_info: {
      page: 1, count: 1, per_page: 2, total_count: 3 } },
    { success: true, result: { items: [{ id: reviewTriggerUuid }, { id: reviewTokenUuid }] },
      result_info: { page: 2, count: 2, per_page: 2, total_count: 3 } },
  ]), /pagination metadata is malformed/u);
  assert.throws(() => combineWorkerVersionPages([
    { success: true, result: { items: [{ id: resourceUuid }, { id: reviewTriggerUuid }] },
      result_info: { page: 1, count: 2, per_page: 2, total_count: 3 } },
    { success: true, result: { items: [] }, result_info: {
      page: 2, count: 0, per_page: 2, total_count: 3 } },
  ]), /pagination metadata is malformed/u);
});

test("rejects equal-count provider replacement between complete passes", () => {
  assert.throws(() => validateStableProviderPasses(
    envelope([{ build_uuid: resourceUuid }]),
    envelope([{ build_uuid: reviewTriggerUuid }]), "builds"), /changed between complete passes/u);
});

test("requires an exact private random absent staging ref", () => {
  const { productionSentinelProof: proof } = freshBoundary();
  const reviewSentinelProof = { ...structuredClone(proof),
    branch: `review-build-only-sentinel-${"b".repeat(32)}` };
  assert.equal(validateSentinelRefAbsence(proof).outcome, "staging-sentinel-ref-absent");
  assert.doesNotThrow(() => validateDistinctSentinelRefAbsence(proof, reviewSentinelProof));
  assert.throws(() => validateDistinctSentinelRefAbsence(undefined, reviewSentinelProof),
    /repository identity drift/u);
  assert.throws(() => validateDistinctSentinelRefAbsence(proof, undefined),
    /repository identity drift/u);
  assert.throws(() => validateDistinctSentinelRefAbsence(proof, structuredClone(proof)),
    /must be distinct/u);
  assert.throws(() => validateSentinelRefAbsence({ ...proof,
    branch: "review-build-only-sentinel" }), /malformed/u);
  assert.throws(() => validateSentinelRefAbsence({ ...proof,
    refs: [{ ref: `refs/heads/${proof.branch}` }] }), /exists or its absence/u);
  assert.throws(() => validateSentinelRefAbsence({ ...proof,
    capturedAt: "2026-08-15T00:00:00Z" }, Date.parse("2026-08-15T00:06:00Z")), /stale/u);
  assert.throws(() => validateDistinctSentinelRefAbsence(proof, {
    ...reviewSentinelProof, capturedAt: "2026-08-15T00:00:00Z",
  }, Date.parse("2026-08-15T00:06:00Z")), /stale/u);
});

test("loads the private production sentinel branch and proof", async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), "atrinik-production-sentinel-"));
  await chmod(temporary, 0o700);
  const paths = Object.fromEntries(["production-branch", "production-proof"]
    .map((name) => [name, resolve(temporary, name)]));
  const boundary = freshBoundary();
  const writePrivate = async (path, value) => {
    await writeFile(path, typeof value === "string" ? `${value}\n` : `${JSON.stringify(value)}\n`);
    await chmod(path, 0o600);
  };
  const environment = {
    ATRINIK_PRODUCTION_STAGING_SENTINEL_BRANCH_FILE: paths["production-branch"],
    ATRINIK_PRODUCTION_STAGING_SENTINEL_REFS_FILE: paths["production-proof"],
  };
  try {
    await writePrivate(paths["production-branch"], boundary.productionSentinelProof.branch);
    await writePrivate(paths["production-proof"], boundary.productionSentinelProof);
    const loaded = await readProductionSentinelProof(environment);
    assert.equal(loaded.productionSentinelProof.branch,
      boundary.productionSentinelProof.branch);
    await assert.rejects(readProductionSentinelProof({ ...environment,
      ATRINIK_PRODUCTION_STAGING_SENTINEL_REFS_FILE: undefined }), /path must be absolute/u);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("requires fresh complete per-branch absence proof for a private review staging root", () => {
  const sourceSha = "a".repeat(40);
  const rootDirectory = `/review-build-only-staging-${"b".repeat(32)}`;
  const proof = {
    source: "github-complete-branch-root-absence-readback",
    phase: "create",
    repository: { provider_account_id: "6371603", provider_account_name: "atrinik",
      provider_type: "github", repo_id: "1324297032", repo_name: "metaserver-worker" },
    rootDirectory, currentMainSha: sourceSha, capturedAt: new Date().toISOString(),
    pagination: { hasNextPage: false, pageCount: 1, totalCount: 2 },
    branches: [
      { ref: "refs/heads/main", sha: sourceSha },
      { ref: "refs/heads/review/example", sha: "c".repeat(40) },
    ],
    absenceChecks: [
      { ref: "refs/heads/review/example", sha: "c".repeat(40),
        path: rootDirectory.slice(1), status: 404 },
    ],
  };
  assert.match(validateReviewStagingRootAbsence(proof, rootDirectory, sourceSha,
    "create").proof_digest,
    /^[0-9a-f]{64}$/u);
  assert.throws(() => validateReviewStagingRootAbsence(proof,
    "/deployment/review-check", sourceSha, "create"), /identity is malformed/u);
  assert.throws(() => validateReviewStagingRootAbsence({ ...proof,
    capturedAt: "2026-08-15T00:00:00Z" }, rootDirectory, sourceSha, "create",
  Date.parse("2026-08-15T00:06:00Z")), /stale/u);
  assert.throws(() => validateReviewStagingRootAbsence({ ...proof,
    currentMainSha: "d".repeat(40) }, rootDirectory, sourceSha, "create"),
  /identity is malformed/u);
  assert.throws(() => validateReviewStagingRootAbsence({ ...proof,
    absenceChecks: [] }, rootDirectory, sourceSha, "create"), /incomplete or reordered/u);
  assert.throws(() => validateReviewStagingRootAbsence({ ...proof,
    pagination: { ...proof.pagination, hasNextPage: true } }, rootDirectory, sourceSha, "create"),
  /pagination is incomplete/u);
  assert.throws(() => validateReviewStagingRootAbsence({ ...proof,
    branches: [...proof.branches, { ref: "refs/heads/other", sha: "d".repeat(40) }] },
  rootDirectory, sourceSha, "create"), /pagination is incomplete/u);
  assert.throws(() => validateReviewStagingRootAbsence(proof, rootDirectory, sourceSha,
    "activation"), /identity is malformed/u);
  const activationProof = { ...proof, phase: "activation",
    capturedAt: new Date(Date.parse(proof.capturedAt) + 1000).toISOString() };
  assert.equal(validateReviewStagingRootAbsence(activationProof, rootDirectory, sourceSha,
    "activation").phase, "activation");
  const createResult = validateReviewStagingRootAbsence(proof, rootDirectory, sourceSha, "create");
  const activationResult = validateReviewStagingRootAbsence(activationProof,
    rootDirectory, sourceSha, "activation");
  assert.equal(validateReviewStagingRootProofSequence(createResult, activationResult).outcome,
    "review-staging-root-proof-sequence-valid");
  assert.throws(() => validateReviewStagingRootProofSequence(createResult, {
    ...activationResult, capturedAt: createResult.capturedAt,
  }), /replayed/u);
});

test("requires stable canonical environment before final review trigger activation", () => {
  const rootDirectory = `/review-build-only-staging-${"b".repeat(32)}`;
  const expected = withConnection(automaticReviewTriggerSpec(review, {
    externalScriptId: scriptTag, repositoryConnectionUuid: resourceUuid,
    buildTokenUuid: reviewTokenUuid,
  }));
  expected.trigger_uuid = reviewTriggerUuid;
  expected.root_directory = rootDirectory;
  expected.build_command = "exit 1";
  expected.deploy_command = "exit 1";
  const environment = envelope(automaticReviewEnvironmentSpec(review));
  assert.match(validateReviewStagedEnvironmentReadback({ trigger: expected, environment },
    expected, review).proof_digest, /^[0-9a-f]{64}$/u);
  assert.throws(() => validateReviewStagedEnvironmentReadback({ trigger: {
    ...expected, root_directory: "/deployment/review-check",
  }, environment }, expected, review), /staged review trigger root_directory drift/u);
  assert.throws(() => validateReviewStagedEnvironmentReadback({ trigger: expected,
    environment: envelope({ SKIP_DEPENDENCY_INSTALL: { is_secret: false, value: "0" } }) },
  expected, review), /review trigger environment drift/u);
});

test("binds the staged review environment proof to both journaled triggers", async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), "atrinik-review-staged-proof-"));
  const snapshot = resolve(temporary, "snapshot");
  await chmod(temporary, 0o700);
  await mkdir(snapshot, { mode: 0o700 });
  const writePrivate = async (path, value) => {
    await writeFile(path, typeof value === "string" ? `${value}\n` :
      `${JSON.stringify(value)}\n`, { mode: 0o600 });
    await chmod(path, 0o600);
  };
  const sourceSha = "a".repeat(40);
  const boundary = freshBoundary();
  const rootDirectory = `/review-build-only-staging-${"b".repeat(32)}`;
  const productionActual = withConnection(productionTriggerSpec(production, {
    externalScriptId: scriptTag, repositoryConnectionUuid: resourceUuid,
    buildTokenUuid: reviewTokenUuid,
  }));
  productionActual.trigger_uuid = resourceUuid;
  productionActual.branch_includes = [boundary.productionSentinelProof.branch];
  const reviewActual = withConnection(automaticReviewTriggerSpec(review, {
    externalScriptId: scriptTag, repositoryConnectionUuid: resourceUuid,
    buildTokenUuid: reviewTokenUuid,
  }));
  reviewActual.trigger_uuid = reviewTriggerUuid;
  reviewActual.root_directory = rootDirectory;
  reviewActual.build_command = "exit 1";
  reviewActual.deploy_command = "exit 1";
  const now = new Date().toISOString();
  const manifest = {
    accountId, sourceSha,
    productionContractSha256: createHash("sha256").update(JSON.stringify(production)).digest("hex"),
    reviewContractSha256: createHash("sha256").update(JSON.stringify(review)).digest("hex"),
    startedAt: now, completedAt: now,
  };
  const privatePaths = Object.fromEntries([
    "production-uuid", "review-uuid", "root", "production-branch", "production-proof",
  ].map((name) => [name, resolve(temporary, name)]));
  const prior = Object.fromEntries(Object.keys(process.env).filter((name) => name.startsWith(
    "ATRINIK_")).map((name) => [name, process.env[name]]));
  const writeSnapshot = (name, value) => writePrivate(resolve(snapshot, name), value);
  try {
    await Promise.all([
      writeSnapshot("snapshot-manifest.json", manifest),
      writeSnapshot("scripts.json", envelope([{ id: production.workers[0].name,
        tag: scriptTag }])),
      writeSnapshot(`${production.workers[0].name}.triggers.json`,
        envelope([productionActual, reviewActual])),
      writeSnapshot("build-tokens.json", buildTokenInventory()),
      writeSnapshot(`${production.workers[0].name}.trigger-${reviewTriggerUuid}.environment.json`,
        envelope(automaticReviewEnvironmentSpec(review))),
      writeSnapshot("account-triggers.json", envelope([productionActual, reviewActual])),
      ...production.workers.flatMap(({ name }) => [
        writeSnapshot(`${name}.deploy-hooks.json`, envelope([])),
        writeSnapshot(`${name}.builds.json`, envelope([])),
      ]),
      ...production.workers.slice(1).map(({ name }) =>
        writeSnapshot(`${name}.triggers.json`, envelope([]))),
      writePrivate(privatePaths["production-uuid"], resourceUuid),
      writePrivate(privatePaths["review-uuid"], reviewTriggerUuid),
      writePrivate(privatePaths.root, rootDirectory),
      writePrivate(privatePaths["production-branch"], boundary.productionSentinelProof.branch),
      writePrivate(privatePaths["production-proof"], boundary.productionSentinelProof),
    ]);
    Object.assign(process.env, {
      ATRINIK_PRODUCTION_STAGED_TRIGGER_UUID_FILE: privatePaths["production-uuid"],
      ATRINIK_REVIEW_STAGED_TRIGGER_UUID_FILE: privatePaths["review-uuid"],
      ATRINIK_REVIEW_STAGING_ROOT_DIRECTORY_FILE: privatePaths.root,
      ATRINIK_PRODUCTION_STAGING_SENTINEL_BRANCH_FILE: privatePaths["production-branch"],
      ATRINIK_PRODUCTION_STAGING_SENTINEL_REFS_FILE: privatePaths["production-proof"],
    });
    const authority = reviewActivationAuthorityFixture();
    const arguments_ = { snapshotDirectory: snapshot, production, review, accountId, sourceSha,
      tokenAuthorityProofs: authority.evidence.tokenAuthorityProofs,
      reviewActivationAuthorityProof: authority.proof,
      reviewActivationAuthorityEvidence: authority.evidence };
    const accepted = await validateReviewStagedEnvironmentSnapshotDirectory(arguments_);
    assert.match(accepted.proof_digest, /^[0-9a-f]{64}$/u);

    await writePrivate(privatePaths["production-uuid"],
      "44444444-4444-4444-8444-444444444444");
    await assert.rejects(validateReviewStagedEnvironmentSnapshotDirectory(arguments_),
      /incomplete or competing/u);
    await writePrivate(privatePaths["production-uuid"], reviewTriggerUuid);
    await writePrivate(privatePaths["review-uuid"], resourceUuid);
    await assert.rejects(validateReviewStagedEnvironmentSnapshotDirectory(arguments_),
      /incomplete or competing/u);
    await writePrivate(privatePaths["production-uuid"], resourceUuid);
    await writePrivate(privatePaths["review-uuid"], resourceUuid);
    await assert.rejects(validateReviewStagedEnvironmentSnapshotDirectory(arguments_),
      /identities overlap/u);
    await writePrivate(privatePaths["review-uuid"], reviewTriggerUuid);

    await writeSnapshot(`${production.workers[0].name}.triggers.json`, envelope([{
      ...productionActual, branch_includes: ["main"],
    }, reviewActual]));
    await assert.rejects(validateReviewStagedEnvironmentSnapshotDirectory(arguments_),
      /branch_includes drift/u);
    await writeSnapshot(`${production.workers[0].name}.triggers.json`,
      envelope([productionActual, reviewActual]));
    await writeSnapshot(`${production.workers[0].name}.builds.json`, envelope([{
      build_uuid: resourceUuid, status: "running",
    }]));
    await assert.rejects(validateReviewStagedEnvironmentSnapshotDirectory(arguments_),
      /active Workers Build/u);
  } finally {
    for (const name of Object.keys(process.env).filter((key) => key.startsWith("ATRINIK_")))
      if (!(name in prior)) delete process.env[name];
    Object.assign(process.env, prior);
    await rm(temporary, { recursive: true, force: true });
  }
});

test("proves phase-aware exact rollback trigger inventory", () => {
  assert.match(validateRollbackTriggerInventory(envelope([])).proof_digest,
    /^[0-9a-f]{64}$/u);
  assert.match(validateRollbackTriggerInventory(envelope([
    { trigger_uuid: resourceUuid },
  ]), { productionTriggerUuid: resourceUuid }).proof_digest, /^[0-9a-f]{64}$/u);
  assert.match(validateRollbackTriggerInventory(envelope([
    { trigger_uuid: resourceUuid },
  ]), { productionTriggerUuid: resourceUuid,
    reviewTriggerUuid }).proof_digest, /^[0-9a-f]{64}$/u);
  assert.throws(() => validateRollbackTriggerInventory(envelope([
    { trigger_uuid: reviewTriggerUuid },
  ]), { productionTriggerUuid: resourceUuid, reviewTriggerUuid }),
  /competing or unreconciled/u);
  assert.throws(() => validateRollbackTriggerInventory(envelope([
    { trigger_uuid: resourceUuid }, { trigger_uuid: reviewTriggerUuid },
  ]), { productionTriggerUuid: resourceUuid }), /competing or unreconciled/u);
  assert.throws(() => validateRollbackTriggerInventory(envelope([
    { trigger_uuid: reviewTriggerUuid },
  ])), /competing or unreconciled/u);

  const inert = withConnection(productionTriggerSpec(production, {
    externalScriptId: scriptTag, repositoryConnectionUuid: resourceUuid,
    buildTokenUuid: reviewTokenUuid,
  }));
  inert.trigger_uuid = resourceUuid;
  inert.branch_includes = ["review-build-only-sentinel-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"];
  assert.match(validateRollbackProductionTriggerReadback(envelope([])).proof_digest,
    /^[0-9a-f]{64}$/u);
  assert.match(validateRollbackProductionTriggerReadback(envelope([inert]), {
    productionTriggerUuid: resourceUuid, expectedTrigger: inert,
  }).proof_digest, /^[0-9a-f]{64}$/u);
  assert.throws(() => validateRollbackProductionTriggerReadback(envelope([{
    ...inert, branch_includes: ["main"],
  }]), { productionTriggerUuid: resourceUuid, expectedTrigger: inert }), /branch_includes drift/u);
  assert.throws(() => validateRollbackProductionTriggerReadback(envelope([{
    ...inert, build_token_uuid: "44444444-4444-4444-8444-444444444444",
  }]), { productionTriggerUuid: resourceUuid, expectedTrigger: inert }), /build_token_uuid drift/u);
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

test("validates an exact fresh authenticated current-main proof", () => {
  const sha = "a".repeat(40);
  const now = Date.parse("2026-08-17T12:00:00.000Z");
  const proof = authenticatedCurrentMainProof(sha, "2026-08-17T11:59:00.000Z");
  assert.equal(validateCurrentMainProof(proof, sha, now), sha);
  assert.equal(validateCurrentMainProof({ ...proof,
    repository: { name: "metaserver-worker", owner: "atrinik" } }, sha, now), sha);
  assert.throws(() => validateCurrentMainProof({ ...proof,
    capturedAt: "2026-08-17T11:54:59.000Z" }, sha, now), /stale or malformed/u);
  assert.throws(() => validateCurrentMainProof({ ...proof,
    capturedAt: "2026-08-17T12:00:31.000Z" }, sha, now), /stale or malformed/u);
  assert.throws(() => validateCurrentMainProof({ ...proof,
    capturedAt: "2026-99-99T99:99:99Z" }, sha, now), /stale or malformed/u);
  assert.throws(() => validateCurrentMainProof({ ...proof,
    capturedAt: ["2026-08-17T11:59:00.000Z"] }, sha, now), /stale or malformed/u);
  assert.throws(() => validateCurrentMainProof({ ...proof,
    repository: { owner: "atrinik", name: "website" } }, sha, now), /stale or malformed/u);
  assert.throws(() => validateCurrentMainProof({ ...proof,
    ref: "refs/heads/review/example" }, sha, now), /stale or malformed/u);
  assert.throws(() => validateCurrentMainProof({ ...proof,
    endpoint: "repos/atrinik/website/git/ref/heads/main" }, sha, now), /stale or malformed/u);
  assert.throws(() => validateCurrentMainProof({ ...proof,
    sha: "b".repeat(40) }, sha, now), /stale or malformed/u);
  assert.throws(() => validateCurrentMainProof({ ...proof,
    unexpected: true }, sha, now), /stale or malformed/u);
  assert.throws(() => validateCurrentMainProof({ ...proof,
    raw: { ...proof.raw, object: { ...proof.raw.object, type: "tag" } } }, sha, now),
  /stale or malformed/u);
  assert.throws(() => validateCurrentMainProof({ ...proof,
    raw: { ...proof.raw, ref: "refs/heads/review/example" } }, sha, now),
  /stale or malformed/u);
  assert.throws(() => validateCurrentMainProof({ ...proof,
    raw: { ...proof.raw, object: { ...proof.raw.object, sha: "b".repeat(40) } } }, sha, now),
  /stale or malformed/u);
});

test("loads current-main evidence only from an owner-only regular file", async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), "atrinik-current-main-proof-"));
  const proofPath = resolve(temporary, "proof.json");
  const linkedPath = resolve(temporary, "linked-proof.json");
  const proofDirectory = resolve(temporary, "proof-directory");
  const linkedDirectory = resolve(temporary, "linked-directory");
  const sha = "a".repeat(40);
  const now = Date.parse("2026-08-17T12:00:00.000Z");
  await chmod(temporary, 0o700);
  await writeFile(proofPath, `${JSON.stringify(authenticatedCurrentMainProof(
    sha, "2026-08-17T11:59:00.000Z"))}\n`, { mode: 0o600 });
  try {
    const environment = { ATRINIK_GITHUB_CURRENT_MAIN_PROOF_FILE: proofPath };
    assert.equal((await readCurrentMainProof(environment, sha, now)).sha, sha);
    await chmod(proofPath, 0o644);
    await assert.rejects(readCurrentMainProof(environment, sha, now),
      /bounded private regular file/u);
    await chmod(proofPath, 0o600);
    await symlink(proofPath, linkedPath);
    await assert.rejects(readCurrentMainProof({
      ATRINIK_GITHUB_CURRENT_MAIN_PROOF_FILE: linkedPath,
    }, sha, now), /canonical without linked ancestors/u);
    await mkdir(proofDirectory, { mode: 0o700 });
    await writeFile(resolve(proofDirectory, "proof.json"), `${JSON.stringify(
      authenticatedCurrentMainProof(sha, "2026-08-17T11:59:00.000Z"))}\n`, { mode: 0o600 });
    await symlink(proofDirectory, linkedDirectory);
    await assert.rejects(readCurrentMainProof({
      ATRINIK_GITHUB_CURRENT_MAIN_PROOF_FILE: resolve(linkedDirectory, "proof.json"),
    }, sha, now), /canonical without linked ancestors/u);
    await assert.rejects(readCurrentMainProof({}, sha, now), /path must be absolute/u);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("gates every credentialed mode on the private current-main proof", async () => {
  assert.deepEqual(credentialedProvisioningModes, [
    "--materialize-production",
    "--readback",
    "--verify-configured",
    "--verify-preflight",
    "--verify-production-activation",
    "--verify-review-activation",
    "--verify-review-activation-authority",
    "--verify-review-activation-authority-proof",
    "--verify-review-staged-environment",
    "--verify-review-staging-root-activation",
    "--verify-review-staging-root-create",
    "--verify-staged",
    "--verify-staged-proof",
  ]);
  for (const mode of credentialedProvisioningModes) {
    let proofLoads = 0;
    const sourceSha = await credentialedSourceSha(mode, async () => {
      proofLoads += 1;
      return "a".repeat(40);
    });
    assert.equal(sourceSha, "a".repeat(40));
    assert.equal(proofLoads, 1);
    await assert.rejects(credentialedSourceSha(mode, async () => {
      throw new Error("proof stopped before provider mode");
    }), /proof stopped before provider mode/u);
  }
  assert.equal(await credentialedSourceSha("--dry-run", async () => {
    assert.fail("credential-free mode must not load a current-main proof");
  }), undefined);
  for (const mode of credentialedProvisioningModes) {
    let runtimeProofLoads = 0;
    await assert.rejects(runProvisioningCli(mode, async () => {
      runtimeProofLoads += 1;
      throw new Error("runtime proof gate stopped before provider access");
    }), /runtime proof gate stopped before provider access/u);
    assert.equal(runtimeProofLoads, 1, mode);
  }
  const writes = [];
  const stdoutWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    writes.push(String(chunk));
    return true;
  };
  try {
    for (const mode of ["--validate-only", "--dry-run", "--plan-setup"])
      await runProvisioningCli(mode, async () => assert.fail(
        `credential-free mode ${mode} must not load current-main proof`));
  } finally {
    process.stdout.write = stdoutWrite;
  }
  assert.equal(writes.length, 3);
  assert.ok(writes.every((output) =>
    /"mutation":false|workers-builds-provisioning-valid/u.test(output)));
  const implementation = await readFile(resolve(root,
    "scripts/workers-builds-provisioning.mjs"), "utf8");
  const deploymentGuide = await readFile(resolve(root, "DEPLOYMENT.md"), "utf8");
  assert.doesNotMatch(implementation,
    /fetch\([\s\S]{0,200}api\.github\.com\/repos\/atrinik\/metaserver-worker/u);
  assert.match(deploymentGuide,
    /gh api --hostname github\.com \\\n+  repos\/atrinik\/metaserver-worker\/git\/ref\/heads\/main/u);
  const gateIndex = implementation.indexOf(
    "await credentialedSourceSha(mode, sourceShaLoader)");
  assert.notEqual(gateIndex, -1);
  assert.ok(gateIndex < implementation.indexOf('if (mode === "--readback")'));
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

test("binds fresh owner evidence into one bounded review activation phase", () => {
  const { proof, evidence } = reviewActivationAuthorityFixture();
  const captured = Date.parse(proof.capturedAt);
  const arguments_ = { production, review, accountId, sourceSha: "a".repeat(40),
    ...evidence };
  assert.equal(validateReviewActivationAuthority(proof, arguments_, captured + 10 * 60_000)
    .proof_digest, proof.proof_digest);
  assert.throws(() => validateReviewActivationAuthority(proof, arguments_,
    captured + 26 * 60_000), /stale, malformed, or cross-phase/u);
  assert.throws(() => validateReviewActivationAuthority({ ...proof, phase: "production" },
    arguments_, captured), /cross-phase/u);
  assert.throws(() => validateReviewActivationAuthority(proof, { ...arguments_,
    buildUsageProof: { ...evidence.buildUsageProof, monthlyMinutesUsed: 1 } }, captured),
  /evidence binding drift/u);
  const replayed = { ...proof, stagedSnapshot: { ...proof.stagedSnapshot,
    proofDigest: "0".repeat(64) } };
  assert.throws(() => validateReviewActivationAuthority(replayed, arguments_, captured),
    /cross-phase/u);
  const staleStaged = structuredClone(evidence);
  staleStaged.stagedProof.capturedAt = new Date(captured - 6 * 60_000).toISOString();
  staleStaged.stagedProof.snapshotStartedAt = staleStaged.stagedProof.capturedAt;
  staleStaged.stagedProof.snapshotCompletedAt = staleStaged.stagedProof.capturedAt;
  assert.throws(() => issueReviewActivationAuthority({ production, review, accountId,
    sourceSha: "a".repeat(40), ...staleStaged,
    currentStagedProof: staleStaged.stagedProof, tokenRows: {
      production: { cloudflare_token_id: "production-token-id" },
      review: { cloudflare_token_id: "review-token-id" },
    } }, captured), /staged activation proof/u);
  const futureStaged = structuredClone(evidence);
  futureStaged.stagedProof.capturedAt = new Date(captured + 31_000).toISOString();
  futureStaged.stagedProof.snapshotStartedAt = futureStaged.stagedProof.capturedAt;
  futureStaged.stagedProof.snapshotCompletedAt = futureStaged.stagedProof.capturedAt;
  assert.throws(() => issueReviewActivationAuthority({ production, review, accountId,
    sourceSha: "a".repeat(40), ...futureStaged,
    currentStagedProof: futureStaged.stagedProof, tokenRows: {
      production: { cloudflare_token_id: "production-token-id" },
      review: { cloudflare_token_id: "review-token-id" },
    } }, captured), /staged activation proof/u);
  const rewrittenTiming = structuredClone(evidence);
  rewrittenTiming.stagedProof.snapshotStartedAt = new Date(captured - 1_000).toISOString();
  assert.throws(() => issueReviewActivationAuthority({ production, review, accountId,
    sourceSha: "a".repeat(40), ...rewrittenTiming,
    currentStagedProof: evidence.stagedProof, tokenRows: {
      production: { cloudflare_token_id: "production-token-id" },
      review: { cloudflare_token_id: "review-token-id" },
    } }, captured), /staged activation proof/u);
  const staleEvidence = structuredClone(evidence);
  staleEvidence.tokenAuthorityProofs[0].capturedAt = new Date(captured - 6 * 60_000)
    .toISOString();
  assert.throws(() => issueReviewActivationAuthority({ production, review, accountId,
    sourceSha: "a".repeat(40), ...staleEvidence,
    currentStagedProof: staleEvidence.stagedProof, tokenRows: {
      production: { cloudflare_token_id: "production-token-id" },
      review: { cloudflare_token_id: "review-token-id" },
    } }, captured), /token permission proof drift/u);
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

test("permits only the exact absent-trigger initial production predecessor", () => {
  const predecessorBases = bases.map((config, index) =>
    initialBootstrapPredecessorConfiguration(production, config, production.workers[index]));
  const predecessorSnapshots = predecessorBases.map(snapshot);
  assert.throws(() => materializeProductionConfigurations({
    contract: production, bases, snapshots: predecessorSnapshots, accountId,
  }), /binding inventory drift/u);
  const configurations = materializeProductionConfigurations({
    contract: production, bases, snapshots: predecessorSnapshots, accountId,
    initialBootstrapPredecessor: true,
  });
  assert.equal(configurations[0].vars.CLASSIC_DIRECTORY_CUTOVER_MODE, "v4-production");

  const unexpectedMissing = structuredClone(predecessorSnapshots);
  unexpectedMissing[0].settings.result.bindings = unexpectedMissing[0].settings.result.bindings
    .filter(({ name }) => name !== "PUBLISH_ENABLED");
  assert.throws(() => materializeProductionConfigurations({
    contract: production, bases, snapshots: unexpectedMissing, accountId,
    initialBootstrapPredecessor: true,
  }), /binding inventory drift/u);
  const unexpectedExtra = structuredClone(predecessorSnapshots);
  unexpectedExtra[0].settings.result.bindings.push({
    name: "CLASSIC_DIRECTORY_CUTOVER_MODE", type: "plain_text", text: "v4-production",
  });
  assert.throws(() => materializeProductionConfigurations({
    contract: production, bases, snapshots: unexpectedExtra, accountId,
    initialBootstrapPredecessor: true,
  }), /binding inventory drift/u);
  const unexpectedChanged = structuredClone(predecessorSnapshots);
  one(unexpectedChanged[0].settings.result.bindings, "PUBLISH_ENABLED").text = "disabled";
  assert.throws(() => materializeProductionConfigurations({
    contract: production, bases, snapshots: unexpectedChanged, accountId,
    initialBootstrapPredecessor: true,
  }), /plain-text binding PUBLISH_ENABLED drift/u);
  assert.throws(() => materializeProductionConfigurations({
    contract: production, bases, snapshots: bases.map(snapshot), accountId,
    initialBootstrapPredecessor: true,
  }), /binding inventory drift/u);
  const changedContract = structuredClone(production);
  changedContract.initialBootstrapPredecessor.allowedBindingDelta[0].desired = "wrong";
  assert.throws(() => initialBootstrapPredecessorConfiguration(
    changedContract, bases[0], production.workers[0]), /binding delta drift/u);

  const labels = production.workers.map(({ role, name }) => [role, name]);
  const boundary = {
    production,
    review,
    scripts: envelope(production.workers.map(({ name }) => ({ id: name, tag: scriptTag }))),
    triggers: labels.map(([role]) => [role, envelope([])]),
    deployHooks: labels.map(([role]) => [role, envelope([])]),
    builds: labels.map(([role]) => [role, envelope([])]),
    buildTokens: envelope([]),
    accountTriggers: envelope([]),
  };
  assert.equal(validateInitialBootstrapSnapshot(boundary).mutation, false);
  const reviewPresent = structuredClone(boundary);
  reviewPresent.scripts.result.push({ id: review.automaticReview.localValidation.workerName,
    tag: "d".repeat(32) });
  assert.throws(() => validateInitialBootstrapSnapshot(reviewPresent), /retired review Worker/u);
  const triggerPresent = structuredClone(boundary);
  triggerPresent.triggers[0][1].result.push({ trigger_uuid: resourceUuid });
  triggerPresent.triggers[0][1].result_info.total_count = 1;
  assert.throws(() => validateInitialBootstrapSnapshot(triggerPresent), /trigger makes/u);
  const tokenPresent = structuredClone(boundary);
  tokenPresent.buildTokens = envelope([{ build_token_name: "Atrinik metaserver production" }]);
  assert.throws(() => validateInitialBootstrapSnapshot(tokenPresent), /reserved build token/u);
  const hookPresent = structuredClone(boundary);
  hookPresent.deployHooks[0][1] = envelope([{ id: resourceUuid }]);
  assert.throws(() => validateInitialBootstrapSnapshot(hookPresent), /gained a Deploy Hook/u);
  const buildPresent = structuredClone(boundary);
  buildPresent.builds[0][1] = envelope([{ build_uuid: resourceUuid, status: "running" }]);
  assert.throws(() => validateInitialBootstrapSnapshot(buildPresent), /active Workers Build/u);
  const accountTriggerPresent = structuredClone(boundary);
  accountTriggerPresent.accountTriggers = envelope([{
    trigger_uuid: resourceUuid,
    repo_connection: {
      provider_type: "github", provider_account_id: "6371603", repo_id: "1324297032",
    },
  }]);
  assert.throws(() => validateInitialBootstrapSnapshot(accountTriggerPresent),
    /repository trigger/u);
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
  const providerDefault = structuredClone(snapshots);
  for (const value of providerDefault) value.settings.result.observability.head_sampling_rate = 1;
  assert.doesNotThrow(() => validateProductionControlPlane({
    contract: production, configurations, snapshots: providerDefault, domains,
  }));
  const wrongProviderDefault = structuredClone(providerDefault);
  wrongProviderDefault[0].settings.result.observability.head_sampling_rate = 0.5;
  assert.throws(() => validateProductionControlPlane({
    contract: production, configurations, snapshots: wrongProviderDefault, domains,
  }), /observability configuration/u);
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
  const liveConfigurations = configurations.map((config, index) =>
    initialBootstrapPredecessorConfiguration(production, config, production.workers[index]));
  const predecessorActiveVersions = liveConfigurations.map((config, index) => envelope({
    id: versionIds[index], resources: { bindings: bindings(config), script_runtime: {
      compatibility_date: config.compatibility_date,
      compatibility_flags: config.compatibility_flags ?? [], exports: configurations[index].exports ?? {},
    } },
  }));
  assert.doesNotThrow(() => validateProductionRuntimeProof({ contract: production,
    configurations, liveConfigurations, deployments, activeVersions: predecessorActiveVersions,
    migrationEnvelope: envelope([{ results: migrationNames.slice(0, 9)
      .map((name, index) => ({ id: index + 1, name })) }]), migrationNames }));
  assert.throws(() => validateProductionRuntimeProof({ contract: production,
    configurations, deployments, activeVersions: predecessorActiveVersions,
    migrationEnvelope: envelope([{ results: migrationNames.slice(0, 9)
      .map((name, index) => ({ id: index + 1, name })) }]), migrationNames }),
  /binding inventory/u);
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
  assert.deepEqual(reviewSpec.branch_excludes, ["main"]);
  assert.equal(reviewSpec.external_script_id, productionSpec.external_script_id);
  assert.equal(reviewSpec.root_directory, "/deployment/review-check");
  assert.equal(reviewSpec.build_command, "npm run build");
  assert.equal(Buffer.byteLength(reviewSpec.build_command, "utf8"), 13);
  assert.equal(reviewSpec.deploy_command, "npm run validate");
  assert.doesNotThrow(() => validateTriggerSnapshot(withConnection(productionSpec),
    productionSpec, "production"));
  assert.doesNotThrow(() => validateTriggerSnapshot(withConnection(reviewSpec),
    reviewSpec, "review"));
  const changed = withConnection(reviewSpec);
  changed.branch_excludes = [];
  assert.throws(() => validateTriggerSnapshot(changed, reviewSpec, "review"), /branch_excludes/u);
  const relativeRoot = withConnection(reviewSpec);
  relativeRoot.root_directory = "deployment/review-check";
  assert.throws(() => validateTriggerSnapshot(relativeRoot, reviewSpec, "review"),
    /root_directory/u);
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
  }, review), /trigger environment/u);
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
  assert.equal(result.reviewPersistentWorkerCount, 0);
  const scriptsWithReview = structuredClone(envelope(production.workers.map(({ name }, index) =>
    ({ id: name, tag: String(index + 1).repeat(32) }))));
  scriptsWithReview.result.push({ id: review.automaticReview.localValidation.workerName,
    tag: "d".repeat(32) });
  assert.throws(() => validateFreshBuildsSnapshot({
    ...freshBoundary(),
    production, review, scripts: scriptsWithReview,
    triggers: projects.map((label) => [label, envelope([])]),
    deployHooks: projects.map((label) => [label, envelope([])]),
    builds: projects.map((label) => [label, envelope([])]),
  }), /retired review Worker/u);
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
  assert.deepEqual(provisioningDryRunSummary(production, review).gates, plan.gates);
  assert.equal(plan.mutation, false);
  assert.equal(plan.providerTopology.mode, "one-worker-two-triggers");
  assert.equal(plan.retainedFailedRequest.error, 12002);
  assert.equal(plan.retainedFailedRequest.disposition, "forbidden-never-retry-or-vary");
  assert.equal(plan.retainedRejectedPreviewRequest.error, 12002);
  assert.equal(plan.retainedRejectedPreviewRequest.topology,
    "one-worker-two-triggers-private-sentinel-preview");
  assert.equal(plan.retainedRejectedPreviewRequest.disposition,
    "forbidden-never-retry-or-normalize");
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
  assert.equal(triggerCreates.length, 1);
  const productionStaged = triggerCreates.find(({ id }) => id === "production-trigger-staged");
  assert.deepEqual(productionStaged.request.body.branch_includes,
    [{ privateFileEnvironment: "ATRINIK_PRODUCTION_STAGING_SENTINEL_BRANCH_FILE" }]);
  assert.equal(productionStaged.precondition.productionSentinelProof.resultReference,
    "sentinel-recheck-before-production-trigger.proof_digest");
  assert.equal(plan.setupOperations.find(({ id }) => id === "production-environment")
    .precondition.productionSentinelProof.resultReference,
    "sentinel-recheck-before-production-environment.proof_digest");
  assert.equal(productionStaged.request.body.build_token_uuid.resultReference,
    "review-build-token.build_token_uuid");
  assert.equal(plan.setupOperations.some(({ id }) => id === "review-trigger-staged"), false);
  const reviewOperation = (id) => plan.reviewActivation.operations.find(
    (operation) => operation.id === id);
  const reviewAuthority = reviewOperation("review-activation-authority");
  const reviewRootProof = reviewOperation("review-root-recheck-before-trigger");
  const reviewCreate = reviewOperation("review-trigger-create");
  const reviewEnvironment = reviewOperation("review-environment");
  const reviewEnvironmentReadback = reviewOperation(
    "review-environment-readback-before-activation");
  const reviewActivationRootProof = reviewOperation("review-root-recheck-before-activation");
  const reviewActivate = reviewOperation("review-trigger-activate");
  assert.equal(reviewAuthority.command,
    "npm run provision:workers-builds:verify-review-activation-authority");
  assert.equal(reviewRootProof.precondition.reviewActivationAuthority.proof.resultReference,
    "review-activation-authority.proof_digest");
  assert.equal(reviewCreate.precondition.reviewActivationAuthority.minimumRemainingSeconds, 300);
  assert.equal(reviewCreate.precondition.reviewActivationAuthority.command,
    "npm run provision:workers-builds:verify-review-activation-authority-proof");
  assert.equal(reviewRootProof.id, "review-root-recheck-before-trigger");
  assert.equal(reviewCreate.id, "review-trigger-create");
  assert.equal(reviewCreate.request.method, "POST");
  assert.deepEqual(reviewCreate.request.body.branch_includes,
    review.automaticReview.previewBranchIncludes);
  assert.deepEqual(reviewCreate.request.body.root_directory,
    { privateFileEnvironment: "ATRINIK_REVIEW_STAGING_ROOT_DIRECTORY_FILE" });
  assert.equal(reviewCreate.request.body.build_command, "exit 1");
  assert.equal(reviewCreate.request.body.deploy_command, "exit 1");
  assert.equal(reviewCreate.precondition.reviewRootProof.resultReference,
    "review-root-recheck-before-trigger.proof_digest");
  assert.equal(reviewCreate.request.body.build_token_uuid.resultReference,
    "review-build-token.build_token_uuid");
  assert.deepEqual(reviewEnvironment.request.path, {
    template: "/builds/triggers/{trigger_uuid}/environment_variables",
    resultReference: "review-trigger-create.trigger_uuid",
  });
  assert.equal(reviewEnvironmentReadback.id,
    "review-environment-readback-before-activation");
  assert.equal(reviewEnvironmentReadback.command,
    "npm run provision:workers-builds:verify-review-staged-environment");
  assert.equal(reviewEnvironmentReadback.stability,
    "two-complete-identical-passes-plus-final-identical-sweep");
  assert.equal(reviewActivationRootProof.id, "review-root-recheck-before-activation");
  assert.equal(reviewActivate.id, "review-trigger-activate");
  assert.equal(reviewActivate.request.method, "PATCH");
  assert.deepEqual(reviewActivate.request.path, {
    template: "/builds/triggers/{trigger_uuid}",
    resultReference: "review-trigger-create.trigger_uuid",
  });
  assert.equal(reviewActivate.request.body.root_directory, "/deployment/review-check");
  assert.equal(reviewActivate.precondition.reviewRootProof.resultReference,
    "review-root-recheck-before-activation.proof_digest");
  assert.equal(reviewActivate.precondition.reviewEnvironmentProof.resultReference,
    "review-environment-readback-before-activation.proof_digest");
  assert.deepEqual(plan.productionActivation.request.body.branch_includes, ["main"]);
  assert.equal(plan.productionActivation.request.body.build_token_uuid.resultReference,
    "production-build-token.build_token_uuid");
  assert.equal(plan.productionActivation.request.method, "PATCH");
  assert.deepEqual(plan.productionActivation.request.path, {
    template: "/builds/triggers/{trigger_uuid}",
    resultReference: "production-trigger-staged.trigger_uuid",
  });
  assert.equal(plan.productionActivation.request.body.root_directory, "/");
  assert.equal(plan.productionActivation.preconditionOperations[0].id,
    "production-activation-readback");
  assert.equal(plan.productionActivation.preconditionOperations[1].id,
    "sentinel-recheck-before-production-activation");
  assert.equal(plan.productionActivation.precondition.productionSentinelProof.resultReference,
    "sentinel-recheck-before-production-activation.proof_digest");
  assert.equal(plan.productionActivation.precondition.productionProof.resultReference,
    "production-activation-readback.proof_digest");
  assert.match(plan.productionActivation.initialGate, /fails-closed/u);
  assert.deepEqual(plan.credentialAuthority.productionLeaseToken.accountPermissions,
    ["Workers Builds Configuration:Edit"]);
  assert.deepEqual(plan.credentialAuthority.controlPlaneOperator.providerAccountPermissions,
    ["Workers Builds Configuration:Edit", "Workers Scripts:Read"]);
  assert.equal(plan.credentialAuthority.controlPlaneOperator.contractPermission,
    "Workers CI Write");
  assert.equal(plan.credentialAuthority.reviewBuildToken.productionWrite, false);
  assert.ok(plan.credentialAuthority.productionBuildToken.forbiddenAuthority.includes("D1:Edit"));
  assert.match(plan.partialFailure.policy, /ambiguous-response/u);
  assert.match(plan.partialFailure.productionWorkerPolicy, /never-delete/u);
  const productionRollback = plan.rollbackOperations.find(({ id }) =>
    id === "restore-production-trigger-to-inert-sentinel");
  assert.match(productionRollback.condition, /only-if-production-trigger-staged/u);
  assert.equal(productionRollback.precondition.productionSentinelProof.resultReference,
    "sentinel-recheck-before-production-rollback.proof_digest");
  assert.deepEqual(productionRollback.request.body.branch_includes,
    [{ privateFileEnvironment: "ATRINIK_PRODUCTION_STAGING_SENTINEL_BRANCH_FILE" }]);
  assert.equal(productionRollback.request.body.build_token_uuid.resultReference,
    "review-build-token.build_token_uuid");
  assert.equal(plan.rollbackOperations.some(({ id }) =>
    id === "restore-review-trigger-to-inert-sentinel"), false);
  assert.ok(plan.rollbackOperations.findIndex(({ id }) =>
    id === "delete-review-trigger-before-quiescence") <
    plan.rollbackOperations.findIndex(({ id }) =>
      id === "restore-production-trigger-to-inert-sentinel"));
  assert.ok(plan.rollbackOperations.findIndex(({ id }) =>
    id === "delete-review-trigger-before-quiescence") <
    plan.rollbackOperations.findIndex(({ id }) => id === "prove-rollback-quiescence"));
  const productionInertReadback = plan.rollbackOperations.find(({ id }) =>
    id === "prove-production-trigger-inert-before-quiescence");
  assert.equal(productionInertReadback.validator,
    "validateRollbackProductionTriggerReadback");
  assert.equal(plan.rollbackOperations.find(({ id }) =>
    id === "prove-rollback-quiescence").precondition.productionInertProof.resultReference,
  "prove-production-trigger-inert-before-quiescence.proof_digest");
  assert.ok(plan.rollbackOperations.findIndex(({ id }) =>
    id === "restore-production-trigger-to-inert-sentinel") <
    plan.rollbackOperations.findIndex(({ id }) =>
      id === "prove-production-trigger-inert-before-quiescence"));
  assert.ok(plan.rollbackOperations.findIndex(({ id }) =>
    id === "prove-production-trigger-inert-before-quiescence") <
    plan.rollbackOperations.findIndex(({ id }) => id === "prove-rollback-quiescence"));
  assert.ok(plan.rollbackOperations.findIndex(({ id }) => id === "prove-rollback-quiescence") <
    plan.rollbackOperations.findIndex(({ id }) => id === "delete-production-trigger"));
  assert.equal(plan.rollbackOperations.at(-1).action,
    "prove-three-production-workers-and-website-app-selection-unchanged");
  assert.match(plan.rollbackOperations.find(({ id }) =>
    id === "retain-repository-connection").action, /retain-shared/u);
  const requestPaths = plan.setupOperations.flatMap(({ request }) => request ?
    [typeof request.path === "string" ? request.path : JSON.stringify(request.path)] : []);
  assert.ok(requestPaths.some((path) => path.includes("environment_variables") &&
    path.includes("trigger_uuid")));
  assert.ok(requestPaths.every((path) => !path.includes("deploy_hooks") &&
    !path.includes("/builds/builds")));
  assert.ok(plan.privateInputs.every((name) => name.endsWith("_FILE")));
  assert.ok(plan.privateInputs.includes("ATRINIK_GITHUB_CURRENT_MAIN_PROOF_FILE"));
  assert.equal(plan.privateInputs.includes("ATRINIK_REVIEW_BOOTSTRAP_API_TOKEN_FILE"), false);
  assert.ok(plan.privateInputs.includes("ATRINIK_PRODUCTION_STAGING_SENTINEL_REFS_FILE"));
  assert.equal(plan.privateInputs.includes("ATRINIK_REVIEW_STAGING_SENTINEL_REFS_FILE"), false);
  assert.ok(plan.privateInputs.includes("ATRINIK_REVIEW_STAGING_ROOT_DIRECTORY_FILE"));
  assert.ok(plan.privateInputs.includes("ATRINIK_REVIEW_STAGING_ROOT_CREATE_PROOF_FILE"));
  assert.ok(plan.privateInputs.includes("ATRINIK_REVIEW_STAGING_ROOT_ACTIVATION_PROOF_FILE"));
  assert.ok(plan.privateInputs.includes(
    "ATRINIK_REVIEW_STAGED_ENVIRONMENT_PROOF_OUTPUT_FILE"));
  assert.ok(plan.privateInputs.includes(
    "ATRINIK_REVIEW_ACTIVATION_AUTHORITY_PROOF_OUTPUT_FILE"));
  assert.ok(plan.privateInputs.includes("ATRINIK_REVIEW_ACTIVATION_AUTHORITY_PROOF_FILE"));
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
  const rejectedTwoWorkerTopology = structuredClone(plan);
  rejectedTwoWorkerTopology.reviewActivation.operations.find(({ id }) =>
    id === "review-trigger-create").request.body.external_script_id =
      { resultReference: "review-bootstrap.script_tag" };
  assert.throws(() => validateSetupPlan(rejectedTwoWorkerTopology), /dangling or forward/u);
  const forgotten12002 = structuredClone(plan);
  forgotten12002.retainedFailedRequest.disposition = "retry";
  assert.throws(() => validateSetupPlan(forgotten12002), /retained failure constraint/u);
  const normalizedPreview = structuredClone(plan);
  normalizedPreview.retainedRejectedPreviewRequest.disposition = "normalize";
  assert.throws(() => validateSetupPlan(normalizedPreview), /retained failure constraint/u);
  const unsafeActivation = structuredClone(plan);
  unsafeActivation.productionActivation.request.method = "DELETE";
  assert.throws(() => validateSetupPlan(unsafeActivation), /complete setup plan schema drift/u);
  const missingStagedEdge = structuredClone(plan);
  delete missingStagedEdge.reviewActivation.precondition;
  assert.throws(() => validateSetupPlan(missingStagedEdge), /complete setup plan schema drift/u);
  const rollbackDrift = structuredClone(plan);
  rollbackDrift.rollbackOperations.pop();
  assert.throws(() => validateSetupPlan(rollbackDrift), /rollback operation set/u);
  const missingRollbackProof = structuredClone(plan);
  delete missingRollbackProof.rollbackOperations.find(({ id }) =>
    id === "restore-production-trigger-to-inert-sentinel").precondition;
  assert.throws(() => validateSetupPlan(missingRollbackProof), /complete setup plan schema drift/u);
  const missingProductionInertReadback = structuredClone(plan);
  missingProductionInertReadback.rollbackOperations =
    missingProductionInertReadback.rollbackOperations.filter(({ id }) =>
      id !== "prove-production-trigger-inert-before-quiescence");
  assert.throws(() => validateSetupPlan(missingProductionInertReadback),
    /rollback operation set/u);
  const missingReviewCreate = structuredClone(plan);
  missingReviewCreate.reviewActivation.operations = missingReviewCreate.reviewActivation.operations
    .filter(({ id }) => id !== "review-trigger-create");
  assert.throws(() => validateSetupPlan(missingReviewCreate),
    /review activation operation set/u);
  const unsafeReviewCreate = structuredClone(plan);
  unsafeReviewCreate.reviewActivation.operations.find(({ id }) =>
    id === "review-trigger-create").request.body.root_directory = "/deployment/review-check";
  assert.throws(() => validateSetupPlan(unsafeReviewCreate), /complete setup plan schema drift/u);
  const missingReviewRootProof = structuredClone(plan);
  delete missingReviewRootProof.reviewActivation.operations.find(({ id }) =>
    id === "review-trigger-activate").precondition;
  assert.throws(() => validateSetupPlan(missingReviewRootProof),
    /complete setup plan schema drift/u);
  const missingReviewEnvironmentProof = structuredClone(plan);
  delete missingReviewEnvironmentProof.reviewActivation.operations.find(({ id }) =>
    id === "review-trigger-activate").precondition.reviewEnvironmentProof;
  assert.throws(() => validateSetupPlan(missingReviewEnvironmentProof),
    /complete setup plan schema drift/u);
  const missingReviewAuthority = structuredClone(plan);
  delete missingReviewAuthority.reviewActivation.operations.find(({ id }) =>
    id === "review-trigger-create").precondition.reviewActivationAuthority;
  assert.throws(() => validateSetupPlan(missingReviewAuthority),
    /complete setup plan schema drift/u);
  const insufficientReviewAuthorityBudget = structuredClone(plan);
  insufficientReviewAuthorityBudget.reviewActivation.operations.find(({ id }) =>
    id === "review-trigger-activate").precondition.reviewActivationAuthority
    .minimumRemainingSeconds = 0;
  assert.throws(() => validateSetupPlan(insufficientReviewAuthorityBudget),
    /complete setup plan schema drift/u);
  const unsafeRollbackOrder = structuredClone(plan);
  [unsafeRollbackOrder.rollbackOperations[0], unsafeRollbackOrder.rollbackOperations[1]] =
    [unsafeRollbackOrder.rollbackOperations[1], unsafeRollbackOrder.rollbackOperations[0]];
  assert.throws(() => validateSetupPlan(unsafeRollbackOrder), /rollback operation set/u);
  const missingReviewDeletionReadback = structuredClone(plan);
  missingReviewDeletionReadback.rollbackOperations =
    missingReviewDeletionReadback.rollbackOperations.filter(({ id }) =>
      id !== "prove-review-trigger-deleted-before-quiescence");
  assert.throws(() => validateSetupPlan(missingReviewDeletionReadback),
    /rollback operation set/u);
  const wrongRollbackUuid = structuredClone(plan);
  wrongRollbackUuid.rollbackOperations.find(({ id }) =>
    id === "delete-review-trigger-before-quiescence").request.path.resultReference =
      "production-trigger-staged.trigger_uuid";
  assert.throws(() => validateSetupPlan(wrongRollbackUuid), /complete setup plan schema drift/u);
  const missingActivationProof = structuredClone(plan);
  delete missingActivationProof.productionActivation.precondition.productionSentinelProof;
  assert.throws(() => validateSetupPlan(missingActivationProof), /complete setup plan schema drift/u);
  const reorderedActivationProof = structuredClone(plan);
  reorderedActivationProof.productionActivation.preconditionOperations.reverse();
  assert.throws(() => validateSetupPlan(reorderedActivationProof),
    /production activation proof operation set/u);
});

test("proves one serialized production trigger and one isolated review trigger", () => {
  const productionSpec = withConnection(productionTriggerSpec(production, triggerCoordinates()));
  const reviewSpec = withConnection(automaticReviewTriggerSpec(review, {
    externalScriptId: scriptTag,
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
    scripts: envelope([{ id: production.workers[0].name, tag: scriptTag }]),
    productionTriggers: envelope([productionSpec, reviewSpec]),
    productionEnvironment: envelope(productionEnvironment),
    reviewTriggers: envelope([productionSpec, reviewSpec]),
    reviewEnvironment: envelope(automaticEnvironment),
    buildTokens: buildTokenInventory(),
    nonEntrypointTriggers: production.workers.slice(1)
      .map(({ role }) => [role, envelope([])]),
    deployHooks: production.workers.map(({ role }) => role)
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
    (value) => { value.reviewBuildState.builds.result.push({
      build_uuid: resourceUuid, status: "running" });
      value.reviewBuildState.builds.result_info.total_count = 1; },
    (value) => value.reviewBuildState.buildLimits.result.has_reached_build_minutes_limit = true,
    (value) => { value.reviewBuildState.buildLimits.result.has_reached_build_minutes_limit = null; },
    (value) => { value.reviewBuildState.buildUsageProof.monthlyMinutesUsed = 800; },
    (value) => value.tokenAuthorityProofs[1].accountPermissions.push("Workers Scripts:Edit"),
    (value) => { value.tokenAuthorityProofs[1].capturedAt = "2026-08-15T00:00:00.000Z"; },
    (value) => { value.tokenAuthorityProofs[1].modifiedOn = "2999-01-01T00:00:00.000Z"; },
    (value) => { value.tokenAuthorityProofs[1].accountId = "b".repeat(32); },
    (value) => { value.tokenAuthorityProofs[1].sourceSha = "b".repeat(40); },
    (value) => { value.accountTriggers.result.push({
      trigger_uuid: "55555555-5555-4555-8555-555555555555",
      repo_connection: productionSpec.repo_connection });
      value.accountTriggers.result_info.total_count = 3; },
    (value) => value.scripts.result.push({ id: review.automaticReview.localValidation.workerName,
      tag: "d".repeat(32) }),
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
    scripts: envelope([{ id: production.workers[0].name, tag: scriptTag }]),
    productionTriggers: envelope([productionSpec, reviewSpec]),
    productionEnvironment: envelope(productionEnvironment),
    reviewTriggers: envelope([productionSpec, reviewSpec]),
    reviewEnvironment: envelope(automaticEnvironment),
    buildTokens: reusedTokens,
    nonEntrypointTriggers: production.workers.slice(1).map(({ role }) => [role, envelope([])]),
    deployHooks: production.workers.map(({ role }) => role)
      .map((label) => [label, envelope([])]),
  }), /reuse one underlying/u);

  assert.throws(() => validateConfiguredBuildsSnapshot({
    ...configuredBoundary(productionSpec, reviewSpec),
    production,
    review,
    scripts: envelope([{ id: production.workers[0].name, tag: scriptTag }]),
    productionTriggers: envelope([productionSpec, reviewSpec]),
    productionEnvironment: envelope(productionEnvironment),
    reviewTriggers: envelope([productionSpec, reviewSpec]),
    reviewEnvironment: envelope(automaticEnvironment),
    buildTokens: buildTokenInventory(),
    nonEntrypointTriggers: [["publisher", envelope([productionSpec])],
      ["rendezvous", envelope([])]],
    deployHooks: production.workers.map(({ role }) => role)
      .map((label) => [label, envelope([])]),
  }), /independent Builds trigger/u);
  assert.throws(() => validateConfiguredBuildsSnapshot({
    ...configuredBoundary(productionSpec, reviewSpec),
    production, review, scripts: envelope([{ id: production.workers[0].name, tag: scriptTag }]),
    productionTriggers: envelope([productionSpec, reviewSpec]),
    productionEnvironment: envelope(productionEnvironment),
    reviewTriggers: envelope([productionSpec, reviewSpec]),
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

test("proves only the production trigger is inert before review activation", () => {
  const { productionSentinelProof } = freshBoundary();
  const productionSpec = withConnection(productionTriggerSpec(production, {
    ...triggerCoordinates(), buildTokenUuid: reviewTokenUuid,
  }));
  productionSpec.branch_includes = [productionSentinelProof.branch];
  const values = Object.fromEntries(Object.values(production.protectedInputs)
    .map((name) => [name, `${name}-value`]));
  const productionEnvironment = productionEnvironmentSpec(production, values);
  for (const name of Object.values(production.protectedInputs))
    productionEnvironment[name].value = null;
  const arguments_ = {
    ...configuredBoundary(productionSpec, productionSpec), production, review,
    productionSentinelProof,
    snapshotManifest: freshSnapshotManifest(),
    scripts: envelope([{ id: production.workers[0].name, tag: scriptTag }]),
    productionTriggers: envelope([productionSpec]),
    productionEnvironment: envelope(productionEnvironment),
    reviewTriggers: envelope([productionSpec]),
    reviewEnvironment: undefined,
    nonEntrypointTriggers: production.workers.slice(1)
      .map(({ role }) => [role, envelope([])]),
    buildTokens: buildTokenInventory(),
    deployHooks: production.workers.map(({ role }) => role)
      .map((label) => [label, envelope([])]),
    builds: production.workers.map(({ role }) => [role, envelope([])]),
  };
  arguments_.accountTriggers = envelope([productionSpec]);
  const stagedProof = validateStagedBuildsSnapshot(arguments_);
  assert.equal(stagedProof.stagedTriggerCount, 1);
  assert.equal(stagedProof.snapshotStartedAt, arguments_.snapshotManifest.startedAt);
  assert.equal(stagedProof.snapshotCompletedAt, arguments_.snapshotManifest.completedAt);
  assert.match(stagedProof.proof_digest, /^[0-9a-f]{64}$/u);
  assert.equal(Object.hasOwn(publicStagedProofSummary(stagedProof), "accountId"), false);
  assert.equal(validateStagedProof(stagedProof, stagedProof).proof_digest,
    stagedProof.proof_digest);
  assert.throws(() => validateStagedProof({ ...stagedProof, proof_digest: "0".repeat(64) },
    stagedProof), /staged activation proof/u);
  const staleProof = { ...stagedProof, capturedAt: "2026-08-15T00:00:00.000Z" };
  assert.throws(() => validateStagedProof(staleProof, staleProof,
    Date.parse("2026-08-15T00:06:00.000Z")), /staged activation proof/u);
  const retimed = structuredClone(arguments_);
  retimed.snapshotManifest.startedAt = new Date(
    Date.parse(arguments_.snapshotManifest.startedAt) - 1_000).toISOString();
  assert.notEqual(validateStagedBuildsSnapshot(retimed).proof_digest, stagedProof.proof_digest);
  const active = structuredClone(arguments_);
  active.productionTriggers.result[0].branch_includes = ["main"];
  active.reviewTriggers = structuredClone(active.productionTriggers);
  assert.throws(() => validateStagedBuildsSnapshot(active), /trigger branch_includes drift/u);
  const retiredWorker = structuredClone(arguments_);
  retiredWorker.scripts.result.push({ id: review.automaticReview.localValidation.workerName,
    tag: "d".repeat(32) });
  assert.throws(() => validateStagedBuildsSnapshot(retiredWorker), /retired review Worker/u);
  const wrongToken = structuredClone(arguments_);
  wrongToken.productionTriggers.result[0].build_token_uuid = resourceUuid;
  wrongToken.reviewTriggers = structuredClone(wrongToken.productionTriggers);
  assert.throws(() => validateStagedBuildsSnapshot(wrongToken), /zero-resource review token/u);
  const callerTrigger = structuredClone(arguments_);
  callerTrigger.nonEntrypointTriggers[0][1].result.push({ trigger_uuid: resourceUuid,
    repo_connection: { provider_type: "gitlab", repo_id: "unrelated" } });
  callerTrigger.nonEntrypointTriggers[0][1].result_info.total_count = 1;
  assert.throws(() => validateStagedBuildsSnapshot(callerTrigger),
    /independent staged Builds trigger/u);
  const reviewActive = structuredClone(arguments_);
  const finalReview = withConnection(automaticReviewTriggerSpec(review, {
    externalScriptId: scriptTag, repositoryConnectionUuid: resourceUuid,
    buildTokenUuid: reviewTokenUuid,
  }));
  finalReview.trigger_uuid = reviewTriggerUuid;
  reviewActive.productionTriggers = envelope([productionSpec, finalReview]);
  reviewActive.reviewTriggers = structuredClone(reviewActive.productionTriggers);
  reviewActive.reviewEnvironment = envelope(automaticReviewEnvironmentSpec(review));
  reviewActive.accountTriggers = envelope([productionSpec, finalReview]);
  const authority = reviewActivationAuthorityFixture(stagedProof);
  reviewActive.reviewActivationAuthorityProof = authority.proof;
  reviewActive.reviewActivationAuthorityEvidence = authority.evidence;
  reviewActive.productionSentinelProof = authority.evidence.productionSentinelProof;
  reviewActive.tokenAuthorityProofs = authority.evidence.tokenAuthorityProofs;
  reviewActive.reviewBuildState.buildUsageProof = authority.evidence.buildUsageProof;
  assert.throws(() => validateStagedBuildsSnapshot(reviewActive), /exactly 1/u);
  const reviewActivationProof = validateReviewActivationSnapshot(reviewActive);
  assert.equal(reviewActivationProof.outcome,
    "workers-builds-review-activation-snapshot-valid");
  const splitConnection = structuredClone(reviewActive);
  splitConnection.productionTriggers.result[1].repo_connection.repo_connection_uuid =
    "66666666-6666-4666-8666-666666666666";
  splitConnection.reviewTriggers = structuredClone(splitConnection.productionTriggers);
  assert.throws(() => validateProductionActivationSnapshot(splitConnection),
    /journaled repository connection/u);
  assert.throws(() => validateProductionActivationSnapshot(reviewActive),
    /disposable review result proof/u);
  const buildUuid = "77777777-7777-4777-8777-777777777777";
  const reviewCommitSha = "b".repeat(40);
  const branch = "review/issue-66-provider-proof";
  const evidenceNow = Date.now();
  const createdOn = new Date(evidenceNow - 120_000).toISOString();
  const stoppedOn = new Date(evidenceNow - 60_000).toISOString();
  const capturedAt = new Date(evidenceNow).toISOString();
  const reviewBuild = { build_uuid: buildUuid, status: "stopped", build_outcome: "success",
    created_on: createdOn, stopped_on: stoppedOn, trigger: structuredClone(finalReview),
    build_trigger_metadata: {
      branch, commit_hash: reviewCommitSha, build_token_uuid: reviewTokenUuid,
      build_trigger_source: "push", repo_id: "1324297032", repo_name: "metaserver-worker",
      build_command: finalReview.build_command, deploy_command: finalReview.deploy_command,
      root_directory: finalReview.root_directory } };
  reviewActive.reviewBuildState.builds = envelope([reviewBuild]);
  reviewActive.builds = reviewActive.builds.map(([label, value]) =>
    [label, label === "core" ? envelope([reviewBuild]) : value]);
  reviewActive.reviewResultProof = {
    source: "cloudflare-github-disposable-review-readback",
    repository: "atrinik/metaserver-worker", branch, reviewCommitSha, buildUuid,
    productionMainSha: "a".repeat(40),
    triggerUuid: reviewTriggerUuid, buildTokenUuid: reviewTokenUuid,
    cleanupPolicy: "build-only-no-version-binding-route-url-or-resource-created",
    evidenceLocation: "atrinik/metaserver-worker#66-private-provider-evidence",
    capturedAt, githubEvidence: { capturedAt, refs: [], comparison: { status: "behind",
      base_commit: { sha: reviewCommitSha }, head_commit: { sha: "a".repeat(40) } },
      checkRuns: { total_count: 1, check_runs: [{ id: 123456, name: "Cloudflare Workers Builds",
        status: "completed", conclusion: "success", head_sha: reviewCommitSha,
        started_at: createdOn, completed_at: stoppedOn, external_id: "cloudflare-review-check",
        details_url: "https://dash.cloudflare.com/example/builds/77777777-7777-4777-8777-777777777777",
        app: { id: 85455 } }] },
    },
  };
  const productionProof = validateProductionActivationSnapshot(reviewActive);
  assert.equal(productionProof.outcome, "workers-builds-production-activation-snapshot-valid");
  assert.match(productionProof.proof_digest, /^[0-9a-f]{64}$/u);
  const failedReview = structuredClone(reviewActive);
  failedReview.reviewBuildState.builds.result[0].build_outcome = "fail";
  assert.throws(() => validateProductionActivationSnapshot(failedReview),
    /disposable review result proof/u);
  const wrongReviewSha = structuredClone(reviewActive);
  wrongReviewSha.reviewResultProof.reviewCommitSha = "c".repeat(40);
  assert.throws(() => validateProductionActivationSnapshot(wrongReviewSha),
    /disposable review result proof/u);
  const manualReview = structuredClone(reviewActive);
  manualReview.reviewBuildState.builds.result[0].build_trigger_metadata.build_trigger_source =
    "api";
  assert.throws(() => validateProductionActivationSnapshot(manualReview),
    /disposable review result proof/u);
  const wrongApp = structuredClone(reviewActive);
  wrongApp.reviewResultProof.githubEvidence.checkRuns.check_runs[0].app.id = 999;
  assert.throws(() => validateProductionActivationSnapshot(wrongApp),
    /disposable review result proof/u);
  const existingBranch = structuredClone(reviewActive);
  existingBranch.reviewResultProof.githubEvidence.refs = [{ ref: `refs/heads/${branch}` }];
  assert.throws(() => validateProductionActivationSnapshot(existingBranch),
    /disposable review result proof/u);
  const unrelatedLink = structuredClone(reviewActive);
  unrelatedLink.reviewResultProof.githubEvidence.checkRuns.check_runs[0].details_url =
    "https://dash.cloudflare.com/example/builds/unrelated";
  assert.throws(() => validateProductionActivationSnapshot(unrelatedLink),
    /disposable review result proof/u);
  const mainReachable = structuredClone(reviewActive);
  mainReachable.reviewResultProof.githubEvidence.comparison.status = "ahead";
  assert.throws(() => validateProductionActivationSnapshot(mainReachable),
    /disposable review result proof/u);
  const duplicateCheck = structuredClone(reviewActive);
  duplicateCheck.reviewResultProof.githubEvidence.checkRuns.total_count = 2;
  duplicateCheck.reviewResultProof.githubEvidence.checkRuns.check_runs.push(
    structuredClone(duplicateCheck.reviewResultProof.githubEvidence.checkRuns.check_runs[0]));
  assert.throws(() => validateProductionActivationSnapshot(duplicateCheck),
    /disposable review result proof/u);
  const oldBuild = structuredClone(reviewActive);
  oldBuild.reviewBuildState.builds.result[0].created_on =
    new Date(evidenceNow - 30 * 60_000).toISOString();
  assert.throws(() => validateProductionActivationSnapshot(oldBuild),
    /disposable review result proof/u);
});
