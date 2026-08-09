import { toASCII } from "tr46";

const CANONICAL_HOSTNAME_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DECIMAL_LABEL_PATTERN = /^[0-9]+$/;
const HEXADECIMAL_LABEL_PATTERN = /^0x[0-9a-f]+$/;
const IDNA_OPTIONS = Object.freeze({
  checkBidi: true,
  checkHyphens: true,
  checkJoiners: true,
  ignoreInvalidPunycode: false,
  transitionalProcessing: false,
  useSTD3ASCIIRules: true,
  verifyDNSLength: true,
});

/**
 * Accept only a lowercase ASCII fully-qualified hostname without a port or
 * trailing dot. Keeping this grammar shared prevents deployment configuration,
 * routing, and privacy-domain separation from interpreting an authority
 * differently.
 */
export function isCanonicalHostname(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !CANONICAL_HOSTNAME_PATTERN.test(value) ||
    !/[a-z]/.test(value) ||
    value.split(".").some((label) =>
      label.startsWith("xn--") && toASCII(label, IDNA_OPTIONS) !== label
    )
  ) {
    return false;
  }

  // Numeric IPv4 has several historical spellings beyond dotted decimal.
  // Requiring at least one label that is neither decimal nor 0x-prefixed hex
  // keeps every such literal out of the persisted explicit-hostname field
  // without performing DNS resolution or accepting URL-parser normalization.
  return value.split(".").some((label) =>
    !DECIMAL_LABEL_PATTERN.test(label) &&
    !HEXADECIMAL_LABEL_PATTERN.test(label)
  );
}
