import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DIRECTORY_PROFILES,
  expireDirectoryEntries,
} from "../src/directory-state";
import worker from "../src/index";
import { persistRendezvousPublication } from "../src/rendezvous-publication";
import type { InternalRendezvousPublication } from "../src/rendezvous-contract";

const CUTOFF = 200;
const NOW = 300;

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM directory_expiry_commits"),
    env.DB.prepare("DELETE FROM directory_transaction_assertions"),
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
      { expiredEntries: 1, visibleChanged: true },
      { expiredEntries: 1, visibleChanged: true },
    ]);
    expect(await env.DB.prepare(
      `SELECT profile, server_id, last_seen
         FROM server_presence ORDER BY profile, server_id`,
    ).all()).toMatchObject({
      results: [
        {
          profile: "classic-v1",
          server_id: "2".repeat(64),
          last_seen: CUTOFF,
        },
        {
          profile: "classic-v1",
          server_id: "7".repeat(64),
          last_seen: CUTOFF,
        },
      ],
    });
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
    await env.DB.prepare(
      `CREATE TRIGGER server_owners_test_ignore_game_update
       BEFORE UPDATE ON server_owners
       WHEN NEW.server_id = '${serverId}'
       BEGIN
         SELECT RAISE(IGNORE);
       END`,
    ).run();
    await expect(persistRendezvousPublication(env.DB, game)).resolves.toEqual({
      accepted: true,
      visibleChanged: true,
    });
    await env.DB.prepare(
      "DROP TRIGGER server_owners_test_ignore_game_update",
    ).run();

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
      "SELECT name, rendezvous_generation FROM servers WHERE server_id = ?",
    ).bind(serverId).first()).toEqual({
      name: "Classic",
      rendezvous_generation: classic.generation,
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
    expect(await env.DB.prepare(
      "SELECT source_ip, quic_host, quic_port FROM servers WHERE server_id = ?",
    ).bind(serverId).first()).toEqual({
      source_ip: "",
      quic_host: "play.example.net",
      quic_port: 1730,
    });

    vi.spyOn(Date, "now").mockReturnValue(NOW * 1_000);
    const context = createExecutionContext();
    const response = await worker.fetch(new Request(
      "https://meta.example.test/v2/servers",
      { headers: { "CF-Connecting-IP": "192.0.2.200" } },
    ), env, context);
    await waitOnExecutionContext(context);
    expect(response.status).toBe(200);
    const xml = await response.text();
    expect(xml).toContain(`<Id>${serverId}</Id>`);
    expect(xml).toContain("<Address>play.example.net</Address>");
    expect(xml).toContain("<Port>1730</Port>");
    expect(xml).not.toContain("192.0.2.200");
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

function nextPublication(
  original: InternalRendezvousPublication,
  overrides: Partial<InternalRendezvousPublication>,
): InternalRendezvousPublication {
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
  };
}

async function snapshotDirectoryState(): Promise<unknown> {
  const tables = [
    "directory_entries",
    "directory_expiry_commits",
    "directory_outbox",
    "directory_revisions",
    "publisher_nonces",
    "publisher_replay",
    "server_owners",
    "server_presence",
    "servers",
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
  return {
    serverId,
    directoryProfile: profile,
    publisherAuthentication: "signed-certificate-v1",
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
    playersCount: 0,
    version: "4.0.0",
    textComment: "",
    isPublic: true,
    quicHost: "",
    quicPort: 1,
    quicCertSha256: serverId,
    passwordRequired: false,
    directoryFingerprint: discriminator.repeat(64),
  };
}

async function seedPublic(
  serverId: string,
  profile: "classic-v1" | "game-v1",
  lastSeen: number,
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO server_owners
         (server_id, auth_key, current_ip, ip_changed_at, created_at, updated_at)
       VALUES (?, ?, '', 0, 0, 0)`,
    ).bind(serverId, "a".repeat(128)),
    env.DB.prepare(
      `INSERT INTO server_presence
         (profile, server_id, last_seen, rendezvous_token_hash,
          rendezvous_generation)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(profile, serverId, lastSeen, "b".repeat(64), "c".repeat(64)),
    env.DB.prepare(
      `INSERT INTO directory_entries
         (profile, server_id, name, players_count, version, text_comment,
          hostname, port, quic_cert_sha256, password_required,
          directory_fingerprint)
       VALUES (?, ?, 'Directory test', 0, '4.0.0', '', NULL, NULL, ?, 0, ?)`,
    ).bind(profile, serverId, serverId, "d".repeat(64)),
  ]);
}

async function seedPrivate(
  serverId: string,
  profile: "classic-v1" | "game-v1",
  lastSeen: number,
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO server_owners
         (server_id, auth_key, current_ip, ip_changed_at, created_at, updated_at)
       VALUES (?, ?, '', 0, 0, 0)`,
    ).bind(serverId, "a".repeat(128)),
    env.DB.prepare(
      `INSERT INTO server_presence
         (profile, server_id, last_seen, rendezvous_token_hash,
          rendezvous_generation)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(profile, serverId, lastSeen, "b".repeat(64), "c".repeat(64)),
  ]);
}
