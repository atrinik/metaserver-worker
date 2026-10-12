// Copyright (C) 2026 Atrinik contributors
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { publishCompleteRelease, releaseAssets } from "./publish-complete-release.mjs";
const sha = "a".repeat(40);
const assets = [{ name: "atrinik-metaserver-worker-4.35.0.tar.gz", size: 50, digest: `sha256:${"b".repeat(64)}` },
  { name: "SHA256SUMS", size: 120, digest: `sha256:${"c".repeat(64)}` }];
function fixture() {
  const context = { cwd: "/fixture", env: { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "atrinik/metaserver-worker",
    GITHUB_SHA: sha, GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main", GH_TOKEN: "fixture-secret" },
    nextRelease: { gitTag: "v4.35.0", gitHead: sha, version: "4.35.0" } };
  const release = { id: 123, tag_name: "v4.35.0", draft: true, immutable: false, prerelease: false,
    assets: assets.map((asset) => ({ ...asset, state: "uploaded" })) };
  const tag = { ref: "refs/tags/v4.35.0", object: { type: "commit", sha } };
  const calls = [];
  const fetcher = async (url, options) => {
    assert.equal(options.headers.Authorization, "Bearer fixture-secret");
    assert.equal(options.redirect, "error");
    calls.push({ url, method: options.method });
    if (options.method === "PATCH") {
      assert.equal(url, "https://api.github.com/repos/atrinik/metaserver-worker/releases/123");
      assert.deepEqual(JSON.parse(options.body), { draft: false });
      release.draft = false; release.immutable = true;
    }
    return new Response(JSON.stringify(url.includes("/git/ref/") ? tag : release));
  };
  return { context, release, tag, calls, fetcher };
}
test("publishes only after exact draft/source/upload integrity checks and verifies final state", async () => {
  const f = fixture();
  const result = await publishCompleteRelease(f.context, { fetcher: f.fetcher, readAssets: async () => assets });
  assert.equal(result.id, 123);
  assert.deepEqual(f.calls.map((call) => call.method), ["GET", "GET", "PATCH", "GET"]);
  assert.equal(f.release.immutable, true);
});
for (const [name, modify] of [
  ["missing archive", (f) => { f.release.assets.pop(); }],
  ["incomplete upload", (f) => { f.release.assets[0].state = "new"; }],
  ["wrong digest", (f) => { f.release.assets[0].digest = `sha256:${"d".repeat(64)}`; }],
  ["missing digest", (f) => { delete f.release.assets[0].digest; }],
  ["wrong size", (f) => { f.release.assets[0].size += 1; }],
  ["duplicate name", (f) => { f.release.assets[1] = f.release.assets[0]; }],
  ["wrong source", (f) => { f.tag.object.sha = "b".repeat(40); }],
  ["wrong tag", (f) => { f.tag.ref = "refs/tags/v4.34.0"; }],
  ["unexpected annotated tag", (f) => { f.tag.object.type = "tag"; }],
  ["already published historical release", (f) => { f.release.draft = false; }],
  ["prerelease", (f) => { f.release.prerelease = true; }],
  ["fork workflow", (f) => { f.context.env.GITHUB_REPOSITORY = "other/repo"; }],
  ["PR workflow", (f) => { f.context.env.GITHUB_EVENT_NAME = "pull_request"; }],
  ["substituted workflow source", (f) => { f.context.env.GITHUB_SHA = "b".repeat(40); }],
]) test(`leaves draft unpublished: ${name}`, async () => {
  const f = fixture(); modify(f);
  await assert.rejects(publishCompleteRelease(f.context, { fetcher: f.fetcher, readAssets: async () => assets }));
  assert.equal(f.calls.filter((call) => call.method === "PATCH").length, 0);
});
test("failed upload/API verification has no publication mutation or secret diagnostics", async () => {
  const f = fixture();
  await assert.rejects(publishCompleteRelease(f.context, { readAssets: async () => assets,
    fetcher: async () => { throw new Error("fixture-secret"); } }), (error) => !error.message.includes("fixture-secret"));
});
test("local release cohort has exact bounded files and checksum content", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "release-completeness-test-"));
  try {
    const directory = resolve(cwd, "build/release"); await mkdir(directory, { recursive: true });
    const name = "atrinik-metaserver-worker-4.35.0.tar.gz"; const bytes = Buffer.from("archive fixture");
    const sum = createHash("sha256").update(bytes).digest("hex");
    await writeFile(resolve(directory, name), bytes);
    await writeFile(resolve(directory, "SHA256SUMS"), `${sum}  ${name}\n`);
    assert.equal((await releaseAssets(cwd, "4.35.0")).length, 2);
    await writeFile(resolve(directory, "SHA256SUMS"), `${"0".repeat(64)}  ${name}\n`);
    await assert.rejects(releaseAssets(cwd, "4.35.0"), /checksum/);
    await writeFile(resolve(directory, "extra"), "unexpected");
    await assert.rejects(releaseAssets(cwd, "4.35.0"), /cohort/);
    await rm(resolve(directory, "extra")); await rm(resolve(directory, name));
    await symlink("SHA256SUMS", resolve(directory, name));
    await assert.rejects(releaseAssets(cwd, "4.35.0"), /regular/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
test("semantic release stages all assets as draft before verified publication", async () => {
  const config = JSON.parse(await readFile(new URL("../../.releaserc.json", import.meta.url), "utf8"));
  const github = config.plugins.findIndex((plugin) => Array.isArray(plugin) && plugin[0] === "@semantic-release/github");
  assert.equal(config.plugins[github][1].draftRelease, true);
  assert.deepEqual(config.plugins[github][1].assets, [{ path: "build/release/*" }]);
  assert.equal(config.plugins[github + 1], "./scripts/release/publish-complete-release.cjs");
  assert.equal(config.plugins.length, github + 2);
  const workflow = await readFile(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");
  assert(workflow.indexOf("node --test scripts/release/test-publish-complete-release.mjs") < workflow.indexOf("npx --yes"));
});
