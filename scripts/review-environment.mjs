import { execFile } from "node:child_process";
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
const safeBranchPattern = /^(?!main$)(?!review-(?:build-only|live-canary)-sentinel$)[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u;

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
    "pathIncludes", "pathExcludes", "installCommand", "buildCommand", "deployCommand",
    "maximumBuildMinutes", "buildEnvironment", "protectedInputs", "bindings", "routes", "result", "forkPolicy",
    "tokenAuthority",
  ], "automatic review");
  exactKeys(value.accountBoundary, [
    "mode", "productionAccountReuse", "liveCanaryAccountReuse", "zones",
    "workersDevSubdomainEnabled", "resources",
  ], "review account boundary");
  exactValue(value.accountBoundary.mode, "dedicated-build-check-account", "review account mode");
  exactValue(value.accountBoundary.productionAccountReuse, false, "review production account isolation");
  exactValue(value.accountBoundary.liveCanaryAccountReuse, false, "review live account isolation");
  exactArray(value.accountBoundary.zones, [], "review account zones");
  exactValue(value.accountBoundary.workersDevSubdomainEnabled, false, "review account workers.dev");
  exactArray(value.accountBoundary.resources, ["atrinik-metaserver-review-check-build-project"], "review account resources");
  exactValue(value.project, "atrinik-metaserver-review-check", "review project");
  exactValue(value.rootDirectory, "", "review root");
  exactValue(value.productionBranch, "review-build-only-sentinel", "review sentinel");
  exactValue(value.productionAutomaticPush, false, "review automatic production push");
  exactValue(value.productionDeployCommand, "npm run review:reject-sentinel", "review sentinel command");
  exactArray(value.previewBranchIncludes, ["*"], "review branch includes");
  exactArray(value.previewBranchExcludes, ["main", "review-build-only-sentinel"], "review branch excludes");
  exactArray(value.pathIncludes, ["*"], "review path includes");
  exactArray(value.pathExcludes, [], "review path excludes");
  exactValue(value.buildCommand, "npm run review:branch", "review build command");
  exactValue(value.deployCommand, "npm run review:validate", "review deploy command");
  exactValue(value.maximumBuildMinutes, 15, "review build duration");
  exactKeys(value.buildEnvironment, ["SKIP_DEPENDENCY_INSTALL"], "review build environment");
  exactValue(value.buildEnvironment.SKIP_DEPENDENCY_INSTALL, "1", "review dependency policy");
  exactArray(value.protectedInputs, [], "review protected inputs");
  exactArray(value.bindings, [], "review bindings");
  exactArray(value.routes, [], "review routes");
  exactKeys(value.result, ["githubCheck", "githubComment", "reviewUrl", "workerVersion", "workerLogs"], "review result");
  if (JSON.stringify(value.result) !== JSON.stringify({
    githubCheck: true, githubComment: false, reviewUrl: null, workerVersion: false, workerLogs: false,
  })) fail("review result drift");
  exactValue(value.forkPolicy, "github-repository-validation-only-no-workers-build", "fork policy");
  exactValue(value.tokenAuthority, "dedicated-build-check-account-only", "review token authority");
  if (!value.installCommand.includes("env -i") || !value.installCommand.includes("--ignore-scripts") ||
      !value.installCommand.includes("npm@11.16.0")) fail("review install boundary drift");
}

