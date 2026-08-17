import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, open, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
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
const reviewStagingRootPattern = /^\/review-build-only-staging-[0-9a-f]{32}$/u;
const gitShaPattern = /^[0-9a-f]{40}$/u;
const expectedSetupPlanSha256 = "a3281ab5632e6d66b7d5ada015420ab0d387250e446a4d0830abc204b9dc0cca";
const currentMainProofSource = "authenticated-gh-api-current-main-readback";
const currentMainProofEndpoint = "repos/atrinik/metaserver-worker/git/ref/heads/main";
const currentMainRef = "refs/heads/main";
const reviewActivationAuthorityLifetimeMs = 30 * 60_000;
const reviewActivationTransitionBudgetMs = 5 * 60_000;
const disposableReviewAuthorityLifetimeMs = 60 * 60_000;
const disposableReviewPushReserveMs = 40 * 60_000;
const reviewActivationPredecessorPlanDigest =
  "fb95bcc4e693b6f933dc1bb788b736100dbd6a24c5b601e3533a03097d091892";
const currentMainRepository = Object.freeze({ owner: "atrinik", name: "metaserver-worker" });
const githubRepository = Object.freeze({
  provider_account_id: "6371603",
  provider_account_name: "atrinik",
  provider_type: "github",
  repo_id: "1324297032",
  repo_name: "metaserver-worker",
});
const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
const execFileAsync = promisify(execFile);

export class WorkersBuildsProvisioningError extends Error {}

function fail(message) {
  throw new WorkersBuildsProvisioningError(message);
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameCanonical(left, right) {
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(
      Object.entries(value).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
        .map(([key, item]) => [key, canonical(item)]));
    return value;
  };
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function isUtcTimestamp(value) {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/u
    .exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText,
    fractionText = "0"] = match;
  const [year, month, day, hour, minute, second, milliseconds] = [
    Number(yearText), Number(monthText), Number(dayText), Number(hourText),
    Number(minuteText), Number(secondText), Number(fractionText.padEnd(3, "0")),
  ];
  if (year < 2000 || month < 1 || month > 12 || day < 1 || day > 31 ||
      hour > 23 || minute > 59 || second > 59) return false;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second, milliseconds));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day && date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute && date.getUTCSeconds() === second &&
    date.getUTCMilliseconds() === milliseconds;
}

