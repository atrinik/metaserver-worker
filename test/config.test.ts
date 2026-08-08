import { describe, expect, it } from "vitest";

import {
  rendezvousPolicyConfiguration,
  requestControlConfiguration,
  RequestControlConfigurationError,
} from "../src/config";
import type {
  RendezvousPolicyConfigurationInput,
  RequestControlConfigurationInput,
} from "../src/config";

const validRendezvousPolicy = {
  RENDEZVOUS_CLIENT_ROLLING_LIMIT: "50",
  RENDEZVOUS_ACTIVE_CLIENT_LIMIT: "16",
  RENDEZVOUS_CLIENT_SESSION_SECONDS: "15",
} satisfies RendezvousPolicyConfigurationInput;

const valid: RequestControlConfigurationInput &
  RendezvousPolicyConfigurationInput = {
  ...validRendezvousPolicy,
  COMPAT_HOSTNAME: "meta.example.test",
  OTP_TTL_SECONDS: "120",
  LISTING_TTL_SECONDS: "14400",
  STALE_DATA_RETENTION_SECONDS: "18000",
  ROUTE_DISABLED_RETRY_SECONDS: "300",
  COMPAT_STATUS_DAILY_LIMIT: "100",
  COMPAT_DIRECTORY_DAILY_LIMIT: "100",
  COMPAT_OTP_DAILY_LIMIT: "48",
  COMPAT_UPDATE_SOURCE_DAILY_LIMIT: "48",
  COMPAT_UPDATE_SERVER_DAILY_LIMIT: "48",
  COMPAT_RENDEZVOUS_CLIENT_SOURCE_DAILY_LIMIT: "50",
  COMPAT_RENDEZVOUS_CLIENT_PAIR_DAILY_LIMIT: "10",
  COMPAT_RENDEZVOUS_SERVER_SOURCE_DAILY_LIMIT: "50",
  COMPAT_RENDEZVOUS_SERVER_DAILY_LIMIT: "50",
};

describe("rendezvous policy configuration", () => {
  it("accepts the reviewed maxima and minimum canary boundaries", () => {
    const maxima = rendezvousPolicyConfiguration(validRendezvousPolicy);
    expect(maxima).toEqual({
      rendezvousClientRollingLimit: 50,
      rendezvousActiveClientLimit: 16,
      rendezvousClientSessionSeconds: 15,
    });
    expect(Object.isFrozen(maxima)).toBe(true);

    expect(rendezvousPolicyConfiguration({
      RENDEZVOUS_CLIENT_ROLLING_LIMIT: "1",
      RENDEZVOUS_ACTIVE_CLIENT_LIMIT: "1",
      RENDEZVOUS_CLIENT_SESSION_SECONDS: "1",
    })).toEqual({
      rendezvousClientRollingLimit: 1,
      rendezvousActiveClientLimit: 1,
      rendezvousClientSessionSeconds: 1,
    });
  });

  it("fails closed for missing, malformed, zero, or policy-raising values", () => {
    for (const [variable, value] of [
      ["RENDEZVOUS_CLIENT_ROLLING_LIMIT", undefined],
      ["RENDEZVOUS_CLIENT_ROLLING_LIMIT", ""],
      ["RENDEZVOUS_CLIENT_ROLLING_LIMIT", "0"],
      ["RENDEZVOUS_CLIENT_ROLLING_LIMIT", "51"],
      ["RENDEZVOUS_ACTIVE_CLIENT_LIMIT", undefined],
      ["RENDEZVOUS_ACTIVE_CLIENT_LIMIT", "16.0"],
      ["RENDEZVOUS_ACTIVE_CLIENT_LIMIT", "17"],
      ["RENDEZVOUS_CLIENT_SESSION_SECONDS", undefined],
      ["RENDEZVOUS_CLIENT_SESSION_SECONDS", " 15"],
      ["RENDEZVOUS_CLIENT_SESSION_SECONDS", "16"],
    ] as const) {
      expect(() => rendezvousPolicyConfiguration({
        ...validRendezvousPolicy,
        [variable]: value,
      })).toThrowError(expect.objectContaining({
        name: "RequestControlConfigurationError",
        variable,
      } satisfies Partial<RequestControlConfigurationError>));
    }
  });
});

describe("request-control configuration", () => {
  it("accepts the reviewed maxima and canary reductions", () => {
    expect(requestControlConfiguration(valid)).toMatchObject({
      compatibilityHostname: "meta.example.test",
      otpTtlSeconds: 120,
      listingTtlSeconds: 14_400,
      staleDataRetentionSeconds: 18_000,
      routeDisabledRetrySeconds: 300,
      compatibilityStatusDaily: 100,
      compatibilityDirectoryDaily: 100,
      compatibilityRendezvousClientPairDaily: 10,
      compatibilityRendezvousServerSourceDaily: 50,
    });
    expect(requestControlConfiguration({
      ...valid,
      COMPAT_DIRECTORY_DAILY_LIMIT: "8",
      COMPAT_RENDEZVOUS_SERVER_SOURCE_DAILY_LIMIT: "8",
    })).toMatchObject({
      compatibilityDirectoryDaily: 8,
      compatibilityRendezvousServerSourceDaily: 8,
    });
  });

  it("does not couple non-rendezvous routes to room-only policy", () => {
    const {
      RENDEZVOUS_CLIENT_ROLLING_LIMIT: _rolling,
      RENDEZVOUS_ACTIVE_CLIENT_LIMIT: _active,
      RENDEZVOUS_CLIENT_SESSION_SECONDS: _session,
      ...requestControlOnly
    } = valid;
    expect(requestControlConfiguration(requestControlOnly)).toMatchObject({
      compatibilityHostname: "meta.example.test",
      compatibilityStatusDaily: 100,
    });
  });

  it("fails closed for missing, malformed, zero, or policy-raising values", () => {
    for (const [variable, value] of [
      ["COMPAT_HOSTNAME", undefined],
      ["COMPAT_HOSTNAME", "META.EXAMPLE.TEST"],
      ["COMPAT_HOSTNAME", "localhost"],
      ["COMPAT_HOSTNAME", "meta.example.test:443"],
      ["COMPAT_STATUS_DAILY_LIMIT", undefined],
      ["OTP_TTL_SECONDS", "301"],
      ["LISTING_TTL_SECONDS", "59"],
      ["STALE_DATA_RETENTION_SECONDS", "14399"],
      ["COMPAT_DIRECTORY_DAILY_LIMIT", "1000"],
      ["COMPAT_OTP_DAILY_LIMIT", "0"],
      ["COMPAT_UPDATE_SOURCE_DAILY_LIMIT", " 48"],
      ["COMPAT_UPDATE_SERVER_DAILY_LIMIT", "48.0"],
      ["COMPAT_RENDEZVOUS_CLIENT_SOURCE_DAILY_LIMIT", "+50"],
      ["COMPAT_RENDEZVOUS_CLIENT_PAIR_DAILY_LIMIT", "11"],
      ["COMPAT_RENDEZVOUS_SERVER_SOURCE_DAILY_LIMIT", "51"],
      ["COMPAT_RENDEZVOUS_SERVER_DAILY_LIMIT", "51"],
      ["ROUTE_DISABLED_RETRY_SECONDS", "86401"],
    ] as const) {
      expect(() => requestControlConfiguration({
        ...valid,
        [variable]: value,
      })).toThrowError(expect.objectContaining({
        name: "RequestControlConfigurationError",
        variable,
      } satisfies Partial<RequestControlConfigurationError>));
    }
  });
});
