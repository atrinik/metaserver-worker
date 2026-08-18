import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  automaticReviewEnvironmentSpec,
  automaticReviewTriggerSpec,
  boundedResponseText,
  classifyReviewTokenRotationCompleteRecoveryPrefix,
  classifyReviewTokenRotationProviderNormalizedRollbackPrefix,
  combineProviderPages,
  combineWorkerVersionPages,
  credentialedSourceSha,
  credentialedProvisioningModes,
  createPrivateDirectory,
  initialBootstrapPredecessorConfiguration,
  issueDisposableReviewAuthority,
  issueReviewActivationAuthority,
  issueReviewTokenRotationAuthority,
  loadSnapshot,
  materializeProductionConfigurations,
  normalizeBuildsListPage,
  normalizeDomainListPage,
  normalizeTriggerListPage,
  productionEnvironmentSpec,
  productionTriggerSpec,
  reviewBuildTokenNames,
  publicStagedProofSummary,
  provisioningDryRunSummary,
  provisioningSetupPlan,
  readProductionSentinelProof,
  readCurrentMainProof,
  readProviderSnapshot,
  readPrivateValue,
  reviewTokenRotationRequestDigest,
  reviewTokenRotationRollbackRequestDigest,
  reviewTokenRotationUnresolvedReplacementCoordinate,
  runProvisioningCli,
  snapshotProductionPreservationDigest,
  validateAutomaticReviewEnvironment,
  validateBuildTokenInventory,
  validateCheckedInProvisioning,
  validateConfiguredBuildsSnapshot,
  validateCurrentMainProof,
  validateDistinctSentinelRefAbsence,
  validateDisposableReviewAuthority,
  validateDisposableCoordinatePreparation,
  validateFreshBuildsSnapshot,
  validateInitialBootstrapSnapshot,
  validateNoActiveBuilds,
  validateNoDeployHooks,
  validateProductionControlPlane,
  validateProductionActivationSnapshot,
  validateReviewActivationSnapshot,
  validateReviewActivationAuthority,
  validateReviewActivationAuthorityCheckpoint,
  validateReplacementReviewTokenAuthorityProof,
  validateReplacementTokenOwnerMembershipProof,
  validateReviewTokenRotationReadback,
  reviewTokenRotationProviderNormalizedIncident,
  validateReviewTokenRotationAuthority,
  validateReviewTokenRotationDeleteProofChronology,
  validateReviewTokenRotationJournal,
  validateReviewTokenRotationNoOwnedPreIntentTerminal,
  validateReviewTokenRotationProviderNormalizedIncident,
  validateReviewTokenRotationRollbackJournal,
  validateReviewTokenRotationProviderPeerNormalizationSnapshotDirectory,
  validateReviewTokenRotationSnapshotDirectory,
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
const execFileAsync = promisify(execFile);
const checksummedRecord = (payload) => ({ ...payload,
  recordSha256: createHash("sha256").update(JSON.stringify(payload)).digest("hex") });

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
    { build_token_name: reviewBuildTokenNames.current, build_token_uuid: reviewTokenUuid,
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
  const stateDigest = "e".repeat(64);
  stagedProof ??= {
    outcome: "workers-builds-staged-snapshot-valid", mutation: false, accountId,
    sourceSha: "a".repeat(40), stagedTriggerCount: 1, capturedAt: stagedCapturedAt,
    snapshotStartedAt: stagedCapturedAt, snapshotCompletedAt: stagedCapturedAt,
    state_digest: stateDigest,
    proof_digest: createHash("sha256").update(JSON.stringify({ state_digest: stateDigest,
      snapshotStartedAt: stagedCapturedAt, snapshotCompletedAt: stagedCapturedAt,
      capturedAt: stagedCapturedAt })).digest("hex"),
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

function reviewActiveProof(capturedAt, stateDigest = "f".repeat(64),
  sourceSha = "a".repeat(40), liveIdentities = null) {
  const proof = {
    outcome: "workers-builds-review-activation-snapshot-valid", mutation: false, accountId,
    sourceSha, stagedTriggerCount: 2, capturedAt,
    snapshotStartedAt: capturedAt, snapshotCompletedAt: capturedAt,
    state_digest: stateDigest,
  };
  if (liveIdentities) proof.liveIdentities = liveIdentities;
  proof.proof_digest = createHash("sha256").update(JSON.stringify({ state_digest: stateDigest,
    snapshotStartedAt: capturedAt, snapshotCompletedAt: capturedAt, capturedAt,
    ...(liveIdentities ? { liveIdentities } : {}) })).digest("hex");
  return proof;
}

function disposableReviewAuthorityFixture(now = Date.now(),
  runDirectory = "/secure/issue-66/disposable-proof",
  productionPreservationDigest = "8".repeat(64)) {
  const currentSourceSha = "a".repeat(40);
  const predecessorSourceSha = "b".repeat(40);
  const replacementReviewTokenUuid = "89898989-8989-4989-8989-898989898989";
  const setupSourceSha = "815076d3d69d358e3b265025d94a9151b9542b96";
  const setupPlanDigest = "856f64dc2027a81ed5fcd7d85b687680e01c950400dbf8965ea40c076b09eb34";
  const activationPlanDigest = "fb95bcc4e693b6f933dc1bb788b736100dbd6a24c5b601e3533a03097d091892";
  const boundary = freshBoundary();
  const configured = configuredBoundary({}, {});
  boundary.repositoryConnectionProof.mainProtection.sha = currentSourceSha;
  boundary.repositoryConnectionProof.capturedAt = new Date(now - 1_500).toISOString();
  boundary.productionSentinelProof.capturedAt = new Date(now - 1_500).toISOString();
  for (const item of configured.tokenAuthorityProofs) {
    item.sourceSha = currentSourceSha;
    item.capturedAt = new Date(now - 1_500).toISOString();
  }
  configured.reviewBuildState.buildUsageProof.capturedAt = new Date(now - 1_500).toISOString();
  const journalRecord = (payload) => ({ ...payload,
    recordSha256: createHash("sha256").update(JSON.stringify(payload)).digest("hex") });
  const reviewTrigger = "22222222-2222-4222-8222-222222222222";
  const productionTrigger = "11111111-1111-4111-8111-111111111111";
  const productionBuildToken = "44444444-4444-4444-8444-444444444444";
  const repositoryConnection = "55555555-5555-4555-8555-555555555555";
  const reviewActivationProof = reviewActiveProof(new Date(now - 5_972).toISOString(),
    "d".repeat(64), predecessorSourceSha);
  const liveIdentities = {
    productionTriggerUuid: productionTrigger, reviewTriggerUuid: reviewTrigger,
    productionBuildTokenUuid: productionBuildToken, reviewBuildTokenUuid: reviewTokenUuid,
    repositoryConnectionUuid: repositoryConnection,
    productionEnvironmentDigest: "6".repeat(64), reviewEnvironmentDigest: "7".repeat(64),
  };
  const predecessorReviewActiveProof = reviewActiveProof(new Date(now - 3_000).toISOString(),
    "e".repeat(64), currentSourceSha, liveIdentities);
  const setupPairs = [
    ["preflight-proven", "execution-preflight"], ["setup-authorized"],
    ["mutation-intent", "repository-connection"],
    ["mutation-bound", "repository-connection"],
    ["mutation-intent", "production-build-token"],
    ["provider-response-classified", "production-build-token"],
    ["mutation-bound", "production-build-token"],
    ["mutation-intent", "review-build-token"],
    ["provider-response-classified", "review-build-token"],
    ["mutation-bound", "review-build-token"],
    ["sentinel-recheck", "sentinel-recheck-before-production-trigger"],
    ["mutation-intent", "production-trigger-staged"],
    ["provider-response-classified", "production-trigger-staged"],
    ["mutation-bound", "production-trigger-staged"],
    ["mutation-proof-bound", "production-trigger-staged"],
    ["sentinel-recheck", "sentinel-recheck-before-production-environment"],
    ["mutation-intent", "production-environment"],
    ["provider-response-classified", "production-environment"],
    ["mutation-bound", "production-environment"],
    ["mutation-proof-bound", "production-environment"],
    ["staged-readback-proven", "staged-readback"], ["inert-setup-complete"],
  ];
  const setupResource = { "repository-connection": repositoryConnection,
    "production-build-token": productionBuildToken, "review-build-token": reviewTokenUuid,
    "production-trigger-staged": productionTrigger, "production-environment": productionTrigger };
  const setupRecords = setupPairs.map(([event, operation], index) => {
    const payload = { event, ...(operation ? { operation } : {}), attempt: 1,
      at: new Date(now - 10_000 + index).toISOString() };
    if (event === "mutation-bound") payload.resourceUuid = setupResource[operation];
    if (event === "setup-authorized") Object.assign(payload, { sourceSha: setupSourceSha,
      planDigestSha256: setupPlanDigest });
    if (event === "mutation-intent") Object.assign(payload, {
      method: operation === "repository-connection" ? "PUT" :
        operation === "production-environment" ? "PATCH" : "POST",
      path: operation === "repository-connection" ? "/builds/repos/connections" :
        operation === "production-environment" ?
          `/builds/triggers/${productionTrigger}/environment_variables` :
          operation.includes("token") ? "/builds/tokens" : "/builds/triggers",
      requestDigestSha256: createHash("sha256").update(operation).digest("hex"),
    });
    if (event === "provider-response-classified") Object.assign(payload, {
      outcome: "explicit-success",
      ...(operation !== "production-environment" ? { resourceUuid: setupResource[operation] } : {}),
    });
    if (event === "mutation-bound") Object.assign(payload, {
      providerResponseExplicitSuccess: true,
      requestDigestSha256: createHash("sha256").update(operation).digest("hex"),
      readbackDigestSha256: createHash("sha256").update(`readback:${operation}`).digest("hex"),
    });
    if (event === "inert-setup-complete") Object.assign(payload, {
      stagedProofDigest: "8".repeat(64), activation: false, migration0010: false,
      initialProductionBuild: false });
    return journalRecord(payload);
  });
  const inertSetupResults = { sourceSha: setupSourceSha, planDigest: setupPlanDigest,
    repositoryConnection, productionBuildToken, reviewBuildToken: reviewTokenUuid,
    productionTrigger, stagedProofDigest: "8".repeat(64) };
  const activationPairs = [
    ["attempt-started", "review-trigger-activation"],
    ["current-main-proof-bound", "fresh-staged-readback"],
    ["current-main-proof-bound", "fresh-staged-verify"],
    ["current-main-proof-bound", "fresh-staged-proof-verify"],
    ["current-main-proof-bound", "review-activation-authority-issue"],
    ["review-gate-preflight-proven"],
    ["current-main-proof-bound", "review-root-create-validate"],
    ["github-proof-bound", "review-root-create"],
    ["review-gate-authorized"],
    ["current-main-proof-bound", "before-review-trigger-create"],
    ["review-activation-authority-checked", "before-review-trigger-create"],
    ["mutation-intent", "review-trigger-create"],
    ["provider-response-classified", "review-trigger-create"],
    ["mutation-bound", "review-trigger-create"],
    ["current-main-proof-bound", "before-review-environment"],
    ["review-activation-authority-checked", "before-review-environment"],
    ["mutation-intent", "review-environment"],
    ["provider-response-classified", "review-environment"],
    ["mutation-bound", "review-environment"],
    ["current-main-proof-bound", "review-staged-environment-verify"],
    ["provider-proof-bound", "review-staged-environment"],
    ["current-main-proof-bound", "review-root-activation-validate"],
    ["github-proof-bound", "review-root-activation"],
    ["current-main-proof-bound", "before-review-trigger-activate"],
    ["review-activation-authority-checked", "before-review-trigger-activate"],
    ["mutation-intent", "review-trigger-activate"],
    ["provider-response-classified", "review-trigger-activate"],
    ["mutation-bound", "review-trigger-activate"],
    ["current-main-proof-bound", "review-activation-verify"],
    ["provider-proof-bound", "review-activation"],
    ["review-trigger-active"],
  ];
  const setupJournalSha256 = createHash("sha256").update(
    setupRecords.map((record) => JSON.stringify(record)).join("\n")).digest("hex");
  const setupResultsSha256 = createHash("sha256").update(JSON.stringify(inertSetupResults))
    .digest("hex");
  const reviewActivationJournal = activationPairs.map(([event, operation], index) => {
    const payload = { event, ...(operation ? { operation } : {}), attempt: 1,
      at: new Date(now - 5_000 + index).toISOString() };
    if (index === 0) Object.assign(payload, { sourceSha: predecessorSourceSha,
      planDigestSha256: activationPlanDigest });
    if (event === "review-gate-preflight-proven") Object.assign(payload, {
      sourceSha: predecessorSourceSha, planDigestSha256: activationPlanDigest,
      setupJournalSha256, setupResultsSha256,
      reviewActivationAuthorityDigest: "4".repeat(64),
    });
    if (event === "current-main-proof-bound") Object.assign(payload, {
      sourceSha: predecessorSourceSha, proofFileSha256: "5".repeat(64),
      rawFileSha256: "6".repeat(64),
    });
    if (event === "review-activation-authority-checked") Object.assign(payload, {
      proofDigest: "4".repeat(64), expiresAt: new Date(now + 60_000).toISOString(),
    });
    if (event === "mutation-intent") Object.assign(payload, {
      method: operation === "review-trigger-create" ? "POST" : "PATCH",
      path: operation === "review-trigger-create" ? "/builds/triggers" :
        operation === "review-environment" ?
          `/builds/triggers/${reviewTrigger}/environment_variables` :
          `/builds/triggers/${reviewTrigger}`,
      requestDigestSha256: createHash("sha256").update(operation).digest("hex"),
    });
    if (event === "provider-response-classified") Object.assign(payload, {
      outcome: "explicit-success",
      ...(operation === "review-trigger-create" ? { resourceUuid: reviewTrigger } : {}),
    });
    if (event === "mutation-bound") Object.assign(payload, { resourceUuid: reviewTrigger,
      providerResponseExplicitSuccess: true,
      requestDigestSha256: createHash("sha256").update(operation).digest("hex"),
      readbackDigestSha256: createHash("sha256").update(`readback:${operation}`).digest("hex"),
    });
    if (event === "provider-proof-bound" && operation === "review-activation")
      Object.assign(payload, { proofDigest: reviewActivationProof.proof_digest,
        proofFileSha256: createHash("sha256").update(JSON.stringify(reviewActivationProof))
          .digest("hex") });
    if (event === "review-trigger-active") Object.assign(payload, { reviewTrigger,
      stagedEnvironmentProofDigest: "1".repeat(64), activationRootProofDigest: "2".repeat(64),
      reviewActivationProofDigest: reviewActivationProof.proof_digest,
      productionActivation: false, migration0010: false, initialProductionBuild: false });
    return journalRecord(payload);
  });
  const executorSha256 = "3".repeat(64);
  const journalPath = resolve(runDirectory, "disposable-proof-journal.jsonl");
  const disposableCoordinate = { source: "journaled-disposable-review-coordinate",
    repository: "atrinik/metaserver-worker", sourceSha: currentSourceSha,
    branch: "review/issue-66-proof", commit: "c".repeat(40), parentSha: currentSourceSha,
    treeSha: "f".repeat(40), proofBlobSha: "1".repeat(40),
    proofPath: "deployment/review-check/.issue-66-build-proof", proofMode: "100644",
    contentSha256: createHash("sha256").update("issue-66 automatic review build proof\n")
      .digest("hex"), commitSubject: "test(deploy): verify issue 66 review build",
    authorName: "Atrinik Delivery", authorEmail: "delivery@atrinik.org",
    commitMetadataSha256: createHash("sha256").update(JSON.stringify([
      "test(deploy): verify issue 66 review build", "Atrinik Delivery", "delivery@atrinik.org",
      currentSourceSha])).digest("hex"), executorSha256,
    executorPath: resolve(runDirectory, "run-disposable-proof.mjs"), journalPath,
    detachedRepositoryPath: resolve(runDirectory, "disposable-source"),
    pushReceiptPath: resolve(runDirectory, "push-authorization-receipt.json"),
    deleteReceiptPath: resolve(runDirectory, "delete-authorization-receipt.json"),
    journalId: createHash("sha256").update(
      `disposable-journal:${journalPath}:${executorSha256}`).digest("hex"),
    journalInitialRecordCount: 0,
    capturedAt: new Date(now - 1_500).toISOString() };
  const replacementTokenId = "replacement-review-token-id";
  const replacementTokenAuthorityProof = {
    ...configured.tokenAuthorityProofs.find(({ kind }) => kind === "review"),
    kind: "review-replacement", tokenId: replacementTokenId,
    ownerUserId: "1".repeat(32),
    capturedAt: new Date(now - 3_200).toISOString(),
    modifiedOn: new Date(now - 3_300).toISOString(),
  };
  const replacementTokenOwnerMembershipProof = { accountId,
    capturedAt: new Date(now - 3_100).toISOString(), membershipStatus: "accepted",
    ownerUserId: replacementTokenAuthorityProof.ownerUserId,
    source: "cloudflare-owner-account-membership-readback", sourceSha: currentSourceSha };
  const productionBaselineUnsigned = {
    source: "workers-builds-review-token-rotation-production-baseline", accountId,
    sourceSha: currentSourceSha, capturedAt: new Date(now - 3_000).toISOString(),
    currentReviewActiveProofDigest: predecessorReviewActiveProof.proof_digest,
    productionPreservationDigest, productionScriptTag: scriptTag,
  };
  const productionBaselineProof = { ...productionBaselineUnsigned,
    proof_digest: createHash("sha256").update(JSON.stringify(productionBaselineUnsigned))
      .digest("hex") };
  const rotationArguments = { production, review, accountId, sourceSha: currentSourceSha,
    reviewActivationProof, reviewActivationJournal, inertSetupJournal: setupRecords,
    inertSetupResults, currentReviewActiveProof: predecessorReviewActiveProof,
    repositoryConnectionProof: boundary.repositoryConnectionProof,
    productionSentinelProof: boundary.productionSentinelProof,
    predecessorTokenAuthorityProofs: configured.tokenAuthorityProofs,
    replacementTokenAuthorityProof, replacementTokenId, replacementTokenOwnerMembershipProof,
    buildUsageProof: configured.reviewBuildState.buildUsageProof,
    tokenRows: { production: { build_token_uuid: productionBuildToken,
      cloudflare_token_id: "production-token-id" }, review: {
      build_token_uuid: reviewTokenUuid, cloudflare_token_id: "review-token-id" } },
    productionBaselineProof,
    replacementTokenSecretSha256: createHash("sha256").update("replacement-secret")
      .digest("hex"),
  };
  const reviewTokenRotationAuthorityProof = issueReviewTokenRotationAuthority(rotationArguments,
    now - 2_500);
  const reviewTokenRotationProof = {
    outcome: "workers-builds-review-token-rotation-complete-valid", mutation: false,
    phase: "complete", accountId, sourceSha: currentSourceSha,
    capturedAt: new Date(now - 1_965).toISOString(),
    productionTriggerUuid: productionTrigger, reviewTriggerUuid: reviewTrigger,
    productionBuildTokenUuid: productionBuildToken,
    predecessorReviewTokenUuid: reviewTokenUuid,
    replacementReviewTokenUuid,
    productionPreservationDigest,
    proof_digest: "9".repeat(64),
  };
  const reviewTokenRotationIntermediateProof = { ...reviewTokenRotationProof,
    outcome: "workers-builds-review-token-rotation-production-repointed-valid",
    phase: "production-repointed", capturedAt: new Date(now - 2_085).toISOString(),
    proof_digest: "7".repeat(64) };
  const reviewTokenRotationUnreferencedProof = { ...reviewTokenRotationProof,
    outcome: "workers-builds-review-token-rotation-old-wrapper-unreferenced-valid",
    phase: "old-wrapper-unreferenced", capturedAt: new Date(now - 2_025).toISOString(),
    proof_digest: "8".repeat(64) };
  const rotationPairs = [
    ["attempt-started", "review-token-rotation"], ["rotation-authorized"],
    ["current-main-proof-bound", "replacement-review-build-token"],
    ["review-token-rotation-authority-checked", "replacement-review-build-token"],
    ["mutation-intent", "replacement-review-build-token"],
    ["provider-response-classified", "replacement-review-build-token"],
    ["mutation-bound", "replacement-review-build-token"],
    ["current-main-proof-bound", "repoint-inert-production-trigger"],
    ["review-token-rotation-authority-checked", "repoint-inert-production-trigger"],
    ["mutation-intent", "repoint-inert-production-trigger"],
    ["provider-response-classified", "repoint-inert-production-trigger"],
    ["mutation-bound", "repoint-inert-production-trigger"],
    ["provider-proof-bound", "prove-production-repointed-review-still-predecessor"],
    ["current-main-proof-bound", "repoint-final-review-trigger"],
    ["review-token-rotation-authority-checked", "repoint-final-review-trigger"],
    ["mutation-intent", "repoint-final-review-trigger"],
    ["provider-response-classified", "repoint-final-review-trigger"],
    ["mutation-bound", "repoint-final-review-trigger"],
    ["current-main-proof-bound", "retire-superseded-review-build-token"],
    ["review-token-rotation-authority-checked", "retire-superseded-review-build-token"],
    ["provider-proof-bound", "prove-superseded-wrapper-unreferenced"],
    ["mutation-intent", "retire-superseded-review-build-token"],
    ["provider-response-classified", "retire-superseded-review-build-token"],
    ["mutation-bound", "retire-superseded-review-build-token"],
    ["provider-proof-bound", "review-token-rotation-readback"],
    ["review-token-rotation-complete"],
  ];
  const resourceForRotation = (operation) => operation === "replacement-review-build-token" ?
    replacementReviewTokenUuid : operation === "repoint-inert-production-trigger" ?
      productionTrigger : operation === "repoint-final-review-trigger" ? reviewTrigger :
        reviewTokenUuid;
  const reviewTokenRotationJournal = rotationPairs.map(([event, operation], index) => {
    const payload = { event, ...(operation ? { operation } : {}), attempt: 1,
      at: new Date(now - 2_200 + index * 10).toISOString() };
    if (event === "rotation-authorized") payload.authorityProofDigest =
      reviewTokenRotationAuthorityProof.proof_digest;
    if (event === "review-token-rotation-authority-checked") payload.proofDigest =
      reviewTokenRotationAuthorityProof.proof_digest;
    if (event === "review-token-rotation-authority-checked") payload.expiresAt =
      reviewTokenRotationAuthorityProof.expiresAt;
    if (event === "current-main-proof-bound") Object.assign(payload, {
      sourceSha: currentSourceSha, ref: "refs/heads/main",
      capturedAt: new Date(now - 2_205 + index * 10).toISOString(),
      proofFileSha256: createHash("sha256").update(`proof:${operation}`).digest("hex"),
      rawFileSha256: createHash("sha256").update(`raw:${operation}`).digest("hex"),
    });
    if (event === "mutation-intent") Object.assign(payload, {
      ...reviewTokenRotationRequestDigest({ production, review,
        authorityProof: reviewTokenRotationAuthorityProof, operation,
        replacementReviewTokenUuid }),
    });
    if (event === "provider-response-classified") Object.assign(payload, {
      outcome: "explicit-success", ...(operation === "replacement-review-build-token" ?
        { resourceUuid: replacementReviewTokenUuid } : {}),
    });
    if (event === "mutation-bound") Object.assign(payload, {
      resourceUuid: resourceForRotation(operation), providerResponseExplicitSuccess: true,
      requestDigestSha256: reviewTokenRotationRequestDigest({ production, review,
        authorityProof: reviewTokenRotationAuthorityProof, operation,
        replacementReviewTokenUuid }).requestDigestSha256,
      readbackDigestSha256: createHash("sha256").update(`readback:${operation}`).digest("hex"),
      reconciliation: operation === "retire-superseded-review-build-token" ?
        "explicit-success-exact-absence" : "explicit-success-exact-readback",
      ...(operation === "retire-superseded-review-build-token" ?
        { deletionTombstone: true } : {}),
    });
    if (event === "provider-proof-bound") Object.assign(payload, {
      proofDigest: operation === "review-token-rotation-readback" ?
        reviewTokenRotationProof.proof_digest :
        operation === "prove-production-repointed-review-still-predecessor" ?
          reviewTokenRotationIntermediateProof.proof_digest :
          reviewTokenRotationUnreferencedProof.proof_digest,
      proofFileSha256: createHash("sha256").update(JSON.stringify(
        operation === "review-token-rotation-readback" ? reviewTokenRotationProof :
          operation === "prove-production-repointed-review-still-predecessor" ?
            reviewTokenRotationIntermediateProof : reviewTokenRotationUnreferencedProof))
        .digest("hex"),
    });
    if (event === "review-token-rotation-complete") Object.assign(payload, {
      proofDigest: reviewTokenRotationProof.proof_digest, productionTriggerUuid: productionTrigger,
      reviewTriggerUuid: reviewTrigger, predecessorReviewTokenUuid: reviewTokenUuid,
      replacementReviewTokenUuid, productionActivation: false, migration0010: false,
      initialProductionBuild: false, productionPreservationDigest,
      replacementTokenOwnerMembershipProofDigest:
        reviewTokenRotationAuthorityProof.evidenceDigests.replacementTokenOwnerMembership,
    });
    return journalRecord(payload);
  });
  const rotatedIdentities = { ...liveIdentities, reviewBuildTokenUuid: replacementReviewTokenUuid };
  const currentReviewActiveProof = reviewActiveProof(new Date(now - 1_000).toISOString(),
    "f".repeat(64), currentSourceSha, rotatedIdentities);
  const currentReplacementTokenOwnerMembershipProof = {
    ...replacementTokenOwnerMembershipProof,
    capturedAt: new Date(now - 1_500).toISOString(),
  };
  const { ownerUserId: _replacementOwnerUserId, ...ordinaryReplacementTokenProof } =
    replacementTokenAuthorityProof;
  const tokenAuthorityProofs = configured.tokenAuthorityProofs.map((proof) =>
    proof.kind === "review" ? { ...ordinaryReplacementTokenProof, kind: "review" } : proof);
  const evidence = {
    reviewActivationProof, reviewActivationJournal, currentReviewActiveProof,
    predecessorReviewActiveProof,
    inertSetupJournal: setupRecords, inertSetupResults, disposableCoordinate,
    reviewTokenRotationProof, reviewTokenRotationJournal, reviewTokenRotationAuthorityProof,
    reviewTokenRotationIntermediateProof, reviewTokenRotationUnreferencedProof,
    repositoryConnectionProof: boundary.repositoryConnectionProof,
    productionSentinelProof: boundary.productionSentinelProof,
    tokenAuthorityProofs, predecessorTokenAuthorityProofs: configured.tokenAuthorityProofs,
    replacementTokenAuthorityProof, replacementTokenOwnerMembershipProof,
    currentReplacementTokenOwnerMembershipProof,
    replacementTokenId, productionBaselineProof,
    buildUsageProof: configured.reviewBuildState.buildUsageProof,
  };
  const proof = issueDisposableReviewAuthority({ production, review, accountId,
    sourceSha: currentSourceSha, ...evidence, tokenRows: {
      production: { cloudflare_token_id: "production-token-id" },
      review: { cloudflare_token_id: replacementTokenId },
    } }, now);
  return { proof, evidence, production, review, accountId, sourceSha: currentSourceSha };
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

test("cryptographically binds the disposable commit, executor, and empty journal", async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), "atrinik-disposable-coordinate-"));
  await chmod(temporary, 0o700);
  const repository = resolve(temporary, "disposable-source");
  await mkdir(repository, { mode: 0o700 });
  const git = async (...args) => (await execFileAsync("git", args, {
    cwd: repository, encoding: "utf8" })).stdout.trim();
  try {
    await git("init", "-q");
    await chmod(resolve(repository, ".git"), 0o700);
    await git("config", "user.name", "Atrinik Delivery");
    await git("config", "user.email", "delivery@atrinik.org");
    await writeFile(resolve(repository, "README.md"), "base\n", { mode: 0o600 });
    await git("add", "README.md");
    await git("commit", "-q", "-m", "test: base");
    const parentSha = await git("rev-parse", "HEAD");
    const proofDirectory = resolve(repository, "deployment/review-check");
    await mkdir(proofDirectory, { recursive: true, mode: 0o700 });
    const content = "issue-66 automatic review build proof\n";
    await writeFile(resolve(proofDirectory, ".issue-66-build-proof"), content, { mode: 0o600 });
    await git("add", "deployment/review-check/.issue-66-build-proof");
    await git("commit", "-q", "-m", "test(deploy): verify issue 66 review build");
    const commit = await git("rev-parse", "HEAD");
    const treeSha = await git("rev-parse", "HEAD^{tree}");
    const proofBlobSha = await git("rev-parse",
      "HEAD:deployment/review-check/.issue-66-build-proof");
    const executorPath = resolve(temporary, "run-disposable-proof.mjs");
    const journalPath = resolve(temporary, "disposable-proof-journal.jsonl");
    const executor = "export const reviewed = true;\n";
    await writeFile(executorPath, executor, { mode: 0o600 });
    await writeFile(journalPath, "", { mode: 0o600 });
    const executorSha256 = createHash("sha256").update(executor).digest("hex");
    const coordinate = {
      source: "journaled-disposable-review-coordinate", repository: "atrinik/metaserver-worker",
      sourceSha: parentSha, branch: "review/issue-66-proof", commit, parentSha, treeSha,
      proofBlobSha, proofPath: "deployment/review-check/.issue-66-build-proof",
      proofMode: "100644", contentSha256: createHash("sha256").update(content).digest("hex"),
      commitSubject: "test(deploy): verify issue 66 review build", authorName: "Atrinik Delivery",
      authorEmail: "delivery@atrinik.org", commitMetadataSha256: createHash("sha256").update(
        JSON.stringify(["test(deploy): verify issue 66 review build", "Atrinik Delivery",
          "delivery@atrinik.org", parentSha])).digest("hex"), executorSha256, executorPath,
      journalPath, detachedRepositoryPath: repository,
      pushReceiptPath: resolve(temporary, "push-authorization-receipt.json"),
      deleteReceiptPath: resolve(temporary, "delete-authorization-receipt.json"),
      journalId: createHash("sha256").update(
        `disposable-journal:${journalPath}:${executorSha256}`).digest("hex"),
      journalInitialRecordCount: 0, capturedAt: new Date().toISOString(),
    };
    const previousGitDirectory = process.env.GIT_DIR;
    process.env.GIT_DIR = resolve(temporary, "hostile-alternate-git-dir");
    try {
      assert.equal((await validateDisposableCoordinatePreparation(coordinate)).commit, commit);
    } finally {
      if (previousGitDirectory === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previousGitDirectory;
    }
    await git("checkout", "-q", "-b", "hostile-replacement");
    await writeFile(resolve(proofDirectory, ".issue-66-build-proof"), "malicious\n", {
      mode: 0o600 });
    await git("add", "deployment/review-check/.issue-66-build-proof");
    await git("commit", "-q", "-m", "test: hostile replacement");
    const replacement = await git("rev-parse", "HEAD");
    await git("checkout", "-q", "--detach", commit);
    await git("replace", commit, replacement);
    assert.equal((await validateDisposableCoordinatePreparation(coordinate)).commit, commit);
    const linkedRepository = resolve(temporary, "linked-worktree");
    await mkdir(linkedRepository, { mode: 0o700 });
    await writeFile(resolve(linkedRepository, ".git"), `gitdir: ${resolve(repository, ".git")}\n`,
      { mode: 0o600 });
    await assert.rejects(validateDisposableCoordinatePreparation({ ...coordinate,
      detachedRepositoryPath: linkedRepository }), /Git metadata must be an owner-only/u);
    const commonDirectoryMarker = resolve(repository, ".git/commondir");
    await writeFile(commonDirectoryMarker, ".\n", { mode: 0o600 });
    try {
      await assert.rejects(validateDisposableCoordinatePreparation(coordinate),
        /forbidden shared, graft, or shallow Git metadata/u);
    } finally { await rm(commonDirectoryMarker); }
    await writeFile(journalPath, "started\n", { mode: 0o600 });
    await assert.rejects(validateDisposableCoordinatePreparation(coordinate),
      /executor or empty journal identity drift/u);
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
    "--verify-disposable-review-authority",
    "--verify-disposable-review-authority-proof",
    "--verify-disposable-review-authority-push",
    "--verify-preflight",
    "--verify-production-activation",
    "--verify-review-activation",
    "--verify-review-activation-authority",
    "--verify-review-activation-authority-proof",
    "--verify-review-token-rotation-authority",
    "--verify-review-token-rotation-authority-proof-historical",
    "--verify-review-token-rotation-authority-proof",
    "--verify-review-token-rotation-complete",
    "--verify-review-token-rotation-complete-historical",
    "--verify-review-token-rotation-intermediate",
    "--verify-review-token-rotation-provider-normalized-incident",
    "--verify-review-token-rotation-provider-peer-normalization",
    "--verify-review-token-rotation-rollback-restored",
    "--verify-review-token-rotation-rollback-complete",
    "--verify-review-token-rotation-unreferenced",
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
  const checkpointOptionIndex = implementation.indexOf(
    "reviewActivationAuthorityCheckpoint = undefined");
  assert.notEqual(checkpointOptionIndex, -1);
  assert.notEqual(implementation.indexOf("reviewActivationAuthorityCheckpoint };",
    checkpointOptionIndex), -1);
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
  const checkpoint = validateReviewActivationAuthority(proof, arguments_,
    captured + 24 * 60_000 + 59_000);
  assert.equal(validateReviewActivationAuthorityCheckpoint(proof, arguments_, checkpoint,
    captured + 29 * 60_000 + 59_500).proof_digest, proof.proof_digest);
  assert.throws(() => validateReviewActivationAuthorityCheckpoint(proof, arguments_, checkpoint,
    Date.parse(proof.expiresAt)), /stale, malformed, or cross-phase/u);
  assert.throws(() => validateReviewActivationAuthorityCheckpoint(proof, arguments_, checkpoint,
    Date.parse(checkpoint.checkedAt) - 1), /checkpoint is stale or malformed/u);
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

test("renews only a bounded disposable proof authority from exact review-active state", () => {
  const now = Date.now();
  const { proof, evidence } = disposableReviewAuthorityFixture(now);
  const arguments_ = { production, review, accountId, sourceSha: "a".repeat(40), ...evidence };
  assert.equal(proof.sourceSha, "a".repeat(40));
  assert.equal(proof.predecessorSourceSha, "b".repeat(40));
  assert.equal(Date.parse(proof.expiresAt) - Date.parse(proof.capturedAt), 60 * 60_000);
  assert.equal(validateDisposableReviewAuthority(proof, arguments_, now + 10 * 60_000,
    40 * 60_000).proof_digest, proof.proof_digest);
  assert.throws(() => validateDisposableReviewAuthority(proof, arguments_,
    now + 21 * 60_000, 40 * 60_000), /stale, malformed, or cross-phase/u);
  assert.equal(validateDisposableReviewAuthority(proof, arguments_, now + 54 * 60_000)
    .proof_digest, proof.proof_digest);
  assert.throws(() => validateDisposableReviewAuthority(proof, arguments_, now + 56 * 60_000),
    /stale, malformed, or cross-phase/u);
  assert.throws(() => validateDisposableReviewAuthority({ ...proof, phase: "production" },
    arguments_, now), /cross-phase/u);
  assert.throws(() => validateDisposableReviewAuthority(proof, { ...arguments_,
    currentReviewActiveProof: { ...evidence.currentReviewActiveProof,
      proof_digest: "0".repeat(64) } }, now),
  /staged proof drift|live proof drift|live identity proof drift|evidence binding drift/u);
  const wrongWrites = { ...proof, allowedWrites: [...proof.allowedWrites, "manual-build"] };
  assert.throws(() => validateDisposableReviewAuthority(wrongWrites, arguments_, now),
    /cross-phase/u);
  const corruptJournal = structuredClone(arguments_);
  corruptJournal.reviewActivationJournal[1].proofDigest = "0".repeat(64);
  assert.throws(() => validateDisposableReviewAuthority(proof, corruptJournal, now),
    /checksum drift|terminal provenance drift/u);
  const corruptRotation = structuredClone(arguments_);
  corruptRotation.reviewTokenRotationJournal[1].authorityProofDigest = "0".repeat(64);
  assert.throws(() => validateDisposableReviewAuthority(proof, corruptRotation, now),
    /checksum drift|terminal provenance drift/u);
  const inactiveReplacementOwner = structuredClone(arguments_);
  inactiveReplacementOwner.replacementTokenOwnerMembershipProof.membershipStatus = "revoked";
  assert.throws(() => validateDisposableReviewAuthority(proof, inactiveReplacementOwner, now),
    /active membership proof drift/u);
  const staleCurrentReplacementOwner = structuredClone(arguments_);
  staleCurrentReplacementOwner.currentReplacementTokenOwnerMembershipProof.capturedAt =
    new Date(now - 6 * 60_000).toISOString();
  assert.throws(() => validateDisposableReviewAuthority(proof, staleCurrentReplacementOwner, now),
    /active membership proof drift/u);
  const replayedReplacementOwner = structuredClone(arguments_);
  replayedReplacementOwner.currentReplacementTokenOwnerMembershipProof =
    structuredClone(replayedReplacementOwner.replacementTokenOwnerMembershipProof);
  assert.throws(() => issueDisposableReviewAuthority({ production, review, accountId,
    sourceSha: "a".repeat(40), ...replayedReplacementOwner, tokenRows: {
      production: { cloudflare_token_id: "production-token-id" },
      review: { cloudflare_token_id: "replacement-review-token-id" } } }, now),
  /observations overlap/u);
  assert.throws(() => validateDisposableReviewAuthority(proof,
    replayedReplacementOwner, now), /observations overlap|evidence binding drift/u);
  const terminalEqualReplacementOwner = structuredClone(arguments_);
  terminalEqualReplacementOwner.currentReplacementTokenOwnerMembershipProof.capturedAt =
    terminalEqualReplacementOwner.reviewTokenRotationJournal.at(-1).at;
  assert.throws(() => issueDisposableReviewAuthority({ production, review, accountId,
    sourceSha: "a".repeat(40), ...terminalEqualReplacementOwner, tokenRows: {
      production: { cloudflare_token_id: "production-token-id" },
      review: { cloudflare_token_id: "replacement-review-token-id" } } }, now),
  /observations overlap/u);
  const alteredRequest = structuredClone(arguments_);
  const alteredIntentIndex = alteredRequest.reviewTokenRotationJournal.findIndex(({ event,
    operation }) => event === "mutation-intent" &&
      operation === "repoint-final-review-trigger");
  const { recordSha256: _alteredChecksum, ...alteredIntent } =
    alteredRequest.reviewTokenRotationJournal[alteredIntentIndex];
  alteredIntent.requestDigestSha256 = "0".repeat(64);
  alteredRequest.reviewTokenRotationJournal[alteredIntentIndex] = checksummedRecord(alteredIntent);
  assert.throws(() => issueDisposableReviewAuthority({ production, review, accountId,
    sourceSha: "a".repeat(40), ...alteredRequest, tokenRows: {
      production: { cloudflare_token_id: "production-token-id" },
      review: { cloudflare_token_id: "replacement-review-token-id" } } }, now),
  /terminal provenance drift/u);
  const preMutationProof = structuredClone(arguments_);
  preMutationProof.reviewTokenRotationIntermediateProof.capturedAt =
    new Date(now - 2_150).toISOString();
  const intermediateBoundIndex = preMutationProof.reviewTokenRotationJournal.findIndex(({ event,
    operation }) => event === "provider-proof-bound" &&
      operation === "prove-production-repointed-review-still-predecessor");
  const { recordSha256: _oldBoundChecksum, ...preMutationBound } =
    preMutationProof.reviewTokenRotationJournal[intermediateBoundIndex];
  preMutationBound.proofDigest = preMutationProof.reviewTokenRotationIntermediateProof.proof_digest;
  preMutationBound.proofFileSha256 = createHash("sha256").update(JSON.stringify(
    preMutationProof.reviewTokenRotationIntermediateProof)).digest("hex");
  preMutationProof.reviewTokenRotationJournal[intermediateBoundIndex] =
    checksummedRecord(preMutationBound);
  assert.throws(() => issueDisposableReviewAuthority({ production, review, accountId,
    sourceSha: "a".repeat(40), ...preMutationProof, tokenRows: {
      production: { cloudflare_token_id: "production-token-id" },
      review: { cloudflare_token_id: "replacement-review-token-id" } } }, now),
  /terminal provenance drift/u);
  const oldDeleteProofOrder = structuredClone(arguments_);
  const deleteMainIndex = oldDeleteProofOrder.reviewTokenRotationJournal.findIndex(({ event,
    operation }) => event === "current-main-proof-bound" &&
      operation === "retire-superseded-review-build-token");
  const deleteAuthorityIndex = oldDeleteProofOrder.reviewTokenRotationJournal.findIndex(({ event,
    operation }) => event === "review-token-rotation-authority-checked" &&
      operation === "retire-superseded-review-build-token");
  const deleteProofIndex = oldDeleteProofOrder.reviewTokenRotationJournal.findIndex(({ event,
    operation }) => event === "provider-proof-bound" &&
      operation === "prove-superseded-wrapper-unreferenced");
  const reorder = [deleteProofIndex, deleteMainIndex, deleteAuthorityIndex].map((index) => {
    const { recordSha256: _checksum, at: _at, ...payload } =
      oldDeleteProofOrder.reviewTokenRotationJournal[index];
    return payload;
  });
  for (const [offset, payload] of reorder.entries()) {
    const index = deleteMainIndex + offset;
    oldDeleteProofOrder.reviewTokenRotationJournal[index] = checksummedRecord({ ...payload,
      at: oldDeleteProofOrder.reviewTokenRotationJournal[index].at });
  }
  assert.throws(() => issueDisposableReviewAuthority({ production, review, accountId,
    sourceSha: "a".repeat(40), ...oldDeleteProofOrder, tokenRows: {
      production: { cloudflare_token_id: "production-token-id" },
      review: { cloudflare_token_id: "replacement-review-token-id" } } }, now),
  /journal operation sequence drift/u);
  assert.throws(() => validateReviewTokenRotationDeleteProofChronology(
    { capturedAt: new Date(now - 31_001).toISOString() },
    { at: new Date(now - 31_000).toISOString() },
    { at: new Date(now + 1).toISOString() }),
  /delete proof chronology drift/u);
  const ambiguousCreate = structuredClone(evidence);
  for (const [index, record] of ambiguousCreate.reviewTokenRotationJournal.entries()) {
    if (record.operation !== "replacement-review-build-token" ||
        !["provider-response-classified", "mutation-bound"].includes(record.event)) continue;
    const { recordSha256: _checksum, ...payload } = record;
    if (record.event === "provider-response-classified") {
      payload.outcome = "ambiguous";
      delete payload.resourceUuid;
    } else {
      payload.providerResponseExplicitSuccess = false;
      payload.reconciliation = "ambiguous-exact-readback";
    }
    ambiguousCreate.reviewTokenRotationJournal[index] = checksummedRecord(payload);
  }
  assert.equal(issueDisposableReviewAuthority({ production, review, accountId,
    sourceSha: "a".repeat(40), ...ambiguousCreate, tokenRows: {
      production: { cloudflare_token_id: "production-token-id" },
      review: { cloudflare_token_id: "replacement-review-token-id" } } }, now)
    .reviewTokenRotation.replacementReviewTokenUuid,
  evidence.reviewTokenRotationProof.replacementReviewTokenUuid);
  const exhaustedUsage = structuredClone(arguments_);
  exhaustedUsage.buildUsageProof.monthlyMinutesUsed = 780;
  assert.throws(() => validateDisposableReviewAuthority(proof, exhaustedUsage, now),
    /reserved build-minute budget/u);
  const wrongCoordinate = structuredClone(arguments_);
  wrongCoordinate.disposableCoordinate.branch = "review/issue-66-other";
  assert.throws(() => validateDisposableReviewAuthority(proof, wrongCoordinate, now),
    /evidence binding drift/u);
  const wrongIdentity = structuredClone(evidence.currentReviewActiveProof);
  wrongIdentity.liveIdentities.reviewTriggerUuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  wrongIdentity.proof_digest = createHash("sha256").update(JSON.stringify({
    state_digest: wrongIdentity.state_digest,
    snapshotStartedAt: wrongIdentity.snapshotStartedAt,
    snapshotCompletedAt: wrongIdentity.snapshotCompletedAt,
    capturedAt: wrongIdentity.capturedAt, liveIdentities: wrongIdentity.liveIdentities,
  })).digest("hex");
  assert.throws(() => issueDisposableReviewAuthority({ production, review, accountId,
    sourceSha: "a".repeat(40), ...evidence, currentReviewActiveProof: wrongIdentity,
    tokenRows: { production: { cloudflare_token_id: "production-token-id" },
      review: { cloudflare_token_id: "replacement-review-token-id" } } }, now),
  /journal\/live identity drift/u);
  const staleCurrent = reviewActiveProof(new Date(now - 31_000).toISOString(),
    evidence.currentReviewActiveProof.state_digest, "a".repeat(40),
    evidence.currentReviewActiveProof.liveIdentities);
  assert.throws(() => issueDisposableReviewAuthority({ production, review, accountId,
    sourceSha: "a".repeat(40), ...evidence, currentReviewActiveProof: staleCurrent,
    tokenRows: { production: { cloudflare_token_id: "production-token-id" },
      review: { cloudflare_token_id: "replacement-review-token-id" } } }, now),
  /staged proof drift|live proof drift/u);
});

test("issues one journal-bound review-token rotation authority", () => {
  const now = Date.now();
  const { evidence: disposable } = disposableReviewAuthorityFixture(now);
  const replacementTokenId = "replacement-review-token-id";
  const replacementTokenAuthorityProof = {
    kind: "review-replacement", source: "cloudflare-owner-token-policy-readback",
    capturedAt: new Date(now - 1_000).toISOString(),
    modifiedOn: new Date(now - 2_000).toISOString(), accountId,
    sourceSha: "a".repeat(40), tokenId: replacementTokenId,
    ownerUserId: "1".repeat(32),
    userPermissions: ["User Details:Read"], accountPermissions: [], accountResources: [],
    zonePermissions: [], zoneResources: [],
  };
  const evidence = {
    reviewActivationProof: disposable.reviewActivationProof,
    reviewActivationJournal: disposable.reviewActivationJournal,
    inertSetupJournal: disposable.inertSetupJournal,
    inertSetupResults: disposable.inertSetupResults,
    currentReviewActiveProof: disposable.predecessorReviewActiveProof,
    repositoryConnectionProof: disposable.repositoryConnectionProof,
    productionSentinelProof: disposable.productionSentinelProof,
    predecessorTokenAuthorityProofs: disposable.predecessorTokenAuthorityProofs,
    replacementTokenAuthorityProof, replacementTokenId,
    replacementTokenOwnerMembershipProof: { accountId,
      capturedAt: new Date(now - 900).toISOString(), membershipStatus: "accepted",
      ownerUserId: "1".repeat(32), source: "cloudflare-owner-account-membership-readback",
      sourceSha: "a".repeat(40) },
    buildUsageProof: disposable.buildUsageProof,
    productionBaselineProof: (() => {
      const value = { source: "workers-builds-review-token-rotation-production-baseline",
        accountId, sourceSha: "a".repeat(40), capturedAt: new Date(now - 950).toISOString(),
        currentReviewActiveProofDigest: disposable.predecessorReviewActiveProof.proof_digest,
        productionPreservationDigest: "8".repeat(64), productionScriptTag: scriptTag };
      return { ...value,
        proof_digest: createHash("sha256").update(JSON.stringify(value)).digest("hex") };
    })(),
    replacementTokenSecretSha256: "7".repeat(64),
  };
  const tokenRows = {
    production: { build_token_uuid:
      evidence.currentReviewActiveProof.liveIdentities.productionBuildTokenUuid,
    cloudflare_token_id: "production-token-id" },
    review: { build_token_uuid:
      evidence.currentReviewActiveProof.liveIdentities.reviewBuildTokenUuid,
    cloudflare_token_id: "review-token-id" },
  };
  const proof = issueReviewTokenRotationAuthority({ production, review, accountId,
    sourceSha: "a".repeat(40), ...evidence, tokenRows }, now);
  const arguments_ = { production, review, accountId, sourceSha: "a".repeat(40), ...evidence,
    tokenRows };
  assert.equal(proof.phase, "review-token-rotation");
  assert.equal(proof.replacementToken.name, reviewBuildTokenNames.current);
  assert.equal(proof.journalIdentities.predecessorReviewBuildTokenUuid, reviewTokenUuid);
  assert.equal(validateReplacementTokenOwnerMembershipProof({ accountId,
    sourceSha: "a".repeat(40), proof: evidence.replacementTokenOwnerMembershipProof,
    ownerUserId: replacementTokenAuthorityProof.ownerUserId }, now).membershipStatus,
  "accepted");
  assert.equal(Date.parse(proof.expiresAt) - Date.parse(proof.capturedAt), 30 * 60_000);
  assert.equal(validateReviewTokenRotationAuthority(proof, arguments_, now + 20 * 60_000)
    .proof_digest, proof.proof_digest);
  assert.throws(() => validateReviewTokenRotationAuthority(proof, arguments_,
    now + 26 * 60_000), /stale/u);
  const wrongPermission = structuredClone(arguments_);
  wrongPermission.replacementTokenAuthorityProof.accountPermissions.push("Workers Scripts:Read");
  assert.throws(() => validateReviewTokenRotationAuthority(proof, wrongPermission, now),
    /permission proof drift/u);
  const reusedUnderlying = structuredClone(arguments_);
  reusedUnderlying.replacementTokenId = "review-token-id";
  reusedUnderlying.replacementTokenAuthorityProof.tokenId = "review-token-id";
  assert.throws(() => issueReviewTokenRotationAuthority({ ...reusedUnderlying }, now),
    /journal\/live\/token identity drift/u);
  const wrongTrigger = structuredClone(arguments_);
  wrongTrigger.currentReviewActiveProof.liveIdentities.reviewTriggerUuid =
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  wrongTrigger.currentReviewActiveProof.proof_digest = createHash("sha256")
    .update(JSON.stringify({ state_digest: wrongTrigger.currentReviewActiveProof.state_digest,
      snapshotStartedAt: wrongTrigger.currentReviewActiveProof.snapshotStartedAt,
      snapshotCompletedAt: wrongTrigger.currentReviewActiveProof.snapshotCompletedAt,
      capturedAt: wrongTrigger.currentReviewActiveProof.capturedAt,
      liveIdentities: wrongTrigger.currentReviewActiveProof.liveIdentities }))
    .digest("hex");
  assert.throws(() => issueReviewTokenRotationAuthority({ ...wrongTrigger }, now),
    /production baseline proof drift|journal\/live\/token identity drift/u);
  for (const membership of [
    { ...evidence.replacementTokenOwnerMembershipProof, membershipStatus: "revoked" },
    { ...evidence.replacementTokenOwnerMembershipProof, ownerUserId: "2".repeat(32) },
  ]) assert.throws(() => issueReviewTokenRotationAuthority({ ...arguments_,
    replacementTokenOwnerMembershipProof: membership }, now), /active membership proof drift/u);
  const oldCredential = structuredClone(arguments_);
  oldCredential.replacementTokenAuthorityProof.modifiedOn = new Date(now - 10_000).toISOString();
  assert.throws(() => issueReviewTokenRotationAuthority(oldCredential, now),
    /journal\/live\/token identity drift/u);
  const equalToActivation = structuredClone(arguments_);
  equalToActivation.replacementTokenAuthorityProof.modifiedOn =
    equalToActivation.reviewActivationJournal.at(-1).at;
  assert.throws(() => issueReviewTokenRotationAuthority(equalToActivation, now),
    /journal\/live\/token identity drift/u);
  const widened = { ...proof, allowedWrites: [...proof.allowedWrites, "manual-build"] };
  assert.throws(() => validateReviewTokenRotationAuthority(widened, arguments_, now),
    /malformed or cross-phase/u);
});

test("validates exact review-token rotation rollback and residual journals", async () => {
  const now = Date.now();
  const base = now - 1_000;
  const temporary = await mkdtemp(resolve(tmpdir(), "atrinik-rotation-residual-"));
  const blockedSnapshotDirectory = resolve(temporary, "snapshot");
  await chmod(temporary, 0o700);
  await mkdir(blockedSnapshotDirectory, { mode: 0o700 });
  const writeSnapshot = async (name, value) => {
    const path = resolve(blockedSnapshotDirectory, name);
    await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    await chmod(path, 0o600);
  };
  const sourceSha = "a".repeat(40);
  const replacementReviewTokenUuid = "89898989-8989-4989-8989-898989898989";
  const productionTriggerUuid = "11111111-1111-4111-8111-111111111111";
  const repositoryConnectionUuid = "55555555-5555-4555-8555-555555555555";
  const providerTrigger = (spec, uuid) => ({ ...spec, trigger_uuid: uuid, deleted_on: null,
    repo_connection: { repo_connection_uuid: repositoryConnectionUuid,
      provider_type: "github", provider_account_id: "6371603",
      provider_account_name: "atrinik", repo_id: "1324297032",
      repo_name: "metaserver-worker" } });
  const productionActual = providerTrigger(productionTriggerSpec(production, {
    externalScriptId: scriptTag, repositoryConnectionUuid,
    buildTokenUuid: replacementReviewTokenUuid }), productionTriggerUuid);
  productionActual.branch_includes = [`review-build-only-sentinel-${"a".repeat(32)}`];
  const reviewActual = providerTrigger(automaticReviewTriggerSpec(review, {
    externalScriptId: scriptTag, repositoryConnectionUuid,
    buildTokenUuid: replacementReviewTokenUuid }), reviewTriggerUuid);
  const productionEnvironment = productionEnvironmentSpec(production,
    Object.fromEntries(Object.values(production.protectedInputs)
      .map((name) => [name, `${name}-value`])));
  for (const name of Object.values(production.protectedInputs))
    productionEnvironment[name].value = null;
  const manifest = (at) => ({ accountId, sourceSha, startedAt: new Date(at).toISOString(),
    completedAt: new Date(at).toISOString(),
    productionContractSha256: createHash("sha256").update(JSON.stringify(production))
      .digest("hex"),
    reviewContractSha256: createHash("sha256").update(JSON.stringify(review)).digest("hex") });
  await Promise.all([
    writeSnapshot("snapshot-manifest.json", manifest(base)),
    writeSnapshot("scripts.json", envelope([{ id: production.workers[0].name, tag: scriptTag }])),
    writeSnapshot("domains.json", envelope([])),
    writeSnapshot("production-migrations.json", envelope([])),
    writeSnapshot(`${production.workers[0].name}.triggers.json`,
      envelope([productionActual, reviewActual])),
    ...production.workers.slice(1).map(({ name }) =>
      writeSnapshot(`${name}.triggers.json`, envelope([]))),
    writeSnapshot(`${production.workers[0].name}.trigger-${productionTriggerUuid}.environment.json`,
      envelope(productionEnvironment)),
    writeSnapshot(`${production.workers[0].name}.trigger-${reviewTriggerUuid}.environment.json`,
      envelope(automaticReviewEnvironmentSpec(review))),
    writeSnapshot("build-tokens.json", envelope([
      { build_token_name: "Atrinik metaserver production",
        build_token_uuid: "44444444-4444-4444-8444-444444444444",
        cloudflare_token_id: "production-token-id", owner_type: "user" },
      { build_token_name: reviewBuildTokenNames.predecessor, build_token_uuid: reviewTokenUuid,
        cloudflare_token_id: "review-token-id", owner_type: "user" },
      { build_token_name: reviewBuildTokenNames.current,
        build_token_uuid: replacementReviewTokenUuid,
        cloudflare_token_id: "replacement-review-token-id", owner_type: "user" },
    ])),
    writeSnapshot("account-triggers.json", envelope([productionActual, reviewActual])),
    ...production.workers.flatMap(({ name }) => [
      writeSnapshot(`${name}.settings.json`, envelope([])),
      writeSnapshot(`${name}.subdomain.json`, envelope([])),
      writeSnapshot(`${name}.schedules.json`, envelope([])),
      writeSnapshot(`${name}.routes.json`, envelope([])),
      writeSnapshot(`${name}.script-settings.json`, envelope([])),
      writeSnapshot(`${name}.deployments.json`, envelope([])),
      writeSnapshot(`${name}.deployments-final.json`, envelope([])),
      writeSnapshot(`${name}.active-version.json`, envelope([])),
      writeSnapshot(`${name}.versions.json`, envelope([])),
      writeSnapshot(`${name}.deploy-hooks.json`, envelope([])),
      writeSnapshot(`${name}.builds.json`, envelope([])),
    ]),
  ]);
  const productionPreservationDigest = await snapshotProductionPreservationDigest(
    blockedSnapshotDirectory, production);
  const { evidence } = disposableReviewAuthorityFixture(now,
    "/secure/issue-66/disposable-proof", productionPreservationDigest);
  const authorityProof = evidence.reviewTokenRotationAuthorityProof;
  const restoredProof = { ...evidence.reviewTokenRotationProof,
    outcome: "workers-builds-review-token-rotation-predecessor-restored-valid",
    phase: "predecessor-restored", capturedAt: new Date(base + 105).toISOString(),
    proof_digest: "a".repeat(64) };
  const { replacementReviewTokenUuid: _replacement, ...completeBase } =
    evidence.reviewTokenRotationProof;
  const completeProof = { ...completeBase,
    outcome: "workers-builds-review-token-rotation-predecessor-valid", phase: "predecessor",
    capturedAt: new Date(base + 165).toISOString(), proof_digest: "b".repeat(64) };
  const pairs = [["review-token-rotation-rollback-started"],
    ...["rotation-restore-review-trigger-old-token",
      "rotation-restore-production-trigger-old-token"].flatMap((operation) => [
      ["current-main-proof-bound", operation], ["rollback-authority-checked", operation],
      ["mutation-intent", operation], ["provider-response-classified", operation],
      ["mutation-bound", operation],
    ]),
    ["provider-proof-bound", "rotation-prove-predecessor-restored"],
    ["current-main-proof-bound", "rotation-delete-replacement-wrapper"],
    ["rollback-authority-checked", "rotation-delete-replacement-wrapper"],
    ["mutation-intent", "rotation-delete-replacement-wrapper"],
    ["provider-response-classified", "rotation-delete-replacement-wrapper"],
    ["mutation-bound", "rotation-delete-replacement-wrapper"],
    ["provider-proof-bound", "rotation-prove-rollback-complete"],
    ["review-token-rotation-rollback-complete"]];
  const records = pairs.map(([event, operation], index) => {
    const payload = { event, ...(operation ? { operation } : {}), attempt: 1,
      at: new Date(base + index * 10).toISOString() };
    if (event === "review-token-rotation-rollback-started") Object.assign(payload, {
      startingPhase: "review-repointed", authorityProofDigest: authorityProof.proof_digest,
      replacementReviewTokenUuid,
    });
    if (event === "current-main-proof-bound") Object.assign(payload, {
      sourceSha: "a".repeat(40), ref: "refs/heads/main",
      capturedAt: new Date(base + index * 10 - 1).toISOString(),
      proofFileSha256: "c".repeat(64), rawFileSha256: "d".repeat(64),
    });
    if (event === "rollback-authority-checked") Object.assign(payload, {
      proofDigest: authorityProof.proof_digest, historicalRollbackAuthority: true,
    });
    if (["mutation-intent", "mutation-bound"].includes(event)) Object.assign(payload,
      reviewTokenRotationRollbackRequestDigest({ production, review, authorityProof, operation,
        replacementReviewTokenUuid }));
    if (event === "provider-response-classified") payload.outcome = "explicit-success";
    if (event === "mutation-bound") Object.assign(payload, {
      resourceUuid: operation === "rotation-restore-review-trigger-old-token" ?
        authorityProof.journalIdentities.reviewTriggerUuid :
        operation === "rotation-restore-production-trigger-old-token" ?
          authorityProof.journalIdentities.productionTriggerUuid : replacementReviewTokenUuid,
      providerResponseExplicitSuccess: true,
      readbackDigestSha256: "e".repeat(64),
      reconciliation: operation === "rotation-delete-replacement-wrapper" ?
        "explicit-success-exact-absence" : "explicit-success-exact-readback",
      ...(operation === "rotation-delete-replacement-wrapper" ?
        { deletionTombstone: true } : {}),
    });
    if (event === "provider-proof-bound") {
      const proof = operation === "rotation-prove-predecessor-restored" ? restoredProof :
        completeProof;
      Object.assign(payload, { proofDigest: proof.proof_digest,
        proofFileSha256: createHash("sha256").update(JSON.stringify(proof)).digest("hex") });
    }
    if (event === "review-token-rotation-rollback-complete") Object.assign(payload, {
      proofDigest: completeProof.proof_digest, productionActivation: false,
      migration0010: false, initialProductionBuild: false,
    });
    return checksummedRecord(payload);
  });
  const arguments_ = { production, review, accountId, sourceSha, restoredProof,
    completeProof, replacementReviewTokenUuid };
  assert.equal((await validateReviewTokenRotationRollbackJournal(records, authorityProof,
    arguments_))
    .startingPhase, "review-repointed");
  const altered = structuredClone(records);
  const intentIndex = altered.findIndex(({ event }) => event === "mutation-intent");
  const { recordSha256: _checksum, ...intent } = altered[intentIndex];
  intent.requestDigestSha256 = "0".repeat(64);
  altered[intentIndex] = checksummedRecord(intent);
  await assert.rejects(validateReviewTokenRotationRollbackJournal(altered, authorityProof,
    arguments_), /mutation provenance drift/u);
  const residualState = { activeMutation: null,
    liveProductionTokenReference: replacementReviewTokenUuid,
    liveReviewTokenReference: replacementReviewTokenUuid, predecessorWrapperPresent: true,
    replacementWrapperPresent: true };
  const blockedProof = await validateReviewTokenRotationSnapshotDirectory({ snapshotDirectory:
    blockedSnapshotDirectory, production, review, accountId, sourceSha,
    phase: "review-repointed", productionSentinelProof: evidence.productionSentinelProof,
    predecessorTokenAuthorityProofs: evidence.predecessorTokenAuthorityProofs,
    replacementTokenAuthorityProof: evidence.replacementTokenAuthorityProof,
    replacementTokenId: evidence.replacementTokenId, productionTriggerUuid,
    reviewTriggerUuid, predecessorReviewTokenUuid: reviewTokenUuid,
    replacementReviewTokenUuid, productionPreservationDigest, authorityProof,
    productionBaselineProof: evidence.productionBaselineProof, now: base + 5 });
  const blocked = [records[0], checksummedRecord({ event:
    "review-token-rotation-rollback-blocked", attempt: 1,
  at: new Date(base + 10).toISOString(), residualState,
  residualProofDigest: blockedProof.proof_digest,
  residualProofFileSha256: createHash("sha256").update(JSON.stringify(blockedProof))
    .digest("hex") })];
  assert.equal((await validateReviewTokenRotationRollbackJournal(blocked, authorityProof, {
    ...arguments_, blockedSnapshotDirectory, blockedProof,
    productionSentinelProof: evidence.productionSentinelProof,
    predecessorTokenAuthorityProofs: evidence.predecessorTokenAuthorityProofs,
    replacementTokenAuthorityProof: evidence.replacementTokenAuthorityProof,
    replacementTokenId: evidence.replacementTokenId,
    productionBaselineProof: evidence.productionBaselineProof }))
    .outcome, "workers-builds-review-token-rotation-rollback-blocked-valid");
  await writeSnapshot("account-triggers.json", envelope([productionActual, reviewActual, {
    ...reviewActual, trigger_uuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  }]));
  await assert.rejects(validateReviewTokenRotationRollbackJournal(blocked, authorityProof, {
    ...arguments_, blockedSnapshotDirectory, blockedProof,
    productionSentinelProof: evidence.productionSentinelProof,
    predecessorTokenAuthorityProofs: evidence.predecessorTokenAuthorityProofs,
    replacementTokenAuthorityProof: evidence.replacementTokenAuthorityProof,
    replacementTokenId: evidence.replacementTokenId,
    productionBaselineProof: evidence.productionBaselineProof }),
  /account trigger inventory drift/u);
  await writeSnapshot("account-triggers.json", envelope([productionActual, reviewActual]));
  await writeSnapshot("snapshot-manifest.json", manifest(base + 21));
  const preparedProof = await validateReviewTokenRotationSnapshotDirectory({ snapshotDirectory:
    blockedSnapshotDirectory, production, review, accountId, sourceSha,
  phase: "review-repointed", productionSentinelProof: evidence.productionSentinelProof,
  predecessorTokenAuthorityProofs: evidence.predecessorTokenAuthorityProofs,
  replacementTokenAuthorityProof: evidence.replacementTokenAuthorityProof,
  replacementTokenId: evidence.replacementTokenId, productionTriggerUuid,
  reviewTriggerUuid, predecessorReviewTokenUuid: reviewTokenUuid,
  replacementReviewTokenUuid, productionPreservationDigest, authorityProof,
  productionBaselineProof: evidence.productionBaselineProof, now: base + 25 });
  const preparedBlocked = [...records.slice(0, 3), checksummedRecord({ event:
    "review-token-rotation-rollback-blocked", attempt: 1, at: new Date(base + 30).toISOString(),
  residualState, residualProofDigest: preparedProof.proof_digest,
  residualProofFileSha256: createHash("sha256").update(JSON.stringify(preparedProof))
    .digest("hex") })];
  assert.equal((await validateReviewTokenRotationRollbackJournal(preparedBlocked,
    authorityProof, { ...arguments_, blockedSnapshotDirectory, blockedProof: preparedProof,
      productionSentinelProof: evidence.productionSentinelProof,
      predecessorTokenAuthorityProofs: evidence.predecessorTokenAuthorityProofs,
      replacementTokenAuthorityProof: evidence.replacementTokenAuthorityProof,
      replacementTokenId: evidence.replacementTokenId,
      productionBaselineProof: evidence.productionBaselineProof })).residualState.activeMutation,
  null);
  const failedPrefix = structuredClone(records.slice(0, 5));
  const { recordSha256: _failedChecksum, ...failedClassification } = failedPrefix[4];
  failedClassification.outcome = "explicit-failure";
  failedPrefix[4] = checksummedRecord(failedClassification);
  const failedResidual = { ...residualState,
    activeMutation: null };
  failedClassification.status = 403;
  failedClassification.responseDigestSha256 = "f".repeat(64);
  failedPrefix[4] = checksummedRecord(failedClassification);
  await writeSnapshot("snapshot-manifest.json", manifest(base + 41));
  const failedProof = await validateReviewTokenRotationSnapshotDirectory({ snapshotDirectory:
    blockedSnapshotDirectory, production, review, accountId, sourceSha,
  phase: "review-repointed", productionSentinelProof: evidence.productionSentinelProof,
  predecessorTokenAuthorityProofs: evidence.predecessorTokenAuthorityProofs,
  replacementTokenAuthorityProof: evidence.replacementTokenAuthorityProof,
  replacementTokenId: evidence.replacementTokenId, productionTriggerUuid,
  reviewTriggerUuid, predecessorReviewTokenUuid: reviewTokenUuid,
  replacementReviewTokenUuid, productionPreservationDigest, authorityProof,
  productionBaselineProof: evidence.productionBaselineProof, now: base + 45 });
  failedPrefix.push(checksummedRecord({ event: "review-token-rotation-rollback-blocked",
    attempt: 1, at: new Date(base + 50).toISOString(), residualState: failedResidual,
    residualProofDigest: failedProof.proof_digest,
    residualProofFileSha256: createHash("sha256").update(JSON.stringify(failedProof))
      .digest("hex") }));
  assert.equal((await validateReviewTokenRotationRollbackJournal(failedPrefix, authorityProof,
    { ...arguments_, blockedSnapshotDirectory, blockedProof: failedProof,
      productionSentinelProof: evidence.productionSentinelProof,
      predecessorTokenAuthorityProofs: evidence.predecessorTokenAuthorityProofs,
      replacementTokenAuthorityProof: evidence.replacementTokenAuthorityProof,
      replacementTokenId: evidence.replacementTokenId,
      productionBaselineProof: evidence.productionBaselineProof })).residualState.activeMutation,
  null);
  const postReview = providerTrigger(automaticReviewTriggerSpec(review, {
    externalScriptId: scriptTag, repositoryConnectionUuid, buildTokenUuid: reviewTokenUuid,
  }), reviewTriggerUuid);
  await Promise.all([
    writeSnapshot(`${production.workers[0].name}.triggers.json`,
      envelope([productionActual, postReview])),
    writeSnapshot("account-triggers.json", envelope([productionActual, postReview])),
  ]);
  for (const [outcome, offset] of [["ambiguous", 61], ["explicit-success", 81]]) {
    await writeSnapshot("snapshot-manifest.json", manifest(base + offset));
    const phaseProof = await validateReviewTokenRotationSnapshotDirectory({ snapshotDirectory:
      blockedSnapshotDirectory, production, review, accountId, sourceSha,
    phase: "production-repointed", productionSentinelProof: evidence.productionSentinelProof,
    predecessorTokenAuthorityProofs: evidence.predecessorTokenAuthorityProofs,
    replacementTokenAuthorityProof: evidence.replacementTokenAuthorityProof,
    replacementTokenId: evidence.replacementTokenId, productionTriggerUuid,
    reviewTriggerUuid, predecessorReviewTokenUuid: reviewTokenUuid,
    replacementReviewTokenUuid, productionPreservationDigest, authorityProof,
    productionBaselineProof: evidence.productionBaselineProof, now: base + offset + 4 });
    const prefix = structuredClone(records.slice(0, 5));
    const { recordSha256: _classificationChecksum, ...classification } = prefix[4];
    classification.outcome = outcome;
    prefix[4] = checksummedRecord(classification);
    const postResidual = { activeMutation: "rotation-restore-review-trigger-old-token",
      liveProductionTokenReference: replacementReviewTokenUuid,
      liveReviewTokenReference: reviewTokenUuid, predecessorWrapperPresent: true,
      replacementWrapperPresent: true };
    prefix.push(checksummedRecord({ event: "review-token-rotation-rollback-blocked",
      attempt: 1, at: new Date(base + offset + 5).toISOString(), residualState: postResidual,
      residualProofDigest: phaseProof.proof_digest,
      residualProofFileSha256: createHash("sha256").update(JSON.stringify(phaseProof))
        .digest("hex") }));
    assert.equal((await validateReviewTokenRotationRollbackJournal(prefix, authorityProof,
      { ...arguments_, blockedSnapshotDirectory, blockedProof: phaseProof,
        productionSentinelProof: evidence.productionSentinelProof,
        predecessorTokenAuthorityProofs: evidence.predecessorTokenAuthorityProofs,
        replacementTokenAuthorityProof: evidence.replacementTokenAuthorityProof,
        replacementTokenId: evidence.replacementTokenId,
        productionBaselineProof: evidence.productionBaselineProof })).residualState
      .liveReviewTokenReference, reviewTokenUuid);
    if (outcome === "explicit-success") {
      const wrong = structuredClone(prefix);
      const { recordSha256: _terminalChecksum, ...wrongTerminal } = wrong.at(-1);
      wrongTerminal.residualState = residualState;
      wrong[wrong.length - 1] = checksummedRecord(wrongTerminal);
      await assert.rejects(validateReviewTokenRotationRollbackJournal(wrong, authorityProof,
        { ...arguments_, blockedSnapshotDirectory, blockedProof: phaseProof,
          productionSentinelProof: evidence.productionSentinelProof,
          predecessorTokenAuthorityProofs: evidence.predecessorTokenAuthorityProofs,
          replacementTokenAuthorityProof: evidence.replacementTokenAuthorityProof,
          replacementTokenId: evidence.replacementTokenId,
          productionBaselineProof: evidence.productionBaselineProof }),
      /residual state drift|trigger build_token_uuid drift/u);
    }
  }
  const predecessorProduction = providerTrigger(productionTriggerSpec(production, {
    externalScriptId: scriptTag, repositoryConnectionUuid, buildTokenUuid: reviewTokenUuid,
  }), productionTriggerUuid);
  predecessorProduction.branch_includes = [`review-build-only-sentinel-${"a".repeat(32)}`];
  const predecessorReview = providerTrigger(automaticReviewTriggerSpec(review, {
    externalScriptId: scriptTag, repositoryConnectionUuid, buildTokenUuid: reviewTokenUuid,
  }), reviewTriggerUuid);
  const retainedAugmentation = structuredClone(predecessorReview);
  retainedAugmentation.branch_excludes = [review.productionBranch,
    evidence.productionSentinelProof.branch];
  await Promise.all([
    writeSnapshot("snapshot-manifest.json", manifest(base + 141)),
    writeSnapshot(`${production.workers[0].name}.triggers.json`,
      envelope([predecessorProduction, retainedAugmentation])),
    writeSnapshot("account-triggers.json",
      envelope([predecessorProduction, retainedAugmentation])),
  ]);
  const peerArguments = { snapshotDirectory: blockedSnapshotDirectory,
    production, review, accountId, sourceSha, productionSentinelProof:
      evidence.productionSentinelProof, predecessorTokenAuthorityProofs:
      evidence.predecessorTokenAuthorityProofs, replacementTokenAuthorityProof:
      evidence.replacementTokenAuthorityProof, replacementTokenId: evidence.replacementTokenId,
    productionTriggerUuid, reviewTriggerUuid, predecessorReviewTokenUuid: reviewTokenUuid,
    replacementReviewTokenUuid, productionPreservationDigest, authorityProof,
    productionBaselineProof: evidence.productionBaselineProof, now: base + 145 };
  assert.equal((await validateReviewTokenRotationProviderPeerNormalizationSnapshotDirectory(
    peerArguments)).phase, "production-restored-review-augmented");
  await Promise.all([
    writeSnapshot("snapshot-manifest.json", manifest(base + 151)),
    writeSnapshot(`${production.workers[0].name}.triggers.json`,
      envelope([predecessorProduction, predecessorReview])),
    writeSnapshot("account-triggers.json", envelope([predecessorProduction, predecessorReview])),
  ]);
  assert.equal((await validateReviewTokenRotationProviderPeerNormalizationSnapshotDirectory({
    ...peerArguments, now: base + 155 })).phase, "predecessor-restored");
  const incidentForwardRecords = evidence.reviewTokenRotationJournal.slice(0, 12);
  const incidentCoordinate = { sourceSha, planDigest: authorityProof.planDigest,
    forwardJournalSha256: "1".repeat(64),
    forwardJournalDigest: createHash("sha256")
      .update(JSON.stringify(incidentForwardRecords)).digest("hex"),
    incidentSnapshotManifestSha256: "2".repeat(64), authorityFileSha256: "3".repeat(64) };
  const incidentProof = { ...evidence.reviewTokenRotationIntermediateProof,
    outcome:
      "workers-builds-review-token-rotation-production-repointed-review-augmented-valid",
    phase: "production-repointed-review-augmented",
    capturedAt: new Date(base + 155).toISOString(), proof_digest: "4".repeat(64) };
  const incidentValidation = validateReviewTokenRotationProviderNormalizedIncident(
    incidentForwardRecords, incidentProof, authorityProof, { production, review, accountId,
      forwardJournalSha256: incidentCoordinate.forwardJournalSha256,
      incidentSnapshotManifestSha256: incidentCoordinate.incidentSnapshotManifestSha256,
      authorityFileSha256: incidentCoordinate.authorityFileSha256,
      coordinate: incidentCoordinate });
  const incidentRollbackStart = checksummedRecord({ event:
    "review-token-rotation-rollback-started", attempt: 1,
  at: new Date(base + 156).toISOString(),
  startingPhase: "production-repointed-review-augmented",
  authorityProofDigest: authorityProof.proof_digest, replacementReviewTokenUuid,
  incidentCoordinateDigest: incidentValidation.incidentCoordinateDigest,
  incidentProofDigest: incidentProof.proof_digest,
  forwardJournalDigest: incidentValidation.forwardJournalDigest });
  await Promise.all([
    writeSnapshot("snapshot-manifest.json", manifest(base + 158)),
    writeSnapshot(`${production.workers[0].name}.triggers.json`,
      envelope([productionActual, retainedAugmentation])),
    writeSnapshot("account-triggers.json", envelope([productionActual, retainedAugmentation])),
  ]);
  const incidentBlockedProof = await validateReviewTokenRotationSnapshotDirectory({
    snapshotDirectory: blockedSnapshotDirectory, production, review, accountId, sourceSha,
    phase: "production-repointed-review-augmented",
    productionSentinelProof: evidence.productionSentinelProof,
    predecessorTokenAuthorityProofs: evidence.predecessorTokenAuthorityProofs,
    replacementTokenAuthorityProof: evidence.replacementTokenAuthorityProof,
    replacementTokenId: evidence.replacementTokenId, productionTriggerUuid,
    reviewTriggerUuid, predecessorReviewTokenUuid: reviewTokenUuid,
    replacementReviewTokenUuid, productionPreservationDigest, authorityProof,
    productionBaselineProof: evidence.productionBaselineProof, now: base + 159 });
  const incidentBlocked = [incidentRollbackStart, checksummedRecord({ event:
    "review-token-rotation-rollback-blocked", attempt: 1,
  at: new Date(base + 160).toISOString(), residualState: { activeMutation: null,
    liveProductionTokenReference: replacementReviewTokenUuid,
    liveReviewTokenReference: reviewTokenUuid, predecessorWrapperPresent: true,
    replacementWrapperPresent: true, reviewPeerAugmented: true },
  residualProofDigest: incidentBlockedProof.proof_digest,
  residualProofFileSha256: createHash("sha256")
    .update(JSON.stringify(incidentBlockedProof)).digest("hex") })];
  const incidentRollbackArguments = { ...arguments_, incidentProof, incidentForwardRecords,
    incidentForwardJournalSha256: incidentCoordinate.forwardJournalSha256,
    incidentSnapshotManifestSha256: incidentCoordinate.incidentSnapshotManifestSha256,
    incidentAuthorityFileSha256: incidentCoordinate.authorityFileSha256, incidentCoordinate,
    blockedSnapshotDirectory, blockedProof: incidentBlockedProof,
    productionSentinelProof: evidence.productionSentinelProof,
    predecessorTokenAuthorityProofs: evidence.predecessorTokenAuthorityProofs,
    replacementTokenAuthorityProof: evidence.replacementTokenAuthorityProof,
    replacementTokenId: evidence.replacementTokenId,
    productionBaselineProof: evidence.productionBaselineProof };
  assert.equal((await validateReviewTokenRotationRollbackJournal(incidentBlocked,
    authorityProof, incidentRollbackArguments)).outcome,
  "workers-builds-review-token-rotation-rollback-blocked-valid");
  assert.equal((await classifyReviewTokenRotationProviderNormalizedRollbackPrefix(
    incidentBlocked, { ...incidentRollbackArguments, authorityProof })).terminal, true);
  await Promise.all([
    writeSnapshot("snapshot-manifest.json", manifest(base + 161)),
    writeSnapshot(`${production.workers[0].name}.triggers.json`,
      envelope([predecessorProduction, predecessorReview])),
    writeSnapshot("account-triggers.json", envelope([predecessorProduction, predecessorReview])),
    writeSnapshot("build-tokens.json", envelope([
      { build_token_name: "Atrinik metaserver production",
        build_token_uuid: "44444444-4444-4444-8444-444444444444",
        cloudflare_token_id: "production-token-id", owner_type: "user" },
      { build_token_name: reviewBuildTokenNames.predecessor, build_token_uuid: reviewTokenUuid,
        cloudflare_token_id: "review-token-id", owner_type: "user" },
    ])),
  ]);
  const afterDeleteProof = await validateReviewTokenRotationSnapshotDirectory({
    snapshotDirectory: blockedSnapshotDirectory, production, review, accountId, sourceSha,
    phase: "predecessor", productionSentinelProof: evidence.productionSentinelProof,
    predecessorTokenAuthorityProofs: evidence.predecessorTokenAuthorityProofs,
    replacementTokenAuthorityProof: evidence.replacementTokenAuthorityProof,
    replacementTokenId: evidence.replacementTokenId, productionTriggerUuid,
    reviewTriggerUuid, predecessorReviewTokenUuid: reviewTokenUuid,
    replacementReviewTokenUuid: undefined, productionPreservationDigest, authorityProof,
    productionBaselineProof: evidence.productionBaselineProof, now: base + 165 });
  const afterDeleteResidual = { activeMutation: null,
    liveProductionTokenReference: reviewTokenUuid,
    liveReviewTokenReference: reviewTokenUuid, predecessorWrapperPresent: true,
    replacementWrapperPresent: false };
  const blockedAfterDelete = [...records.slice(0, 17), checksummedRecord({ event:
    "review-token-rotation-rollback-blocked", attempt: 1,
  at: new Date(base + 170).toISOString(), residualState: afterDeleteResidual,
  residualProofDigest: afterDeleteProof.proof_digest,
  residualProofFileSha256: createHash("sha256").update(JSON.stringify(afterDeleteProof))
    .digest("hex") })];
  assert.equal((await validateReviewTokenRotationRollbackJournal(blockedAfterDelete,
    authorityProof, { ...arguments_, blockedSnapshotDirectory, blockedProof: afterDeleteProof,
      productionSentinelProof: evidence.productionSentinelProof,
      predecessorTokenAuthorityProofs: evidence.predecessorTokenAuthorityProofs,
      replacementTokenAuthorityProof: evidence.replacementTokenAuthorityProof,
      replacementTokenId: evidence.replacementTokenId,
      productionBaselineProof: evidence.productionBaselineProof })).residualState
    .replacementWrapperPresent, false);
  const { evidence: expiredEvidence } = disposableReviewAuthorityFixture(now - 31 * 60_000,
    "/secure/issue-66/disposable-proof-expired", productionPreservationDigest);
  const expiredAuthority = expiredEvidence.reviewTokenRotationAuthorityProof;
  const expiry = Date.parse(expiredAuthority.expiresAt);
  assert.ok(expiry < now);
  await writeSnapshot("snapshot-manifest.json", manifest(now - 500));
  const expiredPredecessorProof = await validateReviewTokenRotationSnapshotDirectory({
    snapshotDirectory: blockedSnapshotDirectory, production, review, accountId, sourceSha,
    phase: "predecessor", productionSentinelProof: expiredEvidence.productionSentinelProof,
    predecessorTokenAuthorityProofs: expiredEvidence.predecessorTokenAuthorityProofs,
    replacementTokenAuthorityProof: expiredEvidence.replacementTokenAuthorityProof,
    replacementTokenId: expiredEvidence.replacementTokenId, productionTriggerUuid,
    reviewTriggerUuid, predecessorReviewTokenUuid: reviewTokenUuid,
    replacementReviewTokenUuid: undefined, productionPreservationDigest,
    authorityProof: expiredAuthority,
    productionBaselineProof: expiredEvidence.productionBaselineProof, now: now - 400 });
  const unresolvedCoordinate = reviewTokenRotationUnresolvedReplacementCoordinate(
    expiredAuthority);
  const noOwnedRollback = [
    checksummedRecord({ event: "review-token-rotation-rollback-started", attempt: 1,
      at: new Date(expiry + 1).toISOString(), startingPhase: "predecessor",
      authorityProofDigest: expiredAuthority.proof_digest,
      replacementReviewTokenUuid: unresolvedCoordinate }),
    checksummedRecord({ event: "review-token-rotation-rollback-blocked", attempt: 1,
      at: new Date(now - 300).toISOString(), residualState: { activeMutation: null,
        liveProductionTokenReference: reviewTokenUuid,
        liveReviewTokenReference: reviewTokenUuid, predecessorWrapperPresent: true,
        replacementWrapperPresent: false },
      residualProofDigest: expiredPredecessorProof.proof_digest,
      residualProofFileSha256: createHash("sha256").update(
        JSON.stringify(expiredPredecessorProof)).digest("hex") }),
  ];
  const noOwnedArguments = { productionSentinelProof: expiredEvidence.productionSentinelProof,
    predecessorTokenAuthorityProofs: expiredEvidence.predecessorTokenAuthorityProofs,
    replacementTokenAuthorityProof: expiredEvidence.replacementTokenAuthorityProof,
    replacementTokenId: expiredEvidence.replacementTokenId,
    productionBaselineProof: expiredEvidence.productionBaselineProof,
    blockedSnapshotDirectory, blockedProof: expiredPredecessorProof };
  const preIntentForward = expiredEvidence.reviewTokenRotationJournal.slice(0, 4);
  for (const prefixLength of [1, 2, 3, 4]) {
    assert.equal((await validateReviewTokenRotationNoOwnedPreIntentTerminal(
      preIntentForward.slice(0, prefixLength), expiredAuthority,
      { production, review, accountId, sourceSha, rollbackRecords: noOwnedRollback,
        rollbackArguments: noOwnedArguments }, now)).outcome,
    "workers-builds-review-token-rotation-no-owned-predecessor-blocked-valid");
  }
  await assert.rejects(validateReviewTokenRotationNoOwnedPreIntentTerminal(
    expiredEvidence.reviewTokenRotationJournal.slice(0, 5), expiredAuthority,
    { production, review, accountId, sourceSha, rollbackRecords: noOwnedRollback,
      rollbackArguments: noOwnedArguments }, now), /no-owned prefix drift/u);
  const wrongCoordinateRollback = structuredClone(noOwnedRollback);
  const { recordSha256: _startRecordChecksum, ...wrongCoordinateStart } =
    wrongCoordinateRollback[0];
  wrongCoordinateStart.replacementReviewTokenUuid = replacementReviewTokenUuid;
  wrongCoordinateRollback[0] = checksummedRecord(wrongCoordinateStart);
  await assert.rejects(validateReviewTokenRotationNoOwnedPreIntentTerminal(preIntentForward,
    expiredAuthority, { production, review, accountId, sourceSha,
      rollbackRecords: wrongCoordinateRollback, rollbackArguments: noOwnedArguments }, now),
  /residual coordinate drift/u);
  const lateAuthorizedForward = structuredClone(preIntentForward.slice(0, 2));
  const { recordSha256: _lateAuthorizedChecksum, ...lateAuthorized } =
    lateAuthorizedForward[1];
  lateAuthorized.at = expiredAuthority.expiresAt;
  lateAuthorizedForward[1] = checksummedRecord(lateAuthorized);
  await assert.rejects(validateReviewTokenRotationNoOwnedPreIntentTerminal(
    lateAuthorizedForward, expiredAuthority,
    { production, review, accountId, sourceSha, rollbackRecords: noOwnedRollback,
      rollbackArguments: noOwnedArguments }, now), /prefix provenance drift/u);
  const preExpiryRollback = structuredClone(noOwnedRollback);
  const { recordSha256: _preExpiryChecksum, ...preExpiryStart } = preExpiryRollback[0];
  preExpiryStart.at = new Date(expiry - 1).toISOString();
  preExpiryRollback[0] = checksummedRecord(preExpiryStart);
  await assert.rejects(validateReviewTokenRotationNoOwnedPreIntentTerminal(preIntentForward,
    expiredAuthority, { production, review, accountId, sourceSha,
      rollbackRecords: preExpiryRollback, rollbackArguments: noOwnedArguments }, now),
  /residual coordinate drift/u);
  await Promise.all([
    writeSnapshot(`${production.workers[0].name}.triggers.json`,
      envelope([productionActual, reviewActual])),
    writeSnapshot("account-triggers.json", envelope([productionActual, reviewActual])),
    writeSnapshot("build-tokens.json", envelope([
      { build_token_name: "Atrinik metaserver production",
        build_token_uuid: "44444444-4444-4444-8444-444444444444",
        cloudflare_token_id: "production-token-id", owner_type: "user" },
      { build_token_name: reviewBuildTokenNames.predecessor, build_token_uuid: reviewTokenUuid,
        cloudflare_token_id: "review-token-id", owner_type: "user" },
      { build_token_name: reviewBuildTokenNames.current,
        build_token_uuid: replacementReviewTokenUuid,
        cloudflare_token_id: "replacement-review-token-id", owner_type: "user" },
    ])),
  ]);
  const staleMain = structuredClone(records);
  const mainIndex = staleMain.findIndex(({ event }) => event === "current-main-proof-bound");
  const { recordSha256: _mainChecksum, ...main } = staleMain[mainIndex];
  main.capturedAt = new Date(base - 6 * 60_000).toISOString();
  staleMain[mainIndex] = checksummedRecord(main);
  await assert.rejects(validateReviewTokenRotationRollbackJournal(staleMain, authorityProof,
    arguments_), /mutation provenance drift/u);
  const staleComplete = { ...completeProof, capturedAt: new Date(base - 1).toISOString() };
  await assert.rejects(validateReviewTokenRotationRollbackJournal(records, authorityProof,
    { ...arguments_, completeProof: staleComplete }), /terminal provenance drift/u);
  const blockedAfterBadIntent = structuredClone(records.slice(0, 4));
  const badIntent = { ...blockedAfterBadIntent[3], requestDigestSha256: "0".repeat(64) };
  delete badIntent.recordSha256;
  blockedAfterBadIntent[3] = checksummedRecord(badIntent);
  const activeResidual = { ...residualState,
    activeMutation: "rotation-restore-review-trigger-old-token",
    liveProductionTokenReference: replacementReviewTokenUuid };
  blockedAfterBadIntent.push(checksummedRecord({ event:
    "review-token-rotation-rollback-blocked", attempt: 1, at: new Date(base + 40).toISOString(),
  residualState: activeResidual, residualProofDigest: blockedProof.proof_digest,
  residualProofFileSha256: createHash("sha256").update(JSON.stringify(blockedProof))
    .digest("hex") }));
  await assert.rejects(validateReviewTokenRotationRollbackJournal(blockedAfterBadIntent,
    authorityProof, { ...arguments_, blockedSnapshotDirectory, blockedProof,
      productionSentinelProof: evidence.productionSentinelProof,
      predecessorTokenAuthorityProofs: evidence.predecessorTokenAuthorityProofs,
      replacementTokenAuthorityProof: evidence.replacementTokenAuthorityProof,
      replacementTokenId: evidence.replacementTokenId,
      productionBaselineProof: evidence.productionBaselineProof }), /mutation provenance drift/u);
  await Promise.all([
    writeSnapshot("snapshot-manifest.json", manifest(Date.now() - 10)),
    writeSnapshot(`${production.workers[0].name}.triggers.json`,
      envelope([productionActual, reviewActual])),
    writeSnapshot("account-triggers.json", envelope([productionActual, reviewActual])),
    writeSnapshot("build-tokens.json", envelope([
      { build_token_name: "Atrinik metaserver production",
        build_token_uuid: "44444444-4444-4444-8444-444444444444",
        cloudflare_token_id: "production-token-id", owner_type: "user" },
      { build_token_name: reviewBuildTokenNames.current,
        build_token_uuid: replacementReviewTokenUuid,
        cloudflare_token_id: "replacement-review-token-id", owner_type: "user" },
    ])),
  ]);
  const cliInputs = resolve(temporary, "cli-inputs");
  await mkdir(cliInputs, { mode: 0o700 });
  const privateFile = async (name, value, lines = false) => {
    const path = resolve(cliInputs, name);
    const text = lines ? value.map((row) => JSON.stringify(row)).join("\n") + "\n" :
      typeof value === "string" ? `${value}\n` : `${JSON.stringify(value)}\n`;
    await writeFile(path, text, { mode: 0o600 });
    return path;
  };
  const productionPermission = expiredEvidence.predecessorTokenAuthorityProofs
    .find(({ kind }) => kind === "production");
  const reviewPermission = expiredEvidence.predecessorTokenAuthorityProofs
    .find(({ kind }) => kind === "review");
  const cliEnvironment = {
    ATRINIK_CLOUDFLARE_ACCOUNT_ID_FILE: await privateFile("account-id", accountId),
    ATRINIK_WORKERS_BUILDS_API_TOKEN_FILE: await privateFile("control-token", "control-token"),
    ATRINIK_PRODUCTION_BUILD_TOKEN_SECRET_FILE: await privateFile(
      "production-token", "production-token"),
    ATRINIK_REVIEW_TOKEN_ROTATION_AUTHORITY_PROOF_FILE: await privateFile(
      "authority.json", expiredAuthority),
    ATRINIK_REVIEW_ACTIVATION_PROOF_FILE: await privateFile(
      "activation-proof.json", expiredEvidence.reviewActivationProof),
    ATRINIK_REVIEW_ACTIVATION_JOURNAL_FILE: await privateFile(
      "activation-journal.jsonl", expiredEvidence.reviewActivationJournal, true),
    ATRINIK_INERT_SETUP_JOURNAL_FILE: await privateFile(
      "setup-journal.jsonl", expiredEvidence.inertSetupJournal, true),
    ATRINIK_INERT_SETUP_RESULTS_FILE: await privateFile(
      "setup-results.json", expiredEvidence.inertSetupResults),
    ATRINIK_REPOSITORY_CONNECTION_OWNER_PROOF_FILE: await privateFile(
      "repository-owner.json", expiredEvidence.repositoryConnectionProof),
    ATRINIK_PRODUCTION_STAGING_SENTINEL_BRANCH_FILE: await privateFile(
      "sentinel-branch", expiredEvidence.productionSentinelProof.branch),
    ATRINIK_PRODUCTION_STAGING_SENTINEL_REFS_FILE: await privateFile(
      "sentinel.json", expiredEvidence.productionSentinelProof),
    ATRINIK_PRODUCTION_BUILD_TOKEN_PERMISSION_PROOF_FILE: await privateFile(
      "production-permission.json", productionPermission),
    ATRINIK_REVIEW_BUILD_TOKEN_PERMISSION_PROOF_FILE: await privateFile(
      "review-permission.json", reviewPermission),
    ATRINIK_REPLACEMENT_REVIEW_BUILD_TOKEN_PERMISSION_PROOF_FILE: await privateFile(
      "replacement-permission.json", expiredEvidence.replacementTokenAuthorityProof),
    ATRINIK_REPLACEMENT_REVIEW_TOKEN_OWNER_MEMBERSHIP_PROOF_FILE: await privateFile(
      "replacement-membership.json", expiredEvidence.replacementTokenOwnerMembershipProof),
    ATRINIK_REPLACEMENT_REVIEW_BUILD_TOKEN_ID_FILE: await privateFile(
      "replacement-id", expiredEvidence.replacementTokenId),
    ATRINIK_REPLACEMENT_REVIEW_BUILD_TOKEN_SECRET_FILE: await privateFile(
      "replacement-secret", "replacement-secret"),
    ATRINIK_WORKERS_BUILDS_USAGE_PROOF_FILE: await privateFile(
      "usage.json", expiredEvidence.buildUsageProof),
    ATRINIK_REVIEW_TOKEN_ROTATION_PREDECESSOR_PROOF_FILE: await privateFile(
      "predecessor-proof.json", expiredEvidence.predecessorReviewActiveProof),
    ATRINIK_REVIEW_TOKEN_ROTATION_PRODUCTION_BASELINE_PROOF_FILE: await privateFile(
      "baseline.json", expiredEvidence.productionBaselineProof),
    ATRINIK_REPLACEMENT_REVIEW_BUILD_TOKEN_UUID_FILE: await privateFile(
      "replacement-uuid", replacementReviewTokenUuid),
    ATRINIK_PROVIDER_SNAPSHOT_OUTPUT: blockedSnapshotDirectory,
    ATRINIK_REVIEW_TOKEN_ROTATION_COMPLETE_PROOF_OUTPUT_FILE:
      resolve(cliInputs, "historical-complete.json"),
    ATRINIK_REVIEW_TOKEN_ROTATION_PEER_NORMALIZATION_PROOF_OUTPUT_FILE:
      resolve(cliInputs, "peer-normalization.json"),
    ATRINIK_REVIEW_TOKEN_ROTATION_PROVIDER_NORMALIZED_FORWARD_JOURNAL_FILE: await privateFile(
      "provider-normalized-forward.jsonl",
      expiredEvidence.reviewTokenRotationJournal.slice(0, 12), true),
    ATRINIK_REVIEW_TOKEN_ROTATION_PROVIDER_NORMALIZED_INCIDENT_SNAPSHOT_DIRECTORY_FILE:
      await privateFile("provider-normalized-snapshot-directory", blockedSnapshotDirectory),
    ATRINIK_REVIEW_TOKEN_ROTATION_PROVIDER_NORMALIZED_INCIDENT_PROOF_OUTPUT_FILE:
      resolve(cliInputs, "provider-normalized-incident.json"),
  };
  const previousEnvironment = { ...process.env };
  const originalWrite = process.stdout.write;
  let snapshotReads = 0;
  try {
    Object.assign(process.env, cliEnvironment);
    process.stdout.write = () => true;
    await runProvisioningCli("--verify-review-token-rotation-complete-historical",
      async () => sourceSha, async ({ outputDirectory }) => {
        snapshotReads += 1;
        assert.equal(outputDirectory, blockedSnapshotDirectory);
        return { outcome: "injected-stable-readback", mutation: false };
      });
    await Promise.all([
      writeSnapshot("snapshot-manifest.json", manifest(Date.now() - 10)),
      writeSnapshot(`${production.workers[0].name}.triggers.json`,
        envelope([productionActual, retainedAugmentation])),
      writeSnapshot("account-triggers.json", envelope([productionActual,
        retainedAugmentation])),
      writeSnapshot("build-tokens.json", envelope([
        { build_token_name: "Atrinik metaserver production",
          build_token_uuid: "44444444-4444-4444-8444-444444444444",
          cloudflare_token_id: "production-token-id", owner_type: "user" },
        { build_token_name: reviewBuildTokenNames.predecessor,
          build_token_uuid: reviewTokenUuid, cloudflare_token_id: "review-token-id",
          owner_type: "user" },
        { build_token_name: reviewBuildTokenNames.current,
          build_token_uuid: replacementReviewTokenUuid,
          cloudflare_token_id: "replacement-review-token-id", owner_type: "user" },
      ])),
    ]);
    const fileSha256 = async (path) => createHash("sha256")
      .update(await readFile(path)).digest("hex");
    const incidentForwardRecords = expiredEvidence.reviewTokenRotationJournal.slice(0, 12);
    const incidentCoordinate = { sourceSha, planDigest: expiredAuthority.planDigest,
      forwardJournalSha256: await fileSha256(
        cliEnvironment.ATRINIK_REVIEW_TOKEN_ROTATION_PROVIDER_NORMALIZED_FORWARD_JOURNAL_FILE),
      forwardJournalDigest: createHash("sha256")
        .update(JSON.stringify(incidentForwardRecords)).digest("hex"),
      incidentSnapshotManifestSha256: await fileSha256(
        resolve(blockedSnapshotDirectory, "snapshot-manifest.json")),
      authorityFileSha256: await fileSha256(
        cliEnvironment.ATRINIK_REVIEW_TOKEN_ROTATION_AUTHORITY_PROOF_FILE) };
    await runProvisioningCli("--verify-review-token-rotation-provider-normalized-incident",
      async () => sourceSha, async () => {
        throw new Error("provider-normalized incident validation must use retained evidence");
      }, incidentCoordinate);
    await Promise.all([
      writeSnapshot("snapshot-manifest.json", manifest(Date.now() - 10)),
      writeSnapshot(`${production.workers[0].name}.triggers.json`,
        envelope([predecessorProduction, predecessorReview])),
      writeSnapshot("account-triggers.json", envelope([predecessorProduction,
        predecessorReview])),
      writeSnapshot("build-tokens.json", envelope([
        { build_token_name: "Atrinik metaserver production",
          build_token_uuid: "44444444-4444-4444-8444-444444444444",
          cloudflare_token_id: "production-token-id", owner_type: "user" },
        { build_token_name: reviewBuildTokenNames.predecessor,
          build_token_uuid: reviewTokenUuid, cloudflare_token_id: "review-token-id",
          owner_type: "user" },
        { build_token_name: reviewBuildTokenNames.current,
          build_token_uuid: replacementReviewTokenUuid,
          cloudflare_token_id: "replacement-review-token-id", owner_type: "user" },
      ])),
    ]);
    await runProvisioningCli("--verify-review-token-rotation-provider-peer-normalization",
      async () => sourceSha, async () => {
        snapshotReads += 1;
        return { outcome: "injected-stable-readback", mutation: false };
      });
  } finally {
    process.stdout.write = originalWrite;
    for (const key of Object.keys(process.env)) if (!(key in previousEnvironment))
      delete process.env[key];
    Object.assign(process.env, previousEnvironment);
  }
  assert.equal(snapshotReads, 2);
  const historicalOutput = JSON.parse(await readFile(
    cliEnvironment.ATRINIK_REVIEW_TOKEN_ROTATION_COMPLETE_PROOF_OUTPUT_FILE, "utf8"));
  assert.equal(historicalOutput.phase, "complete");
  assert.equal(historicalOutput.replacementReviewTokenUuid, replacementReviewTokenUuid);
  const peerOutput = JSON.parse(await readFile(
    cliEnvironment.ATRINIK_REVIEW_TOKEN_ROTATION_PEER_NORMALIZATION_PROOF_OUTPUT_FILE, "utf8"));
  assert.equal(peerOutput.phase, "predecessor-restored");
  const incidentOutput = JSON.parse(await readFile(
    cliEnvironment.ATRINIK_REVIEW_TOKEN_ROTATION_PROVIDER_NORMALIZED_INCIDENT_PROOF_OUTPUT_FILE,
    "utf8"));
  assert.equal(incidentOutput.phase, "production-repointed-review-augmented");
  await rm(temporary, { recursive: true, force: true });
});

test("recovers an exact complete rotation after the original write authority expires", () => {
  const now = Date.now();
  const fixtureNow = now - 31 * 60_000;
  const { evidence, production, review, accountId, sourceSha } =
    disposableReviewAuthorityFixture(fixtureNow);
  const authority = evidence.reviewTokenRotationAuthorityProof;
  assert.ok(Date.parse(authority.expiresAt) < now);
  const original = evidence.reviewTokenRotationJournal;
  const terminalTemplate = original.at(-1);
  const terminalProof = { ...evidence.reviewTokenRotationProof,
    capturedAt: new Date(now - 30).toISOString(), proof_digest: "a".repeat(64) };
  const proofFileSha256 = createHash("sha256").update(JSON.stringify(terminalProof))
    .digest("hex");
  const recoveryRecords = (prefixLength) => [
    ...original.slice(0, prefixLength),
    checksummedRecord({ event: "review-token-rotation-complete-recovery-started", attempt: 1,
      at: new Date(now - 40).toISOString(), authorityProofDigest: authority.proof_digest,
      predecessorReviewTokenUuid: authority.journalIdentities.predecessorReviewBuildTokenUuid,
      replacementReviewTokenUuid: terminalProof.replacementReviewTokenUuid,
      providerMutation: false }),
    checksummedRecord({ event: "provider-proof-bound",
      operation: "review-token-rotation-recovery-readback", attempt: 1,
      at: new Date(now - 20).toISOString(), proofDigest: terminalProof.proof_digest,
      proofFileSha256 }),
    checksummedRecord({ event: "deletion-recovery-bound",
      operation: "retire-superseded-review-build-token", attempt: 1,
      at: new Date(now - 10).toISOString(), authorityProofDigest: authority.proof_digest,
      requestDigestSha256: original[21].requestDigestSha256,
      resourceUuid: authority.journalIdentities.predecessorReviewBuildTokenUuid,
      proofDigest: terminalProof.proof_digest, proofFileSha256,
      readbackDigestSha256: terminalProof.proof_digest,
      reconciliation: "historical-authority-exact-absence", deletionTombstone: true,
      providerMutation: false }),
    checksummedRecord({ ...Object.fromEntries(Object.entries(terminalTemplate)
      .filter(([key]) => !["event", "at", "recordSha256"].includes(key))),
    event: "review-token-rotation-complete-recovered", at: new Date(now).toISOString(),
    proofDigest: terminalProof.proof_digest, historicalAuthorityRecovery: true,
    providerMutation: false }),
  ];
  const arguments_ = { production, review, accountId, sourceSha,
    intermediateProof: evidence.reviewTokenRotationIntermediateProof,
    unreferencedProof: evidence.reviewTokenRotationUnreferencedProof };
  for (const prefixLength of [22, 23, 24]) {
    const result = validateReviewTokenRotationJournal(recoveryRecords(prefixLength), terminalProof,
      authority, arguments_);
    assert.equal(result.replacementReviewTokenUuid, terminalProof.replacementReviewTokenUuid);
  }
  const expectedNext = [
    ["review-token-rotation-complete-recovery-started", null],
    ["provider-proof-bound", "review-token-rotation-recovery-readback"],
    ["deletion-recovery-bound", "retire-superseded-review-build-token"],
    ["review-token-rotation-complete-recovered", null],
  ];
  for (const originalPrefixLength of [22, 23, 24]) {
    const completeRecovery = recoveryRecords(originalPrefixLength);
    const recoveryStart = completeRecovery.findIndex(({ event }) =>
      event === "review-token-rotation-complete-recovery-started");
    for (let suffixLength = 0; suffixLength < expectedNext.length; suffixLength += 1) {
      const classification = classifyReviewTokenRotationCompleteRecoveryPrefix(
        completeRecovery.slice(0, recoveryStart + suffixLength),
        suffixLength < 2 ? null : terminalProof, authority,
        arguments_, now);
      assert.equal(classification.outcome,
        "workers-builds-review-token-rotation-recovery-prefix-valid");
      assert.equal(classification.mutation, false);
      assert.equal(classification.terminal, false);
      assert.equal(classification.nextEvent, expectedNext[suffixLength][0]);
      assert.equal(classification.nextOperation, expectedNext[suffixLength][1]);
    }
    const recoveredTerminal = classifyReviewTokenRotationCompleteRecoveryPrefix(
      completeRecovery, terminalProof, authority, arguments_, now);
    assert.deepEqual(recoveredTerminal, {
      outcome: "workers-builds-review-token-rotation-recovery-terminal",
      mutation: false, terminal: true, nextEvent: null,
    });
    assert.deepEqual(classifyReviewTokenRotationCompleteRecoveryPrefix(
      completeRecovery, terminalProof, authority, arguments_, now), recoveredTerminal);
  }
  assert.throws(() => classifyReviewTokenRotationCompleteRecoveryPrefix(
    recoveryRecords(22).slice(0, 22), null, authority, arguments_,
    Date.parse(authority.expiresAt) - 1), /authority remains active/u);
  const lateDeleteIntentPrefix = recoveryRecords(22).slice(0, 22);
  const { recordSha256: _lateDeleteIntentChecksum, ...lateDeleteIntent } =
    lateDeleteIntentPrefix[21];
  lateDeleteIntent.at = new Date(Date.parse(lateDeleteIntentPrefix[19].at) + 30_001)
    .toISOString();
  lateDeleteIntentPrefix[21] = checksummedRecord(lateDeleteIntent);
  assert.throws(() => classifyReviewTokenRotationCompleteRecoveryPrefix(
    lateDeleteIntentPrefix, null, authority, arguments_, now), /delete intent drift/u);
  const lateDeleteBoundPrefix = recoveryRecords(24).slice(0, 24);
  const { recordSha256: _lateDeleteBoundChecksum, ...lateDeleteBound } =
    lateDeleteBoundPrefix[23];
  lateDeleteBound.at = authority.expiresAt;
  lateDeleteBoundPrefix[23] = checksummedRecord(lateDeleteBound);
  assert.throws(() => classifyReviewTokenRotationCompleteRecoveryPrefix(
    lateDeleteBoundPrefix, null, authority, arguments_, now),
  /deletion evidence drift/u);
  const inconsistentDeleteBoundPrefix = recoveryRecords(24).slice(0, 24);
  const { recordSha256: _inconsistentBoundChecksum, ...inconsistentBound } =
    inconsistentDeleteBoundPrefix[23];
  inconsistentBound.providerResponseExplicitSuccess = false;
  inconsistentBound.reconciliation = "ambiguous-exact-absence";
  inconsistentDeleteBoundPrefix[23] = checksummedRecord(inconsistentBound);
  assert.throws(() => classifyReviewTokenRotationCompleteRecoveryPrefix(
    inconsistentDeleteBoundPrefix, null, authority, arguments_, now),
  /deletion evidence drift/u);
  const wrongCreateResponsePrefix = recoveryRecords(22).slice(0, 22);
  const { recordSha256: _wrongCreateResponseChecksum, ...wrongCreateResponse } =
    wrongCreateResponsePrefix[5];
  wrongCreateResponse.resourceUuid = authority.journalIdentities.productionBuildTokenUuid;
  wrongCreateResponsePrefix[5] = checksummedRecord(wrongCreateResponse);
  assert.throws(() => classifyReviewTokenRotationCompleteRecoveryPrefix(
    wrongCreateResponsePrefix, null, authority, arguments_, now), /mutation drift/u);
  const proofIdentityRecovery = recoveryRecords(22);
  const proofIdentityRecoveryStart = proofIdentityRecovery.findIndex(({ event }) =>
    event === "review-token-rotation-complete-recovery-started");
  const wrongIdentityTerminalProof = { ...terminalProof,
    replacementReviewTokenUuid: authority.journalIdentities.productionBuildTokenUuid };
  assert.throws(() => classifyReviewTokenRotationCompleteRecoveryPrefix(
    proofIdentityRecovery.slice(0, proofIdentityRecoveryStart + 2),
    wrongIdentityTerminalProof, authority, arguments_, now), /proof drift/u);
  const injectedTimeRecovery = recoveryRecords(22);
  const injectedTimeRecoveryStart = injectedTimeRecovery.findIndex(({ event }) =>
    event === "review-token-rotation-complete-recovery-started");
  const injectedCheckpoint = Date.parse(authority.expiresAt);
  const futureAtCheckpointProof = { ...terminalProof,
    capturedAt: new Date(injectedCheckpoint + 30_001).toISOString() };
  const { recordSha256: _injectedTimeBoundChecksum, ...injectedTimeBound } =
    injectedTimeRecovery[injectedTimeRecoveryStart + 1];
  injectedTimeBound.proofFileSha256 = createHash("sha256").update(
    JSON.stringify(futureAtCheckpointProof)).digest("hex");
  injectedTimeRecovery[injectedTimeRecoveryStart + 1] =
    checksummedRecord(injectedTimeBound);
  assert.throws(() => classifyReviewTokenRotationCompleteRecoveryPrefix(
    injectedTimeRecovery.slice(0, injectedTimeRecoveryStart + 2),
    futureAtCheckpointProof, authority, arguments_, injectedCheckpoint),
  /phase proof drift/u);
  const ambiguousRecovery = recoveryRecords(23);
  const ambiguousClassificationIndex = ambiguousRecovery.findIndex(({ event, operation }) =>
    event === "provider-response-classified" &&
    operation === "retire-superseded-review-build-token");
  const { recordSha256: _ambiguousChecksum, ...ambiguousClassification } =
    ambiguousRecovery[ambiguousClassificationIndex];
  ambiguousClassification.outcome = "ambiguous";
  ambiguousRecovery[ambiguousClassificationIndex] =
    checksummedRecord(ambiguousClassification);
  assert.equal(classifyReviewTokenRotationCompleteRecoveryPrefix(
    ambiguousRecovery.slice(0, 23), null, authority, arguments_, now).mutation, false);
  assert.equal(validateReviewTokenRotationJournal(ambiguousRecovery, terminalProof,
    authority, arguments_).replacementReviewTokenUuid,
  terminalProof.replacementReviewTokenUuid);
  const lateStandardTerminal = original.slice(0, 25);
  const { recordSha256: _terminalChecksum, ...standardTerminal } = original.at(-1);
  standardTerminal.at = new Date(now).toISOString();
  lateStandardTerminal.push(checksummedRecord(standardTerminal));
  assert.equal(validateReviewTokenRotationJournal(lateStandardTerminal,
    evidence.reviewTokenRotationProof, authority, arguments_).replacementReviewTokenUuid,
  terminalProof.replacementReviewTokenUuid);
  assert.throws(() => validateReviewTokenRotationJournal(recoveryRecords(21), terminalProof,
    authority, arguments_), /operation sequence drift/u);
  assert.throws(() => validateReviewTokenRotationJournal(recoveryRecords(25), terminalProof,
    authority, arguments_), /operation sequence drift/u);
  const mutatingRecovery = recoveryRecords(22);
  const recoveryBoundIndex = mutatingRecovery.findIndex(({ event }) =>
    event === "deletion-recovery-bound");
  const { recordSha256: _checksum, ...mutatingBound } = mutatingRecovery[recoveryBoundIndex];
  mutatingBound.providerMutation = true;
  mutatingRecovery[recoveryBoundIndex] = checksummedRecord(mutatingBound);
  assert.throws(() => validateReviewTokenRotationJournal(mutatingRecovery, terminalProof,
    authority, arguments_), /terminal provenance drift/u);
  const explicitFailure = recoveryRecords(23);
  const classificationIndex = explicitFailure.findIndex(({ event, operation }) =>
    event === "provider-response-classified" &&
    operation === "retire-superseded-review-build-token");
  const { recordSha256: _classificationChecksum, ...classification } =
    explicitFailure[classificationIndex];
  classification.outcome = "explicit-failure";
  explicitFailure[classificationIndex] = checksummedRecord(classification);
  assert.throws(() => validateReviewTokenRotationJournal(explicitFailure, terminalProof,
    authority, arguments_), /terminal provenance drift/u);
  const wrongIdentity = recoveryRecords(22);
  const wrongStartIndex = wrongIdentity.findIndex(({ event }) =>
    event === "review-token-rotation-complete-recovery-started");
  const { recordSha256: _startChecksum, ...wrongStart } = wrongIdentity[wrongStartIndex];
  wrongStart.predecessorReviewTokenUuid = terminalProof.replacementReviewTokenUuid;
  wrongIdentity[wrongStartIndex] = checksummedRecord(wrongStart);
  assert.throws(() => validateReviewTokenRotationJournal(wrongIdentity, terminalProof,
    authority, arguments_), /terminal provenance drift/u);
  const earlyRecovery = recoveryRecords(22);
  const earlyStartIndex = earlyRecovery.findIndex(({ event }) =>
    event === "review-token-rotation-complete-recovery-started");
  const { recordSha256: _earlyChecksum, ...earlyStart } = earlyRecovery[earlyStartIndex];
  earlyStart.at = new Date(Date.parse(authority.expiresAt) - 1).toISOString();
  earlyRecovery[earlyStartIndex] = checksummedRecord(earlyStart);
  assert.throws(() => validateReviewTokenRotationJournal(earlyRecovery, terminalProof,
    authority, arguments_), /terminal provenance drift/u);
  const lateIntent = recoveryRecords(22);
  const intentIndex = lateIntent.findIndex(({ event, operation }) => event === "mutation-intent" &&
    operation === "retire-superseded-review-build-token");
  const { recordSha256: _intentChecksum, ...intent } = lateIntent[intentIndex];
  intent.at = new Date(now - 50).toISOString();
  lateIntent[intentIndex] = checksummedRecord(intent);
  assert.throws(() => validateReviewTokenRotationJournal(lateIntent, terminalProof,
    authority, arguments_), /checksum drift|terminal provenance drift/u);
});

test("dispatches disposable authority verification through exact private evidence", async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), "atrinik-disposable-authority-"));
  await chmod(temporary, 0o700);
  const previousEnvironment = { ...process.env };
  const originalWrite = process.stdout.write;
  try {
    const { proof, evidence } = disposableReviewAuthorityFixture(Date.now(), temporary);
    const json = async (name, value, lines = false) => {
      const path = resolve(temporary, name);
      const body = lines ? `${value.map((row) => JSON.stringify(row)).join("\n")}\n` :
        `${JSON.stringify(value)}\n`;
      await writeFile(path, body, { mode: 0o600 });
      return path;
    };
    const text = async (name, value) => {
      const path = resolve(temporary, name);
      await writeFile(path, `${value}\n`, { mode: 0o600 });
      return path;
    };
    Object.assign(process.env, {
      ATRINIK_CLOUDFLARE_ACCOUNT_ID_FILE: await text("account-id", accountId),
      ATRINIK_REVIEW_ACTIVATION_PROOF_FILE: await json("activation-proof.json",
        evidence.reviewActivationProof),
      ATRINIK_REVIEW_ACTIVATION_JOURNAL_FILE: await json("activation-journal.jsonl",
        evidence.reviewActivationJournal, true),
      ATRINIK_INERT_SETUP_JOURNAL_FILE: await json("setup-journal.jsonl",
        evidence.inertSetupJournal, true),
      ATRINIK_INERT_SETUP_RESULTS_FILE: await json("setup-results.json",
        evidence.inertSetupResults),
      ATRINIK_DISPOSABLE_REVIEW_COORDINATE_FILE: await json("coordinate.json",
        evidence.disposableCoordinate),
      ATRINIK_CURRENT_REVIEW_ACTIVE_PROOF_FILE: await json("current-proof.json",
        evidence.currentReviewActiveProof),
      ATRINIK_REVIEW_TOKEN_ROTATION_PREDECESSOR_PROOF_FILE: await json(
        "rotation-predecessor-proof.json", evidence.predecessorReviewActiveProof),
      ATRINIK_REVIEW_TOKEN_ROTATION_PRODUCTION_BASELINE_PROOF_FILE: await json(
        "rotation-production-baseline.json", evidence.productionBaselineProof),
      ATRINIK_REVIEW_TOKEN_ROTATION_COMPLETE_PROOF_FILE: await json("rotation-proof.json",
        evidence.reviewTokenRotationProof),
      ATRINIK_REVIEW_TOKEN_ROTATION_JOURNAL_FILE: await json("rotation-journal.jsonl",
        evidence.reviewTokenRotationJournal, true),
      ATRINIK_REVIEW_TOKEN_ROTATION_AUTHORITY_PROOF_FILE: await json("rotation-authority.json",
        evidence.reviewTokenRotationAuthorityProof),
      ATRINIK_REVIEW_TOKEN_ROTATION_INTERMEDIATE_PROOF_FILE: await json(
        "rotation-intermediate.json", evidence.reviewTokenRotationIntermediateProof),
      ATRINIK_REVIEW_TOKEN_ROTATION_UNREFERENCED_PROOF_FILE: await json(
        "rotation-unreferenced.json", evidence.reviewTokenRotationUnreferencedProof),
      ATRINIK_REPOSITORY_CONNECTION_OWNER_PROOF_FILE: await json("owner-proof.json",
        evidence.repositoryConnectionProof),
      ATRINIK_PRODUCTION_STAGING_SENTINEL_BRANCH_FILE: await text("sentinel",
        evidence.productionSentinelProof.branch),
      ATRINIK_PRODUCTION_STAGING_SENTINEL_REFS_FILE: await json("sentinel-proof.json",
        evidence.productionSentinelProof),
      ATRINIK_PRODUCTION_BUILD_TOKEN_PERMISSION_PROOF_FILE: await json("production-token.json",
        evidence.tokenAuthorityProofs[0]),
      ATRINIK_REVIEW_BUILD_TOKEN_PERMISSION_PROOF_FILE: await json("review-token.json",
        evidence.predecessorTokenAuthorityProofs[1]),
      ATRINIK_REPLACEMENT_REVIEW_BUILD_TOKEN_PERMISSION_PROOF_FILE: await json(
        "replacement-review-token.json", evidence.replacementTokenAuthorityProof),
      ATRINIK_REPLACEMENT_REVIEW_TOKEN_OWNER_MEMBERSHIP_PROOF_FILE: await json(
        "replacement-membership.json", evidence.replacementTokenOwnerMembershipProof),
      ATRINIK_CURRENT_REPLACEMENT_REVIEW_TOKEN_OWNER_MEMBERSHIP_PROOF_FILE: await json(
        "current-replacement-membership.json",
        evidence.currentReplacementTokenOwnerMembershipProof),
      ATRINIK_REPLACEMENT_REVIEW_BUILD_TOKEN_ID_FILE: await text(
        "replacement-token-id", evidence.replacementTokenId),
      ATRINIK_REPLACEMENT_REVIEW_BUILD_TOKEN_SECRET_FILE: await text(
        "replacement-token-secret", "replacement-secret"),
      ATRINIK_WORKERS_BUILDS_USAGE_PROOF_FILE: await json("usage.json",
        evidence.buildUsageProof),
      ATRINIK_DISPOSABLE_REVIEW_AUTHORITY_PROOF_FILE: await json("authority.json", proof),
      ATRINIK_DISPOSABLE_REVIEW_PUSH_AUTHORIZATION_RECEIPT_OUTPUT_FILE:
        evidence.disposableCoordinate.pushReceiptPath,
      ATRINIK_DISPOSABLE_REVIEW_DELETE_AUTHORIZATION_RECEIPT_OUTPUT_FILE:
        evidence.disposableCoordinate.deleteReceiptPath,
    });
    const output = [];
    process.stdout.write = (chunk) => { output.push(String(chunk)); return true; };
    await runProvisioningCli("--verify-review-token-rotation-authority-proof",
      async () => "a".repeat(40));
    await runProvisioningCli("--verify-review-token-rotation-authority-proof-historical",
      async () => "a".repeat(40));
    process.env.ATRINIK_REVIEW_BUILD_TOKEN_PERMISSION_PROOF_FILE = await json(
      "rotated-review-token.json", evidence.tokenAuthorityProofs[1]);
    await runProvisioningCli("--verify-disposable-review-authority-proof",
      async () => "a".repeat(40));
    await runProvisioningCli("--verify-disposable-review-authority-push",
      async () => "a".repeat(40));
    assert.equal(output.length, 4);
    assert.equal(JSON.parse(output[0]).outcome,
      "workers-builds-review-token-rotation-authority-valid");
    assert.equal(JSON.parse(output[1]).outcome,
      "workers-builds-review-token-rotation-historical-authority-valid");
    assert.ok(output.slice(2).every((line) => JSON.parse(line).outcome ===
      "workers-builds-disposable-review-authority-valid"));
    await assert.rejects(runProvisioningCli("--verify-disposable-review-authority-push",
      async () => "a".repeat(40)), /EEXIST/u);
    process.env.ATRINIK_DISPOSABLE_REVIEW_PUSH_AUTHORIZATION_RECEIPT_OUTPUT_FILE =
      resolve(temporary, "alternate-push-receipt.json");
    await assert.rejects(runProvisioningCli("--verify-disposable-review-authority-push",
      async () => "a".repeat(40)), /receipt path drift/u);
    await writeFile(process.env.ATRINIK_REVIEW_ACTIVATION_JOURNAL_FILE,
      JSON.stringify(evidence.reviewActivationJournal[0]), { mode: 0o600 });
    await assert.rejects(runProvisioningCli("--verify-disposable-review-authority-proof",
      async () => "a".repeat(40)), /not fully framed/u);
  } finally {
    process.stdout.write = originalWrite;
    for (const key of Object.keys(process.env)) if (!(key in previousEnvironment))
      delete process.env[key];
    Object.assign(process.env, previousEnvironment);
    await rm(temporary, { recursive: true, force: true });
  }
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
  assert.equal(plan.setupOperations.find(({ id }) => id === "review-build-token")
    .request.body.build_token_name, reviewBuildTokenNames.predecessor);
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
  const rotationOperation = (id) => plan.reviewTokenRotation.operations.find(
    (operation) => operation.id === id);
  const rotationAuthority = rotationOperation("review-token-rotation-authority");
  const replacementToken = rotationOperation("replacement-review-build-token");
  const productionRepoint = rotationOperation("repoint-inert-production-trigger");
  const intermediate = rotationOperation(
    "prove-production-repointed-review-still-predecessor");
  const reviewRepoint = rotationOperation("repoint-final-review-trigger");
  const unreferenced = rotationOperation("prove-superseded-wrapper-unreferenced");
  const retire = rotationOperation("retire-superseded-review-build-token");
  const rotationReadback = rotationOperation("review-token-rotation-readback");
  assert.equal(rotationAuthority.command,
    "npm run provision:workers-builds:verify-review-token-rotation-authority");
  assert.equal(replacementToken.request.method, "POST");
  assert.equal(replacementToken.request.path, "/builds/tokens");
  assert.equal(replacementToken.request.body.build_token_name, reviewBuildTokenNames.current);
  assert.equal(productionRepoint.request.method, "PATCH");
  assert.equal(productionRepoint.request.path.resultReference,
    "review-token-rotation-authority.production_trigger_uuid");
  assert.deepEqual(productionRepoint.request.body.branch_includes,
    [{ privateFileEnvironment: "ATRINIK_PRODUCTION_STAGING_SENTINEL_BRANCH_FILE" }]);
  assert.equal(productionRepoint.request.body.build_token_uuid.resultReference,
    "replacement-review-build-token.build_token_uuid");
  assert.equal(intermediate.command,
    "npm run provision:workers-builds:verify-review-token-rotation-intermediate");
  assert.equal(reviewRepoint.precondition.intermediateProof.resultReference,
    "prove-production-repointed-review-still-predecessor.proof_digest");
  assert.equal(reviewRepoint.request.body.root_directory, "/deployment/review-check");
  assert.equal(reviewRepoint.request.body.build_token_uuid.resultReference,
    "replacement-review-build-token.build_token_uuid");
  assert.equal(unreferenced.command,
    "npm run provision:workers-builds:verify-review-token-rotation-unreferenced");
  assert.equal(retire.precondition.unreferencedProof.resultReference,
    "prove-superseded-wrapper-unreferenced.proof_digest");
  assert.equal(retire.request.method, "DELETE");
  assert.equal(retire.request.path.resultReference,
    "review-token-rotation-authority.predecessor_review_build_token_uuid");
  assert.equal(rotationReadback.command,
    "npm run provision:workers-builds:verify-review-token-rotation-complete");
  const terminalRotationAlternatives = [
    { resultReference: "review-token-rotation-readback.proof_digest" },
    { resultReference:
      "rotation-forward-complete-after-old-wrapper-absent.proof_digest" },
  ];
  assert.deepEqual(plan.disposableProof.authorityOperation.precondition
    .reviewTokenRotationProof.oneOf, terminalRotationAlternatives);
  assert.deepEqual(plan.disposableProof.precondition.reviewTokenRotationProof.oneOf,
    terminalRotationAlternatives);
  assert.deepEqual(plan.gates, ["provider-setup-authorization",
    "review-trigger-activation-and-proof", "review-token-rotation",
    "production-trigger-activation", "migration-0010",
    "initial-automatic-production-proof"]);
  assert.ok(plan.reviewTokenRotation.forbidden.includes("production-trigger-activation"));
  const incidentRecovery = plan.reviewTokenRotation.providerNormalizedIncidentRecovery;
  assert.equal(incidentRecovery.mode, "rollback-only");
  assert.equal(incidentRecovery.incidentPhase,
    "production-repointed-review-augmented");
  assert.deepEqual(incidentRecovery.coordinates, reviewTokenRotationProviderNormalizedIncident);
  assert.ok(incidentRecovery.operations.findIndex(({ id }) => id ===
    "rotation-incident-restore-production-trigger-old-token") <
    incidentRecovery.operations.findIndex(({ id }) => id ===
      "rotation-incident-restore-review-trigger-old-token"));
  assert.equal(incidentRecovery.operations.find(({ id }) => id ===
    "rotation-incident-restore-review-trigger-old-token").condition,
  "only-when-peer-normalization-proof-retains-the-sentinel-exclusion");
  assert.deepEqual(incidentRecovery.operations.filter(({ mutation }) => mutation)
    .map(({ actor, journalOperation }) => [actor, journalOperation]), [
    ["workers-builds-control-plane-operator",
      "rotation-restore-production-trigger-old-token"],
    ["workers-builds-control-plane-operator", "rotation-restore-review-trigger-old-token"],
    ["workers-builds-control-plane-operator", "rotation-delete-replacement-wrapper"],
  ]);
  assert.ok(incidentRecovery.operations.filter(({ mutation }) => !mutation)
    .every(({ actor, command }) => actor === "workers-builds-control-plane-operator" &&
      typeof command === "string" && command.startsWith("npm run provision:")));
  assert.ok(incidentRecovery.forbidden.includes("forward-rotation-retry"));
  assert.ok(plan.reviewTokenRotation.rollbackOperations.findIndex(({ id }) =>
    id === "rotation-prove-predecessor-restored") <
    plan.reviewTokenRotation.rollbackOperations.findIndex(({ id }) =>
      id === "rotation-delete-replacement-wrapper"));
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
    { uuid: reviewTokenUuid, name: reviewBuildTokenNames.current },
  ]), /missing or ambiguous/u);
  assert.throws(() => validateNoDeployHooks(envelope([{ deploy_hook_uuid: resourceUuid }]),
    "production"), /Deploy Hook/u);
});