function digestJson(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function digestText(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function validateReviewedSourceCoordinates({ expected, head, dirty, currentMain }) {
  if (!gitShaPattern.test(expected ?? "") || !gitShaPattern.test(head ?? "") ||
      !gitShaPattern.test(currentMain ?? "") || expected !== head || head !== currentMain ||
      dirty !== "")
    fail("reviewed source is not the exact clean current GitHub main checkout");
  return head;
}

export function validateCurrentMainProof(proof, sourceSha, now = Date.now()) {
  const keys = ["capturedAt", "endpoint", "raw", "ref", "repository", "sha", "source"];
  const rawKeys = ["node_id", "object", "ref", "url"];
  const objectKeys = ["sha", "type", "url"];
  const captured = Date.parse(proof?.capturedAt ?? "");
  const sha = proof?.sha;
  if (!proof || !same(sorted(Object.keys(proof)), keys) ||
      proof.source !== currentMainProofSource || proof.endpoint !== currentMainProofEndpoint ||
      !proof.repository ||
      !same(sorted(Object.keys(proof.repository)), sorted(Object.keys(currentMainRepository))) ||
      proof.repository.owner !== currentMainRepository.owner ||
      proof.repository.name !== currentMainRepository.name || proof.ref !== currentMainRef ||
      !gitShaPattern.test(sha ?? "") || sha !== sourceSha ||
      !isUtcTimestamp(proof.capturedAt) || !Number.isFinite(captured) ||
      captured > now + 30_000 || now - captured > 5 * 60_000 ||
      !proof.raw || !same(sorted(Object.keys(proof.raw)), rawKeys) ||
      proof.raw.ref !== currentMainRef ||
      typeof proof.raw.node_id !== "string" ||
      !/^[A-Za-z0-9_=-]{1,256}$/u.test(proof.raw.node_id) ||
      proof.raw.url !==
        "https://api.github.com/repos/atrinik/metaserver-worker/git/refs/heads/main" ||
      !proof.raw.object || !same(sorted(Object.keys(proof.raw.object)), objectKeys) ||
      proof.raw.object.sha !== sha || proof.raw.object.type !== "commit" ||
      proof.raw.object.url !==
        `https://api.github.com/repos/atrinik/metaserver-worker/git/commits/${sha}`)
    fail("authenticated GitHub current main proof is stale or malformed");
  return sha;
}

export async function readCurrentMainProof(environment, sourceSha, now = Date.now()) {
  const proof = await readPrivateJson(environment.ATRINIK_GITHUB_CURRENT_MAIN_PROOF_FILE,
    "authenticated GitHub current main proof");
  validateCurrentMainProof(proof, sourceSha, now);
  return proof;
}

async function reviewedSourceSha() {
  const expected = await readPrivateValue(process.env.ATRINIK_REVIEWED_SOURCE_SHA_FILE,
    "reviewed source SHA", gitShaPattern);
  const options = { cwd: root, encoding: "utf8", timeout: 10_000,
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" } };
  let head;
  let dirty;
  try {
    ({ stdout: head } = await execFileAsync("git", ["rev-parse", "HEAD"], options));
    ({ stdout: dirty } = await execFileAsync("git",
      ["status", "--porcelain=v1", "--untracked-files=all"], options));
  } catch { fail("reviewed source checkout proof failed"); }
  head = head.trim();
  return { expected, head, dirty };
}

async function reviewedCurrentMainSha(environment = process.env, now = Date.now()) {
  const coordinates = await reviewedSourceSha();
  const proof = await readCurrentMainProof(environment, coordinates.head, now);
  return validateReviewedSourceCoordinates({ ...coordinates,
    currentMain: proof.sha });
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

export function initialBootstrapPredecessorConfiguration(contract, config, worker) {
  const predecessor = structuredClone(config);
  const policy = contract.initialBootstrapPredecessor;
  if (policy?.requiredPhase !== "all-builds-triggers-absent" ||
      !Array.isArray(policy.allowedBindingDelta))
    fail("initial production bootstrap predecessor is malformed");
  for (const delta of policy.allowedBindingDelta.filter(({ role }) => role === worker.role)) {
    if (!same(sorted(Object.keys(delta)), ["desired", "live", "name", "role", "type"]) ||
        delta.type !== "plain_text" || typeof delta.live !== "string" ||
        predecessor.vars?.[delta.name] !== delta.desired)
      fail("initial production bootstrap predecessor binding delta drift");
    if (delta.live === "absent") delete predecessor.vars[delta.name];
    else predecessor.vars[delta.name] = delta.live;
  }
  return predecessor;
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

export function validateSentinelRefAbsence(proof, now = Date.now()) {
  const { repository, branch, refs, capturedAt } = proof ?? {};
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

export function validateDistinctSentinelRefAbsence(productionProof, reviewProof,
  now = Date.now()) {
  const production = validateSentinelRefAbsence(productionProof, now);
  const review = validateSentinelRefAbsence(reviewProof, now);
  if (production.branch === review.branch)
    fail("production and review staging sentinel branches must be distinct");
  return { production, review };
}

export function validateReviewStagingRootAbsence(proof, rootDirectory, sourceSha,
  expectedPhase, now = Date.now()) {
  const keys = ["absenceChecks", "branches", "capturedAt", "currentMainSha", "pagination",
    "phase", "repository", "rootDirectory", "source"];
  if (!reviewStagingRootPattern.test(rootDirectory ?? "") ||
      !proof || !same(sorted(Object.keys(proof)), sorted(keys)) ||
      proof.source !== "github-complete-branch-root-absence-readback" ||
      !["create", "activation"].includes(expectedPhase) || proof.phase !== expectedPhase ||
      !same(proof.repository, githubRepository) || proof.rootDirectory !== rootDirectory ||
      proof.currentMainSha !== sourceSha || !gitShaPattern.test(sourceSha ?? ""))
    fail("review staging root absence proof identity is malformed");
  const captured = Date.parse(proof.capturedAt ?? "");
  if (!Number.isFinite(captured) || captured > now + 30_000 || now - captured > 5 * 60_000)
    fail("review staging root absence proof is stale");
  if (!Array.isArray(proof.branches) || !Array.isArray(proof.absenceChecks) ||
      proof.branches.length < 1 || proof.branches.length > 200)
    fail("review staging root branch inventory is incomplete");
  if (!proof.pagination || !same(sorted(Object.keys(proof.pagination)),
    ["hasNextPage", "pageCount", "totalCount"]) ||
      proof.pagination.hasNextPage !== false ||
      !Number.isSafeInteger(proof.pagination.pageCount) || proof.pagination.pageCount < 1 ||
      proof.pagination.pageCount > 10 || proof.pagination.totalCount !== proof.branches.length)
    fail("review staging root branch pagination is incomplete");
  const branchKeys = ["ref", "sha"];
  const branches = proof.branches.map((entry) => {
    if (!entry || !same(sorted(Object.keys(entry)), branchKeys) ||
        !/^refs\/heads\/[A-Za-z0-9._/-]{1,200}$/u.test(entry.ref ?? "") ||
        !gitShaPattern.test(entry.sha ?? ""))
      fail("review staging root branch inventory is malformed");
    return entry;
  });
  if (new Set(branches.map(({ ref }) => ref)).size !== branches.length ||
      branches.filter(({ ref, sha }) => ref === "refs/heads/main" && sha === sourceSha).length !== 1)
    fail("review staging root branch inventory is incomplete");
  const nonMain = branches.filter(({ ref }) => ref !== "refs/heads/main");
  const expectedPath = rootDirectory.slice(1);
  const checks = proof.absenceChecks.map((entry) => {
    if (!entry || !same(sorted(Object.keys(entry)), ["path", "ref", "sha", "status"]) ||
        entry.path !== expectedPath || entry.status !== 404)
      fail("review staging root absence check is malformed");
    return entry;
  });
  if (!same(checks.map(({ ref, sha }) => ({ ref, sha })),
    nonMain.map(({ ref, sha }) => ({ ref, sha }))))
    fail("review staging root absence checks are incomplete or reordered");
  return { outcome: "review-staging-root-absent", mutation: false, phase: expectedPhase,
    rootDirectory, sourceSha, capturedAt: proof.capturedAt, proof_digest: digestJson(proof) };
}

export function validateReviewStagingRootProofSequence(create, activation) {
  if (create?.phase !== "create" || activation?.phase !== "activation" ||
      create.rootDirectory !== activation.rootDirectory || create.sourceSha !== activation.sourceSha ||
      Date.parse(activation.capturedAt ?? "") <= Date.parse(create.capturedAt ?? "") ||
      activation.proof_digest === create.proof_digest)
    fail("review staging root activation proof was replayed from create phase");
  return { outcome: "review-staging-root-proof-sequence-valid", mutation: false,
    createProofDigest: create.proof_digest, activationProofDigest: activation.proof_digest };
}

export function validateRepositoryConnectionOwnerProof(proof, accountId, sourceSha,
  now = Date.now()) {
  const expectedKeys = ["accountId", "capturedAt", "connectionPreexisting", "repository",
    "source", "websitePreserved", "githubApp", "mainProtection"];
  const expectedApp = { appId: 85455, installationId: 152311798,
    evidenceLocation: "atrinik/metaserver-worker#66-private-provider-evidence",
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

function validateBuildUsageProof(review, buildUsageProof, accountId, now = Date.now()) {
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
  return buildUsageProof;
}

function reviewActivationEvidenceDigests({ stagedProof, repositoryConnectionProof,
  productionSentinelProof, tokenAuthorityProofs, buildUsageProof }) {
  return {
    stagedProofFile: digestJson(stagedProof),
    repositoryOwner: digestJson(repositoryConnectionProof),
    productionSentinel: digestJson(productionSentinelProof),
    tokenAuthority: Object.fromEntries(tokenAuthorityProofs.map((proof) =>
      [proof.kind, digestJson(proof)])),
    buildUsage: digestJson(buildUsageProof),
  };
}

function validateReviewActivationJournal(records, reviewActivationProof, predecessorSourceSha) {
  if (!Array.isArray(records) || records.length === 0) fail("review activation journal is absent");
  const expected = [
    ["attempt-started", "review-trigger-activation"],
    ["current-main-proof-bound", "fresh-staged-readback"],
    ["current-main-proof-bound", "fresh-staged-verify"],
    ["current-main-proof-bound", "fresh-staged-proof-verify"],
    ["current-main-proof-bound", "review-activation-authority-issue"],
    ["review-gate-preflight-proven", undefined],
    ["current-main-proof-bound", "review-root-create-validate"],
    ["github-proof-bound", "review-root-create"],
    ["review-gate-authorized", undefined],
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
    ["review-trigger-active", undefined],
  ];
  if (!same(records.map(({ event, operation }) => [event, operation]), expected))
    fail("review activation journal operation sequence drift");
  let previousAt = -Infinity;
  for (const record of records) {
    const { recordSha256, ...payload } = record ?? {};
    const at = Date.parse(record?.at ?? "");
    if (!/^[0-9a-f]{64}$/u.test(recordSha256 ?? "") || digestJson(payload) !== recordSha256 ||
        !Number.isFinite(at) || !isUtcTimestamp(record.at) || at <= previousAt ||
        record.attempt !== 1)
      fail("review activation journal checksum drift");
    previousAt = at;
  }
  const first = records[0];
  const terminal = records.at(-1);
  const proofBound = [...records].reverse().find(({ event, operation }) =>
    event === "provider-proof-bound" && operation === "review-activation");
  const preflight = records.find(({ event }) => event === "review-gate-preflight-proven");
  const mutation = (event, operation) => records.find((record) =>
    record.event === event && record.operation === operation);
  const reviewTriggerUuid = terminal.reviewTrigger;
  const mutationSemantics = [
    ["review-trigger-create", "POST", "/builds/triggers"],
    ["review-environment", "PATCH",
      `/builds/triggers/${reviewTriggerUuid}/environment_variables`],
    ["review-trigger-activate", "PATCH", `/builds/triggers/${reviewTriggerUuid}`],
  ];
  const mutationsValid = mutationSemantics.every(([operation, method, path]) => {
    const intent = mutation("mutation-intent", operation);
    const classification = mutation("provider-response-classified", operation);
    const bound = mutation("mutation-bound", operation);
    return intent?.method === method && intent.path === path &&
      /^[0-9a-f]{64}$/u.test(intent.requestDigestSha256 ?? "") &&
      classification?.outcome === "explicit-success" &&
      (operation !== "review-trigger-create" || classification.resourceUuid === reviewTriggerUuid) &&
      bound?.resourceUuid === reviewTriggerUuid && bound.providerResponseExplicitSuccess === true &&
      bound.requestDigestSha256 === intent.requestDigestSha256 &&
      /^[0-9a-f]{64}$/u.test(bound.readbackDigestSha256 ?? "");
  });
  const currentMainValid = records.filter(({ event }) => event === "current-main-proof-bound")
    .every(({ sourceSha, proofFileSha256, rawFileSha256 }) =>
      sourceSha === predecessorSourceSha && /^[0-9a-f]{64}$/u.test(proofFileSha256 ?? "") &&
      /^[0-9a-f]{64}$/u.test(rawFileSha256 ?? ""));
  const authorityDigest = preflight?.reviewActivationAuthorityDigest;
  const authorityChecksValid = /^[0-9a-f]{64}$/u.test(authorityDigest ?? "") &&
    records.filter(({ event }) => event === "review-activation-authority-checked")
      .every(({ proofDigest, expiresAt }) => proofDigest === authorityDigest &&
        isUtcTimestamp(expiresAt));
  if (first.event !== "attempt-started" || first.sourceSha !== predecessorSourceSha ||
      first.planDigestSha256 !== reviewActivationPredecessorPlanDigest ||
      terminal.event !== "review-trigger-active" ||
      !uuidPattern.test(terminal.reviewTrigger ?? "") ||
      terminal.reviewActivationProofDigest !== reviewActivationProof?.proof_digest ||
      terminal.productionActivation !== false || terminal.migration0010 !== false ||
      terminal.initialProductionBuild !== false ||
      records.some(({ event }) => event.startsWith("rollback")) ||
      proofBound?.proofDigest !== reviewActivationProof?.proof_digest ||
      proofBound?.proofFileSha256 !== digestJson(reviewActivationProof) ||
      Date.parse(reviewActivationProof?.capturedAt ?? "") > Date.parse(proofBound?.at ?? "") ||
      Date.parse(proofBound?.at ?? "") > Date.parse(terminal.at) ||
      preflight?.sourceSha !== predecessorSourceSha ||
      preflight?.planDigestSha256 !== reviewActivationPredecessorPlanDigest ||
      !mutationsValid || !currentMainValid || !authorityChecksValid)
    fail("review activation journal terminal provenance drift");
  return { digest: digestJson(records), reviewTriggerUuid: terminal.reviewTrigger,
    terminalAt: terminal.at, predecessorPlanDigest: first.planDigestSha256,
    predecessorSourceSha, preflight };
}

function validateInertSetupProvenance(records, setupResults, activationPreflight) {
  if (!Array.isArray(records) || records.length === 0 || !setupResults || !activationPreflight)
    fail("inert setup predecessor evidence is absent");
  const expected = [
    ["preflight-proven", "execution-preflight"], ["setup-authorized", undefined],
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
    ["staged-readback-proven", "staged-readback"], ["inert-setup-complete", undefined],
  ];
  if (!same(records.map(({ event, operation }) => [event, operation]), expected) ||
      !same(sorted(Object.keys(setupResults)), sorted(["planDigest", "productionBuildToken",
        "productionTrigger", "repositoryConnection", "reviewBuildToken", "sourceSha",
        "stagedProofDigest"])))
    fail("inert setup predecessor operation sequence drift");
  let previousAt = -Infinity;
  for (const record of records) {
    const { recordSha256, ...payload } = record ?? {};
    const at = Date.parse(record?.at ?? "");
    if (!/^[0-9a-f]{64}$/u.test(recordSha256 ?? "") ||
        digestJson(payload) !== recordSha256 || !Number.isFinite(at) || at <= previousAt ||
        record.at !== new Date(at).toISOString() || record.attempt !== 1)
      fail("inert setup predecessor journal drift");
    previousAt = at;
  }
  const terminal = records.at(-1);
  const resource = (operation) => [...records].reverse().find(({ event, operation: value }) =>
    event === "mutation-bound" && value === operation)?.resourceUuid;
  const setupAuthorized = records.find(({ event }) => event === "setup-authorized");
  const setupMutationSemantics = [
    ["repository-connection", "PUT", "/builds/repos/connections"],
    ["production-build-token", "POST", "/builds/tokens"],
    ["review-build-token", "POST", "/builds/tokens"],
    ["production-trigger-staged", "POST", "/builds/triggers"],
    ["production-environment", "PATCH",
      `/builds/triggers/${setupResults.productionTrigger}/environment_variables`],
  ];
  const setupMutationsValid = setupMutationSemantics.every(([operation, method, path]) => {
    const intent = records.find((record) => record.event === "mutation-intent" &&
      record.operation === operation);
    const bound = records.find((record) => record.event === "mutation-bound" &&
      record.operation === operation);
    const classification = records.find((record) =>
      record.event === "provider-response-classified" && record.operation === operation);
    const expectedUuid = operation === "repository-connection" ? setupResults.repositoryConnection :
      operation === "production-build-token" ? setupResults.productionBuildToken :
        operation === "review-build-token" ? setupResults.reviewBuildToken :
          setupResults.productionTrigger;
    return intent?.method === method && intent.path === path &&
      /^[0-9a-f]{64}$/u.test(intent.requestDigestSha256 ?? "") &&
      bound?.resourceUuid === expectedUuid && bound.providerResponseExplicitSuccess === true &&
      bound.requestDigestSha256 === intent.requestDigestSha256 &&
      /^[0-9a-f]{64}$/u.test(bound.readbackDigestSha256 ?? "") &&
      (operation === "repository-connection" ||
        (classification?.outcome === "explicit-success" &&
          (operation === "production-environment" || classification.resourceUuid === expectedUuid)));
  });
  if (terminal.event !== "inert-setup-complete" || records.some(({ event }) =>
    event.startsWith("rollback")) || terminal.activation !== false ||
      terminal.migration0010 !== false || terminal.initialProductionBuild !== false ||
      setupResults.sourceSha !== "815076d3d69d358e3b265025d94a9151b9542b96" ||
      setupResults.planDigest !== "856f64dc2027a81ed5fcd7d85b687680e01c950400dbf8965ea40c076b09eb34" ||
      setupAuthorized?.sourceSha !== setupResults.sourceSha ||
      setupAuthorized?.planDigestSha256 !== setupResults.planDigest || !setupMutationsValid ||
      terminal.stagedProofDigest !== setupResults.stagedProofDigest ||
      resource("repository-connection") !== setupResults.repositoryConnection ||
      resource("production-build-token") !== setupResults.productionBuildToken ||
      resource("review-build-token") !== setupResults.reviewBuildToken ||
      resource("production-trigger-staged") !== setupResults.productionTrigger ||
      activationPreflight.setupJournalSha256 !== digestText(
        records.map((record) => JSON.stringify(record)).join("\n")) ||
      activationPreflight.setupResultsSha256 !== digestJson(setupResults))
    fail("inert setup predecessor terminal provenance drift");
  return { journalDigest: activationPreflight.setupJournalSha256,
    resultsDigest: activationPreflight.setupResultsSha256,
    productionTriggerUuid: setupResults.productionTrigger,
    productionBuildTokenUuid: setupResults.productionBuildToken,
    reviewBuildTokenUuid: setupResults.reviewBuildToken,
    repositoryConnectionUuid: setupResults.repositoryConnection,
    stagedProofDigest: setupResults.stagedProofDigest };
}

function validateDisposableReviewCoordinate(coordinate, sourceSha, now = Date.now()) {
  const keys = ["authorEmail", "authorName", "branch", "capturedAt", "commit",
    "commitMetadataSha256", "commitSubject", "contentSha256", "executorSha256", "journalId",
    "journalInitialRecordCount", "parentSha", "proofBlobSha", "proofMode", "proofPath",
    "repository", "source", "sourceSha", "treeSha"];
  const captured = Date.parse(coordinate?.capturedAt ?? "");
  const expectedContentSha256 = digestText("issue-66 automatic review build proof\n");
  const expectedMetadataSha256 = digestJson(["test(deploy): verify issue 66 review build",
    "Atrinik Delivery", "delivery@atrinik.org", sourceSha]);
  if (!coordinate || !same(sorted(Object.keys(coordinate)), sorted(keys)) ||
      coordinate.source !== "journaled-disposable-review-coordinate" ||
      coordinate.repository !== "atrinik/metaserver-worker" || coordinate.sourceSha !== sourceSha ||
      !/^review\/issue-66-[a-z0-9-]{1,40}$/u.test(coordinate.branch ?? "") ||
      !gitShaPattern.test(coordinate.commit ?? "") || coordinate.commit === sourceSha ||
      coordinate.parentSha !== sourceSha || !gitShaPattern.test(coordinate.treeSha ?? "") ||
      !gitShaPattern.test(coordinate.proofBlobSha ?? "") ||
      coordinate.proofPath !== "deployment/review-check/.issue-66-build-proof" ||
      coordinate.proofMode !== "100644" || coordinate.contentSha256 !== expectedContentSha256 ||
      coordinate.commitSubject !== "test(deploy): verify issue 66 review build" ||
      coordinate.authorName !== "Atrinik Delivery" ||
      coordinate.authorEmail !== "delivery@atrinik.org" ||
      coordinate.commitMetadataSha256 !== expectedMetadataSha256 ||
      !/^[0-9a-f]{64}$/u.test(coordinate.executorSha256 ?? "") ||
      !/^[0-9a-f]{64}$/u.test(coordinate.journalId ?? "") ||
      coordinate.journalInitialRecordCount !== 0 ||
      !isUtcTimestamp(coordinate.capturedAt) || !Number.isFinite(captured) ||
      captured > now + 30_000 || now - captured > 5 * 60_000)
    fail("disposable review coordinate proof is stale or malformed");
  return coordinate;
}

function disposableReviewEvidenceDigests({ reviewActivationProof, reviewActivationJournal,
  inertSetupJournal, inertSetupResults, disposableCoordinate,
  currentReviewActiveProof,
  repositoryConnectionProof, productionSentinelProof, tokenAuthorityProofs, buildUsageProof }) {
  return {
    reviewActivationProofFile: digestJson(reviewActivationProof),
    reviewActivationJournal: digestJson(reviewActivationJournal),
    inertSetupJournal: digestJson(inertSetupJournal),
    inertSetupResults: digestJson(inertSetupResults),
    disposableCoordinate: digestJson(disposableCoordinate),
    currentReviewActiveProofFile: digestJson(currentReviewActiveProof),
    repositoryOwner: digestJson(repositoryConnectionProof),
    productionSentinel: digestJson(productionSentinelProof),
    tokenAuthority: Object.fromEntries(tokenAuthorityProofs.map((proof) =>
      [proof.kind, digestJson(proof)])),
    buildUsage: digestJson(buildUsageProof),
  };
}

const stagedSnapshotProofKeys = ["accountId", "capturedAt", "mutation", "outcome",
  "proof_digest", "snapshotCompletedAt", "snapshotStartedAt", "sourceSha", "state_digest",
  "stagedTriggerCount"];

function validateStagedSnapshotProofEvidence(proof, { accountId, sourceSha },
  now = Date.now(), maximumAgeMs = 5 * 60_000) {
  const captured = Date.parse(proof?.capturedAt ?? "");
  const started = Date.parse(proof?.snapshotStartedAt ?? "");
  const completed = Date.parse(proof?.snapshotCompletedAt ?? "");
  if (!proof || !same(sorted(Object.keys(proof)), sorted(stagedSnapshotProofKeys)) ||
      proof.outcome !== "workers-builds-staged-snapshot-valid" || proof.mutation !== false ||
      proof.accountId !== accountId || proof.sourceSha !== sourceSha ||
      proof.stagedTriggerCount !== 1 || !/^[0-9a-f]{64}$/u.test(proof.proof_digest ?? "") ||
      !/^[0-9a-f]{64}$/u.test(proof.state_digest ?? "") ||
      !isUtcTimestamp(proof.capturedAt) || !isUtcTimestamp(proof.snapshotStartedAt) ||
      !isUtcTimestamp(proof.snapshotCompletedAt) || !Number.isFinite(captured) ||
      !Number.isFinite(started) || !Number.isFinite(completed) || started > completed ||
      completed > captured || captured - completed > 5 * 60_000 ||
      completed - started > 5 * 60_000 || captured > now + 30_000 ||
      now - captured > maximumAgeMs || proof.proof_digest !== digestJson({
        state_digest: proof.state_digest, snapshotStartedAt: proof.snapshotStartedAt,
        snapshotCompletedAt: proof.snapshotCompletedAt, capturedAt: proof.capturedAt,
      }))
    fail("review activation authority staged proof drift");
  return { captured, started, completed };
}

function validateReviewActiveSnapshotProofEvidence(proof, { accountId, sourceSha },
  now = Date.now(), maximumAgeMs = 5 * 60_000) {
  const expected = { ...proof, outcome: "workers-builds-staged-snapshot-valid",
    stagedTriggerCount: 1 };
  validateStagedSnapshotProofEvidence(expected, { accountId, sourceSha }, now, maximumAgeMs);
  if (proof?.outcome !== "workers-builds-review-activation-snapshot-valid" ||
      proof?.stagedTriggerCount !== 2)
    fail("disposable review authority live proof drift");
  return proof;
}

function validateCurrentDisposableReviewSnapshotProof(proof, { accountId, sourceSha },
  now = Date.now()) {
  const identityKeys = ["productionBuildTokenUuid", "productionEnvironmentDigest",
    "productionTriggerUuid", "repositoryConnectionUuid", "reviewBuildTokenUuid",
    "reviewEnvironmentDigest", "reviewTriggerUuid"];
  const expectedKeys = [...stagedSnapshotProofKeys, "liveIdentities"];
  if (!proof || !same(sorted(Object.keys(proof)), sorted(expectedKeys)) ||
      !proof.liveIdentities ||
      !same(sorted(Object.keys(proof.liveIdentities)), sorted(identityKeys)) ||
      !Object.entries(proof.liveIdentities).every(([key, value]) =>
        key.endsWith("Digest") ? /^[0-9a-f]{64}$/u.test(value) : uuidPattern.test(value)) ||
      proof.liveIdentities.productionTriggerUuid === proof.liveIdentities.reviewTriggerUuid ||
      proof.liveIdentities.productionBuildTokenUuid === proof.liveIdentities.reviewBuildTokenUuid)
    fail("disposable review authority live identity proof drift");
  const withoutIdentities = { ...proof };
  delete withoutIdentities.liveIdentities;
  withoutIdentities.proof_digest = digestJson({ state_digest: proof.state_digest,
    snapshotStartedAt: proof.snapshotStartedAt,
    snapshotCompletedAt: proof.snapshotCompletedAt, capturedAt: proof.capturedAt });
  validateReviewActiveSnapshotProofEvidence(withoutIdentities, { accountId, sourceSha }, now,
    30_000);
  if (proof.proof_digest !== digestJson({ state_digest: proof.state_digest,
    snapshotStartedAt: proof.snapshotStartedAt, snapshotCompletedAt: proof.snapshotCompletedAt,
    capturedAt: proof.capturedAt, liveIdentities: proof.liveIdentities }))
    fail("disposable review authority live identity proof drift");
  return proof;
}

export function issueDisposableReviewAuthority({ production, review, accountId, sourceSha,
  reviewActivationProof, reviewActivationJournal, inertSetupJournal, inertSetupResults,
  disposableCoordinate, currentReviewActiveProof,
  repositoryConnectionProof,
  productionSentinelProof, tokenAuthorityProofs, buildUsageProof, tokenRows }, now = Date.now()) {
  validateRepositoryConnectionOwnerProof(repositoryConnectionProof, accountId, sourceSha, now);
  const sentinel = validateSentinelRefAbsence(productionSentinelProof, now);
  validateTokenAuthorityProofs({ production, review, accountId, proofs: tokenAuthorityProofs,
    tokenRows, sourceSha }, now);
  validateBuildUsageProof(review, buildUsageProof, accountId, now);
  if (buildUsageProof.monthlyMinutesUsed + review.automaticReview.providerBuildTimeoutMinutes >=
      buildUsageProof.alertAtMinutes)
    fail("disposable review authority lacks reserved build-minute budget");
  const predecessorSourceSha = reviewActivationProof?.sourceSha;
  if (!gitShaPattern.test(predecessorSourceSha ?? ""))
    fail("disposable review authority predecessor source drift");
  validateReviewActiveSnapshotProofEvidence(reviewActivationProof,
    { accountId, sourceSha: predecessorSourceSha },
    Date.parse(reviewActivationProof?.capturedAt ?? ""), 0);
  const journal = validateReviewActivationJournal(reviewActivationJournal,
    reviewActivationProof, predecessorSourceSha);
  const setupProvenance = validateInertSetupProvenance(inertSetupJournal, inertSetupResults,
    journal.preflight);
  const coordinate = validateDisposableReviewCoordinate(disposableCoordinate, sourceSha, now);
  validateCurrentDisposableReviewSnapshotProof(currentReviewActiveProof,
    { accountId, sourceSha }, now);
  if (Date.parse(currentReviewActiveProof.snapshotStartedAt) <
      Date.parse(journal.terminalAt))
    fail("disposable review authority observations overlap");
  const identities = currentReviewActiveProof.liveIdentities;
  if (identities.reviewTriggerUuid !== journal.reviewTriggerUuid ||
      identities.productionTriggerUuid !== setupProvenance.productionTriggerUuid ||
      identities.productionBuildTokenUuid !== setupProvenance.productionBuildTokenUuid ||
      identities.reviewBuildTokenUuid !== setupProvenance.reviewBuildTokenUuid ||
      identities.repositoryConnectionUuid !== setupProvenance.repositoryConnectionUuid)
    fail("disposable review authority journal/live identity drift");
  const capturedAt = new Date(now).toISOString();
  const authority = {
    outcome: "workers-builds-disposable-review-authority-valid", mutation: false,
    phase: "disposable-review-build-and-proof", accountId, sourceSha, capturedAt,
    predecessorSourceSha,
    expiresAt: new Date(now + disposableReviewAuthorityLifetimeMs).toISOString(),
    planDigest: digestJson(provisioningSetupPlan(production, review)),
    productionContractDigest: digestJson(production),
    reviewContractDigest: digestJson(review),
    reviewActiveSnapshot: {
      predecessorProofDigest: reviewActivationProof.proof_digest,
      stateDigest: currentReviewActiveProof.state_digest,
      proofDigest: currentReviewActiveProof.proof_digest,
      capturedAt: currentReviewActiveProof.capturedAt,
      startedAt: currentReviewActiveProof.snapshotStartedAt,
      completedAt: currentReviewActiveProof.snapshotCompletedAt,
      liveIdentities: structuredClone(currentReviewActiveProof.liveIdentities),
    },
    reviewActivationJournal: journal,
    inertSetup: setupProvenance,
    disposableCoordinate: structuredClone(coordinate),
    repositoryOwner: { capturedAt: repositoryConnectionProof.capturedAt,
      githubApp: structuredClone(repositoryConnectionProof.githubApp),
      websitePreserved: repositoryConnectionProof.websitePreserved },
    productionSentinel: { branch: sentinel.branch, capturedAt: productionSentinelProof.capturedAt },
    tokenAuthority: tokenAuthorityProofs.map(({ kind, tokenId, modifiedOn, capturedAt: value }) =>
      ({ kind, tokenId, modifiedOn, capturedAt: value })),
    buildUsage: { capturedAt: buildUsageProof.capturedAt,
      monthlyMinutesUsed: buildUsageProof.monthlyMinutesUsed,
      alertAtMinutes: buildUsageProof.alertAtMinutes,
      disableAtMinutes: buildUsageProof.disableAtMinutes },
    reservedBuildMinutes: review.automaticReview.providerBuildTimeoutMinutes,
    evidenceDigests: disposableReviewEvidenceDigests({ reviewActivationProof,
      reviewActivationJournal, inertSetupJournal, inertSetupResults, disposableCoordinate,
      currentReviewActiveProof, repositoryConnectionProof, productionSentinelProof,
      tokenAuthorityProofs, buildUsageProof }),
    allowedWrites: ["push-one-exact-review-issue-66-branch",
      "delete-that-exact-sha-bound-branch",
      "cancel-only-journal-owned-automatic-review-build-during-cleanup"],
  };
  return { ...authority, proof_digest: digestJson(authority) };
}

export function validateDisposableReviewAuthority(proof, { production, review, accountId,
  sourceSha, reviewActivationProof, reviewActivationJournal, inertSetupJournal,
  inertSetupResults, disposableCoordinate, currentReviewActiveProof,
  repositoryConnectionProof,
  productionSentinelProof, tokenAuthorityProofs, buildUsageProof }, now = Date.now(),
minimumRemainingMs = reviewActivationTransitionBudgetMs) {
  const keys = ["accountId", "allowedWrites", "buildUsage", "capturedAt", "evidenceDigests",
    "disposableCoordinate", "expiresAt", "inertSetup", "mutation", "outcome", "phase",
    "planDigest", "predecessorSourceSha", "productionContractDigest",
    "productionSentinel", "proof_digest", "repositoryOwner", "reviewActiveSnapshot",
    "reservedBuildMinutes", "reviewActivationJournal", "reviewContractDigest", "sourceSha",
    "tokenAuthority"];
  const captured = Date.parse(proof?.capturedAt ?? "");
  const expires = Date.parse(proof?.expiresAt ?? "");
  if (!proof || !same(sorted(Object.keys(proof)), sorted(keys)) ||
      proof.outcome !== "workers-builds-disposable-review-authority-valid" ||
      proof.mutation !== false || proof.phase !== "disposable-review-build-and-proof" ||
      proof.accountId !== accountId || proof.sourceSha !== sourceSha ||
      proof.predecessorSourceSha !== reviewActivationProof?.sourceSha ||
      !isUtcTimestamp(proof.capturedAt) || !isUtcTimestamp(proof.expiresAt) ||
      !Number.isFinite(captured) || !Number.isFinite(expires) || captured > now + 30_000 ||
      expires - captured !== disposableReviewAuthorityLifetimeMs || now >= expires ||
      expires - now < minimumRemainingMs ||
      proof.planDigest !== digestJson(provisioningSetupPlan(production, review)) ||
      proof.productionContractDigest !== digestJson(production) ||
      proof.reviewContractDigest !== digestJson(review) ||
      proof.reservedBuildMinutes !== review.automaticReview.providerBuildTimeoutMinutes ||
      !same(proof.allowedWrites, ["push-one-exact-review-issue-66-branch",
        "delete-that-exact-sha-bound-branch",
        "cancel-only-journal-owned-automatic-review-build-during-cleanup"]) ||
      proof.proof_digest !== digestJson(Object.fromEntries(Object.entries(proof)
        .filter(([key]) => key !== "proof_digest"))))
    fail("disposable review authority proof is stale, malformed, or cross-phase");
  validateReviewActiveSnapshotProofEvidence(reviewActivationProof,
    { accountId, sourceSha: proof.predecessorSourceSha },
    Date.parse(reviewActivationProof?.capturedAt ?? ""), 0);
  const journal = validateReviewActivationJournal(reviewActivationJournal,
    reviewActivationProof, proof.predecessorSourceSha);
  const setupProvenance = validateInertSetupProvenance(inertSetupJournal, inertSetupResults,
    journal.preflight);
  const coordinate = validateDisposableReviewCoordinate(disposableCoordinate, sourceSha, captured);
  validateCurrentDisposableReviewSnapshotProof(currentReviewActiveProof,
    { accountId, sourceSha }, captured);
  validateRepositoryConnectionOwnerProof(repositoryConnectionProof, accountId, sourceSha, captured);
  const sentinel = validateSentinelRefAbsence(productionSentinelProof, captured);
  const proofByKind = Object.fromEntries(tokenAuthorityProofs.map((item) => [item.kind, item]));
  validateTokenAuthorityProofs({ production, review, accountId, proofs: tokenAuthorityProofs,
    tokenRows: { production: { cloudflare_token_id: proofByKind.production?.tokenId },
      review: { cloudflare_token_id: proofByKind.review?.tokenId } }, sourceSha }, captured);
  validateBuildUsageProof(review, buildUsageProof, accountId, captured);
  if (buildUsageProof.monthlyMinutesUsed + proof.reservedBuildMinutes >=
      buildUsageProof.alertAtMinutes)
    fail("disposable review authority lacks reserved build-minute budget");
  const active = proof.reviewActiveSnapshot;
  if (!active || !same(sorted(Object.keys(active)), sorted(["capturedAt", "completedAt",
    "liveIdentities", "predecessorProofDigest", "proofDigest", "startedAt", "stateDigest"])) ||
      active.predecessorProofDigest !== reviewActivationProof.proof_digest ||
      active.stateDigest !== currentReviewActiveProof.state_digest ||
      active.proofDigest !== currentReviewActiveProof.proof_digest ||
      active.capturedAt !== currentReviewActiveProof.capturedAt ||
      active.startedAt !== currentReviewActiveProof.snapshotStartedAt ||
      active.completedAt !== currentReviewActiveProof.snapshotCompletedAt ||
      Date.parse(reviewActivationProof.capturedAt) > Date.parse(journal.terminalAt) ||
      Date.parse(journal.terminalAt) > Date.parse(currentReviewActiveProof.snapshotStartedAt) ||
      !same(active.liveIdentities, currentReviewActiveProof.liveIdentities) ||
      !same(proof.reviewActivationJournal, journal) ||
      !same(proof.inertSetup, setupProvenance) ||
      !same(proof.disposableCoordinate, coordinate) ||
      currentReviewActiveProof.liveIdentities.reviewTriggerUuid !== journal.reviewTriggerUuid ||
      currentReviewActiveProof.liveIdentities.productionTriggerUuid !==
        setupProvenance.productionTriggerUuid ||
      currentReviewActiveProof.liveIdentities.productionBuildTokenUuid !==
        setupProvenance.productionBuildTokenUuid ||
      currentReviewActiveProof.liveIdentities.reviewBuildTokenUuid !==
        setupProvenance.reviewBuildTokenUuid ||
      currentReviewActiveProof.liveIdentities.repositoryConnectionUuid !==
        setupProvenance.repositoryConnectionUuid ||
      !same(proof.evidenceDigests, disposableReviewEvidenceDigests({ reviewActivationProof,
        reviewActivationJournal, inertSetupJournal, inertSetupResults, disposableCoordinate,
        currentReviewActiveProof, repositoryConnectionProof, productionSentinelProof,
        tokenAuthorityProofs, buildUsageProof })) ||
      !same(proof.repositoryOwner, { capturedAt: repositoryConnectionProof.capturedAt,
        githubApp: repositoryConnectionProof.githubApp,
        websitePreserved: repositoryConnectionProof.websitePreserved }) ||
      !same(proof.productionSentinel, { branch: sentinel.branch,
        capturedAt: productionSentinelProof.capturedAt }) ||
      !same(proof.tokenAuthority, tokenAuthorityProofs.map(
        ({ kind, tokenId, modifiedOn, capturedAt: value }) =>
          ({ kind, tokenId, modifiedOn, capturedAt: value }))) ||
      !same(proof.buildUsage, { capturedAt: buildUsageProof.capturedAt,
        monthlyMinutesUsed: buildUsageProof.monthlyMinutesUsed,
        alertAtMinutes: buildUsageProof.alertAtMinutes,
        disableAtMinutes: buildUsageProof.disableAtMinutes }))
    fail("disposable review authority evidence binding drift");
  return { outcome: proof.outcome, mutation: false, phase: proof.phase,
    proofValidationTime: captured, checkedAt: new Date(now).toISOString(),
    expiresAt: proof.expiresAt, proof_digest: proof.proof_digest };
}

export function issueReviewActivationAuthority({ production, review, accountId, sourceSha,
  stagedProof, currentStagedProof, repositoryConnectionProof, productionSentinelProof,
  tokenAuthorityProofs, buildUsageProof, tokenRows }, now = Date.now()) {
  validateRepositoryConnectionOwnerProof(repositoryConnectionProof, accountId, sourceSha, now);
  const sentinel = validateSentinelRefAbsence(productionSentinelProof, now);
  validateTokenAuthorityProofs({ production, review, accountId, proofs: tokenAuthorityProofs,
    tokenRows, sourceSha }, now);
  validateBuildUsageProof(review, buildUsageProof, accountId, now);
  validateStagedProof(stagedProof, currentStagedProof, now);
  const capturedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + reviewActivationAuthorityLifetimeMs).toISOString();
  const authority = {
    outcome: "workers-builds-review-activation-authority-valid",
    mutation: false,
    phase: "review-trigger-activation-and-proof",
    accountId,
    sourceSha,
    capturedAt,
    expiresAt,
    planDigest: digestJson(provisioningSetupPlan(production, review)),
    productionContractDigest: digestJson(production),
    reviewContractDigest: digestJson(review),
    stagedSnapshot: {
      predecessorProofDigest: stagedProof.proof_digest,
      stateDigest: currentStagedProof.state_digest,
      proofDigest: currentStagedProof.proof_digest,
      capturedAt: currentStagedProof.capturedAt,
      startedAt: currentStagedProof.snapshotStartedAt,
      completedAt: currentStagedProof.snapshotCompletedAt,
    },
    repositoryOwner: {
      capturedAt: repositoryConnectionProof.capturedAt,
      githubApp: structuredClone(repositoryConnectionProof.githubApp),
      websitePreserved: repositoryConnectionProof.websitePreserved,
    },
    productionSentinel: { branch: sentinel.branch,
      capturedAt: productionSentinelProof.capturedAt },
    tokenAuthority: tokenAuthorityProofs.map(({ kind, tokenId, modifiedOn, capturedAt: captured }) =>
      ({ kind, tokenId, modifiedOn, capturedAt: captured })),
    buildUsage: {
      capturedAt: buildUsageProof.capturedAt,
      monthlyMinutesUsed: buildUsageProof.monthlyMinutesUsed,
      alertAtMinutes: buildUsageProof.alertAtMinutes,
      disableAtMinutes: buildUsageProof.disableAtMinutes,
    },
    evidenceDigests: reviewActivationEvidenceDigests({ stagedProof, repositoryConnectionProof,
      productionSentinelProof, tokenAuthorityProofs, buildUsageProof }),
  };
  return { ...authority, proof_digest: digestJson(authority) };
}

export function validateReviewActivationAuthority(proof, { production, review, accountId,
  sourceSha, stagedProof, repositoryConnectionProof, productionSentinelProof,
  tokenAuthorityProofs, buildUsageProof }, now = Date.now(),
minimumRemainingMs = reviewActivationTransitionBudgetMs) {
  const keys = ["accountId", "buildUsage", "capturedAt", "evidenceDigests", "expiresAt",
    "mutation", "outcome", "phase", "planDigest", "productionContractDigest",
    "productionSentinel", "proof_digest", "repositoryOwner", "reviewContractDigest",
    "sourceSha", "stagedSnapshot", "tokenAuthority"];
  const captured = Date.parse(proof?.capturedAt ?? "");
  const expires = Date.parse(proof?.expiresAt ?? "");
  if (!proof || !same(sorted(Object.keys(proof)), sorted(keys)) ||
      proof.outcome !== "workers-builds-review-activation-authority-valid" ||
      proof.mutation !== false || proof.phase !== "review-trigger-activation-and-proof" ||
      proof.accountId !== accountId || proof.sourceSha !== sourceSha ||
      !isUtcTimestamp(proof.capturedAt) || !isUtcTimestamp(proof.expiresAt) ||
      !Number.isFinite(captured) || !Number.isFinite(expires) ||
      captured > now + 30_000 || expires - captured !== reviewActivationAuthorityLifetimeMs ||
      now >= expires || expires - now < minimumRemainingMs ||
      proof.planDigest !== digestJson(provisioningSetupPlan(production, review)) ||
      proof.productionContractDigest !== digestJson(production) ||
      proof.reviewContractDigest !== digestJson(review) ||
      proof.proof_digest !== digestJson(Object.fromEntries(Object.entries(proof)
        .filter(([key]) => key !== "proof_digest"))))
    fail("review activation authority proof is stale, malformed, or cross-phase");
  validateStagedSnapshotProofEvidence(stagedProof, { accountId, sourceSha }, captured);
  const stagedCaptured = Date.parse(proof.stagedSnapshot?.capturedAt ?? "");
  const stagedStarted = Date.parse(proof.stagedSnapshot?.startedAt ?? "");
  const stagedCompleted = Date.parse(proof.stagedSnapshot?.completedAt ?? "");
  validateRepositoryConnectionOwnerProof(repositoryConnectionProof, accountId, sourceSha,
    captured);
  const sentinel = validateSentinelRefAbsence(productionSentinelProof, captured);
  const proofByKind = Object.fromEntries(tokenAuthorityProofs.map((item) => [item.kind, item]));
  validateTokenAuthorityProofs({ production, review, accountId, proofs: tokenAuthorityProofs,
    tokenRows: {
      production: { cloudflare_token_id: proofByKind.production?.tokenId },
      review: { cloudflare_token_id: proofByKind.review?.tokenId },
    }, sourceSha }, captured);
  validateBuildUsageProof(review, buildUsageProof, accountId, captured);
  if (!proof.stagedSnapshot ||
      !same(sorted(Object.keys(proof.stagedSnapshot)), sorted(["capturedAt", "completedAt",
        "predecessorProofDigest", "proofDigest", "startedAt", "stateDigest"])) ||
      proof.stagedSnapshot.predecessorProofDigest !== stagedProof.proof_digest ||
      proof.stagedSnapshot.stateDigest !== stagedProof.state_digest ||
      !/^[0-9a-f]{64}$/u.test(proof.stagedSnapshot.proofDigest ?? "") ||
      proof.stagedSnapshot.proofDigest !== digestJson({
        state_digest: proof.stagedSnapshot.stateDigest,
        snapshotStartedAt: proof.stagedSnapshot.startedAt,
        snapshotCompletedAt: proof.stagedSnapshot.completedAt,
        capturedAt: proof.stagedSnapshot.capturedAt,
      }) ||
      !isUtcTimestamp(proof.stagedSnapshot.capturedAt) ||
      !isUtcTimestamp(proof.stagedSnapshot.startedAt) ||
      !isUtcTimestamp(proof.stagedSnapshot.completedAt) ||
      !Number.isFinite(stagedCaptured) || !Number.isFinite(stagedStarted) ||
      !Number.isFinite(stagedCompleted) || stagedStarted > stagedCompleted ||
      stagedCompleted > stagedCaptured || stagedCaptured > captured ||
      stagedCompleted - stagedStarted > 5 * 60_000 ||
      !same(proof.evidenceDigests, reviewActivationEvidenceDigests({ stagedProof,
    repositoryConnectionProof, productionSentinelProof, tokenAuthorityProofs,
    buildUsageProof })) ||
      !same(proof.repositoryOwner, { capturedAt: repositoryConnectionProof.capturedAt,
        githubApp: repositoryConnectionProof.githubApp,
        websitePreserved: repositoryConnectionProof.websitePreserved }) ||
      !same(proof.productionSentinel, { branch: sentinel.branch,
        capturedAt: productionSentinelProof.capturedAt }) ||
      !same(proof.tokenAuthority, tokenAuthorityProofs.map(
        ({ kind, tokenId, modifiedOn, capturedAt: capturedAt_ }) =>
          ({ kind, tokenId, modifiedOn, capturedAt: capturedAt_ }))) ||
      !same(proof.buildUsage, { capturedAt: buildUsageProof.capturedAt,
        monthlyMinutesUsed: buildUsageProof.monthlyMinutesUsed,
        alertAtMinutes: buildUsageProof.alertAtMinutes,
        disableAtMinutes: buildUsageProof.disableAtMinutes }))
    fail("review activation authority evidence binding drift");
  return { outcome: proof.outcome, mutation: false, phase: proof.phase,
    proofValidationTime: captured, checkedAt: new Date(now).toISOString(),
    expiresAt: proof.expiresAt, proof_digest: proof.proof_digest };
}

export function validateReviewActivationAuthorityCheckpoint(proof, arguments_, checkpoint,
  now = Date.now()) {
  const checked = Date.parse(checkpoint?.checkedAt ?? "");
  if (!checkpoint || !same(sorted(Object.keys(checkpoint)), sorted(["checkedAt", "expiresAt",
    "mutation", "outcome", "phase", "proofValidationTime", "proof_digest"])) ||
      checkpoint.outcome !== "workers-builds-review-activation-authority-valid" ||
      checkpoint.mutation !== false || checkpoint.phase !== "review-trigger-activation-and-proof" ||
      checkpoint.proof_digest !== proof?.proof_digest || !isUtcTimestamp(checkpoint.checkedAt) ||
      !Number.isFinite(checked) || checked > now)
    fail("review activation authority checkpoint is stale or malformed");
  const start = validateReviewActivationAuthority(proof, arguments_, checked,
    reviewActivationTransitionBudgetMs);
  if (!same(start, checkpoint)) fail("review activation authority checkpoint drift");
  return validateReviewActivationAuthority(proof, arguments_, now, 0);
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
    fail("review trigger environment drift");
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

function reviewActivationAuthorityPrecondition() {
  return {
    proof: resultReference("review-activation-authority", "proof_digest"),
    command: "npm run provision:workers-builds:verify-review-activation-authority-proof",
    minimumRemainingSeconds: reviewActivationTransitionBudgetMs / 1000,
  };
}

function disposableReviewAuthorityPrecondition() {
  return {
    proof: resultReference("disposable-review-proof-authority", "proof_digest"),
    command: "npm run provision:workers-builds:verify-disposable-review-authority-proof",
    minimumRemainingSeconds: reviewActivationTransitionBudgetMs / 1000,
  };
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
  const productionSentinel = privateFileReference(
    "ATRINIK_PRODUCTION_STAGING_SENTINEL_BRANCH_FILE");
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
  productionStaged.branch_includes = [productionSentinel];
  const reviewStagingRoot = privateFileReference(
    "ATRINIK_REVIEW_STAGING_ROOT_DIRECTORY_FILE");
  const reviewStaged = structuredClone(reviewFinal);
  reviewStaged.root_directory = reviewStagingRoot;
  reviewStaged.build_command = "exit 1";
  reviewStaged.deploy_command = "exit 1";
  const plan = {
    schemaVersion: 1,
    outcome: "workers-builds-reviewed-setup-plan",
    mutation: false,
    providerTopology: structuredClone(review.automaticReview.providerTopology),
    retainedFailedRequest: {
      error: 12002,
      topology: "one-repository-connection-two-workers",
      disposition: "forbidden-never-retry-or-vary",
    },
    retainedRejectedPreviewRequest: {
      error: 12002,
      topology: "one-worker-two-triggers-private-sentinel-preview",
      disposition: "forbidden-never-retry-or-normalize",
    },
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
      "ATRINIK_GITHUB_CURRENT_MAIN_PROOF_FILE",
      "ATRINIK_REVIEWED_SOURCE_SHA_FILE",
      "ATRINIK_WORKERS_BUILDS_API_TOKEN_FILE",
      "ATRINIK_PRODUCTION_STAGING_SENTINEL_BRANCH_FILE",
      "ATRINIK_PRODUCTION_STAGING_SENTINEL_REFS_FILE",
      "ATRINIK_REVIEW_STAGING_ROOT_DIRECTORY_FILE",
      "ATRINIK_REVIEW_STAGING_ROOT_CREATE_PROOF_FILE",
      "ATRINIK_REVIEW_STAGING_ROOT_ACTIVATION_PROOF_FILE",
      "ATRINIK_PRODUCTION_STAGED_TRIGGER_UUID_FILE",
      "ATRINIK_REVIEW_STAGED_TRIGGER_UUID_FILE",
      "ATRINIK_REVIEW_STAGED_ENVIRONMENT_PROOF_OUTPUT_FILE",
      "ATRINIK_REVIEW_ACTIVATION_AUTHORITY_PROOF_OUTPUT_FILE",
      "ATRINIK_REVIEW_ACTIVATION_AUTHORITY_PROOF_FILE",
      "ATRINIK_REPOSITORY_CONNECTION_OWNER_PROOF_FILE",
      "ATRINIK_WORKERS_BUILDS_USAGE_PROOF_FILE",
      "ATRINIK_STAGED_PROOF_OUTPUT_FILE",
      "ATRINIK_STAGED_PROOF_FILE",
      "ATRINIK_REVIEW_ACTIVATION_PROOF_OUTPUT_FILE",
      "ATRINIK_REVIEW_ACTIVATION_PROOF_FILE",
      "ATRINIK_REVIEW_ACTIVATION_JOURNAL_FILE",
      "ATRINIK_INERT_SETUP_JOURNAL_FILE",
      "ATRINIK_INERT_SETUP_RESULTS_FILE",
      "ATRINIK_DISPOSABLE_REVIEW_COORDINATE_FILE",
      "ATRINIK_CURRENT_REVIEW_ACTIVE_PROOF_OUTPUT_FILE",
      "ATRINIK_CURRENT_REVIEW_ACTIVE_PROOF_FILE",
      "ATRINIK_DISPOSABLE_REVIEW_AUTHORITY_PROOF_OUTPUT_FILE",
      "ATRINIK_DISPOSABLE_REVIEW_AUTHORITY_PROOF_FILE",
      "ATRINIK_DISPOSABLE_REVIEW_PUSH_AUTHORIZATION_RECEIPT_OUTPUT_FILE",
      "ATRINIK_DISPOSABLE_REVIEW_DELETE_AUTHORIZATION_RECEIPT_OUTPUT_FILE",
      "ATRINIK_PRODUCTION_ACTIVATION_PROOF_OUTPUT_FILE",
      "ATRINIK_REVIEW_RESULT_PROOF_FILE",
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
        action: "require-exact-private-readback-no-competing-trigger-and-validate-private-random-production-sentinel-ref-absence",
        mutation: false,
        commands: [
          "gh api repos/atrinik/metaserver-worker/git/matching-refs/heads/{private-random-production-sentinel} outside-sandbox",
        ],
        produces: { production_sentinel_branch: "private-random-branch-name",
          production_sentinel_refs: "exact-empty-array",
          repository_connection_owner_proof: "fresh-exact-cloudflare-owner-ui-proof" } },
      { id: "production-script", actor: "workers-builds-control-plane-operator",
        action: "select-exact-existing-production-script-tag", mutation: false,
        expected: { worker: production.workers[0].name },
        produces: { script_tag: { sourceField: "tag", pattern: "32-lowercase-hex" } } },
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
        action: "repeat-exact-private-random-production-sentinel-ref-absence-proof-outside-sandbox",
        mutation: false, branch: productionSentinel,
        produces: { proof_digest: "fresh-production-sentinel-absence-proof-digest" } },
      { id: "production-trigger-staged", actor: "workers-builds-control-plane-operator",
        action: "post-inert-trigger-with-zero-resource-token", mutation: true,
        precondition: { productionSentinelProof: resultReference(
          "sentinel-recheck-before-production-trigger", "proof_digest") },
        request: { method: "POST", path: "/builds/triggers",
          body: triggerPlanSpec(productionStaged, "production-script",
            "review-build-token") },
        produces: { trigger_uuid: "provider-trigger-uuid" } },
      { id: "sentinel-recheck-before-production-environment", actor: "github-owner-readback",
        action: "repeat-exact-private-random-production-sentinel-ref-absence-proof-outside-sandbox",
        mutation: false, branch: productionSentinel,
        produces: { proof_digest: "fresh-production-sentinel-absence-proof-digest" } },
      { id: "production-environment", actor: "workers-builds-control-plane-operator",
        action: "patch-exact-environment", mutation: true,
        precondition: { productionSentinelProof: resultReference(
          "sentinel-recheck-before-production-environment", "proof_digest") },
        request: { method: "PATCH",
          path: apiPathReference("/builds/triggers/{trigger_uuid}/environment_variables",
            "production-trigger-staged", "trigger_uuid"),
          body: productionEnvironmentPlan(production) } },
      { id: "staged-readback", actor: "workers-builds-control-plane-operator",
        action: "prove-one-inert-production-trigger-review-trigger-absent-tokens-and-no-deploy-hooks",
        mutation: false, command: "npm run provision:workers-builds:verify-staged",
        produces: { proof_digest: "fresh-private-staged-verifier-digest" } },
    ],
    reviewActivation: {
      gate: "review-trigger-activation-and-proof",
      precondition: { stagedProof: resultReference("staged-readback", "proof_digest") },
      preconditionCommand: "npm run provision:workers-builds:verify-staged-proof",
      operations: [
        { id: "review-activation-authority", actor: "workers-builds-control-plane-operator",
          action: "bind-fresh-owner-token-sentinel-usage-and-staged-evidence-into-bounded-review-phase-authority",
          mutation: false,
          command: "npm run provision:workers-builds:verify-review-activation-authority",
          precondition: { stagedProof: resultReference("staged-readback", "proof_digest") },
          produces: { proof_digest: "bounded-review-activation-authority-proof-digest" } },
        { id: "review-root-recheck-before-trigger", actor: "github-owner-readback",
          action: "prove-private-random-review-staging-root-absent-from-every-current-non-main-ref-outside-sandbox",
          mutation: false, rootDirectory: reviewStagingRoot,
          command: "npm run provision:workers-builds:verify-review-staging-root-create",
          precondition: { reviewActivationAuthority: reviewActivationAuthorityPrecondition() },
          proof: privateFileReference("ATRINIK_REVIEW_STAGING_ROOT_CREATE_PROOF_FILE"),
          produces: { proof_digest: "fresh-review-staging-root-absence-proof-digest" } },
        { id: "review-trigger-create", actor: "workers-builds-control-plane-operator",
          action: "post-preview-role-trigger-with-private-absent-root-inert-commands-and-zero-resource-token",
          mutation: true,
          precondition: { reviewActivationAuthority: reviewActivationAuthorityPrecondition(),
            reviewRootProof: resultReference(
              "review-root-recheck-before-trigger", "proof_digest") },
          request: { method: "POST", path: "/builds/triggers",
            body: triggerPlanSpec(reviewStaged, "production-script", "review-build-token") },
          produces: { trigger_uuid: "provider-trigger-uuid" } },
        { id: "review-environment", actor: "workers-builds-control-plane-operator",
          action: "patch-exact-nonsecret-review-environment", mutation: true,
          precondition: { reviewActivationAuthority: reviewActivationAuthorityPrecondition() },
          request: { method: "PATCH",
            path: apiPathReference("/builds/triggers/{trigger_uuid}/environment_variables",
              "review-trigger-create", "trigger_uuid"),
            body: Object.fromEntries(Object.entries(automaticReviewEnvironmentSpec(review))
              .map(([name, value]) => [name, { is_secret: value.is_secret,
                valueSource: { literal: value.value } }])) } },
        { id: "review-environment-readback-before-activation",
          actor: "workers-builds-control-plane-operator",
          action: "prove-three-stable-reads-of-journaled-triggers-private-root-environments-and-no-competing-build-path",
          mutation: false,
          journalInputs: {
            productionTriggerUuid: privateFileReference(
              "ATRINIK_PRODUCTION_STAGED_TRIGGER_UUID_FILE"),
            reviewTriggerUuid: privateFileReference(
              "ATRINIK_REVIEW_STAGED_TRIGGER_UUID_FILE"),
          },
          requests: [
            { method: "GET", path: apiPathReference(
              "/builds/workers/{external_script_id}/triggers",
              "production-script", "script_tag") },
            { method: "GET", path: apiPathReference(
              "/builds/triggers/{trigger_uuid}/environment_variables",
              "review-trigger-create", "trigger_uuid") },
          ],
          stability: "two-complete-identical-passes-plus-final-identical-sweep",
          validator: "exact-journaled-production-and-review-staged-triggers-environments-no-hooks-or-active-builds",
          command: "npm run provision:workers-builds:verify-review-staged-environment",
          precondition: { reviewActivationAuthority: reviewActivationAuthorityPrecondition() },
          produces: { proof_digest: "fresh-staged-review-environment-readback-digest" } },
        { id: "review-root-recheck-before-activation", actor: "github-owner-readback",
          action: "repeat-private-random-review-staging-root-absence-proof-immediately-before-final-preview-patch-outside-sandbox",
          mutation: false, rootDirectory: reviewStagingRoot,
          command: "npm run provision:workers-builds:verify-review-staging-root-activation",
          precondition: { reviewActivationAuthority: reviewActivationAuthorityPrecondition() },
          proof: privateFileReference("ATRINIK_REVIEW_STAGING_ROOT_ACTIVATION_PROOF_FILE"),
          produces: { proof_digest: "fresh-review-staging-root-absence-proof-digest" } },
        { id: "review-trigger-activate", actor: "workers-builds-control-plane-operator",
          action: "patch-preview-trigger-atomically-to-reviewed-root-and-commands",
          mutation: true,
          precondition: {
            reviewActivationAuthority: reviewActivationAuthorityPrecondition(),
            reviewEnvironmentProof: resultReference(
              "review-environment-readback-before-activation", "proof_digest"),
            reviewRootProof: resultReference(
              "review-root-recheck-before-activation", "proof_digest"),
          },
          request: { method: "PATCH",
            path: apiPathReference("/builds/triggers/{trigger_uuid}",
              "review-trigger-create", "trigger_uuid"),
            body: triggerPlanSpec(reviewFinal, "production-script", "review-build-token") } },
        { id: "review-activation-readback", actor: "workers-builds-control-plane-operator",
          action: "prove-final-review-trigger-production-staged-and-no-build-active",
          mutation: false, command: "npm run provision:workers-builds:verify-review-activation",
          precondition: { reviewActivationAuthority: reviewActivationAuthorityPrecondition() },
          produces: { proof_digest: "fresh-live-review-active-production-staged-proof-digest" } },
        { id: "disposable-review-proof-authority",
          actor: "workers-builds-control-plane-operator",
          action: "bind-fresh-review-active-owner-token-sentinel-usage-evidence-into-bounded-disposable-proof-authority",
          mutation: false,
          command: "npm run provision:workers-builds:verify-disposable-review-authority",
          precondition: { reviewActivationProof: resultReference(
            "review-activation-readback", "proof_digest") },
          produces: { proof_digest: "bounded-disposable-review-proof-authority-digest" } },
      ],
      proof: "disposable-same-repository-non-main-build-only-branch",
    },
    disposableProof: {
      gate: "review-trigger-activation-and-proof",
      precondition: { disposableReviewAuthority: disposableReviewAuthorityPrecondition(),
        reviewActivationProof: resultReference("review-activation-readback", "proof_digest") },
      authorityLifetimeMinutes: disposableReviewAuthorityLifetimeMs / 60_000,
      pushMinimumRemainingMinutes: disposableReviewPushReserveMs / 60_000,
      maximumAutomaticBuildMinutes: review.automaticReview.providerBuildTimeoutMinutes,
      allowedWrites: ["push-one-exact-review-issue-66-branch",
        "delete-that-exact-sha-bound-branch",
        "cancel-only-journal-owned-automatic-review-build-during-cleanup"],
      forbidden: ["manual-build", "production-trigger-activation", "migration-0010",
        "initial-production-build", "production-resource-mutation"],
      proof: "authenticated-cloudflare-github-disposable-review-readback",
    },
    productionActivation: {
      gate: "production-trigger-activation",
      preconditionOperations: [
        { id: "production-activation-readback",
          actor: "workers-builds-control-plane-operator",
          action: "prove-review-active-production-staged-and-disposable-review-result",
          mutation: false,
          command: "npm run provision:workers-builds:verify-production-activation",
          produces: { proof_digest: "fresh-live-review-active-production-staged-proof-digest" } },
        { id: "sentinel-recheck-before-production-activation",
          actor: "github-owner-readback",
          action: "repeat-exact-private-random-production-sentinel-ref-absence-proof-outside-sandbox",
          mutation: false, branch: productionSentinel,
          produces: { proof_digest: "fresh-production-sentinel-absence-proof-digest" } },
      ],
      precondition: {
        productionSentinelProof: resultReference(
          "sentinel-recheck-before-production-activation", "proof_digest"),
        reviewPath: "fresh-private-successful-disposable-review-build-and-cleanup-proof",
        productionProof: resultReference("production-activation-readback", "proof_digest"),
      },
      preconditionCommand: "npm run provision:workers-builds:verify-production-activation",
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
      { id: "delete-review-trigger-before-quiescence",
        actor: "workers-builds-control-plane-operator",
        action: "delete-exact-journaled-review-trigger-before-any-non-main-push-can-race-quiescence",
        mutation: true, condition: "only-if-review-trigger-create-is-journal-bound-or-ambiguously-reconciled",
        request: { method: "DELETE", path: apiPathReference(
          "/builds/triggers/{trigger_uuid}", "review-trigger-create", "trigger_uuid") } },
      { id: "prove-review-trigger-deleted-before-quiescence",
        actor: "workers-builds-control-plane-operator",
        action: "prove-phase-aware-exhaustive-inventory-is-empty-or-exactly-journaled-production-trigger",
        mutation: false,
        journalInputs: {
          productionTriggerUuid: "optional-journal-bound-production-trigger-staged-uuid",
          reviewTriggerUuid: "optional-journal-bound-or-ambiguously-reconciled-review-trigger-create-uuid",
        },
        request: { method: "GET", path: apiPathReference(
          "/builds/workers/{external_script_id}/triggers",
          "production-script", "script_tag") },
        stability: "two-complete-identical-passes-plus-final-identical-sweep",
        validator: "validateRollbackTriggerInventory",
        produces: { proof_digest: "fresh-review-trigger-absence-readback-digest" } },
      { id: "sentinel-recheck-before-production-rollback", actor: "github-owner-readback",
        action: "repeat-exact-private-random-production-sentinel-ref-absence-proof-outside-sandbox",
        mutation: false, branch: productionSentinel,
        produces: { proof_digest: "fresh-production-sentinel-absence-proof-digest" } },
      { id: "restore-production-trigger-to-inert-sentinel",
        actor: "workers-builds-control-plane-operator",
        action: "restore-production-trigger-to-its-exact-inert-production-sentinel-before-cancelling-exact-active-builds",
        mutation: true,
        condition: "only-if-production-trigger-staged-is-journal-bound-or-ambiguously-reconciled",
        precondition: { productionSentinelProof: resultReference(
          "sentinel-recheck-before-production-rollback", "proof_digest") },
        request: { method: "PATCH",
          path: apiPathReference("/builds/triggers/{trigger_uuid}",
            "production-trigger-staged", "trigger_uuid"),
          body: triggerPlanSpec(productionStaged, "production-script", "review-build-token") } },
      { id: "prove-production-trigger-inert-before-quiescence",
        actor: "workers-builds-control-plane-operator",
        action: "prove-phase-aware-production-trigger-is-absent-or-exactly-restored-to-inert-sentinel",
        mutation: false,
        journalInputs: {
          productionTriggerUuid: "optional-journal-bound-or-ambiguously-reconciled-production-trigger-staged-uuid",
        },
        expectedTrigger: triggerPlanSpec(productionStaged,
          "production-script", "review-build-token"),
        request: { method: "GET", path: apiPathReference(
          "/builds/workers/{external_script_id}/triggers",
          "production-script", "script_tag") },
        stability: "two-complete-identical-passes-plus-final-identical-sweep",
        validator: "validateRollbackProductionTriggerReadback",
        produces: { proof_digest: "fresh-production-trigger-inert-readback-digest" } },
      { id: "prove-rollback-quiescence", actor: "workers-builds-control-plane-operator",
        action: "prove-no-build-or-upload-remains-active", mutation: false,
        precondition: { reviewDeletionProof: resultReference(
          "prove-review-trigger-deleted-before-quiescence", "proof_digest"),
        productionInertProof: resultReference(
          "prove-production-trigger-inert-before-quiescence", "proof_digest") } },
      { id: "delete-production-trigger", actor: "workers-builds-control-plane-operator",
        action: "delete-exact-journaled-production-trigger-after-quiescence",
        mutation: true, condition: "only-if-production-trigger-staged-is-journal-bound-or-ambiguously-reconciled",
        request: { method: "DELETE", path: apiPathReference(
          "/builds/triggers/{trigger_uuid}", "production-trigger-staged", "trigger_uuid") } },
      { id: "prove-setup-triggers-deleted", actor: "workers-builds-control-plane-operator",
        action: "prove-exhaustive-shared-core-trigger-inventory-is-empty",
        mutation: false,
        request: { method: "GET", path: apiPathReference(
          "/builds/workers/{external_script_id}/triggers",
          "production-script", "script_tag") },
        stability: "two-complete-identical-passes-plus-final-identical-sweep",
        produces: { proof_digest: "fresh-zero-trigger-readback-digest" } },
      { id: "delete-setup-build-tokens", actor: "workers-builds-control-plane-operator",
        action: "delete-only-the-two-recorded-build-token-uuids", mutation: true,
        condition: "delete-each-only-if-its-create-is-journal-bound-or-ambiguously-reconciled",
        precondition: { triggerDeletionProof: resultReference(
          "prove-setup-triggers-deleted", "proof_digest") },
        requests: [
          { method: "DELETE", path: apiPathReference(
            "/builds/tokens/{build_token_uuid}", "production-build-token", "build_token_uuid") },
          { method: "DELETE", path: apiPathReference(
            "/builds/tokens/{build_token_uuid}", "review-build-token", "build_token_uuid") },
        ] },
      { id: "prove-setup-build-tokens-deleted", actor: "workers-builds-control-plane-operator",
        action: "prove-exhaustive-build-token-inventory-excludes-both-journaled-token-uuids",
        mutation: false,
        request: { method: "GET", path: "/builds/tokens" },
        stability: "two-complete-identical-passes-plus-final-identical-sweep",
        produces: { proof_digest: "fresh-setup-token-absence-readback-digest" } },
      { id: "retain-repository-connection", actor: "workers-builds-control-plane-operator",
        action: "retain-shared-metaserver-repository-connection-provider-has-no-read-inventory-and-website-must-survive",
        mutation: false },
      { id: "prove-production-preserved", actor: "workers-builds-control-plane-operator",
        action: "prove-three-production-workers-and-website-app-selection-unchanged",
        mutation: false,
        precondition: { tokenDeletionProof: resultReference(
          "prove-setup-build-tokens-deleted", "proof_digest") },
        command: "npm run provision:workers-builds:verify-preflight" },
    ],
  };
  validateSetupPlan(plan);
  return plan;
}

export function validateSetupPlan(plan) {
  if (!same(plan?.providerTopology, {
    mode: "one-worker-two-triggers", maximumTriggersPerWorker: 2,
    productionTriggerRole: "production", reviewTriggerRole: "preview",
    triggerEnvironmentIsolation: true,
    documentation: "https://developers.cloudflare.com/workers/ci-cd/builds/api-reference/",
    documentedContract:
      "each-worker-up-to-two-triggers-production-and-preview-with-per-trigger-build-token-commands-and-environment",
    lastVerifiedOn: "2026-08-16",
    retained12002Constraint: "one-repository-connection-two-workers-rejected-never-retry",
  }) || !same(plan?.retainedFailedRequest, {
    error: 12002, topology: "one-repository-connection-two-workers",
    disposition: "forbidden-never-retry-or-vary",
  }) || !same(plan?.retainedRejectedPreviewRequest, {
    error: 12002, topology: "one-worker-two-triggers-private-sentinel-preview",
    disposition: "forbidden-never-retry-or-normalize",
  })) fail("provider trigger topology or retained failure constraint drift");
  const operations = plan?.setupOperations;
  const expectedOperations = [
    ["preflight", "workers-builds-control-plane-operator", false,
      "require-exact-private-readback-no-competing-trigger-and-validate-private-random-production-sentinel-ref-absence"],
    ["production-script", "workers-builds-control-plane-operator", false,
      "select-exact-existing-production-script-tag"],
    ["repository-connection", "workers-builds-control-plane-operator", true,
      "put-or-reuse-exact-repository-connection-and-always-retain-on-rollback"],
    ["production-build-token", "workers-builds-control-plane-operator", true,
      "post-build-token-only-after-exact-list-proves-no-match-or-resume-journal-binds-one"],
    ["review-build-token", "workers-builds-control-plane-operator", true,
      "post-build-token-only-after-exact-list-proves-no-match-or-resume-journal-binds-one"],
    ["sentinel-recheck-before-production-trigger", "github-owner-readback", false,
      "repeat-exact-private-random-production-sentinel-ref-absence-proof-outside-sandbox"],
    ["production-trigger-staged", "workers-builds-control-plane-operator", true,
      "post-inert-trigger-with-zero-resource-token"],
    ["sentinel-recheck-before-production-environment", "github-owner-readback", false,
      "repeat-exact-private-random-production-sentinel-ref-absence-proof-outside-sandbox"],
    ["production-environment", "workers-builds-control-plane-operator", true,
      "patch-exact-environment"],
    ["staged-readback", "workers-builds-control-plane-operator", false,
      "prove-one-inert-production-trigger-review-trigger-absent-tokens-and-no-deploy-hooks"],
  ];
  if (!Array.isArray(operations) || new Set(operations.map(({ id }) => id)).size !== operations.length)
    fail("setup operation identity is incomplete or duplicated");
  if (!same(operations.map(({ id, actor, mutation, action }) => [id, actor, mutation, action]),
    expectedOperations))
    fail("setup operation set, order, actor, or mutation boundary drift");
  const expectedProduces = new Map([
    ["preflight", { production_sentinel_branch: "private-random-branch-name",
      production_sentinel_refs: "exact-empty-array",
      repository_connection_owner_proof: "fresh-exact-cloudflare-owner-ui-proof" }],
    ["production-script", { script_tag: { sourceField: "tag", pattern: "32-lowercase-hex" } }],
    ["repository-connection", { repo_connection_uuid: "provider-repository-connection-uuid" }],
    ["production-build-token", { build_token_uuid: "provider-build-token-uuid",
      cloudflare_token_id: "exact-private-input-token-id" }],
    ["review-build-token", { build_token_uuid: "provider-build-token-uuid",
      cloudflare_token_id: "exact-private-input-token-id" }],
    ["sentinel-recheck-before-production-trigger",
      { proof_digest: "fresh-production-sentinel-absence-proof-digest" }],
    ["production-trigger-staged", { trigger_uuid: "provider-trigger-uuid" }],
    ["sentinel-recheck-before-production-environment",
      { proof_digest: "fresh-production-sentinel-absence-proof-digest" }],
    ["staged-readback", { proof_digest: "fresh-private-staged-verifier-digest" }],
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
  const reviewOperations = plan.reviewActivation?.operations;
  const expectedReviewOperations = [
    ["review-activation-authority", "workers-builds-control-plane-operator", false,
      "bind-fresh-owner-token-sentinel-usage-and-staged-evidence-into-bounded-review-phase-authority"],
    ["review-root-recheck-before-trigger", "github-owner-readback", false,
      "prove-private-random-review-staging-root-absent-from-every-current-non-main-ref-outside-sandbox"],
    ["review-trigger-create", "workers-builds-control-plane-operator", true,
      "post-preview-role-trigger-with-private-absent-root-inert-commands-and-zero-resource-token"],
    ["review-environment", "workers-builds-control-plane-operator", true,
      "patch-exact-nonsecret-review-environment"],
    ["review-environment-readback-before-activation", "workers-builds-control-plane-operator",
      false, "prove-three-stable-reads-of-journaled-triggers-private-root-environments-and-no-competing-build-path"],
    ["review-root-recheck-before-activation", "github-owner-readback", false,
      "repeat-private-random-review-staging-root-absence-proof-immediately-before-final-preview-patch-outside-sandbox"],
    ["review-trigger-activate", "workers-builds-control-plane-operator", true,
      "patch-preview-trigger-atomically-to-reviewed-root-and-commands"],
    ["review-activation-readback", "workers-builds-control-plane-operator", false,
      "prove-final-review-trigger-production-staged-and-no-build-active"],
    ["disposable-review-proof-authority", "workers-builds-control-plane-operator", false,
      "bind-fresh-review-active-owner-token-sentinel-usage-evidence-into-bounded-disposable-proof-authority"],
  ];
  if (!Array.isArray(reviewOperations) || !same(reviewOperations.map(
    ({ id, actor, mutation, action }) => [id, actor, mutation, action]), expectedReviewOperations))
    fail("review activation operation set, order, or authority drift");
  inspect({ ...plan.reviewActivation, operations: undefined });
  for (const operation of reviewOperations) {
    inspect(operation);
    available.set(operation.id, new Set(Object.keys(operation.produces ?? {})));
  }
  inspect(plan.disposableProof);
  const activationOperations = plan.productionActivation?.preconditionOperations;
  const expectedActivationOperations = [
    ["production-activation-readback", "workers-builds-control-plane-operator", false,
      "prove-review-active-production-staged-and-disposable-review-result"],
    ["sentinel-recheck-before-production-activation", "github-owner-readback", false,
      "repeat-exact-private-random-production-sentinel-ref-absence-proof-outside-sandbox"],
  ];
  if (!Array.isArray(activationOperations) ||
      !same(activationOperations.map(({ id, actor, mutation, action }) =>
        [id, actor, mutation, action]), expectedActivationOperations))
    fail("production activation proof operation set, order, or authority drift");
  for (const operation of activationOperations) {
    inspect(operation);
    available.set(operation.id, new Set(Object.keys(operation.produces ?? {})));
  }
  inspect(plan.productionActivation);
  const rollbackOperations = plan.rollbackOperations;
  if (!Array.isArray(rollbackOperations) ||
      new Set(rollbackOperations.map(({ id }) => id)).size !== rollbackOperations.length)
    fail("rollback operation identity is incomplete or duplicated");
  const expectedRollback = [
    ["delete-review-trigger-before-quiescence", "workers-builds-control-plane-operator", true,
      "delete-exact-journaled-review-trigger-before-any-non-main-push-can-race-quiescence"],
    ["prove-review-trigger-deleted-before-quiescence", "workers-builds-control-plane-operator",
      false, "prove-phase-aware-exhaustive-inventory-is-empty-or-exactly-journaled-production-trigger"],
    ["sentinel-recheck-before-production-rollback", "github-owner-readback", false,
      "repeat-exact-private-random-production-sentinel-ref-absence-proof-outside-sandbox"],
    ["restore-production-trigger-to-inert-sentinel", "workers-builds-control-plane-operator", true,
      "restore-production-trigger-to-its-exact-inert-production-sentinel-before-cancelling-exact-active-builds"],
    ["prove-production-trigger-inert-before-quiescence", "workers-builds-control-plane-operator",
      false, "prove-phase-aware-production-trigger-is-absent-or-exactly-restored-to-inert-sentinel"],
    ["prove-rollback-quiescence", "workers-builds-control-plane-operator", false,
      "prove-no-build-or-upload-remains-active"],
    ["delete-production-trigger", "workers-builds-control-plane-operator", true,
      "delete-exact-journaled-production-trigger-after-quiescence"],
    ["prove-setup-triggers-deleted", "workers-builds-control-plane-operator", false,
      "prove-exhaustive-shared-core-trigger-inventory-is-empty"],
    ["delete-setup-build-tokens", "workers-builds-control-plane-operator", true,
      "delete-only-the-two-recorded-build-token-uuids"],
    ["prove-setup-build-tokens-deleted", "workers-builds-control-plane-operator", false,
      "prove-exhaustive-build-token-inventory-excludes-both-journaled-token-uuids"],
    ["retain-repository-connection", "workers-builds-control-plane-operator", false,
      "retain-shared-metaserver-repository-connection-provider-has-no-read-inventory-and-website-must-survive"],
    ["prove-production-preserved", "workers-builds-control-plane-operator", false,
      "prove-three-production-workers-and-website-app-selection-unchanged"],
  ];
  if (!same(rollbackOperations.map(({ id, actor, mutation, action }) =>
    [id, actor, mutation, action]), expectedRollback))
    fail("rollback operation set, order, actor, or mutation boundary drift");
  for (const operation of rollbackOperations) {
    inspect(operation);
    available.set(operation.id, new Set(Object.keys(operation.produces ?? {})));
  }
  const actualDigest = digestJson(plan);
  if (actualDigest !== expectedSetupPlanSha256)
    fail(`complete setup plan schema drift (${actualDigest})`);
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
    fail("review trigger environment drift");
}

export function validateReviewStagedEnvironmentReadback({ trigger, environment },
  expectedTrigger, review) {
  if (!reviewStagingRootPattern.test(expectedTrigger?.root_directory ?? "") ||
      expectedTrigger.build_command !== "exit 1" || expectedTrigger.deploy_command !== "exit 1")
    fail("review staged trigger expectation is unsafe");
  validateTriggerSnapshot(trigger, expectedTrigger, "staged review");
  validateAutomaticReviewEnvironment(requireEnvelope(environment,
    "staged review environment"), review);
  return { outcome: "review-staged-environment-readback-valid", mutation: false,
    proof_digest: digestJson({ trigger, environment }) };
}

export function validateNoDeployHooks(envelope, label) {
  const hooks = requireExhaustiveEnvelope(envelope, `${label} deploy hooks`);
  if (hooks.length !== 0)
    fail(`${label} gained a Deploy Hook`);
}

export function validateRollbackTriggerInventory(envelope, {
  productionTriggerUuid = null, reviewTriggerUuid = null,
} = {}) {
  if (productionTriggerUuid !== null && !uuidPattern.test(productionTriggerUuid) ||
      reviewTriggerUuid !== null && !uuidPattern.test(reviewTriggerUuid) ||
      productionTriggerUuid !== null && productionTriggerUuid === reviewTriggerUuid)
    fail("rollback journaled trigger identity is malformed");
  const rows = requireExhaustiveEnvelope(envelope, "rollback shared core triggers");
  const expected = productionTriggerUuid === null ? [] : [productionTriggerUuid];
  if (!same(rows.map(({ trigger_uuid: id }) => id), expected) ||
      rows.some(({ trigger_uuid: id }) => !uuidPattern.test(id ?? "")) ||
      (reviewTriggerUuid !== null && rows.some(({ trigger_uuid: id }) => id === reviewTriggerUuid)))
    fail("rollback trigger inventory contains a competing or unreconciled trigger");
  return { outcome: "rollback-trigger-inventory-exact", mutation: false,
    proof_digest: digestJson({ productionTriggerUuid, reviewTriggerUuid, rows }) };
}

export function validateRollbackProductionTriggerReadback(envelope, {
  productionTriggerUuid = null, expectedTrigger = null,
} = {}) {
  if (productionTriggerUuid !== null && !uuidPattern.test(productionTriggerUuid))
    fail("rollback production trigger identity is malformed");
  const rows = requireExhaustiveEnvelope(envelope, "rollback production trigger readback");
  if (productionTriggerUuid === null) {
    if (rows.length !== 0)
      fail("rollback production trigger must be absent before creation");
  } else {
    if (rows.length !== 1 || rows[0]?.trigger_uuid !== productionTriggerUuid)
      fail("rollback production trigger inventory is not exact");
    validateTriggerSnapshot(rows[0], expectedTrigger, "rollback production inert");
  }
  return { outcome: "rollback-production-trigger-inert", mutation: false,
    proof_digest: digestJson({ productionTriggerUuid, expectedTrigger, rows }) };
}

export function validateNoActiveBuilds(envelope, label) {
  const builds = requireExhaustiveEnvelope(envelope, `${label} builds`);
  if (builds.some(({ status }) =>
    !["queued", "initializing", "running", "stopped"].includes(status)))
    fail(`${label} build inventory is malformed`);
  if (builds.some(({ status }) => status !== "stopped"))
    fail(`${label} has an active Workers Build`);
}

function validateRetiredReviewWorkerAbsent(scriptRows, review, label) {
  const retiredName = review?.automaticReview?.localValidation?.workerName;
  if (review?.automaticReview?.costPolicy?.persistentWorkers !== 0 ||
      typeof retiredName !== "string" || !retiredName ||
      retiredName === review?.automaticReview?.project)
    fail("retired review Worker contract is malformed");
  const count = scriptRows.filter(({ id }) => id === retiredName).length;
  if (count !== 0) fail(`${label} contains the retired review Worker`);
  return count;
}

export function validateFreshBuildsSnapshot({ production, review, scripts,
  triggers, deployHooks, builds, buildTokens, accountTriggers,
  productionSentinelProof, repositoryConnectionProof, accountId,
  sourceSha }) {
  const scriptRows = requireEnvelope(scripts, "scripts");
  if (!Array.isArray(scriptRows)) fail("script inventory is invalid");
  const reviewPersistentWorkerCount = validateRetiredReviewWorkerAbsent(
    scriptRows, review, "fresh Worker inventory");
  const requiredNames = production.workers.map(({ name }) => name);
  for (const name of requiredNames) {
    const matches = scriptRows.filter(({ id }) => id === name);
    if (matches.length !== 1 || !scriptTagPattern.test(matches[0].tag ?? ""))
      fail(`required production Worker ${name} is missing or ambiguous`);
  }
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
  validateSentinelRefAbsence(productionSentinelProof);
  validateRepositoryConnectionOwnerProof(repositoryConnectionProof, accountId, sourceSha);
  return { outcome: "workers-builds-fresh-preflight-valid", mutation: false,
    productionProjectCount: production.workers.length,
    reviewPersistentWorkerCount, repositoryConnectionInventory: "provider-not-readable" };
}

export function validateInitialBootstrapSnapshot({ production, review, scripts,
  triggers, deployHooks, builds, buildTokens, accountTriggers }) {
  if (production.initialBootstrapPredecessor?.requiredPhase !==
      "all-builds-triggers-absent")
    fail("initial production bootstrap predecessor phase drift");
  const scriptRows = requireEnvelope(scripts, "initial bootstrap scripts");
  if (!Array.isArray(scriptRows) || production.workers.some(({ name }) =>
    scriptRows.filter(({ id }) => id === name).length !== 1))
    fail("initial bootstrap Worker inventory drift");
  validateRetiredReviewWorkerAbsent(scriptRows, review, "initial bootstrap Worker inventory");
  const expectedLabels = production.workers.map(({ role }) => role);
  for (const [label, envelope] of exactLabeledInventories(triggers,
    expectedLabels, "initial bootstrap trigger")) {
    if (requireExhaustiveEnvelope(envelope, `${label} triggers`).length !== 0)
      fail(`${label} trigger makes the initial bootstrap predecessor unavailable`);
  }
  for (const [label, envelope] of exactLabeledInventories(deployHooks,
    expectedLabels, "initial bootstrap Deploy Hook")) validateNoDeployHooks(envelope, label);
  for (const [label, envelope] of exactLabeledInventories(builds,
    expectedLabels, "initial bootstrap build")) validateNoActiveBuilds(envelope, label);
  const allTriggers = requireExhaustiveEnvelope(accountTriggers, "initial bootstrap account triggers")
    .filter(({ repo_connection: connection }) => connection?.provider_type === "github" &&
      connection.provider_account_id === githubRepository.provider_account_id &&
      connection.repo_id === githubRepository.repo_id);
  if (allTriggers.length !== 0)
    fail("repository trigger makes the initial bootstrap predecessor unavailable");
  const reservedNames = new Set([
    "Atrinik metaserver production", "Atrinik metaserver review check",
  ]);
  if (requireExhaustiveEnvelope(buildTokens, "initial bootstrap build tokens")
    .some(({ build_token_name: name }) => reservedNames.has(name)))
    fail("reserved build token makes the initial bootstrap predecessor unavailable");
  return { outcome: "initial-production-bootstrap-predecessor-proven", mutation: false };
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

export function validateReviewBuildBoundary({ review, builds, buildLimits,
  buildUsageProof, accountId }, now = Date.now()) {
  validateNoActiveBuilds(builds, "review trigger");
  const limits = requireEnvelope(buildLimits, "Workers Builds account limits");
  if (typeof limits.has_reached_build_minutes_limit !== "boolean" ||
      (limits.build_minutes_refresh_on !== undefined &&
       !Number.isFinite(Date.parse(limits.build_minutes_refresh_on))))
    fail("Workers Builds account limit readback is malformed");
  if (limits.has_reached_build_minutes_limit)
    fail("Workers Builds account has reached its monthly limit");
  validateBuildUsageProof(review, buildUsageProof, accountId, now);
}

export function validateConfiguredBuildsSnapshot({ production, review, scripts,
  productionTriggers, productionEnvironment, reviewTriggers, reviewEnvironment,
  nonEntrypointTriggers, deployHooks, buildTokens, accountTriggers,
  reviewBuildState, accountId, tokenAuthorityProofs, sourceSha }) {
  const scriptRows = requireEnvelope(scripts, "scripts");
  if (!Array.isArray(scriptRows)) fail("script inventory is invalid");
  validateRetiredReviewWorkerAbsent(scriptRows, review, "configured Worker inventory");
  const matches = scriptRows.filter(({ id }) => id === production.workers[0].name);
  if (matches.length !== 1 || review.automaticReview.project !== production.workers[0].name ||
      !scriptTagPattern.test(matches[0].tag ?? ""))
    fail("configured shared Builds project is missing or malformed");
  const productionScript = matches[0];
  const reviewScript = matches[0];
  const sharedRows = requireExhaustiveEnvelope(productionTriggers, "shared core triggers");
  if (!same(productionTriggers, reviewTriggers) || sharedRows.length !== 2)
    fail("configured core project does not have exactly two shared triggers");
  const productionRows = sharedRows.filter(({ trigger_name: name }) =>
    name === "Atrinik automatic production main");
  const reviewRows = sharedRows.filter(({ trigger_name: name }) =>
    name === "Atrinik build-only review");
  if (productionRows.length !== 1 || reviewRows.length !== 1)
    fail("configured production/preview trigger roles are missing or ambiguous");
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
  validateReviewBuildBoundary({ review, ...reviewBuildState, accountId });
  for (const [label, envelope] of exactLabeledInventories(deployHooks,
    production.workers.map(({ role }) => role), "Deploy Hook"))
    validateNoDeployHooks(envelope, label);
  return {
    outcome: "workers-builds-configured-snapshot-valid",
    mutation: false,
    productionTriggerCount: 1,
    reviewTriggerCount: 1,
    deployHookCount: 0,
  };
}

export function validateReviewResultProof({ proof, reviewTrigger, reviewToken, builds, mainSha },
  now = Date.now()) {
  const keys = ["branch", "buildTokenUuid", "buildUuid", "capturedAt", "cleanupPolicy",
    "evidenceLocation", "githubEvidence", "repository", "reviewCommitSha", "source",
    "triggerUuid", "productionMainSha"];
  const captured = Date.parse(proof?.capturedAt ?? "");
  const rows = requireExhaustiveEnvelope(builds, "review result builds");
  const matches = rows.filter(({ build_uuid: id }) => id === proof?.buildUuid);
  const row = matches[0];
  const metadata = row?.build_trigger_metadata ?? {};
  const created = Date.parse(row?.created_on ?? "");
  const stopped = Date.parse(row?.stopped_on ?? "");
  const evidenceCaptured = Date.parse(proof?.githubEvidence?.capturedAt ?? "");
  const checkRuns = proof?.githubEvidence?.checkRuns;
  const check = checkRuns?.check_runs?.[0];
  const checkStarted = Date.parse(check?.started_at ?? "");
  const checkCompleted = Date.parse(check?.completed_at ?? "");
  let details;
  try { details = new URL(check?.details_url ?? ""); } catch { details = null; }
  const triggerKeys = ["branch_excludes", "branch_includes", "build_caching_enabled",
    "build_command", "deploy_command", "external_script_id", "path_excludes", "path_includes",
    "root_directory", "trigger_name", "trigger_uuid"];
  const liveTriggerView = Object.fromEntries(triggerKeys.map((key) => [key,
    key === "root_directory" ? normalizedRoot(reviewTrigger[key]) : reviewTrigger[key]]));
  const buildTriggerView = Object.fromEntries(triggerKeys.map((key) => [key,
    key === "root_directory" ? normalizedRoot(row?.trigger?.[key]) : row?.trigger?.[key]]));
  if (!proof || !same(sorted(Object.keys(proof)), sorted(keys)) ||
      proof.source !== "cloudflare-github-disposable-review-readback" ||
      proof.repository !== "atrinik/metaserver-worker" ||
      proof.productionMainSha !== mainSha || proof.reviewCommitSha === mainSha ||
      !/^review\/issue-66-[a-z0-9-]{1,40}$/u.test(proof.branch ?? "") ||
      !gitShaPattern.test(proof.reviewCommitSha ?? "") || !uuidPattern.test(proof.buildUuid ?? "") ||
      proof.triggerUuid !== reviewTrigger.trigger_uuid ||
      proof.buildTokenUuid !== reviewToken.build_token_uuid ||
      proof.cleanupPolicy !== "build-only-no-version-binding-route-url-or-resource-created" ||
      proof.evidenceLocation !== "atrinik/metaserver-worker#66-private-provider-evidence" ||
      !Number.isFinite(captured) || captured > now + 30_000 || now - captured > 5 * 60_000 ||
      matches.length !== 1 || row.status !== "stopped" || row.build_outcome !== "success" ||
      row.trigger?.trigger_uuid !== proof.triggerUuid || metadata.branch !== proof.branch ||
      metadata.commit_hash !== proof.reviewCommitSha ||
      metadata.build_token_uuid !== proof.buildTokenUuid ||
      metadata.build_trigger_source !== "push_event" ||
      metadata.provider_type !== "github" || metadata.provider_account_name !== "atrinik" ||
      metadata.repo_name !== githubRepository.repo_name ||
      row.trigger?.repo_connection?.provider_account_id !==
        githubRepository.provider_account_id ||
      row.trigger?.repo_connection?.repo_id !== githubRepository.repo_id ||
      row.trigger?.repo_connection?.repo_connection_uuid !==
        reviewTrigger.repo_connection?.repo_connection_uuid ||
      metadata.build_command !== reviewTrigger.build_command ||
      metadata.deploy_command !== reviewTrigger.deploy_command ||
      normalizedRoot(metadata.root_directory) !== normalizedRoot(reviewTrigger.root_directory) ||
      !same(buildTriggerView, liveTriggerView) ||
      !Number.isFinite(created) || !Number.isFinite(stopped) || created > stopped ||
      stopped - created > 20 * 60_000 || stopped > captured || captured - stopped > 5 * 60_000 ||
      !Number.isFinite(evidenceCaptured) || evidenceCaptured > now + 30_000 ||
      evidenceCaptured < stopped || now - evidenceCaptured > 5 * 60_000 ||
      !Array.isArray(proof.githubEvidence?.refs) || proof.githubEvidence.refs.length !== 0 ||
      proof.githubEvidence?.comparison?.status === "ahead" ||
      proof.githubEvidence?.comparison?.status === "identical" ||
      !["behind", "diverged"].includes(proof.githubEvidence?.comparison?.status) ||
      proof.githubEvidence?.comparison?.base_commit?.sha !== proof.reviewCommitSha ||
      proof.githubEvidence?.comparison?.head_commit?.sha !== mainSha ||
      checkRuns?.total_count !== 1 || !Array.isArray(checkRuns?.check_runs) ||
      checkRuns.check_runs.length !== 1 || !Number.isSafeInteger(check?.id) ||
      check.name !== "Workers Builds: atrinik-metaserver" || check.status !== "completed" ||
      check.conclusion !== "success" || check.head_sha !== proof.reviewCommitSha ||
      check.app?.id !== 85455 || typeof check.external_id !== "string" || !check.external_id ||
      details?.protocol !== "https:" || details.hostname !== "dash.cloudflare.com" ||
      !details.pathname.includes(proof.buildUuid) || !Number.isFinite(checkStarted) ||
      !Number.isFinite(checkCompleted) || checkStarted > checkCompleted ||
      checkCompleted > evidenceCaptured)
    fail("disposable review result proof is missing, stale, failed, or mismatched");
  return proof;
}

function validateActivationSnapshot({ production, review, scripts,
  productionTriggers, productionEnvironment, reviewTriggers, reviewEnvironment,
  nonEntrypointTriggers, deployHooks, builds, buildTokens, accountTriggers, reviewBuildState,
  accountId, tokenAuthorityProofs, sourceSha,
  productionSentinelProof,
  snapshotManifest, reviewResultProof, reviewActivationAuthorityProof,
  reviewActivationAuthorityEvidence, reviewActivationAuthorityCheckpoint },
{ reviewActive, requireReviewResult = reviewActive,
  authorityRequired = reviewActive && !requireReviewResult,
  includeLiveIdentities = false }) {
  const reviewAuthority = reviewActive && !requireReviewResult && authorityRequired ?
    (reviewActivationAuthorityCheckpoint ? validateReviewActivationAuthorityCheckpoint(
      reviewActivationAuthorityProof, {
        production, review, accountId, sourceSha, ...reviewActivationAuthorityEvidence,
      }, reviewActivationAuthorityCheckpoint) :
      validateReviewActivationAuthority(reviewActivationAuthorityProof, {
        production, review, accountId, sourceSha, ...reviewActivationAuthorityEvidence,
      })) : null;
  const proofValidationTime = reviewAuthority?.proofValidationTime ?? Date.now();
  if (reviewAuthority &&
      (!same(productionSentinelProof, reviewActivationAuthorityEvidence.productionSentinelProof) ||
       !same(tokenAuthorityProofs, reviewActivationAuthorityEvidence.tokenAuthorityProofs) ||
       !same(reviewBuildState.buildUsageProof,
         reviewActivationAuthorityEvidence.buildUsageProof)))
    fail("review activation snapshot authority evidence drift");
  validateSentinelRefAbsence(productionSentinelProof, proofValidationTime);
  const scriptRows = requireEnvelope(scripts, "scripts");
  if (!Array.isArray(scriptRows)) fail("script inventory is invalid");
  validateRetiredReviewWorkerAbsent(scriptRows, review, "staged Worker inventory");
  const matches = scriptRows.filter(({ id }) => id === production.workers[0].name);
  if (matches.length !== 1 || review.automaticReview.project !== production.workers[0].name ||
      !scriptTagPattern.test(matches[0].tag ?? ""))
    fail("staged shared Builds project is missing or malformed");
  const productionScript = matches[0];
  const reviewScript = matches[0];
  const sharedRows = requireExhaustiveEnvelope(productionTriggers, "staged shared core triggers");
  const expectedTriggerCount = reviewActive ? 2 : 1;
  if (!same(productionTriggers, reviewTriggers) || sharedRows.length !== expectedTriggerCount)
    fail(`staged core project does not have exactly ${expectedTriggerCount} shared trigger(s)`);
  const productionRows = sharedRows.filter(({ trigger_name: name }) =>
    name === "Atrinik automatic production main");
  const reviewRows = sharedRows.filter(({ trigger_name: name }) =>
    name === "Atrinik build-only review");
  if (productionRows.length !== 1 || reviewRows.length !== (reviewActive ? 1 : 0))
    fail("staged production/preview trigger phase is missing or ambiguous");
  const tokenRows = requireExhaustiveEnvelope(buildTokens, "build tokens");
  const reviewToken = tokenRows.find(({ build_token_name: name }) =>
    name === "Atrinik metaserver review check");
  const productionToken = tokenRows.find(({ build_token_name: name }) =>
    name === "Atrinik metaserver production");
  if (!productionToken || !reviewToken ||
      productionRows[0].build_token_uuid !== reviewToken.build_token_uuid ||
      (reviewActive && reviewRows[0].build_token_uuid !== reviewToken.build_token_uuid))
    fail("staged trigger phase does not use the zero-resource review token");
  validateBuildTokenInventory(buildTokens, [
    { uuid: productionToken.build_token_uuid, name: "Atrinik metaserver production",
      cloudflareTokenId: tokenAuthorityProofs?.find(({ kind }) => kind === "production")?.tokenId },
    { uuid: reviewToken.build_token_uuid, name: "Atrinik metaserver review check",
      cloudflareTokenId: tokenAuthorityProofs?.find(({ kind }) => kind === "review")?.tokenId },
  ]);
  validateTokenAuthorityProofs({ production, review, accountId, proofs: tokenAuthorityProofs,
    tokenRows: { production: productionToken, review: reviewToken }, sourceSha },
  proofValidationTime);
  const productionExpected = productionTriggerSpec(production, {
    externalScriptId: productionScript.tag,
    repositoryConnectionUuid: productionRows[0].repo_connection?.repo_connection_uuid,
    buildTokenUuid: reviewToken.build_token_uuid,
  });
  productionExpected.branch_includes = [productionSentinelProof.branch];
  validateTriggerSnapshot(productionRows[0], productionExpected, "staged production");
  if (reviewActive) {
    const reviewExpected = automaticReviewTriggerSpec(review, {
      externalScriptId: reviewScript.tag,
      repositoryConnectionUuid: reviewRows[0].repo_connection?.repo_connection_uuid,
      buildTokenUuid: reviewToken.build_token_uuid,
    });
    validateTriggerSnapshot(reviewRows[0], reviewExpected, "staged review");
    if (productionRows[0].repo_connection.repo_connection_uuid !==
        reviewRows[0].repo_connection.repo_connection_uuid)
      fail("staged triggers do not share the journaled repository connection");
  }
  validateBuildEnvironment(production, requireEnvelope(productionEnvironment,
    "staged production environment"));
  if (reviewActive) validateAutomaticReviewEnvironment(requireEnvelope(reviewEnvironment,
    "staged review environment"), review);
  else if (reviewEnvironment !== undefined)
    fail("staged review environment exists before review activation");
  for (const [label, envelope] of exactLabeledInventories(nonEntrypointTriggers,
    production.workers.slice(1).map(({ role }) => role), "staged non-entrypoint trigger"))
    if (requireExhaustiveEnvelope(envelope, `${label} staged triggers`).length !== 0)
      fail(`${label} has an independent staged Builds trigger`);
  const metaserverTriggers = requireExhaustiveEnvelope(accountTriggers, "account triggers")
    .filter(({ repo_connection: connection }) => connection?.provider_type === "github" &&
      connection.provider_account_id === githubRepository.provider_account_id &&
      connection.repo_id === githubRepository.repo_id);
  if (!same(sorted(metaserverTriggers.map(({ trigger_uuid: id }) => id)),
    sorted(reviewActive ? [productionRows[0].trigger_uuid, reviewRows[0].trigger_uuid] :
      [productionRows[0].trigger_uuid])))
    fail("staged account trigger inventory drift");
  const stagedLabels = production.workers.map(({ role }) => role);
  for (const [label, envelope] of exactLabeledInventories(deployHooks, stagedLabels,
    "staged Deploy Hook")) validateNoDeployHooks(envelope, label);
  for (const [label, envelope] of exactLabeledInventories(builds, stagedLabels,
    "staged build")) validateNoActiveBuilds(envelope, label);
  validateReviewBuildBoundary({ review, ...reviewBuildState, accountId }, proofValidationTime);
  if (requireReviewResult) validateReviewResultProof({ proof: reviewResultProof,
    reviewTrigger: reviewRows[0], reviewToken,
    builds: reviewBuildState.builds, mainSha: sourceSha });
  validateSnapshotManifest(snapshotManifest, { accountId, sourceSha, production, review });
  const capturedAt = new Date().toISOString();
  const snapshotCoordinate = { accountId: snapshotManifest.accountId,
    sourceSha: snapshotManifest.sourceSha,
    productionContractSha256: snapshotManifest.productionContractSha256,
    reviewContractSha256: snapshotManifest.reviewContractSha256 };
  const sentinelCoordinates = {
    production: { repository: productionSentinelProof.repository,
      branch: productionSentinelProof.branch, refs: productionSentinelProof.refs },
  };
  const state_digest = digestJson({ snapshotCoordinate, sentinelCoordinates, scripts,
    productionTriggers, productionEnvironment, reviewTriggers, reviewEnvironment,
    nonEntrypointTriggers, deployHooks, builds, buildTokens, accountTriggers,
    reviewBuildState, tokenAuthorityProofs,
    ...(reviewAuthority ? { reviewActivationAuthorityProof } : {}),
    ...(requireReviewResult ? { reviewResultProof } : {}) });
  const liveIdentities = includeLiveIdentities ? {
    productionTriggerUuid: productionRows[0].trigger_uuid,
    reviewTriggerUuid: reviewRows[0].trigger_uuid,
    productionBuildTokenUuid: productionToken.build_token_uuid,
    reviewBuildTokenUuid: reviewToken.build_token_uuid,
    repositoryConnectionUuid: reviewRows[0].repo_connection.repo_connection_uuid,
    productionEnvironmentDigest: digestJson(productionEnvironment),
    reviewEnvironmentDigest: digestJson(reviewEnvironment),
  } : undefined;
  const proof_digest = digestJson({ state_digest,
    snapshotStartedAt: snapshotManifest.startedAt,
    snapshotCompletedAt: snapshotManifest.completedAt, capturedAt,
    ...(liveIdentities ? { liveIdentities } : {}) });
  return { outcome: requireReviewResult ? "workers-builds-production-activation-snapshot-valid" :
    reviewActive ? "workers-builds-review-activation-snapshot-valid" :
      "workers-builds-staged-snapshot-valid", mutation: false,
    stagedTriggerCount: expectedTriggerCount, accountId, sourceSha, capturedAt,
    snapshotStartedAt: snapshotManifest.startedAt,
    snapshotCompletedAt: snapshotManifest.completedAt, state_digest, proof_digest,
    ...(liveIdentities ? { liveIdentities } : {}) };
}

export function validateStagedBuildsSnapshot(arguments_) {
  return validateActivationSnapshot(arguments_, { reviewActive: false });
}

export function validateProductionActivationSnapshot(arguments_) {
  return validateActivationSnapshot(arguments_, { reviewActive: true });
}

export function validateReviewActivationSnapshot(arguments_) {
  return validateActivationSnapshot(arguments_, { reviewActive: true,
    requireReviewResult: false });
}

export function validateStagedProof(proof, current, now = Date.now()) {
  if (!proof || !current ||
      proof.accountId !== current.accountId || proof.sourceSha !== current.sourceSha ||
      proof.state_digest !== current.state_digest)
    fail("staged activation proof is missing, stale, or mismatched");
  try {
    validateStagedSnapshotProofEvidence(proof,
      { accountId: proof.accountId, sourceSha: proof.sourceSha }, now);
    validateStagedSnapshotProofEvidence(current,
      { accountId: proof.accountId, sourceSha: proof.sourceSha }, now, 30_000);
  } catch { fail("staged activation proof is missing, stale, or mismatched"); }
  if (Date.parse(current.capturedAt) < Date.parse(proof.capturedAt) ||
      Date.parse(current.snapshotStartedAt) < Date.parse(proof.snapshotCompletedAt) ||
      Date.parse(current.snapshotCompletedAt) < Date.parse(proof.snapshotCompletedAt))
    fail("staged activation proof chronology did not advance");
  return { outcome: "workers-builds-staged-activation-proof-valid", mutation: false,
    state_digest: current.state_digest, proof_digest: current.proof_digest };
}

export function publicStagedProofSummary(proof) {
  return { outcome: proof.outcome, mutation: false,
    ...(proof.stagedTriggerCount === 1 ? { stagedTriggerCount: 1 } : {}),
    sourceSha: proof.sourceSha, proof_digest: proof.proof_digest };
}

export function materializeProductionConfiguration({
  base, liveBase = base, worker, settingsEnvelope, subdomainEnvelope, accountId,
}) {
  if (!accountIdPattern.test(accountId ?? "")) fail("production account ID is malformed");
  const settings = requireEnvelope(settingsEnvelope, `${worker.role} settings`);
  const subdomain = requireEnvelope(subdomainEnvelope, `${worker.role} subdomain`);
  if (subdomain.enabled !== false || subdomain.previews_enabled !== false)
    fail(`${worker.role} enables an alternate production URL`);
  if (
    liveBase.compatibility_date !== settings.compatibility_date ||
    !same(liveBase.compatibility_flags ?? [], settings.compatibility_flags ?? [])
  ) fail(`${worker.role} compatibility settings drift`);

  const config = structuredClone(base);
  const bindings = settings.bindings ?? [];
  if (!Array.isArray(bindings)) fail(`${worker.role} binding inventory is malformed`);
  const actualBindingInventory = bindings.map(({ name, type }) => ({ name, type }))
    .sort((left, right) => `${left.name}:${left.type}`.localeCompare(`${right.name}:${right.type}`));
  if (!same(actualBindingInventory, expectedBindingInventory(liveBase)))
    fail(`${worker.role} binding inventory drift`);
  config.account_id = accountId;
  config.workers_dev = false;
  config.preview_urls = false;
  config.routes = worker.customDomains.map((pattern) => ({ pattern, custom_domain: true }));
  if (Object.hasOwn(config.vars ?? {}, "DIRECTORY_CACHE_ZONE_ID")) {
    const live = oneBinding(bindings, "DIRECTORY_CACHE_ZONE_ID", "plain_text");
    config.vars.DIRECTORY_CACHE_ZONE_ID = live.text;
  }
  for (const [name, expected] of Object.entries(liveBase.vars ?? {})) {
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
  contract, bases, snapshots, accountId, initialBootstrapPredecessor = false,
}) {
  if (!Array.isArray(bases) || bases.length !== 3 || !Array.isArray(snapshots) || snapshots.length !== 3)
    fail("exactly three production configuration snapshots are required");
  const liveConfigurations = contract.workers.map((worker, index) =>
    initialBootstrapPredecessor
      ? initialBootstrapPredecessorConfiguration(contract, bases[index], worker)
      : bases[index]);
  const configurations = contract.workers.map((worker, index) =>
    materializeProductionConfiguration({
      base: bases[index], liveBase: liveConfigurations[index], worker,
      settingsEnvelope: snapshots[index].settings,
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
    const expectedObservability = structuredClone(configurations[index].observability);
    if (observability?.head_sampling_rate === 1 &&
        expectedObservability.head_sampling_rate === undefined)
      expectedObservability.head_sampling_rate = 1;
    if (!sameCanonical(observability, expectedObservability))
      fail(`${contract.workers[index].role} observability configuration drift`);
  }
}

export function validateProductionRuntimeProof({ contract, configurations, deployments,
  activeVersions, migrationEnvelope, migrationNames, liveConfigurations = configurations }) {
  if (!Array.isArray(deployments) || deployments.length !== contract.workers.length ||
      !Array.isArray(activeVersions) || activeVersions.length !== contract.workers.length ||
      !Array.isArray(liveConfigurations) || liveConfigurations.length !== contract.workers.length)
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
    validateRemoteBindings(worker, liveConfigurations[index], active);
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
  validateProductionContract(production);
  await validateReviewContract();
  return { production, review, bases };
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
  if (await realpath(path).catch(() => null) !== resolve(path))
    fail(`${label} file path must be canonical without linked ancestors`);
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

async function readPrivateJsonLines(path, label) {
  if (!isAbsolute(path ?? "")) fail(`${label} file path must be absolute`);
  if (await realpath(path).catch(() => null) !== resolve(path))
    fail(`${label} file path must be canonical without linked ancestors`);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  if (!handle) fail(`${label} file cannot be opened without following links`);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || !isCurrentUserOwned(metadata) || (metadata.mode & 0o077) !== 0 ||
        metadata.size > maximumPrivateDocumentBytes)
      fail(`${label} file must be a bounded private regular file`);
    const raw = await handle.readFile("utf8");
    if (!raw.endsWith("\n") || raw.length === 1) fail(`${label} is not fully framed`);
    return raw.slice(0, -1).split("\n").map((line) => {
      if (!line) fail(`${label} contains an empty frame`);
      try { return JSON.parse(line); }
      catch { fail(`${label} is malformed`); }
    });
  } finally { await handle.close(); }
}

async function loadProductionSentinelProof(environment = process.env) {
  const productionBranch = await readPrivateValue(
    environment.ATRINIK_PRODUCTION_STAGING_SENTINEL_BRANCH_FILE,
    "production staging sentinel branch", stagingBranchPattern);
  const productionProof = await readPrivateJson(
    environment.ATRINIK_PRODUCTION_STAGING_SENTINEL_REFS_FILE,
    "production staging sentinel refs");
  if (productionProof.branch !== productionBranch)
    fail("production staging sentinel proof branch drift");
  return productionProof;
}

export async function readProductionSentinelProof(environment = process.env, now = Date.now()) {
  const productionProof = await loadProductionSentinelProof(environment);
  validateSentinelRefAbsence(productionProof, now);
  return { productionSentinelProof: productionProof };
}

async function readReviewActivationAuthorityEvidence(environment = process.env) {
  return {
    stagedProof: await readPrivateJson(environment.ATRINIK_STAGED_PROOF_FILE,
      "staged activation proof"),
    repositoryConnectionProof: await readPrivateJson(
      environment.ATRINIK_REPOSITORY_CONNECTION_OWNER_PROOF_FILE,
      "shared repository connection owner proof"),
    productionSentinelProof: await loadProductionSentinelProof(environment),
    tokenAuthorityProofs: [
      await readPrivateJson(environment.ATRINIK_PRODUCTION_BUILD_TOKEN_PERMISSION_PROOF_FILE,
        "production build token permission proof"),
      await readPrivateJson(environment.ATRINIK_REVIEW_BUILD_TOKEN_PERMISSION_PROOF_FILE,
        "review build token permission proof"),
    ],
    buildUsageProof: await readPrivateJson(environment.ATRINIK_WORKERS_BUILDS_USAGE_PROOF_FILE,
      "Workers Builds usage proof"),
  };
}

async function readDisposableReviewAuthorityEvidence(environment = process.env,
{ requireCurrent = true } = {}) {
  return {
    reviewActivationProof: await readPrivateJson(
      environment.ATRINIK_REVIEW_ACTIVATION_PROOF_FILE, "review activation proof"),
    reviewActivationJournal: await readPrivateJsonLines(
      environment.ATRINIK_REVIEW_ACTIVATION_JOURNAL_FILE, "review activation journal"),
    inertSetupJournal: await readPrivateJsonLines(environment.ATRINIK_INERT_SETUP_JOURNAL_FILE,
      "inert setup journal"),
    inertSetupResults: await readPrivateJson(environment.ATRINIK_INERT_SETUP_RESULTS_FILE,
      "inert setup results"),
    disposableCoordinate: await readPrivateJson(
      environment.ATRINIK_DISPOSABLE_REVIEW_COORDINATE_FILE,
      "disposable review coordinate"),
    ...(requireCurrent ? { currentReviewActiveProof: await readPrivateJson(
      environment.ATRINIK_CURRENT_REVIEW_ACTIVE_PROOF_FILE, "current review active proof") } : {}),
    repositoryConnectionProof: await readPrivateJson(
      environment.ATRINIK_REPOSITORY_CONNECTION_OWNER_PROOF_FILE,
      "shared repository connection owner proof"),
    productionSentinelProof: await loadProductionSentinelProof(environment),
    tokenAuthorityProofs: [
      await readPrivateJson(environment.ATRINIK_PRODUCTION_BUILD_TOKEN_PERMISSION_PROOF_FILE,
        "production build token permission proof"),
      await readPrivateJson(environment.ATRINIK_REVIEW_BUILD_TOKEN_PERMISSION_PROOF_FILE,
        "review build token permission proof"),
    ],
    buildUsageProof: await readPrivateJson(environment.ATRINIK_WORKERS_BUILDS_USAGE_PROOF_FILE,
      "Workers Builds usage proof"),
  };
}

async function readAndValidateDisposableReviewAuthority({ production, review, accountId,
  sourceSha, environment = process.env,
  minimumRemainingMs = reviewActivationTransitionBudgetMs }) {
  const evidence = await readDisposableReviewAuthorityEvidence(environment);
  const proof = await readPrivateJson(environment.ATRINIK_DISPOSABLE_REVIEW_AUTHORITY_PROOF_FILE,
    "disposable review authority proof");
  const validation = validateDisposableReviewAuthority(proof,
    { production, review, accountId, sourceSha, ...evidence }, Date.now(), minimumRemainingMs);
  return { proof, evidence, validation };
}

async function readAndValidateReviewActivationAuthority({ production, review, accountId,
  sourceSha, environment = process.env, minimumRemainingMs = reviewActivationTransitionBudgetMs }) {
  const evidence = await readReviewActivationAuthorityEvidence(environment);
  const proof = await readPrivateJson(environment.ATRINIK_REVIEW_ACTIVATION_AUTHORITY_PROOF_FILE,
    "review activation authority proof");
  const validation = validateReviewActivationAuthority(proof, {
    production, review, accountId, sourceSha, ...evidence,
  }, Date.now(), minimumRemainingMs);
  return { proof, evidence, validation };
}

export async function readReviewStagingRootProof(proofVariable, expectedPhase,
  environment = process.env, sourceSha, now = Date.now()) {
  const rootDirectory = await readPrivateValue(
    environment.ATRINIK_REVIEW_STAGING_ROOT_DIRECTORY_FILE,
    "review staging root directory", reviewStagingRootPattern);
  const proof = await readPrivateJson(environment[proofVariable],
    "review staging root absence proof");
  return validateReviewStagingRootAbsence(proof, rootDirectory, sourceSha, expectedPhase, now);
}

async function writePrivateJson(path, value) {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT |
    constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.chmod(0o600);
  } finally { await handle.close(); }
}

async function writePrivateProof(path, value) {
  if (!isAbsolute(path ?? "") || resolve(path) !== path)
    fail("private proof output path must be absolute and normalized");
  const parent = dirname(path);
  const metadata = await lstat(parent).catch(() => null);
  if (await realpath(parent).catch(() => null) !== parent || !metadata?.isDirectory() ||
      !isCurrentUserOwned(metadata) || (metadata.mode & 0o077) !== 0)
    fail("private proof output parent must be owner-only and symlink-free");
  await writePrivateJson(path, value);
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

async function providerGet({ accountId, token, outputDirectory, fetchImpl = fetch }, label, path) {
  const response = await fetchImpl(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`, {
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

async function providerPost({ accountId, token, outputDirectory, fetchImpl = fetch }, label, path,
  requestBody) {
  const response = await fetchImpl(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`, {
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

async function providerGetStable(context, label, path) {
  const first = await providerGet(context, `${label}.pass-1`, path);
  const second = await providerGet(context, `${label}.pass-2`, path);
  if (!same(first.result, second.result))
    fail(`${label} provider state changed between complete passes`);
  await writePrivateJson(resolve(context.outputDirectory, `${label}.json`), second);
  context.stableReadbacks.push({ kind: "get", label, path, expected: second.result });
  return second;
}

async function providerPostStable(context, label, path, requestBody, projection = ({ result }) =>
  result) {
  const first = await providerPost(context, `${label}.pass-1`, path, requestBody);
  const second = await providerPost(context, `${label}.pass-2`, path, requestBody);
  if (!same(projection(first), projection(second)))
    fail(`${label} provider state changed between complete passes`);
  await writePrivateJson(resolve(context.outputDirectory, `${label}.json`), second);
  context.stableReadbacks.push({ kind: "post", label, path, requestBody, token: context.token,
    expected: projection(second), projection });
  return second;
}

export function combineProviderPages(envelopes, label, identity) {
  if (!Array.isArray(envelopes) || envelopes.length === 0 ||
      envelopes.length > maximumProviderPages)
    fail(`${label} provider pagination is unbounded`);
  const rows = [];
  const identities = new Set();
  let totalPages;
  let totalCount;
  let perPage;
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
    if (info.per_page !== undefined) {
      if (!Number.isSafeInteger(info.per_page) || info.per_page < 1 ||
          (perPage !== undefined && info.per_page !== perPage))
        fail(`${label} provider pagination changed during readback`);
      perPage ??= info.per_page;
    }
    if (info.count !== undefined &&
        (!Number.isSafeInteger(info.count) || info.count !== pageRows.length))
      fail(`${label} provider pagination metadata is malformed`);
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

export function normalizeBuildsListPage(envelope, label, page) {
  const rows = requireEnvelope(envelope, label);
  if (envelope.result_info !== undefined) {
    const info = envelope.result_info;
    if (info?.total_pages !== 0) return envelope;
    const zeroPageKeys = ["count", "next_page", "page", "per_page", "total_count",
      "total_pages"];
    if (page !== 1 || rows.length !== 0 || !info ||
        !same(sorted(Object.keys(info)), zeroPageKeys) || info.page !== 1 ||
        !Number.isSafeInteger(info.per_page) || info.per_page < 1 || info.count !== 0 ||
        info.total_count !== 0 || info.next_page !== false)
      fail(`${label} provider Builds pagination metadata is malformed`);
    return { ...envelope,
      result_info: { page: 1, total_pages: 1, total_count: 0 } };
  }
  if (page !== 1 || rows.length !== 0)
    fail(`${label} provider Builds pagination metadata is malformed`);
  return { ...envelope, result_info: { page: 1, total_pages: 1, total_count: 0 } };
}

export function normalizeTriggerListPage(envelope, label, page,
  maximumTriggersPerWorker) {
  const rows = requireEnvelope(envelope, label);
  if (maximumTriggersPerWorker !== 2)
    fail(`${label} provider trigger pagination metadata is malformed`);
  if (envelope.result_info !== undefined) {
    const normalized = normalizeBuildsListPage(envelope, label, page);
    if (Number.isSafeInteger(normalized.result_info?.total_count) &&
        normalized.result_info.total_count > maximumTriggersPerWorker)
      fail(`${label} provider trigger pagination metadata is malformed`);
    return normalized;
  }
  const envelopeKeys = ["errors", "messages", "result", "success"];
  if (page !== 1 ||
      !same(sorted(Object.keys(envelope)), envelopeKeys) ||
      !Array.isArray(envelope.errors) || !Array.isArray(envelope.messages) ||
      !Array.isArray(rows) || rows.length > maximumTriggersPerWorker)
    fail(`${label} provider trigger pagination metadata is malformed`);
  return { ...envelope, result_info: {
    page: 1, total_pages: 1, total_count: rows.length,
  } };
}

export function normalizeDomainListPage(envelope, label, page) {
  const rows = requireEnvelope(envelope, label);
  const info = envelope.result_info;
  const keysWithoutTotalPages = ["count", "page", "per_page", "total_count"];
  const keysWithTotalPages = [...keysWithoutTotalPages, "total_pages"];
  if (!Array.isArray(rows) || !info ||
      (!same(sorted(Object.keys(info)), keysWithoutTotalPages) &&
       !same(sorted(Object.keys(info)), keysWithTotalPages)) ||
      !Number.isSafeInteger(info.page) || !Number.isSafeInteger(info.count) ||
      !Number.isSafeInteger(info.per_page) || !Number.isSafeInteger(info.total_count) ||
      info.page !== page || info.page < 1 || info.count < 0 || info.per_page < 1 ||
      info.total_count < 0 || info.count !== rows.length)
    fail(`${label} provider domain pagination metadata is malformed`);
  const derivedTotalPages = Math.max(1, Math.ceil(info.total_count / info.per_page));
  const expectedCount = info.page < derivedTotalPages
    ? info.per_page
    : info.total_count - (info.per_page * (derivedTotalPages - 1));
  if (info.page > derivedTotalPages || info.count > info.per_page ||
      info.count !== expectedCount ||
      (info.total_pages !== undefined &&
       (!Number.isSafeInteger(info.total_pages) || info.total_pages !== derivedTotalPages)))
    fail(`${label} provider domain pagination metadata is malformed`);
  return { ...envelope, result_info: { ...info, total_pages: derivedTotalPages } };
}

function normalizeWorkerVersionPage(envelope, label) {
  const result = requireEnvelope(envelope, label);
  const info = envelope.result_info ?? {};
  if (!result || !Array.isArray(result.items) || !Number.isSafeInteger(info.page) ||
      !Number.isSafeInteger(info.count) || !Number.isSafeInteger(info.per_page) ||
      !Number.isSafeInteger(info.total_count) || info.page < 1 || info.count < 0 ||
      info.per_page < 1 || info.total_count < 0 || info.count !== result.items.length)
    fail(`${label} provider version pagination metadata is malformed`);
  const derivedTotalPages = Math.max(1, Math.ceil(info.total_count / info.per_page));
  const expectedCount = info.page < derivedTotalPages
    ? info.per_page
    : info.total_count - (info.per_page * (derivedTotalPages - 1));
  if (info.page > derivedTotalPages ||
      info.count > info.per_page || info.count !== expectedCount ||
      (info.total_pages !== undefined &&
       (!Number.isSafeInteger(info.total_pages) || info.total_pages !== derivedTotalPages)))
    fail(`${label} provider version pagination metadata is malformed`);
  return { ...envelope, result_info: { ...info, total_pages: derivedTotalPages } };
}

export function combineWorkerVersionPages(envelopes, label = "Worker versions") {
  if (!Array.isArray(envelopes)) fail(`${label} provider pagination is unbounded`);
  let perPage;
  return combineProviderPages(envelopes.map((rawEnvelope, index) => {
    const envelope = normalizeWorkerVersionPage(rawEnvelope, `${label} page ${index + 1}`);
    const result = requireEnvelope(envelope, `${label} page ${index + 1}`);
    perPage ??= envelope.result_info.per_page;
    if (envelope.result_info.per_page !== perPage)
      fail(`${label} provider version pagination metadata changed during readback`);
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

async function providerGetPaginatedPass(context, label, path, identity, perPage,
  normalizePage = (envelope) => envelope) {
  const pages = [];
  for (let page = 1; page <= maximumProviderPages; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const pageLabel = `${label}.page-${page}`;
    const envelope = normalizePage(await providerGet(context, pageLabel,
      `${path}${separator}page=${page}&per_page=${perPage}`), pageLabel, page);
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

async function providerGetPaginated(context, label, path, identity, perPage = 50,
  normalizePage = (envelope) => envelope) {
  const first = await providerGetPaginatedPass(context, `${label}.pass-1`, path, identity,
    perPage, normalizePage);
  const second = await providerGetPaginatedPass(context, `${label}.pass-2`, path, identity,
    perPage, normalizePage);
  validateStableProviderPasses(first, second, label);
  await writePrivateJson(resolve(context.outputDirectory, `${label}.json`), second);
  context.stableReadbacks.push({ kind: "paginated", label, path, identity, perPage,
    normalizePage, expected: second.result });
  return second;
}

async function providerGetBuildsList(context, label, path, identity, perPage = 50) {
  return providerGetPaginated(context, label, path, identity, perPage,
    normalizeBuildsListPage);
}

async function providerGetTriggerList(context, label, path, identity,
  maximumTriggersPerWorker, perPage = 50) {
  if (!/^\/builds\/workers\/[^/?]+\/triggers$/u.test(path))
    fail(`${label} is not a per-Worker trigger inventory`);
  return providerGetPaginated(context, label, path, identity, perPage,
    (envelope, pageLabel, page) => normalizeTriggerListPage(
      envelope, pageLabel, page, maximumTriggersPerWorker));
}

async function providerGetWorkerVersionsPass(context, label, path, perPage) {
  const pages = [];
  for (let page = 1; page <= maximumProviderPages; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const envelope = normalizeWorkerVersionPage(await providerGet(context,
      `${label}.page-${page}`, `${path}${separator}page=${page}&per_page=${perPage}`),
    `${label} page ${page}`);
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
  context.stableReadbacks.push({ kind: "versions", label, path, perPage,
    expected: second.result });
  return second;
}

async function verifyCompleteProviderSweep(context) {
  const readbacks = [...context.stableReadbacks];
  for (const item of readbacks) {
    let actual;
    if (item.kind === "get")
      actual = (await providerGet(context, `${item.label}.sweep-final`, item.path)).result;
    else if (item.kind === "post")
      actual = item.projection(await providerPost({ ...context, token: item.token },
        `${item.label}.sweep-final`,
        item.path, item.requestBody));
    else if (item.kind === "paginated")
      actual = (await providerGetPaginatedPass(context, `${item.label}.sweep-final`,
        item.path, item.identity, item.perPage, item.normalizePage)).result;
    else if (item.kind === "versions")
      actual = (await providerGetWorkerVersionsPass(context, `${item.label}.sweep-final`,
        item.path, item.perPage)).result;
    else fail("provider sweep readback kind is malformed");
    if (!same(item.expected, actual))
      fail(`${item.label} changed between complete provider sweeps`);
  }
}

export async function readProviderSnapshot({ accountId, token, productionReadToken,
  outputDirectory, production, review, sourceSha, fetchImpl = fetch }) {
  const startedAt = new Date().toISOString();
  await createPrivateDirectory(outputDirectory);
  const context = { accountId, token, outputDirectory, stableReadbacks: [], fetchImpl };
  const scriptsFirst = await providerGet(context, "scripts.pass-1", "/workers/scripts");
  const scripts = await providerGet(context, "scripts.pass-2", "/workers/scripts");
  if (!same(scriptsFirst.result, scripts.result))
    fail("account Worker inventory changed between complete passes");
  await writePrivateJson(resolve(outputDirectory, "scripts.json"), scripts);
  context.stableReadbacks.push({ kind: "get", label: "scripts", path: "/workers/scripts",
    expected: scripts.result });
  const scriptRows = requireEnvelope(scripts, "scripts");
  if (!Array.isArray(scriptRows) || scriptRows.length > 1000)
    fail("account Worker inventory is invalid or unbounded");
  const reviewPersistentWorkerCount = validateRetiredReviewWorkerAbsent(
    scriptRows, review, "provider Worker inventory");
  const names = [...new Set(production.workers.map(({ name }) => name))];
  let productionDatabaseId;
  for (const name of names) {
    const script = (scripts.result ?? []).find(({ id }) => id === name);
    if (!script) {
      fail(`required production Worker ${name} is absent`);
    }
    if (!scriptTagPattern.test(script.tag ?? "")) fail(`${name} script tag is malformed`);
    const settings = await providerGetStable(context, `${name}.settings`,
      `/workers/scripts/${encodeURIComponent(name)}/settings`);
    if (name === production.workers[0].name) {
      const database = (settings.result?.bindings ?? []).filter(({ name: binding, type }) =>
        binding === "DB" && type === "d1");
      if (database.length !== 1 || !uuidPattern.test(database[0].id ?? database[0].database_id ?? ""))
        fail("production D1 binding is missing or ambiguous");
      productionDatabaseId = database[0].id ?? database[0].database_id;
    }
    await providerGetStable(context, `${name}.subdomain`,
      `/workers/scripts/${encodeURIComponent(name)}/subdomain`);
    await providerGetStable(context, `${name}.schedules`,
      `/workers/scripts/${encodeURIComponent(name)}/schedules`);
    await providerGetStable(context, `${name}.routes`,
      `/workers/services/${encodeURIComponent(name)}/environments/production/routes?show_zonename=true`);
    await providerGetStable(context, `${name}.script-settings`,
      `/workers/scripts/${encodeURIComponent(name)}/script-settings`);
    const deployments = await providerGetStable(context, `${name}.deployments`,
      `/workers/scripts/${encodeURIComponent(name)}/deployments`);
    const deploymentRows = deployments.result?.deployments;
    const activeVersions = deploymentRows?.[0]?.versions ?? [];
    if (!Array.isArray(deploymentRows) || deploymentRows.length === 0 ||
        activeVersions.length !== 1 || activeVersions[0].percentage !== 100 ||
        !uuidPattern.test(activeVersions[0].version_id ?? ""))
      fail(`${name} does not have one unambiguous active version`);
    await providerGetStable(context, `${name}.active-version`,
      `/workers/scripts/${encodeURIComponent(name)}/versions/${encodeURIComponent(activeVersions[0].version_id)}`);
    const deploymentsFinal = await providerGetStable(context, `${name}.deployments-final`,
      `/workers/scripts/${encodeURIComponent(name)}/deployments`);
    if (!same(deployments.result, deploymentsFinal.result))
      fail(`${name} active deployment changed during version readback`);
    await providerGetWorkerVersions(context, `${name}.versions`,
      `/workers/scripts/${encodeURIComponent(name)}/versions`);
    await providerGetBuildsList(context, `${name}.deploy-hooks`,
      `/builds/workers/${encodeURIComponent(name)}/deploy_hooks`,
      ({ deploy_hook_uuid: id }) => id);
    const triggers = await providerGetTriggerList(context, `${name}.triggers`,
      `/builds/workers/${encodeURIComponent(script.tag)}/triggers`,
      ({ trigger_uuid: id }) => id,
      review.automaticReview.providerTopology.maximumTriggersPerWorker);
    await providerGetBuildsList(context, `${name}.builds`,
      `/builds/workers/${encodeURIComponent(script.tag)}/builds`,
      ({ build_uuid: id }) => id, 200);
    for (const trigger of triggers.result ?? []) {
      if (!uuidPattern.test(trigger.trigger_uuid ?? "")) fail(`${name} trigger UUID is malformed`);
      await providerGetStable(context,
        `${name}.trigger-${trigger.trigger_uuid}.environment`,
        `/builds/triggers/${encodeURIComponent(trigger.trigger_uuid)}/environment_variables`);
    }
  }
  const collectAccountTriggers = async (pass) => {
    const rows = [];
    for (const [index, script] of scriptRows.entries()) {
      if (!scriptTagPattern.test(script.tag ?? "")) fail("account Worker tag is malformed");
      const triggerInventory = await providerGetTriggerList(context,
        `account-trigger-pass-${pass}-script-${index}`,
        `/builds/workers/${encodeURIComponent(script.tag)}/triggers`,
        ({ trigger_uuid: id }) => id,
        review.automaticReview.providerTopology.maximumTriggersPerWorker);
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
    ({ hostname, service }) => `${hostname}\0${service}`, 50, normalizeDomainListPage);
  await providerGetBuildsList(context, "build-tokens", "/builds/tokens",
    ({ build_token_uuid: id }) => id);
  await providerGetStable(context, "build-limits", "/builds/account/limits");
  if (!productionDatabaseId) fail("production D1 database identity is unavailable");
  await providerPostStable({ ...context, token: productionReadToken },
    "production-migrations", `/d1/database/${encodeURIComponent(productionDatabaseId)}/query`,
    { sql: "SELECT id, name FROM d1_migrations ORDER BY id", params: [] },
    ({ result }) => result?.map(({ results }) => results));
  await verifyCompleteProviderSweep(context);
  await writePrivateJson(resolve(outputDirectory, "snapshot-manifest.json"), {
    accountId, sourceSha, startedAt, completedAt: new Date().toISOString(),
    productionContractSha256: digestJson(production), reviewContractSha256: digestJson(review),
  });
  return { outcome: "workers-builds-private-readback-complete", mutation: false,
    productionWorkers: production.workers.length,
    reviewPersistentWorkerCount };
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
  const projects = production.workers.map(({ role, name }) => [role, name]);
  const bootstrap = validateInitialBootstrapSnapshot({
    production,
    review,
    scripts: await loadSnapshot(snapshotDirectory, "scripts.json"),
    triggers: await Promise.all(projects.map(async ([role, name]) =>
      [role, await loadSnapshot(snapshotDirectory, `${name}.triggers.json`)])),
    deployHooks: await Promise.all(projects.map(async ([role, name]) =>
      [role, await loadSnapshot(snapshotDirectory, `${name}.deploy-hooks.json`)])),
    builds: await Promise.all(projects.map(async ([role, name]) =>
      [role, await loadSnapshot(snapshotDirectory, `${name}.builds.json`)])),
    buildTokens: await loadSnapshot(snapshotDirectory, "build-tokens.json"),
    accountTriggers: await loadSnapshot(snapshotDirectory, "account-triggers.json"),
  });
  const configurations = materializeProductionConfigurations({
    contract: production, bases, snapshots, accountId, initialBootstrapPredecessor: true,
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
    liveConfigurations: production.workers.map((worker, index) =>
      initialBootstrapPredecessorConfiguration(production, configurations[index], worker)),
    deployments, activeVersions, migrationEnvelope, migrationNames });
  await createPrivateDirectory(outputDirectory);
  const results = [];
  for (const [index, worker] of production.workers.entries()) {
    const bytes = Buffer.byteLength(JSON.stringify(configurations[index]));
    await writePrivateJson(resolve(outputDirectory, `${worker.role}.json`), configurations[index]);
    results.push({ role: worker.role, bytes });
  }
  return { outcome: "production-protected-documents-materialized", mutation: false, results,
    bootstrap, runtime };
}

async function validateConfiguredSnapshotDirectory({ snapshotDirectory, production, review,
  accountId, tokenAuthorityProofs, sourceSha }) {
  validateSnapshotManifest(await loadSnapshot(snapshotDirectory, "snapshot-manifest.json"),
    { accountId, sourceSha, production, review });
  const [core, publisher, rendezvous] = production.workers;
  const reviewProject = review.automaticReview.project;
  const scripts = await loadSnapshot(snapshotDirectory, "scripts.json");
  const buildTokens = await loadSnapshot(snapshotDirectory, "build-tokens.json");
  const productionTriggers = await loadSnapshot(snapshotDirectory, `${core.name}.triggers.json`);
  const reviewTriggers = productionTriggers;
  const rows = requireEnvelope(productionTriggers, "shared core triggers");
  if (!Array.isArray(rows) || rows.length !== 2)
    fail("configured core trigger inventory is not exactly two");
  for (const trigger of rows)
    if (!uuidPattern.test(trigger.trigger_uuid ?? "")) fail("configured trigger UUID is malformed");
  const productionRows = rows.filter(({ trigger_name: name }) =>
    name === "Atrinik automatic production main");
  const reviewRows = rows.filter(({ trigger_name: name }) => name === "Atrinik build-only review");
  if (productionRows.length !== 1 || reviewRows.length !== 1)
    fail("configured production/preview trigger roles are missing or ambiguous");
  const productionEnvironment = await loadSnapshot(snapshotDirectory,
    `${core.name}.trigger-${productionRows[0].trigger_uuid}.environment.json`);
  const reviewEnvironment = await loadSnapshot(snapshotDirectory,
    `${reviewProject}.trigger-${reviewRows[0].trigger_uuid}.environment.json`);
  const nonEntrypointTriggers = await Promise.all([publisher, rendezvous].map(async (worker) => [
    worker.role,
    await loadSnapshot(snapshotDirectory, `${worker.name}.triggers.json`),
  ]));
  const deployHooks = await Promise.all(production.workers.map(({ role, name }) =>
    [role, name]).map(async ([label, name]) => [
    label,
    await loadSnapshot(snapshotDirectory, `${name}.deploy-hooks.json`),
  ]));
  const accountTriggers = await loadSnapshot(snapshotDirectory, "account-triggers.json");
  const reviewBuildState = {
    builds: await loadSnapshot(snapshotDirectory, `${reviewProject}.builds.json`),
    buildLimits: await loadSnapshot(snapshotDirectory, "build-limits.json"),
    buildUsageProof: await readPrivateJson(process.env.ATRINIK_WORKERS_BUILDS_USAGE_PROOF_FILE,
      "Workers Builds usage proof"),
  };
  return validateConfiguredBuildsSnapshot({
    production, review, scripts, productionTriggers, productionEnvironment,
    reviewTriggers, reviewEnvironment, nonEntrypointTriggers, deployHooks, buildTokens,
    accountTriggers, reviewBuildState,
    accountId, tokenAuthorityProofs, sourceSha,
  });
}

async function validateStagedSnapshotDirectory({ snapshotDirectory, production, review,
  accountId, tokenAuthorityProofs, sourceSha },
{ reviewActive = false, requireReviewResult = reviewActive,
  authorityRequired = reviewActive && !requireReviewResult,
  includeLiveIdentities = false,
  reviewResultProof = undefined, reviewActivationAuthorityProof = undefined,
  reviewActivationAuthorityEvidence = undefined,
  reviewActivationAuthorityCheckpoint = undefined } = {}) {
  const snapshotManifest = await loadSnapshot(snapshotDirectory, "snapshot-manifest.json");
  validateSnapshotManifest(snapshotManifest, { accountId, sourceSha, production, review });
  const core = production.workers[0];
  const reviewProject = review.automaticReview.project;
  const scripts = await loadSnapshot(snapshotDirectory, "scripts.json");
  const buildTokens = await loadSnapshot(snapshotDirectory, "build-tokens.json");
  const productionTriggers = await loadSnapshot(snapshotDirectory, `${core.name}.triggers.json`);
  const reviewTriggers = productionTriggers;
  const rows = requireExhaustiveEnvelope(productionTriggers, "staged shared core triggers");
  const expectedTriggerCount = reviewActive ? 2 : 1;
  if (rows.length !== expectedTriggerCount)
    fail(`staged core trigger inventory is not exactly ${expectedTriggerCount}`);
  for (const trigger of rows)
    if (!uuidPattern.test(trigger.trigger_uuid ?? "")) fail("staged trigger UUID is malformed");
  const productionRows = rows.filter(({ trigger_name: name }) =>
    name === "Atrinik automatic production main");
  const reviewRows = rows.filter(({ trigger_name: name }) => name === "Atrinik build-only review");
  if (productionRows.length !== 1 || reviewRows.length !== (reviewActive ? 1 : 0))
    fail("staged production/preview trigger phase is missing or ambiguous");
  const productionEnvironment = await loadSnapshot(snapshotDirectory,
    `${core.name}.trigger-${productionRows[0].trigger_uuid}.environment.json`);
  const reviewEnvironment = reviewActive ? await loadSnapshot(snapshotDirectory,
    `${reviewProject}.trigger-${reviewRows[0].trigger_uuid}.environment.json`) : undefined;
  const deployHooks = await Promise.all(production.workers.map(({ role, name }) =>
    [role, name]).map(async ([label, name]) =>
    [label, await loadSnapshot(snapshotDirectory, `${name}.deploy-hooks.json`)]));
  const builds = await Promise.all(production.workers.map(({ role, name }) => [role, name])
    .map(async ([label, name]) =>
      [label, await loadSnapshot(snapshotDirectory, `${name}.builds.json`)]));
  const nonEntrypointTriggers = await Promise.all(production.workers.slice(1)
    .map(async ({ role, name }) =>
      [role, await loadSnapshot(snapshotDirectory, `${name}.triggers.json`)]));
  const reviewBuildState = {
    builds: await loadSnapshot(snapshotDirectory, `${reviewProject}.builds.json`),
    buildLimits: await loadSnapshot(snapshotDirectory, "build-limits.json"),
    buildUsageProof: await readPrivateJson(process.env.ATRINIK_WORKERS_BUILDS_USAGE_PROOF_FILE,
      "Workers Builds usage proof"),
  };
  const productionSentinelProof = reviewActivationAuthorityEvidence?.productionSentinelProof ??
    (await readProductionSentinelProof()).productionSentinelProof;
  const arguments_ = { production, review, scripts, productionTriggers,
    productionEnvironment, reviewTriggers, reviewEnvironment, nonEntrypointTriggers,
    deployHooks, builds, buildTokens,
    accountTriggers: await loadSnapshot(snapshotDirectory, "account-triggers.json"),
    reviewBuildState, accountId, tokenAuthorityProofs, sourceSha,
    productionSentinelProof, snapshotManifest, reviewResultProof,
    reviewActivationAuthorityProof, reviewActivationAuthorityEvidence,
    reviewActivationAuthorityCheckpoint };
  if (!reviewActive) return validateStagedBuildsSnapshot(arguments_);
  if (requireReviewResult) return validateProductionActivationSnapshot(arguments_);
  return authorityRequired ? validateReviewActivationSnapshot(arguments_) :
    validateActivationSnapshot(arguments_, { reviewActive: true, requireReviewResult: false,
      authorityRequired: false, includeLiveIdentities });
}

export async function validateReviewStagedEnvironmentSnapshotDirectory({ snapshotDirectory,
  production, review, accountId, sourceSha, tokenAuthorityProofs,
  reviewActivationAuthorityProof, reviewActivationAuthorityEvidence,
  reviewActivationAuthorityCheckpoint }) {
  const authorityArguments = { production, review, accountId, sourceSha,
    ...reviewActivationAuthorityEvidence };
  const { proofValidationTime } = reviewActivationAuthorityCheckpoint ?
    validateReviewActivationAuthorityCheckpoint(reviewActivationAuthorityProof,
      authorityArguments, reviewActivationAuthorityCheckpoint) :
    validateReviewActivationAuthority(reviewActivationAuthorityProof, authorityArguments);
  if (!same(tokenAuthorityProofs, reviewActivationAuthorityEvidence.tokenAuthorityProofs))
    fail("review staged token authority evidence drift");
  const manifest = await loadSnapshot(snapshotDirectory, "snapshot-manifest.json");
  validateSnapshotManifest(manifest, { accountId, sourceSha, production, review });
  const core = production.workers[0];
  const scripts = requireEnvelope(await loadSnapshot(snapshotDirectory, "scripts.json"),
    "review staged scripts");
  const script = scripts.filter(({ id }) => id === core.name);
  if (script.length !== 1 || !scriptTagPattern.test(script[0].tag ?? ""))
    fail("review staged core script is missing or ambiguous");
  const triggerEnvelope = await loadSnapshot(snapshotDirectory, `${core.name}.triggers.json`);
  const triggerRows = requireExhaustiveEnvelope(triggerEnvelope, "review staged core triggers");
  const productionTriggerUuid = await readPrivateValue(
    process.env.ATRINIK_PRODUCTION_STAGED_TRIGGER_UUID_FILE,
    "journaled production staged trigger UUID", uuidPattern);
  const reviewTriggerUuid = await readPrivateValue(
    process.env.ATRINIK_REVIEW_STAGED_TRIGGER_UUID_FILE,
    "journaled review staged trigger UUID", uuidPattern);
  if (productionTriggerUuid === reviewTriggerUuid)
    fail("journaled staged trigger identities overlap");
  const productionRows = triggerRows.filter(({ trigger_uuid: id }) => id === productionTriggerUuid);
  const reviewRows = triggerRows.filter(({ trigger_name: name, trigger_uuid: id }) =>
    name === "Atrinik build-only review" && id === reviewTriggerUuid);
  if (triggerRows.length !== 2 || productionRows.length !== 1 || reviewRows.length !== 1 ||
      reviewRows[0].trigger_uuid !== reviewTriggerUuid)
    fail("review staged trigger inventory is incomplete or competing");
  const productionActual = productionRows[0];
  const reviewActual = reviewRows[0];
  const tokenEnvelope = await loadSnapshot(snapshotDirectory, "build-tokens.json");
  const tokenRows = requireExhaustiveEnvelope(tokenEnvelope, "review staged build tokens");
  const productionToken = tokenRows.filter(({ build_token_name: name }) =>
    name === "Atrinik metaserver production");
  const reviewToken = tokenRows.filter(({ build_token_name: name }) =>
    name === "Atrinik metaserver review check");
  if (productionToken.length !== 1 || reviewToken.length !== 1)
    fail("review staged token inventory is incomplete or ambiguous");
  validateBuildTokenInventory(tokenEnvelope, [
    { uuid: productionToken[0].build_token_uuid, name: "Atrinik metaserver production" },
    { uuid: reviewToken[0].build_token_uuid, name: "Atrinik metaserver review check" },
  ]);
  validateTokenAuthorityProofs({ production, review, accountId, proofs: tokenAuthorityProofs,
    tokenRows: { production: productionToken[0], review: reviewToken[0] }, sourceSha },
  proofValidationTime);
  const rootDirectory = await readPrivateValue(
    process.env.ATRINIK_REVIEW_STAGING_ROOT_DIRECTORY_FILE,
    "review staging root directory", reviewStagingRootPattern);
  const productionSentinelProof = reviewActivationAuthorityEvidence.productionSentinelProof;
  validateSentinelRefAbsence(productionSentinelProof, proofValidationTime);
  const productionExpected = productionTriggerSpec(production, {
    externalScriptId: script[0].tag,
    repositoryConnectionUuid: productionActual.repo_connection?.repo_connection_uuid,
    buildTokenUuid: reviewToken[0].build_token_uuid,
  });
  productionExpected.branch_includes = [productionSentinelProof.branch];
  validateTriggerSnapshot(productionActual, productionExpected, "review staged production");
  const expected = automaticReviewTriggerSpec(review, {
    externalScriptId: script[0].tag,
    repositoryConnectionUuid: reviewActual.repo_connection?.repo_connection_uuid,
    buildTokenUuid: reviewToken[0].build_token_uuid,
  });
  expected.root_directory = rootDirectory;
  expected.build_command = "exit 1";
  expected.deploy_command = "exit 1";
  if (productionActual.repo_connection?.repo_connection_uuid !==
      reviewActual.repo_connection?.repo_connection_uuid)
    fail("review staged triggers do not share the repository connection");
  const environment = await loadSnapshot(snapshotDirectory,
    `${core.name}.trigger-${reviewActual.trigger_uuid}.environment.json`);
  const result = validateReviewStagedEnvironmentReadback({ trigger: reviewActual, environment },
    expected, review);
  for (const { role, name } of production.workers) {
    validateNoDeployHooks(await loadSnapshot(snapshotDirectory, `${name}.deploy-hooks.json`), role);
    validateNoActiveBuilds(await loadSnapshot(snapshotDirectory, `${name}.builds.json`), role);
  }
  for (const { role, name } of production.workers.slice(1)) {
    const rows = requireExhaustiveEnvelope(await loadSnapshot(snapshotDirectory,
      `${name}.triggers.json`), `${role} review staged triggers`);
    if (rows.length !== 0) fail(`${role} has an independent review staged trigger`);
  }
  const accountRows = requireExhaustiveEnvelope(await loadSnapshot(snapshotDirectory,
    "account-triggers.json"), "review staged account triggers").filter(
    ({ repo_connection: connection }) => connection?.provider_type === "github" &&
      connection.provider_account_id === githubRepository.provider_account_id &&
      connection.repo_id === githubRepository.repo_id);
  if (!same(sorted(accountRows.map(({ trigger_uuid: id }) => id)),
    sorted([productionTriggerUuid, reviewTriggerUuid])))
    fail("review staged account trigger inventory drift");
  const capturedAt = new Date().toISOString();
  return { outcome: result.outcome, mutation: false, accountId, sourceSha, capturedAt,
    proof_digest: digestJson({ manifest, productionTrigger: productionActual,
      reviewTrigger: reviewActual, environment,
      tokenIds: [productionToken[0].build_token_uuid, reviewToken[0].build_token_uuid],
      reviewActivationAuthorityProof }) };
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
  const { productionSentinelProof } = await readProductionSentinelProof();
  const repositoryConnectionProof = await readPrivateJson(
    process.env.ATRINIK_REPOSITORY_CONNECTION_OWNER_PROOF_FILE,
    "shared repository connection owner proof");
  return validateFreshBuildsSnapshot({
    production, review, scripts, triggers, deployHooks, builds, buildTokens,
    accountTriggers,
    productionSentinelProof, repositoryConnectionProof, accountId,
    sourceSha,
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

export function provisioningDryRunSummary(production, review) {
  const setupPlan = provisioningSetupPlan(production, review);
  return {
    outcome: "workers-builds-provisioning-plan-valid", mutation: false,
    production: { project: production.workers[0].name, branch: production.productionBranch,
      triggerCount: 1, protectedInputCount: Object.keys(production.protectedInputs).length },
    automaticReview: { project: review.automaticReview.project, triggerCount: 1,
      protectedInputCount: review.automaticReview.protectedInputs.length },
    setupOperationCount: setupPlan.setupOperations.length,
    rollbackOperationCount: setupPlan.rollbackOperations.length,
    gates: structuredClone(setupPlan.gates),
  };
}

export const credentialedProvisioningModes = Object.freeze([
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
  "--verify-review-staged-environment",
  "--verify-review-staging-root-activation",
  "--verify-review-staging-root-create",
  "--verify-staged",
  "--verify-staged-proof",
]);

export async function credentialedSourceSha(mode, load = reviewedCurrentMainSha) {
  return credentialedProvisioningModes.includes(mode) ? await load() : undefined;
}

export async function runProvisioningCli(mode = process.argv[2] ?? "--validate-only",
  sourceShaLoader = reviewedCurrentMainSha) {
  const { production, review } = await validateCheckedInProvisioning();
  if (mode === "--validate-only") {
    process.stdout.write(`${JSON.stringify({ outcome: "workers-builds-provisioning-valid" })}\n`);
    return;
  }
  if (mode === "--dry-run") {
    process.stdout.write(`${JSON.stringify(provisioningDryRunSummary(production, review))}\n`);
    return;
  }
  if (mode === "--plan-setup") {
    process.stdout.write(`${JSON.stringify(provisioningSetupPlan(production, review))}\n`);
    return;
  }
  const sourceSha = await credentialedSourceSha(mode, sourceShaLoader);
  if (mode === "--readback") {
    const accountId = await readPrivateValue(process.env.ATRINIK_CLOUDFLARE_ACCOUNT_ID_FILE,
      "Cloudflare account ID", accountIdPattern);
    const token = await readPrivateValue(process.env.ATRINIK_WORKERS_BUILDS_API_TOKEN_FILE,
      "Workers Builds API token");
    const productionReadToken = await readPrivateValue(
      process.env.ATRINIK_PRODUCTION_BUILD_TOKEN_SECRET_FILE,
      "production D1 read API token");
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
    const stagedProof = await validateStagedSnapshotDirectory({
      snapshotDirectory: process.env.ATRINIK_PROVIDER_SNAPSHOT_DIRECTORY,
      production, review, accountId, tokenAuthorityProofs, sourceSha,
    });
    await writePrivateProof(process.env.ATRINIK_STAGED_PROOF_OUTPUT_FILE, stagedProof);
    process.stdout.write(`${JSON.stringify(publicStagedProofSummary(stagedProof))}\n`);
    return;
  }
  if (mode === "--verify-review-activation-authority") {
    const accountId = await readPrivateValue(process.env.ATRINIK_CLOUDFLARE_ACCOUNT_ID_FILE,
      "Cloudflare account ID", accountIdPattern);
    const evidence = await readReviewActivationAuthorityEvidence();
    const current = await validateStagedSnapshotDirectory({
      snapshotDirectory: process.env.ATRINIK_PROVIDER_SNAPSHOT_DIRECTORY,
      production, review, accountId, tokenAuthorityProofs: evidence.tokenAuthorityProofs,
      sourceSha,
    });
    validateStagedProof(evidence.stagedProof, current);
    const tokenRows = requireExhaustiveEnvelope(await loadSnapshot(
      process.env.ATRINIK_PROVIDER_SNAPSHOT_DIRECTORY, "build-tokens.json"),
    "review activation authority build tokens");
    const productionToken = tokenRows.find(({ build_token_name: name }) =>
      name === "Atrinik metaserver production");
    const reviewToken = tokenRows.find(({ build_token_name: name }) =>
      name === "Atrinik metaserver review check");
    if (!productionToken || !reviewToken)
      fail("review activation authority token inventory drift");
    const proof = issueReviewActivationAuthority({ production, review, accountId, sourceSha,
      ...evidence, currentStagedProof: current,
      tokenRows: { production: productionToken, review: reviewToken } });
    await writePrivateProof(
      process.env.ATRINIK_REVIEW_ACTIVATION_AUTHORITY_PROOF_OUTPUT_FILE, proof);
    process.stdout.write(`${JSON.stringify({ outcome: proof.outcome, mutation: false,
      sourceSha, expiresAt: proof.expiresAt, proof_digest: proof.proof_digest })}\n`);
    return;
  }
  if (mode === "--verify-disposable-review-authority") {
    const accountId = await readPrivateValue(process.env.ATRINIK_CLOUDFLARE_ACCOUNT_ID_FILE,
      "Cloudflare account ID", accountIdPattern);
    const evidence = await readDisposableReviewAuthorityEvidence(process.env,
      { requireCurrent: false });
    const current = await validateStagedSnapshotDirectory({
      snapshotDirectory: process.env.ATRINIK_PROVIDER_SNAPSHOT_DIRECTORY,
      production, review, accountId, tokenAuthorityProofs: evidence.tokenAuthorityProofs,
      sourceSha,
    }, { reviewActive: true, requireReviewResult: false, authorityRequired: false,
      includeLiveIdentities: true });
    await writePrivateProof(process.env.ATRINIK_CURRENT_REVIEW_ACTIVE_PROOF_OUTPUT_FILE, current);
    const tokenRows = requireExhaustiveEnvelope(await loadSnapshot(
      process.env.ATRINIK_PROVIDER_SNAPSHOT_DIRECTORY, "build-tokens.json"),
    "disposable review authority build tokens");
    const productionToken = tokenRows.find(({ build_token_name: name }) =>
      name === "Atrinik metaserver production");
    const reviewToken = tokenRows.find(({ build_token_name: name }) =>
      name === "Atrinik metaserver review check");
    if (!productionToken || !reviewToken)
      fail("disposable review authority token inventory drift");
    const proof = issueDisposableReviewAuthority({ production, review, accountId, sourceSha,
      ...evidence, currentReviewActiveProof: current,
      tokenRows: { production: productionToken, review: reviewToken } });
    await writePrivateProof(process.env.ATRINIK_DISPOSABLE_REVIEW_AUTHORITY_PROOF_OUTPUT_FILE,
      proof);
    process.stdout.write(`${JSON.stringify({ outcome: proof.outcome, mutation: false,
      sourceSha, expiresAt: proof.expiresAt, proof_digest: proof.proof_digest })}\n`);
    return;
  }
  if (mode === "--verify-disposable-review-authority-proof" ||
      mode === "--verify-disposable-review-authority-push") {
    const accountId = await readPrivateValue(process.env.ATRINIK_CLOUDFLARE_ACCOUNT_ID_FILE,
      "Cloudflare account ID", accountIdPattern);
    const { proof, evidence, validation } = await readAndValidateDisposableReviewAuthority({
      production, review, accountId, sourceSha,
      minimumRemainingMs: mode === "--verify-disposable-review-authority-push" ?
        disposableReviewPushReserveMs : reviewActivationTransitionBudgetMs });
    const operation = mode === "--verify-disposable-review-authority-push" ? "push" : "delete";
    const receipt = { outcome: "workers-builds-disposable-review-write-authorized",
      mutation: false, operation, sourceSha, authorityProofDigest: proof.proof_digest,
      journalId: evidence.disposableCoordinate.journalId,
      branch: evidence.disposableCoordinate.branch, commit: evidence.disposableCoordinate.commit,
      checkedAt: validation.checkedAt, expiresAt: validation.expiresAt };
    await writePrivateProof(operation === "push" ?
      process.env.ATRINIK_DISPOSABLE_REVIEW_PUSH_AUTHORIZATION_RECEIPT_OUTPUT_FILE :
      process.env.ATRINIK_DISPOSABLE_REVIEW_DELETE_AUTHORIZATION_RECEIPT_OUTPUT_FILE, receipt);
    process.stdout.write(`${JSON.stringify({ outcome: validation.outcome, mutation: false,
      sourceSha, expiresAt: validation.expiresAt, proof_digest: proof.proof_digest,
      authorizationReceiptDigest: digestJson(receipt) })}\n`);
    return;
  }
  if (mode === "--verify-review-activation-authority-proof") {
    const accountId = await readPrivateValue(process.env.ATRINIK_CLOUDFLARE_ACCOUNT_ID_FILE,
      "Cloudflare account ID", accountIdPattern);
    const { proof, validation } = await readAndValidateReviewActivationAuthority({
      production, review, accountId, sourceSha,
    });
    process.stdout.write(`${JSON.stringify({ outcome: validation.outcome, mutation: false,
      sourceSha, expiresAt: validation.expiresAt, proof_digest: proof.proof_digest })}\n`);
    return;
  }
  if (mode === "--verify-review-staging-root-create" ||
      mode === "--verify-review-staging-root-activation") {
    const accountId = await readPrivateValue(process.env.ATRINIK_CLOUDFLARE_ACCOUNT_ID_FILE,
      "Cloudflare account ID", accountIdPattern);
    await readAndValidateReviewActivationAuthority({ production, review, accountId, sourceSha });
    const activation = mode === "--verify-review-staging-root-activation";
    const proofVariable = activation ? "ATRINIK_REVIEW_STAGING_ROOT_ACTIVATION_PROOF_FILE" :
      "ATRINIK_REVIEW_STAGING_ROOT_CREATE_PROOF_FILE";
    const proof = await readReviewStagingRootProof(proofVariable,
      activation ? "activation" : "create", process.env, sourceSha);
    if (activation) {
      const create = await readReviewStagingRootProof(
        "ATRINIK_REVIEW_STAGING_ROOT_CREATE_PROOF_FILE", "create", process.env, sourceSha);
      validateReviewStagingRootProofSequence(create, proof);
    }
    process.stdout.write(`${JSON.stringify({ outcome: proof.outcome, mutation: false,
      sourceSha: proof.sourceSha, proof_digest: proof.proof_digest })}\n`);
    return;
  }
  if (mode === "--verify-review-staged-environment") {
    const accountId = await readPrivateValue(process.env.ATRINIK_CLOUDFLARE_ACCOUNT_ID_FILE,
      "Cloudflare account ID", accountIdPattern);
    const token = await readPrivateValue(process.env.ATRINIK_WORKERS_BUILDS_API_TOKEN_FILE,
      "Workers Builds API token");
    const productionReadToken = await readPrivateValue(
      process.env.ATRINIK_PRODUCTION_BUILD_TOKEN_SECRET_FILE,
      "production D1 read API token");
    const authority = await readAndValidateReviewActivationAuthority({ production, review,
      accountId, sourceSha });
    const tokenAuthorityProofs = authority.evidence.tokenAuthorityProofs;
    const outputDirectory = process.env.ATRINIK_PROVIDER_SNAPSHOT_OUTPUT;
    await readProviderSnapshot({ accountId, token, productionReadToken, outputDirectory,
      production, review, sourceSha });
    const proof = await validateReviewStagedEnvironmentSnapshotDirectory({
      snapshotDirectory: outputDirectory, production, review, accountId, sourceSha,
      tokenAuthorityProofs, reviewActivationAuthorityProof: authority.proof,
      reviewActivationAuthorityEvidence: authority.evidence,
      reviewActivationAuthorityCheckpoint: authority.validation,
    });
    await writePrivateProof(process.env.ATRINIK_REVIEW_STAGED_ENVIRONMENT_PROOF_OUTPUT_FILE,
      proof);
    process.stdout.write(`${JSON.stringify({ outcome: proof.outcome, mutation: false,
      sourceSha, proof_digest: proof.proof_digest })}\n`);
    return;
  }
  if (mode === "--verify-staged-proof") {
    const accountId = await readPrivateValue(process.env.ATRINIK_CLOUDFLARE_ACCOUNT_ID_FILE,
      "Cloudflare account ID", accountIdPattern);
    const token = await readPrivateValue(process.env.ATRINIK_WORKERS_BUILDS_API_TOKEN_FILE,
      "Workers Builds API token");
    const productionReadToken = await readPrivateValue(
      process.env.ATRINIK_PRODUCTION_BUILD_TOKEN_SECRET_FILE,
      "production D1 read API token");
    const tokenAuthorityProofs = [
      await readPrivateJson(process.env.ATRINIK_PRODUCTION_BUILD_TOKEN_PERMISSION_PROOF_FILE,
        "production build token permission proof"),
      await readPrivateJson(process.env.ATRINIK_REVIEW_BUILD_TOKEN_PERMISSION_PROOF_FILE,
        "review build token permission proof"),
    ];
    const activationSnapshotDirectory = process.env.ATRINIK_PROVIDER_SNAPSHOT_OUTPUT;
    await readProviderSnapshot({ accountId, token, productionReadToken,
      outputDirectory: activationSnapshotDirectory, production, review, sourceSha });
    const current = await validateStagedSnapshotDirectory({
      snapshotDirectory: activationSnapshotDirectory,
      production, review, accountId, tokenAuthorityProofs, sourceSha,
    });
    const proof = await readPrivateJson(process.env.ATRINIK_STAGED_PROOF_FILE,
      "staged activation proof");
    process.stdout.write(`${JSON.stringify(validateStagedProof(proof, current))}\n`);
    return;
  }
  if (mode === "--verify-review-activation" || mode === "--verify-production-activation") {
    const accountId = await readPrivateValue(process.env.ATRINIK_CLOUDFLARE_ACCOUNT_ID_FILE,
      "Cloudflare account ID", accountIdPattern);
    const token = await readPrivateValue(process.env.ATRINIK_WORKERS_BUILDS_API_TOKEN_FILE,
      "Workers Builds API token");
    const productionReadToken = await readPrivateValue(
      process.env.ATRINIK_PRODUCTION_BUILD_TOKEN_SECRET_FILE,
      "production D1 read API token");
    const tokenAuthorityProofs = [
      await readPrivateJson(process.env.ATRINIK_PRODUCTION_BUILD_TOKEN_PERMISSION_PROOF_FILE,
        "production build token permission proof"),
      await readPrivateJson(process.env.ATRINIK_REVIEW_BUILD_TOKEN_PERMISSION_PROOF_FILE,
        "review build token permission proof"),
    ];
    const requireReviewResult = mode === "--verify-production-activation";
    const authority = requireReviewResult ? null :
      await readAndValidateReviewActivationAuthority({ production, review, accountId, sourceSha });
    const outputDirectory = process.env.ATRINIK_PROVIDER_SNAPSHOT_OUTPUT;
    await readProviderSnapshot({ accountId, token, productionReadToken, outputDirectory,
      production, review, sourceSha });
    const reviewResultProof = requireReviewResult ? await readPrivateJson(
      process.env.ATRINIK_REVIEW_RESULT_PROOF_FILE, "disposable review result proof") : undefined;
    const proof = await validateStagedSnapshotDirectory({ snapshotDirectory: outputDirectory,
      production, review, accountId, tokenAuthorityProofs, sourceSha,
    }, { reviewActive: true, requireReviewResult, reviewResultProof,
      reviewActivationAuthorityProof: authority?.proof,
      reviewActivationAuthorityEvidence: authority?.evidence,
      reviewActivationAuthorityCheckpoint: authority?.validation });
    await writePrivateProof(requireReviewResult ?
      process.env.ATRINIK_PRODUCTION_ACTIVATION_PROOF_OUTPUT_FILE :
      process.env.ATRINIK_REVIEW_ACTIVATION_PROOF_OUTPUT_FILE, proof);
    process.stdout.write(`${JSON.stringify(publicStagedProofSummary(proof))}\n`);
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
    process.stdout.write(`${JSON.stringify(await validateConfiguredSnapshotDirectory({
      snapshotDirectory: process.env.ATRINIK_PROVIDER_SNAPSHOT_DIRECTORY,
      production, review, accountId, tokenAuthorityProofs, sourceSha,
    }))}\n`);
    return;
  }
  fail("unknown Workers Builds provisioning mode");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  runProvisioningCli().catch((error) => {
    const reason = error instanceof WorkersBuildsProvisioningError
      ? error.message : "unexpected-internal-error";
    process.stderr.write(`${JSON.stringify({ outcome: "workers-builds-provisioning-stopped", reason })}\n`);
    process.exitCode = 1;
  });
