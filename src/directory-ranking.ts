/** Version the private scoring policy independently of public artifact schemas. */
export const DIRECTORY_RANKING_SCHEMA = "atrinik-directory-ranking-v1";
export const DIRECTORY_ACTIVITY_WINDOW_SECONDS = 7 * 24 * 60 * 60;
export const DIRECTORY_ACTIVITY_BUCKET_SECONDS = 24 * 60 * 60;
export const DIRECTORY_ACTIVITY_WINDOW_BUCKETS =
  DIRECTORY_ACTIVITY_WINDOW_SECONDS / DIRECTORY_ACTIVITY_BUCKET_SECONDS;
// The inclusive current bucket means a seven-day rolling query can contain
// the current partial day plus the seven preceding daily buckets.
export const DIRECTORY_ACTIVITY_MAX_BUCKETS =
  DIRECTORY_ACTIVITY_WINDOW_BUCKETS + 1;
export const DIRECTORY_ACTIVITY_MAX_GAP_SECONDS = 15 * 60;
export const DIRECTORY_ACTIVITY_MAX_POPULATION = 100_000;
export const DIRECTORY_ACTIVITY_MAX_SCORE = 1_000_000;
export const DIRECTORY_PIN_MAX_PRIORITY = 1_000;

export interface DirectoryActivityState {
  readonly lastObservedAt: number;
  readonly lastPositiveObservedAt: number | null;
  readonly lastPopulation: number;
  readonly observationCount: number;
}

export interface DirectoryActivityBucket {
  readonly bucketStart: number;
  readonly positiveSeconds: number;
  readonly playerMinutes: number;
  readonly maxPopulation: number;
  readonly positiveObservations: number;
  readonly zeroObservations: number;
}

export interface DirectoryAdminPin {
  readonly priority: number;
  readonly expiresAt: number | null;
}

export interface DirectoryRankingInput {
  readonly serverId: string;
  readonly currentPopulation: number;
  readonly lastSeen: number;
  readonly activityState: DirectoryActivityState | undefined;
  readonly activityBuckets: readonly DirectoryActivityBucket[];
  readonly adminPin: DirectoryAdminPin | undefined;
}

/**
 * Calculate a bounded score from aggregate evidence only.  Player-minutes
 * reward population sustained over time, positive seconds reward continuity,
 * active days reward consistency, and the final freshness factor from the last
 * positive observation decays old evidence inside the rolling window. A single
 * fresh positive observation receives score 1 so a new server is discoverable
 * while its history warms; zero-only state has no positive score.
 */
export function directoryActivityScore(
  input: DirectoryRankingInput,
  now: number,
): number {
  if (input.activityState === undefined) {
    return 0;
  }
  const state = input.activityState;
  if (state.lastPositiveObservedAt === null) {
    return input.currentPopulation > 0 && state.observationCount > 0 ? 1 : 0;
  }
  const age = Math.max(0, now - state.lastPositiveObservedAt);
  if (age > DIRECTORY_ACTIVITY_WINDOW_SECONDS) {
    return 0;
  }
  if (state.observationCount === 1) {
    return input.currentPopulation > 0 ? 1 : 0;
  }
  const positiveSeconds = Math.min(
    DIRECTORY_ACTIVITY_WINDOW_SECONDS,
    input.activityBuckets.reduce(
      (total, bucket) => total + Math.max(0, bucket.positiveSeconds),
      0,
    ),
  );
  const playerMinutes = Math.min(
    DIRECTORY_ACTIVITY_WINDOW_SECONDS * DIRECTORY_ACTIVITY_MAX_POPULATION / 60,
    input.activityBuckets.reduce(
      (total, bucket) => total + Math.max(0, bucket.playerMinutes),
      0,
    ),
  );
  const activeDays = Math.min(
    DIRECTORY_ACTIVITY_WINDOW_BUCKETS,
    input.activityBuckets.filter((bucket) => bucket.positiveObservations > 0)
      .length,
  );
  const durationComponent = positiveSeconds /
    DIRECTORY_ACTIVITY_WINDOW_SECONDS;
  const populationComponent = playerMinutes /
    (DIRECTORY_ACTIVITY_WINDOW_SECONDS * DIRECTORY_ACTIVITY_MAX_POPULATION / 60);
  const consistencyComponent = activeDays / DIRECTORY_ACTIVITY_WINDOW_BUCKETS;
  const base = (
    durationComponent * 45 +
    populationComponent * 35 +
    consistencyComponent * 20
  ) / 100;
  const freshness = Math.max(
    0,
    (DIRECTORY_ACTIVITY_WINDOW_SECONDS - age) /
      DIRECTORY_ACTIVITY_WINDOW_SECONDS,
  );
  const score = Math.floor(
    base * freshness * DIRECTORY_ACTIVITY_MAX_SCORE,
  );
  if (
    score === 0 &&
    age < DIRECTORY_ACTIVITY_WINDOW_SECONDS &&
    input.currentPopulation > 0 &&
    state.observationCount > 0
  ) {
    return 1;
  }
  return Math.min(DIRECTORY_ACTIVITY_MAX_SCORE, score);
}

/**
 * Return the complete public entry set in one deterministic policy order.
 * Pins are considered only as an ordering hint: eligibility is established by
 * the caller's public-entry query, so a pin cannot resurrect private, expired,
 * malformed, or denied state.
 */
export function rankDirectoryEntries<T extends DirectoryRankingInput>(
  entries: readonly T[],
  now: number,
): readonly T[] {
  return entries
    .map((entry, index) => ({
      entry,
      index,
      pinned: activePin(entry.adminPin, now),
      score: directoryActivityScore(entry, now),
      population: Math.min(
        DIRECTORY_ACTIVITY_MAX_POPULATION,
        Math.max(0, entry.currentPopulation),
      ),
    }))
    .sort((left, right) => {
      if (left.pinned !== undefined || right.pinned !== undefined) {
        if (left.pinned === undefined) return 1;
        if (right.pinned === undefined) return -1;
        if (left.pinned.priority !== right.pinned.priority) {
          return left.pinned.priority - right.pinned.priority;
        }
      }
      if (left.score !== right.score) return right.score - left.score;
      if (left.population !== right.population) {
        return right.population - left.population;
      }
      if (left.entry.lastSeen !== right.entry.lastSeen) {
        return right.entry.lastSeen - left.entry.lastSeen;
      }
      if (left.entry.serverId < right.entry.serverId) return -1;
      if (left.entry.serverId > right.entry.serverId) return 1;
      return left.index - right.index;
    })
    .map(({ entry }) => entry);
}

function activePin(
  pin: DirectoryAdminPin | undefined,
  now: number,
): DirectoryAdminPin | undefined {
  return pin !== undefined && (pin.expiresAt === null || pin.expiresAt > now)
    ? pin
    : undefined;
}
