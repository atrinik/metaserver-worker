import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateBuildEnvironment,
  validateContract as validateProductionContract,
  validateRemoteBindings,
  validateRuntimeExports,
  validateTopology,
} from "./production-delivery.mjs";
import { validateCheckedInContract as validateReviewContract } from "./review-environment.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const productionPath = resolve(root, "deployment/workers-builds-production.json");
const reviewPath = resolve(root, "deployment/workers-builds-review.json");
const accountIdPattern = /^[0-9a-f]{32}$/u;
const scriptTagPattern = /^[0-9a-f]{32}$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const maximumProviderResponseBytes = 1024 * 1024;
const maximumPrivateDocumentBytes = 64 * 1024;
const maximumProviderPages = 100;
const stagingBranchPattern = /^review-build-only-sentinel-[0-9a-f]{32}$/u;
const gitShaPattern = /^[0-9a-f]{40}$/u;
const githubRepository = Object.freeze({
  provider_account_id: "6371603",
  provider_account_name: "atrinik",
  provider_type: "github",
  repo_id: "1324297032",
  repo_name: "metaserver-worker",
});
const currentUid = typeof process.getuid === "function" ? process.getuid() : null;

export class WorkersBuildsProvisioningError extends Error {}

function fail(message) {
  throw new WorkersBuildsProvisioningError(message);
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function digestJson(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function validateSnapshotManifest(manifest, { accountId, sourceSha, production, review },
  now = Date.now()) {
  const keys = ["accountId", "completedAt", "productionContractSha256",
    "reviewContractSha256", "sourceSha", "startedAt"];
  const started = Date.parse(manifest?.startedAt ?? "");
  const completed = Date.parse(manifest?.completedAt ?? "");
  if (!manifest || !same(sorted(Object.keys(manifest)), sorted(keys)) ||
      manifest.accountId !== accountId || manifest.sourceSha !== sourceSha ||
      manifest.productionContractSha256 !== digestJson(production) ||
      manifest.reviewContractSha256 !== digestJson(review) ||
      !Number.isFinite(started) || !Number.isFinite(completed) || started > completed ||
      completed > now + 30_000 || now - completed > 5 * 60_000 ||
      completed - started > 5 * 60_000)
    fail("provider snapshot manifest is stale or does not bind this reviewed source");
}

function normalizedRoot(value) {
  return value === "/" ? "" : value;
}

function isCurrentUserOwned(metadata) {
  return currentUid !== null && metadata.uid === currentUid;
}

function oneBinding(bindings, name, type) {
  const matches = bindings.filter((value) => value.name === name && value.type === type);
  if (matches.length !== 1) fail(`${type} binding ${name} is missing or ambiguous`);
  return matches[0];
}

function expectedBindingInventory(config) {
  return [
    ...Object.keys(config.vars ?? {}).map((name) => ({ name, type: "plain_text" })),
    ...(config.secrets?.required ?? []).map((name) => ({ name, type: "secret_text" })),
    ...(config.d1_databases ?? []).map(({ binding: name }) => ({ name, type: "d1" })),
    ...(config.r2_buckets ?? []).map(({ binding: name }) => ({ name, type: "r2_bucket" })),
    ...(config.analytics_engine_datasets ?? []).map(({ binding: name }) =>
      ({ name, type: "analytics_engine" })),
    ...(config.ratelimits ?? []).map(({ name }) => ({ name, type: "ratelimit" })),
    ...(config.durable_objects?.bindings ?? []).map(({ name }) =>
      ({ name, type: "durable_object_namespace" })),
    ...(config.services ?? []).map(({ binding: name }) => ({ name, type: "service" })),
  ].sort((left, right) => `${left.name}:${left.type}`.localeCompare(`${right.name}:${right.type}`));
}

function requireEnvelope(value, label) {
  if (!value || value.success !== true || !value.result)
    fail(`${label} provider readback failed`);
  return value.result;
}

function requireExhaustiveEnvelope(value, label) {
  const rows = requireEnvelope(value, label);
  const info = value.result_info ?? {};
  if (!Array.isArray(rows) || info.exhaustive !== true || info.page !== 1 ||
      info.total_pages !== 1 || info.total_count !== rows.length)
    fail(`${label} provider inventory is not proven exhaustive`);
  return rows;
}

export function validateSentinelRefAbsence({ repository, branch, refs, capturedAt }, now = Date.now()) {
  if (!same(repository, githubRepository)) fail("sentinel repository identity drift");
  if (!stagingBranchPattern.test(branch ?? "")) fail("staging sentinel branch is malformed");
  if (!Array.isArray(refs) || refs.length !== 0)
    fail("staging sentinel branch exists or its absence is ambiguous");
  const captured = Date.parse(capturedAt ?? "");
  if (!Number.isFinite(captured) || captured > now + 30_000 || now - captured > 5 * 60_000)
    fail("staging sentinel branch absence proof is stale");
  return { outcome: "staging-sentinel-ref-absent", repository: "atrinik/metaserver-worker",
    branch };
}

export function validateRepositoryConnectionOwnerProof(proof, accountId, sourceSha,
  now = Date.now()) {
  const expectedKeys = ["accountId", "capturedAt", "connectionPreexisting", "repository",
    "source", "websitePreserved", "githubApp", "mainProtection"];
  const expectedApp = { appId: 85455, installationId: 152311798,
    evidenceLocation: "atrinik/metaserver-worker#56-private-provider-evidence",
    repositorySelection: "selected", selectedRepositories: [
      { fullName: "atrinik/metaserver-worker", id: 1324297032 },
      { fullName: "atrinik/website", id: 1327107093 },
    ] };
  const expectedMain = { repository: "atrinik/metaserver-worker", defaultBranch: "main",
    sha: sourceSha, requiresPullRequest: true, allowsDeletion: false, allowsForcePush: false };
  if (!proof || !same(sorted(Object.keys(proof)), sorted(expectedKeys)) ||
      proof.source !== "cloudflare-owner-ui-readback" || proof.accountId !== accountId ||
      proof.connectionPreexisting !== true || proof.websitePreserved !== true ||
      !same(proof.repository, githubRepository) || !same(proof.githubApp, expectedApp) ||
      !same(proof.mainProtection, expectedMain))
    fail("shared repository connection owner proof drift");
  const captured = Date.parse(proof.capturedAt ?? "");
  if (!Number.isFinite(captured) || captured > now + 30_000 || now - captured > 5 * 60_000)
    fail("shared repository connection owner proof is stale");
}

export function productionTriggerSpec(contract, {
  externalScriptId, repositoryConnectionUuid, buildTokenUuid,
}) {
  if (!scriptTagPattern.test(externalScriptId ?? "")) fail("external script tag is malformed");
  for (const [label, value] of [
    ["repository connection", repositoryConnectionUuid],
    ["build token", buildTokenUuid],
  ]) if (!uuidPattern.test(value ?? "")) fail(`${label} UUID is malformed`);
  return {
    trigger_name: "Atrinik automatic production main",
    external_script_id: externalScriptId,
    repo_connection_uuid: repositoryConnectionUuid,
    build_token_uuid: buildTokenUuid,
    build_command: contract.installCommand,
    deploy_command: contract.deployCommand,
    root_directory: contract.rootDirectory,
    branch_includes: [contract.productionBranch],
    branch_excludes: [],
    path_includes: contract.pathIncludes,
    path_excludes: contract.pathExcludes,
    build_caching_enabled: false,
  };
}

export function automaticReviewTriggerSpec(contract, {
  externalScriptId, repositoryConnectionUuid, buildTokenUuid,
}) {
  if (!scriptTagPattern.test(externalScriptId ?? "")) fail("external script tag is malformed");
  for (const [label, value] of [
    ["repository connection", repositoryConnectionUuid],
    ["build token", buildTokenUuid],
  ]) if (!uuidPattern.test(value ?? "")) fail(`${label} UUID is malformed`);
  const automatic = contract.automaticReview;
  return {
    trigger_name: "Atrinik build-only review",
    external_script_id: externalScriptId,
    repo_connection_uuid: repositoryConnectionUuid,
    build_token_uuid: buildTokenUuid,
    build_command: automatic.buildCommand,
    deploy_command: automatic.deployCommand,
    root_directory: automatic.rootDirectory,
    branch_includes: automatic.previewBranchIncludes,
    branch_excludes: automatic.previewBranchExcludes,
    path_includes: automatic.pathIncludes,
    path_excludes: automatic.pathExcludes,
    build_caching_enabled: false,
  };
}

export function validateTriggerSnapshot(actual, expected, label) {
  const keys = [
    "external_script_id", "build_token_uuid", "build_command", "deploy_command",
    "branch_includes", "branch_excludes", "path_includes", "path_excludes",
    "build_caching_enabled",
  ];
  for (const key of keys) if (!same(actual?.[key], expected[key]))
    fail(`${label} trigger ${key} drift`);
  if (
    actual.trigger_name !== expected.trigger_name ||
    !uuidPattern.test(actual.trigger_uuid ?? "") ||
    actual.deleted_on != null
  ) fail(`${label} trigger identity drift`);
  if (normalizedRoot(actual.root_directory) !== normalizedRoot(expected.root_directory))
    fail(`${label} trigger root_directory drift`);
  const connection = actual.repo_connection ?? {};
  if (
    connection.repo_connection_uuid !== expected.repo_connection_uuid ||
    connection.provider_type !== "github" ||
    connection.provider_account_id !== "6371603" ||
    connection.provider_account_name !== "atrinik" ||
    connection.repo_id !== "1324297032" ||
    connection.repo_name !== "metaserver-worker"
  ) fail(`${label} repository connection drift`);
}

export function productionEnvironmentSpec(contract, values) {
  const protectedNames = Object.values(contract.protectedInputs);
  const result = {
    SKIP_DEPENDENCY_INSTALL: { is_secret: false, value: "1" },
  };
  for (const name of protectedNames) {
    if (typeof values?.[name] !== "string" || values[name].length === 0)
      fail(`protected input ${name} is missing`);
    if (Buffer.byteLength(values[name]) > 5 * 1024)
      fail(`protected input ${name} exceeds the provider limit`);
    result[name] = { is_secret: true, value: values[name] };
  }
  return result;
}

export function automaticReviewEnvironmentSpec(review) {
  if (!same(review.automaticReview.buildEnvironment, { SKIP_DEPENDENCY_INSTALL: "1" }))
    fail("review bootstrap environment drift");
  return { SKIP_DEPENDENCY_INSTALL: { is_secret: false, value: "1" } };
}

function resultReference(operation, field) {
  return { resultReference: `${operation}.${field}` };
}

function apiPathReference(template, operation, field) {
  return { template, resultReference: `${operation}.${field}` };
}

function privateFileReference(environmentVariable) {
  return { privateFileEnvironment: environmentVariable };
}

function triggerPlanSpec(spec, scriptOperation, tokenOperation) {
  return {
    ...spec,
    root_directory: spec.root_directory || "/",
    external_script_id: resultReference(scriptOperation, "script_tag"),
    repo_connection_uuid: resultReference("repository-connection", "repo_connection_uuid"),
    build_token_uuid: resultReference(tokenOperation, "build_token_uuid"),
  };
}

function productionEnvironmentPlan(contract) {
  const valueSources = {
    [contract.protectedInputs.accountVariable]: privateFileReference(
      "ATRINIK_CLOUDFLARE_ACCOUNT_ID_FILE"),
    [contract.protectedInputs.coreConfigVariable]: privateFileReference(
      "ATRINIK_PRODUCTION_CORE_CONFIG_FILE"),
    [contract.protectedInputs.publisherConfigVariable]: privateFileReference(
      "ATRINIK_PRODUCTION_PUBLISHER_CONFIG_FILE"),
    [contract.protectedInputs.rendezvousConfigVariable]: privateFileReference(
      "ATRINIK_PRODUCTION_RENDEZVOUS_CONFIG_FILE"),
    [contract.protectedInputs.buildsApiTokenVariable]: privateFileReference(
      "ATRINIK_PRODUCTION_LEASE_TOKEN_FILE"),
    [contract.protectedInputs.controlPlaneGateVariable]: { literal: "routine" },
  };
  return Object.fromEntries([
    ["SKIP_DEPENDENCY_INSTALL", { is_secret: false, valueSource: { literal: "1" } }],
    ...Object.values(contract.protectedInputs).map((name) =>
      [name, { is_secret: true, valueSource: valueSources[name] }]),
  ]);
}

export function provisioningSetupPlan(production, review) {
  const placeholderTag = "1".repeat(32);
  const placeholderUuid = "11111111-1111-4111-8111-111111111111";
  const sentinel = privateFileReference("ATRINIK_STAGING_SENTINEL_BRANCH_FILE");
  const productionFinal = productionTriggerSpec(production, {
    externalScriptId: placeholderTag,
    repositoryConnectionUuid: placeholderUuid,
    buildTokenUuid: placeholderUuid,
  });
  const reviewFinal = automaticReviewTriggerSpec(review, {
    externalScriptId: placeholderTag,
    repositoryConnectionUuid: placeholderUuid,
    buildTokenUuid: placeholderUuid,
  });
  const productionStaged = structuredClone(productionFinal);
  productionStaged.branch_includes = [sentinel];
  const reviewStaged = structuredClone(reviewFinal);
  reviewStaged.branch_includes = [sentinel];
  reviewStaged.branch_excludes = ["main"];
  const plan = {
    schemaVersion: 1,
    outcome: "workers-builds-reviewed-setup-plan",
    mutation: false,
    repositoryConnection: structuredClone(githubRepository),
    gates: [
      "provider-setup-authorization",
      "review-trigger-activation-and-proof",
      "production-trigger-activation",
      "migration-0010",
      "initial-automatic-production-proof",
    ],
    privateInputs: [
      "ATRINIK_CLOUDFLARE_ACCOUNT_ID_FILE",
      "ATRINIK_REVIEWED_SOURCE_SHA_FILE",
      "ATRINIK_WORKERS_BUILDS_API_TOKEN_FILE",
      "ATRINIK_STAGING_SENTINEL_BRANCH_FILE",
      "ATRINIK_STAGING_SENTINEL_REFS_FILE",
      "ATRINIK_REPOSITORY_CONNECTION_OWNER_PROOF_FILE",
      "ATRINIK_REVIEW_BOOTSTRAP_API_TOKEN_FILE",
      "ATRINIK_REVIEW_BOOTSTRAP_UPLOAD_PROOF_FILE",
      "ATRINIK_WORKERS_BUILDS_USAGE_PROOF_FILE",
      "ATRINIK_PRODUCTION_BUILD_TOKEN_SECRET_FILE",
      "ATRINIK_PRODUCTION_BUILD_TOKEN_ID_FILE",
      "ATRINIK_PRODUCTION_BUILD_TOKEN_PERMISSION_PROOF_FILE",
      "ATRINIK_REVIEW_BUILD_TOKEN_SECRET_FILE",
      "ATRINIK_REVIEW_BUILD_TOKEN_ID_FILE",
      "ATRINIK_REVIEW_BUILD_TOKEN_PERMISSION_PROOF_FILE",
      "ATRINIK_PRODUCTION_CORE_CONFIG_FILE",
      "ATRINIK_PRODUCTION_PUBLISHER_CONFIG_FILE",
      "ATRINIK_PRODUCTION_RENDEZVOUS_CONFIG_FILE",
      "ATRINIK_PRODUCTION_LEASE_TOKEN_FILE",
    ],
    credentialAuthority: {
      controlPlaneOperator: {
        tokenType: review.automaticReview.controlPlaneOperator.tokenType,
        contractPermission: review.automaticReview.controlPlaneOperator.permission,
        providerAccountPermissions: [
          "Workers Builds Configuration:Edit",
          "Workers Scripts:Read",
        ],
        credentialBuildReadable: false,
      },
      reviewBootstrapToken: {
        accountPermissions: structuredClone(
          review.automaticReview.bootstrap.provisioningPermissions),
        purpose: "upload-readback-and-if-proven-setup-owned-delete-inert-review-worker",
        credentialBuildReadable:
          review.automaticReview.bootstrap.provisioningCredentialBuildReadable,
      },
      productionBuildToken: {
        accountPermissions: ["Workers Scripts:Edit", "D1:Read"],
        purpose: "read-exact-worker-config-and-migration-ledger-deploy-three-workers",
        forbiddenAuthority: ["D1:Edit", "DNS", "WAF", "Account Administration",
          "Secrets:Read", "destructive-resource-authority"],
      },
      productionLeaseToken: {
        accountPermissions: ["Workers Builds Configuration:Edit"],
        purpose: "read-trigger-and-build-inventory-cancel-only-competing-main-builds",
      },
      reviewBuildToken: structuredClone(review.automaticReview.tokenAuthority),
      stagingBuildToken: {
        source: "review-build-token",
        accountPermissions: [],
        zonePermissions: [],
        accountResources: [],
        purpose: "inert-trigger-staging-only-before-atomic-production-activation",
      },
    },
    setupOperations: [
      { id: "preflight", actor: "workers-builds-control-plane-operator",
        action: "require-exact-private-readback-no-competing-trigger-and-validate-private-random-sentinel-ref-absence",
        mutation: false,
        command: "gh api repos/atrinik/metaserver-worker/git/matching-refs/heads/{private-random-sentinel} outside-sandbox",
        produces: { sentinel_branch: "private-random-branch-name", sentinel_refs: "exact-empty-array",
          repository_connection_owner_proof: "fresh-exact-cloudflare-owner-ui-proof" } },
      { id: "production-script", actor: "workers-builds-control-plane-operator",
        action: "select-exact-existing-production-script-tag", mutation: false,
        expected: { worker: production.workers[0].name },
        produces: { script_tag: { sourceField: "tag", pattern: "32-lowercase-hex" } } },
      { id: "review-bootstrap", actor: "issue-56-review-check-bootstrap-operator",
        action: "upload-exact-inert-review-worker", mutation: true,
        credential: privateFileReference("ATRINIK_REVIEW_BOOTSTRAP_API_TOKEN_FILE"),
        config: review.automaticReview.bootstrap.configPath,
        command: { executable: "node_modules/.bin/wrangler", argv: ["deploy", "--config",
          review.automaticReview.bootstrap.configPath, "--tag", "atrinik-review-bootstrap",
          "--message", `config=${review.automaticReview.bootstrap.configSha256} source=${review.automaticReview.bootstrap.sourceSha256}`],
        environment: { CLOUDFLARE_API_TOKEN:
          privateFileReference("ATRINIK_REVIEW_BOOTSTRAP_API_TOKEN_FILE") } },
        expected: { worker: review.automaticReview.project, retainedVersions: 1,
          workersDev: false, previewUrls: false, bindings: [], routes: [],
          configSha256: review.automaticReview.bootstrap.configSha256,
          sourceSha256: review.automaticReview.bootstrap.sourceSha256,
          versionAnnotations: {
            "workers/tag": "atrinik-review-bootstrap",
            "workers/message": `config=${review.automaticReview.bootstrap.configSha256} source=${review.automaticReview.bootstrap.sourceSha256}`,
          } },
        produces: { script_tag: { sourceField: "tag", pattern: "32-lowercase-hex" },
          version_id: { sourceField: "id", pattern: "provider-uuid" } } },
      { id: "repository-connection", actor: "workers-builds-control-plane-operator",
        action: "put-or-reuse-exact-repository-connection-and-always-retain-on-rollback", mutation: true,
        request: { method: "PUT", path: "/builds/repos/connections",
          body: structuredClone(githubRepository) },
        produces: { repo_connection_uuid: "provider-repository-connection-uuid" } },
      { id: "production-build-token", actor: "workers-builds-control-plane-operator",
        action: "post-build-token-only-after-exact-list-proves-no-match-or-resume-journal-binds-one",
        mutation: true,
        request: { method: "POST", path: "/builds/tokens", body: {
          build_token_name: "Atrinik metaserver production",
          build_token_secret: privateFileReference("ATRINIK_PRODUCTION_BUILD_TOKEN_SECRET_FILE"),
          cloudflare_token_id: privateFileReference("ATRINIK_PRODUCTION_BUILD_TOKEN_ID_FILE"),
        } }, produces: { build_token_uuid: "provider-build-token-uuid",
          cloudflare_token_id: "exact-private-input-token-id" } },
      { id: "review-build-token", actor: "workers-builds-control-plane-operator",
        action: "post-build-token-only-after-exact-list-proves-no-match-or-resume-journal-binds-one",
        mutation: true,
        request: { method: "POST", path: "/builds/tokens", body: {
          build_token_name: "Atrinik metaserver review check",
          build_token_secret: privateFileReference("ATRINIK_REVIEW_BUILD_TOKEN_SECRET_FILE"),
          cloudflare_token_id: privateFileReference("ATRINIK_REVIEW_BUILD_TOKEN_ID_FILE"),
        } }, produces: { build_token_uuid: "provider-build-token-uuid",
          cloudflare_token_id: "exact-private-input-token-id" } },
      { id: "sentinel-recheck-before-production-trigger", actor: "github-owner-readback",
        action: "repeat-exact-private-random-sentinel-ref-absence-proof-outside-sandbox",
        mutation: false, branch: sentinel },
      { id: "production-trigger-staged", actor: "workers-builds-control-plane-operator",
        action: "post-inert-trigger-with-zero-resource-token", mutation: true,
        request: { method: "POST", path: "/builds/triggers",
          body: triggerPlanSpec(productionStaged, "production-script",
            "review-build-token") },
        produces: { trigger_uuid: "provider-trigger-uuid" } },
      { id: "sentinel-recheck-before-production-environment", actor: "github-owner-readback",
        action: "repeat-exact-private-random-sentinel-ref-absence-proof-outside-sandbox",
        mutation: false, branch: sentinel },
      { id: "production-environment", actor: "workers-builds-control-plane-operator",
        action: "patch-exact-environment", mutation: true,
        request: { method: "PATCH",
          path: apiPathReference("/builds/triggers/{trigger_uuid}/environment_variables",
            "production-trigger-staged", "trigger_uuid"),
          body: productionEnvironmentPlan(production) } },
      { id: "sentinel-recheck-before-review-trigger", actor: "github-owner-readback",
        action: "repeat-exact-private-random-sentinel-ref-absence-proof-outside-sandbox",
        mutation: false, branch: sentinel },
      { id: "review-trigger-staged", actor: "workers-builds-control-plane-operator",
        action: "post-inert-trigger-with-zero-resource-token", mutation: true,
        request: { method: "POST", path: "/builds/triggers",
          body: triggerPlanSpec(reviewStaged, "review-bootstrap", "review-build-token") },
        produces: { trigger_uuid: "provider-trigger-uuid" } },
      { id: "review-environment", actor: "workers-builds-control-plane-operator",
        action: "patch-exact-environment", mutation: true,
        request: { method: "PATCH",
          path: apiPathReference("/builds/triggers/{trigger_uuid}/environment_variables",
            "review-trigger-staged", "trigger_uuid"),
          body: Object.fromEntries(Object.entries(automaticReviewEnvironmentSpec(review))
            .map(([name, value]) => [name, { is_secret: value.is_secret,
              valueSource: { literal: value.value } }])) } },
      { id: "staged-readback", actor: "workers-builds-control-plane-operator",
        action: "prove-both-inert-triggers-environments-tokens-and-no-deploy-hooks",
        mutation: false },
    ],
    reviewActivation: {
      gate: "review-trigger-activation-and-proof",
      request: { method: "PATCH",
        path: apiPathReference("/builds/triggers/{trigger_uuid}",
          "review-trigger-staged", "trigger_uuid"),
        body: triggerPlanSpec(reviewFinal, "review-bootstrap", "review-build-token") },
      proof: "disposable-same-repository-non-main-build-only-branch",
    },
    productionActivation: {
      gate: "production-trigger-activation",
      precondition: "repeat-exact-private-random-sentinel-ref-absence-proof-immediately-before-atomic-patch",
      request: { method: "PATCH",
        path: apiPathReference("/builds/triggers/{trigger_uuid}",
          "production-trigger-staged", "trigger_uuid"),
        body: triggerPlanSpec(productionFinal, "production-script", "production-build-token") },
      initialGate: "routine-fails-closed-until-exact-main-sha-is-known-and-separately-approved",
      proof: "automatic-main-build-then-exact-sha-provider-retry-if-first-annotation-gate-stops",
    },
    partialFailure: {
      journal: "owner-only-append-after-each-mutation-with-operation-request-digest-resource-uuid-and-readback-digest",
      policy: "stop-at-first-ambiguous-response-read-back-before-retry-and-never-recreate-an-unknown-resource",
      rollbackScope: "delete-or-restore-only-exact-resources-proven-created-or-changed-by-this-journal",
      productionWorkerPolicy: "never-delete-or-roll-back-existing-production-workers-versions-state-or-secrets",
    },
    rollbackOperations: [
      "restore-production-trigger-to-inert-sentinel-before-cancelling-exact-active-builds",
      "restore-review-trigger-to-inert-sentinel",
      "prove-no-build-or-upload-remains-active",
      "delete-exact-production-and-review-triggers",
      "delete-only-the-two-recorded-build-token-uuids",
      "retain-shared-metaserver-repository-connection-provider-has-no-read-inventory-and-website-must-survive",
      "delete-review-bootstrap-only-after-trigger-absence-and-exact-version-readback",
      "prove-three-production-workers-and-website-app-selection-unchanged",
    ],
  };
  validateSetupPlan(plan);
  return plan;
}

export function validateSetupPlan(plan) {
  const operations = plan?.setupOperations;
  const expectedOperations = [
    ["preflight", "workers-builds-control-plane-operator", false,
      "require-exact-private-readback-no-competing-trigger-and-validate-private-random-sentinel-ref-absence"],
    ["production-script", "workers-builds-control-plane-operator", false,
      "select-exact-existing-production-script-tag"],
    ["review-bootstrap", "issue-56-review-check-bootstrap-operator", true,
      "upload-exact-inert-review-worker"],
    ["repository-connection", "workers-builds-control-plane-operator", true,
      "put-or-reuse-exact-repository-connection-and-always-retain-on-rollback"],
    ["production-build-token", "workers-builds-control-plane-operator", true,
      "post-build-token-only-after-exact-list-proves-no-match-or-resume-journal-binds-one"],
    ["review-build-token", "workers-builds-control-plane-operator", true,
      "post-build-token-only-after-exact-list-proves-no-match-or-resume-journal-binds-one"],
    ["sentinel-recheck-before-production-trigger", "github-owner-readback", false,
      "repeat-exact-private-random-sentinel-ref-absence-proof-outside-sandbox"],
    ["production-trigger-staged", "workers-builds-control-plane-operator", true,
      "post-inert-trigger-with-zero-resource-token"],
    ["sentinel-recheck-before-production-environment", "github-owner-readback", false,
      "repeat-exact-private-random-sentinel-ref-absence-proof-outside-sandbox"],
    ["production-environment", "workers-builds-control-plane-operator", true,
      "patch-exact-environment"],
    ["sentinel-recheck-before-review-trigger", "github-owner-readback", false,
      "repeat-exact-private-random-sentinel-ref-absence-proof-outside-sandbox"],
    ["review-trigger-staged", "workers-builds-control-plane-operator", true,
      "post-inert-trigger-with-zero-resource-token"],
    ["review-environment", "workers-builds-control-plane-operator", true,
      "patch-exact-environment"],
    ["staged-readback", "workers-builds-control-plane-operator", false,
      "prove-both-inert-triggers-environments-tokens-and-no-deploy-hooks"],
  ];
  if (!Array.isArray(operations) || new Set(operations.map(({ id }) => id)).size !== operations.length)
    fail("setup operation identity is incomplete or duplicated");
  if (!same(operations.map(({ id, actor, mutation, action }) => [id, actor, mutation, action]),
    expectedOperations))
    fail("setup operation set, order, actor, or mutation boundary drift");
  const expectedProduces = new Map([
    ["preflight", { sentinel_branch: "private-random-branch-name",
      sentinel_refs: "exact-empty-array",
      repository_connection_owner_proof: "fresh-exact-cloudflare-owner-ui-proof" }],
    ["production-script", { script_tag: { sourceField: "tag", pattern: "32-lowercase-hex" } }],
    ["review-bootstrap", { script_tag: { sourceField: "tag", pattern: "32-lowercase-hex" },
      version_id: { sourceField: "id", pattern: "provider-uuid" } }],
    ["repository-connection", { repo_connection_uuid: "provider-repository-connection-uuid" }],
    ["production-build-token", { build_token_uuid: "provider-build-token-uuid",
      cloudflare_token_id: "exact-private-input-token-id" }],
    ["review-build-token", { build_token_uuid: "provider-build-token-uuid",
      cloudflare_token_id: "exact-private-input-token-id" }],
    ["production-trigger-staged", { trigger_uuid: "provider-trigger-uuid" }],
    ["review-trigger-staged", { trigger_uuid: "provider-trigger-uuid" }],
  ]);
  for (const operation of operations) {
    const expected = expectedProduces.get(operation.id);
    if ((expected !== undefined && !same(operation.produces, expected)) ||
        (expected === undefined && operation.produces !== undefined))
      fail(`setup producer schema ${operation.id} drift`);
  }
  const available = new Map();
  const inspect = (value) => {
    if (Array.isArray(value)) return value.forEach(inspect);
    if (!value || typeof value !== "object") return;
    if (typeof value.resultReference === "string") {
      const [operation, field, ...extra] = value.resultReference.split(".");
      if (extra.length || !available.get(operation)?.has(field))
        fail(`setup result reference ${value.resultReference} is dangling or forward`);
    }
    for (const nested of Object.values(value)) inspect(nested);
  };
  for (const operation of operations) {
    inspect(operation);
    const fields = Object.keys(operation.produces ?? {});
    available.set(operation.id, new Set(fields));
  }
  inspect(plan.reviewActivation);
  inspect(plan.productionActivation);
  return plan;
}

export function validateAutomaticReviewEnvironment(actual, review) {
  const expected = automaticReviewEnvironmentSpec(review);
  if (!same(sorted(Object.keys(actual ?? {})), sorted(Object.keys(expected))))
    fail("review environment inventory drift");
  const bootstrap = actual.SKIP_DEPENDENCY_INSTALL ?? {};
  if (
    bootstrap.is_secret !== expected.SKIP_DEPENDENCY_INSTALL.is_secret ||
    bootstrap.value !== expected.SKIP_DEPENDENCY_INSTALL.value ||
    (bootstrap.created_on !== undefined &&
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(bootstrap.created_on)) ||
    !Object.keys(bootstrap).every((key) => ["created_on", "is_secret", "value"].includes(key))
  )
    fail("review bootstrap environment drift");
}

export function validateNoDeployHooks(envelope, label) {
  const hooks = requireExhaustiveEnvelope(envelope, `${label} deploy hooks`);
  if (hooks.length !== 0)
    fail(`${label} gained a Deploy Hook`);
}

export function validateNoActiveBuilds(envelope, label) {
  const builds = requireExhaustiveEnvelope(envelope, `${label} builds`);
  if (builds.some(({ status }) =>
    !["queued", "initializing", "running", "stopped"].includes(status)))
    fail(`${label} build inventory is malformed`);
  if (builds.some(({ status }) => status !== "stopped"))
    fail(`${label} has an active Workers Build`);
}

export function validateFreshBuildsSnapshot({ production, review, scripts,
  triggers, deployHooks, builds, buildTokens, accountTriggers,
  sentinelProof, repositoryConnectionProof, accountId, sourceSha }) {
  const scriptRows = requireEnvelope(scripts, "scripts");
  if (!Array.isArray(scriptRows)) fail("script inventory is invalid");
  const requiredNames = production.workers.map(({ name }) => name);
  for (const name of requiredNames) {
    const matches = scriptRows.filter(({ id }) => id === name);
    if (matches.length !== 1 || !scriptTagPattern.test(matches[0].tag ?? ""))
      fail(`required production Worker ${name} is missing or ambiguous`);
  }
  const reviewRows = scriptRows.filter(({ id }) => id === review.automaticReview.project);
  if (reviewRows.length !== 0)
    fail("fresh setup cannot adopt a pre-existing review bootstrap Worker");
  const expectedLabels = production.workers.map(({ role }) => role);
  for (const [label, envelope] of exactLabeledInventories(triggers,
    expectedLabels, "fresh trigger")) {
    const rows = requireExhaustiveEnvelope(envelope, `${label} triggers`);
    if (rows.length !== 0)
      fail(`${label} has a competing Workers Builds trigger`);
  }
  for (const [label, envelope] of exactLabeledInventories(deployHooks,
    expectedLabels, "fresh Deploy Hook")) validateNoDeployHooks(envelope, label);
  for (const [label, envelope] of exactLabeledInventories(builds,
    expectedLabels, "fresh build")) validateNoActiveBuilds(envelope, label);
  const allTriggers = requireExhaustiveEnvelope(accountTriggers, "account triggers")
    .filter(({ repo_connection: connection }) => connection?.provider_type === "github" &&
      connection.provider_account_id === githubRepository.provider_account_id &&
      connection.repo_id === githubRepository.repo_id);
  if (allTriggers.length !== 0)
    fail("account has a competing Workers Builds trigger");
  const tokenRows = requireExhaustiveEnvelope(buildTokens, "build tokens");
  const reservedNames = new Set([
    "Atrinik metaserver production", "Atrinik metaserver review check",
  ]);
  if (tokenRows.some(({ build_token_name: name }) => reservedNames.has(name)))
    fail("reserved Workers Builds token name already exists");
  validateSentinelRefAbsence(sentinelProof);
  validateRepositoryConnectionOwnerProof(repositoryConnectionProof, accountId, sourceSha);
  return { outcome: "workers-builds-fresh-preflight-valid", mutation: false,
    productionProjectCount: production.workers.length,
    reviewBootstrapPresent: false, repositoryConnectionInventory: "provider-not-readable" };
}

function exactLabeledInventories(actual, expectedLabels, label) {
  if (!Array.isArray(actual) || actual.some((entry) =>
    !Array.isArray(entry) || entry.length !== 2) ||
      !same(sorted(actual.map(([name]) => name)), sorted(expectedLabels)))
    fail(`${label} inventory is incomplete or ambiguous`);
  return actual;
}

export function validateBuildTokenInventory(envelope, expectedTokens) {
  const tokens = requireExhaustiveEnvelope(envelope, "build tokens");
  const underlyingIds = new Set();
  for (const { uuid, name, cloudflareTokenId } of expectedTokens) {
    const matches = tokens.filter(({ build_token_uuid: candidate }) => candidate === uuid);
    if (matches.length !== 1) fail("configured build token is missing or ambiguous");
    const token = matches[0];
    if (
      token.owner_type !== "user" ||
      token.build_token_name !== name ||
      typeof token.cloudflare_token_id !== "string" || !token.cloudflare_token_id.trim() ||
      (cloudflareTokenId !== undefined && token.cloudflare_token_id !== cloudflareTokenId)
    ) fail("configured build token authority is malformed");
    if (underlyingIds.has(token.cloudflare_token_id))
      fail("production and review reuse one underlying API token");
    underlyingIds.add(token.cloudflare_token_id);
  }
}

export function validateTokenAuthorityProofs({ production, review, accountId, proofs,
  tokenRows, sourceSha }, now = Date.now()) {
  const expected = [
    { kind: "production", tokenId: tokenRows.production.cloudflare_token_id,
      userPermissions: [], accountPermissions: ["D1:Read", "Workers Scripts:Edit"],
      accountResources: [accountId], zonePermissions: [], zoneResources: [] },
    { kind: "review", tokenId: tokenRows.review.cloudflare_token_id,
      userPermissions: review.automaticReview.tokenAuthority.userPermissions,
      accountPermissions: review.automaticReview.tokenAuthority.accountPermissions,
      accountResources: review.automaticReview.tokenAuthority.accountResources,
      zonePermissions: review.automaticReview.tokenAuthority.zonePermissions,
      zoneResources: review.automaticReview.tokenAuthority.zoneResources },
  ];
  if (!Array.isArray(proofs) || proofs.length !== expected.length)
    fail("build token permission proof inventory is incomplete");
  for (const item of expected) {
    const proof = proofs.find(({ kind }) => kind === item.kind);
    const captured = Date.parse(proof?.capturedAt ?? "");
    const modified = Date.parse(proof?.modifiedOn ?? "");
    if (!proof || proof.source !== "cloudflare-owner-token-policy-readback" ||
        !same(Object.keys(proof).sort(), ["accountId", "accountPermissions", "accountResources",
          "capturedAt", "kind", "modifiedOn", "source", "sourceSha", "tokenId",
          "userPermissions", "zonePermissions", "zoneResources"].sort()) ||
        !Number.isFinite(captured) || captured > now + 30_000 || now - captured > 5 * 60_000 ||
        !Number.isFinite(modified) || modified > captured ||
        ![proof.userPermissions, proof.accountPermissions, proof.accountResources,
          proof.zonePermissions, proof.zoneResources].every(Array.isArray) ||
        proof.accountId !== accountId || proof.sourceSha !== sourceSha ||
        proof.tokenId !== item.tokenId ||
        !same(sorted(proof.userPermissions ?? []), sorted(item.userPermissions)) ||
        !same(sorted(proof.accountPermissions ?? []), sorted(item.accountPermissions)) ||
        !same(sorted(proof.accountResources ?? []), sorted(item.accountResources)) ||
        !same(sorted(proof.zonePermissions ?? []), sorted(item.zonePermissions)) ||
        !same(sorted(proof.zoneResources ?? []), sorted(item.zoneResources)))
      fail(`${item.kind} build token permission proof drift`);
  }
  if (production.workers.length !== 3) fail("production token resource boundary drift");
}

export function validateReviewBootstrapState({ review, config, script, settings, subdomain,
  schedules, routes, scriptSettings, deployments, versions, activeVersion, builds,
  buildLimits, buildUsageProof, uploadProof, sourceSha, accountId }, now = Date.now()) {
  const bootstrap = review.automaticReview.bootstrap;
  const liveSettings = requireEnvelope(settings, "review bootstrap settings");
  if (liveSettings.compatibility_date !== config.compatibility_date ||
      !same(liveSettings.compatibility_flags ?? [], config.compatibility_flags ?? []) ||
      !same(liveSettings.bindings ?? [], []) ||
      !same(liveSettings.observability ?? {}, config.observability))
    fail("review bootstrap runtime settings drift");
  const liveSubdomain = requireEnvelope(subdomain, "review bootstrap subdomain");
  if (liveSubdomain.enabled !== false || liveSubdomain.previews_enabled !== false)
    fail("review bootstrap exposes a public or preview URL");
  if (!same(requireEnvelope(schedules, "review bootstrap schedules").schedules ?? [], []) ||
      !same(requireEnvelope(routes, "review bootstrap routes"), []))
    fail("review bootstrap gained a route or schedule");
  const auxiliary = requireEnvelope(scriptSettings, "review bootstrap script settings");
  if (auxiliary.logpush === true || (auxiliary.tail_consumers ?? []).length !== 0)
    fail("review bootstrap gained an external log consumer");
  const deploymentRows = requireEnvelope(deployments, "review bootstrap deployments").deployments;
  const versionRows = requireExhaustiveEnvelope(versions, "review bootstrap versions");
  if (!Array.isArray(deploymentRows) || deploymentRows.length !== 1 ||
      versionRows.length !== bootstrap.retainedBootstrapVersions)
    fail("review bootstrap retained deployment/version inventory drift");
  const deploymentVersions = deploymentRows[0].versions ?? [];
  if (deploymentVersions.length !== 1 || deploymentVersions[0].percentage !== 100 ||
      deploymentVersions[0].version_id !== versionRows[0].id ||
      versionRows[0].id !== activeVersion?.result?.id || !scriptTagPattern.test(script.tag ?? ""))
    fail("review bootstrap active version identity drift");
  const expectedAnnotations = {
    "workers/tag": "atrinik-review-bootstrap",
    "workers/message": `config=${bootstrap.configSha256} source=${bootstrap.sourceSha256}`,
  };
  const version = requireEnvelope(activeVersion, "review bootstrap active version");
  if (!same(version.annotations, expectedAnnotations) ||
      !same(version.resources?.bindings ?? [], []) ||
      !same(version.resources?.script_runtime?.exports ?? {}, {}))
    fail("review bootstrap digest, binding, or export proof drift");
  const proofKeys = ["capturedAt", "cleanCheckout", "command", "configSha256", "source",
    "sourceRevision", "sourceSha256", "versionId"];
  const captured = Date.parse(uploadProof?.capturedAt ?? "");
  if (!uploadProof || !same(sorted(Object.keys(uploadProof)), sorted(proofKeys)) ||
      uploadProof.source !== "wrangler-clean-reviewed-source-upload" ||
      uploadProof.cleanCheckout !== true || uploadProof.sourceRevision !== sourceSha ||
      uploadProof.sourceSha256 !== bootstrap.sourceSha256 ||
      uploadProof.configSha256 !== bootstrap.configSha256 || uploadProof.versionId !== version.id ||
      !same(uploadProof.command, ["node_modules/.bin/wrangler", "deploy", "--config",
        bootstrap.configPath, "--tag", "atrinik-review-bootstrap", "--message",
        `config=${bootstrap.configSha256} source=${bootstrap.sourceSha256}`]) ||
      !Number.isFinite(captured) || captured > now + 30_000 || now - captured > 5 * 60_000)
    fail("review bootstrap clean-source upload proof drift");
  validateNoActiveBuilds(builds, "review bootstrap");
  const limits = requireEnvelope(buildLimits, "Workers Builds account limits");
  if (typeof limits.has_reached_build_minutes_limit !== "boolean" ||
      (limits.build_minutes_refresh_on !== undefined &&
       !Number.isFinite(Date.parse(limits.build_minutes_refresh_on))))
    fail("Workers Builds account limit readback is malformed");
  if (limits.has_reached_build_minutes_limit)
    fail("Workers Builds account has reached its monthly limit");
  const usageKeys = ["accountId", "alertAtMinutes", "capturedAt", "disableAtMinutes",
    "monthlyMinutesUsed", "source"];
  const usageCaptured = Date.parse(buildUsageProof?.capturedAt ?? "");
  if (!buildUsageProof || !same(sorted(Object.keys(buildUsageProof)), sorted(usageKeys)) ||
      buildUsageProof.source !== "cloudflare-owner-build-usage-readback" ||
      buildUsageProof.accountId !== accountId ||
      buildUsageProof.alertAtMinutes !== review.automaticReview.costPolicy.alertAtMinutes ||
      buildUsageProof.disableAtMinutes !==
        review.automaticReview.costPolicy.maximumMonthlyReviewBuildMinutes ||
      !Number.isSafeInteger(buildUsageProof.monthlyMinutesUsed) ||
      buildUsageProof.monthlyMinutesUsed < 0 ||
      buildUsageProof.monthlyMinutesUsed >= buildUsageProof.alertAtMinutes ||
      !Number.isFinite(usageCaptured) || usageCaptured > now + 30_000 ||
      now - usageCaptured > 5 * 60_000)
    fail("Workers Builds private usage boundary is stale or exhausted");
}

export function validateConfiguredBuildsSnapshot({ production, review, scripts,
  productionTriggers, productionEnvironment, reviewTriggers, reviewEnvironment,
  nonEntrypointTriggers, deployHooks, buildTokens, accountTriggers,
  reviewBootstrapState, reviewBootstrapConfig, accountId, tokenAuthorityProofs, sourceSha }) {
  const scriptRows = requireEnvelope(scripts, "scripts");
  if (!Array.isArray(scriptRows)) fail("script inventory is invalid");
  const productionScript = scriptRows.find(({ id }) => id === production.workers[0].name);
  const reviewScript = scriptRows.find(({ id }) => id === review.automaticReview.project);
  if (!scriptTagPattern.test(productionScript?.tag ?? "") ||
      !scriptTagPattern.test(reviewScript?.tag ?? ""))
    fail("configured Builds scripts are missing or malformed");
  if (productionScript.tag === reviewScript.tag)
    fail("production and review Builds projects share one script tag");
  const productionRows = requireExhaustiveEnvelope(productionTriggers, "production triggers");
  const reviewRows = requireExhaustiveEnvelope(reviewTriggers, "review triggers");
  if (productionRows.length !== 1 || reviewRows.length !== 1)
    fail("configured trigger inventory is not exactly one per Builds project");
  for (const [label, envelope] of exactLabeledInventories(nonEntrypointTriggers,
    production.workers.slice(1).map(({ role }) => role), "non-entrypoint trigger")) {
    const rows = requireExhaustiveEnvelope(envelope, `${label} triggers`);
    if (rows.length !== 0)
      fail(`${label} gained an independent Builds trigger`);
  }
  const productionActual = productionRows[0];
  const reviewActual = reviewRows[0];
  if (productionActual.trigger_uuid === reviewActual.trigger_uuid ||
      productionActual.build_token_uuid === reviewActual.build_token_uuid)
    fail("production and review trigger/token identities are not isolated");
  const tokenRows = requireExhaustiveEnvelope(buildTokens, "build tokens");
  const productionToken = tokenRows.find(({ build_token_uuid: id }) =>
    id === productionActual.build_token_uuid);
  const reviewToken = tokenRows.find(({ build_token_uuid: id }) => id === reviewActual.build_token_uuid);
  validateBuildTokenInventory(buildTokens, [
    { uuid: productionActual.build_token_uuid, name: "Atrinik metaserver production",
      cloudflareTokenId: tokenAuthorityProofs?.find(({ kind }) => kind === "production")?.tokenId },
    { uuid: reviewActual.build_token_uuid, name: "Atrinik metaserver review check",
      cloudflareTokenId: tokenAuthorityProofs?.find(({ kind }) => kind === "review")?.tokenId },
  ]);
  validateTokenAuthorityProofs({ production, review, accountId, proofs: tokenAuthorityProofs,
    tokenRows: { production: productionToken, review: reviewToken }, sourceSha });
  const productionExpected = productionTriggerSpec(production, {
    externalScriptId: productionScript.tag,
    repositoryConnectionUuid: productionActual.repo_connection?.repo_connection_uuid,
    buildTokenUuid: productionActual.build_token_uuid,
  });
  const reviewExpected = automaticReviewTriggerSpec(review, {
    externalScriptId: reviewScript.tag,
    repositoryConnectionUuid: reviewActual.repo_connection?.repo_connection_uuid,
    buildTokenUuid: reviewActual.build_token_uuid,
  });
  validateTriggerSnapshot(productionActual, productionExpected, "production");
  validateTriggerSnapshot(reviewActual, reviewExpected, "review");
  if (productionActual.repo_connection.repo_connection_uuid !==
      reviewActual.repo_connection.repo_connection_uuid)
    fail("production and review triggers do not reuse one repository connection");
  validateBuildEnvironment(production, requireEnvelope(productionEnvironment,
    "production environment"));
  validateAutomaticReviewEnvironment(requireEnvelope(reviewEnvironment,
    "review environment"), review);
  const allTriggers = requireExhaustiveEnvelope(accountTriggers, "account triggers")
    .filter(({ repo_connection: connection }) => connection?.provider_type === "github" &&
      connection.provider_account_id === githubRepository.provider_account_id &&
      connection.repo_id === githubRepository.repo_id);
  if (allTriggers.length !== 2 || !same(sorted(allTriggers.map(({ trigger_uuid: id }) => id)),
    sorted([productionActual.trigger_uuid, reviewActual.trigger_uuid])))
    fail("account has a competing or missing Workers Builds trigger");
  validateReviewBootstrapState({ review, config: reviewBootstrapConfig,
    script: reviewScript, ...reviewBootstrapState, sourceSha, accountId });
  for (const [label, envelope] of exactLabeledInventories(deployHooks,
    [...production.workers.map(({ role }) => role), "review"], "Deploy Hook"))
    validateNoDeployHooks(envelope, label);
  return {
    outcome: "workers-builds-configured-snapshot-valid",
    mutation: false,
    productionTriggerCount: productionRows.length,
    reviewTriggerCount: reviewRows.length,
    deployHookCount: 0,
  };
}

export function validateStagedBuildsSnapshot({ production, review, scripts,
  productionTriggers, productionEnvironment, reviewTriggers, reviewEnvironment,
  nonEntrypointTriggers, deployHooks, builds, buildTokens, accountTriggers, reviewBootstrapState,
  reviewBootstrapConfig, accountId, tokenAuthorityProofs, sourceSha, sentinelProof }) {
  validateSentinelRefAbsence(sentinelProof);
  const scriptRows = requireEnvelope(scripts, "scripts");
  const productionScript = scriptRows.find(({ id }) => id === production.workers[0].name);
  const reviewScript = scriptRows.find(({ id }) => id === review.automaticReview.project);
  if (!scriptTagPattern.test(productionScript?.tag ?? "") ||
      !scriptTagPattern.test(reviewScript?.tag ?? ""))
    fail("staged Builds scripts are missing or malformed");
  const productionRows = requireExhaustiveEnvelope(productionTriggers, "staged production triggers");
  const reviewRows = requireExhaustiveEnvelope(reviewTriggers, "staged review triggers");
  if (productionRows.length !== 1 || reviewRows.length !== 1)
    fail("staged trigger inventory is not exactly one per Builds project");
  const tokenRows = requireExhaustiveEnvelope(buildTokens, "build tokens");
  const reviewToken = tokenRows.find(({ build_token_uuid: id }) =>
    id === reviewRows[0].build_token_uuid);
  const productionToken = tokenRows.find(({ build_token_name: name }) =>
    name === "Atrinik metaserver production");
  if (!productionToken || !reviewToken ||
      productionRows[0].build_token_uuid !== reviewRows[0].build_token_uuid)
    fail("staged triggers do not share the zero-resource review token");
  validateBuildTokenInventory(buildTokens, [
    { uuid: productionToken.build_token_uuid, name: "Atrinik metaserver production",
      cloudflareTokenId: tokenAuthorityProofs?.find(({ kind }) => kind === "production")?.tokenId },
    { uuid: reviewToken.build_token_uuid, name: "Atrinik metaserver review check",
      cloudflareTokenId: tokenAuthorityProofs?.find(({ kind }) => kind === "review")?.tokenId },
  ]);
  validateTokenAuthorityProofs({ production, review, accountId, proofs: tokenAuthorityProofs,
    tokenRows: { production: productionToken, review: reviewToken }, sourceSha });
  const productionExpected = productionTriggerSpec(production, {
    externalScriptId: productionScript.tag,
    repositoryConnectionUuid: productionRows[0].repo_connection?.repo_connection_uuid,
    buildTokenUuid: reviewToken.build_token_uuid,
  });
  productionExpected.branch_includes = [sentinelProof.branch];
  const reviewExpected = automaticReviewTriggerSpec(review, {
    externalScriptId: reviewScript.tag,
    repositoryConnectionUuid: reviewRows[0].repo_connection?.repo_connection_uuid,
    buildTokenUuid: reviewToken.build_token_uuid,
  });
  reviewExpected.branch_includes = [sentinelProof.branch];
  reviewExpected.branch_excludes = ["main"];
  validateTriggerSnapshot(productionRows[0], productionExpected, "staged production");
  validateTriggerSnapshot(reviewRows[0], reviewExpected, "staged review");
  validateBuildEnvironment(production, requireEnvelope(productionEnvironment,
    "staged production environment"));
  validateAutomaticReviewEnvironment(requireEnvelope(reviewEnvironment,
    "staged review environment"), review);
  for (const [label, envelope] of exactLabeledInventories(nonEntrypointTriggers,
    production.workers.slice(1).map(({ role }) => role), "staged non-entrypoint trigger"))
    if (requireExhaustiveEnvelope(envelope, `${label} staged triggers`).length !== 0)
      fail(`${label} has an independent staged Builds trigger`);
  const metaserverTriggers = requireExhaustiveEnvelope(accountTriggers, "account triggers")
    .filter(({ repo_connection: connection }) => connection?.provider_type === "github" &&
      connection.provider_account_id === githubRepository.provider_account_id &&
      connection.repo_id === githubRepository.repo_id);
  if (!same(sorted(metaserverTriggers.map(({ trigger_uuid: id }) => id)),
    sorted([productionRows[0].trigger_uuid, reviewRows[0].trigger_uuid])))
    fail("staged account trigger inventory drift");
  const stagedLabels = [...production.workers.map(({ role }) => role), "review"];
  for (const [label, envelope] of exactLabeledInventories(deployHooks, stagedLabels,
    "staged Deploy Hook")) validateNoDeployHooks(envelope, label);
  for (const [label, envelope] of exactLabeledInventories(builds, stagedLabels,
    "staged build")) validateNoActiveBuilds(envelope, label);
  validateReviewBootstrapState({ review, config: reviewBootstrapConfig,
    script: reviewScript, ...reviewBootstrapState, sourceSha, accountId });
  return { outcome: "workers-builds-staged-snapshot-valid", mutation: false,
    stagedTriggerCount: 2 };
}

export function materializeProductionConfiguration({
  base, worker, settingsEnvelope, subdomainEnvelope, accountId,
}) {
  if (!accountIdPattern.test(accountId ?? "")) fail("production account ID is malformed");
  const settings = requireEnvelope(settingsEnvelope, `${worker.role} settings`);
  const subdomain = requireEnvelope(subdomainEnvelope, `${worker.role} subdomain`);
  if (subdomain.enabled !== false || subdomain.previews_enabled !== false)
    fail(`${worker.role} enables an alternate production URL`);
  if (
    base.compatibility_date !== settings.compatibility_date ||
    !same(base.compatibility_flags ?? [], settings.compatibility_flags ?? [])
  ) fail(`${worker.role} compatibility settings drift`);

  const config = structuredClone(base);
  const bindings = settings.bindings ?? [];
  if (!Array.isArray(bindings)) fail(`${worker.role} binding inventory is malformed`);
  const actualBindingInventory = bindings.map(({ name, type }) => ({ name, type }))
    .sort((left, right) => `${left.name}:${left.type}`.localeCompare(`${right.name}:${right.type}`));
  if (!same(actualBindingInventory, expectedBindingInventory(base)))
    fail(`${worker.role} binding inventory drift`);
  config.account_id = accountId;
  config.workers_dev = false;
  config.preview_urls = false;
  config.routes = worker.customDomains.map((pattern) => ({ pattern, custom_domain: true }));
  if (Object.hasOwn(config.vars ?? {}, "DIRECTORY_CACHE_ZONE_ID")) {
    const live = oneBinding(bindings, "DIRECTORY_CACHE_ZONE_ID", "plain_text");
    config.vars.DIRECTORY_CACHE_ZONE_ID = live.text;
  }
  for (const [name, expected] of Object.entries(config.vars ?? {})) {
    if (name === "DIRECTORY_CACHE_ZONE_ID") continue;
    if (oneBinding(bindings, name, "plain_text").text !== expected)
      fail(`${worker.role} plain-text binding ${name} drift`);
  }
  for (const { name, class_name: expectedClass } of config.durable_objects?.bindings ?? [])
    if (oneBinding(bindings, name, "durable_object_namespace").class_name !== expectedClass)
      fail(`${worker.role} Durable Object binding ${name} drift`);
  if (config.d1_databases) config.d1_databases = config.d1_databases.map((item) => {
    const live = oneBinding(bindings, item.binding, "d1");
    if (live.id !== undefined && live.database_id !== undefined &&
        live.id !== live.database_id)
      fail(`${worker.role} D1 binding ${item.binding} has ambiguous identifiers`);
    return { ...item, database_id: live.database_id ?? live.id };
  });
  if (config.r2_buckets) config.r2_buckets = config.r2_buckets.map((item) => {
    const live = oneBinding(bindings, item.binding, "r2_bucket");
    return { ...item, bucket_name: live.bucket_name };
  });
  if (config.analytics_engine_datasets)
    config.analytics_engine_datasets = config.analytics_engine_datasets.map((item) => {
      const live = oneBinding(bindings, item.binding, "analytics_engine");
      return { ...item, dataset: live.dataset };
    });
  if (config.ratelimits) config.ratelimits = config.ratelimits.map((item) => {
    const live = oneBinding(bindings, item.name, "ratelimit");
    return { ...item, namespace_id: String(live.namespace_id), simple: live.simple };
  });
  if (config.services) config.services = config.services.map((item) => {
    const live = oneBinding(bindings, item.binding, "service");
    if (live.environment !== undefined && live.environment !== "production")
      fail(`${worker.role} service binding ${item.binding} targets a nonproduction environment`);
    return { ...item, service: live.service, entrypoint: live.entrypoint };
  });
  const actualSecrets = sorted(bindings.filter(({ type }) => type === "secret_text")
    .map(({ name }) => name));
  if (!same(actualSecrets, sorted(config.secrets?.required ?? [])))
    fail(`${worker.role} secret-name inventory drift`);
  return config;
}

export function materializeProductionConfigurations({
  contract, bases, snapshots, accountId,
}) {
  if (!Array.isArray(bases) || bases.length !== 3 || !Array.isArray(snapshots) || snapshots.length !== 3)
    fail("exactly three production configuration snapshots are required");
  const configurations = contract.workers.map((worker, index) =>
    materializeProductionConfiguration({
      base: bases[index], worker, settingsEnvelope: snapshots[index].settings,
      subdomainEnvelope: snapshots[index].subdomain, accountId,
    }));
  validateTopology(contract, configurations, { production: true });
  for (const [index, config] of configurations.entries())
    if (Buffer.byteLength(JSON.stringify(config)) > 5 * 1024)
      fail(`${contract.workers[index].role} protected configuration exceeds the provider limit`);
  return configurations;
}

export function validateProductionControlPlane({ contract, configurations, snapshots, domains }) {
  const expectedDomains = contract.workers.flatMap((worker) =>
    worker.customDomains.map((hostname) => ({ hostname, service: worker.name })));
  const liveDomainRows = requireExhaustiveEnvelope(domains, "Custom Domain")
    .filter(({ service }) => contract.workers.some((worker) => worker.name === service));
  const actualDomains = liveDomainRows.map(({ hostname, service }) => ({ hostname, service }));
  if (!same(actualDomains.sort((a, b) => a.hostname.localeCompare(b.hostname)),
    expectedDomains.sort((a, b) => a.hostname.localeCompare(b.hostname))))
    fail("production Custom Domain inventory drift");
  const expectedZoneId = configurations[0]?.vars?.DIRECTORY_CACHE_ZONE_ID;
  if (liveDomainRows.some(({ zone_id: zoneId, zone_name: zoneName }) =>
    zoneId !== expectedZoneId || zoneName !== "atrinik.org"))
    fail("production Custom Domain zone authority drift");
  for (const [index, snapshot] of snapshots.entries()) {
    const expected = configurations[index].triggers?.crons ?? [];
    const schedules = requireEnvelope(snapshot.schedules, `${contract.workers[index].role} schedules`);
    const actual = (schedules.schedules ?? []).map(({ cron }) => cron);
    if (!same(sorted(actual), sorted(expected)))
      fail(`${contract.workers[index].role} schedule drift`);
    const routes = requireEnvelope(snapshot.routes, `${contract.workers[index].role} routes`);
    if (!Array.isArray(routes) || routes.length !== 0)
      fail(`${contract.workers[index].role} gained an alternate production route`);
    const scriptSettings = requireEnvelope(snapshot.scriptSettings,
      `${contract.workers[index].role} script settings`);
    if ((scriptSettings.tail_consumers ?? []).length !== 0 || scriptSettings.logpush === true)
      fail(`${contract.workers[index].role} gained an external log consumer`);
    const observability = requireEnvelope(snapshot.settings,
      `${contract.workers[index].role} settings`).observability;
    for (const channel of [observability?.logs, observability?.traces])
      if ((channel?.destinations ?? []).length !== 0)
        fail(`${contract.workers[index].role} gained an observability destination`);
    if (!same(observability, configurations[index].observability))
      fail(`${contract.workers[index].role} observability configuration drift`);
  }
}

export function validateProductionRuntimeProof({ contract, configurations, deployments,
  activeVersions, migrationEnvelope, migrationNames }) {
  if (!Array.isArray(deployments) || deployments.length !== contract.workers.length ||
      !Array.isArray(activeVersions) || activeVersions.length !== contract.workers.length)
    fail("production runtime proof inventory is incomplete");
  for (const [index, worker] of contract.workers.entries()) {
    const rows = requireEnvelope(deployments[index], `${worker.role} deployments`).deployments;
    const active = requireEnvelope(activeVersions[index], `${worker.role} active version`);
    const assigned = rows?.[0]?.versions ?? [];
    if (!Array.isArray(rows) || rows.length === 0 || assigned.length !== 1 ||
        assigned[0].percentage !== 100 || assigned[0].version_id !== active.id)
      fail(`${worker.role} active deployment is ambiguous`);
    const runtime = active.resources?.script_runtime ?? {};
    if (runtime.compatibility_date !== configurations[index].compatibility_date ||
        !same(runtime.compatibility_flags ?? [], configurations[index].compatibility_flags ?? []))
      fail(`${worker.role} active runtime configuration drift`);
    validateRemoteBindings(worker, configurations[index], active);
    validateRuntimeExports(worker, configurations[index], runtime.exports ?? {});
  }
  const queryResults = requireEnvelope(migrationEnvelope, "production migration ledger");
  if (!Array.isArray(queryResults) || queryResults.length !== 1 ||
      !Array.isArray(queryResults[0].results))
    fail("production migration ledger result is malformed");
  const liveRows = queryResults[0].results;
  for (const [index, row] of liveRows.entries())
    if (!same(sorted(Object.keys(row)), ["id", "name"]) ||
        row.id !== index + 1 || typeof row.name !== "string")
      fail("production migration ledger sequence is malformed");
  const liveNames = liveRows.map(({ name }) => name);
  if (!same(liveNames, migrationNames.slice(0, liveNames.length)) ||
      liveNames.length < migrationNames.length - 1 || liveNames.length > migrationNames.length)
    fail("production migration ledger is not an exact reviewed prefix");
  return { appliedMigrations: liveNames.length,
    pendingMigrations: migrationNames.slice(liveNames.length) };
}

async function checkedInInputs() {
  const production = JSON.parse(await readFile(productionPath, "utf8"));
  const review = JSON.parse(await readFile(reviewPath, "utf8"));
  const bases = await Promise.all([
    "wrangler.jsonc", "wrangler.publisher.jsonc", "wrangler.rendezvous.jsonc",
  ].map(async (path) => JSON.parse(await readFile(resolve(root, path), "utf8"))));
  const reviewBootstrapConfig = JSON.parse(await readFile(resolve(root,
    review.automaticReview.bootstrap.configPath), "utf8"));
  validateProductionContract(production);
  await validateReviewContract();
  return { production, review, bases, reviewBootstrapConfig };
}

export async function createPrivateDirectory(path) {
  if (!isAbsolute(path ?? "")) fail("private output directory must be absolute");
  if (resolve(path) !== path) fail("private output directory must be normalized");
  const parent = dirname(path);
  const canonicalParent = await realpath(parent).catch(() => null);
  if (canonicalParent !== parent) fail("private output parent must be canonical and symlink-free");
  try {
    await lstat(path);
    fail("private output directory already exists");
  } catch (error) {
    if (error instanceof WorkersBuildsProvisioningError) throw error;
    if (error?.code !== "ENOENT") fail("private output directory cannot be inspected");
  }
  await mkdir(path, { mode: 0o700 });
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    .catch(() => null);
  if (!handle) fail("private output directory cannot be pinned");
  try {
    const metadata = await handle.stat();
    if (!metadata.isDirectory() || !isCurrentUserOwned(metadata))
      fail("private output path is not an owner-controlled directory");
    await handle.chmod(0o700);
  } finally { await handle.close(); }
}

export async function readPrivateValue(path, label, pattern = null) {
  if (!isAbsolute(path ?? "")) fail(`${label} file path must be absolute`);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  if (!handle) fail(`${label} file cannot be opened without following links`);
  let value;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || !isCurrentUserOwned(metadata) ||
        (metadata.mode & 0o077) !== 0 ||
        metadata.size > maximumPrivateDocumentBytes)
      fail(`${label} file must be a bounded private regular file`);
    value = (await handle.readFile("utf8")).trim();
  } finally { await handle.close(); }
  if (!value || value.includes("\n") || (pattern && !pattern.test(value)))
    fail(`${label} file is malformed`);
  return value;
}

