// Copyright (C) 2026 Atrinik contributors
// The trusted main controller consumes GitHub's dispatch event; no local approval file
// or caller-selected module can grant production authority.
import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = "atrinik/metaserver-worker";
const workflow = ".github/workflows/promote-production.yml";
const shaPattern = /^[0-9a-f]{40}$/u;
const digestPattern = /^[0-9a-f]{64}$/u;
const fields = {
  tag: "ATRINIK_PROMOTION_TAG",
  source_sha: "ATRINIK_PROMOTION_SHA",
  artifact_digest: "ATRINIK_PROMOTION_ARTIFACT_DIGEST",
  configuration_digest: "ATRINIK_PROMOTION_CONFIG_DIGEST",
  migration_digest: "ATRINIK_PROMOTION_MIGRATION_DIGEST",
  expected_predecessor: "ATRINIK_PROMOTION_PREDECESSOR",
};
// Only this module can brand a diagnostic. Formatting never examines thrown values.
const sourceFailures = new WeakMap();
const sourceStages = new Set(["event", "dispatch", "evidence-read", "tag-resolution", "inventory", "source-provenance", "output"]);
const sourceCategories = new Set(["missing-credential", "transport", "http-rejected", "body-unavailable", "body-read",
  "body-too-large", "json-invalid", "predicate", "unknown"]);
const sourceEndpoints = new Set(["repository", "main", "run", "release", "tag", "source-ancestry", "controller-ancestry",
  "source-checks", "environment", "jobs", "approvals", "operator-permission", "tag-object"]);
const sourcePredicates = new Set(["input-fields", "input-coordinates", "dispatch-context", "dispatch-inputs",
  "dispatch-identity", "release-provenance", "source-check", "operator-identity", "annotated-tag", "tag-commit",
  "source-inventory", "jobs-inventory", "output-path"]);
const fail = (message, stage, category = "predicate", endpoint, predicate, status) => {
  const error = new Error(`production promotion: ${message}`);
  if (sourceStages.has(stage) && sourceCategories.has(category)) {
    const diagnostic = { stage, category };
    if (sourceEndpoints.has(endpoint)) diagnostic.endpoint = endpoint;
    if (sourcePredicates.has(predicate)) diagnostic.predicate = predicate;
    if (Number.isInteger(status) && status >= 100 && status <= 599) diagnostic.httpStatus = status;
    sourceFailures.set(error, Object.freeze(diagnostic));
  }
  throw error;
};
export const promotionDigest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function validatePromotionInputs(inputs) {
  if (!inputs || Object.keys(inputs).sort().join() !== Object.keys(fields).sort().join())
    fail("dispatch must name exactly the approved tag, SHA and four digests", "dispatch", "predicate", undefined, "input-fields");
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u.test(inputs.tag ?? "") ||
      !shaPattern.test(inputs.source_sha ?? "") ||
      Object.keys(fields).filter((key) => !["tag", "source_sha"].includes(key))
        .some((key) => !digestPattern.test(inputs[key] ?? "")))
    fail("invalid immutable release coordinates", "dispatch", "predicate", undefined, "input-coordinates");
  return inputs;
}

export function validatePromotionDispatch(environment, event) {
  const inputs = validatePromotionInputs(event?.inputs);
  if (environment.GITHUB_ACTIONS !== "true" || environment.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
      environment.GITHUB_REPOSITORY !== repository || environment.GITHUB_REF !== "refs/heads/main" ||
      environment.GITHUB_RUN_ATTEMPT !== "1" || !/^[1-9][0-9]*$/u.test(environment.GITHUB_RUN_ID ?? "") ||
      !shaPattern.test(environment.GITHUB_SHA ?? "") ||
      environment.GITHUB_WORKFLOW_SHA !== environment.GITHUB_SHA ||
      environment.GITHUB_WORKFLOW_REF !== `${repository}/${workflow}@refs/heads/main` ||
      event.repository?.full_name !== repository || event.ref !== "refs/heads/main" ||
      !Number.isSafeInteger(event.sender?.id) || event.sender.id < 1)
    fail("requires a first-attempt protected main dispatch", "dispatch", "predicate", undefined, "dispatch-context");
  for (const [key, name] of Object.entries(fields))
    if (environment[name] !== inputs[key]) fail("dispatch input differs from execution input", "dispatch", "predicate", undefined, "dispatch-inputs");
  return inputs;
}

