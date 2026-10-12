// Copyright (C) 2026 Atrinik contributors
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = "atrinik/metaserver-worker";
const fail = (message) => { throw new Error(`release publication: ${message}`); };
const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

export async function releaseAssets(cwd, version) {
  if (!/^\d+\.\d+\.\d+$/u.test(version ?? "")) fail("invalid stable release version");
  const directory = resolve(cwd, "build/release");
  const archive = `atrinik-metaserver-worker-${version}.tar.gz`;
  const names = [archive, "SHA256SUMS"].sort();
  if (JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify(names))
    fail("release asset cohort is incomplete or unexpected");
  const assets = [];
  for (const name of names) {
    const path = resolve(directory, name);
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > 64 * 1024 * 1024)
      fail("release asset is not a bounded regular file");
    const bytes = await readFile(path);
    assets.push({ name, size: bytes.length, digest: digest(bytes), bytes });
  }
  const tarball = assets.find((asset) => asset.name === archive);
  const checksum = assets.find((asset) => asset.name === "SHA256SUMS");
  if (checksum.bytes.toString("utf8") !== `${tarball.digest.slice(7)}  ${archive}\n`)
    fail("release checksum does not match the complete archive");
  return assets.map(({ bytes: _bytes, ...asset }) => asset);
}

export function validateDraft(release, assets, { tag, sourceSha, tagSha }) {
  if (!Number.isSafeInteger(release?.id) || release.id < 1 || release.tag_name !== tag ||
      release.draft !== true || release.prerelease !== false || release.immutable !== false ||
      tagSha !== sourceSha || !/^[0-9a-f]{40}$/u.test(sourceSha ?? "") ||
      !Array.isArray(release.assets) || release.assets.length !== assets.length)
    fail("draft or source identity differs from the selected release");
  const names = new Set();
  for (const actual of release.assets) {
    const expected = assets.find((asset) => asset.name === actual.name);
    if (!expected || names.has(actual.name) || actual.state !== "uploaded" ||
        actual.size !== expected.size || actual.digest !== expected.digest)
      fail("uploaded release assets lack complete matching integrity proof");
    names.add(actual.name);
  }
}