export async function readPrivateJson(path, label) {
  if (!isAbsolute(path ?? "")) fail(`${label} file path must be absolute`);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  if (!handle) fail(`${label} file cannot be opened without following links`);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || !isCurrentUserOwned(metadata) ||
        (metadata.mode & 0o077) !== 0 || metadata.size > maximumPrivateDocumentBytes)
      fail(`${label} file must be a bounded private regular file`);
    return JSON.parse(await handle.readFile("utf8"));
  } catch (error) {
    if (error instanceof WorkersBuildsProvisioningError) throw error;
    fail(`${label} file is malformed`);
  } finally { await handle.close(); }
}

async function writePrivateJson(path, value) {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT |
    constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.chmod(0o600);
  } finally { await handle.close(); }
}

export async function boundedResponseText(response, label) {
  if (!response.body) fail(`${label} returned an empty provider body`);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumProviderResponseBytes) {
        await reader.cancel();
        fail(`${label} exceeded the provider response limit`);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}

async function providerGet({ accountId, token, outputDirectory }, label, path) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`, {
    method: "GET", redirect: "error",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  let body;
  try { body = JSON.parse(await boundedResponseText(response, label)); }
  catch { fail(`${label} returned non-JSON provider data`); }
  await writePrivateJson(resolve(outputDirectory, `${label}.json`), body);
  if (!response.ok || body.success !== true) fail(`${label} provider readback failed`);
  return body;
}

async function providerPost({ accountId, token, outputDirectory }, label, path, requestBody) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`, {
    method: "POST", redirect: "error",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json",
      "Content-Type": "application/json" },
    body: JSON.stringify(requestBody), signal: AbortSignal.timeout(20_000),
  });
  let body;
  try { body = JSON.parse(await boundedResponseText(response, label)); }
  catch { fail(`${label} returned non-JSON provider data`); }
  await writePrivateJson(resolve(outputDirectory, `${label}.json`), body);
  if (!response.ok || body.success !== true) fail(`${label} provider readback failed`);
  return body;
}