export function validatePromotionContext(environment, event, checkoutHead, dirty) {
  const inputs = validatePromotionDispatch(environment, event);
  if (checkoutHead !== inputs.source_sha || dirty !== false || !environment.ATRINIK_DELIVERY_SOURCE_ROOT)
    fail("requires a clean selected source checkout");
  return inputs;
}

function ancestor(comparison, sha) {
  return ["ahead", "identical"].includes(comparison?.status) && comparison?.merge_base_commit?.sha === sha;
}

export function validatePromotionSourceEvidence({ environment, event, inputs, evidence, now = Date.now() }) {
  const { repo, branch, run, release, tagSha, sourceComparison, controllerComparison, checks, actorPermission } = evidence;
  const created = Date.parse(run?.created_at);
  if (repo?.full_name !== repository || repo.default_branch !== "main" || repo.fork !== false ||
      branch?.name !== "main" || branch.protected !== true ||
      String(run?.id) !== environment.GITHUB_RUN_ID || run.run_attempt !== 1 ||
      run.event !== "workflow_dispatch" || run.head_branch !== "main" ||
      run.head_sha !== environment.GITHUB_SHA || run.path !== workflow ||
      run.repository?.full_name !== repository || run.head_repository?.full_name !== repository ||
      run.status !== "in_progress" || run.conclusion !== null ||
      run.actor?.id !== event.sender.id || run.triggering_actor?.id !== event.sender.id ||
      actorPermission?.user?.id !== event.sender.id ||
      !["admin", "write", "maintain"].includes(actorPermission.permission) ||
      !Number.isFinite(created) || created > now || now - created > 60 * 60 * 1000)
    fail("dispatch identity, first attempt or one-hour freshness fence failed", "source-provenance", "predicate", undefined, "dispatch-identity");
  if (tagSha !== inputs.source_sha || release?.tag_name !== inputs.tag ||
      release.immutable !== true || release.draft !== false || release.prerelease !== false ||
      !Number.isSafeInteger(release.id) || !Number.isFinite(Date.parse(release.published_at)) ||
      Date.parse(release.published_at) > created ||
      !ancestor(sourceComparison, inputs.source_sha) ||
      !ancestor(controllerComparison, environment.GITHUB_SHA))
    fail("selected tag lost immutable release or protected source provenance", "source-provenance", "predicate", undefined, "release-provenance");
  if (!Array.isArray(checks) || !checks.some((check) =>
    check.path === ".github/workflows/check.yml" && check.event === "push" &&
    check.head_branch === "main" && check.head_sha === inputs.source_sha &&
    check.repository?.full_name === repository && check.head_repository?.full_name === repository &&
    check.status === "completed" && check.conclusion === "success" &&
    Number.isFinite(Date.parse(check.updated_at)) && Date.parse(check.updated_at) <= created))
    fail("selected source lacks successful protected-main Check before dispatch", "source-provenance", "predicate", undefined, "source-check");
}

