import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import {
  boundedRetryAfter,
  consumeFixedWindowBudget,
  enforceNativeBurst,
  enforceNativeBurstAliases,
  isD1ProgrammingOrIntegrityFailure,
  isRequestActorKey,
  REQUEST_BUDGET_SCOPES,
  RequestBudgetExceeded,
  RequestControlUnavailable,
  utcDayWindow,
} from "../src/rate-limit";
import type {
  FixedWindowBudgetRequest,
  RequestBudgetAdmission,
  RequestBudgetScope,
} from "../src/rate-limit";

const HMAC_DIGEST = "A".repeat(43);
const SERVER_ACTOR = "1".repeat(64);
const TEST_TRIGGER_NAMES = [
  "request_budgets_test_abort_insert",
] as const;

function sourceActor(keyId = "current"): string {
  return `v1.${keyId}.${HMAC_DIGEST}`;
}

function request(
  overrides: Partial<FixedWindowBudgetRequest> = {},
): FixedWindowBudgetRequest {
  const now = 1_786_147_200;
  return {
    actorKey: SERVER_ACTOR,
    scope: "publish-server",
    limit: 3,
    now,
    window: utcDayWindow(now),
    ...overrides,
  };
}

async function readCount(
  actorKey: string,
  scope: RequestBudgetScope,
  windowStart: number,
): Promise<number | null> {
  return env.DB.prepare(
    `SELECT request_count
       FROM request_budgets
      WHERE actor_key = ? AND scope = ? AND window_start = ?`,
  )
    .bind(actorKey, scope, windowStart)
    .first<number>("request_count");
}

async function captureRejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw new Error("Expected the promise to reject with an Error");
  }
  throw new Error("Expected the promise to reject");
}

beforeEach(async () => {
  for (const triggerName of TEST_TRIGGER_NAMES) {
    await env.DB.prepare(`DROP TRIGGER IF EXISTS ${triggerName}`).run();
  }
  await env.DB.prepare("DELETE FROM request_budgets").run();
});

describe("fixed request-budget windows", () => {
  it("admits exactly N calls and leaves the counter at N after N+1", async () => {
    const budget = request({ limit: 3 });
    const admissions: RequestBudgetAdmission[] = [];
    for (let attempt = 0; attempt < budget.limit; attempt += 1) {
      admissions.push(await consumeFixedWindowBudget(env.DB, budget));
    }

    expect(admissions.map((admission) => admission.count)).toEqual([1, 2, 3]);
    expect(admissions.map((admission) => admission.remaining)).toEqual([2, 1, 0]);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(consumeFixedWindowBudget(env.DB, budget)).rejects.toMatchObject({
        name: "RequestBudgetExceeded",
        reason: "request_budget_exceeded",
        scope: budget.scope,
        limit: budget.limit,
      });
    }
    expect(await readCount(
      budget.actorKey,
      budget.scope,
      budget.window.startAt,
    )).toBe(3);
  });

  it("rolls over at UTC midnight and reports the exact retry interval", async () => {
    const beforeMidnight = Math.floor(
      Date.parse("2026-08-08T23:59:50.000Z") / 1_000,
    );
    const firstWindow = utcDayWindow(beforeMidnight);
    const first = request({
      actorKey: SERVER_ACTOR,
      scope: "publish-server",
      limit: 1,
      now: beforeMidnight,
      window: firstWindow,
    });
    await consumeFixedWindowBudget(env.DB, first);

    await expect(consumeFixedWindowBudget(env.DB, first)).rejects.toMatchObject({
      retryAfterSeconds: 10,
      resetAt: firstWindow.endAt,
    });

    const atMidnight = firstWindow.endAt;
    const secondWindow = utcDayWindow(atMidnight);
    const admission = await consumeFixedWindowBudget(env.DB, {
      ...first,
      now: atMidnight,
      window: secondWindow,
    });
    expect(admission).toMatchObject({ count: 1, remaining: 0 });
    expect(secondWindow.startAt).toBe(firstWindow.endAt);
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM request_budgets WHERE actor_key = ?",
    ).bind(SERVER_ACTOR).first<number>("count")).toBe(2);
  });

  it("admits no more than the configured limit under concurrency", async () => {
    const budget = request({
      actorKey: "2".repeat(64),
      scope: "publish-server",
      limit: 5,
    });
    const outcomes = await Promise.all(Array.from({ length: 32 }, async () => {
      try {
        return {
          admitted: true as const,
          value: await consumeFixedWindowBudget(env.DB, budget),
        };
      } catch (error) {
        return { admitted: false as const, error };
      }
    }));

    const accepted = outcomes.filter((outcome) => outcome.admitted);
    const rejected = outcomes.filter((outcome) => !outcome.admitted);
    expect(accepted).toHaveLength(5);
    expect(rejected).toHaveLength(27);
    for (const outcome of rejected) {
      expect(outcome.error).toBeInstanceOf(RequestBudgetExceeded);
    }
    expect(await readCount(
      budget.actorKey,
      budget.scope,
      budget.window.startAt,
    )).toBe(5);
  });

  it("isolates every closed scope for the same actor and window", async () => {
    const actorKey = "3".repeat(64);
    const now = 1_786_147_200;
    const window = utcDayWindow(now);

    for (const scope of REQUEST_BUDGET_SCOPES) {
      const admission = await consumeFixedWindowBudget(env.DB, {
        actorKey,
        scope,
        limit: 1,
        now,
        window,
      });
      expect(admission.scope).toBe(scope);
      expect(admission.count).toBe(1);
    }

    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM request_budgets WHERE actor_key = ?",
    ).bind(actorKey).first<number>("count")).toBe(REQUEST_BUDGET_SCOPES.length);
  });

});