export function combineProviderPages(envelopes, label, identity) {
  if (!Array.isArray(envelopes) || envelopes.length === 0 ||
      envelopes.length > maximumProviderPages)
    fail(`${label} provider pagination is unbounded`);
  const rows = [];
  const identities = new Set();
  let totalPages;
  let totalCount;
  for (const [index, envelope] of envelopes.entries()) {
    const pageRows = requireEnvelope(envelope, `${label} page ${index + 1}`);
    const info = envelope.result_info ?? {};
    if (!Array.isArray(pageRows) || !Number.isSafeInteger(info.page) ||
        !Number.isSafeInteger(info.total_pages) || !Number.isSafeInteger(info.total_count) ||
        info.page !== index + 1 || info.total_pages < 1 ||
        info.total_pages > maximumProviderPages || info.total_count < 0)
      fail(`${label} provider pagination metadata is malformed`);
    totalPages ??= info.total_pages;
    totalCount ??= info.total_count;
    if (info.total_pages !== totalPages || info.total_count !== totalCount ||
        envelopes.length !== totalPages)
      fail(`${label} provider pagination changed during readback`);
    for (const row of pageRows) {
      const key = identity(row);
      if (typeof key !== "string" || key.length === 0 || identities.has(key))
        fail(`${label} provider pagination identity is missing or duplicated`);
      identities.add(key);
      rows.push(row);
    }
  }
  if (rows.length !== totalCount) fail(`${label} provider pagination count drift`);
  return { success: true, result: rows, result_info: {
    page: 1, total_pages: 1, total_count: rows.length, exhaustive: true,
    source_total_pages: totalPages,
  } };
}

