// Copyright (C) 2026 Atrinik contributors
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { parseResourcePolicy, projectWorkerResources,
  resourcePolicyReader } from "./delivery-resource-policy.mjs";

const repository = "atrinik/metaserver-worker";
const workflow = ".github/workflows/diagnose-development-resources.yml";
const shaPattern = /^[0-9a-f]{40}$/u;
const maxFields = 128;
const maxOutputBytes = 64 * 1024;
const failure = category => ({ outcome: "rejected", mutation: false, category });

function validContext(environment) {
  return environment.GITHUB_ACTIONS === "true" && environment.GITHUB_EVENT_NAME === "workflow_dispatch" &&
    environment.GITHUB_REPOSITORY === repository && environment.GITHUB_REF === "refs/heads/main" &&
    environment.GITHUB_RUN_ATTEMPT === "1" && /^[1-9][0-9]{0,15}$/u.test(environment.GITHUB_RUN_ID ?? "") &&
    shaPattern.test(environment.GITHUB_SHA ?? "") && environment.GITHUB_WORKFLOW_SHA === environment.GITHUB_SHA &&
    environment.GITHUB_WORKFLOW_REF === `${repository}/${workflow}@refs/heads/main` && Boolean(environment.GITHUB_TOKEN);
}

async function boundedJson(response) {
  if (!response.ok || !response.body) throw new Error("read rejected");
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 2_000_000) { await reader.cancel(); throw new Error("read bound"); }
    chunks.push(Buffer.from(value));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

