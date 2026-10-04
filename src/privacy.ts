// Historical key binding names are retained only for non-address grant/ticket replay HMACs.
import { isCanonicalHostname } from "./hostname";

const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const LOWERCASE_HEX_256_PATTERN = /^[0-9a-f]{64}$/;

export const RENDEZVOUS_REPLAY_TAG_VERSION = "v1";

export interface SourceTagKeyConfiguration {
  currentKeyId: string | undefined;
  currentSecret: string | undefined;
  previousKeyId?: string | undefined;
  previousSecret?: string | undefined;
}

export interface SourceTagKeyEnvironment {
  readonly SOURCE_TAG_KEY_CURRENT_ID?: unknown;
  readonly SOURCE_TAG_KEY_CURRENT?: unknown;
  readonly SOURCE_TAG_KEY_PREVIOUS_ID?: unknown;
  readonly SOURCE_TAG_KEY_PREVIOUS?: unknown;
}

export type RendezvousReplayTags = readonly [
  current: string,
  previous: string,
];

interface ImportedSourceTagKey {
  readonly id: string;
  readonly key: CryptoKey;
}

interface CachedSourceTagKeyRing extends SourceTagKeyConfiguration {
  readonly ring: SourceTagKeyRing;
}

let cachedRequiredSourceTagKeyRing: CachedSourceTagKeyRing | undefined;

export class SourceTagConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceTagConfigurationError";
  }
}

export class SourceTagKeyRing {
  readonly #keys: readonly ImportedSourceTagKey[];

  private constructor(keys: readonly ImportedSourceTagKey[]) {
    this.#keys = keys;
  }

  static async parse(
    configuration: SourceTagKeyConfiguration,
  ): Promise<SourceTagKeyRing> {
    const currentId = validateKeyId(
      configuration.currentKeyId,
      "current source-tag key ID",
    );
    const currentSecret = decodeSecret(
      configuration.currentSecret,
      "current source-tag secret",
    );

    const hasPreviousId = configuration.previousKeyId !== undefined;
    const hasPreviousSecret = configuration.previousSecret !== undefined;
    if (hasPreviousId !== hasPreviousSecret) {
      throw new SourceTagConfigurationError(
        "Previous source-tag key ID and secret must be configured together",
      );
    }

    const keys: ImportedSourceTagKey[] = [];

    if (hasPreviousId && hasPreviousSecret) {
      const previousId = validateKeyId(
        configuration.previousKeyId,
        "previous source-tag key ID",
      );
      if (previousId === currentId) {
        throw new SourceTagConfigurationError(
          "Current and previous source-tag key IDs must be distinct",
        );
      }
      const previousSecret = decodeSecret(
        configuration.previousSecret,
        "previous source-tag secret",
      );
      if (equalBytes(currentSecret, previousSecret)) {
        throw new SourceTagConfigurationError(
          "Current and previous source-tag secrets must be distinct",
        );
      }
      keys.push({
        id: currentId,
        key: await importHmacKey(currentSecret),
      }, {
        id: previousId,
        key: await importHmacKey(previousSecret),
      });
    } else {
      keys.push({
        id: currentId,
        key: await importHmacKey(currentSecret),
      });
    }

    return new SourceTagKeyRing(Object.freeze(keys));
  }

  /**
   * Derive current and previous-key aliases for a replay-ledger entry. The
   * caller receives only opaque tags; the ticket, HMAC keys, and signing
   * domain remain private to this module.
   */
  async rendezvousReplayTags(
    namespace: string,
    roomId: string,
    clientTicket: string,
  ): Promise<RendezvousReplayTags> {
    const validatedNamespace = validateNamespace(namespace);
    validateRendezvousRoomId(roomId);
    validateRendezvousClientTicket(clientTicket);
    const [currentKey, previousKey, unexpectedKey] = this.#keys;
    if (
      currentKey === undefined ||
      previousKey === undefined ||
      unexpectedKey !== undefined
    ) {
      throw new SourceTagConfigurationError(
        "Rendezvous replay tags require exactly two source-tag keys",
      );
    }

    const domain = rendezvousReplayTagDomain(
      validatedNamespace,
      roomId,
      clientTicket,
    );
    const [current, previous] = await Promise.all([
      deriveVersionedTag(currentKey, RENDEZVOUS_REPLAY_TAG_VERSION, domain),
      deriveVersionedTag(previousKey, RENDEZVOUS_REPLAY_TAG_VERSION, domain),
    ]);
    const tags: [string, string] = [current, previous];
    return Object.freeze(tags);
  }

  /** Separate domain from transport tickets and request-source abuse tags. */
  async accessGrantTags(
    namespace: string, profile: "classic" | "game", serverId: string,
    grant: string, clientNonce: string,
  ): Promise<RendezvousReplayTags> {
    const validatedNamespace = validateNamespace(namespace);
    validateServerId(serverId);
    validateRendezvousClientTicket(grant);
    validateRendezvousClientTicket(clientNonce);
    if (profile !== "classic" && profile !== "game") {
      throw new SourceTagConfigurationError("Invalid access profile");
    }
    const [currentKey, previousKey, unexpectedKey] = this.#keys;
    if (currentKey === undefined || previousKey === undefined || unexpectedKey !== undefined) {
      throw new SourceTagConfigurationError("Access grants require exactly two source-tag keys");
    }
    const domain = JSON.stringify(["atrinik-access-grant-v1", validatedNamespace,
      profile, serverId, grant, clientNonce]);
    const tags = await Promise.all([
      deriveVersionedTag(currentKey, RENDEZVOUS_REPLAY_TAG_VERSION, domain),
      deriveVersionedTag(previousKey, RENDEZVOUS_REPLAY_TAG_VERSION, domain),
    ]);
    return Object.freeze([tags[0], tags[1]] as [string, string]);
  }

}