export function combineWorkerVersionPages(envelopes, label = "Worker versions") {
  if (!Array.isArray(envelopes)) fail(`${label} provider pagination is unbounded`);
  return combineProviderPages(envelopes.map((envelope, index) => {
    const result = requireEnvelope(envelope, `${label} page ${index + 1}`);
    if (!result || !Array.isArray(result.items))
      fail(`${label} provider version inventory is malformed`);
    return { ...envelope, result: result.items };
  }), label, ({ id }) => id);
}

export function validateStableProviderPasses(first, second, label) {
  const firstRows = requireExhaustiveEnvelope(first, `${label} first pass`);
  const secondRows = requireExhaustiveEnvelope(second, `${label} second pass`);
  if (!same(firstRows, secondRows))
    fail(`${label} provider inventory changed between complete passes`);
  return second;
}

async function providerGetPaginatedPass(context, label, path, identity, perPage) {
  const pages = [];
  for (let page = 1; page <= maximumProviderPages; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const envelope = await providerGet(context, `${label}.page-${page}`,
      `${path}${separator}page=${page}&per_page=${perPage}`);
    pages.push(envelope);
    const totalPages = envelope.result_info?.total_pages;
    if (!Number.isSafeInteger(totalPages) || totalPages < 1 ||
        totalPages > maximumProviderPages)
      fail(`${label} provider pagination metadata is malformed`);
    if (page === totalPages) {
      return combineProviderPages(pages, label, identity);
    }
    if (page > totalPages) fail(`${label} provider pagination changed during readback`);
  }
  fail(`${label} provider pagination exceeded its bound`);
}

