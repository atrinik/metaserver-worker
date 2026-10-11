import { env } from "cloudflare:workers";
import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CoreEnv } from "../src/core-env";
import type { DirectoryBuildResult } from "../src/directory-builder";
import {
  handleDirectoryReconciliationRequest,
  INTERNAL_DIRECTORY_RECONCILIATION_URL,
} from "../src/directory-reconciliation";
import {
  DIRECTORY_PROFILES,
  readDirectoryArtifactPublication,
} from "../src/directory-state";
import type { DirectoryProfile } from "../src/directory-state";
import worker, {
  handlePublisherCoordinatorRequest,
  handleRendezvousCoordinatorRequest,
} from "../src/index";
import publisher from "../src/publisher-worker";
import rendezvous from "../src/rendezvous-worker";

const NOW = Math.floor(Date.now() / 1_000);
const ZERO_DIGEST = "0".repeat(64);

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(NOW * 1_000);
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({
    success: true, errors: [], messages: [], result: { id: "f".repeat(32) },
  }));
  await env.DB.batch([
    ...["directory_artifact_history", "directory_artifact_commits",
      "directory_expiry_commits", "directory_activity_buckets",
      "directory_activity_state", "directory_admin_pins", "directory_entries",
      "server_presence", "directory_outbox", "publisher_nonces", "publisher_replay"]
      .map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
    env.DB.prepare("UPDATE directory_revisions SET revision = 0, updated_at = 0"),
    env.DB.prepare(`UPDATE directory_artifact_publications
      SET published_revision = 0, generation = 0, generated_at = 0,
        expires_at = 0, model_sha256 = ?, html_sha256 = ?, xml_sha256 = ?,
        json_sha256 = ?, manifest_sha256 = ?, html_bytes = 0, xml_bytes = 0,
        json_bytes = 0, manifest_bytes = 0, published_at = 0`)
      .bind(ZERO_DIGEST, ZERO_DIGEST, ZERO_DIGEST, ZERO_DIGEST, ZERO_DIGEST),
  ]);
  await Promise.all([
    ...[env.DIRECTORY_GENERATIONS, env.CLASSIC_DIRECTORY_PUBLIC, env.GAME_DIRECTORY_PUBLIC]
      .map(async (bucket) => {
        let cursor: string | undefined;
        do {
          const page = await bucket.list({ ...(cursor === undefined ? {} : { cursor }) });
          if (page.objects.length > 0) await bucket.delete(page.objects.map((item) => item.key));
          cursor = page.truncated ? page.cursor : undefined;
        } while (cursor !== undefined);
      }),
    ...DIRECTORY_PROFILES.map((profile) => runInDurableObject(
      env.DIRECTORY_BUILDER.getByName(profile), async (_instance, state) => {
        await state.storage.deleteAll();
        await state.storage.put("directory-builder:state:v1", {
          version: 1, highWaterGeneration: 0, pending: null, cleanupCursor: null,
        });
      },
    )),
  ]);
});

