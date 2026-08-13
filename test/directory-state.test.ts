import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import {
  commitDirectoryArtifactPublication,
  DIRECTORY_PROFILES,
  expireDirectoryEntries,
  readDirectoryArtifactHistory,
  readDirectoryArtifactPublication,
} from "../src/directory-state";
import { MAX_GAME_DIRECTORY_JSON_SERVER_SET_BYTES } from "../src/directory-artifacts";
import { persistRendezvousPublication } from "../src/rendezvous-publication";
import type { InternalRendezvousPublication } from "../src/rendezvous-contract";

const CUTOFF = 200;
const NOW = 300;

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM directory_artifact_history"),
    env.DB.prepare("DELETE FROM directory_artifact_commits"),
    env.DB.prepare("DELETE FROM directory_expiry_commits"),
    env.DB.prepare("DELETE FROM directory_transaction_assertions"),
    env.DB.prepare("DELETE FROM directory_entries"),
    env.DB.prepare("DELETE FROM server_presence"),
    env.DB.prepare("DELETE FROM directory_outbox"),
    env.DB.prepare("DELETE FROM publisher_nonces"),
    env.DB.prepare("DELETE FROM publisher_replay"),
    env.DB.prepare(
      "UPDATE directory_revisions SET revision = 0, updated_at = 0",
    ),
    env.DB.prepare(
      `UPDATE directory_artifact_publications
          SET published_revision = 0, generation = 0, generated_at = 0,
              expires_at = 0,
              model_sha256 = '${"0".repeat(64)}',
              html_sha256 = '${"0".repeat(64)}',
              xml_sha256 = '${"0".repeat(64)}',
              json_sha256 = '${"0".repeat(64)}',
              manifest_sha256 = '${"0".repeat(64)}',
              html_bytes = 0, xml_bytes = 0, json_bytes = 0,
              manifest_bytes = 0, published_at = 0`,
    ),
  ]);
});