async function providerGetPaginated(context, label, path, identity, perPage = 50) {
  const first = await providerGetPaginatedPass(context, `${label}.pass-1`, path, identity, perPage);
  const second = await providerGetPaginatedPass(context, `${label}.pass-2`, path, identity, perPage);
  validateStableProviderPasses(first, second, label);
  await writePrivateJson(resolve(context.outputDirectory, `${label}.json`), second);
  return second;
}

async function providerGetWorkerVersionsPass(context, label, path, perPage) {
  const pages = [];
  for (let page = 1; page <= maximumProviderPages; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const envelope = await providerGet(context, `${label}.page-${page}`,
      `${path}${separator}page=${page}&per_page=${perPage}`);
    pages.push(envelope);
    const totalPages = envelope.result_info?.total_pages;
    if (!Number.isSafeInteger(totalPages) || totalPages < 1 ||
        totalPages > maximumProviderPages)
      fail(`${label} provider pagination metadata is malformed`);
    if (page === totalPages) {
      return combineWorkerVersionPages(pages, label);
    }
    if (page > totalPages) fail(`${label} provider pagination changed during readback`);
  }
  fail(`${label} provider pagination exceeded its bound`);
}

async function providerGetWorkerVersions(context, label, path, perPage = 50) {
  const first = await providerGetWorkerVersionsPass(context, `${label}.pass-1`, path, perPage);
  const second = await providerGetWorkerVersionsPass(context, `${label}.pass-2`, path, perPage);
  validateStableProviderPasses(first, second, label);
  await writePrivateJson(resolve(context.outputDirectory, `${label}.json`), second);
  return second;
}

