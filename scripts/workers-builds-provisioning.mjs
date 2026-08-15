import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateBuildEnvironment,
  validateContract as validateProductionContract,
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
const githubRepository = Object.freeze({
  provider_account_id: "6371603",
  provider_account_name: "atrinik",
  provider_type: "github",
  repo_id: "1324297032",
  repo_name: "metaserver-worker",
});

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

function normalizedRoot(value) {
  return value === "/" ? "" : value;
}

function oneBinding(bindings, name, type) {
  const matches = bindings.filter((value) => value.name === name && value.type === type);
  if (matches.length !== 1) fail(`${type} binding ${name} is missing or ambiguous`);
  return matches[0];
}

function requireEnvelope(value, label) {
  if (!value || value.success !== true || !value.result)
    fail(`${label} provider readback failed`);
  return value.result;
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
  const sentinel = review.automaticReview.productionBranch;
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
  return {
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
      "ATRINIK_WORKERS_BUILDS_API_TOKEN_FILE",
      "ATRINIK_PRODUCTION_BUILD_TOKEN_SECRET_FILE",
      "ATRINIK_PRODUCTION_BUILD_TOKEN_ID_FILE",
      "ATRINIK_REVIEW_BUILD_TOKEN_SECRET_FILE",
      "ATRINIK_REVIEW_BUILD_TOKEN_ID_FILE",
      "ATRINIK_PRODUCTION_CORE_CONFIG_FILE",
      "ATRINIK_PRODUCTION_PUBLISHER_CONFIG_FILE",
      "ATRINIK_PRODUCTION_RENDEZVOUS_CONFIG_FILE",
      "ATRINIK_PRODUCTION_LEASE_TOKEN_FILE",
    ],
    credentialAuthority: {
      controlPlaneOperator: {
        tokenType: review.automaticReview.controlPlaneOperator.tokenType,
        permission: review.automaticReview.controlPlaneOperator.permission,
        credentialBuildReadable: false,
      },
      productionBuildToken: {
        accountPermissions: ["Workers Scripts:Edit", "D1:Read"],
        purpose: "read-exact-worker-config-and-migration-ledger-deploy-three-workers",
        forbiddenAuthority: ["D1:Edit", "DNS", "WAF", "Account Administration",
          "Secrets:Read", "destructive-resource-authority"],
      },
      productionLeaseToken: {
        accountPermissions: ["Workers CI Write"],
        purpose: "read-trigger-and-build-inventory-cancel-only-competing-main-builds",
      },
      reviewBuildToken: structuredClone(review.automaticReview.tokenAuthority),
    },
    setupOperations: [
      { id: "preflight", actor: "workers-builds-control-plane-operator",
        action: "require-exact-private-readback-no-competing-trigger-and-sentinel-branch-absence",
        mutation: false },
      { id: "production-script", actor: "workers-builds-control-plane-operator",
        action: "select-exact-existing-production-script-tag", mutation: false,
        expected: { worker: production.workers[0].name } },
      { id: "review-bootstrap", actor: "issue-56-review-check-bootstrap-operator",
        action: "upload-exact-inert-review-worker", mutation: true,
        config: review.automaticReview.bootstrap.configPath,
        expected: { worker: review.automaticReview.project, retainedVersions: 1,
          workersDev: false, previewUrls: false, bindings: [], routes: [] } },
      { id: "repository-connection", actor: "workers-builds-control-plane-operator",
        action: "put-repository-connection", mutation: true,
        request: { method: "PUT", path: "/builds/repos/connections",
          body: structuredClone(githubRepository) } },
      { id: "production-build-token", actor: "workers-builds-control-plane-operator",
        action: "post-build-token", mutation: true,
        request: { method: "POST", path: "/builds/tokens", body: {
          build_token_name: "Atrinik metaserver production",
          build_token_secret: privateFileReference("ATRINIK_PRODUCTION_BUILD_TOKEN_SECRET_FILE"),
          cloudflare_token_id: privateFileReference("ATRINIK_PRODUCTION_BUILD_TOKEN_ID_FILE"),
        } } },
      { id: "review-build-token", actor: "workers-builds-control-plane-operator",
        action: "post-build-token", mutation: true,
        request: { method: "POST", path: "/builds/tokens", body: {
          build_token_name: "Atrinik metaserver review check",
          build_token_secret: privateFileReference("ATRINIK_REVIEW_BUILD_TOKEN_SECRET_FILE"),
          cloudflare_token_id: privateFileReference("ATRINIK_REVIEW_BUILD_TOKEN_ID_FILE"),
        } } },
      { id: "production-trigger-staged", actor: "workers-builds-control-plane-operator",
        action: "post-inert-trigger", mutation: true,
        request: { method: "POST", path: "/builds/triggers",
          body: triggerPlanSpec(productionStaged, "production-script",
            "production-build-token") } },
      { id: "production-environment", actor: "workers-builds-control-plane-operator",
        action: "patch-exact-environment", mutation: true,
        request: { method: "PATCH",
          path: resultReference("production-trigger-staged", "environment_variables_path"),
          body: productionEnvironmentPlan(production) } },
      { id: "review-trigger-staged", actor: "workers-builds-control-plane-operator",
        action: "post-inert-trigger", mutation: true,
        request: { method: "POST", path: "/builds/triggers",
          body: triggerPlanSpec(reviewStaged, "review-bootstrap", "review-build-token") } },
      { id: "review-environment", actor: "workers-builds-control-plane-operator",
        action: "patch-exact-environment", mutation: true,
        request: { method: "PATCH",
          path: resultReference("review-trigger-staged", "environment_variables_path"),
          body: Object.fromEntries(Object.entries(automaticReviewEnvironmentSpec(review))
            .map(([name, value]) => [name, { is_secret: value.is_secret,
              valueSource: { literal: value.value } }])) } },
      { id: "staged-readback", actor: "workers-builds-control-plane-operator",
        action: "prove-both-inert-triggers-environments-tokens-and-no-deploy-hooks",
        mutation: false },
    ],
    reviewActivation: {
      gate: "review-trigger-activation-and-proof",
      request: { method: "PUT",
        path: resultReference("review-trigger-staged", "trigger_path"),
        body: triggerPlanSpec(reviewFinal, "review-bootstrap", "review-build-token") },
      proof: "disposable-same-repository-non-main-build-only-branch",
    },
    productionActivation: {
      gate: "production-trigger-activation",
      request: { method: "PUT",
        path: resultReference("production-trigger-staged", "trigger_path"),
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
      "delete-the-recorded-metaserver-repository-connection",
      "delete-review-bootstrap-only-after-trigger-absence-and-exact-version-readback",
      "prove-three-production-workers-and-website-app-selection-unchanged",
    ],
  };
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
  const hooks = requireEnvelope(envelope, `${label} deploy hooks`);
  if (!Array.isArray(hooks) || hooks.length !== 0)
    fail(`${label} gained a Deploy Hook`);
}

