const CANONICAL_HOSTNAME_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Accept only a lowercase ASCII fully-qualified hostname without a port or
 * trailing dot. Keeping this grammar shared prevents deployment configuration,
 * routing, and privacy-domain separation from interpreting an authority
 * differently.
 */
export function isCanonicalHostname(value: unknown): value is string {
  return typeof value === "string" &&
    CANONICAL_HOSTNAME_PATTERN.test(value);
}
