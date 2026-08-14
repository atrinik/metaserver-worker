import { describe, expect, it } from "vitest";

import {
  CANONICAL_POLICY_MAXIMUMS,
  directoryArtifactConfiguration,
  publisherCoordinatorConfiguration,
  publisherEdgeConfiguration,
  rendezvousCoordinatorConfiguration,
  rendezvousEdgeConfiguration,
  rendezvousPolicyConfiguration,
  RequestControlConfigurationError,
  scheduledMaintenanceConfiguration,
} from "../src/config";

const rendezvousCoordinator = {
  RENDEZVOUS_HOSTNAME: "rendezvous.example.test",
  LISTING_TTL_SECONDS: "14400",
  ROUTE_DISABLED_RETRY_SECONDS: "300",
  RENDEZVOUS_CLIENT_PAIR_BURST_LIMIT: "20",
  RENDEZVOUS_CLIENT_PAIR_WINDOW_SECONDS: "60",
  RENDEZVOUS_CLIENT_PAIR_INITIAL_COOLDOWN_SECONDS: "30",
  RENDEZVOUS_CLIENT_PAIR_MAXIMUM_COOLDOWN_SECONDS: "900",
  RENDEZVOUS_CLIENT_PAIR_RESET_SECONDS: "1800",
  RENDEZVOUS_SERVER_DAILY_LIMIT: "50",
} as const;

describe("canonical configuration", () => {
  it("parses only the policy owned by each public edge", () => {
    expect(publisherEdgeConfiguration({
      PUBLISH_HOSTNAME: "publish.example.test",
      ROUTE_DISABLED_RETRY_SECONDS: "300",
    })).toEqual({
      authority: "publish.example.test",
      routeDisabledRetrySeconds: 300,
    });
    expect(rendezvousEdgeConfiguration({
      RENDEZVOUS_HOSTNAME: "rendezvous.example.test",
      ROUTE_DISABLED_RETRY_SECONDS: "60",
    })).toEqual({
      authority: "rendezvous.example.test",
      routeDisabledRetrySeconds: 60,
    });
  });

  it("parses canonical publisher, rendezvous, and maintenance policy", () => {
    expect(publisherCoordinatorConfiguration({
      PUBLISH_HOSTNAME: "publish.example.test",
      LISTING_TTL_SECONDS: "14400",
      PUBLISH_SERVER_DAILY_LIMIT: "48",
      ROUTE_DISABLED_RETRY_SECONDS: "300",
    })).toEqual({
      authority: "publish.example.test",
      listingTtlSeconds: 14_400,
      publishServerDaily: 48,
      routeDisabledRetrySeconds: 300,
    });
    expect(rendezvousCoordinatorConfiguration(rendezvousCoordinator)).toEqual({
      authority: "rendezvous.example.test",
      listingTtlSeconds: 14_400,
      routeDisabledRetrySeconds: 300,
      rendezvousClientPairBurstLimit: 20,
      rendezvousClientPairWindowSeconds: 60,
      rendezvousClientPairInitialCooldownSeconds: 30,
      rendezvousClientPairMaximumCooldownSeconds: 900,
      rendezvousClientPairResetSeconds: 1_800,
      rendezvousServerDaily: 50,
    });
    expect(scheduledMaintenanceConfiguration({
      LISTING_TTL_SECONDS: "14400",
    })).toEqual({ listingTtlSeconds: 14_400 });
    expect(Object.keys(CANONICAL_POLICY_MAXIMUMS).sort()).toEqual([
      "listingTtlSeconds",
      "publishServerDaily",
      "rendezvousServerDaily",
    ]);
  });

  it("fails closed for missing, malformed, or raised canonical limits", () => {
    for (const [variable, value] of [
      ["RENDEZVOUS_CLIENT_PAIR_BURST_LIMIT", undefined],
      ["RENDEZVOUS_CLIENT_PAIR_BURST_LIMIT", "21"],
      ["RENDEZVOUS_CLIENT_PAIR_WINDOW_SECONDS", "61"],
      ["RENDEZVOUS_CLIENT_PAIR_INITIAL_COOLDOWN_SECONDS", "31"],
      ["RENDEZVOUS_CLIENT_PAIR_MAXIMUM_COOLDOWN_SECONDS", "901"],
      ["RENDEZVOUS_CLIENT_PAIR_RESET_SECONDS", "1801"],
      ["RENDEZVOUS_SERVER_DAILY_LIMIT", "51"],
    ] as const) {
      expect(() => rendezvousCoordinatorConfiguration({
        ...rendezvousCoordinator,
        [variable]: value,
      })).toThrowError(expect.objectContaining({ variable }));
    }
    expect(() => rendezvousCoordinatorConfiguration({
      ...rendezvousCoordinator,
      RENDEZVOUS_CLIENT_PAIR_MAXIMUM_COOLDOWN_SECONDS: "29",
    })).toThrowError(expect.objectContaining({
      variable: "RENDEZVOUS_CLIENT_PAIR_MAXIMUM_COOLDOWN_SECONDS",
    }));
  });

  it("rejects invalid authorities and retry policy", () => {
    for (const value of [undefined, "PUBLISH.example.test", "192.0.2.1"]) {
      expect(() => publisherEdgeConfiguration({
        PUBLISH_HOSTNAME: value,
        ROUTE_DISABLED_RETRY_SECONDS: "300",
      })).toThrowError(RequestControlConfigurationError);
    }
    for (const value of [undefined, "0", " 300", "86401"]) {
      expect(() => publisherEdgeConfiguration({
        PUBLISH_HOSTNAME: "publish.example.test",
        ROUTE_DISABLED_RETRY_SECONDS: value,
      })).toThrowError(expect.objectContaining({
        variable: "ROUTE_DISABLED_RETRY_SECONDS",
      }));
    }
  });
});