export function validatePromotionEvidence(context) {
  validatePromotionSourceEvidence(context);
  const { environment, event, evidence: { protection, jobs, approvals, run } } = context;
  if (protection?.name !== "production" || !Number.isSafeInteger(protection.id) ||
      protection.deployment_branch_policy?.protected_branches !== true ||
      protection.deployment_branch_policy?.custom_branch_policies !== false ||
      !Array.isArray(protection.protection_rules) ||
      protection.protection_rules.some((rule) => !rule || typeof rule !== "object" ||
        Array.isArray(rule) || !["required_reviewers", "wait_timer", "branch_policy"].includes(rule.type)) ||
      new Set(protection.protection_rules.map((rule) => rule.type)).size !== protection.protection_rules.length)
    fail("production environment must restrict deployment to protected branches");
  // The authenticated manual dispatch is the operator's approval. Honor any
  // existing environment review policy without imposing a second human operator.
  const reviewers = protection.protection_rules.find((rule) => rule.type === "required_reviewers");
  if (reviewers) {
    if (typeof reviewers.prevent_self_review !== "boolean" ||
        !Array.isArray(reviewers.reviewers) || reviewers.reviewers.length < 1 ||
        reviewers.reviewers.some((entry) => !["User", "Team"].includes(entry?.type) ||
          !Number.isSafeInteger(entry.reviewer?.id) || entry.reviewer.id < 1))
      fail("production reviewer policy is incomplete");
    const reviews = Array.isArray(approvals) ? approvals.filter((approval) =>
      approval.environments?.some((entry) => entry.id === protection.id && entry.name === "production")) : [];
    if (reviews.length !== 1 || reviews[0].state !== "approved" ||
        !Number.isSafeInteger(reviews[0].user?.id) ||
        (reviewers.prevent_self_review === true && reviews[0].user.id === event.sender.id))
      fail("this dispatch lacks its configured production environment approval");
  }
  if (!Array.isArray(jobs) || jobs.filter((job) => job.name === "validate").length !== 1 ||
      !jobs.some((job) => job.name === "validate" && job.run_id === run.id &&
        job.run_attempt === 1 && job.head_sha === environment.GITHUB_SHA &&
        job.status === "completed" && job.conclusion === "success"))
    fail("this first-attempt dispatch lacks successful isolated source validation");
}

export function validatePromotionPlan(inputs, plan) {
  if (plan?.deploy !== inputs.artifact_digest || plan.configDigest !== inputs.configuration_digest ||
      plan.migrationDigest !== inputs.migration_digest)
    fail("selected artifacts, protected configuration or migrations differ from approval");
}

export function validatePromotionPredecessor(inputs, versions) {
  if (!Array.isArray(versions) || versions.length !== 3 ||
      versions.some((value) => typeof value !== "string" || !value) ||
      promotionDigest(versions) !== inputs.expected_predecessor)
    fail("production predecessor changed while promotion was queued");
}

// API results are deliberately bounded, never logged, and never used as authority
// after a cached fence. Each call refreshes dispatch, tag, validation and writer state.
async function requestJson(url, token, fetcher, endpoint) {
  const stop = (category, status) => fail("authority read failed", "evidence-read", category, endpoint, undefined, status);
  if (typeof token !== "string" || !token) stop("missing-credential");
  let response;
  try {
    response = await fetcher(url, {
      method: "GET", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10" },
    });
  } catch { stop("transport"); }
  if (!response.ok) stop("http-rejected", response.status);
  let reader;
  try { reader = response.body?.getReader(); }
  catch { stop("body-unavailable"); }
  if (!reader) stop("body-unavailable");
  let size = 0;
  const chunks = [];
  while (true) {
    let chunk;
    try { chunk = await reader.read(); }
    catch { stop("body-read"); }
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > 2_000_000) {
      try { await reader.cancel(); } catch { /* The size bound already denied this response. */ }
      stop("body-too-large");
    }
    chunks.push(Buffer.from(chunk.value));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { stop("json-invalid"); }
}