async function readProviderSnapshot({ accountId, token, productionReadToken, outputDirectory,
  production, review, sourceSha }) {
  const startedAt = new Date().toISOString();
  await createPrivateDirectory(outputDirectory);
  const context = { accountId, token, outputDirectory };
  const scriptsFirst = await providerGet(context, "scripts.pass-1", "/workers/scripts");
  const scripts = await providerGet(context, "scripts.pass-2", "/workers/scripts");
  if (!same(scriptsFirst.result, scripts.result))
    fail("account Worker inventory changed between complete passes");
  await writePrivateJson(resolve(outputDirectory, "scripts.json"), scripts);
  const scriptRows = requireEnvelope(scripts, "scripts");
  if (!Array.isArray(scriptRows) || scriptRows.length > 1000)
    fail("account Worker inventory is invalid or unbounded");
  const names = [...production.workers.map(({ name }) => name), review.automaticReview.project];
  let productionDatabaseId;
  for (const name of names) {
    const script = (scripts.result ?? []).find(({ id }) => id === name);
    if (!script) {
      if (name === review.automaticReview.project) {
        await writePrivateJson(resolve(outputDirectory, `${name}.absent.json`), {
          success: true, result: { absent: true },
        });
        continue;
      }
      fail(`required production Worker ${name} is absent`);
    }
    if (!scriptTagPattern.test(script.tag ?? "")) fail(`${name} script tag is malformed`);
    const settings = await providerGet(context, `${name}.settings`,
      `/workers/scripts/${encodeURIComponent(name)}/settings`);
    if (name === production.workers[0].name) {
      const database = (settings.result?.bindings ?? []).filter(({ name: binding, type }) =>
        binding === "DB" && type === "d1");
      if (database.length !== 1 || !uuidPattern.test(database[0].id ?? database[0].database_id ?? ""))
        fail("production D1 binding is missing or ambiguous");
      productionDatabaseId = database[0].id ?? database[0].database_id;
    }
    await providerGet(context, `${name}.subdomain`,
      `/workers/scripts/${encodeURIComponent(name)}/subdomain`);
    await providerGet(context, `${name}.schedules`,
      `/workers/scripts/${encodeURIComponent(name)}/schedules`);
    await providerGet(context, `${name}.routes`,
      `/workers/services/${encodeURIComponent(name)}/environments/production/routes?show_zonename=true`);
    await providerGet(context, `${name}.script-settings`,
      `/workers/scripts/${encodeURIComponent(name)}/script-settings`);
    const deployments = await providerGet(context, `${name}.deployments`,
      `/workers/scripts/${encodeURIComponent(name)}/deployments`);
    const deploymentRows = deployments.result?.deployments;
    const activeVersions = deploymentRows?.[0]?.versions ?? [];
    if (!Array.isArray(deploymentRows) || deploymentRows.length === 0 ||
        activeVersions.length !== 1 || activeVersions[0].percentage !== 100 ||
        !uuidPattern.test(activeVersions[0].version_id ?? ""))
      fail(`${name} does not have one unambiguous active version`);
    await providerGet(context, `${name}.active-version`,
      `/workers/scripts/${encodeURIComponent(name)}/versions/${encodeURIComponent(activeVersions[0].version_id)}`);
    await providerGetWorkerVersions(context, `${name}.versions`,
      `/workers/scripts/${encodeURIComponent(name)}/versions`);
    await providerGetPaginated(context, `${name}.deploy-hooks`,
      `/builds/workers/${encodeURIComponent(name)}/deploy_hooks`,
      ({ deploy_hook_uuid: id }) => id);
    const triggers = await providerGetPaginated(context, `${name}.triggers`,
      `/builds/workers/${encodeURIComponent(script.tag)}/triggers`,
      ({ trigger_uuid: id }) => id);
    await providerGetPaginated(context, `${name}.builds`,
      `/builds/workers/${encodeURIComponent(script.tag)}/builds`,
      ({ build_uuid: id }) => id, 200);
    for (const trigger of triggers.result ?? []) {
      if (!uuidPattern.test(trigger.trigger_uuid ?? "")) fail(`${name} trigger UUID is malformed`);
      await providerGet(context,
        `${name}.trigger-${trigger.trigger_uuid}.environment`,
        `/builds/triggers/${encodeURIComponent(trigger.trigger_uuid)}/environment_variables`);
    }
  }
  const collectAccountTriggers = async (pass) => {
    const rows = [];
    for (const [index, script] of scriptRows.entries()) {
      if (!scriptTagPattern.test(script.tag ?? "")) fail("account Worker tag is malformed");
      const triggerInventory = await providerGetPaginated(context,
        `account-trigger-pass-${pass}-script-${index}`,
        `/builds/workers/${encodeURIComponent(script.tag)}/triggers`,
        ({ trigger_uuid: id }) => id);
      rows.push(...triggerInventory.result);
    }
    return combineProviderPages([{
      success: true, result: rows,
      result_info: { page: 1, total_pages: 1, total_count: rows.length },
    }], `account triggers pass ${pass}`, ({ trigger_uuid: id }) => id);
  };
  const accountTriggersFirst = await collectAccountTriggers(1);
  const accountTriggers = await collectAccountTriggers(2);
  validateStableProviderPasses(accountTriggersFirst, accountTriggers, "account triggers");
  const scriptsFinal = await providerGet(context, "scripts.pass-final", "/workers/scripts");
  if (!same(scripts.result, scriptsFinal.result))
    fail("account Worker inventory changed during trigger aggregation");
  await writePrivateJson(resolve(outputDirectory, "account-triggers.json"), accountTriggers);
  await providerGetPaginated(context, "domains", "/workers/domains",
    ({ hostname, service }) => `${hostname}\0${service}`);
  await providerGetPaginated(context, "build-tokens", "/builds/tokens",
    ({ build_token_uuid: id }) => id);
  await providerGet(context, "build-limits", "/builds/account/limits");
  if (!productionDatabaseId) fail("production D1 database identity is unavailable");
  await providerPost({ accountId, token: productionReadToken, outputDirectory },
    "production-migrations", `/d1/database/${encodeURIComponent(productionDatabaseId)}/query`,
    { sql: "SELECT id, name FROM d1_migrations ORDER BY id", params: [] });
  await writePrivateJson(resolve(outputDirectory, "snapshot-manifest.json"), {
    accountId, sourceSha, startedAt, completedAt: new Date().toISOString(),
    productionContractSha256: digestJson(production), reviewContractSha256: digestJson(review),
  });
  return { outcome: "workers-builds-private-readback-complete", mutation: false,
    productionWorkers: production.workers.length,
    reviewBootstrapPresent: (scripts.result ?? []).some(({ id }) => id === review.automaticReview.project) };
}