describe("profile-scoped directory expiry", () => {
  it("advances one revision per changed profile and deletes only expired rows", async () => {
    await seedPublic("1".repeat(64), "classic-v1", CUTOFF - 1);
    await seedPublic("2".repeat(64), "classic-v1", CUTOFF);
    await seedPublic("3".repeat(64), "game-v1", CUTOFF - 2);
    await seedPrivate("6".repeat(64), "classic-v1", CUTOFF - 3);
    await seedPrivate("7".repeat(64), "classic-v1", CUTOFF);
    await seedPrivate("8".repeat(64), "game-v1", CUTOFF - 4);

    const results = [];
    for (const profile of DIRECTORY_PROFILES) {
      results.push(await expireDirectoryEntries(env.DB, profile, CUTOFF, NOW));
    }
    expect(results).toEqual([
      { expiredEntries: 2, visibleChanged: true },
      { expiredEntries: 1, visibleChanged: true },
    ]);
    expect(await env.DB.prepare(
      `SELECT profile, server_id, last_seen
         FROM server_presence ORDER BY profile, server_id`,
    ).all()).toMatchObject({ results: [] });
    expect(await env.DB.prepare(
      `SELECT profile, revision, updated_at
         FROM directory_revisions ORDER BY profile`,
    ).all()).toMatchObject({
      results: [
        { profile: "classic-v1", revision: 1, updated_at: NOW },
        { profile: "game-v1", revision: 1, updated_at: NOW },
      ],
    });
    expect(await env.DB.prepare(
      `SELECT profile, revision, created_at
         FROM directory_outbox ORDER BY profile, revision`,
    ).all()).toMatchObject({
      results: [
        { profile: "classic-v1", revision: 1, created_at: NOW },
        { profile: "game-v1", revision: 1, created_at: NOW },
      ],
    });
  });

  it("is revision-neutral after the expired set is gone", async () => {
    await seedPublic("4".repeat(64), "classic-v1", CUTOFF - 1);
    expect(await expireDirectoryEntries(
      env.DB,
      "classic-v1",
      CUTOFF,
      NOW,
    )).toEqual({ expiredEntries: 1, visibleChanged: true });
    expect(await expireDirectoryEntries(
      env.DB,
      "classic-v1",
      CUTOFF,
      NOW + 1,
    )).toEqual({ expiredEntries: 0, visibleChanged: false });
    expect(await env.DB.prepare(
      "SELECT revision FROM directory_revisions WHERE profile = 'classic-v1'",
    ).first<number>("revision")).toBe(1);
  });

  it("never moves a visible revision timestamp backward", async () => {
    await seedPublic("b".repeat(64), "classic-v1", CUTOFF - 1);
    await env.DB.prepare(
      `UPDATE directory_revisions SET updated_at = 500
        WHERE profile = 'classic-v1'`,
    ).run();
    await expect(expireDirectoryEntries(
      env.DB,
      "classic-v1",
      CUTOFF,
      NOW,
    )).resolves.toEqual({ expiredEntries: 1, visibleChanged: true });
    expect(await env.DB.prepare(
      `SELECT revision, updated_at FROM directory_revisions
        WHERE profile = 'classic-v1'`,
    ).first()).toEqual({ revision: 1, updated_at: 500 });
  });

  it("rolls back expiry when its required outbox write is ignored", async () => {
    await seedPublic("a".repeat(64), "classic-v1", CUTOFF - 1);
    const before = await snapshotDirectoryState();
    await env.DB.prepare(
      `CREATE TRIGGER directory_outbox_test_ignore_expiry
       BEFORE INSERT ON directory_outbox
       WHEN NEW.profile = 'classic-v1'
       BEGIN
         SELECT RAISE(IGNORE);
       END`,
    ).run();
    await expect(expireDirectoryEntries(
      env.DB,
      "classic-v1",
      CUTOFF,
      NOW,
    )).rejects.toThrow();
    await env.DB.prepare("DROP TRIGGER directory_outbox_test_ignore_expiry").run();
    expect(await snapshotDirectoryState()).toEqual(before);

    await expect(expireDirectoryEntries(
      env.DB,
      "classic-v1",
      CUTOFF,
      NOW,
    )).resolves.toEqual({ expiredEntries: 1, visibleChanged: true });
  });

  it("rolls back expiry when outbox coalescing is ignored", async () => {
    await seedPublic("8".repeat(64), "classic-v1", CUTOFF - 1);
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE directory_revisions SET revision = 1, updated_at = 1
          WHERE profile = 'classic-v1'`,
      ),
      env.DB.prepare(
        `INSERT INTO directory_outbox (profile, revision, created_at)
         VALUES ('classic-v1', 1, 1)`,
      ),
      env.DB.prepare(
        `CREATE TRIGGER directory_outbox_test_ignore_expiry_coalesce
         BEFORE DELETE ON directory_outbox
         WHEN OLD.profile = 'classic-v1' AND OLD.revision = 1
         BEGIN SELECT RAISE(IGNORE); END`,
      ),
    ]);
    const before = await snapshotDirectoryState();
    await expect(expireDirectoryEntries(
      env.DB,
      "classic-v1",
      CUTOFF,
      NOW,
    )).rejects.toThrow();
    await env.DB.prepare(
      "DROP TRIGGER directory_outbox_test_ignore_expiry_coalesce",
    ).run();
    expect(await snapshotDirectoryState()).toEqual(before);
  });

  it("expires private presence without a visible revision or outbox row", async () => {
    const serverId = "9".repeat(64);
    await seedPrivate(serverId, "classic-v1", CUTOFF - 1);

    await expect(expireDirectoryEntries(
      env.DB,
      "classic-v1",
      CUTOFF,
      NOW,
    )).resolves.toEqual({ expiredEntries: 0, visibleChanged: false });
    expect(await env.DB.prepare(
      `SELECT COUNT(*) AS count
         FROM server_presence
        WHERE profile = 'classic-v1' AND server_id = ?`,
    ).bind(serverId).first<number>("count")).toBe(0);
    expect(await env.DB.prepare(
      `SELECT revision, updated_at
         FROM directory_revisions
        WHERE profile = 'classic-v1'`,
    ).first()).toEqual({ revision: 0, updated_at: 0 });
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM directory_outbox",
    ).first<number>("count")).toBe(0);
  });

  it("validates time bounds before D1 work", async () => {
    for (const [cutoff, now] of [
      [-1, NOW],
      [CUTOFF, -1],
      [NOW + 1, NOW],
      [1.5, NOW],
      [CUTOFF, Number.MAX_SAFE_INTEGER + 1],
    ] as const) {
      await expect(expireDirectoryEntries(
        env.DB,
        "classic-v1",
        cutoff,
        now,
      )).rejects.toBeInstanceOf(RangeError);
    }
  });

  it("keeps the same certificate identity isolated across profiles", async () => {
    const serverId = "5".repeat(64);
    const classic = publication(serverId, "classic-v1", "Classic", "1");
    const game = publication(serverId, "game-v1", "Game", "2");

    await expect(persistRendezvousPublication(env.DB, classic)).resolves.toEqual({
      accepted: true,
      visibleChanged: true,
    });
    await expect(persistRendezvousPublication(env.DB, game)).resolves.toEqual({
      accepted: true,
      visibleChanged: true,
    });

    expect(await env.DB.prepare(
      `SELECT profile, rendezvous_generation
         FROM server_presence ORDER BY profile`,
    ).all()).toMatchObject({
      results: [
        { profile: "classic-v1", rendezvous_generation: classic.generation },
        { profile: "game-v1", rendezvous_generation: game.generation },
      ],
    });
    expect(await env.DB.prepare(
      `SELECT profile, name FROM directory_entries ORDER BY profile`,
    ).all()).toMatchObject({
      results: [
        { profile: "classic-v1", name: "Classic" },
        { profile: "game-v1", name: "Game" },
      ],
    });
    expect(await env.DB.prepare(
      `SELECT profile, revision FROM directory_revisions ORDER BY profile`,
    ).all()).toMatchObject({
      results: [
        { profile: "classic-v1", revision: 1 },
        { profile: "game-v1", revision: 1 },
      ],
    });
  });

  it("rolls back every Game publication mutation at the JSON aggregate ceiling", async () => {
    const existingId = "6".repeat(64);
    await seedPublic(existingId, "game-v1", NOW);
    await env.DB.prepare(
      `UPDATE directory_entries SET game_json_bytes = ?
        WHERE profile = 'game-v1' AND server_id = ?`,
    ).bind(MAX_GAME_DIRECTORY_JSON_SERVER_SET_BYTES, existingId).run();
    const before = await snapshotDirectoryState();

    await expect(persistRendezvousPublication(
      env.DB,
      publication("7".repeat(64), "game-v1", "Blocked Game", "8"),
    )).rejects.toThrow();

    expect(await snapshotDirectoryState()).toEqual(before);
  });

  it("persists and renders only an explicitly signed DNS fallback", async () => {
    const serverId = "f".repeat(64);
    const explicit = {
      ...publication(serverId, "classic-v1", "Explicit host", "6"),
      quicHost: "play.example.net",
      quicPort: 1730,
    };
    await persistRendezvousPublication(env.DB, explicit);
    expect(await env.DB.prepare(
      `SELECT hostname, port FROM directory_entries
        WHERE profile = 'classic-v1' AND server_id = ?`,
    ).bind(serverId).first()).toEqual({
      hostname: "play.example.net",
      port: 1730,
    });
  });

  it("persists a canonical IDNA A-label fallback", async () => {
    const serverId = "9".repeat(64);
    const explicit = {
      ...publication(serverId, "classic-v1", "IDNA host", "7"),
      quicHost: "xn--bcher-kva.example.org",
      quicPort: 1730,
    };
    await expect(persistRendezvousPublication(env.DB, explicit)).resolves
      .toEqual({ accepted: true, visibleChanged: true });
    expect(await env.DB.prepare(
      `SELECT hostname, port FROM directory_entries
        WHERE profile = 'classic-v1' AND server_id = ?`,
    ).bind(serverId).first()).toEqual({
      hostname: "xn--bcher-kva.example.org",
      port: 1730,
    });
  });

  it("rolls back a publication whose required outbox write is ignored", async () => {
    const serverId = "b".repeat(64);
    const initial = publication(serverId, "classic-v1", "Initial", "1");
    await persistRendezvousPublication(env.DB, initial);
    const before = await snapshotDirectoryState();
    await env.DB.prepare(
      `CREATE TRIGGER directory_outbox_test_ignore_publication
       BEFORE INSERT ON directory_outbox
       WHEN NEW.profile = 'classic-v1'
       BEGIN
         SELECT RAISE(IGNORE);
       END`,
    ).run();
    const changed = nextPublication(initial, {
      name: "Changed",
      directoryFingerprint: "2".repeat(64),
    });
    await expect(persistRendezvousPublication(env.DB, changed)).rejects.toThrow();
    await env.DB.prepare(
      "DROP TRIGGER directory_outbox_test_ignore_publication",
    ).run();
    expect(await snapshotDirectoryState()).toEqual(before);
    await expect(persistRendezvousPublication(env.DB, changed)).resolves.toEqual({
      accepted: true,
      visibleChanged: true,
    });
  });

  it("rolls back a publication when outbox coalescing is ignored", async () => {
    const serverId = "f".repeat(64);
    const initial = publication(serverId, "classic-v1", "Initial", "1");
    await persistRendezvousPublication(env.DB, initial);
    const before = await snapshotDirectoryState();
    await env.DB.prepare(
      `CREATE TRIGGER directory_outbox_test_ignore_publication_coalesce
       BEFORE DELETE ON directory_outbox
       WHEN OLD.profile = 'classic-v1' AND OLD.revision = 1
       BEGIN SELECT RAISE(IGNORE); END`,
    ).run();
    await expect(persistRendezvousPublication(env.DB, nextPublication(initial, {
      name: "Changed",
      directoryFingerprint: "2".repeat(64),
    }))).rejects.toThrow();
    await env.DB.prepare(
      "DROP TRIGGER directory_outbox_test_ignore_publication_coalesce",
    ).run();
    expect(await snapshotDirectoryState()).toEqual(before);
  });

  it("emits exactly one removal revision across private and expiry races", async () => {
    const privateFirstId = "c".repeat(64);
    const privateFirst = publication(
      privateFirstId,
      "classic-v1",
      "Private first",
      "1",
    );
    await persistRendezvousPublication(env.DB, privateFirst);
    await env.DB.prepare(
      `UPDATE server_presence SET last_seen = ?
        WHERE profile = 'classic-v1' AND server_id = ?`,
    ).bind(CUTOFF - 1, privateFirstId).run();
    await expect(persistRendezvousPublication(env.DB, nextPublication(
      privateFirst,
      { isPublic: false },
    ))).resolves.toEqual({ accepted: true, visibleChanged: true });
    await expect(expireDirectoryEntries(
      env.DB,
      "classic-v1",
      CUTOFF,
      NOW + 2,
    )).resolves.toEqual({ expiredEntries: 0, visibleChanged: false });

    const expiryFirstId = "d".repeat(64);
    const expiryFirst = publication(
      expiryFirstId,
      "game-v1",
      "Expiry first",
      "3",
    );
    await persistRendezvousPublication(env.DB, expiryFirst);
    await env.DB.prepare(
      `UPDATE server_presence SET last_seen = ?
        WHERE profile = 'game-v1' AND server_id = ?`,
    ).bind(CUTOFF - 1, expiryFirstId).run();
    await expect(expireDirectoryEntries(
      env.DB,
      "game-v1",
      CUTOFF,
      NOW + 1,
    )).resolves.toEqual({ expiredEntries: 1, visibleChanged: true });
    await expect(persistRendezvousPublication(env.DB, nextPublication(
      expiryFirst,
      { isPublic: false },
    ))).resolves.toEqual({ accepted: true, visibleChanged: false });

    expect(await env.DB.prepare(
      `SELECT profile, revision FROM directory_revisions ORDER BY profile`,
    ).all()).toMatchObject({
      results: [
        { profile: "classic-v1", revision: 2 },
        { profile: "game-v1", revision: 2 },
      ],
    });
  });
});

describe("static artifact publication checkpoints", () => {
  const DIGESTS = Object.freeze({
    modelSha256: "1".repeat(64),
    htmlSha256: "2".repeat(64),
    xmlSha256: "3".repeat(64),
    jsonSha256: "4".repeat(64),
    manifestSha256: "5".repeat(64),
    htmlBytes: 100,
    xmlBytes: 101,
    jsonBytes: 102,
    manifestBytes: 103,
  });

  it("checkpoints idempotently and acknowledges its exact current revision", async () => {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE directory_revisions SET revision = 2, updated_at = 100
          WHERE profile = 'classic-v1'`,
      ),
      ...[1, 2].map((revision) => env.DB.prepare(
        `INSERT INTO directory_outbox (profile, revision, created_at)
         VALUES ('classic-v1', ?, 100)`,
      ).bind(revision)),
    ]);
    const commit = {
      profile: "classic-v1",
      publishedRevision: 2,
      generation: 1,
      generatedAt: 100,
      expiresAt: 200,
      ...DIGESTS,
      publishedAt: 101,
    } as const;

    await expect(commitDirectoryArtifactPublication(env.DB, commit)).resolves
      .toBeUndefined();
    await expect(commitDirectoryArtifactPublication(env.DB, commit)).resolves
      .toBeUndefined();
    expect(await readDirectoryArtifactPublication(
      env.DB,
      "classic-v1",
    )).toEqual({
      publishedRevision: 2,
      generation: 1,
      generatedAt: 100,
      expiresAt: 200,
      ...DIGESTS,
      publishedAt: 101,
    });
    expect(await env.DB.prepare(
      `SELECT revision FROM directory_outbox
        WHERE profile = 'classic-v1' ORDER BY revision`,
    ).all()).toMatchObject({ results: [] });
    expect(await readDirectoryArtifactHistory(env.DB, "classic-v1"))
      .toEqual([1]);
  });

  it("rejects a checkpoint when D1 advances after artifact verification", async () => {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE directory_revisions SET revision = 1, updated_at = 100
          WHERE profile = 'classic-v1'`,
      ),
      env.DB.prepare(
        `INSERT INTO directory_outbox (profile, revision, created_at)
         VALUES ('classic-v1', 1, 100)`,
      ),
    ]);

    await expect(commitDirectoryArtifactPublication(env.DB, {
      profile: "classic-v1",
      publishedRevision: 0,
      generation: 1,
      generatedAt: 100,
      expiresAt: 200,
      ...DIGESTS,
      publishedAt: 101,
    })).rejects.toThrow();
    expect((await readDirectoryArtifactPublication(
      env.DB,
      "classic-v1",
    )).generation).toBe(0);
    expect(await env.DB.prepare(
      `SELECT revision FROM directory_outbox
        WHERE profile = 'classic-v1'`,
    ).all()).toMatchObject({ results: [{ revision: 1 }] });
  });

  it("requires one public model hash after the generation-zero sentinel", async () => {
    const initial = {
      profile: "classic-v1",
      publishedRevision: 0,
      generation: 1,
      generatedAt: 100,
      expiresAt: 200,
      ...DIGESTS,
      publishedAt: 101,
    } as const;
    await commitDirectoryArtifactPublication(env.DB, initial);

    await expect(commitDirectoryArtifactPublication(env.DB, {
      ...initial,
      generation: 2,
      htmlSha256: "6".repeat(64),
      publishedAt: 102,
    })).resolves.toBeUndefined();
    await expect(commitDirectoryArtifactPublication(env.DB, {
      ...initial,
      generation: 3,
      modelSha256: "7".repeat(64),
      publishedAt: 103,
    })).rejects.toThrow();
    expect(await readDirectoryArtifactPublication(
      env.DB,
      "classic-v1",
    )).toMatchObject({
      publishedRevision: 0,
      generation: 2,
      modelSha256: DIGESTS.modelSha256,
      htmlSha256: "6".repeat(64),
    });
  });

  it("rejects generation rollback and preserves the newer checkpoint", async () => {
    await env.DB.prepare(
      `UPDATE directory_revisions SET revision = 2, updated_at = 100
        WHERE profile = 'classic-v1'`,
    ).run();
    const newer = {
      profile: "classic-v1",
      publishedRevision: 2,
      generation: 4,
      generatedAt: 100,
      expiresAt: 200,
      ...DIGESTS,
      publishedAt: 101,
    } as const;
    await commitDirectoryArtifactPublication(env.DB, newer);
    await expect(commitDirectoryArtifactPublication(env.DB, {
      ...newer,
      publishedRevision: 1,
      generation: 3,
    })).rejects.toThrow();
    expect(await readDirectoryArtifactPublication(
      env.DB,
      "classic-v1",
    )).toEqual({
      publishedRevision: 2,
      generation: 4,
      generatedAt: 100,
      expiresAt: 200,
      ...DIGESTS,
      publishedAt: 101,
    });
  });

  it("rolls back when a required checkpoint write is ignored", async () => {
    await env.DB.prepare(
      `CREATE TRIGGER directory_artifact_publication_test_ignore
       BEFORE UPDATE ON directory_artifact_publications
       WHEN NEW.profile = 'classic-v1'
       BEGIN SELECT RAISE(IGNORE); END`,
    ).run();
    await expect(commitDirectoryArtifactPublication(env.DB, {
      profile: "classic-v1",
      publishedRevision: 0,
      generation: 1,
      generatedAt: 100,
      expiresAt: 200,
      ...DIGESTS,
      publishedAt: 101,
    })).rejects.toThrow();
    await env.DB.prepare(
      "DROP TRIGGER directory_artifact_publication_test_ignore",
    ).run();
    expect((await readDirectoryArtifactPublication(
      env.DB,
      "classic-v1",
    )).generation).toBe(0);
    expect(await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM directory_artifact_commits
        WHERE profile = 'classic-v1'`,
    ).first<number>("count")).toBe(0);
  });

  it("rolls back when required rollback-history persistence is ignored", async () => {
    await env.DB.prepare(
      `CREATE TRIGGER directory_artifact_history_test_ignore_insert
       BEFORE INSERT ON directory_artifact_history
       WHEN NEW.profile = 'classic-v1'
       BEGIN SELECT RAISE(IGNORE); END`,
    ).run();
    await expect(commitDirectoryArtifactPublication(env.DB, {
      profile: "classic-v1",
      publishedRevision: 0,
      generation: 1,
      generatedAt: 100,
      expiresAt: 200,
      ...DIGESTS,
      publishedAt: 101,
    })).rejects.toThrow();
    await env.DB.prepare(
      "DROP TRIGGER directory_artifact_history_test_ignore_insert",
    ).run();
    expect((await readDirectoryArtifactPublication(
      env.DB,
      "classic-v1",
    )).generation).toBe(0);
    expect(await readDirectoryArtifactHistory(env.DB, "classic-v1"))
      .toEqual([]);
  });

  it("rolls back when bounded rollback-history pruning is ignored", async () => {
    const base = {
      profile: "classic-v1",
      publishedRevision: 0,
      generatedAt: 100,
      expiresAt: 1_000,
      ...DIGESTS,
    } as const;
    for (let generation = 1; generation <= 8; generation += 1) {
      await commitDirectoryArtifactPublication(env.DB, {
        ...base,
        generation,
        publishedAt: 100 + generation,
      });
    }
    await env.DB.prepare(
      `CREATE TRIGGER directory_artifact_history_test_ignore_prune
       BEFORE DELETE ON directory_artifact_history
       WHEN OLD.profile = 'classic-v1' AND OLD.generation = 1
       BEGIN SELECT RAISE(IGNORE); END`,
    ).run();
    await expect(commitDirectoryArtifactPublication(env.DB, {
      ...base,
      generation: 9,
      publishedAt: 109,
    })).rejects.toThrow();
    await env.DB.prepare(
      "DROP TRIGGER directory_artifact_history_test_ignore_prune",
    ).run();
    expect((await readDirectoryArtifactPublication(
      env.DB,
      "classic-v1",
    )).generation).toBe(8);
    expect(await readDirectoryArtifactHistory(env.DB, "classic-v1"))
      .toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("rolls back when required outbox acknowledgement is ignored", async () => {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE directory_revisions SET revision = 1, updated_at = 100
          WHERE profile = 'classic-v1'`,
      ),
      env.DB.prepare(
        `INSERT INTO directory_outbox (profile, revision, created_at)
         VALUES ('classic-v1', 1, 100)`,
      ),
      env.DB.prepare(
        `CREATE TRIGGER directory_outbox_test_ignore_acknowledgement
         BEFORE DELETE ON directory_outbox
         WHEN OLD.profile = 'classic-v1'
         BEGIN SELECT RAISE(IGNORE); END`,
      ),
    ]);
    await expect(commitDirectoryArtifactPublication(env.DB, {
      profile: "classic-v1",
      publishedRevision: 1,
      generation: 1,
      generatedAt: 100,
      expiresAt: 200,
      ...DIGESTS,
      publishedAt: 101,
    })).rejects.toThrow();
    await env.DB.prepare(
      "DROP TRIGGER directory_outbox_test_ignore_acknowledgement",
    ).run();
    expect((await readDirectoryArtifactPublication(
      env.DB,
      "classic-v1",
    )).generation).toBe(0);
    expect(await env.DB.prepare(
      `SELECT revision FROM directory_outbox WHERE profile = 'classic-v1'`,
    ).all()).toMatchObject({ results: [{ revision: 1 }] });
    expect(await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM directory_artifact_commits
        WHERE profile = 'classic-v1'`,
    ).first<number>("count")).toBe(0);
  });
});