function exactLabeledInventories(actual, expectedLabels, label) {
  if (!Array.isArray(actual) || actual.some((entry) =>
    !Array.isArray(entry) || entry.length !== 2) ||
      !same(sorted(actual.map(([name]) => name)), sorted(expectedLabels)))
    fail(`${label} inventory is incomplete or ambiguous`);
  return actual;
}

export function validateBuildTokenInventory(envelope, expectedUuids) {
  const tokens = requireEnvelope(envelope, "build tokens");
  if (!Array.isArray(tokens)) fail("build token inventory is invalid");
  for (const uuid of expectedUuids) {
    const matches = tokens.filter(({ build_token_uuid: candidate }) => candidate === uuid);
    if (matches.length !== 1) fail("configured build token is missing or ambiguous");
    const token = matches[0];
    if (
      token.owner_type !== "user" ||
      typeof token.build_token_name !== "string" || !token.build_token_name.trim() ||
      typeof token.cloudflare_token_id !== "string" || !token.cloudflare_token_id.trim()
    ) fail("configured build token authority is malformed");
  }
}

export function validateConfiguredBuildsSnapshot({ production, review, scripts,
  productionTriggers, productionEnvironment, reviewTriggers, reviewEnvironment,
  nonEntrypointTriggers, deployHooks, buildTokens }) {
  const scriptRows = requireEnvelope(scripts, "scripts");
  if (!Array.isArray(scriptRows)) fail("script inventory is invalid");
  const productionScript = scriptRows.find(({ id }) => id === production.workers[0].name);
  const reviewScript = scriptRows.find(({ id }) => id === review.automaticReview.project);
  if (!scriptTagPattern.test(productionScript?.tag ?? "") ||
      !scriptTagPattern.test(reviewScript?.tag ?? ""))
    fail("configured Builds scripts are missing or malformed");
  if (productionScript.tag === reviewScript.tag)
    fail("production and review Builds projects share one script tag");
  const productionRows = requireEnvelope(productionTriggers, "production triggers");
  const reviewRows = requireEnvelope(reviewTriggers, "review triggers");
  if (!Array.isArray(productionRows) || productionRows.length !== 1 ||
      !Array.isArray(reviewRows) || reviewRows.length !== 1)
    fail("configured trigger inventory is not exactly one per Builds project");
  for (const [label, envelope] of exactLabeledInventories(nonEntrypointTriggers,
    production.workers.slice(1).map(({ role }) => role), "non-entrypoint trigger")) {
    const rows = requireEnvelope(envelope, `${label} triggers`);
    if (!Array.isArray(rows) || rows.length !== 0)
      fail(`${label} gained an independent Builds trigger`);
  }
  const productionActual = productionRows[0];
  const reviewActual = reviewRows[0];
  if (productionActual.trigger_uuid === reviewActual.trigger_uuid ||
      productionActual.build_token_uuid === reviewActual.build_token_uuid)
    fail("production and review trigger/token identities are not isolated");
  validateBuildTokenInventory(buildTokens, [productionActual.build_token_uuid,
    reviewActual.build_token_uuid]);
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
  config.account_id = accountId;
  config.workers_dev = false;
  config.preview_urls = false;
  config.routes = worker.customDomains.map((pattern) => ({ pattern, custom_domain: true }));
  if (Object.hasOwn(config.vars ?? {}, "DIRECTORY_CACHE_ZONE_ID")) {
    const live = oneBinding(bindings, "DIRECTORY_CACHE_ZONE_ID", "plain_text");
    config.vars.DIRECTORY_CACHE_ZONE_ID = live.text;
  }
  if (config.d1_databases) config.d1_databases = config.d1_databases.map((item) => {
    const live = oneBinding(bindings, item.binding, "d1");
    return { ...item, database_id: live.id ?? live.database_id };
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
  const actualDomains = (requireEnvelope(domains, "Custom Domain") ?? [])
    .filter(({ service }) => contract.workers.some((worker) => worker.name === service))
    .map(({ hostname, service }) => ({ hostname, service }));
  if (!same(actualDomains.sort((a, b) => a.hostname.localeCompare(b.hostname)),
    expectedDomains.sort((a, b) => a.hostname.localeCompare(b.hostname))))
    fail("production Custom Domain inventory drift");
  for (const [index, snapshot] of snapshots.entries()) {
    const expected = configurations[index].triggers?.crons ?? [];
    const schedules = requireEnvelope(snapshot.schedules, `${contract.workers[index].role} schedules`);
    const actual = (schedules.schedules ?? []).map(({ cron }) => cron);
    if (!same(sorted(actual), sorted(expected)))
      fail(`${contract.workers[index].role} schedule drift`);
    const scriptSettings = requireEnvelope(snapshot.scriptSettings,
      `${contract.workers[index].role} script settings`);
    if ((scriptSettings.tail_consumers ?? []).length !== 0 || scriptSettings.logpush === true)
      fail(`${contract.workers[index].role} gained an external log consumer`);
    const observability = requireEnvelope(snapshot.settings,
      `${contract.workers[index].role} settings`).observability;
    for (const channel of [observability?.logs, observability?.traces])
      if ((channel?.destinations ?? []).length !== 0)
        fail(`${contract.workers[index].role} gained an observability destination`);
  }
}

async function checkedInInputs() {
  const production = JSON.parse(await readFile(productionPath, "utf8"));
  const review = JSON.parse(await readFile(reviewPath, "utf8"));
  const bases = await Promise.all([
    "wrangler.jsonc", "wrangler.publisher.jsonc", "wrangler.rendezvous.jsonc",
  ].map(async (path) => JSON.parse(await readFile(resolve(root, path), "utf8"))));
  validateProductionContract(production);
  await validateReviewContract();
  return { production, review, bases };
}

async function createPrivateDirectory(path) {
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
    if (!metadata.isDirectory()) fail("private output path is not a directory");
    await handle.chmod(0o700);
  } finally { await handle.close(); }
}

async function readPrivateValue(path, label, pattern = null) {
  if (!isAbsolute(path ?? "")) fail(`${label} file path must be absolute`);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  if (!handle) fail(`${label} file cannot be opened without following links`);
  let value;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0 ||
        metadata.size > maximumPrivateDocumentBytes)
      fail(`${label} file must be a bounded private regular file`);
    value = (await handle.readFile("utf8")).trim();
  } finally { await handle.close(); }
  if (!value || value.includes("\n") || (pattern && !pattern.test(value)))
    fail(`${label} file is malformed`);
  return value;
}