describe("request-control dependency failures", () => {
  it("keeps a D1 admission constraint failure as an internal error", async () => {
    await env.DB.prepare(
      `CREATE TRIGGER request_budgets_test_abort_insert
       BEFORE INSERT ON request_budgets
       BEGIN
         SELECT RAISE(ABORT, 'simulated admission failure');
       END`,
    ).run();

    const error = await captureRejection(
      consumeFixedWindowBudget(env.DB, request()),
    );
    expect(error).not.toBeInstanceOf(RequestControlUnavailable);
    expect(error.message.toLowerCase()).toContain("simulated admission failure");
  });

  it("recognizes only narrow D1 programming and integrity diagnostics", () => {
    for (const error of [
      new TypeError("bad bind"),
      new RangeError("bad range"),
      new SyntaxError("bad syntax"),
      new Error("D1_TYPE_ERROR: Incorrect type for binding"),
      new Error("D1_COLUMNNOTFOUND: missing result column"),
      new Error("D1_COLUMN_NOTFOUND: missing result column"),
      new Error("D1_EXEC_ERROR: SQLITE_CONSTRAINT_TRIGGER"),
      new Error("D1_ERROR: no such table: request_budgets"),
      new Error("D1_ERROR: no such column: actor_key"),
      new Error("D1_ERROR: near SELECT: syntax error"),
      new Error("No SQL statements detected"),
      new Error("outer", {
        cause: new Error("D1_EXEC_ERROR: UNIQUE constraint failed"),
      }),
    ]) {
      expect(isD1ProgrammingOrIntegrityFailure(error)).toBe(true);
    }

    for (const error of [
      new Error("D1_EXEC_ERROR: database is locked"),
      new Error("D1_ERROR: Network connection lost"),
      new Error("D1_ERROR: storage quota exceeded"),
      new Error("D1 reset while executing query"),
      new Error("unknown D1 failure"),
      "not even an Error",
    ]) {
      expect(isD1ProgrammingOrIntegrityFailure(error)).toBe(false);
    }
  });

  it("fails unknown and operational D1 errors closed as unavailable", async () => {
    for (const message of [
      "D1_EXEC_ERROR: database is locked",
      "D1_ERROR: Network connection lost",
      "D1_ERROR: storage quota exceeded",
      "unknown D1 failure",
    ]) {
      const unavailableDatabase = {
        prepare() {
          throw new Error(message);
        },
      } as unknown as D1Database;
      const error = await captureRejection(
        consumeFixedWindowBudget(unavailableDatabase, request()),
      );
      expect(error).toBeInstanceOf(RequestControlUnavailable);
      if (!(error instanceof RequestControlUnavailable)) {
        throw new Error("Expected RequestControlUnavailable");
      }
      expect(error.dependency).toBe("d1");
      expect(error.cause).toBeInstanceOf(Error);
    }
  });
});