export function parseSourceTagKeyRing(
  configuration: SourceTagKeyConfiguration,
): Promise<SourceTagKeyRing> {
  return SourceTagKeyRing.parse(configuration);
}

export async function requiredSourceTagKeyRing(
  environment: SourceTagKeyEnvironment,
): Promise<SourceTagKeyRing> {
  if (
    typeof environment.SOURCE_TAG_KEY_PREVIOUS_ID !== "string" ||
    typeof environment.SOURCE_TAG_KEY_PREVIOUS !== "string"
  ) {
    throw new SourceTagConfigurationError(
      "Current and previous source-tag keys are both required",
    );
  }
  const configuration: SourceTagKeyConfiguration = {
    currentKeyId: optionalString(environment.SOURCE_TAG_KEY_CURRENT_ID),
    currentSecret: optionalString(environment.SOURCE_TAG_KEY_CURRENT),
    previousKeyId: environment.SOURCE_TAG_KEY_PREVIOUS_ID,
    previousSecret: environment.SOURCE_TAG_KEY_PREVIOUS,
  };
  if (
    cachedRequiredSourceTagKeyRing !== undefined &&
    sameSourceTagKeyConfiguration(
      cachedRequiredSourceTagKeyRing,
      configuration,
    )
  ) {
    return cachedRequiredSourceTagKeyRing.ring;
  }

  const ring = await parseSourceTagKeyRing(configuration);
  cachedRequiredSourceTagKeyRing = { ...configuration, ring };
  return ring;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function validateKeyId(value: string | undefined, label: string): string {
  if (typeof value !== "string" || !KEY_ID_PATTERN.test(value)) {
    throw new SourceTagConfigurationError(
      `${label} must contain 1-32 ASCII letters, digits, underscores, or hyphens`,
    );
  }
  return value;
}

function validateNamespace(value: unknown): string {
  if (!isCanonicalHostname(value)) {
    throw new SourceTagConfigurationError(
      "Source-tag namespace must be a canonical lowercase ASCII hostname",
    );
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function sameSourceTagKeyConfiguration(
  left: SourceTagKeyConfiguration,
  right: SourceTagKeyConfiguration,
): boolean {
  return left.currentKeyId === right.currentKeyId &&
    left.currentSecret === right.currentSecret &&
    left.previousKeyId === right.previousKeyId &&
    left.previousSecret === right.previousSecret;
}

function decodeSecret(
  value: string | undefined,
  label: string,
): Uint8Array {
  if (typeof value !== "string" || !SECRET_PATTERN.test(value)) {
    throw new SourceTagConfigurationError(
      `${label} must be an unpadded base64url encoding of exactly 32 bytes`,
    );
  }

  let binary: string;
  try {
    binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=");
  } catch {
    throw new SourceTagConfigurationError(
      `${label} must be an unpadded base64url encoding of exactly 32 bytes`,
    );
  }

  const bytes = Uint8Array.from(binary, (character) =>
    character.charCodeAt(0)
  );
  if (bytes.byteLength !== 32 || encodeBase64Url(bytes) !== value) {
    throw new SourceTagConfigurationError(
      `${label} must be an unpadded base64url encoding of exactly 32 bytes`,
    );
  }
  return bytes;
}

async function importHmacKey(secret: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function deriveVersionedTag(
  key: ImportedSourceTagKey,
  version: string,
  domain: string,
): Promise<string> {
  const digest = await crypto.subtle.sign(
    "HMAC",
    key.key,
    new TextEncoder().encode(domain),
  );
  return `${version}.${key.id}.${encodeBase64Url(new Uint8Array(digest))}`;
}

function rendezvousReplayTagDomain(
  namespace: string,
  roomId: string,
  clientTicket: string,
): string {
  return `atrinik-metaserver\0rendezvous-ticket-replay-tag\0${RENDEZVOUS_REPLAY_TAG_VERSION}\0${namespace}\0${roomId}\0${clientTicket}`;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function validateServerId(serverId: string): void {
  if (!LOWERCASE_HEX_256_PATTERN.test(serverId)) {
    throw new TypeError("Server ID must contain exactly 64 lowercase hex digits");
  }
}

function validateRendezvousRoomId(roomId: unknown): asserts roomId is string {
  if (
    typeof roomId !== "string" ||
    !LOWERCASE_HEX_256_PATTERN.test(roomId)
  ) {
    throw new TypeError(
      "Rendezvous room ID must contain exactly 64 lowercase hex digits",
    );
  }
}

function validateRendezvousClientTicket(
  clientTicket: unknown,
): asserts clientTicket is string {
  if (
    typeof clientTicket !== "string" ||
    !LOWERCASE_HEX_256_PATTERN.test(clientTicket)
  ) {
    throw new TypeError(
      "Rendezvous client ticket must contain exactly 64 lowercase hex digits",
    );
  }
}