async function writePrivateJson(path, value) {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT |
    constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.chmod(0o600);
  } finally { await handle.close(); }
}

async function boundedResponseText(response, label) {
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

async function readProviderSnapshot({ accountId, token, outputDirectory, production, review }) {
  await createPrivateDirectory(outputDirectory);
  const scripts = await providerGet({ accountId, token, outputDirectory }, "scripts", "/workers/scripts");
  const names = [...production.workers.map(({ name }) => name), review.automaticReview.project];
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
    await providerGet({ accountId, token, outputDirectory }, `${name}.settings`,
      `/workers/scripts/${encodeURIComponent(name)}/settings`);
    await providerGet({ accountId, token, outputDirectory }, `${name}.subdomain`,
      `/workers/scripts/${encodeURIComponent(name)}/subdomain`);
    await providerGet({ accountId, token, outputDirectory }, `${name}.schedules`,
      `/workers/scripts/${encodeURIComponent(name)}/schedules`);
    await providerGet({ accountId, token, outputDirectory }, `${name}.script-settings`,
      `/workers/scripts/${encodeURIComponent(name)}/script-settings`);
    await providerGet({ accountId, token, outputDirectory }, `${name}.deployments`,
      `/workers/scripts/${encodeURIComponent(name)}/deployments`);
    await providerGet({ accountId, token, outputDirectory }, `${name}.versions`,
      `/workers/scripts/${encodeURIComponent(name)}/versions?per_page=20`);
    await providerGet({ accountId, token, outputDirectory }, `${name}.deploy-hooks`,
      `/builds/workers/${encodeURIComponent(name)}/deploy_hooks`);
    const triggers = await providerGet({ accountId, token, outputDirectory }, `${name}.triggers`,
      `/builds/workers/${encodeURIComponent(script.tag)}/triggers`);
    for (const trigger of triggers.result ?? []) {
      if (!uuidPattern.test(trigger.trigger_uuid ?? "")) fail(`${name} trigger UUID is malformed`);
      await providerGet({ accountId, token, outputDirectory },
        `${name}.trigger-${trigger.trigger_uuid}.environment`,
        `/builds/triggers/${encodeURIComponent(trigger.trigger_uuid)}/environment_variables`);
    }
  }
  await providerGet({ accountId, token, outputDirectory }, "domains", "/workers/domains");
  await providerGet({ accountId, token, outputDirectory }, "build-tokens",
    "/builds/tokens?per_page=200");
  await providerGet({ accountId, token, outputDirectory }, "build-limits", "/builds/account/limits");
  return { outcome: "workers-builds-private-readback-complete", mutation: false,
    productionWorkers: production.workers.length,
    reviewBootstrapPresent: (scripts.result ?? []).some(({ id }) => id === review.automaticReview.project) };
}