// This preflight runs without Cloudflare inputs, then repeats before any provider read.
export async function verifyContext(environment, fetcher = fetch, now = Date.now()) {
  if (!validContext(environment)) return failure("context-rejected");
  try {
    const github = async path => boundedJson(await fetcher(`https://api.github.com/repos/${repository}${path}`, {
      method: "GET", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${environment.GITHUB_TOKEN}`, Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28" },
    }));
    const repo = await github("");
    const branch = await github("/branches/main");
    const run = await github(`/actions/runs/${environment.GITHUB_RUN_ID}`);
    const protection = await github("/environments/development");
    const created = Date.parse(run?.created_at);
    if (repo?.id !== 1324297032 || repo.full_name !== repository || repo.fork !== false || repo.default_branch !== "main" ||
        branch?.name !== "main" || branch.protected !== true || branch.commit?.sha !== environment.GITHUB_SHA ||
        String(run?.id) !== environment.GITHUB_RUN_ID || run.run_attempt !== 1 || run.event !== "workflow_dispatch" ||
        run.head_branch !== "main" || run.head_sha !== environment.GITHUB_SHA || run.path !== workflow ||
        run.status !== "in_progress" || run.conclusion !== null ||
        run.repository?.full_name !== repository || run.head_repository?.full_name !== repository ||
        !Number.isFinite(created) || created > now || now - created > 30 * 60_000 ||
        protection?.name !== "development" || protection.deployment_branch_policy?.protected_branches !== true ||
        protection.deployment_branch_policy?.custom_branch_policies !== false)
      return failure("context-rejected");
    return { outcome: "context-verified", mutation: false, sourceSha: environment.GITHUB_SHA };
  } catch { return failure("github-read-rejected"); }
}

function normalize(worker) {
  const result = { ...worker };
  // Preserve the delivery fence's array comparator, including JSON key order.
  for (const key of ["resources", "services", "origins", "variables", "routes", "secrets"])
    result[key] = [...result[key]].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return result;
}

// Only schema-defined property names and numeric indices enter output, never data values.
function differentPaths(expected, actual, path = "", fields = []) {
  if (fields.length >= maxFields || Object.is(expected, actual)) return fields;
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) fields.push(`${path}/length`);
    for (let i = 0; i < Math.min(expected.length, actual.length) && fields.length < maxFields; i++)
      differentPaths(expected[i], actual[i], `${path}/${i}`, fields);
  } else if (expected && actual && typeof expected === "object" && typeof actual === "object" &&
      !Array.isArray(expected) && !Array.isArray(actual)) {
    for (const key of [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()) {
      if (fields.length >= maxFields) break;
      differentPaths(expected[key], actual[key], `${path}/${key}`, fields);
    }
  } else fields.push(path || "/");
  return fields;
}

export async function diagnoseDevelopmentResources(environment, fetcher = fetch, now = Date.now()) {
  const authority = await verifyContext(environment, fetcher, now);
  if (authority.outcome !== "context-verified") return authority;
  let policy;
  try {
    policy = parseResourcePolicy(environment.ATRINIK_DELIVERY_RESOURCE_POLICY, "development", environment.CLOUDFLARE_ACCOUNT_ID);
    if (!environment.ATRINIK_DELIVERY_RESOURCE_READ_TOKEN) return failure("input-rejected");
  } catch { return failure("input-rejected"); }
  const deadline = AbortSignal.timeout(120_000);
  const allowed = new Map();
  for (const cohort of policy.cohorts) for (const worker of cohort.workers) {
    const root = `https://api.cloudflare.com/client/v4/accounts/${cohort.accountId}`;
    allowed.set(`${root}/workers/scripts/${worker.name}/settings`, "settings");
    allowed.set(`${root}/workers/services/${worker.name}/environments/production/routes?show_zonename=true`, "routes");
    allowed.set(`${root}/workers/domains?service=${worker.name}&environment=production`, "domains");
  }
  const requests = [];
  let lastReadRejected = false;
  const guardedFetch = async (url, options) => {
    const endpoint = allowed.get(url);
    if (!endpoint || options?.method !== "GET" || options.redirect !== "error" || requests.length >= 27 || deadline.aborted)
      throw new Error("read boundary");
    const row = { endpoint, status: null };
    requests.push(row);
    try {
      const response = await fetcher(url, { ...options, signal: AbortSignal.any([options.signal, deadline]) });
      row.status = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : null;
      if (!response.ok) lastReadRejected = true;
      return response;
    } catch { lastReadRejected = true; throw new Error("read rejected"); }
  };
  const read = resourcePolicyReader(environment, guardedFetch);
  const rows = [];
  for (const cohort of policy.cohorts) for (const worker of cohort.workers) {
    const start = requests.length;
    let observed;
    try { observed = await read(cohort.accountId, worker.name); }
    catch {
      rows.push({ cohort: cohort.environment, role: worker.role, outcome: "read-rejected", requests: requests.slice(start) });
      return { ...failure("resource-read-rejected"), sourceSha: authority.sourceSha, rows };
    }
    try {
      const actual = normalize(projectWorkerResources({ name: worker.name, role: worker.role, ...observed }));
      const expected = normalize(worker);
      // Match the ordinary DEV fence: non-target plaintext remains pinned.
      if (cohort.environment === "development") { delete actual.variables; delete expected.variables; }
      const fields = differentPaths(expected, actual);
      rows.push({ cohort: cohort.environment, role: worker.role, outcome: fields.length ? "mismatch" : "matched",
        fields, fieldLimitReached: fields.length === maxFields, requests: requests.slice(start) });
    } catch {
      rows.push({ cohort: cohort.environment, role: worker.role, outcome: "projection-rejected", requests: requests.slice(start) });
      return { ...failure("resource-projection-rejected"), sourceSha: authority.sourceSha, rows };
    }
  }
  return { outcome: rows.some(row => row.outcome !== "matched") || lastReadRejected ? "rejected" : "matched",
    mutation: false, sourceSha: authority.sourceSha, rows };
}

export function formatDiagnostic(result) {
  const text = JSON.stringify(result);
  return Buffer.byteLength(text) <= maxOutputBytes ? text : JSON.stringify(failure("output-bound"));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  let result;
  try {
    if (process.argv.length !== 3 || !["--verify-context", "--diagnose"].includes(process.argv[2]))
      result = failure("arguments-rejected");
    else result = await (process.argv[2] === "--verify-context" ? verifyContext(process.env) : diagnoseDevelopmentResources(process.env));
  } catch { result = failure("diagnostic-failed"); }
  console.log(formatDiagnostic(result));
  process.exitCode = ["matched", "context-verified"].includes(result.outcome) ? 0 : 1;
}
