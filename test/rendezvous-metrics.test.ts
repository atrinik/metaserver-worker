import { describe, expect, it, vi } from "vitest";

import {
  RENDEZVOUS_SESSION_METRICS_SCHEMA,
  RENDEZVOUS_TERMINAL_OUTCOMES,
  writeRendezvousTerminalMetric,
} from "../src/rendezvous-metrics";
import type {
  RendezvousTerminalOutcome,
  RendezvousTerminalSummary,
} from "../src/rendezvous-metrics";

function summary(
  outcome: RendezvousTerminalOutcome,
): RendezvousTerminalSummary {
  return {
    outcome,
    clientFramesAccepted: 1,
    serverFramesMatched: 13,
    framesForwarded: 14,
    signalBytes: 7_168,
    durationMs: 15_000,
  };
}

function recordingDataset() {
  const writeDataPoint = vi.fn<AnalyticsEngineDataset["writeDataPoint"]>();
  return {
    dataset: { writeDataPoint },
    writeDataPoint,
  };
}

describe("rendezvous terminal metrics", () => {
  it.each(RENDEZVOUS_TERMINAL_OUTCOMES)(
    "writes the exact privacy-safe schema for %s",
    (outcome) => {
      const { dataset, writeDataPoint } = recordingDataset();

      writeRendezvousTerminalMetric(dataset, summary(outcome));

      expect(writeDataPoint).toHaveBeenCalledTimes(1);
      expect(writeDataPoint).toHaveBeenCalledWith({
        indexes: [`${RENDEZVOUS_SESSION_METRICS_SCHEMA}:${outcome}`],
        blobs: [RENDEZVOUS_SESSION_METRICS_SCHEMA, outcome],
        doubles: [1, 1, 13, 14, 7_168, 15_000],
      });
    },
  );

  it("floors fractional values and clamps every dimension to its reviewed cap", () => {
    const { dataset, writeDataPoint } = recordingDataset();

    writeRendezvousTerminalMetric(dataset, {
      outcome: "completed",
      clientFramesAccepted: 2.9,
      serverFramesMatched: 14.9,
      framesForwarded: 15.9,
      signalBytes: 8_000.9,
      durationMs: 20_000.9,
    });

    expect(writeDataPoint).toHaveBeenCalledExactlyOnceWith({
      indexes: ["rendezvous-session-v1:completed"],
      blobs: ["rendezvous-session-v1", "completed"],
      doubles: [1, 1, 13, 14, 7_168, 15_000],
    });
  });

  it("normalizes malformed numeric dimensions without omitting the summary", () => {
    const { dataset, writeDataPoint } = recordingDataset();
    const malformed = {
      outcome: "completed",
      clientFramesAccepted: Number.NaN,
      serverFramesMatched: Number.POSITIVE_INFINITY,
      framesForwarded: -1,
      signalBytes: "512",
      durationMs: null,
    } as unknown as RendezvousTerminalSummary;

    writeRendezvousTerminalMetric(dataset, malformed);

    expect(writeDataPoint).toHaveBeenCalledExactlyOnceWith({
      indexes: ["rendezvous-session-v1:completed"],
      blobs: ["rendezvous-session-v1", "completed"],
      doubles: [1, 0, 0, 0, 0, 0],
    });
  });

  it("maps a runtime-invalid outcome to the closed internal-error bucket", () => {
    const { dataset, writeDataPoint } = recordingDataset();
    const malformed = {
      ...summary("completed"),
      outcome: "server=example.test;ticket=secret",
    } as unknown as RendezvousTerminalSummary;

    writeRendezvousTerminalMetric(dataset, malformed);

    expect(writeDataPoint).toHaveBeenCalledExactlyOnceWith({
      indexes: ["rendezvous-session-v1:internal_error"],
      blobs: ["rendezvous-session-v1", "internal_error"],
      doubles: [1, 1, 13, 14, 7_168, 15_000],
    });
  });
});
