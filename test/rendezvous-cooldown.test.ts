import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { RequestBudgetExceeded } from "../src/rate-limit";
import { consumeRendezvousPairCooldown } from "../src/rendezvous-cooldown";

const DIGEST = "A".repeat(43);

function actor(keyId: string): string {
  return `v1.${keyId}.${DIGEST}`;
}

function attemptId(value: number): string {
  return value.toString(16).padStart(32, "0");
}

function request(
  now: number,
  attempt: number,
  actorKeys: readonly [string] | readonly [string, string] = [actor("a")],
) {
  return {
    actorKeys,
    now,
    burstLimit: 20,
    windowSeconds: 60,
    initialCooldownSeconds: 30,
    maximumCooldownSeconds: 900,
    resetSeconds: 1_800,
    attemptId: attemptId(attempt),
  } as const;
}

async function admitBurst(
  now: number,
  firstAttempt: number,
  actorKeys?: readonly [string] | readonly [string, string],
): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await expect(consumeRendezvousPairCooldown(
      env.DB,
      request(now, firstAttempt + index, actorKeys),
    )).resolves.toMatchObject({
      admitted: true,
      count: index + 1,
      remaining: 19 - index,
    });
  }
}

async function rejectCooldown(
  now: number,
  attempt: number,
  retryAfterSeconds: number,
  actorKeys?: readonly [string] | readonly [string, string],
): Promise<void> {
  await expect(consumeRendezvousPairCooldown(
    env.DB,
    request(now, attempt, actorKeys),
  )).rejects.toMatchObject({
    name: "RequestBudgetExceeded",
    scope: "rendezvous-client-pair-cooldown",
    reason: "cooldown_active",
    retryAfterSeconds,
    resetAt: now + retryAfterSeconds,
    limit: 20,
  } satisfies Partial<RequestBudgetExceeded>);
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DROP TRIGGER IF EXISTS rendezvous_pair_test_abort_attempt"),
    env.DB.prepare("DROP TRIGGER IF EXISTS rendezvous_pair_test_abort_cooldown"),
    env.DB.prepare("DELETE FROM rendezvous_pair_attempts"),
    env.DB.prepare("DELETE FROM rendezvous_pair_cooldowns"),
  ]);
});

