/** Access capabilities are binary hashes, never UTF-8 encodings of hex text. */
const HEX_32 = /^[0-9a-f]{64}$/;
const CODE = /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{16}$/;
const encoder = new TextEncoder();

export function isAccessHash(value: unknown): value is string {
  return typeof value === "string" && HEX_32.test(value);
}

export function decodeAccessHash(value: string): Uint8Array {
  if (!isAccessHash(value)) throw new Error("Invalid access hash");
  return Uint8Array.from(value.match(/../g)!, (byte) => Number.parseInt(byte, 16));
}

export async function accessRouteIndex(routeCapability: string): Promise<string> {
  return domainHash("atrinik-access-index-v1\0", decodeAccessHash(routeCapability));
}

/** Used by synthetic conformance tests; the metaserver never receives a code. */
export async function accessRouteCapability(code: string): Promise<string> {
  if (!CODE.test(code)) throw new Error("Invalid access code");
  return domainHash("atrinik-access-route-v1\0", encoder.encode(code));
}

async function domainHash(domain: string, value: Uint8Array): Promise<string> {
  const prefix = encoder.encode(domain);
  const input = new Uint8Array(prefix.length + value.length);
  input.set(prefix);
  input.set(value, prefix.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
