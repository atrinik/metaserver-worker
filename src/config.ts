import { isCanonicalHostname } from "./hostname";

const MAXIMUM_RETRY_AFTER_SECONDS = 86_400;

export const RENDEZVOUS_POLICY_MAXIMUMS = Object.freeze({
  rendezvousClientRollingLimit: 50,
  rendezvousActiveClientLimit: 16,
  rendezvousClientSessionSeconds: 15,
} as const);

export const REQUEST_CONTROL_POLICY_MAXIMUMS = Object.freeze({
  otpTtlSeconds: 300,
  listingTtlSeconds: 86_400,
  staleDataRetentionSeconds: 86_400,
  compatibilityStatusDaily: 100,
  compatibilityDirectoryDaily: 100,
  compatibilityOtpDaily: 48,
  compatibilityUpdateSourceDaily: 48,
  compatibilityUpdateServerDaily: 48,
  publishServerDaily: 48,
  compatibilityRendezvousClientSourceDaily: 50,
  compatibilityRendezvousClientPairDaily: 10,
  compatibilityRendezvousServerSourceDaily: 50,
  compatibilityRendezvousServerDaily: 50,
} as const);

export const DIRECTORY_ARTIFACT_POLICY_MAXIMUMS = Object.freeze({
  refreshLeadSeconds: 7_200,
  lifetimeSeconds: 14_400,
  expiryQuantumSeconds: 900,
  minimumAliasPublicationLifetimeSeconds: 60,
} as const);

export const MINIMUM_LISTING_TTL_SECONDS =
  DIRECTORY_ARTIFACT_POLICY_MAXIMUMS.expiryQuantumSeconds +
  DIRECTORY_ARTIFACT_POLICY_MAXIMUMS.minimumAliasPublicationLifetimeSeconds;

export interface DirectoryArtifactConfigurationInput {
  readonly DIRECTORY_REFRESH_LEAD_SECONDS?: string;
  readonly LISTING_TTL_SECONDS?: string;
}

export interface DirectoryArtifactConfiguration {
  readonly refreshLeadSeconds: number;
  readonly listingTtlSeconds: number;
  readonly artifactLifetimeSeconds: number;
}

export interface PublisherEdgeConfigurationInput {
  readonly PUBLISH_HOSTNAME?: string;
  readonly ROUTE_DISABLED_RETRY_SECONDS?: string;
}

export interface PublisherEdgeConfiguration {
  readonly authority: string;
  readonly routeDisabledRetrySeconds: number;
}

export interface RendezvousEdgeConfigurationInput {
  readonly RENDEZVOUS_HOSTNAME?: string;
  readonly ROUTE_DISABLED_RETRY_SECONDS?: string;
}

export interface RendezvousEdgeConfiguration {
  readonly authority: string;
  readonly routeDisabledRetrySeconds: number;
}

export interface PublisherCoordinatorConfigurationInput {
  readonly PUBLISH_HOSTNAME?: string;
  readonly LISTING_TTL_SECONDS?: string;
  readonly PUBLISH_SERVER_DAILY_LIMIT?: string;
  readonly ROUTE_DISABLED_RETRY_SECONDS?: string;
}

export interface PublisherCoordinatorConfiguration {
  readonly authority: string;
  readonly listingTtlSeconds: number;
  readonly publishServerDaily: number;
  readonly routeDisabledRetrySeconds: number;
}

export interface RendezvousCoordinatorConfigurationInput {
  readonly RENDEZVOUS_HOSTNAME?: string;
  readonly LISTING_TTL_SECONDS?: string;
  readonly ROUTE_DISABLED_RETRY_SECONDS?: string;
  readonly COMPAT_RENDEZVOUS_CLIENT_SOURCE_DAILY_LIMIT?: string;
  readonly COMPAT_RENDEZVOUS_CLIENT_PAIR_DAILY_LIMIT?: string;
  readonly COMPAT_RENDEZVOUS_SERVER_SOURCE_DAILY_LIMIT?: string;
  readonly COMPAT_RENDEZVOUS_SERVER_DAILY_LIMIT?: string;
}

