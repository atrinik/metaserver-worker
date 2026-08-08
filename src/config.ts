import { isCanonicalHostname } from "./hostname";

const MAXIMUM_RETRY_AFTER_SECONDS = 86_400;

export const REQUEST_CONTROL_POLICY_MAXIMUMS = Object.freeze({
  otpTtlSeconds: 300,
  listingTtlSeconds: 86_400,
  staleDataRetentionSeconds: 86_400,
  compatibilityStatusDaily: 100,
  compatibilityDirectoryDaily: 100,
  compatibilityOtpDaily: 48,
  compatibilityUpdateSourceDaily: 48,
  compatibilityUpdateServerDaily: 48,
  compatibilityRendezvousClientSourceDaily: 50,
  compatibilityRendezvousClientPairDaily: 10,
  compatibilityRendezvousServerSourceDaily: 50,
  compatibilityRendezvousServerDaily: 50,
} as const);

export interface RequestControlConfigurationInput {
  readonly COMPAT_HOSTNAME?: string;
  readonly OTP_TTL_SECONDS?: string;
  readonly LISTING_TTL_SECONDS?: string;
  readonly STALE_DATA_RETENTION_SECONDS?: string;
  readonly ROUTE_DISABLED_RETRY_SECONDS?: string;
  readonly COMPAT_STATUS_DAILY_LIMIT?: string;
  readonly COMPAT_DIRECTORY_DAILY_LIMIT?: string;
  readonly COMPAT_OTP_DAILY_LIMIT?: string;
  readonly COMPAT_UPDATE_SOURCE_DAILY_LIMIT?: string;
  readonly COMPAT_UPDATE_SERVER_DAILY_LIMIT?: string;
  readonly COMPAT_RENDEZVOUS_CLIENT_SOURCE_DAILY_LIMIT?: string;
  readonly COMPAT_RENDEZVOUS_CLIENT_PAIR_DAILY_LIMIT?: string;
  readonly COMPAT_RENDEZVOUS_SERVER_SOURCE_DAILY_LIMIT?: string;
  readonly COMPAT_RENDEZVOUS_SERVER_DAILY_LIMIT?: string;
}

export interface RequestControlConfiguration {
  readonly compatibilityHostname: string;
  readonly otpTtlSeconds: number;
  readonly listingTtlSeconds: number;
  readonly staleDataRetentionSeconds: number;
  readonly routeDisabledRetrySeconds: number;
  readonly compatibilityStatusDaily: number;
  readonly compatibilityDirectoryDaily: number;
  readonly compatibilityOtpDaily: number;
  readonly compatibilityUpdateSourceDaily: number;
  readonly compatibilityUpdateServerDaily: number;
  readonly compatibilityRendezvousClientSourceDaily: number;
  readonly compatibilityRendezvousClientPairDaily: number;
  readonly compatibilityRendezvousServerSourceDaily: number;
  readonly compatibilityRendezvousServerDaily: number;
}

export class RequestControlConfigurationError extends Error {
  constructor(readonly variable: string) {
    super(`Invalid request-control configuration: ${variable}`);
    this.name = "RequestControlConfigurationError";
  }
}

/**
 * Parse every request-control ceiling as one fail-closed configuration unit.
 * Values may be lowered for a canary, but configuration can never silently
 * raise the reviewed policy maximums.
 */