describe("private deployment directory reconciliation", () => {
  it.each([
    ["wrong method", () => new Request(INTERNAL_DIRECTORY_RECONCILIATION_URL)],
    ["query", () => request("?profile=game-v2")],
    ["fragment", () => request("#alias")],
    ["path", () => request("/extra")],
    ["origin", () => new Request("https://example.com/v1/directory-reconciliation", { method: "POST" })],
    ["body", () => new Request(INTERNAL_DIRECTORY_RECONCILIATION_URL, { method: "POST", body: "{}" })],
    ["empty stream", () => new Request(INTERNAL_DIRECTORY_RECONCILIATION_URL, { method: "POST", body: "" })],
    ["profile header", () => request("", { "X-Profile": "game-v2" })],
    ["source header", () => request("", { "CF-Connecting-IP": "192.0.2.1" })],
    ["authorization", () => request("", { Authorization: "Bearer arbitrary" })],
    ["transfer encoding", () => request("", { "Transfer-Encoding": "chunked" })],
    ["length", () => request("", { "Content-Length": "1" })],
    ["noncanonical length", () => request("", { "Content-Length": "00" })],
    ["host", () => request("", { Host: "example.com" })],
  ] as const)("rejects %s before state access", async (_name, makeRequest) => {
    const access = vi.fn(() => { throw new Error("Unexpected state access"); });
    const fake = new Proxy({} as CoreEnv, { get: access });
    expect((await handleDirectoryReconciliationRequest(makeRequest(), fake)).status).toBe(400);
    expect(access).not.toHaveBeenCalled();
  });

  it("builds both generation-zero profiles and returns a redacted current receipt", async () => {
    for (const profile of DIRECTORY_PROFILES) {
      expect((await readDirectoryArtifactPublication(env.DB, profile)).generation).toBe(0);
    }
    const response = await handleDirectoryReconciliationRequest(request("", {
      Host: "internal.atrinik.invalid", "Content-Length": "0",
    }), env);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const receipt = await response.json();
    expect(receipt).toEqual({
      schema: "directory-reconciliation-v1", completedAt: NOW,
      configuration: {
        classicCutoverMode: "v6-production", gameCutoverMode: "v2-production",
        classicOrigin: env.CLASSIC_DIRECTORY_PUBLIC_ORIGIN,
        gameOrigin: env.GAME_DIRECTORY_PUBLIC_ORIGIN,
      },
      profiles: DIRECTORY_PROFILES.map((profile) => ({
        profile, outcome: "published", generation: 1, generatedAt: NOW,
        expiresAt: Math.floor((NOW + 14_400) / 900) * 900,
      })),
    });
    for (const profile of DIRECTORY_PROFILES) {
      expect((await readDirectoryArtifactPublication(env.DB, profile)).generation).toBe(1);
    }
    const current = await handleDirectoryReconciliationRequest(request(), env);
    expect(current.status).toBe(200);
    expect(await current.json()).toMatchObject({ profiles: [
      { profile: "classic-v3", outcome: "current", generation: 1 },
      { profile: "game-v2", outcome: "current", generation: 1 },
    ] });
  });

  it("rejects a skipped generation-zero reconciliation", async () => {
    const calls: string[] = [];
    const fake = withReconcile(async (profile) => {
      calls.push(profile);
      return { profile, outcome: "current", generation: 0, revision: 0 };
    });
    expect((await handleDirectoryReconciliationRequest(request(), fake)).status).toBe(503);
    expect(calls).toEqual(DIRECTORY_PROFILES);
  });

  it("returns only a fixed failure when a builder throws", async () => {
    const fake = withReconcile(async () => { throw new Error("private-provider-detail"); });
    const response = await handleDirectoryReconciliationRequest(request(), fake);
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("Directory reconciliation unavailable");
  });

  it("does not accept publication while the purge is pending", async () => {
    vi.mocked(fetch).mockImplementation(async () => new Response("failed", { status: 503 }));
    expect((await handleDirectoryReconciliationRequest(request(), env)).status).toBe(503);
  });

  it("rejects stale successful builder results", async () => {
    const results = await seed();
    const checkpoint = await readDirectoryArtifactPublication(env.DB, "classic-v3");
    vi.mocked(Date.now).mockReturnValue(checkpoint.expiresAt * 1_000);
    const fake = withReconcile(async (profile) => results.get(profile)!);
    expect((await handleDirectoryReconciliationRequest(request(), fake)).status).toBe(503);
  });

  it("rejects a revision that advances during alias verification", async () => {
    const results = await seed();
    await env.DB.prepare("UPDATE directory_revisions SET revision = revision + 1 WHERE profile = ?")
      .bind("classic-v3").run();
    const fake = withReconcile(async (profile) => results.get(profile)!);
    expect((await handleDirectoryReconciliationRequest(request(), fake)).status).toBe(503);
  });

  it.each(["missing", "corrupt", "schema", "digest"] as const)(
    "rejects a %s alias even after successful reconciliation", async (fault) => {
      const results = await seed();
      const bucket = env.CLASSIC_DIRECTORY_PUBLIC;
      const key = fault === "schema" ? "manifest.json" : "index.json";
      const object = (await bucket.get(key))!;
      const body = await object.arrayBuffer();
      if (fault === "missing") await bucket.delete(key);
      else await bucket.put(key, fault === "corrupt" ? "corrupt" : body, {
        httpMetadata: object.httpMetadata,
        customMetadata: { ...object.customMetadata,
          ...(fault === "schema" ? { schema: "retired-schema" } : {}),
          ...(fault === "digest" ? { "model-sha256": ZERO_DIGEST } : {}),
        },
        sha256: fault === "corrupt" ? undefined : object.checksums.sha256,
      });
      const fake = withReconcile(async (profile) => results.get(profile)!);
      expect((await handleDirectoryReconciliationRequest(request(), fake)).status).toBe(503);
    },
  );

  it("cannot dispatch through the default, publisher or rendezvous fetch paths", async () => {
    const access = vi.fn(() => { throw new Error("Directory capability reached"); });
    const fake = { ...env, DIRECTORY_BUILDER: { getByName: access } } as unknown as CoreEnv;
    expect(worker).not.toHaveProperty("fetch");
    const edgeEnvironment = { ...env, COORDINATOR: { fetch: access } };
    for (const edge of [publisher, rendezvous]) {
      const response = await edge.fetch(new Request(
        `https://${env.RENDEZVOUS_HOSTNAME}/v1/directory-reconciliation`,
        { method: "POST" },
      ), edgeEnvironment as unknown as PublisherEnv & RendezvousEnv);
      expect(response.status).toBe(404);
    }
    expect((await handlePublisherCoordinatorRequest(request(), fake, createExecutionContext())).status)
      .toBeGreaterThanOrEqual(400);
    expect((await handleRendezvousCoordinatorRequest(request(), fake, createExecutionContext())).status)
      .toBeGreaterThanOrEqual(400);
    expect(access).not.toHaveBeenCalled();
  });
});

function request(suffix = "", headers?: HeadersInit): Request {
  return new Request(INTERNAL_DIRECTORY_RECONCILIATION_URL + suffix, { method: "POST", headers });
}

function withReconcile(reconcile: (profile: DirectoryProfile) => Promise<DirectoryBuildResult>): CoreEnv {
  return { ...env, DIRECTORY_BUILDER: {
    getByName: (profile: DirectoryProfile) => ({ reconcile: () => reconcile(profile) }),
  } } as unknown as CoreEnv;
}

async function seed(): Promise<Map<DirectoryProfile, DirectoryBuildResult>> {
  const results = new Map<DirectoryProfile, DirectoryBuildResult>();
  for (const profile of DIRECTORY_PROFILES) {
    results.set(profile, await env.DIRECTORY_BUILDER.getByName(profile).reconcile());
  }
  return results;
}
