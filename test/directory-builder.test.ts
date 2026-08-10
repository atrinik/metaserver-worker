import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  createScheduledController,
  runInDurableObject,
  runDurableObjectAlarm,
} from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  readDirectoryArtifactHistory,
  readDirectoryArtifactPublication,
} from "../src/directory-state";
import type { DirectoryBuilder } from "../src/directory-builder";
import worker from "../src/index";
import { persistRendezvousPublication } from "../src/rendezvous-publication";
import type { InternalRendezvousPublication } from "../src/rendezvous-contract";

const NOW = 2_000_000_000;
const EMPTY_EXPIRES_AT = Math.floor((NOW + 14_400) / 900) * 900;
const ZERO_DIGEST = "0".repeat(64);
const BUILDER_STATE_KEY = "directory-builder:state:v1";

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(NOW * 1_000);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM directory_artifact_history"),
    env.DB.prepare("DELETE FROM directory_artifact_commits"),
    env.DB.prepare("DELETE FROM directory_expiry_commits"),
    env.DB.prepare("DELETE FROM directory_entries"),
    env.DB.prepare("DELETE FROM server_presence"),
    env.DB.prepare("DELETE FROM directory_outbox"),
    env.DB.prepare("DELETE FROM publisher_nonces"),
    env.DB.prepare("DELETE FROM publisher_replay"),
    env.DB.prepare("DELETE FROM servers"),
    env.DB.prepare("DELETE FROM server_owners"),
    env.DB.prepare(
      "UPDATE directory_revisions SET revision = 0, updated_at = 0",
    ),
    env.DB.prepare(
      `UPDATE directory_artifact_publications
          SET published_revision = 0, generation = 0, generated_at = 0,
              expires_at = 0, model_sha256 = ?, html_sha256 = ?,
              xml_sha256 = ?, json_sha256 = ?, manifest_sha256 = ?,
              html_bytes = 0, xml_bytes = 0, json_bytes = 0,
              manifest_bytes = 0, published_at = 0`,
    ).bind(
      ZERO_DIGEST,
      ZERO_DIGEST,
      ZERO_DIGEST,
      ZERO_DIGEST,
      ZERO_DIGEST,
    ),
  ]);
  await Promise.all([
    clearBucket(env.DIRECTORY_GENERATIONS),
    clearBucket(env.CLASSIC_DIRECTORY_PUBLIC),
    clearBucket(env.GAME_DIRECTORY_PUBLIC),
    resetBuilder("classic-v1"),
    resetBuilder("game-v1"),
  ]);
});