export function requestControlConfiguration(
  input: RequestControlConfigurationInput,
): RequestControlConfiguration {
  const compatibilityHostname = input.COMPAT_HOSTNAME;
  if (!isCanonicalHostname(compatibilityHostname)) {
    throw new RequestControlConfigurationError("COMPAT_HOSTNAME");
  }
  const listingTtlSeconds = strictInteger(
    input.LISTING_TTL_SECONDS,
    "LISTING_TTL_SECONDS",
    60,
    REQUEST_CONTROL_POLICY_MAXIMUMS.listingTtlSeconds,
  );
  const staleDataRetentionSeconds = strictInteger(
    input.STALE_DATA_RETENTION_SECONDS,
    "STALE_DATA_RETENTION_SECONDS",
    listingTtlSeconds,
    REQUEST_CONTROL_POLICY_MAXIMUMS.staleDataRetentionSeconds,
  );
  return Object.freeze({
    compatibilityHostname,
    otpTtlSeconds: strictInteger(
      input.OTP_TTL_SECONDS,
      "OTP_TTL_SECONDS",
      1,
      REQUEST_CONTROL_POLICY_MAXIMUMS.otpTtlSeconds,
    ),
    listingTtlSeconds,
    staleDataRetentionSeconds,
    routeDisabledRetrySeconds: strictInteger(
      input.ROUTE_DISABLED_RETRY_SECONDS,
      "ROUTE_DISABLED_RETRY_SECONDS",
      1,
      MAXIMUM_RETRY_AFTER_SECONDS,
    ),
    compatibilityStatusDaily: strictInteger(
      input.COMPAT_STATUS_DAILY_LIMIT,
      "COMPAT_STATUS_DAILY_LIMIT",
      1,
      REQUEST_CONTROL_POLICY_MAXIMUMS.compatibilityStatusDaily,
    ),
    compatibilityDirectoryDaily: strictInteger(
      input.COMPAT_DIRECTORY_DAILY_LIMIT,
      "COMPAT_DIRECTORY_DAILY_LIMIT",
      1,
      REQUEST_CONTROL_POLICY_MAXIMUMS.compatibilityDirectoryDaily,
    ),
    compatibilityOtpDaily: strictInteger(
      input.COMPAT_OTP_DAILY_LIMIT,
      "COMPAT_OTP_DAILY_LIMIT",
      1,
      REQUEST_CONTROL_POLICY_MAXIMUMS.compatibilityOtpDaily,
    ),
    compatibilityUpdateSourceDaily: strictInteger(
      input.COMPAT_UPDATE_SOURCE_DAILY_LIMIT,
      "COMPAT_UPDATE_SOURCE_DAILY_LIMIT",
      1,
      REQUEST_CONTROL_POLICY_MAXIMUMS.compatibilityUpdateSourceDaily,
    ),
    compatibilityUpdateServerDaily: strictInteger(
      input.COMPAT_UPDATE_SERVER_DAILY_LIMIT,
      "COMPAT_UPDATE_SERVER_DAILY_LIMIT",
      1,
      REQUEST_CONTROL_POLICY_MAXIMUMS.compatibilityUpdateServerDaily,
    ),
    compatibilityRendezvousClientSourceDaily: strictInteger(
      input.COMPAT_RENDEZVOUS_CLIENT_SOURCE_DAILY_LIMIT,
      "COMPAT_RENDEZVOUS_CLIENT_SOURCE_DAILY_LIMIT",
      1,
      REQUEST_CONTROL_POLICY_MAXIMUMS.compatibilityRendezvousClientSourceDaily,
    ),
    compatibilityRendezvousClientPairDaily: strictInteger(
      input.COMPAT_RENDEZVOUS_CLIENT_PAIR_DAILY_LIMIT,
      "COMPAT_RENDEZVOUS_CLIENT_PAIR_DAILY_LIMIT",
      1,
      REQUEST_CONTROL_POLICY_MAXIMUMS.compatibilityRendezvousClientPairDaily,
    ),
    compatibilityRendezvousServerSourceDaily: strictInteger(
      input.COMPAT_RENDEZVOUS_SERVER_SOURCE_DAILY_LIMIT,
      "COMPAT_RENDEZVOUS_SERVER_SOURCE_DAILY_LIMIT",
      1,
      REQUEST_CONTROL_POLICY_MAXIMUMS.compatibilityRendezvousServerSourceDaily,
    ),
    compatibilityRendezvousServerDaily: strictInteger(
      input.COMPAT_RENDEZVOUS_SERVER_DAILY_LIMIT,
      "COMPAT_RENDEZVOUS_SERVER_DAILY_LIMIT",
      1,
      REQUEST_CONTROL_POLICY_MAXIMUMS.compatibilityRendezvousServerDaily,
    ),
  });
}

function strictInteger(
  value: string | undefined,
  variable: string,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) {
    throw new RequestControlConfigurationError(variable);
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < minimum ||
    parsed > maximum
  ) {
    throw new RequestControlConfigurationError(variable);
  }
  return parsed;
}
