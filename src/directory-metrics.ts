import { DIRECTORY_PROFILES } from "./directory-state";
import type { DirectoryProfile } from "./directory-state";

export const DIRECTORY_BUILD_METRICS_SCHEMA = "directory-build-v1";
export const DIRECTORY_BUILD_OUTCOMES = [
  "current",
  "published",
  "purge-pending",
  "failed",
] as const;

export type DirectoryBuildOutcome = typeof DIRECTORY_BUILD_OUTCOMES[number];

export interface DirectoryBuildSummary {
  readonly profile: DirectoryProfile;
  readonly outcome: DirectoryBuildOutcome;
  readonly durationMs: number;
  readonly cleanupDeleted: number;
  readonly cleanupDeferred: boolean;
}

const MAX_DIRECTORY_BUILD_DURATION_MS = 300_000;
const MAX_DIRECTORY_CLEANUP_DELETES = 64;

/**
 * Emit one bounded, low-cardinality summary for a builder invocation. The
 * schema has no field capable of carrying a server identity, generation,
 * revision, hostname, artifact digest, or network identifier.
 */
export function writeDirectoryBuildMetric(
  dataset: Pick<AnalyticsEngineDataset, "writeDataPoint">,
  summary: DirectoryBuildSummary,
): void {
  const profile = validatedProfile(summary.profile);
  const outcome = validatedOutcome(summary.outcome);
  const cleanup = summary.cleanupDeferred === true ? "deferred" : "current";
  dataset.writeDataPoint({
    indexes: [
      `${DIRECTORY_BUILD_METRICS_SCHEMA}:${profile}:${outcome}:${cleanup}`,
    ],
    blobs: [DIRECTORY_BUILD_METRICS_SCHEMA, profile, outcome, cleanup],
    doubles: [
      1,
      boundedDuration(summary.durationMs),
      boundedInteger(summary.cleanupDeleted, MAX_DIRECTORY_CLEANUP_DELETES),
    ],
  });
}

function validatedProfile(value: DirectoryProfile): DirectoryProfile {
  return (DIRECTORY_PROFILES as readonly unknown[]).includes(value)
    ? value
    : "classic-v1";
}

function validatedOutcome(value: DirectoryBuildOutcome): DirectoryBuildOutcome {
  return (DIRECTORY_BUILD_OUTCOMES as readonly unknown[]).includes(value)
    ? value
    : "failed";
}

function boundedDuration(value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.min(MAX_DIRECTORY_BUILD_DURATION_MS, Math.floor(value));
}

function boundedInteger(value: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return 0;
  }
  return Math.min(maximum, value);
}