export async function loadSnapshot(directory, name) {
  if (!isAbsolute(directory ?? "")) fail("private snapshot directory must be absolute");
  if (resolve(directory) !== directory || await realpath(directory).catch(() => null) !== directory)
    fail("private snapshot directory must be canonical and symlink-free");
  const metadata = await lstat(directory).catch(() => null);
  if (!metadata?.isDirectory() || !isCurrentUserOwned(metadata) ||
      (metadata.mode & 0o077) !== 0)
    fail("private snapshot directory must be private");
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/u.test(name))
    fail("private snapshot name must be a safe JSON basename");
  const path = resolve(directory, name);
  if (dirname(path) !== directory) fail("private snapshot escaped its directory");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  if (!handle) fail(`private snapshot ${name} is missing or linked`);
  try {
    const file = await handle.stat();
    if (!file.isFile() || !isCurrentUserOwned(file) ||
        (file.mode & 0o077) !== 0 || file.size > maximumProviderResponseBytes)
      fail(`private snapshot ${name} is not a bounded private regular file`);
    return JSON.parse(await handle.readFile("utf8"));
  } catch (error) {
    if (error instanceof WorkersBuildsProvisioningError) throw error;
    fail(`private snapshot ${name} is missing or malformed`);
  } finally { await handle.close(); }
}

async function materializeSnapshot({ snapshotDirectory, outputDirectory, accountId,
  production, review, bases, sourceSha }) {
  validateSnapshotManifest(await loadSnapshot(snapshotDirectory, "snapshot-manifest.json"),
    { accountId, sourceSha, production, review });
  const snapshots = await Promise.all(production.workers.map(async ({ name }) => ({
    settings: await loadSnapshot(snapshotDirectory, `${name}.settings.json`),
    subdomain: await loadSnapshot(snapshotDirectory, `${name}.subdomain.json`),
    schedules: await loadSnapshot(snapshotDirectory, `${name}.schedules.json`),
    routes: await loadSnapshot(snapshotDirectory, `${name}.routes.json`),
    scriptSettings: await loadSnapshot(snapshotDirectory, `${name}.script-settings.json`),
  })));
  const domains = await loadSnapshot(snapshotDirectory, "domains.json");
  const configurations = materializeProductionConfigurations({
    contract: production, bases, snapshots, accountId,
  });
  validateProductionControlPlane({ contract: production, configurations, snapshots, domains });
  const deployments = await Promise.all(production.workers.map(({ name }) =>
    loadSnapshot(snapshotDirectory, `${name}.deployments.json`)));
  const activeVersions = await Promise.all(production.workers.map(({ name }) =>
    loadSnapshot(snapshotDirectory, `${name}.active-version.json`)));
  const migrationEnvelope = await loadSnapshot(snapshotDirectory, "production-migrations.json");
  const migrationNames = (await readdir(resolve(root, "migrations")))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort();
  const runtime = validateProductionRuntimeProof({ contract: production, configurations,
    deployments, activeVersions, migrationEnvelope, migrationNames });
  await createPrivateDirectory(outputDirectory);
  const results = [];
  for (const [index, worker] of production.workers.entries()) {
    const bytes = Buffer.byteLength(JSON.stringify(configurations[index]));
    await writePrivateJson(resolve(outputDirectory, `${worker.role}.json`), configurations[index]);
    results.push({ role: worker.role, bytes });
  }
  return { outcome: "production-protected-documents-materialized", mutation: false, results,
    runtime };
}

async function validateConfiguredSnapshotDirectory({ snapshotDirectory, production, review,
  reviewBootstrapConfig, accountId, tokenAuthorityProofs, sourceSha }) {
  validateSnapshotManifest(await loadSnapshot(snapshotDirectory, "snapshot-manifest.json"),
    { accountId, sourceSha, production, review });
  const [core, publisher, rendezvous] = production.workers;
  const reviewProject = review.automaticReview.project;
  const scripts = await loadSnapshot(snapshotDirectory, "scripts.json");
  const buildTokens = await loadSnapshot(snapshotDirectory, "build-tokens.json");
  const productionTriggers = await loadSnapshot(snapshotDirectory, `${core.name}.triggers.json`);
  const reviewTriggers = await loadSnapshot(snapshotDirectory, `${reviewProject}.triggers.json`);
  const productionRows = requireEnvelope(productionTriggers, "production triggers");
  const reviewRows = requireEnvelope(reviewTriggers, "review triggers");
  if (!Array.isArray(productionRows) || productionRows.length !== 1 ||
      !Array.isArray(reviewRows) || reviewRows.length !== 1)
    fail("configured trigger inventory is not exactly one per Builds project");
  for (const trigger of [...productionRows, ...reviewRows])
    if (!uuidPattern.test(trigger.trigger_uuid ?? "")) fail("configured trigger UUID is malformed");
  const productionEnvironment = await loadSnapshot(snapshotDirectory,
    `${core.name}.trigger-${productionRows[0].trigger_uuid}.environment.json`);
  const reviewEnvironment = await loadSnapshot(snapshotDirectory,
    `${reviewProject}.trigger-${reviewRows[0].trigger_uuid}.environment.json`);
  const nonEntrypointTriggers = await Promise.all([publisher, rendezvous].map(async (worker) => [
    worker.role,
    await loadSnapshot(snapshotDirectory, `${worker.name}.triggers.json`),
  ]));
  const deployHooks = await Promise.all([...production.workers.map(({ role, name }) =>
    [role, name]), ["review", reviewProject]].map(async ([label, name]) => [
    label,
    await loadSnapshot(snapshotDirectory, `${name}.deploy-hooks.json`),
  ]));
  const accountTriggers = await loadSnapshot(snapshotDirectory, "account-triggers.json");
  const reviewBootstrapState = {
    settings: await loadSnapshot(snapshotDirectory, `${reviewProject}.settings.json`),
    subdomain: await loadSnapshot(snapshotDirectory, `${reviewProject}.subdomain.json`),
    schedules: await loadSnapshot(snapshotDirectory, `${reviewProject}.schedules.json`),
    routes: await loadSnapshot(snapshotDirectory, `${reviewProject}.routes.json`),
    scriptSettings: await loadSnapshot(snapshotDirectory, `${reviewProject}.script-settings.json`),
    deployments: await loadSnapshot(snapshotDirectory, `${reviewProject}.deployments.json`),
    versions: await loadSnapshot(snapshotDirectory, `${reviewProject}.versions.json`),
    activeVersion: await loadSnapshot(snapshotDirectory, `${reviewProject}.active-version.json`),
    builds: await loadSnapshot(snapshotDirectory, `${reviewProject}.builds.json`),
    buildLimits: await loadSnapshot(snapshotDirectory, "build-limits.json"),
    buildUsageProof: await readPrivateJson(process.env.ATRINIK_WORKERS_BUILDS_USAGE_PROOF_FILE,
      "Workers Builds usage proof"),
    uploadProof: await readPrivateJson(process.env.ATRINIK_REVIEW_BOOTSTRAP_UPLOAD_PROOF_FILE,
      "review bootstrap upload proof"),
  };
  return validateConfiguredBuildsSnapshot({
    production, review, scripts, productionTriggers, productionEnvironment,
    reviewTriggers, reviewEnvironment, nonEntrypointTriggers, deployHooks, buildTokens,
    accountTriggers, reviewBootstrapState, reviewBootstrapConfig,
    accountId, tokenAuthorityProofs, sourceSha,
  });
}