async function loadSnapshot(directory, name) {
  if (!isAbsolute(directory ?? "")) fail("private snapshot directory must be absolute");
  if (resolve(directory) !== directory || await realpath(directory).catch(() => null) !== directory)
    fail("private snapshot directory must be canonical and symlink-free");
  const metadata = await lstat(directory).catch(() => null);
  if (!metadata?.isDirectory() || (metadata.mode & 0o077) !== 0)
    fail("private snapshot directory must be private");
  const path = resolve(directory, name);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  if (!handle) fail(`private snapshot ${name} is missing or linked`);
  try {
    const file = await handle.stat();
    if (!file.isFile() || (file.mode & 0o077) !== 0 || file.size > maximumProviderResponseBytes)
      fail(`private snapshot ${name} is not a bounded private regular file`);
    return JSON.parse(await handle.readFile("utf8"));
  } catch (error) {
    if (error instanceof WorkersBuildsProvisioningError) throw error;
    fail(`private snapshot ${name} is missing or malformed`);
  } finally { await handle.close(); }
}

async function materializeSnapshot({ snapshotDirectory, outputDirectory, accountId,
  production, bases }) {
  const snapshots = await Promise.all(production.workers.map(async ({ name }) => ({
    settings: await loadSnapshot(snapshotDirectory, `${name}.settings.json`),
    subdomain: await loadSnapshot(snapshotDirectory, `${name}.subdomain.json`),
    schedules: await loadSnapshot(snapshotDirectory, `${name}.schedules.json`),
    scriptSettings: await loadSnapshot(snapshotDirectory, `${name}.script-settings.json`),
  })));
  const domains = await loadSnapshot(snapshotDirectory, "domains.json");
  const configurations = materializeProductionConfigurations({
    contract: production, bases, snapshots, accountId,
  });
  validateProductionControlPlane({ contract: production, configurations, snapshots, domains });
  await createPrivateDirectory(outputDirectory);
  const results = [];
  for (const [index, worker] of production.workers.entries()) {
    const bytes = Buffer.byteLength(JSON.stringify(configurations[index]));
    await writePrivateJson(resolve(outputDirectory, `${worker.role}.json`), configurations[index]);
    results.push({ role: worker.role, bytes });
  }
  return { outcome: "production-protected-documents-materialized", mutation: false, results };
}