export async function readPromotionEvidence(environment, inputs, fetcher = fetch) {
  const github = (endpoint, path) => requestJson(`https://api.github.com/repos/${repository}${path}`,
    environment.GITHUB_TOKEN, fetcher, endpoint);
  const [repo, branch, run, release, tag, sourceComparison, controllerComparison, checkPage, protection, jobPage, approvals] =
    await Promise.all([
      github("repository", ""), github("main", "/branches/main"), github("run", `/actions/runs/${environment.GITHUB_RUN_ID}`),
      github("release", `/releases/tags/${encodeURIComponent(inputs.tag)}`),
      github("tag", `/git/ref/tags/${encodeURIComponent(inputs.tag)}`),
      github("source-ancestry", `/compare/${inputs.source_sha}...main`),
      github("controller-ancestry", `/compare/${environment.GITHUB_SHA}...main`),
      github("source-checks", `/actions/workflows/check.yml/runs?head_sha=${inputs.source_sha}&event=push&branch=main&status=success&per_page=100`),
      github("environment", "/environments/production"),
      github("jobs", `/actions/runs/${environment.GITHUB_RUN_ID}/attempts/1/jobs?per_page=100`),
      github("approvals", `/actions/runs/${environment.GITHUB_RUN_ID}/approvals`),
    ]);
  if (typeof run.actor?.login !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/u.test(run.actor.login))
    fail("manual operator identity is invalid", "evidence-read", "predicate", "run", "operator-identity");
  const actorPermission = await github("operator-permission", `/collaborators/${encodeURIComponent(run.actor.login)}/permission`);
  let object = tag.object;
  for (let depth = 0; object?.type === "tag" && depth < 4; depth += 1) {
    if (!shaPattern.test(object.sha ?? "")) fail("invalid annotated tag", "tag-resolution", "predicate", "tag-object", "annotated-tag");
    object = (await github("tag-object", `/git/tags/${object.sha}`)).object;
  }
  if (tag.ref !== `refs/tags/${inputs.tag}` || object?.type !== "commit") fail("tag cannot resolve to commit", "tag-resolution", "predicate", "tag", "tag-commit");
  for (const [page, key, label] of [[checkPage, "workflow_runs", "source validation"],
    [jobPage, "jobs", "dispatch validation"]]) {
    if (!Array.isArray(page?.[key]) || !Number.isSafeInteger(page.total_count) ||
        page.total_count < 0 || Object.is(page.total_count, -0) || page.total_count > 100 ||
        page.total_count !== page[key].length)
      fail(`${label} inventory is incomplete`, "inventory", "predicate",
        key === "workflow_runs" ? "source-checks" : "jobs", key === "workflow_runs" ? "source-inventory" : "jobs-inventory");
  }
  return { repo, branch, run, release, tagSha: object.sha, sourceComparison, controllerComparison,
    checks: checkPage.workflow_runs, protection,
    jobs: jobPage.jobs,
    approvals, actorPermission };
}

// Run from the trusted controller before checkout or execution of a dispatch-selected
// revision. This is source validation only; it cannot grant deployment authority.
export async function validatePromotionSource({ environment = process.env, fetcher = fetch,
  readEvent = (path) => readFile(path, "utf8"), now = () => Date.now() } = {}) {
  let eventText;
  try { eventText = await readEvent(environment.GITHUB_EVENT_PATH); }
  catch { fail("GitHub dispatch event is unavailable", "event", "body-read"); }
  let event;
  try { event = JSON.parse(eventText); }
  catch { fail("GitHub dispatch event is missing or invalid", "event", "json-invalid"); }
  const inputs = validatePromotionDispatch(environment, event);
  const evidence = await readPromotionEvidence(environment, inputs, fetcher);
  validatePromotionSourceEvidence({ environment, event, inputs, evidence, now: now() });
  return inputs.source_sha;
}

