export const DIRECT_CANDIDATE_KINDS = [
  "lan",
  "ipv6",
  "prflx",
  "mapped",
  "srflx",
  "directory",
] as const;
export type DirectCandidateKind = typeof DIRECT_CANDIDATE_KINDS[number];
export const SERVER_SIGNAL_CANDIDATE_KINDS = Object.freeze([
  "lan",
  "ipv6",
  "mapped",
  "srflx",
] as const satisfies readonly DirectCandidateKind[]);

export class RequestError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return bytesToHex(new Uint8Array(digest));
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function constantTimeEqual(
  left: string,
  right: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  return crypto.subtle.timingSafeEqual(
    leftDigest,
    rightDigest,
  );
}

export function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

export function normalizeIpAddress(value: string): string {
  let address = value.trim().toLowerCase();
  const startsWithBracket = address.startsWith("[");
  const endsWithBracket = address.endsWith("]");
  if (startsWithBracket || endsWithBracket) {
    if (!startsWithBracket || !endsWithBracket) {
      throw new RequestError("Invalid source IP address");
    }
    address = address.slice(1, -1);
    if (
      !address.includes(":") ||
      address.includes("[") ||
      address.includes("]")
    ) {
      throw new RequestError("Invalid source IP address");
    }
  } else if (address.includes("[") || address.includes("]")) {
    throw new RequestError("Invalid source IP address");
  }

  if (address.includes("%")) {
    throw new RequestError("Invalid source IP address");
  }

  if (!address.includes(":")) {
    return normalizeIpv4(address);
  }

  const halves = address.split("::");
  if (halves.length > 2) {
    throw new RequestError("Invalid source IP address");
  }

  const left = parseIpv6Words(halves[0], halves.length === 1);
  const right = halves.length === 2 ? parseIpv6Words(halves[1], true) : [];
  const missing = 8 - left.length - right.length;
  if (
    (halves.length === 1 && missing !== 0) ||
    (halves.length === 2 && missing < 1)
  ) {
    throw new RequestError("Invalid source IP address");
  }

  return [...left, ...Array(missing).fill("0"), ...right]
    .map((word) => word.padStart(4, "0"))
    .join(":");
}

function parseIpv6Words(
  part: string,
  allowFinalIpv4: boolean,
): string[] {
  if (part === "") {
    return [];
  }

  const raw = part.split(":");
  const words: string[] = [];
  for (const [index, word] of raw.entries()) {
    if (word.includes(".")) {
      if (!allowFinalIpv4 || index !== raw.length - 1) {
        throw new RequestError("Invalid source IP address");
      }
      const ipv4 = normalizeIpv4(word)
        .split(".")
        .map((value) => Number.parseInt(value, 10));
      words.push(((ipv4[0] << 8) | ipv4[1]).toString(16));
      words.push(((ipv4[2] << 8) | ipv4[3]).toString(16));
    } else {
      if (!/^[0-9a-f]{1,4}$/.test(word)) {
        throw new RequestError("Invalid source IP address");
      }
      words.push(word.replace(/^0+/, "") || "0");
    }
  }

  return words;
}

function normalizeIpv4(value: string): string {
  const octets = value.split(".");
  if (
    octets.length !== 4 ||
    octets.some(
      (octet) =>
        !/^\d{1,3}$/.test(octet) ||
        Number.parseInt(octet, 10) > 255,
    )
  ) {
    throw new RequestError("Invalid source IP address");
  }

  return octets.map((octet) => String(Number.parseInt(octet, 10))).join(".");
}
