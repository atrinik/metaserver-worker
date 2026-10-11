// Copyright (C) 2026 Atrinik contributors
// The trusted main controller consumes GitHub's dispatch event; no local approval file
// or caller-selected module can grant production authority.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
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
const fail = (message) => { throw new Error(`production promotion: ${message}`); };
export const promotionDigest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function validatePromotionInputs(inputs) {
  if (!inputs || Object.keys(inputs).sort().join() !== Object.keys(fields).sort().join())
    fail("dispatch must name exactly the approved tag, SHA and four digests");
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u.test(inputs.tag ?? "") ||
      !shaPattern.test(inputs.source_sha ?? "") ||
      Object.keys(fields).filter((key) => !["tag", "source_sha"].includes(key))
        .some((key) => !digestPattern.test(inputs[key] ?? "")))
    fail("invalid immutable release coordinates");
  return inputs;
}

export function validatePromotionContext(environment, event, checkoutHead, dirty) {
  const inputs = validatePromotionInputs(event?.inputs);
  if (environment.GITHUB_ACTIONS !== "true" || environment.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
      environment.GITHUB_REPOSITORY !== repository || environment.GITHUB_REF !== "refs/heads/main" ||
      environment.GITHUB_RUN_ATTEMPT !== "1" || !/^[1-9][0-9]*$/u.test(environment.GITHUB_RUN_ID ?? "") ||
      !shaPattern.test(environment.GITHUB_SHA ?? "") ||
      environment.GITHUB_WORKFLOW_SHA !== environment.GITHUB_SHA ||
      environment.GITHUB_WORKFLOW_REF !== `${repository}/${workflow}@refs/heads/main` ||
      checkoutHead !== inputs.source_sha || dirty !== false ||
      event.repository?.full_name !== repository || event.ref !== "refs/heads/main" ||
      !Number.isSafeInteger(event.sender?.id) || event.sender.id < 1 ||
      !environment.ATRINIK_DELIVERY_SOURCE_ROOT)
    fail("requires a clean selected checkout and first-attempt protected main dispatch");
  for (const [key, name] of Object.entries(fields))
    if (environment[name] !== inputs[key]) fail("dispatch input differs from execution input");
  return inputs;
}

function ancestor(comparison, sha) {
  return ["ahead", "identical"].includes(comparison?.status) && comparison?.merge_base_commit?.sha === sha;
}

export function validatePromotionEvidence({ environment, event, inputs, evidence, now = Date.now() }) {
  const { repo, branch, run, release, tagSha, sourceComparison, controllerComparison, checks, protection, jobs, approvals } = evidence;
  const created = Date.parse(run?.created_at);
  if (repo?.full_name !== repository || repo.default_branch !== "main" || repo.fork !== false ||
      branch?.name !== "main" || branch.protected !== true ||
      String(run?.id) !== environment.GITHUB_RUN_ID || run.run_attempt !== 1 ||
      run.event !== "workflow_dispatch" || run.head_branch !== "main" ||
      run.head_sha !== environment.GITHUB_SHA || run.path !== workflow ||
      run.repository?.full_name !== repository || run.head_repository?.full_name !== repository ||
      run.status !== "in_progress" || run.conclusion !== null ||
      run.actor?.id !== event.sender.id || run.triggering_actor?.id !== event.sender.id ||
      !Number.isFinite(created) || created > now || now - created > 60 * 60 * 1000)
    fail("dispatch identity, first attempt or one-hour freshness fence failed");
  if (tagSha !== inputs.source_sha || release?.tag_name !== inputs.tag ||
      release.immutable !== true || release.draft !== false || release.prerelease !== false ||
      !Number.isSafeInteger(release.id) || !Number.isFinite(Date.parse(release.published_at)) ||
      Date.parse(release.published_at) > created ||
      !ancestor(sourceComparison, inputs.source_sha) ||
      !ancestor(controllerComparison, environment.GITHUB_SHA))
    fail("selected tag lost immutable release or protected source provenance");
  if (!Array.isArray(checks) || !checks.some((check) =>
    check.path === ".github/workflows/check.yml" && check.event === "push" &&
    check.head_branch === "main" && check.head_sha === inputs.source_sha &&
    check.repository?.full_name === repository && check.head_repository?.full_name === repository &&
    check.status === "completed" && check.conclusion === "success" &&
    Number.isFinite(Date.parse(check.updated_at)) && Date.parse(check.updated_at) <= created))
    fail("selected source lacks successful protected-main Check before dispatch");
  const reviewers = protection?.protection_rules?.find((rule) => rule.type === "required_reviewers");
  if (protection?.name !== "production" || !Number.isSafeInteger(protection.id) ||
      protection.deployment_branch_policy?.protected_branches !== true ||
      protection.deployment_branch_policy?.custom_branch_policies !== false ||
      reviewers?.prevent_self_review !== true || !Array.isArray(reviewers.reviewers) ||
      reviewers.reviewers.length < 1)
    fail("production environment requires independent review and protected branches");
  const reviews = Array.isArray(approvals) ? approvals.filter((approval) =>
    approval.environments?.some((entry) => entry.id === protection.id && entry.name === "production")) : [];
  if (reviews.length !== 1 || reviews[0].state !== "approved" ||
      !Number.isSafeInteger(reviews[0].user?.id) || reviews[0].user.id === event.sender.id)
    fail("this dispatch lacks one independent production environment approval");
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
async function requestJson(url, token, fetcher) {
  if (typeof token !== "string" || !token) fail("required read credential is missing");
  let response;
  try {
    response = await fetcher(url, {
      method: "GET", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10" },
    });
  } catch { fail("authority read failed"); }
  if (!response.ok) fail(`authority read rejected (${response.status})`);
  const reader = response.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2_000_000) { await reader.cancel(); fail("authority response exceeds bound"); }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch { fail("authority response is invalid or oversized"); }
}