test("pins every journaled review-token rotation phase and rejects field drift", () => {
  const productionTriggerUuid = "11111111-1111-4111-8111-111111111111";
  const reviewTriggerIdentity = "22222222-2222-4222-8222-222222222222";
  const predecessorReviewTokenUuid = "33333333-3333-4333-8333-333333333333";
  const productionBuildTokenUuid = "44444444-4444-4444-8444-444444444444";
  const repositoryConnectionUuid = "55555555-5555-4555-8555-555555555555";
  const replacementReviewTokenUuid = "66666666-6666-4666-8666-666666666666";
  const sentinel = `review-build-only-sentinel-${"a".repeat(32)}`;
  const values = Object.fromEntries(Object.values(production.protectedInputs)
    .map((name) => [name, `${name}-value`]));
  const productionEnvironment = productionEnvironmentSpec(production, values);
  for (const name of Object.values(production.protectedInputs))
    productionEnvironment[name].value = null;
  const reviewEnvironment = automaticReviewEnvironmentSpec(review);
  const token = (name, uuid, tokenId) => ({ build_token_name: name, build_token_uuid: uuid,
    cloudflare_token_id: tokenId, owner_type: "user" });
  const productionToken = token("Atrinik metaserver production", productionBuildTokenUuid,
    "production-token-id");
  const predecessorToken = token(reviewBuildTokenNames.predecessor,
    predecessorReviewTokenUuid, "predecessor-review-token-id");
  const replacementToken = token(reviewBuildTokenNames.current,
    replacementReviewTokenUuid, "replacement-review-token-id");
  const trigger = (reviewRole, tokenUuid) => {
    const spec = reviewRole ? automaticReviewTriggerSpec(review, {
      externalScriptId: scriptTag, repositoryConnectionUuid, buildTokenUuid: tokenUuid,
    }) : productionTriggerSpec(production, {
      externalScriptId: scriptTag, repositoryConnectionUuid, buildTokenUuid: tokenUuid,
    });
    if (!reviewRole) spec.branch_includes = [sentinel];
    const result = withConnection(spec);
    result.trigger_uuid = reviewRole ? reviewTriggerIdentity : productionTriggerUuid;
    return result;
  };
  const validate = (phase, productionTokenUuid_, reviewTokenUuid_, tokenRows) =>
    validateReviewTokenRotationReadback({ production, review, phase,
      productionTrigger: trigger(false, productionTokenUuid_),
      reviewTrigger: trigger(true, reviewTokenUuid_),
      productionEnvironment: envelope(productionEnvironment),
      reviewEnvironment: envelope(reviewEnvironment), buildTokens: envelope(tokenRows),
      accountTriggers: envelope([trigger(false, productionTokenUuid_),
        trigger(true, reviewTokenUuid_)]), productionScriptTag: scriptTag,
      productionSentinel: sentinel, productionTriggerUuid,
      reviewTriggerUuid: reviewTriggerIdentity, predecessorReviewTokenUuid,
      replacementReviewTokenUuid: phase === "predecessor" ? undefined :
        replacementReviewTokenUuid, repositoryConnectionUuid });
  assert.equal(validate("predecessor", predecessorReviewTokenUuid,
    predecessorReviewTokenUuid, [productionToken, predecessorToken]).phase, "predecessor");
  assert.equal(validate("production-repointed", replacementReviewTokenUuid,
    predecessorReviewTokenUuid, [productionToken, predecessorToken, replacementToken]).phase,
  "production-repointed");
  const augmentedReview = trigger(true, predecessorReviewTokenUuid);
  augmentedReview.branch_excludes = [review.productionBranch, sentinel];
  const augmentedArguments = { production, review,
    productionTrigger: trigger(false, replacementReviewTokenUuid),
    reviewTrigger: augmentedReview, productionEnvironment: envelope(productionEnvironment),
    reviewEnvironment: envelope(reviewEnvironment),
    buildTokens: envelope([productionToken, predecessorToken, replacementToken]),
    accountTriggers: envelope([trigger(false, replacementReviewTokenUuid), augmentedReview]),
    productionScriptTag: scriptTag, productionSentinel: sentinel, productionTriggerUuid,
    reviewTriggerUuid: reviewTriggerIdentity, predecessorReviewTokenUuid,
    replacementReviewTokenUuid, repositoryConnectionUuid };
  assert.equal(validateReviewTokenRotationReadback({ ...augmentedArguments,
    phase: "production-repointed-review-augmented" }).phase,
  "production-repointed-review-augmented");
  assert.equal(validateReviewTokenRotationReadback({ ...augmentedArguments,
    phase: "production-restored-review-augmented",
    productionTrigger: trigger(false, predecessorReviewTokenUuid),
    accountTriggers: envelope([trigger(false, predecessorReviewTokenUuid), augmentedReview])
  }).phase, "production-restored-review-augmented");
  const broaderAugmentation = structuredClone(augmentedReview);
  broaderAugmentation.branch_excludes.push("foreign");
  assert.throws(() => validateReviewTokenRotationReadback({ ...augmentedArguments,
    phase: "production-repointed-review-augmented", reviewTrigger: broaderAugmentation,
    accountTriggers: envelope([trigger(false, replacementReviewTokenUuid),
      broaderAugmentation]) }), /branch_excludes drift/u);
  assert.equal(reviewTokenRotationProviderNormalizedIncident.sourceSha,
    "48f791e60bc0c1d19a7eff28e9cd99ed1bfd317a");
  assert.equal(validate("old-wrapper-unreferenced", replacementReviewTokenUuid,
    replacementReviewTokenUuid, [productionToken, predecessorToken, replacementToken]).phase,
  "old-wrapper-unreferenced");
  assert.equal(validate("predecessor-restored", predecessorReviewTokenUuid,
    predecessorReviewTokenUuid, [productionToken, predecessorToken, replacementToken]).phase,
  "predecessor-restored");
  const foreignReference = { ...trigger(true, predecessorReviewTokenUuid),
    trigger_uuid: "77777777-7777-4777-8777-777777777777",
    repo_connection: { ...trigger(true, predecessorReviewTokenUuid).repo_connection,
      repo_id: "9999999999", repo_name: "foreign-repository" } };
  assert.throws(() => validateReviewTokenRotationReadback({ production, review,
    phase: "old-wrapper-unreferenced",
    productionTrigger: trigger(false, replacementReviewTokenUuid),
    reviewTrigger: trigger(true, replacementReviewTokenUuid),
    productionEnvironment: envelope(productionEnvironment),
    reviewEnvironment: envelope(reviewEnvironment),
    buildTokens: envelope([productionToken, predecessorToken, replacementToken]),
    accountTriggers: envelope([trigger(false, replacementReviewTokenUuid),
      trigger(true, replacementReviewTokenUuid), foreignReference]),
    productionScriptTag: scriptTag, productionSentinel: sentinel, productionTriggerUuid,
    reviewTriggerUuid: reviewTriggerIdentity, predecessorReviewTokenUuid,
    replacementReviewTokenUuid, repositoryConnectionUuid }), /still referenced/u);
  const foreignReplacementReference = { ...trigger(true, replacementReviewTokenUuid),
    trigger_uuid: "88888888-8888-4888-8888-888888888888",
    repo_connection: { ...trigger(true, replacementReviewTokenUuid).repo_connection,
      repo_id: "9999999999", repo_name: "foreign-repository" } };
  assert.throws(() => validateReviewTokenRotationReadback({ production, review,
    phase: "predecessor-restored",
    productionTrigger: trigger(false, predecessorReviewTokenUuid),
    reviewTrigger: trigger(true, predecessorReviewTokenUuid),
    productionEnvironment: envelope(productionEnvironment),
    reviewEnvironment: envelope(reviewEnvironment),
    buildTokens: envelope([productionToken, predecessorToken, replacementToken]),
    accountTriggers: envelope([trigger(false, predecessorReviewTokenUuid),
      trigger(true, predecessorReviewTokenUuid), foreignReplacementReference]),
    productionScriptTag: scriptTag, productionSentinel: sentinel, productionTriggerUuid,
    reviewTriggerUuid: reviewTriggerIdentity, predecessorReviewTokenUuid,
    replacementReviewTokenUuid, repositoryConnectionUuid }), /still referenced/u);
  assert.equal(validate("complete", replacementReviewTokenUuid, replacementReviewTokenUuid,
    [productionToken, replacementToken]).phase, "complete");
  assert.throws(() => validate("complete", replacementReviewTokenUuid,
    predecessorReviewTokenUuid, [productionToken, replacementToken]), /drift/u);
  assert.throws(() => validate("old-wrapper-unreferenced", replacementReviewTokenUuid,
    replacementReviewTokenUuid, [productionToken, predecessorToken, replacementToken,
      token("foreign", "77777777-7777-4777-8777-777777777777", "foreign-token-id")]),
  /wrapper inventory drift/u);
  const wrongProduction = trigger(false, replacementReviewTokenUuid);
  wrongProduction.build_command = "npm run altered";
  assert.throws(() => validateReviewTokenRotationReadback({ production, review,
    phase: "complete", productionTrigger: wrongProduction,
    reviewTrigger: trigger(true, replacementReviewTokenUuid),
    productionEnvironment: envelope(productionEnvironment),
    reviewEnvironment: envelope(reviewEnvironment),
    buildTokens: envelope([productionToken, replacementToken]),
    accountTriggers: envelope([wrongProduction, trigger(true, replacementReviewTokenUuid)]),
    productionScriptTag: scriptTag, productionSentinel: sentinel, productionTriggerUuid,
    reviewTriggerUuid: reviewTriggerIdentity, predecessorReviewTokenUuid,
    replacementReviewTokenUuid, repositoryConnectionUuid }), /drift/u);

  const now = Date.now();
  const replacementProof = { kind: "review-replacement",
    source: "cloudflare-owner-token-policy-readback", capturedAt: new Date(now).toISOString(),
    modifiedOn: new Date(now - 1_000).toISOString(), accountId, sourceSha: "a".repeat(40),
    tokenId: "replacement-review-token-id", ownerUserId: "1".repeat(32),
    userPermissions: ["User Details:Read"],
    accountPermissions: [], accountResources: [], zonePermissions: [], zoneResources: [] };
  assert.equal(validateReplacementReviewTokenAuthorityProof({ review, accountId,
    proof: replacementProof, tokenId: replacementProof.tokenId,
    sourceSha: replacementProof.sourceSha }, now).kind, "review-replacement");
  for (const mutate of [
    (value) => value.accountPermissions.push("Workers Scripts:Read"),
    (value) => { value.kind = "review"; },
    (value) => { value.tokenId = "predecessor-review-token-id"; },
    (value) => { value.modifiedOn = "2999-01-01T00:00:00.000Z"; },
  ]) {
    const changed = structuredClone(replacementProof);
    mutate(changed);
    assert.throws(() => validateReplacementReviewTokenAuthorityProof({ review, accountId,
      proof: changed, tokenId: replacementProof.tokenId,
      sourceSha: replacementProof.sourceSha }, now));
  }
});

