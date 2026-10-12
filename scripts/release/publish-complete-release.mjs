// Copyright (C) 2026 Atrinik contributors
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

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
  readAssets = releaseAssets } = {}) {
  const { cwd, env = process.env, nextRelease, logger } = context;
  if (!nextRelease || nextRelease.gitTag !== `v${nextRelease.version}` ||
      !/^[0-9a-f]{40}$/u.test(nextRelease.gitHead ?? "") ||
      env.GITHUB_REPOSITORY !== repository || env.GITHUB_ACTIONS !== "true" ||
      env.GITHUB_SHA !== nextRelease.gitHead || !["push", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME) ||
      !/^refs\/heads\/(?:main|\d+\.\d+\.x)$/u.test(env.GITHUB_REF ?? ""))
    fail("requires the authenticated release workflow and exact source SHA");
  const token = env.GH_TOKEN ?? env.GITHUB_TOKEN;
  if (!token) fail("release authentication is missing");
  const assets = await readAssets(cwd, nextRelease.version);
  const request = async (path, { method = "GET", body } = {}) => {
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
  };
  const tagPath = `/git/ref/tags/${encodeURIComponent(nextRelease.gitTag)}`;
  const [release, tag] = await Promise.all([
    request(`/releases/tags/${encodeURIComponent(nextRelease.gitTag)}`), request(tagPath),
  ]);
  // semantic-release creates lightweight tags. Refuse an unexpected tag object
  // rather than following a mutable, differently produced release lineage.
  if (tag.ref !== `refs/tags/${nextRelease.gitTag}` || tag.object?.type !== "commit")
    fail("release tag provenance is unsupported");
  validateDraft(release, assets, { tag: nextRelease.gitTag,
    sourceSha: nextRelease.gitHead, tagSha: tag.object.sha });
  const published = await request(`/releases/${release.id}`, {
    method: "PATCH", body: { draft: false },
  });
  if (published.id !== release.id || published.tag_name !== nextRelease.gitTag || published.draft !== false)
    fail("publication outcome needs fresh operator readback");
  const readback = await request(`/releases/${release.id}`);
  // Reuse the exact cohort validator while validating the published transition.
  if (readback.id !== release.id || readback.draft !== false || typeof readback.immutable !== "boolean")
    fail("published release state is invalid");
  validateDraft({ ...readback, draft: true, immutable: false }, assets,
    { tag: nextRelease.gitTag, sourceSha: nextRelease.gitHead, tagSha: tag.object.sha });
  logger?.log("Published complete release %s (immutable: %s)", nextRelease.gitTag, readback.immutable);
  return { name: "GitHub release", url: `https://github.com/${repository}/releases/tag/${nextRelease.gitTag}`,
    id: release.id };
}