describe("static directory builder", () => {
  it("reconciles both profiles from the private five-minute schedule", async () => {
    await worker.scheduled(
      createScheduledController({ cron: "*/5 * * * *" }),
      env,
      createExecutionContext(),
    );
    expect((await readDirectoryArtifactPublication(env.DB, "classic-v1"))
      .generation).toBe(1);
    expect((await readDirectoryArtifactPublication(env.DB, "game-v1"))
      .generation).toBe(1);
  });

  it("preseeds valid empty aliases for both isolated profiles", async () => {
    for (const profile of ["classic-v1", "game-v1"] as const) {
      const result = await env.DIRECTORY_BUILDER.getByName(profile).reconcile();
      expect(result).toEqual({
        profile,
        outcome: "published",
        generation: 1,
        revision: 0,
      });
      const bucket = profile === "classic-v1"
        ? env.CLASSIC_DIRECTORY_PUBLIC
        : env.GAME_DIRECTORY_PUBLIC;
      expect((await bucket.list()).objects.map((object) => object.key).sort())
        .toEqual(["index.html", "index.json", "index.xml", "manifest.json"]);
      for (const key of ["index.html", "index.json", "index.xml", "manifest.json"]) {
        const object = await bucket.get(key);
        expect(object?.customMetadata).toMatchObject({
          profile,
          generation: "1",
          "generated-at": String(NOW),
          "expires-at": String(EMPTY_EXPIRES_AT),
        });
        expect(object?.httpMetadata?.cacheControl).toBe(
          "public, must-revalidate, stale-if-error=0, no-transform",
        );
        expect(object?.httpMetadata?.cacheExpiry?.getTime()).toBe(
          EMPTY_EXPIRES_AT * 1_000,
        );
      }
      expect((await bucket.get("index.json"))?.text()).resolves.toContain(
        '"generation":"1"',
      );
    }
  });

  it("publishes one new generation for a visible change and none for a heartbeat", async () => {
    const stub = env.DIRECTORY_BUILDER.getByName("classic-v1");
    await stub.reconcile();
    const serverId = "1".repeat(64);
    const first = publication(serverId, NOW, "a".repeat(64));
    await persistRendezvousPublication(env.DB, first);

    await expect(stub.reconcile()).resolves.toMatchObject({
      outcome: "published",
      generation: 2,
      revision: 1,
    });
    const before = await aliasEtags(env.CLASSIC_DIRECTORY_PUBLIC);
    expect(await (await env.CLASSIC_DIRECTORY_PUBLIC.get("index.xml"))?.text())
      .toContain(`<Id>${serverId}</Id>`);
    const checkpoint = await readDirectoryArtifactPublication(
      env.DB,
      "classic-v1",
    );
    expect(checkpoint.expiresAt % 900).toBe(0);
    expect(checkpoint.expiresAt).not.toBe(first.now + 14_400);

    await expect(persistRendezvousPublication(env.DB, {
      ...first,
      commitToken: "b".repeat(64),
      generation: "c".repeat(64),
      expectedGeneration: first.generation,
      publisherSequence: "2",
      publisherNonce: "2".repeat(32),
      publisherNonceExpiresAt: NOW + 360,
      now: NOW + 60,
    })).resolves.toEqual({ accepted: true, visibleChanged: false });
    expect(await env.DB.prepare(
      `SELECT last_seen FROM server_presence
        WHERE profile = 'classic-v1' AND server_id = ?`,
    ).bind(serverId).first<number>("last_seen")).toBe(NOW + 60);
    vi.spyOn(Date, "now").mockReturnValue((NOW + 60) * 1_000);
    await expect(stub.reconcile()).resolves.toMatchObject({
      outcome: "current",
      generation: 2,
      revision: 1,
    });
    expect(await aliasEtags(env.CLASSIC_DIRECTORY_PUBLIC)).toEqual(before);
  });

  it("removes exact-cutoff presence and publishes the resulting empty revision", async () => {
    const stub = env.DIRECTORY_BUILDER.getByName("classic-v1");
    await stub.reconcile();
    const serverId = "2".repeat(64);
    await persistRendezvousPublication(
      env.DB,
      publication(serverId, NOW - 14_400, "d".repeat(64)),
    );

    await expect(stub.reconcile()).resolves.toMatchObject({
      outcome: "published",
      revision: 2,
    });
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM directory_entries",
    ).first<number>("count")).toBe(0);
    expect(await (await env.CLASSIC_DIRECTORY_PUBLIC.get("index.xml"))?.text())
      .not.toContain("<Server>");
  });

  it("repairs a deleted alias only under a strictly newer generation", async () => {
    const stub = env.DIRECTORY_BUILDER.getByName("classic-v1");
    await stub.reconcile();
    await env.CLASSIC_DIRECTORY_PUBLIC.delete("index.html");

    await expect(stub.reconcile()).resolves.toMatchObject({
      outcome: "published",
      generation: 2,
      revision: 0,
    });
    for (const key of ["index.html", "index.json", "index.xml", "manifest.json"]) {
      expect((await env.CLASSIC_DIRECTORY_PUBLIC.head(key))?.customMetadata)
        .toMatchObject({ generation: "2" });
    }
  });

  it("allocates above every observed alias after durable builder-state loss", async () => {
    const bucket = env.CLASSIC_DIRECTORY_PUBLIC;
    await bucket.put("index.html", "orphan", {
      httpMetadata: { contentType: "text/html; charset=utf-8" },
      customMetadata: { generation: "7" },
    });

    await expect(env.DIRECTORY_BUILDER.getByName("classic-v1").reconcile())
      .resolves.toMatchObject({ outcome: "published", generation: 8 });
    expect((await bucket.head("manifest.json"))?.customMetadata)
      .toMatchObject({ generation: "8" });
  });

  it("allocates above a private-only partial generation after state loss", async () => {
    await env.DIRECTORY_GENERATIONS.put(
      "v1/classic-v1/1/index.html",
      "private partial",
    );

    await expect(env.DIRECTORY_BUILDER.getByName("classic-v1").reconcile())
      .resolves.toMatchObject({ outcome: "published", generation: 2 });
    expect((await env.CLASSIC_DIRECTORY_PUBLIC.head("manifest.json"))
      ?.customMetadata).toMatchObject({ generation: "2" });
  });

  it("repairs an alias with invalid generation metadata under R2 compare-and-swap", async () => {
    await env.CLASSIC_DIRECTORY_PUBLIC.put("index.html", "corrupt", {
      customMetadata: { generation: "not-a-generation" },
    });
    await expect(env.DIRECTORY_BUILDER.getByName("classic-v1").reconcile())
      .resolves.toMatchObject({ outcome: "published", generation: 1 });
    expect((await env.CLASSIC_DIRECTORY_PUBLIC.head("index.html"))
      ?.customMetadata).toMatchObject({ generation: "1" });
  });

  it("repairs a body/checksum mismatch only under a newer generation", async () => {
    const stub = env.DIRECTORY_BUILDER.getByName("classic-v1");
    await stub.reconcile();
    const original = await env.CLASSIC_DIRECTORY_PUBLIC.head("index.json");
    expect(original).not.toBeNull();
    await env.CLASSIC_DIRECTORY_PUBLIC.put("index.json", "tampered\n", {
      httpMetadata: original?.httpMetadata,
      customMetadata: original?.customMetadata,
    });

    await expect(stub.reconcile()).resolves.toMatchObject({
      outcome: "published",
      generation: 2,
    });
    expect((await env.CLASSIC_DIRECTORY_PUBLIC.head("index.json"))
      ?.customMetadata).toMatchObject({ generation: "2" });
  });

  it("retries a transient immutable write without consuming its generation", async () => {
    const stub = env.DIRECTORY_BUILDER.getByName("classic-v1");
    const originalPut = env.DIRECTORY_GENERATIONS.put.bind(
      env.DIRECTORY_GENERATIONS,
    );
    const put = vi.spyOn(env.DIRECTORY_GENERATIONS, "put");
    put.mockRejectedValueOnce(new Error("Injected transient immutable failure"));
    await expect(reconcileWithoutPlatformAlarm(stub)).rejects.toThrow(
      "Injected transient immutable failure",
    );
    expect((await readDirectoryArtifactPublication(env.DB, "classic-v1"))
      .generation).toBe(0);

    put.mockImplementation(originalPut);
    await expect(stub.reconcile()).resolves.toMatchObject({
      outcome: "published",
      generation: 1,
    });
  });

  it("retries a transient immutable readback without consuming its generation", async () => {
    const stub = env.DIRECTORY_BUILDER.getByName("classic-v1");
    const bucket = env.DIRECTORY_GENERATIONS;
    const originalGet = bucket.get.bind(bucket);
    vi.spyOn(bucket, "get")
      .mockRejectedValueOnce(new Error("Injected immutable readback failure"))
      .mockImplementation(originalGet);

    await expect(reconcileWithoutPlatformAlarm(stub)).rejects.toThrow(
      "Injected immutable readback failure",
    );
    await expect(stub.reconcile()).resolves.toMatchObject({
      outcome: "published",
      generation: 1,
    });
  });

  it("recovers a partial alias write without acknowledging it", async () => {
    const stub = env.DIRECTORY_BUILDER.getByName("classic-v1");
    const bucket = env.CLASSIC_DIRECTORY_PUBLIC;
    const originalPut = bucket.put.bind(bucket);
    const put = vi.spyOn(bucket, "put").mockImplementation(async (
      key,
      value,
      options,
    ) => {
      if (key === "index.json") {
        throw new Error("Injected alias failure");
      }
      return originalPut(key, value, options);
    });
    await expect(reconcileWithoutPlatformAlarm(stub)).rejects.toThrow(
      "Injected alias failure",
    );
    expect((await bucket.head("index.html"))?.customMetadata)
      .toMatchObject({ generation: "1" });
    expect(await bucket.head("manifest.json")).toBeNull();
    expect((await readDirectoryArtifactPublication(env.DB, "classic-v1"))
      .generation).toBe(0);

    put.mockImplementation(originalPut);
    await expect(stub.reconcile()).resolves.toMatchObject({
      outcome: "published",
      generation: 1,
    });
    expect((await bucket.head("manifest.json"))?.customMetadata)
      .toMatchObject({ generation: "1" });
  });

  it("abandons a corrupt same-generation partial alias", async () => {
    const stub = env.DIRECTORY_BUILDER.getByName("classic-v1");
    const bucket = env.CLASSIC_DIRECTORY_PUBLIC;
    const originalPut = bucket.put.bind(bucket);
    const put = vi.spyOn(bucket, "put").mockImplementation(async (
      key,
      value,
      options,
    ) => {
      if (key === "index.json") {
        throw new Error("Injected partial alias failure");
      }
      return originalPut(key, value, options);
    });
    await expect(reconcileWithoutPlatformAlarm(stub)).rejects.toThrow(
      "Injected partial alias failure",
    );
    put.mockImplementation(originalPut);
    const head = await bucket.head("index.html");
    expect(head?.customMetadata).toMatchObject({ generation: "1" });
    await bucket.put("index.html", "corrupt same generation", {
      httpMetadata: head?.httpMetadata,
      customMetadata: head?.customMetadata,
    });

    await expect(stub.reconcile()).resolves.toMatchObject({
      outcome: "published",
      generation: 2,
    });
    expect((await bucket.head("manifest.json"))?.customMetadata)
      .toMatchObject({ generation: "2" });
  });

  it("retains only the current eight immutable rollback generations", async () => {
    const stub = env.DIRECTORY_BUILDER.getByName("classic-v1");
    await stub.reconcile();
    for (let generation = 2; generation <= 10; generation += 1) {
      await env.CLASSIC_DIRECTORY_PUBLIC.delete("index.html");
      await expect(stub.reconcile()).resolves.toMatchObject({ generation });
    }
    const objects = await env.DIRECTORY_GENERATIONS.list({
      prefix: "v1/classic-v1/",
    });
    expect(new Set(objects.objects.map((object) =>
      Number(object.key.split("/")[2])
    ))).toEqual(new Set([3, 4, 5, 6, 7, 8, 9, 10]));
    expect(objects.objects).toHaveLength(32);
    expect(await readDirectoryArtifactHistory(env.DB, "classic-v1"))
      .toEqual([3, 4, 5, 6, 7, 8, 9, 10]);

    // Simulate lost/restored DO state. D1 remains the authoritative rollback
    // ledger, so cleanup must reconstruct all eight acknowledged cohorts.
    await resetBuilder("classic-v1");

    await env.DIRECTORY_GENERATIONS.put(
      "v1/classic-v1/11/index.html",
      "abandoned partial",
    );
    await expect(stub.reconcile()).resolves.toMatchObject({ outcome: "current" });
    expect(await env.DIRECTORY_GENERATIONS.head(
      "v1/classic-v1/11/index.html",
    )).toBeNull();

    for (let generation = 11; generation <= 18; generation += 1) {
      for (const filename of [
        "index.html",
        "index.json",
        "index.xml",
        "manifest.json",
      ]) {
        await env.DIRECTORY_GENERATIONS.put(
          `v1/classic-v1/${generation}/${filename}`,
          "superseded but complete",
        );
      }
    }
    await expect(stub.reconcile()).resolves.toMatchObject({ outcome: "current" });
    const retained = await env.DIRECTORY_GENERATIONS.list({
      prefix: "v1/classic-v1/",
    });
    expect(new Set(retained.objects.map((object) =>
      Number(object.key.split("/")[2])
    ))).toEqual(new Set([3, 4, 5, 6, 7, 8, 9, 10]));
  });

  it("makes bounded retention progress across delete and page ceilings", async () => {
    const stub = env.DIRECTORY_BUILDER.getByName("classic-v1");
    await stub.reconcile();
    for (let generation = 100; generation < 165; generation += 1) {
      await env.DIRECTORY_GENERATIONS.put(
        `v1/classic-v1/${generation}/index.html`,
        "obsolete partial",
      );
    }

    await expect(stub.reconcile()).resolves.toMatchObject({ outcome: "current" });
    expect((await env.DIRECTORY_GENERATIONS.list({
      prefix: "v1/classic-v1/1",
    })).objects.filter((object) => object.key.includes("/index.html")))
      .toHaveLength(2);
    await expect(stub.reconcile()).resolves.toMatchObject({ outcome: "current" });
    expect((await env.DIRECTORY_GENERATIONS.list({
      prefix: "v1/classic-v1/1",
    })).objects.filter((object) => object.key.includes("/index.html")))
      .toHaveLength(1);

    const bucket = env.DIRECTORY_GENERATIONS;
    const originalList = bucket.list.bind(bucket);
    let pages = 0;
    vi.spyOn(bucket, "list").mockImplementation(async (options) => {
      if (options?.prefix !== "v1/classic-v1/") {
        return originalList(options);
      }
      const expectedCursor = pages === 0 ? undefined : `page-${pages}`;
      expect(options.cursor).toBe(expectedCursor);
      pages += 1;
      const truncated = pages <= 8;
      return truncated
        ? {
          objects: [],
          delimitedPrefixes: [],
          truncated: true,
          cursor: `page-${pages}`,
        }
        : {
          objects: [],
          delimitedPrefixes: [],
          truncated: false,
        };
    });
    for (let page = 0; page < 9; page += 1) {
      await expect(stub.reconcile()).resolves.toMatchObject({ outcome: "current" });
    }
    expect(pages).toBe(9);
  });

  it("recovers retention after bounded R2 list and delete failures", async () => {
    const stub = env.DIRECTORY_BUILDER.getByName("classic-v1");
    await stub.reconcile();
    await env.DIRECTORY_GENERATIONS.put(
      "v1/classic-v1/9/index.html",
      "obsolete partial",
    );
    const bucket = env.DIRECTORY_GENERATIONS;
    const originalList = bucket.list.bind(bucket);
    vi.spyOn(bucket, "list")
      .mockRejectedValueOnce(new Error("Injected list failure"))
      .mockImplementation(originalList);
    await expect(stub.reconcile()).resolves.toMatchObject({ outcome: "current" });
    expect(await bucket.head("v1/classic-v1/9/index.html")).not.toBeNull();

    const originalDelete = bucket.delete.bind(bucket);
    vi.spyOn(bucket, "delete")
      .mockRejectedValueOnce(new Error("Injected delete failure"))
      .mockImplementation(originalDelete);
    await expect(stub.reconcile()).resolves.toMatchObject({ outcome: "current" });
    expect(await bucket.head("v1/classic-v1/9/index.html")).not.toBeNull();
    await expect(stub.reconcile()).resolves.toMatchObject({ outcome: "current" });
    expect(await bucket.head("v1/classic-v1/9/index.html")).toBeNull();
  });

  it("publishes endpoint withdrawal and private removal as isolated generations", async () => {
    const stub = env.DIRECTORY_BUILDER.getByName("classic-v1");
    await stub.reconcile();
    const serverId = "4".repeat(64);
    const first = {
      ...publication(serverId, NOW, "4".repeat(64)),
      quicHost: "play.example.test",
      quicPort: 1730,
    };
    await persistRendezvousPublication(env.DB, first);
    await expect(stub.reconcile()).resolves.toMatchObject({
      outcome: "published",
      generation: 2,
      revision: 1,
    });
    expect(await (await env.CLASSIC_DIRECTORY_PUBLIC.get("index.xml"))?.text())
      .toContain("<Address>play.example.test</Address>");

    await expect(persistRendezvousPublication(env.DB, {
      ...first,
      commitToken: "5".repeat(64),
      generation: "5".repeat(64),
      expectedGeneration: first.generation,
      publisherSequence: "2",
      publisherNonce: "2".repeat(32),
      publisherNonceExpiresAt: NOW + 360,
      quicHost: "",
      quicPort: 1,
      directoryFingerprint: "8".repeat(64),
      now: NOW + 60,
    })).resolves.toEqual({ accepted: true, visibleChanged: true });
    vi.spyOn(Date, "now").mockReturnValue((NOW + 60) * 1_000);
    await expect(stub.reconcile()).resolves.toMatchObject({
      outcome: "published",
      generation: 3,
      revision: 2,
    });
    const addressless = await (await env.CLASSIC_DIRECTORY_PUBLIC.get(
      "index.xml",
    ))?.text();
    expect(addressless).toContain(`<Id>${serverId}</Id>`);
    expect(addressless).not.toContain("<Address>");

    await expect(persistRendezvousPublication(env.DB, {
      ...first,
      commitToken: "6".repeat(64),
      generation: "6".repeat(64),
      expectedGeneration: "5".repeat(64),
      publisherSequence: "3",
      publisherNonce: "3".repeat(32),
      publisherNonceExpiresAt: NOW + 420,
      isPublic: false,
      quicHost: "",
      quicPort: 1,
      directoryFingerprint: "7".repeat(64),
      now: NOW + 120,
    })).resolves.toEqual({ accepted: true, visibleChanged: true });
    vi.spyOn(Date, "now").mockReturnValue((NOW + 120) * 1_000);
    await expect(stub.reconcile()).resolves.toMatchObject({
      outcome: "published",
      generation: 4,
      revision: 3,
    });
    expect(await (await env.CLASSIC_DIRECTORY_PUBLIC.get("index.xml"))?.text())
      .not.toContain("<Server>");
  });

  it("coalesces a visible revision that advances during alias publication", async () => {
    const stub = env.DIRECTORY_BUILDER.getByName("classic-v1");
    await stub.reconcile();
    const serverId = "7".repeat(64);
    const first = publication(serverId, NOW, "7".repeat(64));
    await persistRendezvousPublication(env.DB, first);

    const bucket = env.CLASSIC_DIRECTORY_PUBLIC;
    const originalPut = bucket.put.bind(bucket);
    let advanced = false;
    vi.spyOn(bucket, "put").mockImplementation(async (key, value, options) => {
      const result = await originalPut(key, value, options);
      if (key === "index.html" && !advanced) {
        advanced = true;
        await persistRendezvousPublication(env.DB, {
          ...first,
          commitToken: "8".repeat(64),
          generation: "8".repeat(64),
          expectedGeneration: first.generation,
          publisherSequence: "2",
          publisherNonce: "2".repeat(32),
          publisherNonceExpiresAt: NOW + 360,
          isPublic: false,
          directoryFingerprint: "8".repeat(64),
          now: NOW + 60,
        });
      }
      return result;
    });

    await expect(stub.reconcile()).resolves.toMatchObject({
      outcome: "published",
      generation: 3,
      revision: 2,
    });
    expect(advanced).toBe(true);
    expect(await (await bucket.get("index.xml"))?.text())
      .not.toContain("<Server>");
    expect((await readDirectoryArtifactPublication(env.DB, "classic-v1")))
      .toMatchObject({ generation: 3, publishedRevision: 2 });
    expect(await env.DB.prepare(
      "SELECT revision FROM directory_outbox WHERE profile = 'classic-v1'",
    ).first<number>("revision")).toBeNull();
  });

  it("retries an ambiguous checkpoint without changing the reserved generation", async () => {
    const stub = env.DIRECTORY_BUILDER.getByName("classic-v1");
    await env.DB.prepare(
      `CREATE TRIGGER directory_artifact_test_ignore_checkpoint
       BEFORE UPDATE ON directory_artifact_publications
       WHEN NEW.profile = 'classic-v1'
       BEGIN SELECT RAISE(IGNORE); END`,
    ).run();
    await expect(reconcileWithoutPlatformAlarm(stub)).rejects.toThrow();
    expect((await env.CLASSIC_DIRECTORY_PUBLIC.head("manifest.json"))
      ?.customMetadata).toMatchObject({ generation: "1" });
    expect((await readDirectoryArtifactPublication(env.DB, "classic-v1"))
      .generation).toBe(0);

    await env.DB.prepare(
      "DROP TRIGGER directory_artifact_test_ignore_checkpoint",
    ).run();
    vi.spyOn(Date, "now").mockReturnValue((NOW + 5) * 1_000);
    await expect(stub.reconcile()).resolves.toMatchObject({
      outcome: "published",
      generation: 1,
    });
    expect((await readDirectoryArtifactPublication(env.DB, "classic-v1"))
      .generation).toBe(1);
  });

  it("abandons an immutable collision and recovers under a later generation", async () => {
    const stub = env.DIRECTORY_BUILDER.getByName("classic-v1");
    await stub.reconcile();
    await env.CLASSIC_DIRECTORY_PUBLIC.delete("index.html");
    await env.DB.prepare(
      `CREATE TRIGGER directory_artifact_test_ignore_collision_checkpoint
       BEFORE UPDATE ON directory_artifact_publications
       WHEN NEW.profile = 'classic-v1'
       BEGIN SELECT RAISE(IGNORE); END`,
    ).run();
    await expect(reconcileWithoutPlatformAlarm(stub)).rejects.toThrow();
    await env.DIRECTORY_GENERATIONS.put(
      "v1/classic-v1/2/index.html",
      "tampered immutable",
    );
    await env.DB.prepare(
      "DROP TRIGGER directory_artifact_test_ignore_collision_checkpoint",
    ).run();

    await expect(stub.reconcile()).resolves.toMatchObject({
      outcome: "published",
      generation: 3,
    });
    expect((await env.CLASSIC_DIRECTORY_PUBLIC.head("manifest.json"))
      ?.customMetadata).toMatchObject({ generation: "3" });
  });

  it("coalesces many publication nudges into one persistent alarm", async () => {
    const stub = env.DIRECTORY_BUILDER.getByName("classic-v1");
    await Promise.all(Array.from({ length: 100 }, () => stub.nudge()));

    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
    expect((await env.CLASSIC_DIRECTORY_PUBLIC.list()).objects).toEqual([]);
    expect((await env.DIRECTORY_GENERATIONS.list()).objects).toEqual([]);
  });

  it("executes a coalesced nudge through the durable alarm", async () => {
    const stub = env.DIRECTORY_BUILDER.getByName("classic-v1");
    await Promise.all(Array.from({ length: 100 }, () => stub.nudge()));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await readDirectoryArtifactPublication(env.DB, "classic-v1")))
      .toMatchObject({ generation: 1, publishedRevision: 0 });
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBeGreaterThan(NOW * 1_000);
    });
  });

  it("abandons a surviving stale pending build below a partial public generation", async () => {
    const stub = env.DIRECTORY_BUILDER.getByName("classic-v1");
    await env.DB.prepare(
      `CREATE TRIGGER directory_artifact_test_ignore_stale_checkpoint
       BEFORE UPDATE ON directory_artifact_publications
       WHEN NEW.profile = 'classic-v1'
       BEGIN SELECT RAISE(IGNORE); END`,
    ).run();
    await expect(reconcileWithoutPlatformAlarm(stub)).rejects.toThrow();
    await env.CLASSIC_DIRECTORY_PUBLIC.put("index.html", "partial-newer", {
      customMetadata: { generation: "7" },
    });
    await env.DB.prepare(
      "DROP TRIGGER directory_artifact_test_ignore_stale_checkpoint",
    ).run();

    await expect(stub.reconcile()).resolves.toMatchObject({
      outcome: "published",
      generation: 8,
      revision: 0,
    });
    for (const key of ["index.html", "index.json", "index.xml", "manifest.json"]) {
      expect((await env.CLASSIC_DIRECTORY_PUBLIC.head(key))?.customMetadata)
        .toMatchObject({ generation: "8" });
    }
  });

  it("projects the exact bounded game model from authoritative state", async () => {
    const serverId = "3".repeat(64);
    await persistRendezvousPublication(
      env.DB,
      gamePublication(serverId, NOW, "e".repeat(64)),
    );
    await expect(reconcileWithoutPlatformAlarm(
      env.DIRECTORY_BUILDER.getByName("game-v1"),
    )).resolves.toMatchObject({ outcome: "published", revision: 1 });
    const parsed = JSON.parse(
      await (await env.GAME_DIRECTORY_PUBLIC.get("index.json"))!.text(),
    ) as { readonly servers: readonly unknown[] };
    expect(parsed.servers).toEqual([{
      serverId,
      certificateSha256: serverId,
      name: "Game directory builder test",
      description: "Static Game Protocol 1 listing",
      region: "eu-west",
      protocol: { major: 1, minor: 0 },
      content: { id: "atrinik-main", revisionSha256: "7".repeat(64) },
      players: { online: 3, capacity: 64 },
      status: "online",
      passwordRequired: false,
      endpoint: { hostname: "play.example.org", port: 13_327 },
    }]);
    expect((await readDirectoryArtifactPublication(env.DB, "game-v1"))
      .generation).toBe(1);
  });
});