export async function readPromotionEvidence(environment, inputs, fetcher = fetch) {
  const github = (path) => requestJson(`https://api.github.com/repos/${repository}${path}`,
    environment.GITHUB_TOKEN, fetcher);
  const [repo, branch, run, release, tag, sourceComparison, controllerComparison, checkPage, protection, jobPage, approvals] =
    await Promise.all([
      github(""), github("/branches/main"), github(`/actions/runs/${environment.GITHUB_RUN_ID}`),
      github(`/releases/tags/${encodeURIComponent(inputs.tag)}`),
      github(`/git/ref/tags/${encodeURIComponent(inputs.tag)}`),
      github(`/compare/${inputs.source_sha}...main`),
      github(`/compare/${environment.GITHUB_SHA}...main`),
      github(`/actions/workflows/check.yml/runs?head_sha=${inputs.source_sha}&event=push&branch=main&status=success&per_page=100`),
      github("/environments/production"),
      github(`/actions/runs/${environment.GITHUB_RUN_ID}/attempts/1/jobs?per_page=100`),
      github(`/actions/runs/${environment.GITHUB_RUN_ID}/approvals`),
    ]);
  let object = tag.object;
  for (let depth = 0; object?.type === "tag" && depth < 4; depth += 1) {
    if (!shaPattern.test(object.sha ?? "")) fail("invalid annotated tag");
    object = (await github(`/git/tags/${object.sha}`)).object;
  }
  if (tag.ref !== `refs/tags/${inputs.tag}` || object?.type !== "commit") fail("tag cannot resolve to commit");
  if (!Array.isArray(checkPage.workflow_runs) || checkPage.total_count > 100)
    fail("source validation inventory is incomplete");
  return { repo, branch, run, release, tagSha: object.sha, sourceComparison, controllerComparison,
    checks: checkPage.workflow_runs, protection,
    jobs: Number.isSafeInteger(jobPage.total_count) && jobPage.total_count <= 100 ? jobPage.jobs : null,
    approvals };
}

export async function createProductionAuthority({ environment = process.env, checkoutHead, dirty,
  fetcher = fetch, readEvent = (path) => readFile(path, "utf8"), now = () => Date.now(),
  writerFence = assertProductionWriterFence } = {}) {
  let event;
  try { event = JSON.parse(await readEvent(environment.GITHUB_EVENT_PATH)); }
  catch { fail("GitHub dispatch event is missing or invalid"); }
  const inputs = validatePromotionContext(environment, event, checkoutHead, dirty);
  const fence = async () => {
    const evidence = await readPromotionEvidence(environment, inputs, fetcher);
    validatePromotionEvidence({ environment, event, inputs, evidence, now: now() });
    await writerFence(environment, fetcher);
  };
  await fence();
  return {
    sourceSha: inputs.source_sha, executionId: environment.GITHUB_RUN_ID, fence,
    validatePlan: async (plan) => validatePromotionPlan(inputs, plan),
    validatePredecessor: async (_annotations, { versions }) => validatePromotionPredecessor(inputs, versions),
  };
}

// Filled from the provider's read-only transition verifier; no CF mutation API is
// available to this adapter. The immutable controller chooses the implementation.
export async function assertProductionWriterFence(environment, fetcher = fetch) {
  const { assertProductionPromotionWriterFence } = await import("./production-writer-fence.mjs");
  await assertProductionPromotionWriterFence({ environment, fetcher });
}

async function main() {
  if (process.argv.length !== 3 || !["--dry-run", "--execute"].includes(process.argv[2]))
    fail("usage: production-promotion.mjs --dry-run|--execute");
  if (process.argv[2] === "--dry-run") {
    const inputs = Object.fromEntries(Object.entries(fields).map(([key, name]) => [key, process.env[name]]));
    validatePromotionInputs(inputs);
    console.log(JSON.stringify({ outcome: "promotion-inputs-valid", mutation: false, ...inputs }));
    return;
  }
  const { runDelivery } = await import("./production-delivery.mjs");
  await runDelivery({ target: "production", sourceRoot: process.env.ATRINIK_DELIVERY_SOURCE_ROOT });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => { console.error("production promotion stopped; authority or delivery verification failed"); process.exitCode = 1; });