async function validateStagedSnapshotDirectory({ snapshotDirectory, production, review,
  reviewBootstrapConfig, accountId, tokenAuthorityProofs, sourceSha }) {
  validateSnapshotManifest(await loadSnapshot(snapshotDirectory, "snapshot-manifest.json"),
    { accountId, sourceSha, production, review });
  const core = production.workers[0];
  const reviewProject = review.automaticReview.project;
  const scripts = await loadSnapshot(snapshotDirectory, "scripts.json");
  const buildTokens = await loadSnapshot(snapshotDirectory, "build-tokens.json");
  const productionTriggers = await loadSnapshot(snapshotDirectory, `${core.name}.triggers.json`);
  const reviewTriggers = await loadSnapshot(snapshotDirectory, `${reviewProject}.triggers.json`);
  const productionRows = requireExhaustiveEnvelope(productionTriggers, "staged production triggers");
  const reviewRows = requireExhaustiveEnvelope(reviewTriggers, "staged review triggers");
  if (productionRows.length !== 1 || reviewRows.length !== 1)
    fail("staged trigger inventory is not exactly one per Builds project");
  for (const trigger of [...productionRows, ...reviewRows])
    if (!uuidPattern.test(trigger.trigger_uuid ?? "")) fail("staged trigger UUID is malformed");
  const productionEnvironment = await loadSnapshot(snapshotDirectory,
    `${core.name}.trigger-${productionRows[0].trigger_uuid}.environment.json`);
  const reviewEnvironment = await loadSnapshot(snapshotDirectory,
    `${reviewProject}.trigger-${reviewRows[0].trigger_uuid}.environment.json`);
  const deployHooks = await Promise.all([...production.workers.map(({ role, name }) =>
    [role, name]), ["review", reviewProject]].map(async ([label, name]) =>
    [label, await loadSnapshot(snapshotDirectory, `${name}.deploy-hooks.json`)]));
  const builds = await Promise.all([...production.workers.map(({ role, name }) => [role, name]),
    ["review", reviewProject]].map(async ([label, name]) =>
      [label, await loadSnapshot(snapshotDirectory, `${name}.builds.json`)]));
  const nonEntrypointTriggers = await Promise.all(production.workers.slice(1)
    .map(async ({ role, name }) =>
      [role, await loadSnapshot(snapshotDirectory, `${name}.triggers.json`)]));
  const reviewBootstrapState = {
    settings: await loadSnapshot(snapshotDirectory, `${reviewProject}.settings.json`),
    subdomain: await loadSnapshot(snapshotDirectory, `${reviewProject}.subdomain.json`),
    schedules: await loadSnapshot(snapshotDirectory, `${reviewProject}.schedules.json`),
    routes: await loadSnapshot(snapshotDirectory, `${reviewProject}.routes.json`),
    scriptSettings: await loadSnapshot(snapshotDirectory, `${reviewProject}.script-settings.json`),
    deployments: await loadSnapshot(snapshotDirectory, `${reviewProject}.deployments.json`),
    versions: await loadSnapshot(snapshotDirectory, `${reviewProject}.versions.json`),
    activeVersion: await loadSnapshot(snapshotDirectory, `${reviewProject}.active-version.json`),
    builds: await loadSnapshot(snapshotDirectory, `${reviewProject}.builds.json`),
    buildLimits: await loadSnapshot(snapshotDirectory, "build-limits.json"),
    buildUsageProof: await readPrivateJson(process.env.ATRINIK_WORKERS_BUILDS_USAGE_PROOF_FILE,
      "Workers Builds usage proof"),
    uploadProof: await readPrivateJson(process.env.ATRINIK_REVIEW_BOOTSTRAP_UPLOAD_PROOF_FILE,
      "review bootstrap upload proof"),
  };
  const branch = await readPrivateValue(process.env.ATRINIK_STAGING_SENTINEL_BRANCH_FILE,
    "staging sentinel branch", stagingBranchPattern);
  const sentinelProof = await readPrivateJson(process.env.ATRINIK_STAGING_SENTINEL_REFS_FILE,
    "staging sentinel refs");
  if (sentinelProof.branch !== branch) fail("staging sentinel proof branch drift");
  return validateStagedBuildsSnapshot({ production, review, scripts, productionTriggers,
    productionEnvironment, reviewTriggers, reviewEnvironment, nonEntrypointTriggers,
    deployHooks, builds, buildTokens,
    accountTriggers: await loadSnapshot(snapshotDirectory, "account-triggers.json"),
    reviewBootstrapState, reviewBootstrapConfig, accountId, tokenAuthorityProofs, sourceSha,
    sentinelProof });
}

async function validateFreshSnapshotDirectory({ snapshotDirectory, production, review,
  accountId, sourceSha }) {
  validateSnapshotManifest(await loadSnapshot(snapshotDirectory, "snapshot-manifest.json"),
    { accountId, sourceSha, production, review });
  const scripts = await loadSnapshot(snapshotDirectory, "scripts.json");
  const scriptRows = requireEnvelope(scripts, "scripts");
  if (!Array.isArray(scriptRows)) fail("script inventory is invalid");
  const projects = production.workers.map(({ role, name }) => [role, name]);
  const tagged = projects.map(([label, name]) => {
    const row = scriptRows.find(({ id }) => id === name);
    if (!row || !scriptTagPattern.test(row.tag ?? ""))
      fail(`${label} Builds script is missing or malformed`);
    return [label, name];
  });
  const triggers = await Promise.all(tagged.map(async ([label, name]) =>
    [label, await loadSnapshot(snapshotDirectory, `${name}.triggers.json`)]));
  const deployHooks = await Promise.all(tagged.map(async ([label, name]) =>
    [label, await loadSnapshot(snapshotDirectory, `${name}.deploy-hooks.json`)]));
  const builds = await Promise.all(tagged.map(async ([label, name]) =>
    [label, await loadSnapshot(snapshotDirectory, `${name}.builds.json`)]));
  const buildTokens = await loadSnapshot(snapshotDirectory, "build-tokens.json");
  const accountTriggers = await loadSnapshot(snapshotDirectory, "account-triggers.json");
  const branch = await readPrivateValue(process.env.ATRINIK_STAGING_SENTINEL_BRANCH_FILE,
    "staging sentinel branch", stagingBranchPattern);
  const sentinelProof = await readPrivateJson(process.env.ATRINIK_STAGING_SENTINEL_REFS_FILE,
    "staging sentinel refs");
  if (sentinelProof.branch !== branch) fail("staging sentinel proof branch drift");
  const repositoryConnectionProof = await readPrivateJson(
    process.env.ATRINIK_REPOSITORY_CONNECTION_OWNER_PROOF_FILE,
    "shared repository connection owner proof");
  return validateFreshBuildsSnapshot({
    production, review, scripts, triggers, deployHooks, builds, buildTokens,
    accountTriggers,
    sentinelProof, repositoryConnectionProof, accountId,
    sourceSha,
  });
}

export async function validateCheckedInProvisioning() {
  const { production, review, reviewBootstrapConfig } = await checkedInInputs();
  const id = "11111111-1111-4111-8111-111111111111";
  const tag = "1".repeat(32);
  productionTriggerSpec(production, {
    externalScriptId: tag, repositoryConnectionUuid: id, buildTokenUuid: id,
  });
  automaticReviewTriggerSpec(review, {
    externalScriptId: tag, repositoryConnectionUuid: id, buildTokenUuid: id,
  });
  automaticReviewEnvironmentSpec(review);
  provisioningSetupPlan(production, review);
  return { production, review, reviewBootstrapConfig };
}

async function main() {
  const mode = process.argv[2] ?? "--validate-only";
  const { production, review, reviewBootstrapConfig } = await validateCheckedInProvisioning();
  if (mode === "--validate-only") {
    process.stdout.write(`${JSON.stringify({ outcome: "workers-builds-provisioning-valid" })}\n`);
    return;
  }
  if (mode === "--dry-run") {
    const setupPlan = provisioningSetupPlan(production, review);
    process.stdout.write(`${JSON.stringify({
      outcome: "workers-builds-provisioning-plan-valid", mutation: false,
      production: { project: production.workers[0].name, branch: production.productionBranch,
        triggerCount: 1, protectedInputCount: Object.keys(production.protectedInputs).length },
      automaticReview: { project: review.automaticReview.project, triggerCount: 1,
        protectedInputCount: review.automaticReview.protectedInputs.length },
      setupOperationCount: setupPlan.setupOperations.length,
      rollbackOperationCount: setupPlan.rollbackOperations.length,
      gates: ["provider-setup-approval", "migration-0010", "initial-production-proof"],
    })}\n`);
    return;
  }
  if (mode === "--plan-setup") {
    process.stdout.write(`${JSON.stringify(provisioningSetupPlan(production, review))}\n`);
    return;
  }
  if (mode === "--readback") {
    const accountId = await readPrivateValue(process.env.ATRINIK_CLOUDFLARE_ACCOUNT_ID_FILE,
      "Cloudflare account ID", accountIdPattern);
    const token = await readPrivateValue(process.env.ATRINIK_WORKERS_BUILDS_API_TOKEN_FILE,
      "Workers Builds API token");
    const productionReadToken = await readPrivateValue(
      process.env.ATRINIK_PRODUCTION_BUILD_TOKEN_SECRET_FILE,
      "production D1 read API token");
    const sourceSha = await readPrivateValue(process.env.ATRINIK_REVIEWED_SOURCE_SHA_FILE,
      "reviewed source SHA", gitShaPattern);
    const outputDirectory = process.env.ATRINIK_PROVIDER_SNAPSHOT_OUTPUT;
    process.stdout.write(`${JSON.stringify(await readProviderSnapshot({
      accountId, token, productionReadToken, outputDirectory, production, review, sourceSha,
    }))}\n`);
    return;
  }
  if (mode === "--materialize-production") {
    const accountId = await readPrivateValue(process.env.ATRINIK_CLOUDFLARE_ACCOUNT_ID_FILE,
      "Cloudflare account ID", accountIdPattern);
    const { bases } = await checkedInInputs();
    const sourceSha = await readPrivateValue(process.env.ATRINIK_REVIEWED_SOURCE_SHA_FILE,
      "reviewed source SHA", gitShaPattern);
    process.stdout.write(`${JSON.stringify(await materializeSnapshot({
      snapshotDirectory: process.env.ATRINIK_PROVIDER_SNAPSHOT_DIRECTORY,
      outputDirectory: process.env.ATRINIK_PRODUCTION_CONFIG_OUTPUT,
      accountId, production, review, bases, sourceSha,
    }))}\n`);
    return;
  }
  if (mode === "--verify-preflight") {
    const accountId = await readPrivateValue(process.env.ATRINIK_CLOUDFLARE_ACCOUNT_ID_FILE,
      "Cloudflare account ID", accountIdPattern);
    const sourceSha = await readPrivateValue(process.env.ATRINIK_REVIEWED_SOURCE_SHA_FILE,
      "reviewed source SHA", gitShaPattern);
    process.stdout.write(`${JSON.stringify(await validateFreshSnapshotDirectory({
      snapshotDirectory: process.env.ATRINIK_PROVIDER_SNAPSHOT_DIRECTORY,
      production, review, accountId, sourceSha,
    }))}\n`);
    return;
  }
  if (mode === "--verify-staged") {
    const accountId = await readPrivateValue(process.env.ATRINIK_CLOUDFLARE_ACCOUNT_ID_FILE,
      "Cloudflare account ID", accountIdPattern);
    const tokenAuthorityProofs = [
      await readPrivateJson(process.env.ATRINIK_PRODUCTION_BUILD_TOKEN_PERMISSION_PROOF_FILE,
        "production build token permission proof"),
      await readPrivateJson(process.env.ATRINIK_REVIEW_BUILD_TOKEN_PERMISSION_PROOF_FILE,
        "review build token permission proof"),
    ];
    const sourceSha = await readPrivateValue(process.env.ATRINIK_REVIEWED_SOURCE_SHA_FILE,
      "reviewed source SHA", gitShaPattern);
    process.stdout.write(`${JSON.stringify(await validateStagedSnapshotDirectory({
      snapshotDirectory: process.env.ATRINIK_PROVIDER_SNAPSHOT_DIRECTORY,
      production, review, reviewBootstrapConfig, accountId, tokenAuthorityProofs, sourceSha,
    }))}\n`);
    return;
  }
  if (mode === "--verify-configured") {
    const accountId = await readPrivateValue(process.env.ATRINIK_CLOUDFLARE_ACCOUNT_ID_FILE,
      "Cloudflare account ID", accountIdPattern);
    const tokenAuthorityProofs = [
      await readPrivateJson(process.env.ATRINIK_PRODUCTION_BUILD_TOKEN_PERMISSION_PROOF_FILE,
        "production build token permission proof"),
      await readPrivateJson(process.env.ATRINIK_REVIEW_BUILD_TOKEN_PERMISSION_PROOF_FILE,
        "review build token permission proof"),
    ];
    const sourceSha = await readPrivateValue(process.env.ATRINIK_REVIEWED_SOURCE_SHA_FILE,
      "reviewed source SHA", gitShaPattern);
    process.stdout.write(`${JSON.stringify(await validateConfiguredSnapshotDirectory({
      snapshotDirectory: process.env.ATRINIK_PROVIDER_SNAPSHOT_DIRECTORY,
      production, review, reviewBootstrapConfig, accountId, tokenAuthorityProofs, sourceSha,
    }))}\n`);
    return;
  }
  fail("unknown Workers Builds provisioning mode");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    const reason = error instanceof WorkersBuildsProvisioningError
      ? error.message : "unexpected-internal-error";
    process.stderr.write(`${JSON.stringify({ outcome: "workers-builds-provisioning-stopped", reason })}\n`);
    process.exitCode = 1;
  });
