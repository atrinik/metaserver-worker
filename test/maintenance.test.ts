import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { cleanupExpiredState } from "../src/maintenance";

const EXPIRED_AT = 100;
const LIVE_AT = 300;
const CUTOFF = 200;

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM servers"),
    env.DB.prepare("DELETE FROM server_owners"),
    env.DB.prepare("DELETE FROM one_time_tokens"),
    env.DB.prepare("DELETE FROM rate_limits"),
    env.DB.prepare("DELETE FROM request_budgets"),
  ]);
});

describe("bounded state maintenance", () => {
  it("round-robins every state class and reports exact backlogs", async () => {
    for (let index = 0; index < 6; index += 1) {
      const serverId = index.toString(16).padStart(64, "0");
      const expired = index < 5;
      const timestamp = expired ? EXPIRED_AT : LIVE_AT;
      await env.DB.prepare(
        `INSERT INTO server_owners
           (server_id, auth_key, current_ip, ip_changed_at, created_at, updated_at)
         VALUES (?, ?, '', 0, 0, 0)`,
      ).bind(serverId, "a".repeat(128)).run();
      await env.DB.prepare(
        `INSERT INTO servers
           (server_id, source_ip, name, players_count, version, text_comment,
            last_seen, is_public, quic_host, quic_port, quic_cert_sha256,
            password_required, rendezvous_token_hash)
         VALUES (?, '', 'test', 0, '4', '', ?, 0, '', 1730, ?, 0, ?)`,
      ).bind(serverId, timestamp, serverId, "b".repeat(64)).run();
      await env.DB.prepare(
        `INSERT INTO one_time_tokens
           (token_hash, source_ip, expires_at, created_at)
         VALUES (?, '192.0.2.10', ?, 0)`,
      ).bind(`token-${index}`, timestamp).run();
      await env.DB.prepare(
        `INSERT INTO rate_limits
           (source_ip, scope, window_start, request_count)
         VALUES (?, 'test', ?, 1)`,
      ).bind(`source-${index}`, timestamp).run();
      await env.DB.prepare(
        `INSERT INTO request_budgets
           (actor_key, scope, window_start, request_count, expires_at)
         VALUES (?, 'compat-directory', ?, 1, ?)`,
      ).bind(
        `v1.key-${index}.${"A".repeat(43)}`,
        index,
        timestamp,
      ).run();
    }

    const cutoffs = {
      serversBefore: CUTOFF,
      oneTimeTokensAtOrBefore: CUTOFF,
      rateLimitsBefore: CUTOFF,
      requestBudgetsAtOrBefore: CUTOFF,
    };
    const first = await cleanupExpiredState(env.DB, cutoffs, {
      batchSize: 2,
      maximumBatches: 2,
    });
    expect(first.backloggedTargets).toEqual([
      "servers",
      "one_time_tokens",
      "rate_limits",
      "request_budgets",
    ]);
    for (const result of Object.values(first.targets)) {
      expect(result).toEqual({
        deletedRows: 4,
        executedBatches: 2,
        hasMore: true,
      });
    }

    const second = await cleanupExpiredState(env.DB, cutoffs, {
      batchSize: 2,
      maximumBatches: 2,
    });
    expect(second.backloggedTargets).toEqual([]);
    for (const result of Object.values(second.targets)) {
      expect(result).toEqual({
        deletedRows: 1,
        executedBatches: 1,
        hasMore: false,
      });
    }

    for (const table of [
      "servers",
      "one_time_tokens",
      "rate_limits",
      "request_budgets",
    ]) {
      expect(await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM ${table}`,
      ).first<number>("count")).toBe(1);
    }
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM server_owners",
    ).first<number>("count")).toBe(6);
  });

  it("rejects invalid bounds before issuing a query", async () => {
    for (const options of [
      { batchSize: 0 },
      { batchSize: 1_001 },
      { maximumBatches: 0 },
      { maximumBatches: 9 },
    ]) {
      await expect(cleanupExpiredState(env.DB, {
        serversBefore: CUTOFF,
        oneTimeTokensAtOrBefore: CUTOFF,
        rateLimitsBefore: CUTOFF,
        requestBudgetsAtOrBefore: CUTOFF,
      }, options)).rejects.toBeInstanceOf(RangeError);
    }

    await expect(cleanupExpiredState(env.DB, {
      serversBefore: -1,
      oneTimeTokensAtOrBefore: CUTOFF,
      rateLimitsBefore: CUTOFF,
      requestBudgetsAtOrBefore: CUTOFF,
    })).rejects.toBeInstanceOf(RangeError);
  });
});
