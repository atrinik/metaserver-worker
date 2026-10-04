import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { cleanupExpiredState, MAINTENANCE_TARGETS } from "../src/maintenance";

const EXPIRED_AT = 100;
const LIVE_AT = 300;
const CUTOFF = 200;

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM request_budgets"),
    env.DB.prepare("DELETE FROM publisher_nonces"),
    env.DB.prepare("DELETE FROM publisher_replay"),
  ]);
});

describe("bounded canonical state maintenance", () => {
  it("round-robins every active canonical state class", async () => {
    for (let index = 0; index < 6; index += 1) {
      const serverId = index.toString(16).padStart(64, "0");
      const timestamp = index < 5 ? EXPIRED_AT : LIVE_AT;
      await env.DB.prepare(
        `INSERT INTO request_budgets
           (actor_key, scope, window_start, request_count, expires_at)
         VALUES (?, 'publish-server', ?, 1, ?)`,
      ).bind(serverId, index, timestamp).run();
      await env.DB.prepare(
        `INSERT INTO publisher_replay
           (server_id, profile, last_sequence, last_nonce, commit_token, updated_at)
         VALUES (?, 'classic-v3', '1', ?, ?, 0)`,
      ).bind(serverId, "1".repeat(32), serverId).run();
      await env.DB.prepare(
        `INSERT INTO publisher_nonces
           (server_id, profile, nonce, expires_at, created_at)
         VALUES (?, 'classic-v3', ?, ?, 0)`,
      ).bind(serverId, index.toString(16).padStart(32, "1"), timestamp).run();
    }
    expect(MAINTENANCE_TARGETS).toEqual([
      "request_budgets",
      "publisher_nonces",
    ]);
    const cutoffs = {
      requestBudgetsAtOrBefore: CUTOFF,
      publisherNoncesAtOrBefore: CUTOFF,
    };
    expect(await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE name LIKE 'rendezvous_pair_%'",
    ).all()).toMatchObject({ results: [] });
    const first = await cleanupExpiredState(env.DB, cutoffs, {
      batchSize: 2,
      maximumBatches: 2,
    });
    expect(first.backloggedTargets).toEqual(MAINTENANCE_TARGETS);
    for (const result of Object.values(first.targets)) {
      expect(result).toEqual({ deletedRows: 4, executedBatches: 2, hasMore: true });
    }

    const second = await cleanupExpiredState(env.DB, cutoffs, {
      batchSize: 2,
      maximumBatches: 2,
    });
    expect(second.backloggedTargets).toEqual([]);
    for (const result of Object.values(second.targets)) {
      expect(result).toEqual({ deletedRows: 1, executedBatches: 1, hasMore: false });
    }
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM request_budgets",
    ).first<number>("count")).toBe(1);
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM publisher_nonces",
    ).first<number>("count")).toBe(1);
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM publisher_replay WHERE last_sequence = '1'",
    ).first<number>("count")).toBe(6);
  });

  it("rejects invalid bounds and cutoffs before work", async () => {
    const cutoffs = {
      requestBudgetsAtOrBefore: CUTOFF,
      publisherNoncesAtOrBefore: CUTOFF,
    };
    for (const options of [
      { batchSize: 0 }, { batchSize: 1_001 },
      { maximumBatches: 0 }, { maximumBatches: 9 },
    ]) {
      await expect(cleanupExpiredState(env.DB, cutoffs, options))
        .rejects.toBeInstanceOf(RangeError);
    }
    await expect(cleanupExpiredState(env.DB, {
      ...cutoffs,
      requestBudgetsAtOrBefore: -1,
    })).rejects.toBeInstanceOf(RangeError);
  });
});
