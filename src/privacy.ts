import { normalizeIpAddress, RequestError } from "./protocol";
import { isCanonicalHostname } from "./hostname";

const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const LOWERCASE_HEX_256_PATTERN = /^[0-9a-f]{64}$/;

export const SOURCE_TAG_VERSION = "v1";
export const RENDEZVOUS_REPLAY_TAG_VERSION = "v1";

export enum SourceTagPurpose {
  GlobalIngress = "global-ingress",
  CompatStatus = "compat-status",
  CompatDirectory = "compat-directory",
  CompatOtp = "compat-otp",
  CompatUpdate = "compat-update",
  PublishIngress = "publish-ingress",
  RendezvousClientGlobal = "rendezvous-client-global",
  RendezvousClientServer = "rendezvous-client-server",
  RendezvousServer = "rendezvous-server",
}

const SOURCE_TAG_PURPOSES: ReadonlySet<string> = new Set(
  Object.values(SourceTagPurpose),
);

export type UnscopedSourceTagPurpose = Exclude<
  SourceTagPurpose,
  SourceTagPurpose.RendezvousClientServer
>;

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

export interface RequestPrivacyContext {
  tag(purpose: UnscopedSourceTagPurpose): Promise<string>;
  tags(purpose: UnscopedSourceTagPurpose): Promise<readonly string[]>;
  serverTag(
    purpose: SourceTagPurpose.RendezvousClientServer,
    serverId: string,
  ): Promise<string>;
  serverTags(
    purpose: SourceTagPurpose.RendezvousClientServer,
    serverId: string,
  ): Promise<readonly string[]>;
  matchesLegacySourceAddress(storedValue: string): boolean;
}

export interface RequestPrivacyOptions {
  keys: SourceTagKeyRing;
  namespace: string;
}

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

  createRequestContext(
    request: Request,
    namespace: string,
  ): RequestPrivacyContext {
    const validatedNamespace = validateNamespace(namespace);
    const canonicalAddress = extractCanonicalSourceAddress(request);
    const cachedTags = new Map<string, Promise<readonly string[]>>();

    const deriveTags = (
      purpose: SourceTagPurpose,
      serverId?: string,
    ): Promise<readonly string[]> => {
      const domain = sourceTagDomain(
        validatedNamespace,
        purpose,
        canonicalAddress,
        serverId,
      );
      const cached = cachedTags.get(domain);
      if (cached !== undefined) {
        return cached;
      }

      const tags = Promise.all(
        this.#keys.map((key) => deriveTag(key, domain)),
      ).then((values) => Object.freeze(values));
      cachedTags.set(domain, tags);
      return tags;
    };

    const deriveServerTags = (
      purpose: SourceTagPurpose.RendezvousClientServer,
      serverId: string,
    ): Promise<readonly string[]> => {
      assertServerScopedPurpose(purpose);
      validateServerId(serverId);
      return deriveTags(purpose, serverId);
    };

    return Object.freeze({
      async tag(purpose: UnscopedSourceTagPurpose): Promise<string> {
        assertUnscopedPurpose(purpose);
        return firstTag(await deriveTags(purpose));
      },

      async tags(
        purpose: UnscopedSourceTagPurpose,
      ): Promise<readonly string[]> {
        assertUnscopedPurpose(purpose);
        return deriveTags(purpose);
      },

      async serverTag(
        purpose: SourceTagPurpose.RendezvousClientServer,
        serverId: string,
      ): Promise<string> {
        return firstTag(await deriveServerTags(purpose, serverId));
      },

      async serverTags(
        purpose: SourceTagPurpose.RendezvousClientServer,
        serverId: string,
      ): Promise<readonly string[]> {
        return deriveServerTags(purpose, serverId);
      },

      matchesLegacySourceAddress(storedValue: string): boolean {
        if (typeof storedValue !== "string") {
          return false;
        }
        try {
          return normalizeIpAddress(storedValue) === canonicalAddress;
        } catch {
          return false;
        }
      },
    });
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

export function createRequestPrivacyContext(
  request: Request,
  options: RequestPrivacyOptions,
): RequestPrivacyContext {
  return options.keys.createRequestContext(
    request,
    options.namespace,
  );
}

function extractCanonicalSourceAddress(request: Request): string {
  const address = request.headers.get("CF-Connecting-IP");
  if (address === null) {
    throw new RequestError("The source address is unavailable", 400);
  }

  try {
    return normalizeIpAddress(address);
  } catch {
    throw new RequestError("The source address is invalid", 400);
  }
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

async function deriveTag(
  key: ImportedSourceTagKey,
  domain: string,
): Promise<string> {
  return deriveVersionedTag(key, SOURCE_TAG_VERSION, domain);
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

function sourceTagDomain(
  namespace: string,
  purpose: SourceTagPurpose,
  canonicalAddress: string,
  serverId?: string,
): string {
  const base = `atrinik-metaserver\0source-tag\0${SOURCE_TAG_VERSION}\0${namespace}\0${purpose}\0${canonicalAddress}`;
  return serverId === undefined ? base : `${base}\0${serverId}`;
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

function firstTag(tags: readonly string[]): string {
  const tag = tags[0];
  if (tag === undefined) {
    throw new Error("Source-tag key ring is empty");
  }
  return tag;
}

function assertUnscopedPurpose(
  purpose: UnscopedSourceTagPurpose,
): void {
  const candidate: string = purpose;
  if (
    !SOURCE_TAG_PURPOSES.has(candidate) ||
    candidate === SourceTagPurpose.RendezvousClientServer
  ) {
    throw new TypeError("Invalid unscoped source-tag purpose");
  }
}

function assertServerScopedPurpose(
  purpose: SourceTagPurpose.RendezvousClientServer,
): void {
  if (purpose !== SourceTagPurpose.RendezvousClientServer) {
    throw new TypeError("Invalid server-scoped source-tag purpose");
  }
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
