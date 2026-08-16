import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contractPath = resolve(root, "deployment/workers-builds-review.json");
const productionContractPath = resolve(root, "deployment/workers-builds-production.json");
const shaPattern = /^[0-9a-f]{40}$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const runUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const safeBranchPattern = /^(?!main$)(?!review-build-only-sentinel$)[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u;
const branchCheckStages = [
  "types:generate", "types:check", "typecheck", "test", "test:admin",
  "test:deployment", "test:review", "deploy:dry-run", "deploy:dry-run:review-check", "test:service-bindings",
  "deploy:production:validate", "review:validate",
];

export class ReviewEnvironmentError extends Error {}

function fail(message) {
  throw new ReviewEnvironmentError(message);
}

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function sameValues(actual, expected) {
  return JSON.stringify(sorted(actual)) === JSON.stringify(sorted(expected));
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${label} must be an object`);
  if (!sameValues(Object.keys(value), expected))
    fail(`${label} has unexpected or missing fields`);
}

function exactArray(actual, expected, label) {
  if (!Array.isArray(actual) || JSON.stringify(actual) !== JSON.stringify(expected))
    fail(`${label} drift`);
}

function exactValue(actual, expected, label) {
  if (actual !== expected) fail(`${label} drift`);
}

function unique(values, label) {
  if (new Set(values).size !== values.length) fail(`${label} must be unique`);
}

function allStrings(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(allStrings);
  if (value && typeof value === "object") return Object.values(value).flatMap(allStrings);
  return [];
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    fail(`cannot parse ${path}`);
  }
}

function stripJsonc(text) {
  let output = "";
  let string = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (string) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') string = false;
    } else if (character === '"') {
      string = true;
      output += character;
    } else if (character === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      output += "\n";
    } else if (character === "/" && next === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index += 1;
      index += 1;
    } else output += character;
  }
  return output.replace(/,(\s*[}\]])/gu, "$1");
}

async function readJsonc(path) {
  try {
    return JSON.parse(stripJsonc(await readFile(path, "utf8")));
  } catch {
    fail(`cannot parse ${path}`);
  }
}

export function validateAutomaticReview(value) {
  exactKeys(value, [
    "accountBoundary", "project", "rootDirectory", "productionBranch", "productionAutomaticPush",
    "productionDeployCommand", "previewBranchIncludes", "previewBranchExcludes",
    "pathIncludes", "pathExcludes", "buildCommand", "deployCommand",
    "providerBuildTimeoutMinutes", "checkCommandTimeoutMinutes", "buildEnvironment", "protectedInputs", "bindings", "routes", "bootstrap", "costPolicy", "result", "forkPolicy",
    "tokenAuthority", "controlPlaneOperator",
  ], "automatic review");
  exactKeys(value.accountBoundary, [
    "mode", "productionAccountReuse", "liveCanaryAccountReuse", "githubAccountConnections",
    "repositoryConnectionReuse", "connectedWorker", "buildIdentityProductionProjectSettingsReachable",
    "trustedOperatorProductionBuildsControlPlaneReach",
  ], "review account boundary");
  exactValue(value.accountBoundary.mode, "production-account-dedicated-zero-resource-project", "review account mode");
  exactValue(value.accountBoundary.productionAccountReuse, true, "review account reuse");
  exactValue(value.accountBoundary.liveCanaryAccountReuse, false, "review live account isolation");
  exactValue(value.accountBoundary.githubAccountConnections, 1, "review GitHub connection count");
  exactValue(value.accountBoundary.repositoryConnectionReuse, true, "review repository connection reuse");
  exactValue(value.accountBoundary.connectedWorker, "atrinik-metaserver-review-check", "review connected Worker");
  exactValue(value.accountBoundary.buildIdentityProductionProjectSettingsReachable, false,
    "review build identity production project isolation");
  exactValue(value.accountBoundary.trustedOperatorProductionBuildsControlPlaneReach, true,
    "review trusted operator control-plane reach");
  exactValue(value.project, "atrinik-metaserver-review-check", "review project");
  exactValue(value.rootDirectory, "/deployment/review-check", "review root");
  exactValue(value.productionBranch, "review-build-only-sentinel", "review sentinel branch");
  exactValue(value.productionAutomaticPush, false, "review automatic production push");
  exactValue(value.productionDeployCommand, "cd ../.. && npm run review:reject-sentinel", "review sentinel command");
  exactArray(value.previewBranchIncludes, ["*"], "review branch includes");
  exactArray(value.previewBranchExcludes, ["main", "review-build-only-sentinel"], "review branch excludes");
  exactArray(value.pathIncludes, ["*"], "review path includes");
  exactArray(value.pathExcludes, [], "review path excludes");
  exactValue(value.buildCommand,
    "cd ../.. && npm run review:build",
    "review build command");
  if (Buffer.byteLength(value.buildCommand, "utf8") > 64)
    fail("review build command exceeds the retained provider-safe byte ceiling");
  exactValue(value.deployCommand, "cd ../.. && npm run review:validate", "review deploy command");
  exactValue(value.providerBuildTimeoutMinutes, 20, "review provider build timeout");
  exactValue(value.checkCommandTimeoutMinutes, 15, "review check command timeout");
  exactKeys(value.buildEnvironment, ["SKIP_DEPENDENCY_INSTALL"], "review build environment");
  exactValue(value.buildEnvironment.SKIP_DEPENDENCY_INSTALL, "1", "review dependency policy");
  exactArray(value.protectedInputs, [], "review protected inputs");
  exactArray(value.bindings, [], "review bindings");
  exactArray(value.routes, [], "review routes");
  exactKeys(value.bootstrap, [
    "configPath", "configSha256", "sourcePath", "sourceSha256", "workerName",
    "existingWorkerTagRequired", "retainedBootstrapVersions", "workersDev", "previewUrls",
    "bindings", "routes", "observability", "provisioningActor", "provisioningPermissions",
    "provisioningCredentialBuildReadable",
  ], "review bootstrap");
  const bootstrap = {
    configPath: "deployment/review-check/wrangler.jsonc",
    configSha256: "299f223ca1465512cf0016e3a4446df0bf70968b6fff77e86748b345853526b4",
    sourcePath: "src/review-check-worker.ts",
    sourceSha256: "b90eb0e486a6708d51c33e4b97424fa5f637c9fc354f32fb6fe79645f9ecc21f",
    workerName: "atrinik-metaserver-review-check", existingWorkerTagRequired: true,
    retainedBootstrapVersions: 1, workersDev: false, previewUrls: false,
    observability: false, provisioningActor: "issue-56-review-check-bootstrap-operator",
    provisioningCredentialBuildReadable: false,
  };
  for (const [key, expected] of Object.entries(bootstrap))
    exactValue(value.bootstrap[key], expected, `review bootstrap ${key}`);
  exactArray(value.bootstrap.bindings, [], "review bootstrap bindings");
  exactArray(value.bootstrap.routes, [], "review bootstrap routes");
  exactArray(value.bootstrap.provisioningPermissions, ["Workers Scripts:Edit"],
    "review bootstrap permissions");
  exactKeys(value.costPolicy, [
    "persistentWorkers", "maximumMonthlyReviewBuildMinutes", "alertAtMinutes", "owner",
    "thresholdAction", "staleBuildPolicy", "accountPlanAndUsageReadbackRequired",
  ], "review cost policy");
  const cost = {
    persistentWorkers: 1, maximumMonthlyReviewBuildMinutes: 1000, alertAtMinutes: 800,
    owner: "metaserver-review-environment-operator",
    thresholdAction: "disable-review-check-nonproduction-trigger-and-read-back",
    staleBuildPolicy: "older-build-may-finish-build-only-but-sha-bound-result-is-superseded-never-live-authority-counts-against-budget-and-workflow-does-not-cancel-stale-builds",
    accountPlanAndUsageReadbackRequired: true,
  };
  for (const [key, expected] of Object.entries(cost))
    exactValue(value.costPolicy[key], expected, `review cost ${key}`);
  exactKeys(value.result, [
    "githubCheck", "githubComment", "githubCommentHistory", "reviewUrl",
    "branchCreatesWorkerVersion", "persistentBootstrapVersions", "workerLogs",
  ], "review result");
  if (JSON.stringify(value.result) !== JSON.stringify({
    githubCheck: true, githubComment: true, githubCommentHistory: true,
    reviewUrl: null, branchCreatesWorkerVersion: false, persistentBootstrapVersions: 1,
    workerLogs: false,
  })) fail("review result drift");
  exactValue(value.forkPolicy, "fork-ref-is-not-in-connected-repository-github-validation-only", "fork policy");
  exactKeys(value.tokenAuthority, [
    "tokenReuse", "tokenType", "tokenIdentity", "userPermissions", "accountPermissions", "zonePermissions",
    "accountResources", "zoneResources", "productionRead", "productionWrite", "provisioningGate",
  ], "review token authority");
  exactValue(value.tokenAuthority.tokenReuse, false, "review token reuse");
  exactValue(value.tokenAuthority.tokenType, "user-api-token", "review token type");
  exactValue(value.tokenAuthority.tokenIdentity, "dedicated-nonhuman-no-personal-data", "review token identity");
  exactArray(value.tokenAuthority.userPermissions, ["User Details:Read"], "review user token permissions");
  for (const key of ["accountPermissions", "zonePermissions", "accountResources", "zoneResources"])
    exactArray(value.tokenAuthority[key], [], `review token ${key}`);
  exactValue(value.tokenAuthority.productionRead, false, "review production read authority");
  exactValue(value.tokenAuthority.productionWrite, false, "review production write authority");
  exactValue(value.tokenAuthority.provisioningGate,
    "prove-build-and-local-no-op-deploy-succeed-with-no-account-or-zone-resource-permissions",
    "review token provisioning gate");
  exactKeys(value.controlPlaneOperator, [
    "actor", "when", "tokenType", "tokenIdentity", "credentialStorage", "permission", "resourceScope", "providerCapabilityFamilies",
    "productionBuildsControlPlaneReach",
    "credentialBuildReadable", "allowedMutations", "guards", "acceptance",
  ], "review control-plane operator");
  const operator = {
    actor: "metaserver-review-environment-operator",
    when: "setup-budget-threshold-or-provider-recovery-only-never-review-build",
    tokenType: "user-api-token-account-tokens-not-supported",
    tokenIdentity: "dedicated-nonhuman-no-personal-data",
    credentialStorage: "operator-secret-store-only-never-project-environment-build-or-repository",
    permission: "Workers CI Write",
    resourceScope: "production-account-all-workers-builds-control-plane-resources-provider-cannot-scope-to-project",
    productionBuildsControlPlaneReach: true,
    credentialBuildReadable: false,
    acceptance: "unavoidable-trusted-production-account-control-plane-authority-explicitly-accepted-for-option-three",
  };
  for (const [key, expected] of Object.entries(operator))
    exactValue(value.controlPlaneOperator[key], expected, `review control-plane operator ${key}`);
  exactArray(value.controlPlaneOperator.providerCapabilityFamilies, [
    "build-read-cancel", "build-token-create-delete", "environment-variable-read-write",
    "repository-connection-read-write", "trigger-read-write", "manual-build-create",
  ], "review operator provider capabilities");
  exactArray(value.controlPlaneOperator.allowedMutations,
    ["exact-review-check-trigger-create-update-disable"], "review operator mutations");
  exactArray(value.controlPlaneOperator.guards, [
    "exact-account", "exact-review-project-id", "exact-review-trigger-id",
    "reject-production-project-or-trigger-id", "read-back-after-mutation",
  ], "review operator guards");
}

export function validateReviewBuildEntrypoint(scripts, production) {
  exactValue(scripts?.["review:build"],
    `${production.installCommand} && npm run review:branch`, "review build entrypoint");
}

function validateResources(resources) {
  exactKeys(resources, [
    "workers", "d1", "coordinationD1", "durableObjects", "r2", "analytics", "rateLimits",
    "rendezvousClientRateLimit", "secrets", "hostnames", "edgePolicy", "cron", "observability",
  ], "review resources");
  const workerNames = resources.workers.map(({ name }) => name);
  exactArray(workerNames, [
    "atrinik-metaserver-review-canary",
    "atrinik-metaserver-publisher-review-canary",
    "atrinik-metaserver-rendezvous-review-canary",
  ], "review Worker names");
  exactArray(resources.workers.map(({ role }) => role), ["core", "publisher", "rendezvous"], "review Worker roles");
  for (const worker of resources.workers) {
    exactKeys(worker, ["role", "name", "source", "stateOwner", "serviceBindings"], "review Worker");
    exactValue(worker.source, "approved-exact-commit", "review Worker source");
  }
  exactValue(resources.workers[0].stateOwner, true, "core state ownership");
  exactValue(resources.workers[1].stateOwner, false, "publisher state ownership");
  exactValue(resources.workers[2].stateOwner, false, "rendezvous state ownership");
  exactArray(resources.workers[0].serviceBindings, [], "core service bindings");
  exactArray(resources.workers[1].serviceBindings, ["COORDINATOR:atrinik-metaserver-review-canary#PublisherCoordinator"], "publisher binding");
  exactArray(resources.workers[2].serviceBindings, ["COORDINATOR:atrinik-metaserver-review-canary#RendezvousCoordinator"], "rendezvous binding");
  exactKeys(resources.d1, ["owner", "name", "binding", "migrationLedger", "reset", "referenceVectorSources"], "review D1");
  exactValue(resources.d1.name, "atrinik-metaserver-review-canary", "review D1 name");
  exactValue(resources.d1.owner, "core", "review D1 owner");
  exactValue(resources.d1.binding, "DB", "review D1 binding");
  exactValue(resources.d1.migrationLedger, "independent-exact-checked-in-ledger", "review migration ledger");
  exactValue(resources.d1.reset, "fresh-d1-or-reviewed-expiry-only-no-bulk-production-copy", "review reset plan");
  exactArray(resources.d1.referenceVectorSources, [
    "test/fixtures/metaserver-publisher-v1.json",
    "test/fixtures/metaserver-classic-publisher-v2.json",
    "test/fixtures/metaserver-game-publisher-v1.json",
  ], "review fixture sources");
  exactKeys(resources.coordinationD1, [
    "owner", "name", "schema", "schemaPath", "schemaSha256", "operationsPath", "operationsSha256",
    "controlTable", "controlColumns", "table", "columns",
    "acquire", "renew", "release", "reclaim", "quiesce", "teardownRecovery", "teardown", "leaseDurationSeconds",
    "maximumLeaseProofAgeSeconds", "maximumForwardMutationSeconds", "minimumRecoveryReserveSeconds",
    "minimumQuiesceSeconds", "minimumDisabledDrainSeconds",
  ], "review coordination D1");
  const coordination = {
    owner: "review-live-runner", name: "atrinik-metaserver-review-coordination",
    schema: "review-coordination-v1", schemaPath: "deployment/review-coordination-v1.sql",
    schemaSha256: "be6c3880c5aee7dd6c52175550913aee45e3b15aa673ba695553597bda22ffc2",
    operationsPath: "deployment/review-coordination-operations-v1.json",
    operationsSha256: "d8f09b63fe25b456546da0f1979cd82ea3f71eb3e45e90acfbfc46e374f9fdbe",
    controlTable: "review_environment_control",
    table: "review_runs",
    acquire: "insert-or-cas-expired-after-disabled-drain-proof",
    renew: "cas-run-uuid-generation-before-forward-mutation",
    release: "cas-run-uuid-generation-after-disabled-drain-proof",
    reclaim: "compare-lease-expires-at-to-provider-utc-after-exact-disabled-readback-and-sixty-second-drain",
    quiesce: "atomic-active-to-quiescing-transition-blocks-new-forward-proofs-while-owner-closure-and-release-remain-allowed",
    teardownRecovery: "cleanup-only-expired-exact-owner-generation-cas-after-quiesce-horizon-and-external-disabled-socket-drain-proof",
    teardown: "atomic-quiescing-to-terminal-after-four-hundred-twenty-five-seconds-and-no-review-run-row",
  };
  for (const [key, expected] of Object.entries(coordination))
    exactValue(resources.coordinationD1[key], expected, `review coordination ${key}`);
  exactArray(resources.coordinationD1.columns, [
    "singleton", "source_sha", "run_uuid", "lease_generation", "lease_expires_at", "fixture_namespace", "state",
  ], "review coordination columns");
  exactArray(resources.coordinationD1.controlColumns, ["singleton", "mode", "quiesced_at"],
    "review coordination control columns");
  exactValue(resources.coordinationD1.leaseDurationSeconds, 1800, "review coordination lease duration");
  exactValue(resources.coordinationD1.maximumLeaseProofAgeSeconds, 5,
    "review coordination lease proof age");
  exactValue(resources.coordinationD1.maximumForwardMutationSeconds, 120,
    "review coordination forward mutation timeout");
  exactValue(resources.coordinationD1.minimumRecoveryReserveSeconds, 300,
    "review coordination recovery reserve");
  exactValue(resources.coordinationD1.minimumQuiesceSeconds, 425,
    "review coordination quiesce horizon");
  exactValue(resources.coordinationD1.minimumDisabledDrainSeconds, 60,
    "review coordination disabled drain");
  if (!Array.isArray(resources.durableObjects) || resources.durableObjects.length !== 2)
    fail("review Durable Object inventory drift");
  for (const item of resources.durableObjects)
    exactKeys(item, ["owner", "binding", "class"], "review Durable Object");
  exactArray(resources.durableObjects.map(({ binding }) => binding), ["RENDEZVOUS", "DIRECTORY_BUILDER"], "review Durable Objects");
  exactArray(resources.durableObjects.map(({ owner }) => owner), [
    "atrinik-metaserver-review-canary", "atrinik-metaserver-review-canary",
  ], "review Durable Object owners");
  exactArray(resources.durableObjects.map(({ class: className }) => className), [
    "RendezvousRoom", "DirectoryBuilder",
  ], "review Durable Object classes");
  for (const item of resources.r2)
    exactKeys(item, ["owner", "binding", "name", "r2Dev"], "review R2");
  exactArray(resources.r2.map(({ name }) => name), [
    "atrinik-metaserver-review-canary-generations",
    "atrinik-metaserver-review-canary-classic",
    "atrinik-metaserver-review-canary-game",
  ], "review R2 names");
  exactArray(resources.r2.map(({ binding }) => binding), [
    "DIRECTORY_GENERATIONS", "CLASSIC_DIRECTORY_PUBLIC", "GAME_DIRECTORY_PUBLIC",
  ], "review R2 bindings");
  if (resources.r2.some(({ owner }) => owner !== "core")) fail("review R2 owner drift");
  if (resources.r2.some(({ r2Dev }) => r2Dev !== false)) fail("review R2 must disable r2.dev");
  exactArray(resources.analytics.map(({ name }) => name), [
    "atrinik_metaserver_rendezvous_review_canary",
    "atrinik_metaserver_directory_review_canary",
  ], "review analytics names");
  exactArray(resources.analytics.map(({ binding }) => binding), [
    "RENDEZVOUS_METRICS", "DIRECTORY_METRICS",
  ], "review analytics bindings");
  exactArray(resources.analytics.map(({ owner }) => owner), ["core", "core"], "review analytics owners");
  for (const item of resources.analytics)
    exactKeys(item, ["owner", "binding", "name"], "review analytics");
  for (const item of resources.rateLimits)
    exactKeys(item, ["owner", "binding", "namespaceId", "simple", "productionNamespaceReuse"], "review rate limit");
  exactArray(resources.rateLimits.map(({ namespaceId }) => namespaceId), [
    "2006", "2007", "2101", "2201",
  ], "review rate namespaces");
  exactArray(resources.rateLimits.map(({ owner }) => owner), [
    "core", "core", "publisher", "rendezvous",
  ], "review rate owners");
  exactArray(resources.rateLimits.map(({ binding }) => binding), [
    "PUBLISH_IDENTITY_RATE_LIMITER", "RENDEZVOUS_SERVER_RATE_LIMITER",
    "GLOBAL_RATE_LIMITER", "GLOBAL_RATE_LIMITER",
  ], "review rate bindings");
  for (const rate of [...resources.rateLimits, resources.rendezvousClientRateLimit])
    exactValue(rate.productionNamespaceReuse, false, "review rate namespace isolation");
  exactArray(resources.rateLimits.map(({ simple }) => simple), [
    { limit: 2, period: 60 }, { limit: 3, period: 60 },
    { limit: 10, period: 60 }, { limit: 10, period: 60 },
  ], "review rate policies");
  exactKeys(resources.rendezvousClientRateLimit, [
    "owner", "binding", "namespaceId", "simple", "countedWithinRateLimitNamespaceCeiling", "productionNamespaceReuse",
  ], "review client rate limit");
  exactValue(resources.rendezvousClientRateLimit.owner, "rendezvous", "review client rate owner");
  exactValue(resources.rendezvousClientRateLimit.binding, "RENDEZVOUS_CLIENT_RATE_LIMITER", "review client rate binding");
  exactValue(resources.rendezvousClientRateLimit.namespaceId, "2202", "review client rate namespace");
  exactKeys(resources.rendezvousClientRateLimit.simple, ["limit", "period"], "review client rate policy");
  exactValue(resources.rendezvousClientRateLimit.simple.limit, 60, "review client rate limit");
  exactValue(resources.rendezvousClientRateLimit.simple.period, 60, "review client rate period");
  exactValue(resources.rendezvousClientRateLimit.countedWithinRateLimitNamespaceCeiling, true, "review rate ceiling accounting");
  exactKeys(resources.secrets, ["owner", "names", "epochIds", "productionValueReuse", "buildReadable"], "review secrets");
  exactArray(resources.secrets.names, ["DIRECTORY_CACHE_PURGE_TOKEN", "SOURCE_TAG_KEY_CURRENT", "SOURCE_TAG_KEY_PREVIOUS"], "review secret bindings");
  exactArray(resources.secrets.epochIds, ["review-canary-current", "review-canary-previous"], "review secret epochs");
  exactValue(resources.secrets.owner, "canary-cohort-only", "review secret owner");
  exactValue(resources.secrets.productionValueReuse, false, "review secret isolation");
  exactValue(resources.secrets.buildReadable, false, "review secret visibility");
  exactKeys(resources.hostnames, [
    "zone", "static", "dynamic", "workersDev", "previewUrls", "productionDnsAuthority",
    "productionRouteAuthority", "productionCachePurgeAuthority",
  ], "review hostnames");
  exactArray(resources.hostnames.static, [], "review static hosts");
  exactArray(resources.hostnames.dynamic, [
    "atrinik-metaserver-review-canary.<private-subdomain>.workers.dev",
    "atrinik-metaserver-publisher-review-canary.<private-subdomain>.workers.dev",
    "atrinik-metaserver-rendezvous-review-canary.<private-subdomain>.workers.dev",
  ], "review dynamic hosts");
  exactValue(resources.hostnames.zone, null, "review hostname zone");
  exactValue(resources.hostnames.workersDev, true, "review workers.dev hostnames");
  for (const key of ["previewUrls", "productionDnsAuthority", "productionRouteAuthority", "productionCachePurgeAuthority"])
    exactValue(resources.hostnames[key], false, `review hostname ${key}`);
  exactKeys(resources.edgePolicy, ["owner", "tls", "waf", "cache", "access", "productionRuleAuthority"], "review edge policy");
  for (const [key, expected] of Object.entries({
    owner: "review-canary-workers-dev-only", tls: "provider-managed-workers-dev",
    waf: "none-production-waf-not-proven", cache: "none-static-r2-readback-is-provider-api-only",
    access: "one-all-workers-review-canary-application",
  })) exactValue(resources.edgePolicy[key], expected, `review edge ${key}`);
  exactValue(resources.edgePolicy.productionRuleAuthority, false, "review edge authority");
  exactKeys(resources.cron, ["enabled", "maintenance"], "review cron");
  exactValue(resources.cron.enabled, false, "review cron");
  exactValue(resources.cron.maintenance, "explicit-test-step-only", "review maintenance");
  exactKeys(resources.observability, ["destinations", "workerLogs", "redaction", "productionDestinationReuse"], "review observability");
  exactArray(resources.observability.destinations, [], "review observability destinations");
  exactValue(resources.observability.workerLogs, true, "review Worker logs");
  exactValue(resources.observability.redaction, "docs/privacy.md", "review log redaction");
  exactValue(resources.observability.productionDestinationReuse, false, "review observability isolation");
  unique(workerNames, "review Worker names");
  unique(resources.r2.map(({ name }) => name), "review R2 names");
  unique(resources.analytics.map(({ name }) => name), "review analytics names");
  unique([
    ...resources.rateLimits.map(({ namespaceId }) => namespaceId),
    resources.rendezvousClientRateLimit.namespaceId,
  ], "review rate namespace names");
}

function validateConfigurationMaterialization(value) {
  const expected = {
    mode: "parse-checked-in-role-jsonc-and-apply-only-exact-allowlisted-review-overrides",
    allOtherFields: "canonical-value-equivalent-to-digest-pinned-source",
    providerIssuedSubstitutions: {
      coreD1DatabaseId: "lowercase-hyphenated-uuid-from-exact-review-d1-readback",
      workersDevPrivateSubdomain: "exact-dedicated-live-account-subdomain-readback",
    },
    sources: [
      { role: "core", path: "wrangler.jsonc", sha256: "4e73be0b0ff51b3efc2cc15cd4bceed5036b331d3b68493b18798f23f48ef684" },
      { role: "publisher", path: "wrangler.publisher.jsonc", sha256: "3d188c96bd60fe900a2e52a74e3c19b639170e77807b12bc97991fe2eeb2c964" },
      { role: "rendezvous", path: "wrangler.rendezvous.jsonc", sha256: "c682b93600dbb25763d3d61ad9bb681d85a8a4ad68c809248e8507998dfe8624" },
    ],
    common: {
      workersDev: true, previewUrls: false, routes: [], observabilityDestinations: [],
      sourceTagCurrentId: "review-canary-current", sourceTagPreviousId: "review-canary-previous",
      routeDisabledRetrySeconds: "60",
    },
    core: {
      name: "atrinik-metaserver-review-canary", d1DatabaseName: "atrinik-metaserver-review-canary",
      d1DatabaseId: "<provider-issued-review-d1-uuid>",
      r2BucketNames: ["atrinik-metaserver-review-canary-generations", "atrinik-metaserver-review-canary-classic", "atrinik-metaserver-review-canary-game"],
      analyticsDatasets: ["atrinik_metaserver_rendezvous_review_canary", "atrinik_metaserver_directory_review_canary"],
      rateNamespaceIds: ["2006", "2007"], directoryCacheZoneId: "00000000000000000000000000000000",
      classicDirectoryPublicOrigin: "https://classic.review.invalid",
      gameDirectoryPublicOrigin: "https://game.review.invalid",
      publishHostname: "atrinik-metaserver-publisher-review-canary.<private-subdomain>.workers.dev",
      rendezvousHostname: "atrinik-metaserver-rendezvous-review-canary.<private-subdomain>.workers.dev",
      circuitsOutsideLiveWindow: { publish: "disabled", gamePublish: "disabled", rendezvous: "disabled" },
      circuitsInsideLiveWindow: { publish: "enabled", gamePublish: "enabled", rendezvous: "enabled" },
      cronTriggers: [],
    },
    publisher: {
      name: "atrinik-metaserver-publisher-review-canary",
      serviceBinding: "COORDINATOR:atrinik-metaserver-review-canary#PublisherCoordinator",
      rateNamespaceId: "2101",
      publishHostname: "atrinik-metaserver-publisher-review-canary.<private-subdomain>.workers.dev",
      circuitsOutsideLiveWindow: { publish: "disabled", gamePublish: "disabled" },
      circuitsInsideLiveWindow: { publish: "enabled", gamePublish: "enabled" },
    },
    rendezvous: {
      name: "atrinik-metaserver-rendezvous-review-canary",
      serviceBinding: "COORDINATOR:atrinik-metaserver-review-canary#RendezvousCoordinator",
      rateNamespaceIds: ["2201", "2202"],
      rendezvousHostname: "atrinik-metaserver-rendezvous-review-canary.<private-subdomain>.workers.dev",
      circuitsOutsideLiveWindow: { rendezvous: "disabled" },
      circuitsInsideLiveWindow: { rendezvous: "enabled" },
    },
  };
  if (JSON.stringify(value) !== JSON.stringify(expected))
    fail("review configuration materialization drift");
}

export function materializeReviewConfiguration(source, role, materialization, liveWindow = false) {
  validateConfigurationMaterialization(materialization);
  if (!["core", "publisher", "rendezvous"].includes(role))
    fail("unknown review configuration role");
  const config = structuredClone(source);
  const common = materialization.common;
  const override = materialization[role];
  config.workers_dev = common.workersDev;
  config.preview_urls = common.previewUrls;
  config.routes = structuredClone(common.routes);
  config.tail_consumers = [];
  config.streaming_tail_consumers = [];
  if (!config.vars || !config.observability?.logs || !config.observability?.traces)
    fail(`review ${role} source configuration shape drift`);
  config.observability.logs.destinations = structuredClone(common.observabilityDestinations);
  config.observability.traces.destinations = structuredClone(common.observabilityDestinations);
  config.vars.SOURCE_TAG_KEY_CURRENT_ID = common.sourceTagCurrentId;
  config.vars.SOURCE_TAG_KEY_PREVIOUS_ID = common.sourceTagPreviousId;
  config.vars.ROUTE_DISABLED_RETRY_SECONDS = common.routeDisabledRetrySeconds;
  config.name = override.name;
  if (role === "core") {
    if (config.d1_databases?.length !== 1 || config.r2_buckets?.length !== 3 ||
        config.analytics_engine_datasets?.length !== 2 || config.ratelimits?.length !== 2)
      fail("review core source resource shape drift");
    config.d1_databases[0].database_name = override.d1DatabaseName;
    config.d1_databases[0].database_id = override.d1DatabaseId;
    config.r2_buckets.forEach((binding, index) => { binding.bucket_name = override.r2BucketNames[index]; });
    config.analytics_engine_datasets.forEach((binding, index) => {
      binding.dataset = override.analyticsDatasets[index];
    });
    config.ratelimits.forEach((binding, index) => { binding.namespace_id = override.rateNamespaceIds[index]; });
    config.vars.DIRECTORY_CACHE_ZONE_ID = override.directoryCacheZoneId;
    config.vars.CLASSIC_DIRECTORY_PUBLIC_ORIGIN = override.classicDirectoryPublicOrigin;
    config.vars.GAME_DIRECTORY_PUBLIC_ORIGIN = override.gameDirectoryPublicOrigin;
    config.vars.PUBLISH_HOSTNAME = override.publishHostname;
    config.vars.RENDEZVOUS_HOSTNAME = override.rendezvousHostname;
    config.triggers = { crons: structuredClone(override.cronTriggers) };
  } else {
    if (config.services?.length !== 1) fail(`review ${role} source Service Binding shape drift`);
    const [binding, serviceAndEntrypoint] = override.serviceBinding.split(":");
    const [service, entrypoint] = serviceAndEntrypoint.split("#");
    Object.assign(config.services[0], { binding, service, entrypoint });
    if (role === "publisher") {
      if (config.ratelimits?.length !== 1) fail("review publisher source rate shape drift");
      config.ratelimits[0].namespace_id = override.rateNamespaceId;
      config.vars.PUBLISH_HOSTNAME = override.publishHostname;
    } else {
      if (config.ratelimits?.length !== 2) fail("review rendezvous source rate shape drift");
      config.ratelimits.forEach((bindingValue, index) => {
        bindingValue.namespace_id = override.rateNamespaceIds[index];
      });
      config.vars.RENDEZVOUS_HOSTNAME = override.rendezvousHostname;
    }
  }
  const circuits = liveWindow ? override.circuitsInsideLiveWindow : override.circuitsOutsideLiveWindow;
  if (circuits.publish !== undefined) config.vars.PUBLISH_ENABLED = circuits.publish;
  if (circuits.gamePublish !== undefined) config.vars.GAME_PUBLISH_ENABLED = circuits.gamePublish;
  if (circuits.rendezvous !== undefined) config.vars.RENDEZVOUS_ENABLED = circuits.rendezvous;
  return config;
}

export function validateLiveCanary(value) {
  exactKeys(value, [
    "accountBoundary", "automatic", "invocation", "command", "source", "actors", "credentialBoundary",
    "maximumRunMinutes", "maximumMutationMinutes", "maximumLiveWindowMinutes", "maximumConcurrentCohorts", "lease", "stalePolicy", "deploymentOrder", "circuits",
    "access", "reviewEvidence", "resourceCeilings", "configurationMaterialization", "resources", "dataPolicy", "testPlan", "cleanup",
  ], "live canary");
  exactKeys(value.accountBoundary, [
    "mode", "productionAccountReuse", "automaticReviewAccountReuse", "zone",
    "workersDevSubdomainEnabled", "parentDnsAuthority",
  ], "live account boundary");
  exactValue(value.accountBoundary.mode, "dedicated-live-canary-account", "live account mode");
  exactValue(value.accountBoundary.productionAccountReuse, false, "live production account isolation");
  exactValue(value.accountBoundary.automaticReviewAccountReuse, false, "live automatic-review account isolation");
  exactValue(value.accountBoundary.zone, null, "live account zone");
  exactValue(value.accountBoundary.workersDevSubdomainEnabled, true, "live workers.dev namespace");
  exactValue(value.accountBoundary.parentDnsAuthority, false, "live parent DNS authority");
  exactValue(value.automatic, false, "live automatic execution");
  exactValue(value.invocation, "operator-supervised-clean-exact-commit", "live invocation");
  exactValue(value.command, "npm run deploy:review-canary -- --source-sha <sha>", "live command");
  exactKeys(value.source, [
    "repository", "branch", "commit", "checkout", "githubProof", "approval",
  ], "live source");
  const expectedSource = {
    repository: "atrinik/metaserver-worker", branch: "same-repository-non-main",
    commit: "full-40-lowercase-hex-sha", checkout: "clean-detached-exact-sha",
    githubProof: "gh-read-only-branch-commit-and-not-reachable-from-main-proof-before-credentials",
    approval: "maintainer-explicit-exact-sha-record",
  };
  for (const [key, expected] of Object.entries(expectedSource))
    exactValue(value.source[key], expected, `live source ${key}`);
  const expectedActors = [
    ["provisioner", "issue-56-reviewed-setup-only",
      ["Workers Scripts:Edit", "D1:Edit", "Workers R2 Storage:Edit", "Access Apps and Policies:Edit", "Account Settings:Read"],
      ["dedicated-live-canary-account"],
      ["live-account-resource-create", "workers-dev-subdomain", "all-workers-access-policy", "runtime-secret-write"], false],
    ["migration-operator", "reviewed-ledger-advance-only", ["D1:Edit"],
      ["dedicated-live-canary-account"], ["live-d1-migrations-edit"], false],
    ["live-runner", "explicit-exact-sha-run",
      ["Workers Scripts:Edit", "D1:Edit", "Workers R2 Storage:Read", "Account Analytics:Read"],
      ["dedicated-live-canary-account"],
      ["live-account-workers-scripts-edit", "live-d1-lease-and-fixture-edit", "live-account-readback"], true],
    ["access-token-operator", "after-live-lease-before-live-window-and-after-closed-readback",
      ["Access: Service Tokens Write", "Access Apps and Policies:Edit"], ["dedicated-live-canary-account"],
      ["create-exact-sixty-minute-run-token", "bind-policy-to-exact-run-token-id", "delete-exact-run-token"], false],
    ["access-canary", "bounded-live-window", [], ["one-review-all-workers-access-application"],
      ["one-review-all-workers-access-application"], true],
    ["cleanup-operator", "separately-authorized-preview-then-apply",
      ["Workers Scripts:Edit", "D1:Edit", "Workers R2 Storage:Edit", "Access Apps and Policies:Edit", "Access: Service Tokens Write", "Account Settings:Edit"],
      ["dedicated-live-canary-account"], ["exact-live-account-resource-delete"], false],
  ];
  if (!Array.isArray(value.actors) || value.actors.length !== expectedActors.length)
    fail("live actor inventory drift");
  value.actors.forEach((actor, index) => {
    exactKeys(actor, ["actor", "when", "permissions", "resources", "authority", "routine"], "live actor");
    exactValue(actor.actor, expectedActors[index][0], "live actor name");
    exactValue(actor.when, expectedActors[index][1], "live actor timing");
    exactArray(actor.permissions, expectedActors[index][2], "live actor permissions");
    exactArray(actor.resources, expectedActors[index][3], "live actor resources");
    exactArray(actor.authority, expectedActors[index][4], "live actor authority");
    exactValue(actor.routine, expectedActors[index][5], "live actor routine flag");
  });
  exactKeys(value.credentialBoundary, [
    "githubConnection", "credentialsEnterRepositoryValidation", "liveAccountOnly", "productionAccount",
    "parentDns", "runtimeSecretRead", "cleanupCredentialLoadedInRoutineRun",
  ], "live credential boundary");
  for (const key of ["githubConnection", "credentialsEnterRepositoryValidation", "productionAccount",
    "parentDns", "runtimeSecretRead", "cleanupCredentialLoadedInRoutineRun"])
    exactValue(value.credentialBoundary[key], false, `live credential ${key}`);
  exactValue(value.credentialBoundary.liveAccountOnly, true, "live account credential isolation");
  exactValue(value.maximumRunMinutes, 20, "live run duration");
  exactValue(value.maximumMutationMinutes, 15, "live mutation duration");
  exactValue(value.maximumLiveWindowMinutes, 5, "live test window");
  exactValue(value.maximumConcurrentCohorts, 1, "live concurrency");
  exactValue(value.lease, "atomic-live-d1-lease-exact-sha-owner-with-bounded-expiry", "live lease");
  exactKeys(value.stalePolicy, [
    "forwardMutationFence", "failSafeClosure", "boundedRuntimeCleanup", "lossInjection",
  ], "live stale policy");
  exactValue(value.stalePolicy.forwardMutationFence,
    "reprove-github-branch-sha-and-live-lease-before-every-enable-deploy-fixture-or-test-mutation",
    "live forward mutation fence");
  exactValue(value.stalePolicy.failSafeClosure,
    "always-authorized-for-exact-reviewed-cohort-after-account-and-resource-readback",
    "live fail-safe closure");
  exactValue(value.stalePolicy.boundedRuntimeCleanup,
    "explicitly-close-all-unique-review-do-sockets-wait-close-ack-prove-room-offline-record-logical-replay-expiry-and-schedule-operator-physical-retention-readback-without-live-lease",
    "live bounded runtime cleanup");
  exactValue(value.stalePolicy.lossInjection,
    "force-push-branch-delete-and-lease-expiry-during-every-enabled-stage-must-close-circuits",
    "live loss injection");
  exactArray(value.deploymentOrder, ["core", "publisher", "rendezvous"], "live deploy order");
  exactKeys(value.circuits, ["staging", "final", "restoreOrder"], "live circuits");
  exactValue(value.circuits.staging, "disabled", "live staged circuit");
  exactValue(value.circuits.final, "disabled-unless-explicit-live-test-window", "live final circuit");
  exactArray(value.circuits.restoreOrder, ["publisher", "rendezvous", "core"], "live restore order");
  exactKeys(value.access, [
    "mode", "public", "urlsAreSecret", "websocket", "credentialStorage",
    "application", "policy", "serviceToken",
  ], "live access");
  exactValue(value.access.mode, "cloudflare-access-service-token", "live access mode");
  exactValue(value.access.websocket,
    "cf-access-client-id-and-cf-access-client-secret-on-upgrade", "live WebSocket access");
  exactValue(value.access.credentialStorage,
    "one-run-supervisor-memory-only-never-repository-comment-url-body-log-or-evidence",
    "live Access credential storage");
  exactValue(value.access.public, false, "live public access");
  exactValue(value.access.urlsAreSecret, false, "live URL boundary");
  exactKeys(value.access.application, [
    "name", "type", "destinationType", "sessionDuration", "appLauncherVisible",
  ], "live Access application");
  const application = { name: "atrinik-metaserver-review-canary", type: "self_hosted",
    destinationType: "all_workers", sessionDuration: "15m", appLauncherVisible: false };
  for (const [key, expected] of Object.entries(application))
    exactValue(value.access.application[key], expected, `live Access application ${key}`);
  exactKeys(value.access.policy, ["name", "decision", "precedence", "include", "exclude", "require"],
    "live Access policy");
  const policy = { name: "atrinik-metaserver-review-canary-service-auth", decision: "non_identity",
    precedence: 1 };
  for (const [key, expected] of Object.entries(policy))
    exactValue(value.access.policy[key], expected, `live Access policy ${key}`);
  exactArray(value.access.policy.exclude, [], "live Access policy exclude");
  exactArray(value.access.policy.require, [], "live Access policy require");
  if (JSON.stringify(value.access.policy.include) !== JSON.stringify([
    { service_token: { token_id: "<exact-run-service-token-id>" } },
  ])) fail("live Access policy include drift");
  exactKeys(value.access.serviceToken, [
    "namePrefix", "duration", "owner", "permission", "createdAfterLease",
    "deletedAfterClosedReadback", "policyUpdatedForExactTokenId", "rotation",
  ], "live Access service token");
  const serviceToken = { namePrefix: "atrinik-metaserver-review-canary-", duration: "60m",
    owner: "access-token-operator", permission: "Access: Service Tokens Write",
    createdAfterLease: true, deletedAfterClosedReadback: true,
    policyUpdatedForExactTokenId: true, rotation: false };
  for (const [key, expected] of Object.entries(serviceToken))
    exactValue(value.access.serviceToken[key], expected, `live Access token ${key}`);
  exactKeys(value.reviewEvidence, ["immutableIdentifiers", "mutableUrls", "maximumRetentionDays", "contents"], "review evidence");
  exactArray(value.reviewEvidence.immutableIdentifiers, ["sourceCommit", "runUuid", "deployableDigest"], "review identifiers");
  exactArray(value.reviewEvidence.mutableUrls, [
    "https://atrinik-metaserver-review-canary.<private-subdomain>.workers.dev",
    "https://atrinik-metaserver-publisher-review-canary.<private-subdomain>.workers.dev",
    "https://atrinik-metaserver-rendezvous-review-canary.<private-subdomain>.workers.dev",
  ], "review URLs");
  exactValue(value.reviewEvidence.maximumRetentionDays, 7, "review evidence retention");
  exactValue(value.reviewEvidence.contents, "closed-outcome-digests-counts-and-resource-names-only", "review evidence contents");
  const ceilings = value.resourceCeilings;
  exactKeys(ceilings, [
    "workers", "d1Databases", "durableObjectNamespaces", "r2Buckets", "analyticsDatasets",
    "rateLimitNamespaces", "customHostnames", "accessApplications", "cohortLifetime", "quarterlyReprovisionRequired",
  ], "review resource ceilings");
  const expectedCeilings = { workers: 3, d1Databases: 2, durableObjectNamespaces: 2, r2Buckets: 3,
    analyticsDatasets: 2, rateLimitNamespaces: 5, customHostnames: 0, accessApplications: 1 };
  for (const [key, expected] of Object.entries(expectedCeilings)) exactValue(ceilings[key], expected, `review ${key} ceiling`);
  exactValue(ceilings.cohortLifetime, "long-lived-singleton", "review cohort lifetime");
  exactValue(ceilings.quarterlyReprovisionRequired, true, "review reprovision policy");
  validateConfigurationMaterialization(value.configurationMaterialization);
  validateResources(value.resources);
  exactKeys(value.dataPolicy, [
    "productionCopies", "liveRequestCopies", "credentials", "realServerIdentities",
    "rendezvousStateCopies", "fixturePrefix", "fixtureIdentityDerivation", "fixtureSigningKey", "fixtureMaximumAgeHours",
    "rendezvousReplayValidityHours", "rendezvousDoPhysicalRetention", "rendezvousDoIsolation",
    "isolationBeforeEveryRun", "disableCircuitsAfterEveryRun",
  ], "review data policy");
  for (const key of ["productionCopies", "liveRequestCopies", "credentials", "realServerIdentities", "rendezvousStateCopies"])
    exactValue(value.dataPolicy[key], false, `review data ${key}`);
  exactValue(value.dataPolicy.isolationBeforeEveryRun, "unique-fixture-namespace-and-no-unexpired-collision", "review fixture isolation");
  exactValue(value.dataPolicy.disableCircuitsAfterEveryRun, true, "review circuit cleanup");
  exactValue(value.dataPolicy.fixturePrefix, "review-canary-fixture-", "review fixture namespace");
  exactValue(value.dataPolicy.fixtureIdentityDerivation,
    "fresh-ephemeral-public-certificate-hash-plus-source-sha-run-uuid-vector-name",
    "review fixture identity derivation");
  exactValue(value.dataPolicy.fixtureSigningKey,
    "ephemeral-generated-in-supervised-run-never-persisted-or-logged", "review fixture signing key");
  exactValue(value.dataPolicy.fixtureMaximumAgeHours, 24, "review fixture retention");
  exactValue(value.dataPolicy.rendezvousReplayValidityHours, 24, "review rendezvous replay validity");
  exactValue(value.dataPolicy.rendezvousDoPhysicalRetention,
    "provider-alarm-best-effort-may-exceed-logical-validity-full-namespace-force-delete-and-absence-readback-no-later-than-cohort-age-ninety-days",
    "review rendezvous DO physical retention");
  exactValue(value.dataPolicy.rendezvousDoIsolation,
    "unique-ephemeral-server-id-per-run-no-cross-run-room-reuse", "review rendezvous DO isolation");
  exactArray(value.testPlan, [
    "prove-clean-exact-github-sha-before-loading-live-credentials",
    "acquire-atomic-d1-single-cohort-lease-and-suppress-stale-runs",
    "disable-all-circuits-and-read-back",
    "prove-isolated-state-and-require-exact-preapplied-migration-ledger",
    "generate-ephemeral-identities-and-seed-fresh-nonproduction-d1-fixtures-directly",
    "deploy-core-then-publisher-then-rendezvous",
    "read-back-same-cohort-service-bindings-and-resource-identifiers",
    "run-private-r2-readback-publisher-rejection-rendezvous-websocket-replay-and-redaction-canaries-without-directory-reconciliation",
    "inject-source-or-lease-loss-at-every-enabled-stage-and-prove-fail-safe-closure",
    "disable-all-circuits-and-prove-closed-read-back",
    "prove-no-directory-outbox-builder-or-alarm-work-was-created",
    "close-circuits-wait-sixty-second-socket-drain-release-lease-record-logical-twenty-four-hour-replay-expiry-and-schedule-operator-physical-retention-readback",
    "prove-quiescing-blocks-new-proofs-retains-unexpired-owner-row-drains-inflight-work-and-terminal-teardown-rejects-fixture-deploy-and-worker-recreation-through-final-access-deletion",
  ], "review executable test plan");
  exactKeys(value.cleanup, [
    "owner", "automaticOnBranchEvent", "normal", "fullOrder", "guards",
    "partialFailure", "evidenceMaximumRetentionDays", "providerResiduals",
  ], "review cleanup");
  exactValue(value.cleanup.owner, "metaserver-review-environment-operator", "review cleanup owner");
  exactValue(value.cleanup.automaticOnBranchEvent, false, "review branch cleanup");
  exactValue(value.cleanup.normal, "disable-circuits-expire-fixtures-retain-singleton", "review normal cleanup");
  exactArray(value.cleanup.fullOrder, [
    "atomically-enter-quiescing-mode-before-circuit-closure-or-any-destructive-action",
    "wait-four-hundred-twenty-five-seconds-for-proof-operation-and-recovery-horizon-then-disable-circuits-and-read-back",
    "accept-only-cooperative-live-runner-release-or-after-expiry-exact-disabled-readback-sixty-second-drain-cleanup-disabled-state-cas-and-cleanup-release",
    "prove-no-review-run-row-then-atomically-enter-terminal-teardown-mode",
    "prove-terminal-teardown-mode-and-quiesce-timestamp",
    "revoke-and-delete-run-access-service-token", "delete-caller-workers",
    "inventory-exact-core-script-tag-and-both-durable-object-namespace-ids",
    "force-delete-exact-core-worker-and-associated-durable-object-namespaces",
    "prove-core-script-and-both-durable-object-namespace-ids-absent",
    "delete-review-r2-and-application-d1-resources-and-remove-worker-rate-and-analytics-bindings",
    "disable-live-account-workers-dev-subdomain",
    "delete-all-workers-access-application-after-all-public-endpoints-are-absent",
    "delete-coordination-d1-terminal-fence-last",
  ], "review full cleanup order");
  exactArray(value.cleanup.guards, [
    "exact-review-prefix", "exact-account", "exact-resource-inventory", "no-production-identifier-match",
    "no-unowned-resource", "preview-before-apply", "recheck-disabled-circuits",
    "no-active-rendezvous-sockets-or-directory-builder-work",
    "exact-core-script-tag-and-durable-object-namespace-id-match",
    "cleanup-never-releases-an-unexpired-review-run-row",
    "terminal-teardown-fence-remains-until-final-access-deletion",
  ], "review cleanup guards");
  exactValue(value.cleanup.partialFailure, "stop-record-completed-prefix-leave-circuits-disabled-retry-from-readback", "review partial cleanup");
  exactValue(value.cleanup.evidenceMaximumRetentionDays, 7, "review cleanup evidence retention");
  exactKeys(value.cleanup.providerResiduals, [
    "analyticsDatasetRetentionDays", "analyticsAction", "rateLimitAction",
    "rendezvousDoLogicalReplayValidityHours", "rendezvousDoAction",
    "rendezvousDoPhysicalRetentionAction", "durableObjectFullDelete",
  ], "review provider residuals");
  exactValue(value.cleanup.providerResiduals.analyticsDatasetRetentionDays, 90,
    "review analytics retention");
  exactValue(value.cleanup.providerResiduals.analyticsAction,
    "stop-writes-remove-bindings-and-record-retained-synthetic-residue", "review analytics cleanup");
  exactValue(value.cleanup.providerResiduals.rateLimitAction,
    "remove-bindings-and-allow-provider-counters-to-expire", "review rate cleanup");
  exactValue(value.cleanup.providerResiduals.rendezvousDoLogicalReplayValidityHours, 24,
    "review rendezvous logical validity");
  exactValue(value.cleanup.providerResiduals.rendezvousDoAction,
    "close-sockets-record-provider-alarm-as-best-effort-and-read-back-prune-after-logical-expiry",
    "review rendezvous DO cleanup");
  exactValue(value.cleanup.providerResiduals.rendezvousDoPhysicalRetentionAction,
    "if-state-remains-record-residual-and-force-delete-entire-exact-review-core-and-both-namespaces-by-cohort-age-ninety-days-before-any-new-run-after-deadline",
    "review rendezvous physical cleanup");
  exactKeys(value.cleanup.providerResiduals.durableObjectFullDelete,
    ["method", "effect", "readback", "irreversible"], "review Durable Object full delete");
  const fullDelete = {
    method: "DELETE /accounts/{exact-live-account-id}/workers/scripts/atrinik-metaserver-review-canary?force=true",
    effect: "delete-exact-core-script-and-associated-RendezvousRoom-and-DirectoryBuilder-namespaces",
    readback: "core-script-404-and-both-inventoried-namespace-ids-absent",
    irreversible: true,
  };
  for (const [key, expected] of Object.entries(fullDelete))
    exactValue(value.cleanup.providerResiduals.durableObjectFullDelete[key], expected,
      `review Durable Object full delete ${key}`);
}

function productionIdentifiers(production, configurations) {
  const values = new Set();
  for (const worker of production.workers) {
    values.add(worker.name);
    for (const hostname of worker.customDomains) values.add(hostname);
  }
  for (const config of configurations) {
    for (const item of config.d1_databases ?? []) values.add(item.database_name);
    for (const item of config.r2_buckets ?? []) values.add(item.bucket_name);
    for (const item of config.analytics_engine_datasets ?? []) values.add(item.dataset);
    for (const item of config.ratelimits ?? []) values.add(String(item.namespace_id));
    for (const route of config.routes ?? []) if (route.pattern) values.add(route.pattern);
    for (const name of [config.vars?.PUBLISH_HOSTNAME, config.vars?.RENDEZVOUS_HOSTNAME]) if (name) values.add(name);
  }
  return values;
}

export function validateProductionIsolation(review, production, configurations) {
  exactValue(production.productionBranch, "main", "production branch");
  exactValue(production.deployCommand, "npm run deploy:production", "production command");
  exactValue(review.automaticReview.previewBranchExcludes.includes("main"), true, "main review exclusion");
  exactValue(review.liveCanary.source.branch, "same-repository-non-main", "main live exclusion");
  const reviewStrings = new Set(allStrings({
    automaticBindings: review.automaticReview.bindings,
    automaticRoutes: review.automaticReview.routes,
    automaticProtectedInputs: review.automaticReview.protectedInputs,
    liveResources: review.liveCanary.resources,
    liveUrls: review.liveCanary.reviewEvidence.mutableUrls,
  }));
  for (const identifier of productionIdentifiers(production, configurations))
    if (reviewStrings.has(identifier)) fail(`review contract reaches production identifier ${identifier}`);
  const productionInputs = new Set(Object.values(production.protectedInputs));
  for (const value of review.automaticReview.protectedInputs)
    if (productionInputs.has(value)) fail("automatic review exposes a production protected input");
  exactValue(review.liveCanary.credentialBoundary.productionAccount, false,
    "live review production credential isolation");
  for (const worker of review.liveCanary.resources.workers)
    for (const binding of worker.serviceBindings)
      if (production.workers.some(({ name }) => binding.includes(`:${name}#`)))
        fail("review Service Binding reaches production");
}

export function validateContract(review, production, configurations) {
  exactKeys(review, [
    "schemaVersion", "provider", "repository", "productionContract", "selectedMode",
    "automaticReview", "liveCanary", "reviewerBehavior",
  ], "review contract");
  exactValue(review.schemaVersion, 1, "review schema");
  exactValue(review.provider, "cloudflare-workers-builds", "review provider");
  exactValue(review.repository, "atrinik/metaserver-worker", "review repository");
  exactValue(review.productionContract, "deployment/workers-builds-production.json", "production contract path");
  exactValue(review.selectedMode, "single-connection-build-only-plus-operator-live-canary", "review mode");
  validateAutomaticReview(review.automaticReview);
  validateLiveCanary(review.liveCanary);
  if (!Array.isArray(configurations) || configurations.length !== 3)
    fail("review source configuration inventory drift");
  const roles = ["core", "publisher", "rendezvous"];
  const outside = configurations.map((config, index) => materializeReviewConfiguration(
    config, roles[index], review.liveCanary.configurationMaterialization, false));
  const inside = configurations.map((config, index) => materializeReviewConfiguration(
    config, roles[index], review.liveCanary.configurationMaterialization, true));
  exactArray(outside.map(({ vars }) => [vars.PUBLISH_ENABLED, vars.GAME_PUBLISH_ENABLED,
    vars.RENDEZVOUS_ENABLED]), [
    ["disabled", "disabled", "disabled"], ["disabled", "disabled", undefined],
    [undefined, undefined, "disabled"],
  ], "review outside-window materialized circuits");
  exactArray(inside.map(({ vars }) => [vars.PUBLISH_ENABLED, vars.GAME_PUBLISH_ENABLED,
    vars.RENDEZVOUS_ENABLED]), [
    ["enabled", "enabled", "enabled"], ["enabled", "enabled", undefined],
    [undefined, undefined, "enabled"],
  ], "review inside-window materialized circuits");
  exactValue(review.automaticReview.buildCommand,
    "cd ../.. && npm run review:build", "review pinned build command");
  exactKeys(review.reviewerBehavior, [
    "sameRepositoryPullRequest", "liveReview", "forkPullRequest", "rebaseOrForcePush", "rename",
    "mergeOrClose", "reopen", "overlap", "providerOutage", "manualEscape", "commentPolicy", "logPolicy",
  ], "reviewer behavior");
  const behavior = {
    sameRepositoryPullRequest: "automatic-build-only-check",
    liveReview: "maintainer-explicit-exact-sha-request-only",
    forkPullRequest: "github-repository-validation-only",
    rebaseOrForcePush: "new-sha-supersedes-old-build-and-old-live-request",
    rename: "source-sha-authoritative-branch-label-updated",
    mergeOrClose: "no-live-cleanup-singleton-circuits-remain-disabled",
    reopen: "new-head-build-only-check-live-request-not-restored",
    overlap: "branch-checks-have-no-provider-authority-single-live-cohort-uses-atomic-expiring-lease",
    providerOutage: "github-validation-remains-authoritative-no-production-fallback",
    manualEscape: "run-local-build-only-check-no-cloudflare-credentials-or-live-deploy",
    commentPolicy: "native-cloudflare-status-comment-with-history-no-preview-url-no-privileged-github-actions-comment",
    logPolicy: "private-redacted-provider-logs-and-bounded-digest-evidence",
  };
  for (const [key, expected] of Object.entries(behavior))
    exactValue(review.reviewerBehavior[key], expected, `review behavior ${key}`);
  validateProductionIsolation(review, production, configurations);
}

export function validateSourceCoordinates({ branch, sha, buildUuid }) {
  if (typeof branch !== "string" || !safeBranchPattern.test(branch))
    fail("review branch is main or malformed");
  if (!shaPattern.test(sha ?? "")) fail("review source SHA is malformed");
  if (!uuidPattern.test(buildUuid ?? "")) fail("review build UUID is malformed");
  return { branch, sha, buildUuid };
}

export function validateLiveApproval({ branch, sha, runUuid, githubMatches, checkoutClean, mainReachable }) {
  if (typeof branch !== "string" || !safeBranchPattern.test(branch))
    fail("live review branch is main or malformed");
  if (!shaPattern.test(sha ?? "")) fail("live review source SHA is malformed");
  if (!runUuidPattern.test(runUuid ?? "")) fail("live review run UUID is malformed");
  if (githubMatches !== true || checkoutClean !== true || mainReachable !== false)
    fail("live review requires exact non-main GitHub and clean-checkout proof");
  return { branch, sha, runUuid };
}

async function gitOutput(args) {
  const { stdout } = await execFileAsync("git", args, { cwd: root, encoding: "utf8" });
  return stdout.trim();
}

export async function runBranchCheck(environment = process.env) {
  const source = validateSourceCoordinates({
    branch: environment.WORKERS_CI_BRANCH,
    sha: environment.WORKERS_CI_COMMIT_SHA,
    buildUuid: environment.WORKERS_CI_BUILD_UUID,
  });
  const head = await gitOutput(["rev-parse", "HEAD"]);
  if (head !== source.sha) fail("review checkout does not match source SHA");
  const childEnvironment = Object.fromEntries(["PATH", "HOME", "TMPDIR", "LANG", "CI", "NO_COLOR"]
    .filter((name) => environment[name] !== undefined).map((name) => [name, environment[name]]));
  const deadline = Date.now() + 15 * 60 * 1000;
  let outputBytes = 0;
  for (const stage of branchCheckStages) {
    try {
      const { stdout, stderr } = await execFileAsync("npm", ["run", stage], {
        cwd: root, encoding: "utf8", env: childEnvironment,
        timeout: Math.max(1, deadline - Date.now()), maxBuffer: 8 * 1024 * 1024,
      });
      outputBytes += Buffer.byteLength(stdout) + Buffer.byteLength(stderr);
    } catch (error) {
      fail(describeBranchCheckFailure(stage, error));
    }
  }
  return { outcome: "review-build-only-passed", branch: source.branch, sourceSha: source.sha,
    buildUuid: source.buildUuid, outputBytes };
}

export function describeBranchCheckFailure(stage, error) {
  if (!branchCheckStages.includes(stage)) fail("unknown review check stage");
  const stdoutBytes = Buffer.byteLength(typeof error?.stdout === "string" ? error.stdout : "");
  const stderrBytes = Buffer.byteLength(typeof error?.stderr === "string" ? error.stderr : "");
  const kind = error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "output-limit"
    : error?.killed === true ? "timeout"
      : error?.signal ? "signal" : "exit";
  const code = Number.isInteger(error?.code) ? String(error.code) : "none";
  const signal = typeof error?.signal === "string" ? error.signal : "none";
  return `review check stage ${stage} failed: kind=${kind} code=${code} signal=${signal} stdoutBytes=${stdoutBytes} stderrBytes=${stderrBytes}`;
}

async function loadContractInputs() {
  return {
    review: await readJson(contractPath),
    production: await readJson(productionContractPath),
    package: await readJson(resolve(root, "package.json")),
    configurations: await Promise.all([
      "wrangler.jsonc", "wrangler.publisher.jsonc", "wrangler.rendezvous.jsonc",
    ].map((path) => readJsonc(resolve(root, path)))),
  };
}

export async function validateCheckedInContract() {
  const inputs = await loadContractInputs();
  validateContract(inputs.review, inputs.production, inputs.configurations);
  validateReviewBuildEntrypoint(inputs.package.scripts, inputs.production);
  for (const path of inputs.review.liveCanary.resources.d1.referenceVectorSources)
    await readFile(resolve(root, path));
  const coordination = inputs.review.liveCanary.resources.coordinationD1;
  const schema = await readFile(resolve(root, coordination.schemaPath));
  if (createHash("sha256").update(schema).digest("hex") !== coordination.schemaSha256)
    fail("review coordination schema digest drift");
  const operations = await readFile(resolve(root, coordination.operationsPath));
  if (createHash("sha256").update(operations).digest("hex") !== coordination.operationsSha256)
    fail("review coordination operations digest drift");
  const bootstrap = inputs.review.automaticReview.bootstrap;
  for (const [path, digest] of [
    [bootstrap.configPath, bootstrap.configSha256], [bootstrap.sourcePath, bootstrap.sourceSha256],
    ...inputs.review.liveCanary.configurationMaterialization.sources
      .map(({ path, sha256 }) => [path, sha256]),
  ]) {
    const bytes = await readFile(resolve(root, path));
    if (createHash("sha256").update(bytes).digest("hex") !== digest)
      fail(`review checked-in input digest drift: ${path}`);
  }
  return inputs.review;
}

async function main() {
  const mode = process.argv[2] ?? "--validate-only";
  const contract = await validateCheckedInContract();
  if (mode === "--validate-only") {
    process.stdout.write(`${JSON.stringify({ outcome: "review-contract-valid", mode: contract.selectedMode })}\n`);
    return;
  }
  if (mode === "--dry-run") {
    process.stdout.write(`${JSON.stringify({ outcome: "review-plan-valid", mutation: false,
      automatic: "build-only", live: "explicit-exact-sha", maximumConcurrentCohorts: 1 })}\n`);
    return;
  }
  if (mode === "--branch") {
    process.stdout.write(`${JSON.stringify(await runBranchCheck())}\n`);
    return;
  }
  if (mode === "--reject-sentinel") fail("reserved review sentinel never executes repository code");
  if (mode === "--live-not-provisioned") fail("live review provisioning is reserved for issue #56");
  fail("unknown review-environment mode");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    const reason = error instanceof ReviewEnvironmentError ? error.message : "unexpected-internal-error";
    process.stderr.write(`${JSON.stringify({ outcome: "review-environment-stopped", reason })}\n`);
    process.exitCode = 1;
  });