test("semantically classifies every provider-normalized rollback boundary", async () => {
  const now = Date.now();
  const { evidence, production, review, accountId, sourceSha } =
    disposableReviewAuthorityFixture(now);
  const authorityProof = evidence.reviewTokenRotationAuthorityProof;
  const replacementReviewTokenUuid =
    evidence.reviewTokenRotationProof.replacementReviewTokenUuid;
  const incidentForwardRecords = evidence.reviewTokenRotationJournal.slice(0, 12);
  const incidentForwardJournalSha256 = "1".repeat(64);
  const incidentSnapshotManifestSha256 = "2".repeat(64);
  const incidentAuthorityFileSha256 = "3".repeat(64);
  const incidentCoordinate = {
    sourceSha, planDigest: authorityProof.planDigest,
    forwardJournalSha256: incidentForwardJournalSha256,
    forwardJournalDigest: createHash("sha256")
      .update(JSON.stringify(incidentForwardRecords)).digest("hex"),
    incidentSnapshotManifestSha256, authorityFileSha256: incidentAuthorityFileSha256,
  };
  const incidentProof = { ...evidence.reviewTokenRotationIntermediateProof,
    outcome:
      "workers-builds-review-token-rotation-production-repointed-review-augmented-valid",
    phase: "production-repointed-review-augmented", proof_digest: "4".repeat(64) };
  const incident = validateReviewTokenRotationProviderNormalizedIncident(
    incidentForwardRecords, incidentProof, authorityProof, { production, review, accountId,
      forwardJournalSha256: incidentForwardJournalSha256,
      incidentSnapshotManifestSha256, authorityFileSha256: incidentAuthorityFileSha256,
      coordinate: incidentCoordinate });
  assert.equal(incident.incidentCoordinateDigest,
    createHash("sha256").update(JSON.stringify({ coordinate: incidentCoordinate,
      authorityProofDigest: authorityProof.proof_digest,
      incidentProofDigest: incidentProof.proof_digest })).digest("hex"));

  const context = { production, review, accountId, sourceSha, authorityProof,
    replacementReviewTokenUuid, incidentProof, incidentForwardRecords,
    incidentForwardJournalSha256, incidentSnapshotManifestSha256,
    incidentAuthorityFileSha256, incidentCoordinate };
  const createProof = (phase, capturedAt, digest) => ({
    ...evidence.reviewTokenRotationProof,
    outcome: `workers-builds-review-token-rotation-${phase}-valid`, phase, capturedAt,
    proof_digest: digest,
  });
  const build = (peerPhase, responseOutcome = "explicit-success") => {
    const records = [];
    let timestamp = now + 100;
    const append = (payload) => records.push(checksummedRecord({ ...payload, attempt: 1,
      at: new Date(timestamp += 10).toISOString() }));
    append({ event: "review-token-rotation-rollback-started",
      startingPhase: "production-repointed-review-augmented",
      authorityProofDigest: authorityProof.proof_digest, replacementReviewTokenUuid,
      incidentCoordinateDigest: incident.incidentCoordinateDigest,
      incidentProofDigest: incidentProof.proof_digest,
      forwardJournalDigest: incident.forwardJournalDigest });
    const mutation = (operation, extraBound = {}) => {
      append({ event: "current-main-proof-bound", operation, sourceSha,
        ref: "refs/heads/main", capturedAt: new Date(timestamp + 9).toISOString(),
        proofFileSha256: "5".repeat(64), rawFileSha256: "6".repeat(64) });
      append({ event: "rollback-authority-checked", operation,
        proofDigest: authorityProof.proof_digest, historicalRollbackAuthority: true });
      const request = reviewTokenRotationRollbackRequestDigest({ production, review,
        authorityProof, operation, replacementReviewTokenUuid });
      append({ event: "mutation-intent", operation, ...request });
      append({ event: "provider-response-classified", operation,
        outcome: responseOutcome });
      append({ event: "mutation-bound", operation,
        requestDigestSha256: request.requestDigestSha256,
        resourceUuid: operation === "rotation-restore-production-trigger-old-token" ?
          authorityProof.journalIdentities.productionTriggerUuid :
          operation === "rotation-restore-review-trigger-old-token" ?
            authorityProof.journalIdentities.reviewTriggerUuid : replacementReviewTokenUuid,
        providerResponseExplicitSuccess: responseOutcome === "explicit-success",
        readbackDigestSha256: "7".repeat(64),
        reconciliation: operation === "rotation-delete-replacement-wrapper" ?
          `${responseOutcome}-exact-absence` : `${responseOutcome}-exact-readback`,
        ...(operation === "rotation-delete-replacement-wrapper" ?
          { deletionTombstone: true } : {}), ...extraBound });
    };
    mutation("rotation-restore-production-trigger-old-token",
      { reviewPeerAugmented: peerPhase === "production-restored-review-augmented" });
    const peerNormalizationProof = createProof(peerPhase,
      new Date(timestamp + 5).toISOString(), "8".repeat(64));
    append({ event: "provider-proof-bound",
      operation: "rotation-prove-provider-peer-normalization",
      proofDigest: peerNormalizationProof.proof_digest,
      proofFileSha256: createHash("sha256")
        .update(JSON.stringify(peerNormalizationProof)).digest("hex") });
    if (peerPhase === "production-restored-review-augmented")
      mutation("rotation-restore-review-trigger-old-token");
    const restoredProof = createProof("predecessor-restored",
      new Date(timestamp + 5).toISOString(), "9".repeat(64));
    append({ event: "provider-proof-bound", operation: "rotation-prove-predecessor-restored",
      proofDigest: restoredProof.proof_digest,
      proofFileSha256: createHash("sha256").update(JSON.stringify(restoredProof)).digest("hex") });
    mutation("rotation-delete-replacement-wrapper");
    const { replacementReviewTokenUuid: _removed, ...predecessorBase } =
      evidence.reviewTokenRotationProof;
    const completeProof = { ...predecessorBase,
      outcome: "workers-builds-review-token-rotation-predecessor-valid", phase: "predecessor",
      capturedAt: new Date(timestamp + 5).toISOString(), proof_digest: "a".repeat(64) };
    append({ event: "provider-proof-bound", operation: "rotation-prove-rollback-complete",
      proofDigest: completeProof.proof_digest,
      proofFileSha256: createHash("sha256").update(JSON.stringify(completeProof)).digest("hex") });
    append({ event: "review-token-rotation-rollback-complete",
      proofDigest: completeProof.proof_digest, productionActivation: false,
      migration0010: false, initialProductionBuild: false });
    return { records, peerNormalizationProof, restoredProof, completeProof };
  };

  for (const peerPhase of ["predecessor-restored",
    "production-restored-review-augmented"]) {
    const fixture = build(peerPhase);
    const peerBoundIndex = fixture.records.findIndex(({ event, operation }) =>
      event === "provider-proof-bound" &&
        operation === "rotation-prove-provider-peer-normalization");
    for (let length = 0; length <= fixture.records.length; length++) {
      const afterPeerProof = length > peerBoundIndex;
      const result = await classifyReviewTokenRotationProviderNormalizedRollbackPrefix(
        fixture.records.slice(0, length), { ...context,
          peerNormalizationProof: afterPeerProof ? fixture.peerNormalizationProof : undefined,
          restoredProof: fixture.restoredProof, completeProof: fixture.completeProof });
      assert.equal(result.mutation, false);
      assert.equal(result.terminal, length === fixture.records.length);
      if (fixture.records.at(length - 1)?.event === "provider-response-classified")
        assert.equal(result.reconcile, true);
    }
    const wrongMain = structuredClone(fixture.records.slice(0, 2));
    const { recordSha256: _mainChecksum, ...main } = wrongMain[1];
    main.sourceSha = "f".repeat(40);
    wrongMain[1] = checksummedRecord(main);
    await assert.rejects(classifyReviewTokenRotationProviderNormalizedRollbackPrefix(
      wrongMain, context), /mutation provenance drift/u);
    const wrongRequest = structuredClone(fixture.records.slice(0, 4));
    const { recordSha256: _intentChecksum, ...intent } = wrongRequest[3];
    intent.requestDigestSha256 = "f".repeat(64);
    wrongRequest[3] = checksummedRecord(intent);
    await assert.rejects(classifyReviewTokenRotationProviderNormalizedRollbackPrefix(
      wrongRequest, context), /mutation provenance drift/u);
  }

  const ambiguous = build("predecessor-restored", "ambiguous");
  const classificationIndex = ambiguous.records.findIndex(({ event }) =>
    event === "provider-response-classified");
  assert.equal((await classifyReviewTokenRotationProviderNormalizedRollbackPrefix(
    ambiguous.records.slice(0, classificationIndex + 1), context)).reconcile, true);
  const failed = build("predecessor-restored").records.slice(0, classificationIndex + 1);
  const { recordSha256: _failureChecksum, ...failure } = failed.at(-1);
  Object.assign(failure, { outcome: "explicit-failure", status: 403,
    responseDigestSha256: "b".repeat(64) });
  failed[failed.length - 1] = checksummedRecord(failure);
  const failedResult = await classifyReviewTokenRotationProviderNormalizedRollbackPrefix(
    failed, context);
  assert.equal(failedResult.nextEvent, "review-token-rotation-rollback-blocked");
  assert.equal(failedResult.mutation, false);
  const malformedFailure = structuredClone(failed);
  const { recordSha256: _malformedFailureChecksum, ...malformedFailurePayload } =
    malformedFailure.at(-1);
  delete malformedFailurePayload.status;
  malformedFailure[malformedFailure.length - 1] = checksummedRecord(malformedFailurePayload);
  await assert.rejects(classifyReviewTokenRotationProviderNormalizedRollbackPrefix(
    malformedFailure, context), /mutation provenance drift/u);
  const broaderIncident = { ...incidentProof, phase: "production-repointed" };
  assert.throws(() => validateReviewTokenRotationProviderNormalizedIncident(
    incidentForwardRecords, broaderIncident, authorityProof, { production, review, accountId,
      forwardJournalSha256: incidentForwardJournalSha256,
      incidentSnapshotManifestSha256, authorityFileSha256: incidentAuthorityFileSha256,
      coordinate: incidentCoordinate }), /phase proof drift/u);
});

