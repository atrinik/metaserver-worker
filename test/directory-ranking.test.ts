import { describe, expect, it } from "vitest";

import {
  DIRECTORY_ACTIVITY_MAX_SCORE,
  DIRECTORY_ACTIVITY_WINDOW_SECONDS,
  directoryActivityScore,
  rankDirectoryEntries,
} from "../src/directory-ranking";

const NOW = 1_000_000;

function entry(
  serverId: string,
  overrides: Partial<{
    currentPopulation: number;
    lastSeen: number;
    activityState: {
      lastObservedAt: number;
      lastPositiveObservedAt: number | null;
      lastPopulation: number;
      observationCount: number;
    };
    activityBuckets: Array<{
      bucketStart: number;
      positiveSeconds: number;
      playerMinutes: number;
      maxPopulation: number;
      positiveObservations: number;
      zeroObservations: number;
    }>;
    adminPin: { priority: number; expiresAt: number | null };
  }> = {},
) {
  return {
    serverId,
    currentPopulation: 0,
    lastSeen: NOW,
    activityState: undefined,
    activityBuckets: [],
    adminPin: undefined,
    ...overrides,
  };
}

describe("directory activity ranking", () => {
  it("weights sustained population and keeps the score bounded", () => {
    const sustained = entry("a".repeat(64), {
      currentPopulation: 4,
      activityState: {
        lastObservedAt: NOW,
        lastPositiveObservedAt: NOW,
        lastPopulation: 4,
        observationCount: 2,
      },
      activityBuckets: [{
        bucketStart: NOW - (NOW % 86400),
        positiveSeconds: DIRECTORY_ACTIVITY_WINDOW_SECONDS,
        playerMinutes: DIRECTORY_ACTIVITY_WINDOW_SECONDS * 100_000 / 60,
        maxPopulation: 100_000,
        positiveObservations: 10,
        zeroObservations: 0,
      }],
    });
    expect(directoryActivityScore(sustained, NOW)).toBeLessThanOrEqual(
      DIRECTORY_ACTIVITY_MAX_SCORE,
    );
    expect(directoryActivityScore(sustained, NOW)).toBeGreaterThan(0);
  });

  it("orders active pins, score, population, freshness, then identity", () => {
    const sustained = entry("a".repeat(64), {
      currentPopulation: 2,
      activityState: {
        lastObservedAt: NOW,
        lastPositiveObservedAt: NOW,
        lastPopulation: 2,
        observationCount: 2,
      },
      activityBuckets: [{
        bucketStart: NOW - (NOW % 86400),
        positiveSeconds: 900,
        playerMinutes: 30,
        maxPopulation: 2,
        positiveObservations: 2,
        zeroObservations: 0,
      }],
    });
    const sameScoreEarlierIdentity = entry("0".repeat(64), {
      currentPopulation: 2,
      activityState: sustained.activityState,
      activityBuckets: sustained.activityBuckets,
    });
    const pinned = entry("f".repeat(64), {
      currentPopulation: 0,
      adminPin: { priority: 10, expiresAt: null },
    });
    const expiredPin = entry("e".repeat(64), {
      currentPopulation: 100,
      adminPin: { priority: 0, expiresAt: NOW },
    });

    expect(rankDirectoryEntries([
      sustained,
      sameScoreEarlierIdentity,
      pinned,
      expiredPin,
    ], NOW).map(({ serverId }) => serverId)).toEqual([
      pinned.serverId,
      sameScoreEarlierIdentity.serverId,
      sustained.serverId,
      expiredPin.serverId,
    ]);
  });

  it("decays evidence after the rolling window and gives cold starts a floor", () => {
    const old = entry("a".repeat(64), {
      currentPopulation: 10,
      activityState: {
        lastObservedAt: NOW - DIRECTORY_ACTIVITY_WINDOW_SECONDS - 1,
        lastPositiveObservedAt: NOW - DIRECTORY_ACTIVITY_WINDOW_SECONDS - 1,
        lastPopulation: 10,
        observationCount: 2,
      },
      activityBuckets: [{
        bucketStart: 0,
        positiveSeconds: 600,
        playerMinutes: 100,
        maxPopulation: 10,
        positiveObservations: 2,
        zeroObservations: 0,
      }],
    });
    const cold = entry("b".repeat(64), {
      currentPopulation: 1,
      activityState: {
        lastObservedAt: NOW,
        lastPositiveObservedAt: NOW,
        lastPopulation: 1,
        observationCount: 1,
      },
      activityBuckets: [{
        bucketStart: NOW - (NOW % 86400),
        positiveSeconds: 0,
        playerMinutes: 0,
        maxPopulation: 1,
        positiveObservations: 1,
        zeroObservations: 0,
      }],
    });
    const zeroRefreshed = entry("c".repeat(64), {
      activityState: {
        lastObservedAt: NOW,
        lastPositiveObservedAt: NOW - DIRECTORY_ACTIVITY_WINDOW_SECONDS,
        lastPopulation: 0,
        observationCount: 2,
      },
      activityBuckets: [{
        bucketStart: NOW - (NOW % 86400),
        positiveSeconds: 600,
        playerMinutes: 100,
        maxPopulation: 10,
        positiveObservations: 2,
        zeroObservations: 5,
      }],
    });
    const boundary = entry("d".repeat(64), {
      currentPopulation: 1,
      activityState: {
        lastObservedAt: NOW - DIRECTORY_ACTIVITY_WINDOW_SECONDS,
        lastPositiveObservedAt: NOW - DIRECTORY_ACTIVITY_WINDOW_SECONDS,
        lastPopulation: 1,
        observationCount: 2,
      },
      activityBuckets: [{
        bucketStart: 0,
        positiveSeconds: 600,
        playerMinutes: 10,
        maxPopulation: 1,
        positiveObservations: 2,
        zeroObservations: 0,
      }],
    });
    expect(directoryActivityScore(old, NOW)).toBe(0);
    expect(directoryActivityScore(cold, NOW)).toBe(1);
    expect(directoryActivityScore(zeroRefreshed, NOW)).toBe(0);
    expect(directoryActivityScore(boundary, NOW)).toBe(0);
  });
});
