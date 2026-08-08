import { normalizeIpAddress, RequestError } from "./protocol";
import { isCanonicalHostname } from "./hostname";

const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SERVER_ID_PATTERN = /^[0-9a-f]{64}$/;

export const SOURCE_TAG_VERSION = "v1";

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
}

export function parseSourceTagKeyRing(
  configuration: SourceTagKeyConfiguration,
): Promise<SourceTagKeyRing> {
  return SourceTagKeyRing.parse(configuration);
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
  const digest = await crypto.subtle.sign(
    "HMAC",
    key.key,
    new TextEncoder().encode(domain),
  );
  return `${SOURCE_TAG_VERSION}.${key.id}.${encodeBase64Url(new Uint8Array(digest))}`;
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
  if (!SERVER_ID_PATTERN.test(serverId)) {
    throw new TypeError("Server ID must contain exactly 64 lowercase hex digits");
  }
}