function validateResources(resources) {
  exactKeys(resources, [
    "workers", "d1", "durableObjects", "r2", "analytics", "rateLimits",
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
  exactKeys(resources.d1, ["owner", "name", "binding", "migrationLedger", "reset", "fixtureSources"], "review D1");
  exactValue(resources.d1.name, "atrinik-metaserver-review-canary", "review D1 name");
  exactValue(resources.d1.owner, "core", "review D1 owner");
  exactValue(resources.d1.binding, "DB", "review D1 binding");
  exactValue(resources.d1.migrationLedger, "independent-exact-checked-in-ledger", "review migration ledger");
  exactValue(resources.d1.reset, "fresh-d1-or-reviewed-expiry-only-no-bulk-production-copy", "review reset plan");
  exactArray(resources.d1.fixtureSources, [
    "test/fixtures/metaserver-publisher-v1.json",
    "test/fixtures/metaserver-classic-publisher-v2.json",
    "test/fixtures/metaserver-game-publisher-v1.json",
  ], "review fixture sources");
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
  for (const item of resources.analytics)
    exactKeys(item, ["owner", "binding", "name"], "review analytics");
  for (const item of resources.rateLimits)
    exactKeys(item, ["owner", "binding", "namespace", "productionNamespaceReuse"], "review rate limit");
  exactArray(resources.rateLimits.map(({ namespace }) => namespace), [
    "review-canary-core-publish", "review-canary-core-rendezvous-server",
    "review-canary-publisher-global", "review-canary-rendezvous-global",
  ], "review rate namespaces");
  for (const rate of [...resources.rateLimits, resources.rendezvousClientRateLimit])
    exactValue(rate.productionNamespaceReuse, false, "review rate namespace isolation");
  exactKeys(resources.rendezvousClientRateLimit, [
    "owner", "binding", "namespace", "sharesRendezvousGlobalCeiling", "productionNamespaceReuse",
  ], "review client rate limit");
  exactValue(resources.rendezvousClientRateLimit.namespace, "review-canary-rendezvous-client", "review client rate namespace");
  exactValue(resources.rendezvousClientRateLimit.sharesRendezvousGlobalCeiling, true, "review rate ceiling accounting");
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
  exactArray(resources.hostnames.static, [
    "classic-directory.review.meta.atrinik.org", "game-directory.review.meta.atrinik.org",
  ], "review static hosts");
  exactArray(resources.hostnames.dynamic, [
    "publish.review.meta.atrinik.org", "rendezvous.review.meta.atrinik.org",
  ], "review dynamic hosts");
  exactValue(resources.hostnames.zone, "review.meta.atrinik.org", "review hostname zone");
  for (const key of ["workersDev", "previewUrls", "productionDnsAuthority", "productionRouteAuthority", "productionCachePurgeAuthority"])
    exactValue(resources.hostnames[key], false, `review hostname ${key}`);
  exactKeys(resources.edgePolicy, ["owner", "tls", "waf", "cache", "access", "productionRuleAuthority"], "review edge policy");
  for (const [key, expected] of Object.entries({
    owner: "review-canary-zone-only", tls: "full-strict", waf: "review-host-exact-envelopes",
    cache: "review-static-hosts-only", access: "single-review-canary-application",
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
    ...resources.rateLimits.map(({ namespace }) => namespace),
    resources.rendezvousClientRateLimit.namespace,
  ], "review rate namespace names");
}

export function validateLiveCanary(value) {
  exactKeys(value, [
    "accountBoundary", "automatic", "invocation", "project", "productionBranch", "automaticPush",
    "approvedGateVariable", "requestedCommitVariable", "deployCommand",
    "maximumBuildMinutes", "maximumLiveWindowMinutes", "maximumConcurrentCohorts", "lease", "stalePolicy", "deploymentOrder", "circuits",
    "access", "reviewEvidence", "resourceCeilings", "resources", "dataPolicy", "testPlan", "cleanup",
  ], "live canary");
  exactKeys(value.accountBoundary, [
    "mode", "productionAccountReuse", "buildCheckAccountReuse", "zone", "parentDnsAuthority",
  ], "live account boundary");
  exactValue(value.accountBoundary.mode, "dedicated-live-canary-account", "live account mode");
  exactValue(value.accountBoundary.productionAccountReuse, false, "live production account isolation");
  exactValue(value.accountBoundary.buildCheckAccountReuse, false, "live build-check account isolation");
  exactValue(value.accountBoundary.zone, "review.meta.atrinik.org", "live account zone");
  exactValue(value.accountBoundary.parentDnsAuthority, false, "live parent DNS authority");
  exactValue(value.automatic, false, "live automatic execution");
  exactValue(value.invocation, "manual-workers-builds-api-exact-commit", "live invocation");
  exactValue(value.project, "atrinik-metaserver-review-canary-core", "live project");
  exactValue(value.productionBranch, "review-live-canary-sentinel", "live sentinel");
  exactValue(value.automaticPush, false, "live automatic push");
  exactValue(value.approvedGateVariable, "ATRINIK_REVIEW_APPROVED_SHA", "live approval variable");
  exactValue(value.requestedCommitVariable, "WORKERS_CI_COMMIT_SHA", "live source variable");
  exactValue(value.deployCommand, "npm run deploy:review-canary", "live deploy command");
  exactValue(value.maximumBuildMinutes, 30, "live build duration");
  exactValue(value.maximumLiveWindowMinutes, 30, "live test window");
  exactValue(value.maximumConcurrentCohorts, 1, "live concurrency");
  exactValue(value.lease, "newest-approved-exact-sha-build-owns-single-cohort", "live lease");
  exactValue(value.stalePolicy, "cancel-before-mutation-and-recheck-exact-sha", "live stale policy");
  exactArray(value.deploymentOrder, ["core", "publisher", "rendezvous"], "live deploy order");
  exactKeys(value.circuits, ["staging", "final", "restoreOrder"], "live circuits");
  exactValue(value.circuits.staging, "disabled", "live staged circuit");
  exactValue(value.circuits.final, "disabled-unless-explicit-live-test-window", "live final circuit");
  exactArray(value.circuits.restoreOrder, ["publisher", "rendezvous", "core"], "live restore order");
  exactKeys(value.access, ["mode", "public", "urlsAreSecret", "websocket", "credentialStorage"], "live access");
  exactValue(value.access.mode, "cloudflare-access-service-token-or-interactive-session", "live access mode");
  exactValue(value.access.websocket, "access-session-or-service-token-headers-required", "live WebSocket access");
  exactValue(value.access.credentialStorage, "cloudflare-only-never-repository-or-comment", "live Access credential storage");
  exactValue(value.access.public, false, "live public access");
  exactValue(value.access.urlsAreSecret, false, "live URL boundary");
  exactKeys(value.reviewEvidence, ["immutableIdentifiers", "mutableUrls", "maximumRetentionDays", "contents"], "review evidence");
  exactArray(value.reviewEvidence.immutableIdentifiers, ["sourceCommit", "buildUuid", "deployableDigest"], "review identifiers");
  exactArray(value.reviewEvidence.mutableUrls, [
    "https://classic-directory.review.meta.atrinik.org",
    "https://game-directory.review.meta.atrinik.org",
    "https://publish.review.meta.atrinik.org",
    "https://rendezvous.review.meta.atrinik.org",
  ], "review URLs");
  exactValue(value.reviewEvidence.maximumRetentionDays, 7, "review evidence retention");
  exactValue(value.reviewEvidence.contents, "closed-outcome-digests-counts-and-resource-names-only", "review evidence contents");
  const ceilings = value.resourceCeilings;
  exactKeys(ceilings, [
    "workers", "d1Databases", "durableObjectNamespaces", "r2Buckets", "analyticsDatasets",
    "rateLimitNamespaces", "customHostnames", "accessApplications", "cohortLifetime", "quarterlyReprovisionRequired",
  ], "review resource ceilings");
  const expectedCeilings = { workers: 3, d1Databases: 1, durableObjectNamespaces: 2, r2Buckets: 3,
    analyticsDatasets: 2, rateLimitNamespaces: 5, customHostnames: 4, accessApplications: 1 };
  for (const [key, expected] of Object.entries(expectedCeilings)) exactValue(ceilings[key], expected, `review ${key} ceiling`);
  exactValue(ceilings.cohortLifetime, "long-lived-singleton", "review cohort lifetime");
  exactValue(ceilings.quarterlyReprovisionRequired, true, "review reprovision policy");
  validateResources(value.resources);
  exactKeys(value.dataPolicy, [
    "productionCopies", "liveRequestCopies", "credentials", "realServerIdentities",
    "rendezvousStateCopies", "fixturePrefix", "fixtureIdentityDerivation", "fixtureMaximumAgeHours",
    "isolationBeforeEveryRun", "disableCircuitsAfterEveryRun",
  ], "review data policy");
  for (const key of ["productionCopies", "liveRequestCopies", "credentials", "realServerIdentities", "rendezvousStateCopies"])
    exactValue(value.dataPolicy[key], false, `review data ${key}`);
  exactValue(value.dataPolicy.isolationBeforeEveryRun, "unique-fixture-namespace-and-no-unexpired-collision", "review fixture isolation");
  exactValue(value.dataPolicy.disableCircuitsAfterEveryRun, true, "review circuit cleanup");
  exactValue(value.dataPolicy.fixturePrefix, "review-canary-fixture-", "review fixture namespace");
  exactValue(value.dataPolicy.fixtureIdentityDerivation, "sha256(review-cohort-source-sha-build-uuid-vector-name)", "review fixture identity derivation");
  exactValue(value.dataPolicy.fixtureMaximumAgeHours, 24, "review fixture retention");
  exactArray(value.testPlan, [
    "validate-source-and-approved-exact-sha-before-provider-read",
    "acquire-single-cohort-lease-and-suppress-stale-builds",
    "disable-all-circuits-and-read-back",
    "prove-isolated-empty-state-and-apply-exact-migration-ledger",
    "seed-deterministic-nonproduction-fixtures",
    "deploy-core-then-publisher-then-rendezvous",
    "read-back-same-cohort-service-bindings-and-resource-identifiers",
    "run-static-dynamic-websocket-replay-migration-and-redaction-canaries",
    "disable-all-circuits-and-prove-closed-read-back",
    "expire-fixtures-and-record-bounded-closed-evidence",
  ], "review executable test plan");
  exactKeys(value.cleanup, [
    "owner", "automaticOnBranchEvent", "normal", "fullOrder", "guards",
    "partialFailure", "evidenceMaximumRetentionDays",
  ], "review cleanup");
  exactValue(value.cleanup.owner, "metaserver-review-environment-operator", "review cleanup owner");
  exactValue(value.cleanup.automaticOnBranchEvent, false, "review branch cleanup");
  exactValue(value.cleanup.normal, "disable-circuits-expire-fixtures-retain-singleton", "review normal cleanup");
  exactArray(value.cleanup.fullOrder, [
    "disable-circuits", "detach-review-hostnames-and-access", "delete-caller-workers",
    "delete-core-worker", "delete-review-r2-d1-analytics-and-rate-resources", "delete-review-build-projects",
  ], "review full cleanup order");
  exactArray(value.cleanup.guards, [
    "exact-review-prefix", "exact-account", "exact-resource-inventory", "no-production-identifier-match",
    "no-unowned-resource", "preview-before-apply", "recheck-disabled-circuits",
  ], "review cleanup guards");
  exactValue(value.cleanup.partialFailure, "stop-record-completed-prefix-leave-circuits-disabled-retry-from-readback", "review partial cleanup");
  exactValue(value.cleanup.evidenceMaximumRetentionDays, 7, "review cleanup evidence retention");
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
  exactValue(review.liveCanary.productionBranch === "main", false, "main live exclusion");
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
  exactValue(review.selectedMode, "build-only-plus-explicit-reusable-live-canary", "review mode");
  validateAutomaticReview(review.automaticReview);
  validateLiveCanary(review.liveCanary);
  exactValue(review.automaticReview.installCommand, production.installCommand, "review pinned install command");
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
    overlap: "newest-exact-sha-build-owns-branch-check-single-live-cohort-serialized",
    providerOutage: "github-validation-remains-authoritative-no-production-fallback",
    manualEscape: "run-local-build-only-check-no-cloudflare-credentials-or-live-deploy",
    commentPolicy: "no-privileged-github-actions-comment",
    logPolicy: "private-redacted-provider-logs-and-bounded-digest-evidence",
  };
  for (const [key, expected] of Object.entries(behavior))
    exactValue(review.reviewerBehavior[key], expected, `review behavior ${key}`);
  validateProductionIsolation(review, production, configurations);
}

export function validateSourceCoordinates({ branch, sha, buildUuid, event, fork }) {
  if (event !== "push") fail("Workers Builds review requires a same-repository push");
  if (fork === true) fail("forks cannot enter Workers Builds review");
  if (typeof branch !== "string" || !safeBranchPattern.test(branch))
    fail("review branch is main, reserved, or malformed");
  if (!shaPattern.test(sha ?? "")) fail("review source SHA is malformed");
  if (!uuidPattern.test(buildUuid ?? "")) fail("review build UUID is malformed");
  return { branch, sha, buildUuid };
}

export function validateLiveApproval({ branch, sha, approvedSha, fork }) {
  if (fork === true) fail("forks cannot request live review");
  if (typeof branch !== "string" || !safeBranchPattern.test(branch))
    fail("live review branch is main, reserved, or malformed");
  if (!shaPattern.test(sha ?? "") || approvedSha !== sha)
    fail("live review requires the exact approved source SHA");
  return { branch, sha };
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
    event: environment.WORKERS_CI_EVENT ?? "push",
    fork: environment.WORKERS_CI_FORK === "true",
  });
  const head = await gitOutput(["rev-parse", "HEAD"]);
  if (head !== source.sha) fail("review checkout does not match source SHA");
  const { stdout, stderr } = await execFileAsync("npm", ["run", "check"], {
    cwd: root,
    encoding: "utf8",
    env: Object.fromEntries(["PATH", "HOME", "TMPDIR", "LANG", "CI", "NO_COLOR"]
      .filter((name) => environment[name] !== undefined).map((name) => [name, environment[name]])),
    timeout: 15 * 60 * 1000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return { outcome: "review-build-only-passed", branch: source.branch, sourceSha: source.sha,
    buildUuid: source.buildUuid, outputBytes: Buffer.byteLength(stdout) + Buffer.byteLength(stderr) };
}

async function loadContractInputs() {
  return {
    review: await readJson(contractPath),
    production: await readJson(productionContractPath),
    configurations: await Promise.all([
      "wrangler.jsonc", "wrangler.publisher.jsonc", "wrangler.rendezvous.jsonc",
    ].map((path) => readJsonc(resolve(root, path)))),
  };
}

export async function validateCheckedInContract() {
  const inputs = await loadContractInputs();
  validateContract(inputs.review, inputs.production, inputs.configurations);
  for (const path of inputs.review.liveCanary.resources.d1.fixtureSources)
    await readFile(resolve(root, path));
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