export interface RendezvousCoordinatorConfiguration {
  readonly authority: string;
  readonly listingTtlSeconds: number;
  readonly routeDisabledRetrySeconds: number;
  readonly compatibilityRendezvousClientSourceDaily: number;
  readonly compatibilityRendezvousClientPairDaily: number;
  readonly compatibilityRendezvousServerSourceDaily: number;
  readonly compatibilityRendezvousServerDaily: number;
}

export interface RendezvousPolicyConfigurationInput {
  readonly RENDEZVOUS_CLIENT_ROLLING_LIMIT?: string;
  readonly RENDEZVOUS_ACTIVE_CLIENT_LIMIT?: string;
  readonly RENDEZVOUS_CLIENT_SESSION_SECONDS?: string;
}

export interface RendezvousPolicyConfiguration {
  readonly rendezvousClientRollingLimit: number;
  readonly rendezvousActiveClientLimit: number;
  readonly rendezvousClientSessionSeconds: number;
}

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
  readonly PUBLISH_SERVER_DAILY_LIMIT?: string;
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
  readonly publishServerDaily: number;
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

/** Parse only the fail-closed policy required by the publisher edge. */
export function publisherEdgeConfiguration(
  input: PublisherEdgeConfigurationInput,
): PublisherEdgeConfiguration {
  return Object.freeze({
    authority: strictDynamicAuthority(
      input.PUBLISH_HOSTNAME,
      "PUBLISH_HOSTNAME",
    ),
    routeDisabledRetrySeconds: strictInteger(
      input.ROUTE_DISABLED_RETRY_SECONDS,
      "ROUTE_DISABLED_RETRY_SECONDS",
      1,
      MAXIMUM_RETRY_AFTER_SECONDS,
    ),
  });
}

/** Parse only the fail-closed policy required by the rendezvous edge. */
export function rendezvousEdgeConfiguration(
  input: RendezvousEdgeConfigurationInput,
): RendezvousEdgeConfiguration {
  return Object.freeze({
    authority: strictDynamicAuthority(
      input.RENDEZVOUS_HOSTNAME,
      "RENDEZVOUS_HOSTNAME",
    ),
    routeDisabledRetrySeconds: strictInteger(
      input.ROUTE_DISABLED_RETRY_SECONDS,
      "ROUTE_DISABLED_RETRY_SECONDS",
      1,
      MAXIMUM_RETRY_AFTER_SECONDS,
    ),
  });
}

/** Parse only policy consumed by the named publisher coordinator. */
export function publisherCoordinatorConfiguration(
  input: PublisherCoordinatorConfigurationInput,
): PublisherCoordinatorConfiguration {
  return Object.freeze({
    authority: strictDynamicAuthority(
      input.PUBLISH_HOSTNAME,
      "PUBLISH_HOSTNAME",
    ),
    listingTtlSeconds: parseListingTtlSeconds(input.LISTING_TTL_SECONDS),
    publishServerDaily: strictInteger(
      input.PUBLISH_SERVER_DAILY_LIMIT,
      "PUBLISH_SERVER_DAILY_LIMIT",
      1,
      REQUEST_CONTROL_POLICY_MAXIMUMS.publishServerDaily,
    ),
    routeDisabledRetrySeconds: strictInteger(
      input.ROUTE_DISABLED_RETRY_SECONDS,
      "ROUTE_DISABLED_RETRY_SECONDS",
      1,
      MAXIMUM_RETRY_AFTER_SECONDS,
    ),
  });
}