export async function createProductionAuthority({ environment = process.env, checkoutHead, dirty,
  fetcher = fetch, readEvent = (path) => readFile(path, "utf8"), now = () => Date.now(),
  writerFence = assertProductionWriterFence } = {}) {
  let event;
  try { event = JSON.parse(await readEvent(environment.GITHUB_EVENT_PATH)); }
  catch { fail("GitHub dispatch event is missing or invalid", "event", "json-invalid"); }
  const inputs = validatePromotionContext(environment, event, checkoutHead, dirty);
  const authorize = async () => {
    const evidence = await readPromotionEvidence(environment, inputs, fetcher);
    validatePromotionEvidence({ environment, event, inputs, evidence, now: now() });
  };
  const fence = async ({ allowDrain = true } = {}) => {
    await authorize();
    const writer = await writerFence(environment, fetcher, { allowDrain });
    // Provider sweeps can outlive the dispatch or race a cancellation/tag move.
    // Refresh GitHub authority, then check its deadline at the mutation handoff.
    await authorize();
    return { waited: writer?.waited === true };
  };
  await fence();
  return {
    sourceSha: inputs.source_sha, executionId: environment.GITHUB_RUN_ID, fence, authorize,
    validatePlan: async (plan) => validatePromotionPlan(inputs, plan),
    validatePredecessor: async (_annotations, { versions }) => validatePromotionPredecessor(inputs, versions),
  };
}

// Filled from the provider's read-only transition verifier; no CF mutation API is
// available to this adapter. The immutable controller chooses the implementation.
export async function assertProductionWriterFence(environment, fetcher = fetch, options = {}) {
  const { assertProductionPromotionWriterFence } = await import("./production-writer-fence.mjs");
  return assertProductionPromotionWriterFence({ environment, fetcher, ...options });
}

const promotionFailure = () => ({ outcome: "production-promotion-stopped", reason: "authority-or-delivery-verification-failed" });

export function sourceAuthenticationFailureRecord(error) {
  const record = promotionFailure();
  const diagnostic = sourceFailures.get(error);
  if (diagnostic) record.sourceAuthentication = { ...diagnostic };
  return record;
}

export async function runPromotionDelivery({ environment = process.env, mode = "deploy",
  loadDelivery = () => import("./production-delivery.mjs"), reportFailure = (record) => console.error(record) } = {}) {
  let failureRecord = promotionFailure;
  try {
    const engine = await loadDelivery();
    if (typeof engine.currentDeliveryFailureRecord !== "function") fail("delivery failure reporter is unavailable");
    failureRecord = engine.currentDeliveryFailureRecord;
    await engine.runDelivery({ target: "production", sourceRoot: environment.ATRINIK_DELIVERY_SOURCE_ROOT, mode });
    return 0;
  } catch (error) {
    // Only the fixed trusted engine formats delivery evidence. Never print raw
    // error messages, command output, provider response bodies or credentials.
    reportFailure(JSON.stringify(failureRecord(error)));
    return 1;
  }
}

async function main() {
  if (process.argv.length !== 3 || !["--dry-run", "--plan", "--execute", "--validate-source"].includes(process.argv[2]))
    fail("usage: production-promotion.mjs --dry-run|--plan|--execute|--validate-source");
  if (process.argv[2] === "--validate-source") {
    if (!process.env.GITHUB_OUTPUT) fail("GitHub step output path is missing", "output", "predicate", undefined, "output-path");
    const sourceSha = await validatePromotionSource();
    try { await appendFile(process.env.GITHUB_OUTPUT, `source_sha=${sourceSha}\n`); }
    catch { fail("GitHub step output write failed", "output", "unknown"); }
    return;
  }
  if (process.argv[2] === "--dry-run") {
    const inputs = Object.fromEntries(Object.entries(fields).map(([key, name]) => [key, process.env[name]]));
    validatePromotionInputs(inputs);
    console.log(JSON.stringify({ outcome: "promotion-inputs-valid", mutation: false, ...inputs }));
    return;
  }
  process.exitCode = await runPromotionDelivery({ mode: process.argv[2] === "--plan" ? "plan" : "deploy" });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(JSON.stringify(process.argv[2] === "--validate-source" ?
      sourceAuthenticationFailureRecord(error) : promotionFailure()));
    process.exitCode = 1;
  });