async function clearBucket(bucket: R2Bucket): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ ...(cursor === undefined ? {} : { cursor }) });
    if (page.objects.length > 0) {
      await bucket.delete(page.objects.map((object) => object.key));
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
}

async function resetBuilder(profile: "classic-v1" | "game-v1"): Promise<void> {
  const stub = env.DIRECTORY_BUILDER.getByName(profile);
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.deleteAll();
    await state.storage.put(BUILDER_STATE_KEY, {
      version: 1,
      highWaterGeneration: 0,
      pending: null,
      cleanupCursor: null,
    });
  });
}

async function reconcileWithoutPlatformAlarm(
  stub: DurableObjectStub<import("../src/directory-builder").DirectoryBuilder>,
): Promise<unknown> {
  return runInDurableObject(stub, async (instance, state) => {
    try {
      return await (instance as DirectoryBuilder).reconcile();
    } finally {
      await state.storage.deleteAlarm();
    }
  });
}

async function aliasEtags(bucket: R2Bucket): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const key of ["index.html", "index.json", "index.xml", "manifest.json"]) {
    const head = await bucket.head(key);
    if (head === null) {
      throw new Error("Expected directory alias is missing");
    }
    result[key] = head.etag;
  }
  return result;
}

function publication(
  serverId: string,
  now: number,
  commitToken: string,
): InternalRendezvousPublication {
  return {
    serverId,
    directoryProfile: "classic-v1",
    publisherAuthentication: "signed-certificate-v1",
    publisherSequence: "1",
    publisherNonce: "1".repeat(32),
    publisherNonceExpiresAt: now + 300,
    commitToken,
    expectedGeneration: null,
    generation: "f".repeat(64),
    tokenHash: "a".repeat(64),
    now,
    visibilityCutoff: now - 14_400,
    name: "Directory builder test",
    playersCount: 3,
    version: "5.0.0",
    textComment: "Static",
    isPublic: true,
    quicHost: "",
    quicPort: 1,
    quicCertSha256: serverId,
    passwordRequired: false,
    directoryFingerprint: "9".repeat(64),
  };
}

function gamePublication(
  serverId: string,
  now: number,
  commitToken: string,
): InternalRendezvousPublication {
  return {
    serverId,
    directoryProfile: "game-v1",
    publisherAuthentication: "signed-certificate-v1",
    publisherSequence: "1",
    publisherNonce: "2".repeat(32),
    publisherNonceExpiresAt: now + 300,
    commitToken,
    expectedGeneration: null,
    generation: "e".repeat(64),
    tokenHash: "b".repeat(64),
    now,
    visibilityCutoff: now - 14_400,
    name: "Game directory builder test",
    description: "Static Game Protocol 1 listing",
    region: "eu-west",
    protocolMajor: 1,
    protocolMinor: 0,
    contentId: "atrinik-main",
    contentRevisionSha256: "7".repeat(64),
    playersOnline: 3,
    playersCapacity: 64,
    status: "online",
    isPublic: true,
    quicHost: "play.example.org",
    quicPort: 13_327,
    quicCertSha256: serverId,
    passwordRequired: false,
    directoryFingerprint: "8".repeat(64),
  };
}