describe("request actor privacy", () => {
  it("accepts only exact versioned tags or authenticated server identities", () => {
    expect(isRequestActorKey(sourceActor())).toBe(true);
    expect(isRequestActorKey(SERVER_ACTOR)).toBe(true);
    expect(isRequestActorKey("192.0.2.10")).toBe(false);
    expect(isRequestActorKey("2001:db8::10")).toBe(false);
    expect(isRequestActorKey(`v1..${HMAC_DIGEST}`)).toBe(false);
    expect(isRequestActorKey(`v1.${"x".repeat(33)}.${HMAC_DIGEST}`)).toBe(false);
    expect(isRequestActorKey(`v1.current.${"A".repeat(42)}`)).toBe(false);
    expect(isRequestActorKey("A".repeat(64))).toBe(false);
  });

  it("rejects raw addresses before D1 and through the SQL constraint", async () => {
    for (const actorKey of ["192.0.2.10", "2001:db8::10"]) {
      await expect(consumeFixedWindowBudget(env.DB, request({ actorKey })))
        .rejects.toThrow(/actorKey/);
      await expect(env.DB.prepare(
        `INSERT INTO request_budgets
           (actor_key, scope, window_start, request_count, expires_at)
         VALUES (?, 'publish-server', 0, 1, 60)`,
      ).bind(actorKey).run()).rejects.toThrow();
    }

    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM request_budgets",
    ).first<number>("count")).toBe(0);
    const columns = await env.DB.prepare(
      "PRAGMA table_info(request_budgets)",
    ).all<{ name: string }>();
    expect(columns.results.map((column) => column.name)).toEqual([
      "actor_key",
      "scope",
      "window_start",
      "request_count",
      "expires_at",
    ]);
  });

  it("keeps pseudonymous source tags out of authenticated daily budgets", async () => {
    await expect(consumeFixedWindowBudget(env.DB, request({
      actorKey: sourceActor("not-a-server"),
    }))).rejects.toThrow("authenticated server identity");
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM request_budgets",
    ).first<number>("count")).toBe(0);
  });
});

describe("request-control helpers", () => {
  it("computes UTC calendar days and bounded Retry-After values", () => {
    const noon = Math.floor(Date.parse("2026-08-08T12:34:56.000Z") / 1_000);
    const window = utcDayWindow(noon);
    expect(window).toEqual({
      startAt: Math.floor(Date.parse("2026-08-08T00:00:00.000Z") / 1_000),
      endAt: Math.floor(Date.parse("2026-08-09T00:00:00.000Z") / 1_000),
    });
    expect(boundedRetryAfter(window.endAt, noon)).toBe(41_104);
    expect(boundedRetryAfter(noon, noon)).toBe(1);
    expect(boundedRetryAfter(noon + 1_000_000, noon)).toBe(86_400);
  });

  it("wraps the native burst limiter with scoped keys and typed rejections", async () => {
    const observedKeys: string[] = [];
    const accepting: RateLimit = {
      async limit(options) {
        observedKeys.push(options.key);
        return { success: true };
      },
    };
    await enforceNativeBurst(
      accepting,
      sourceActor("burst"),
      "publish-server",
    );
    expect(observedKeys).toEqual([
      `publish-server.${sourceActor("burst")}`,
    ]);

    const rejecting: RateLimit = {
      async limit() {
        return { success: false };
      },
    };
    await expect(enforceNativeBurst(
      rejecting,
      SERVER_ACTOR,
      "global",
      10,
    )).rejects.toMatchObject({
      name: "RequestBudgetExceeded",
      reason: "burst_limit_exceeded",
      scope: "global",
      retryAfterSeconds: 10,
      resetAt: null,
      limit: null,
    });
  });

  it("checks native aliases in order with conservative partial charging", async () => {
    const current = sourceActor("native-current");
    const previous = sourceActor("native-previous");
    const observedKeys: string[] = [];
    const rejectingSecondAlias: RateLimit = {
      async limit(options) {
        observedKeys.push(options.key);
        return { success: observedKeys.length === 1 };
      },
    };

    await expect(enforceNativeBurstAliases(
      rejectingSecondAlias,
      [current, previous],
      "publish-server",
    )).rejects.toBeInstanceOf(RequestBudgetExceeded);
    expect(observedKeys).toEqual([
      `publish-server.${current}`,
      `publish-server.${previous}`,
    ]);

    const duplicateKeys: string[] = [];
    const accepting: RateLimit = {
      async limit(options) {
        duplicateKeys.push(options.key);
        return { success: true };
      },
    };
    await enforceNativeBurstAliases(
      accepting,
      [current, current],
      "publish-server",
    );
    expect(duplicateKeys).toEqual([`publish-server.${current}`]);
  });

  it("classifies native binding exceptions as temporary unavailability", async () => {
    const cause = new Error("simulated native binding failure");
    const unavailable: RateLimit = {
      async limit() {
        throw cause;
      },
    };

    const error = await captureRejection(enforceNativeBurst(
      unavailable,
      sourceActor("native-failure"),
      "publish-server",
    ));
    expect(error).toBeInstanceOf(RequestControlUnavailable);
    if (!(error instanceof RequestControlUnavailable)) {
      throw new Error("Expected RequestControlUnavailable");
    }
    expect(error.dependency).toBe("native-rate-limit");
    expect(error.cause).toBe(cause);
  });
});