export async function publishCompleteRelease(context, { fetcher = fetch,
  readAssets = releaseAssets, recovery = false } = {}) {
  const { cwd, env = process.env, nextRelease, logger } = context;
  if (!nextRelease || nextRelease.gitTag !== `v${nextRelease.version}` ||
      !/^[0-9a-f]{40}$/u.test(nextRelease.gitHead ?? "") ||
      env.GITHUB_REPOSITORY !== repository || env.GITHUB_ACTIONS !== "true" ||
      (!recovery && env.GITHUB_SHA !== nextRelease.gitHead) || !["push", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME) ||
      !/^refs\/heads\/(?:main|\d+\.\d+\.x)$/u.test(env.GITHUB_REF ?? ""))
    fail("requires the authenticated release workflow and exact source SHA");
  const token = env.GH_TOKEN ?? env.GITHUB_TOKEN;
  if (!token) fail("release authentication is missing");
  const assets = await readAssets(cwd, nextRelease.version);
  let publicationAttempted = false;
  const request = async (path, { method = "GET", body } = {}) => {
    try {
    if (method === "PATCH") publicationAttempted = true;
    let response;
    try {
      response = await fetcher(`https://api.github.com/repos/${repository}${path}`, {
        method, redirect: "error", signal: AbortSignal.timeout(30_000),
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2026-03-10", ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch { fail("GitHub request failed; retain draft or inspect ambiguous publication"); }
    if (!response.ok || !response.body) fail("GitHub request rejected; retain draft");
    const chunks = []; let length = 0;
    for await (const chunk of response.body) {
      length += chunk.byteLength;
      if (length > 256 * 1024) fail("GitHub readback exceeds bound");
      chunks.push(Buffer.from(chunk));
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { fail("GitHub readback is invalid"); }
    } catch {
      fail(publicationAttempted ? "publication outcome is ambiguous; inspect fresh release and tag readback" :
        "release verification read failed; retain draft");
    }
  };
  const tagPath = `/git/ref/tags/${encodeURIComponent(nextRelease.gitTag)}`;
  const [releases, tag] = await Promise.all([
    request("/releases?per_page=100"), request(tagPath),
  ]);
  const release = selectDraft(releases, nextRelease.gitTag);
  // semantic-release creates lightweight tags. Refuse an unexpected tag object
  // rather than following a mutable, differently produced release lineage.
  if (tag.ref !== `refs/tags/${nextRelease.gitTag}` || tag.object?.type !== "commit")
    fail("release tag provenance is unsupported");
  validateDraft(release, assets, { tag: nextRelease.gitTag,
    sourceSha: nextRelease.gitHead, tagSha: tag.object.sha });
  if (env.ATRINIK_RELEASE_IMMUTABILITY_ACTIVE !== "enabled") {
    logger?.log("Verified draft %s retained; immutable publication is inactive", nextRelease.gitTag);
    return { name: "Verified GitHub draft", url: `https://github.com/${repository}/releases/tag/${nextRelease.gitTag}`,
      id: release.id, draft: true };
  }
  const published = await request(`/releases/${release.id}`, {
    method: "PATCH", body: { draft: false },
  });
  if (published.id !== release.id || published.tag_name !== nextRelease.gitTag || published.draft !== false)
    fail("publication outcome needs fresh operator readback");
  const [readback, lockedTag] = await Promise.all([
    request(`/releases/${release.id}`), request(tagPath),
  ]);
  if (lockedTag.ref !== `refs/tags/${nextRelease.gitTag}` || lockedTag.object?.type !== "commit" ||
      lockedTag.object.sha !== nextRelease.gitHead)
    fail("published immutable tag differs from selected source; inspect release, never promote");
  // Reuse the exact cohort validator while validating the published transition.
  if (readback.id !== release.id || readback.draft !== false || readback.immutable !== true)
    fail("published release state is invalid");
  validateDraft({ ...readback, draft: true, immutable: false }, assets,
    { tag: nextRelease.gitTag, sourceSha: nextRelease.gitHead, tagSha: tag.object.sha });
  logger?.log("Published complete release %s (immutable: %s)", nextRelease.gitTag, readback.immutable);
  return { name: "GitHub release", url: `https://github.com/${repository}/releases/tag/${nextRelease.gitTag}`,
    id: release.id };
}


// Recovery finalizes only an owner-selected existing draft. The normal release
// job may already have tagged the source, so semantic-release reruns are not the
// recovery mechanism. Approval names source and both immutable asset digests.
export async function finalizeExistingDraft(environment = process.env, { fetcher = fetch } = {}) {
  const tag = environment.ATRINIK_RELEASE_DRAFT_TAG;
  const sourceSha = environment.ATRINIK_RELEASE_DRAFT_SHA;
  const archiveDigest = environment.ATRINIK_RELEASE_ARCHIVE_SHA256;
  const checksumDigest = environment.ATRINIK_RELEASE_CHECKSUMS_SHA256;
  if (!/^v\d+\.\d+\.\d+$/u.test(tag ?? "") || !/^[0-9a-f]{40}$/u.test(sourceSha ?? "") ||
      ![archiveDigest, checksumDigest].every((value) => /^[0-9a-f]{64}$/u.test(value ?? "")) ||
      environment.GITHUB_ACTIONS !== "true" || environment.GITHUB_REPOSITORY !== repository ||
      environment.GITHUB_EVENT_NAME !== "workflow_dispatch" || environment.GITHUB_REF !== "refs/heads/main" ||
      environment.GITHUB_RUN_ATTEMPT !== "1" || environment.ATRINIK_RELEASE_IMMUTABILITY_ACTIVE !== "enabled" ||
      environment.GITHUB_WORKFLOW_REF !== `${repository}/.github/workflows/finalize-release-draft.yml@refs/heads/main` ||
      environment.GITHUB_WORKFLOW_SHA !== environment.GITHUB_SHA ||
      !/^[0-9a-f]{40}$/u.test(environment.GITHUB_SHA ?? ""))
    fail("exact draft finalization requires activated first-attempt main workflow dispatch");
  const token = environment.GH_TOKEN ?? environment.GITHUB_TOKEN;
  if (!token) fail("release authentication is missing");
  const get = async (path) => {
    const response = await fetcher(`https://api.github.com/repos/${repository}${path}`, {
      method: "GET", redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10" },
    });
    if (!response.ok) fail("draft source authority read failed");
    const bytes = await boundedBytes(response, 256 * 1024);
    try { return JSON.parse(bytes.toString("utf8")); } catch { fail("draft source authority response invalid"); }
  };
  const [branch, comparison, checks, releases, controllerChecks] = await Promise.all([
    get("/branches/main"), get(`/compare/${sourceSha}...main`),
    get(`/actions/workflows/check.yml/runs?head_sha=${sourceSha}&event=push&branch=main&status=success&per_page=100`),
    get("/releases?per_page=100"),
    get(`/actions/workflows/check.yml/runs?head_sha=${environment.GITHUB_SHA}&event=push&branch=main&status=success&per_page=100`),
  ]);
  const draft = selectDraft(releases, tag);
  if (branch.commit?.sha !== environment.GITHUB_SHA || !successfulCheck(controllerChecks, environment.GITHUB_SHA))
    fail("draft finalization controller is not validated current main");
  if (branch.name !== "main" || branch.protected !== true ||
      !["ahead", "identical"].includes(comparison.status) || comparison.merge_base_commit?.sha !== sourceSha ||
      !successfulCheck(checks, sourceSha))
    fail("draft source lacks successful protected-main validation");
  const archiveName = `atrinik-metaserver-worker-${tag.slice(1)}.tar.gz`;
  const expected = [{ name: archiveName, digest: `sha256:${archiveDigest}` },
    { name: "SHA256SUMS", digest: `sha256:${checksumDigest}` }];
  if (!Array.isArray(draft.assets) || draft.assets.length !== 2 || draft.draft !== true || draft.tag_name !== tag)
    fail("selected existing draft is incomplete");
  const verified = [];
  for (const asset of expected) {
    const candidates = draft.assets.filter((candidate) => candidate.name === asset.name);
    if (candidates.length !== 1 || !Number.isSafeInteger(candidates[0].id) || candidates[0].id < 1 ||
        candidates[0].digest !== asset.digest || candidates[0].state !== "uploaded")
      fail("selected draft asset differs from approval");
    const candidate = candidates[0];
    let response = await fetcher(`https://api.github.com/repos/${repository}/releases/assets/${candidate.id}`, {
      method: "GET", redirect: "manual", signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${token}`, Accept: "application/octet-stream" },
    });
    if (response.status === 302) {
      let location; try { location = new URL(response.headers.get("location")); } catch { fail("invalid asset redirect"); }
      if (location.protocol !== "https:" || location.hostname !== "release-assets.githubusercontent.com" ||
          location.username || location.password || location.port)
        fail("untrusted release asset redirect");
      // The signed asset URL is a private capability. Never forward the GitHub
      // token or log that URL; never follow another redirect.
      response = await fetcher(location.href, { method: "GET", redirect: "error", signal: AbortSignal.timeout(30_000) });
    }
    if (!response.ok) fail("draft asset download failed");
    const bytes = await boundedBytes(response, 64 * 1024 * 1024);
    if (bytes.length !== candidate.size || digest(bytes) !== asset.digest)
      fail("downloaded draft asset integrity mismatch");
    if (asset.name === "SHA256SUMS" && bytes.toString("utf8") !== `${archiveDigest}  ${archiveName}\n`)
      fail("approved draft checksum does not bind approved archive");
    verified.push({ ...asset, size: bytes.length });
  }
  return publishCompleteRelease({ cwd: ".", env: environment,
    nextRelease: { gitTag: tag, version: tag.slice(1), gitHead: sourceSha } },
  { fetcher, readAssets: async () => verified, recovery: true });
}

export function selectDraft(releases, tag) {
  if (!Array.isArray(releases) || releases.length >= 100)
    fail("release inventory is incomplete; use a bounded qualified draft recovery");
  const matches = releases.filter((release) => release.tag_name === tag);
  if (matches.length !== 1 || matches[0].draft !== true)
    fail("exact existing draft is missing or ambiguous");
  return matches[0];
}

function successfulCheck(checks, sha) {
  return Number.isSafeInteger(checks.total_count) && checks.total_count > 0 && checks.total_count <= 100 &&
    Array.isArray(checks.workflow_runs) && checks.workflow_runs.length === checks.total_count &&
    checks.workflow_runs.some((run) => run.head_sha === sha && run.head_branch === "main" && run.event === "push" &&
      run.path === ".github/workflows/check.yml" && run.status === "completed" && run.conclusion === "success" &&
      run.repository?.full_name === repository && run.head_repository?.full_name === repository);
}

async function boundedBytes(response, limit) {
  try {
  if (!response.body) fail("response body missing");
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > limit) fail("response exceeds bound");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
  } catch { fail("bounded release response could not be verified"); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== "--finalize-draft") process.exitCode = 1;
  else finalizeExistingDraft().then((result) => console.log(JSON.stringify(result)))
    .catch(() => { console.error("Draft finalization stopped; retain draft or inspect publication readback"); process.exitCode = 1; });
}