async function validateConfiguredSnapshotDirectory({ snapshotDirectory, production, review }) {
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
  return validateConfiguredBuildsSnapshot({
    production, review, scripts, productionTriggers, productionEnvironment,
    reviewTriggers, reviewEnvironment, nonEntrypointTriggers, deployHooks, buildTokens,
  });
}

export async function validateCheckedInProvisioning() {
  const { production, review } = await checkedInInputs();
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
  return { production, review };
}

async function main() {
  const mode = process.argv[2] ?? "--validate-only";
  const { production, review } = await validateCheckedInProvisioning();
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
    const outputDirectory = process.env.ATRINIK_PROVIDER_SNAPSHOT_OUTPUT;
    process.stdout.write(`${JSON.stringify(await readProviderSnapshot({
      accountId, token, outputDirectory, production, review,
    }))}\n`);
    return;
  }
  if (mode === "--materialize-production") {
    const accountId = await readPrivateValue(process.env.ATRINIK_CLOUDFLARE_ACCOUNT_ID_FILE,
      "Cloudflare account ID", accountIdPattern);
    const { bases } = await checkedInInputs();
    process.stdout.write(`${JSON.stringify(await materializeSnapshot({
      snapshotDirectory: process.env.ATRINIK_PROVIDER_SNAPSHOT_DIRECTORY,
      outputDirectory: process.env.ATRINIK_PRODUCTION_CONFIG_OUTPUT,
      accountId, production, bases,
    }))}\n`);
    return;
  }
  if (mode === "--verify-configured") {
    process.stdout.write(`${JSON.stringify(await validateConfiguredSnapshotDirectory({
      snapshotDirectory: process.env.ATRINIK_PROVIDER_SNAPSHOT_DIRECTORY,
      production, review,
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
