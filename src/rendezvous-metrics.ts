import { RENDEZVOUS_POLICY_MAXIMUMS } from "./config";
import {
  MAX_CLIENT_CANDIDATES,
  MAX_CLIENT_AUTHORIZATION_FRAMES,
  MAX_COMPLETIONS,
  MAX_RENDEZVOUS_SESSION_SIGNAL_BYTES,
  MAX_SERVER_CANDIDATES,
  MAX_SERVER_AUTHORIZATION_FRAMES,
  RENDEZVOUS_TERMINAL_OUTCOMES,
} from "./rendezvous-contract";
import type { RendezvousTerminalOutcome } from "./rendezvous-contract";

export { RENDEZVOUS_TERMINAL_OUTCOMES } from "./rendezvous-contract";
export type { RendezvousTerminalOutcome } from "./rendezvous-contract";

export const RENDEZVOUS_SESSION_METRICS_SCHEMA = "rendezvous-session-v2";

export interface RendezvousTerminalSummary {
  readonly outcome: RendezvousTerminalOutcome;
  readonly clientFramesAccepted: number;
  readonly serverFramesMatched: number;
  readonly framesForwarded: number;
  readonly signalBytes: number;
  readonly durationMs: number;
}

const MAX_CLIENT_FRAMES_ACCEPTED =
  MAX_CLIENT_AUTHORIZATION_FRAMES + MAX_CLIENT_CANDIDATES;
const MAX_SERVER_FRAMES_MATCHED =
  MAX_SERVER_AUTHORIZATION_FRAMES + MAX_SERVER_CANDIDATES + MAX_COMPLETIONS;
const MAX_FRAMES_FORWARDED =
  MAX_CLIENT_FRAMES_ACCEPTED + MAX_SERVER_FRAMES_MATCHED;
const MAX_DURATION_MS =
  RENDEZVOUS_POLICY_MAXIMUMS.rendezvousClientSessionSeconds * 1_000;

/**
 * Emits one bounded, low-cardinality terminal summary for an accepted client
 * rendezvous session. The schema deliberately has no field capable of
 * carrying a server, connection, network, or ticket identifier.
 */
export function writeRendezvousTerminalMetric(
  dataset: Pick<AnalyticsEngineDataset, "writeDataPoint">,
  summary: RendezvousTerminalSummary,
): void {
  const outcome = validatedOutcome(summary.outcome);
  dataset.writeDataPoint({
    indexes: [`${RENDEZVOUS_SESSION_METRICS_SCHEMA}:${outcome}`],
    blobs: [RENDEZVOUS_SESSION_METRICS_SCHEMA, outcome],
    doubles: [
      1,
      boundedInteger(summary.clientFramesAccepted, MAX_CLIENT_FRAMES_ACCEPTED),
      boundedInteger(summary.serverFramesMatched, MAX_SERVER_FRAMES_MATCHED),
      boundedInteger(summary.framesForwarded, MAX_FRAMES_FORWARDED),
      boundedInteger(summary.signalBytes, MAX_RENDEZVOUS_SESSION_SIGNAL_BYTES),
      boundedInteger(summary.durationMs, MAX_DURATION_MS),
    ],
  });
}

function validatedOutcome(
  value: RendezvousTerminalOutcome,
): RendezvousTerminalOutcome {
  return (RENDEZVOUS_TERMINAL_OUTCOMES as readonly unknown[]).includes(value)
    ? value
    : "internal_error";
}

function boundedInteger(value: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.min(maximum, Math.floor(value));
}