function nextPublication<T extends InternalRendezvousPublication>(
  original: T,
  overrides: Partial<T>,
): T {
  return {
    ...original,
    publisherSequence: "2",
    publisherNonce: "e".repeat(32),
    publisherNonceExpiresAt: 1_001,
    commitToken: "e".repeat(64),
    generation: "e".repeat(64),
    tokenHash: "e".repeat(64),
    now: NOW + 1,
    ...overrides,
  } as T;
}

async function snapshotDirectoryState(): Promise<unknown> {
  const tables = [
    "directory_artifact_history",
    "directory_entries",
    "directory_expiry_commits",
    "directory_outbox",
    "directory_revisions",
    "publisher_nonces",
    "publisher_replay",
    "server_presence",
  ] as const;
  return Promise.all(tables.map(async (table) => ({
    table,
    rows: (await env.DB.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all())
      .results,
  })));
}

function publication(
  serverId: string,
  profile: "classic-v1" | "game-v1",
  name: string,
  discriminator: string,
): InternalRendezvousPublication {
  const common = {
    serverId,
    publisherSequence: "1",
    publisherNonce: discriminator.repeat(32),
    publisherNonceExpiresAt: 1_000,
    commitToken: discriminator.repeat(64),
    expectedGeneration: null,
    generation: discriminator.repeat(64),
    tokenHash: discriminator.repeat(64),
    now: NOW,
    visibilityCutoff: CUTOFF,
    name,
    isPublic: true,
    quicHost: "",
    quicPort: 1,
    quicCertSha256: serverId,
    passwordRequired: false,
    directoryFingerprint: discriminator.repeat(64),
  } as const;
  return profile === "classic-v1"
    ? {
        ...common,
        directoryProfile: profile,
        playersCount: 0,
        version: "4.0.0",
        textComment: "",
      }
    : {
        ...common,
        directoryProfile: profile,
        description: "Game directory state",
        region: null,
        protocolMajor: 1,
        protocolMinor: 0,
        contentId: "atrinik-main",
        contentRevisionSha256: discriminator.repeat(64),
        playersOnline: 0,
        playersCapacity: 64,
        status: "online",
      };
}

