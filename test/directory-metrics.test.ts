import { describe, expect, it, vi } from "vitest";

import {
  DIRECTORY_BUILD_METRICS_SCHEMA,
  DIRECTORY_BUILD_OUTCOMES,
  writeDirectoryBuildMetric,
} from "../src/directory-metrics";
import type { DirectoryBuildSummary } from "../src/directory-metrics";

describe("directory builder metrics", () => {
  it.each(["classic-v1", "game-v1"] as const)(
    "uses only bounded labels for %s",
    (profile) => {
      for (const outcome of DIRECTORY_BUILD_OUTCOMES) {
        const writeDataPoint = vi.fn<AnalyticsEngineDataset["writeDataPoint"]>();
        writeDirectoryBuildMetric({ writeDataPoint }, {
          profile,
          outcome,
          durationMs: 12.9,
          cleanupDeleted: 3,
          cleanupDeferred: false,
        });
        expect(writeDataPoint).toHaveBeenCalledExactlyOnceWith({
          indexes: [
            `${DIRECTORY_BUILD_METRICS_SCHEMA}:${profile}:${outcome}:current`,
          ],
          blobs: [DIRECTORY_BUILD_METRICS_SCHEMA, profile, outcome, "current"],
          doubles: [1, 12, 3],
        });
      }
    },
  );

  it("fails closed and bounds malformed runtime values", () => {
    const writeDataPoint = vi.fn<AnalyticsEngineDataset["writeDataPoint"]>();
    writeDirectoryBuildMetric({ writeDataPoint }, {
      profile: "server=secret.example" as never,
      outcome: "generation=123" as never,
      durationMs: Number.POSITIVE_INFINITY,
      cleanupDeleted: Number.POSITIVE_INFINITY,
      cleanupDeferred: true,
    } as DirectoryBuildSummary);
    expect(writeDataPoint).toHaveBeenCalledExactlyOnceWith({
      indexes: ["directory-build-v1:classic-v1:failed:deferred"],
      blobs: ["directory-build-v1", "classic-v1", "failed", "deferred"],
      doubles: [1, 0, 0],
    });

    writeDirectoryBuildMetric({ writeDataPoint }, {
      profile: "game-v1",
      outcome: "published",
      durationMs: 500_000.9,
      cleanupDeleted: 65,
      cleanupDeferred: false,
    });
    expect(writeDataPoint).toHaveBeenLastCalledWith({
      indexes: ["directory-build-v1:game-v1:published:current"],
      blobs: ["directory-build-v1", "game-v1", "published", "current"],
      doubles: [1, 300_000, 64],
    });
  });
});