describe("rendezvous room and directory artifact configuration", () => {
  it("keeps bounded room and artifact policy", () => {
    expect(rendezvousPolicyConfiguration({
      RENDEZVOUS_ACTIVE_CLIENT_LIMIT: "16",
      RENDEZVOUS_CLIENT_SESSION_SECONDS: "15",
    })).toEqual({
      rendezvousActiveClientLimit: 16,
      rendezvousClientSessionSeconds: 15,
    });
    expect(directoryArtifactConfiguration({
      CLASSIC_DIRECTORY_CUTOVER_MODE: "v4-production",
      LISTING_TTL_SECONDS: "86400",
      DIRECTORY_REFRESH_LEAD_SECONDS: "7200",
    })).toEqual({
      classicDirectoryCutoverMode: "v4-production",
      listingTtlSeconds: 86_400,
      artifactLifetimeSeconds: 14_400,
      refreshLeadSeconds: 7_200,
    });
  });

  it("rejects incoherent room and artifact bounds", () => {
    expect(() => rendezvousPolicyConfiguration({
      RENDEZVOUS_ACTIVE_CLIENT_LIMIT: "17",
      RENDEZVOUS_CLIENT_SESSION_SECONDS: "15",
    })).toThrowError(expect.objectContaining({
      variable: "RENDEZVOUS_ACTIVE_CLIENT_LIMIT",
    }));
    expect(() => directoryArtifactConfiguration({
      CLASSIC_DIRECTORY_CUTOVER_MODE: "v4-production",
      LISTING_TTL_SECONDS: "960",
      DIRECTORY_REFRESH_LEAD_SECONDS: "61",
    })).toThrowError(expect.objectContaining({
      variable: "DIRECTORY_REFRESH_LEAD_SECONDS",
    }));
    expect(() => directoryArtifactConfiguration({
      CLASSIC_DIRECTORY_CUTOVER_MODE: "canary",
      LISTING_TTL_SECONDS: "86400",
      DIRECTORY_REFRESH_LEAD_SECONDS: "7200",
    })).toThrowError(expect.objectContaining({
      variable: "CLASSIC_DIRECTORY_CUTOVER_MODE",
    }));
  });
});
