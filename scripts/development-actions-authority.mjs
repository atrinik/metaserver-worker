// Copyright (C) 2026 Atrinik contributors
import { readFile } from "node:fs/promises";

const repository = "atrinik/metaserver-worker";
const workflow = ".github/workflows/deploy-development.yml";
const shaPattern = /^[0-9a-f]{40}$/u;
const fail = (message) => { throw new Error(`development delivery: ${message}`); };

export function validateDevelopmentContext(environment, event, checkoutHead, dirty) {
  const sourceSha = environment.ATRINIK_DEVELOPMENT_SHA;
  const check = event?.workflow_run;
  if (environment.GITHUB_ACTIONS !== "true" || environment.GITHUB_EVENT_NAME !== "workflow_run" ||
      environment.GITHUB_REPOSITORY !== repository || environment.GITHUB_REF !== "refs/heads/main" ||
      environment.GITHUB_RUN_ATTEMPT !== "1" || !/^[1-9][0-9]*$/u.test(environment.GITHUB_RUN_ID ?? "") ||
      !shaPattern.test(sourceSha ?? "") || sourceSha !== environment.GITHUB_SHA ||
      environment.GITHUB_WORKFLOW_SHA !== sourceSha ||
      environment.GITHUB_WORKFLOW_REF !== `${repository}/${workflow}@refs/heads/main` ||
      checkoutHead !== sourceSha || dirty !== false || event.repository?.full_name !== repository ||
      event.action !== "completed" || check?.head_sha !== sourceSha || check.head_branch !== "main" ||
      check.event !== "push" || check.conclusion !== "success" || check.status !== "completed" ||
      !Number.isSafeInteger(check.id) || check.id < 1 ||
      check.repository?.full_name !== repository || check.head_repository?.full_name !== repository)
    fail("requires a clean current-main checkout and successful same-repository Check event");
  return sourceSha;
}

export function validateDevelopmentEvidence(environment, event, evidence, now = Date.now()) {
  const { repo, branch, run, check, jobs, deployJobs, activeRuns, protection } = evidence;
  const sourceSha = environment.ATRINIK_DEVELOPMENT_SHA;
  const created = Date.parse(run?.created_at);
  if (repo?.full_name !== repository || repo.fork !== false || repo.default_branch !== "main" ||
      branch?.name !== "main" || branch.protected !== true || branch.commit?.sha !== sourceSha ||
      String(run?.id) !== environment.GITHUB_RUN_ID || run.run_attempt !== 1 ||
      run.event !== "workflow_run" || run.head_branch !== "main" || run.head_sha !== sourceSha ||
      run.path !== workflow || run.status !== "in_progress" || run.conclusion !== null ||
      run.repository?.full_name !== repository || run.head_repository?.full_name !== repository ||
      !Number.isFinite(created) || created > now || now - created > 60 * 60 * 1000)
    fail("run identity, freshness or newest-main fence failed");
  if (check?.id !== event.workflow_run.id || check.path !== ".github/workflows/check.yml" ||
      check.event !== "push" || check.head_branch !== "main" || check.head_sha !== sourceSha ||
      check.status !== "completed" || check.conclusion !== "success" ||
      check.repository?.full_name !== repository || check.head_repository?.full_name !== repository ||
      !Number.isFinite(Date.parse(check.updated_at)) || Date.parse(check.updated_at) > created ||
      !Array.isArray(jobs) || jobs.filter((job) => job.name === "verify").length !== 1 ||
      !jobs.some((job) => job.name === "verify" && job.run_id === check.id &&
        job.head_sha === sourceSha && job.status === "completed" && job.conclusion === "success"))
    fail("exact source Check and job validation failed");
  if (!Array.isArray(activeRuns) || activeRuns.length !== 1 || activeRuns[0].id !== run.id ||
      !Array.isArray(deployJobs) || deployJobs.filter((job) => job.name === "deploy").length !== 1 ||
      !deployJobs.some((job) => job.name === "deploy" && job.run_id === run.id &&
        job.head_sha === sourceSha && job.status === "in_progress" && job.conclusion === null))
    fail("development writer is not the sole authenticated active deployment");
  if (protection?.name !== "development" ||
      protection.deployment_branch_policy?.protected_branches !== true ||
      protection.deployment_branch_policy?.custom_branch_policies !== false)
    fail("development credential environment must restrict protected branches");
}

async function requestJson(path, environment, fetcher) {
  if (!environment.GITHUB_TOKEN) fail("GitHub authority read credential missing");
  const response = await fetcher(`https://api.github.com/repos/${repository}${path}`, {
    method: "GET", redirect: "error", signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${environment.GITHUB_TOKEN}`, Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (!response.ok || !response.body) fail("GitHub authority read rejected");
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 2_000_000) { await reader.cancel(); fail("GitHub authority response exceeds bound"); }
    chunks.push(Buffer.from(value));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function completePage(value, key) {
  if (!Number.isSafeInteger(value?.total_count) || value.total_count > 100 ||
      !Array.isArray(value[key]) || value[key].length !== value.total_count)
    fail("GitHub authority inventory incomplete");
  return value[key];
}

export async function createDevelopmentAuthority({ environment = process.env, checkoutHead, dirty,
  fetcher = fetch, readEvent = (path) => readFile(path, "utf8"), now = () => Date.now(),
  writerFence = async (input) => {
    const { assertProductionPromotionWriterFence } = await import("./production-writer-fence.mjs");
    await assertProductionPromotionWriterFence({ environment: input, fetcher });
  } } = {}) {
  const event = JSON.parse(await readEvent(environment.GITHUB_EVENT_PATH));
  const sourceSha = validateDevelopmentContext(environment, event, checkoutHead, dirty);
  const fence = async () => {
    const github = (path) => requestJson(path, environment, fetcher);
    const [repo, branch, run, check, jobs, deployJobs, activeRuns, protection] = await Promise.all([
      github(""), github("/branches/main"), github(`/actions/runs/${environment.GITHUB_RUN_ID}`),
      github(`/actions/runs/${event.workflow_run.id}`),
      github(`/actions/runs/${event.workflow_run.id}/jobs?filter=latest&per_page=100`),
      github(`/actions/runs/${environment.GITHUB_RUN_ID}/attempts/1/jobs?per_page=100`),
      github("/actions/workflows/deploy-development.yml/runs?status=in_progress&per_page=100"),
      github("/environments/development"),
    ]);
    validateDevelopmentEvidence(environment, event, { repo, branch, run, check,
      jobs: completePage(jobs, "jobs"), deployJobs: completePage(deployJobs, "jobs"),
      activeRuns: completePage(activeRuns, "workflow_runs"), protection }, now());
    await writerFence(environment);
  };
  await fence();
  return { sourceSha, executionId: environment.GITHUB_RUN_ID, fence,
    validatePlan: async () => {}, validatePredecessor: async () => {} };
}