test("proves only the production trigger is inert before review activation", async () => {
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
  const repeatedCapture = { ...stagedProof,
    capturedAt: new Date(Date.parse(stagedProof.capturedAt) + 1_000).toISOString() };
  repeatedCapture.proof_digest = createHash("sha256").update(JSON.stringify({
    state_digest: repeatedCapture.state_digest,
    snapshotStartedAt: repeatedCapture.snapshotStartedAt,
    snapshotCompletedAt: repeatedCapture.snapshotCompletedAt,
    capturedAt: repeatedCapture.capturedAt,
  })).digest("hex");
  assert.equal(validateStagedProof(stagedProof, repeatedCapture,
    Date.parse(repeatedCapture.capturedAt)).proof_digest, repeatedCapture.proof_digest);
  const laterSweep = { ...repeatedCapture,
    snapshotStartedAt: new Date(Date.parse(stagedProof.snapshotStartedAt) + 500).toISOString(),
    snapshotCompletedAt: new Date(Date.parse(stagedProof.snapshotCompletedAt) + 500).toISOString(),
  };
  laterSweep.proof_digest = createHash("sha256").update(JSON.stringify({
    state_digest: laterSweep.state_digest, snapshotStartedAt: laterSweep.snapshotStartedAt,
    snapshotCompletedAt: laterSweep.snapshotCompletedAt, capturedAt: laterSweep.capturedAt,
  })).digest("hex");
  assert.equal(validateStagedProof(stagedProof, laterSweep,
    Date.parse(laterSweep.capturedAt)).proof_digest, laterSweep.proof_digest);
  assert.throws(() => validateStagedProof(stagedProof,
    { ...laterSweep, state_digest: "0".repeat(64) }, Date.parse(laterSweep.capturedAt)),
  /staged activation proof/u);
  assert.throws(() => validateStagedProof(repeatedCapture, stagedProof,
    Date.parse(repeatedCapture.capturedAt)), /chronology did not advance/u);
  const overlappingSweep = { ...laterSweep,
    snapshotStartedAt: new Date(Date.parse(stagedProof.snapshotCompletedAt) - 1).toISOString() };
  overlappingSweep.proof_digest = createHash("sha256").update(JSON.stringify({
    state_digest: overlappingSweep.state_digest,
    snapshotStartedAt: overlappingSweep.snapshotStartedAt,
    snapshotCompletedAt: overlappingSweep.snapshotCompletedAt,
    capturedAt: overlappingSweep.capturedAt,
  })).digest("hex");
  assert.throws(() => validateStagedProof(stagedProof, overlappingSweep,
    Date.parse(overlappingSweep.capturedAt)), /chronology did not advance/u);
  assert.throws(() => validateStagedProof({ ...stagedProof, proof_digest: "0".repeat(64) },
    stagedProof), /staged activation proof/u);
  const staleProof = { ...stagedProof, capturedAt: "2026-08-15T00:00:00.000Z" };
  assert.throws(() => validateStagedProof(staleProof, staleProof,
    Date.parse("2026-08-15T00:06:00.000Z")), /staged activation proof/u);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  const retimed = structuredClone(arguments_);
  retimed.snapshotManifest.startedAt = new Date().toISOString();
  retimed.snapshotManifest.completedAt = retimed.snapshotManifest.startedAt;
  const retimedProof = validateStagedBuildsSnapshot(retimed);
  assert.equal(retimedProof.state_digest, stagedProof.state_digest);
  assert.notEqual(retimedProof.proof_digest, stagedProof.proof_digest);
  assert.equal(validateStagedProof(stagedProof, retimedProof).proof_digest,
    retimedProof.proof_digest);
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
      build_trigger_source: "push_event", provider_type: "github",
      provider_account_name: "atrinik", repo_name: "metaserver-worker",
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
      checkRuns: { total_count: 1, check_runs: [{ id: 123456,
        name: "Workers Builds: atrinik-metaserver",
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
  const nonCanonicalPushSource = structuredClone(reviewActive);
  nonCanonicalPushSource.reviewBuildState.builds.result[0].build_trigger_metadata
    .build_trigger_source = "push";
  assert.throws(() => validateProductionActivationSnapshot(nonCanonicalPushSource),
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
