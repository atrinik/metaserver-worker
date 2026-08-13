import { isCanonicalHostname } from "./hostname";

const MAXIMUM_RETRY_AFTER_SECONDS = 86_400;

export const RENDEZVOUS_POLICY_MAXIMUMS = Object.freeze({
  rendezvousActiveClientLimit: 16,
  rendezvousClientSessionSeconds: 15,
} as const);

export const RENDEZVOUS_COOLDOWN_POLICY_MAXIMUMS = Object.freeze({
  rendezvousClientPairBurstLimit: 20,
  rendezvousClientPairWindowSeconds: 60,
  rendezvousClientPairInitialCooldownSeconds: 30,
  rendezvousClientPairMaximumCooldownSeconds: 900,
  rendezvousClientPairResetSeconds: 1_800,
} as const);

export const CANONICAL_POLICY_MAXIMUMS = Object.freeze({
  listingTtlSeconds: 86_400,
  publishServerDaily: 48,
  rendezvousServerDaily: 50,
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

export interface ScheduledMaintenanceConfigurationInput {
  readonly LISTING_TTL_SECONDS?: string;
}

export interface ScheduledMaintenanceConfiguration {
  readonly listingTtlSeconds: number;
}

export interface RendezvousCoordinatorConfigurationInput {
  readonly RENDEZVOUS_HOSTNAME?: string;
  readonly LISTING_TTL_SECONDS?: string;
  readonly ROUTE_DISABLED_RETRY_SECONDS?: string;
  readonly RENDEZVOUS_CLIENT_PAIR_BURST_LIMIT?: string;
  readonly RENDEZVOUS_CLIENT_PAIR_WINDOW_SECONDS?: string;
  readonly RENDEZVOUS_CLIENT_PAIR_INITIAL_COOLDOWN_SECONDS?: string;
  readonly RENDEZVOUS_CLIENT_PAIR_MAXIMUM_COOLDOWN_SECONDS?: string;
  readonly RENDEZVOUS_CLIENT_PAIR_RESET_SECONDS?: string;
  readonly RENDEZVOUS_SERVER_DAILY_LIMIT?: string;
}

export interface RendezvousCoordinatorConfiguration {
  readonly authority: string;
  readonly listingTtlSeconds: number;
  readonly routeDisabledRetrySeconds: number;
  readonly rendezvousClientPairBurstLimit: number;
  readonly rendezvousClientPairWindowSeconds: number;
  readonly rendezvousClientPairInitialCooldownSeconds: number;
  readonly rendezvousClientPairMaximumCooldownSeconds: number;
  readonly rendezvousClientPairResetSeconds: number;
  readonly rendezvousServerDaily: number;
}

export interface RendezvousPolicyConfigurationInput {
  readonly RENDEZVOUS_ACTIVE_CLIENT_LIMIT?: string;
  readonly RENDEZVOUS_CLIENT_SESSION_SECONDS?: string;
}

export interface RendezvousPolicyConfiguration {
  readonly rendezvousActiveClientLimit: number;
  readonly rendezvousClientSessionSeconds: number;
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
      CANONICAL_POLICY_MAXIMUMS.publishServerDaily,
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
  const initialCooldown = strictInteger(
    input.RENDEZVOUS_CLIENT_PAIR_INITIAL_COOLDOWN_SECONDS,
    "RENDEZVOUS_CLIENT_PAIR_INITIAL_COOLDOWN_SECONDS",
    1,
    RENDEZVOUS_COOLDOWN_POLICY_MAXIMUMS
      .rendezvousClientPairInitialCooldownSeconds,
  );
  const maximumCooldown = strictInteger(
    input.RENDEZVOUS_CLIENT_PAIR_MAXIMUM_COOLDOWN_SECONDS,
    "RENDEZVOUS_CLIENT_PAIR_MAXIMUM_COOLDOWN_SECONDS",
    initialCooldown,
    RENDEZVOUS_COOLDOWN_POLICY_MAXIMUMS
      .rendezvousClientPairMaximumCooldownSeconds,
  );
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
    rendezvousClientPairBurstLimit: strictInteger(
      input.RENDEZVOUS_CLIENT_PAIR_BURST_LIMIT,
      "RENDEZVOUS_CLIENT_PAIR_BURST_LIMIT",
      1,
      RENDEZVOUS_COOLDOWN_POLICY_MAXIMUMS.rendezvousClientPairBurstLimit,
    ),
    rendezvousClientPairWindowSeconds: strictInteger(
      input.RENDEZVOUS_CLIENT_PAIR_WINDOW_SECONDS,
      "RENDEZVOUS_CLIENT_PAIR_WINDOW_SECONDS",
      1,
      RENDEZVOUS_COOLDOWN_POLICY_MAXIMUMS.rendezvousClientPairWindowSeconds,
    ),
    rendezvousClientPairInitialCooldownSeconds: initialCooldown,
    rendezvousClientPairMaximumCooldownSeconds: maximumCooldown,
    rendezvousClientPairResetSeconds: strictInteger(
      input.RENDEZVOUS_CLIENT_PAIR_RESET_SECONDS,
      "RENDEZVOUS_CLIENT_PAIR_RESET_SECONDS",
      maximumCooldown,
      RENDEZVOUS_COOLDOWN_POLICY_MAXIMUMS.rendezvousClientPairResetSeconds,
    ),
    rendezvousServerDaily: strictInteger(
      input.RENDEZVOUS_SERVER_DAILY_LIMIT,
      "RENDEZVOUS_SERVER_DAILY_LIMIT",
      1,
      CANONICAL_POLICY_MAXIMUMS.rendezvousServerDaily,
    ),
  });
}

/** Parse only policy consumed by the private scheduled handler. */
export function scheduledMaintenanceConfiguration(
  input: ScheduledMaintenanceConfigurationInput,
): ScheduledMaintenanceConfiguration {
  return Object.freeze({
    listingTtlSeconds: parseListingTtlSeconds(input.LISTING_TTL_SECONDS),
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

function parseListingTtlSeconds(value: string | undefined): number {
  return strictInteger(
    value,
    "LISTING_TTL_SECONDS",
    MINIMUM_LISTING_TTL_SECONDS,
    CANONICAL_POLICY_MAXIMUMS.listingTtlSeconds,
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
