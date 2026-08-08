import { describe, expect, it } from "vitest";

import {
  requestControlConfiguration,
  RequestControlConfigurationError,
} from "../src/config";
import type { RequestControlConfigurationInput } from "../src/config";

const valid: RequestControlConfigurationInput = {
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