function replaySeed(
  serverId: string,
  profile: "classic-v1" | "game-v1",
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT OR IGNORE INTO publisher_replay
       (server_id, profile, last_sequence, last_nonce, commit_token, updated_at)
     VALUES (?, ?, '1', ?, ?, 0)`,
  ).bind(serverId, profile, serverId.slice(0, 32), serverId);
}

async function seedPublic(
  serverId: string,
  profile: "classic-v1" | "game-v1",
  lastSeen: number,
): Promise<void> {
  await env.DB.batch([
    replaySeed(serverId, profile),
    env.DB.prepare(
      `INSERT INTO server_presence
         (profile, server_id, last_seen, rendezvous_token_hash,
          rendezvous_generation)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(profile, serverId, lastSeen, "b".repeat(64), "c".repeat(64)),
    profile === "classic-v1"
      ? env.DB.prepare(
        `INSERT INTO directory_entries
           (profile, server_id, name, players_count, version, text_comment,
            hostname, port, quic_cert_sha256, password_required,
            directory_fingerprint)
         VALUES (?, ?, 'Directory test', 0, '4.0.0', '', NULL, NULL, ?, 0, ?)`,
      ).bind(profile, serverId, serverId, "d".repeat(64))
      : env.DB.prepare(
        `INSERT INTO directory_entries
           (profile, server_id, name, description, protocol_major,
            protocol_minor, content_id, content_revision_sha256,
            players_online, players_capacity, status, game_json_bytes, hostname, port,
            quic_cert_sha256, password_required, directory_fingerprint)
         VALUES (?, ?, 'Directory test', '', 1, 0, 'atrinik-main', ?,
                 0, 64, 'online', 1, NULL, NULL, ?, 0, ?)`,
      ).bind(profile, serverId, "e".repeat(64), serverId, "d".repeat(64)),
  ]);
}

async function seedPrivate(
  serverId: string,
  profile: "classic-v1" | "game-v1",
  lastSeen: number,
): Promise<void> {
  await env.DB.batch([
    replaySeed(serverId, profile),
    env.DB.prepare(
      `INSERT INTO server_presence
         (profile, server_id, last_seen, rendezvous_token_hash,
          rendezvous_generation)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(profile, serverId, lastSeen, "b".repeat(64), "c".repeat(64)),
  ]);
}