describe("eligible rendezvous pair cooldown", () => {
  it("admits 20 rolling attempts and starts a non-extending 30-second cooldown on 21", async () => {
    const now = 1_800_000_000;
    await admitBurst(now, 1);
    await rejectCooldown(now, 21, 30);

    const before = await env.DB.prepare(
      `SELECT blocked_until, penalty_level, last_burst_at, expires_at
         FROM rendezvous_pair_cooldowns WHERE actor_key = ?`,
    ).bind(actor("a")).first();
    await expect(consumeRendezvousPairCooldown(
      env.DB,
      request(now + 7, 22),
    )).rejects.toMatchObject({ retryAfterSeconds: 23 });
    const after = await env.DB.prepare(
      `SELECT blocked_until, penalty_level, last_burst_at, expires_at
         FROM rendezvous_pair_cooldowns WHERE actor_key = ?`,
    ).bind(actor("a")).first();
    expect(after).toEqual(before);
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM rendezvous_pair_attempts",
    ).first<number>("count")).toBe(0);
  });

  it("escalates only after complete independent bursts and caps at 900 seconds", async () => {
    let now = 1_800_010_000;
    let nextAttempt = 1;
    for (const cooldown of [30, 60, 120, 240, 480, 900, 900]) {
      await admitBurst(now, nextAttempt);
      nextAttempt += 20;
      await rejectCooldown(now, nextAttempt, cooldown);
      nextAttempt += 1;
      now += cooldown;
    }
  });

  it("resets to the first cooldown after 30 quiet minutes", async () => {
    const first = 1_800_020_000;
    await admitBurst(first, 1);
    await rejectCooldown(first, 21, 30);
    const second = first + 30;
    await admitBurst(second, 100);
    await rejectCooldown(second, 120, 60);

    const afterQuiet = second + 1_800;
    await admitBurst(afterQuiet, 200);
    await rejectCooldown(afterQuiet, 220, 30);
  });

  it("uses a true rolling boundary instead of a UTC or fixed window", async () => {
    const first = 1_800_030_000;
    await admitBurst(first, 1);
    await expect(consumeRendezvousPairCooldown(
      env.DB,
      request(first + 60, 21),
    )).resolves.toMatchObject({ admitted: true, count: 1, remaining: 19 });
  });

  it("does not accumulate intermittent attempts through a day or at UTC midnight", async () => {
    const beforeMidnight = Math.floor(
      Date.parse("2026-08-12T23:59:30.000Z") / 1_000,
    );
    for (let attempt = 0; attempt < 24; attempt += 1) {
      await expect(consumeRendezvousPairCooldown(
        env.DB,
        request(beforeMidnight + attempt * 3_600, attempt + 1),
      )).resolves.toMatchObject({ admitted: true, count: 1, remaining: 19 });
    }
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM rendezvous_pair_cooldowns",
    ).first<number>("count")).toBe(0);
  });

  it("mirrors aliases without double charging and carries state across rotation", async () => {
    const now = 1_800_040_000;
    const oldAliases = [actor("a"), actor("z")] as const;
    const newAliases = [actor("b"), actor("a")] as const;
    for (let index = 0; index < 10; index += 1) {
      await consumeRendezvousPairCooldown(
        env.DB,
        request(now, index + 1, oldAliases),
      );
    }
    for (let index = 10; index < 20; index += 1) {
      const admitted = await consumeRendezvousPairCooldown(
        env.DB,
        request(now, index + 1, newAliases),
      );
      expect(admitted.count).toBe(index + 1);
    }
    await rejectCooldown(now, 21, 30, newAliases);

    const rows = await env.DB.prepare(
      `SELECT actor_key, blocked_until, penalty_level, last_burst_at, expires_at
         FROM rendezvous_pair_cooldowns ORDER BY actor_key`,
    ).all();
    expect(rows.results).toHaveLength(2);
    expect(rows.results.map(({ actor_key }) => actor_key)).toEqual(
      [...newAliases].sort(),
    );
    expect(new Set(rows.results.map((row) => JSON.stringify({
      blocked_until: row.blocked_until,
      penalty_level: row.penalty_level,
      last_burst_at: row.last_burst_at,
      expires_at: row.expires_at,
    })))).toHaveLength(1);
  });

  it("admits exactly 20 under concurrency and leaves one exact cooldown", async () => {
    const now = 1_800_050_000;
    const outcomes = await Promise.all(Array.from({ length: 21 }, async (_, index) => {
      try {
        await consumeRendezvousPairCooldown(env.DB, request(now, index + 1));
        return "admitted" as const;
      } catch (error) {
        expect(error).toBeInstanceOf(RequestBudgetExceeded);
        return "blocked" as const;
      }
    }));
    expect(outcomes.filter((outcome) => outcome === "admitted")).toHaveLength(20);
    expect(outcomes.filter((outcome) => outcome === "blocked")).toHaveLength(1);
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM rendezvous_pair_attempts",
    ).first<number>("count")).toBe(0);
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM rendezvous_pair_cooldowns",
    ).first<number>("count")).toBe(1);
  });

  it("rolls back every alias when an attempt or cooldown mirror fails", async () => {
    const aliases = [actor("a"), actor("b")] as const;
    await env.DB.prepare(
      `CREATE TRIGGER rendezvous_pair_test_abort_attempt
         BEFORE INSERT ON rendezvous_pair_attempts
         WHEN NEW.actor_key = '${actor("b")}'
       BEGIN
         SELECT RAISE(ABORT, 'injected attempt mirror failure');
       END`,
    ).run();
    await expect(consumeRendezvousPairCooldown(
      env.DB,
      request(1_800_055_000, 1, aliases),
    )).rejects.toBeInstanceOf(Error);
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM rendezvous_pair_attempts",
    ).first<number>("count")).toBe(0);

    await env.DB.prepare("DROP TRIGGER rendezvous_pair_test_abort_attempt").run();
    await admitBurst(1_800_055_000, 10, aliases);
    await env.DB.prepare(
      `CREATE TRIGGER rendezvous_pair_test_abort_cooldown
         BEFORE INSERT ON rendezvous_pair_cooldowns
         WHEN NEW.actor_key = '${actor("b")}'
       BEGIN
         SELECT RAISE(ABORT, 'injected cooldown mirror failure');
       END`,
    ).run();
    await expect(consumeRendezvousPairCooldown(
      env.DB,
      request(1_800_055_000, 30, aliases),
    )).rejects.toBeInstanceOf(Error);
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM rendezvous_pair_cooldowns",
    ).first<number>("count")).toBe(0);
    expect(await env.DB.prepare(
      "SELECT COUNT(DISTINCT attempt_id) AS count FROM rendezvous_pair_attempts",
    ).first<number>("count")).toBe(20);
  });

  it("rejects malformed tuning and aliases before D1 mutation", async () => {
    for (const overrides of [
      { burstLimit: 21 },
      { windowSeconds: 61 },
      { initialCooldownSeconds: 31 },
      { maximumCooldownSeconds: 901 },
      { resetSeconds: 1_801 },
      { attemptId: "A".repeat(32) },
      { actorKeys: ["192.0.2.1"] as const },
    ]) {
      await expect(consumeRendezvousPairCooldown(env.DB, {
        ...request(1_800_060_000, 1),
        ...overrides,
      })).rejects.toBeInstanceOf(Error);
    }
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM rendezvous_pair_attempts",
    ).first<number>("count")).toBe(0);
  });

  it("fails closed rather than undercharging an attempt-ID collision", async () => {
    const now = 1_800_070_000;
    await consumeRendezvousPairCooldown(env.DB, request(now, 1));
    await expect(consumeRendezvousPairCooldown(
      env.DB,
      request(now, 1),
    )).rejects.toThrow("attempt ID was not newly inserted");
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM rendezvous_pair_attempts",
    ).first<number>("count")).toBe(1);
  });
});