/** Parse only policy consumed by the named rendezvous coordinator. */
export function rendezvousCoordinatorConfiguration(
  input: RendezvousCoordinatorConfigurationInput,
): RendezvousCoordinatorConfiguration {
  return Object.freeze({
    authority: strictDynamicAuthority(
      input.RENDEZVOUS_HOSTNAME,
      "RENDEZVOUS_HOSTNAME",
    ),
    listingTtlSeconds: parseListingTtlSeconds(input.LISTING_TTL_SECONDS),
    routeDisabledRetrySeconds: strictInteger(
      input.ROUTE_DISABLED_RETRY_SECONDS,
      "ROUTE_DISABLED_RETRY_SECONDS",
      1,
      MAXIMUM_RETRY_AFTER_SECONDS,
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

/** Parse the bounded freshness and cache contract used by the static builder. */
export function directoryArtifactConfiguration(
  input: DirectoryArtifactConfigurationInput,
): DirectoryArtifactConfiguration {
  const listingTtlSeconds = parseListingTtlSeconds(input.LISTING_TTL_SECONDS);
  const refreshLeadSeconds = strictInteger(
    input.DIRECTORY_REFRESH_LEAD_SECONDS,
    "DIRECTORY_REFRESH_LEAD_SECONDS",
    1,
    Math.min(
      DIRECTORY_ARTIFACT_POLICY_MAXIMUMS.refreshLeadSeconds,
      DIRECTORY_ARTIFACT_POLICY_MAXIMUMS.lifetimeSeconds - 1,
      listingTtlSeconds -
        DIRECTORY_ARTIFACT_POLICY_MAXIMUMS.expiryQuantumSeconds,
    ),
  );
  return Object.freeze({
    refreshLeadSeconds,
    listingTtlSeconds,
    artifactLifetimeSeconds: Math.min(
      listingTtlSeconds,
      DIRECTORY_ARTIFACT_POLICY_MAXIMUMS.lifetimeSeconds,
    ),
  });
}

/**
 * Parse the policy shared by every rendezvous route and Durable Object room.
 * Missing, malformed, and policy-raising values fail closed.
 */
export function rendezvousPolicyConfiguration(
  input: RendezvousPolicyConfigurationInput,
): RendezvousPolicyConfiguration {
  return Object.freeze({
    rendezvousClientRollingLimit: strictInteger(
      input.RENDEZVOUS_CLIENT_ROLLING_LIMIT,
      "RENDEZVOUS_CLIENT_ROLLING_LIMIT",
      1,
      RENDEZVOUS_POLICY_MAXIMUMS.rendezvousClientRollingLimit,
    ),
    rendezvousActiveClientLimit: strictInteger(
      input.RENDEZVOUS_ACTIVE_CLIENT_LIMIT,
      "RENDEZVOUS_ACTIVE_CLIENT_LIMIT",
      1,
      RENDEZVOUS_POLICY_MAXIMUMS.rendezvousActiveClientLimit,
    ),
    rendezvousClientSessionSeconds: strictInteger(
      input.RENDEZVOUS_CLIENT_SESSION_SECONDS,
      "RENDEZVOUS_CLIENT_SESSION_SECONDS",
      1,
      RENDEZVOUS_POLICY_MAXIMUMS.rendezvousClientSessionSeconds,
    ),
  });
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
    MINIMUM_LISTING_TTL_SECONDS,
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
    publishServerDaily: strictInteger(
      input.PUBLISH_SERVER_DAILY_LIMIT,
      "PUBLISH_SERVER_DAILY_LIMIT",
      1,
      REQUEST_CONTROL_POLICY_MAXIMUMS.publishServerDaily,
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

function parseListingTtlSeconds(value: string | undefined): number {
  return strictInteger(
    value,
    "LISTING_TTL_SECONDS",
    MINIMUM_LISTING_TTL_SECONDS,
    REQUEST_CONTROL_POLICY_MAXIMUMS.listingTtlSeconds,
  );
}

function strictDynamicAuthority(
  value: string | undefined,
  variable: string,
): string {
  if (value === undefined || !isCanonicalHostname(value)) {
    throw new RequestControlConfigurationError(variable);
  }
  return value;
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
