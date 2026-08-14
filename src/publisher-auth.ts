import { isDirectoryText, isGameDirectoryText } from "./directory-state";
import { isCanonicalHostname } from "./hostname";
import { HttpError } from "./http";

export const CLASSIC_PUBLISH_SCHEMA = "atrinik-classic-publish-v1";
export const CLASSIC_V2_PUBLISH_SCHEMA = "atrinik-classic-publish-v2";
export const GAME_PUBLISH_SCHEMA = "atrinik-game-publish-v1";
export const CLASSIC_PUBLISH_SIGNATURE_TAG =
  "atrinik-classic-publish-v1";
export const CLASSIC_V2_PUBLISH_SIGNATURE_TAG =
  "atrinik-classic-publish-v2";
export const GAME_PUBLISH_SIGNATURE_TAG = "atrinik-game-publish-v1";
export const PUBLISH_CONTENT_TYPE = "application/json";
export const PUBLISH_SIGNATURE_LABEL = "atrinik";
export const PUBLISH_SIGNATURE_ALGORITHM = "ecdsa-p256-sha256";
export const PUBLISH_SIGNATURE_VALIDITY_SECONDS = 300;
export const PUBLISH_NONCE_RETENTION_SECONDS = 86_400;
export const PUBLISH_MAXIMUM_CERTIFICATE_BYTES = 2_048;
export const PUBLISH_MAXIMUM_BODY_BYTES = 4_096;

const SERVER_ID = /^[0-9a-f]{64}$/;
const NONCE = /^[0-9a-f]{32}$/;
const SEQUENCE = /^[1-9][0-9]{0,19}$/;
const STRUCTURED_FIELD_INTEGER = /^(0|[1-9][0-9]{0,14})$/;
const PADDED_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const COVERED_COMPONENTS =
  "(\"@method\" \"@authority\" \"@path\" \"content-digest\" \"content-type\" \"atrinik-server-id\" \"atrinik-publish-sequence\")";
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder("utf-8", {
  fatal: true,
  // Retain a leading BOM so the byte-for-byte canonical JSON comparison
  // rejects it instead of silently normalizing signed input.
  ignoreBOM: true,
});
const UINT64_MAXIMUM = 18_446_744_073_709_551_615n;
const REGION = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const CONTENT_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const DIGEST = /^[0-9a-f]{64}$/;

export interface ClassicPublishPayload {
  readonly schema: typeof CLASSIC_PUBLISH_SCHEMA;
  readonly serverId: string;
  readonly certificate: string;
  readonly name: string;
  readonly playersCount: number;
  readonly version: string;
  readonly textComment: string;
  readonly public: boolean;
  readonly passwordRequired: boolean;
  readonly hostname?: string;
  readonly port?: number;
}

export interface AuthenticatedClassicPublish {
  readonly payload: ClassicPublishPayload;
  readonly sequence: string;
  readonly nonce: string;
  readonly nonceExpiresAt: number;
  readonly certificateDer: Uint8Array;
}

export interface ClassicV2PublishPayload {
  readonly schema: typeof CLASSIC_V2_PUBLISH_SCHEMA;
  readonly serverId: string;
  readonly certificate: string;
  readonly name: string;
  readonly playersCount: number;
  readonly version: string;
  readonly textComment: string;
  readonly public: boolean;
  readonly accessCodeRequired: boolean;
  readonly hostname?: string;
  readonly port?: number;
}

export interface AuthenticatedClassicV2Publish {
  readonly payload: ClassicV2PublishPayload;
  readonly sequence: string;
  readonly nonce: string;
  readonly nonceExpiresAt: number;
  readonly certificateDer: Uint8Array;
}

export interface GamePublishPayload {
  readonly schema: typeof GAME_PUBLISH_SCHEMA;
  readonly serverId: string;
  readonly certificate: string;
  readonly name: string;
  readonly description: string;
  readonly region?: string;
  readonly protocol: {
    readonly major: 1;
    readonly minor: number;
  };
  readonly content: {
    readonly id: string;
    readonly revisionSha256: string;
  };
  readonly players: {
    readonly online: number;
    readonly capacity: number;
  };
  readonly status: "online" | "full" | "maintenance";
  readonly public: boolean;
  readonly passwordRequired: boolean;
  readonly endpoint?: {
    readonly hostname: string;
    readonly port: number;
  };
}

export interface AuthenticatedGamePublish {
  readonly payload: GamePublishPayload;
  readonly sequence: string;
  readonly nonce: string;
  readonly nonceExpiresAt: number;
  readonly certificateDer: Uint8Array;
}

export async function authenticateClassicPublish(
  request: Request,
  body: Uint8Array,
  serverId: string,
  authority: string,
  now: number,
): Promise<AuthenticatedClassicPublish> {
  const payload = parseClassicPublishPayload(body);
  return authenticateSignedPublish(
    request,
    body,
    serverId,
    authority,
    now,
    CLASSIC_PUBLISH_SIGNATURE_TAG,
    `/v1/classic/servers/${serverId}/publish`,
    payload,
  );
}

export async function authenticateClassicV2Publish(
  request: Request,
  body: Uint8Array,
  serverId: string,
  authority: string,
  now: number,
): Promise<AuthenticatedClassicV2Publish> {
  const payload = parseClassicV2PublishPayload(body);
  return authenticateSignedPublish(
    request,
    body,
    serverId,
    authority,
    now,
    CLASSIC_V2_PUBLISH_SIGNATURE_TAG,
    `/v2/classic/servers/${serverId}/publish`,
    payload,
  );
}

export async function authenticateGamePublish(
  request: Request,
  body: Uint8Array,
  serverId: string,
  authority: string,
  now: number,
): Promise<AuthenticatedGamePublish> {
  const payload = parseGamePublishPayload(body);
  return authenticateSignedPublish(
    request,
    body,
    serverId,
    authority,
    now,
    GAME_PUBLISH_SIGNATURE_TAG,
    `/v1/servers/${serverId}/publish`,
    payload,
  );
}

async function authenticateSignedPublish<Payload extends {
  readonly serverId: string;
  readonly certificate: string;
}>(
  request: Request,
  body: Uint8Array,
  serverId: string,
  authority: string,
  now: number,
  signatureTag: string,
  path: string,
  payload: Payload,
): Promise<{
  readonly payload: Payload;
  readonly sequence: string;
  readonly nonce: string;
  readonly nonceExpiresAt: number;
  readonly certificateDer: Uint8Array;
}> {
  if (payload.serverId !== serverId) {
    throw new HttpError("unauthorized");
  }

  const sequence = requireHeader(request.headers, "Atrinik-Publish-Sequence");
  if (!isValidPublisherSequence(sequence)) {
    throw new HttpError("unauthorized");
  }
  const signedServerId = requireHeader(request.headers, "Atrinik-Server-ID");
  if (signedServerId !== serverId) {
    throw new HttpError("unauthorized");
  }

  const digest = await crypto.subtle.digest("SHA-256", body);
  const contentDigest = `sha-256=:${encodeBase64(new Uint8Array(digest))}:`;
  if (requireHeader(request.headers, "Content-Digest") !== contentDigest) {
    throw new HttpError("unauthorized");
  }
  if (requireHeader(request.headers, "Content-Type") !== PUBLISH_CONTENT_TYPE) {
    throw new HttpError("unauthorized");
  }

  const signatureParameters = parseSignatureInput(
    requireHeader(request.headers, "Signature-Input"),
    serverId,
    signatureTag,
    now,
  );
  const signature = parseSignature(
    requireHeader(request.headers, "Signature"),
  );
  if (new URL(request.url).pathname !== path) {
    throw new HttpError("unauthorized");
  }
  const signatureBase = [
    `"@method": POST`,
    `"@authority": ${authority}`,
    `"@path": ${path}`,
    `"content-digest": ${contentDigest}`,
    `"content-type": ${PUBLISH_CONTENT_TYPE}`,
    `"atrinik-server-id": ${serverId}`,
    `"atrinik-publish-sequence": ${sequence}`,
    `"@signature-params": ${signatureParameters.serialized}`,
  ].join("\n");

  const certificateDer = decodeCanonicalBase64(payload.certificate);
  if (
    certificateDer.length === 0 ||
    certificateDer.length > PUBLISH_MAXIMUM_CERTIFICATE_BYTES
  ) {
    throw new HttpError("unauthorized");
  }
  const fingerprint = await crypto.subtle.digest("SHA-256", certificateDer);
  if (bytesToHex(new Uint8Array(fingerprint)) !== serverId) {
    throw new HttpError("unauthorized");
  }

  let verified = false;
  try {
    const subjectPublicKeyInfo = extractSubjectPublicKeyInfo(certificateDer);
    const publicKey = await crypto.subtle.importKey(
      "spki",
      subjectPublicKeyInfo,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    verified = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      signature,
      TEXT_ENCODER.encode(signatureBase),
    );
  } catch {
    throw new HttpError("unauthorized");
  }
  if (!verified) {
    throw new HttpError("unauthorized");
  }

  return Object.freeze({
    payload,
    sequence,
    nonce: signatureParameters.nonce,
    nonceExpiresAt: now + PUBLISH_NONCE_RETENTION_SECONDS,
    certificateDer,
  });
}

export async function readBoundedPublishBody(
  request: Request,
  maximum = PUBLISH_MAXIMUM_BODY_BYTES,
): Promise<Uint8Array> {
  if (request.body === null) {
    throw new HttpError("body_required");
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > maximum) {
      try {
        await reader.cancel();
      } catch {
        // Cancellation is best-effort and must not replace the fixed 413.
      }
      throw new HttpError("payload_too_large");
    }
    chunks.push(value);
  }
  if (size === 0) {
    throw new HttpError("body_required");
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

interface SignatureParameters {
  readonly serialized: string;
  readonly nonce: string;
}

function parseSignatureInput(
  value: string,
  serverId: string,
  tag: string,
  now: number,
): SignatureParameters {
  const prefix = `${PUBLISH_SIGNATURE_LABEL}=${COVERED_COMPONENTS};created=`;
  if (!value.startsWith(prefix)) {
    throw new HttpError("unauthorized");
  }
  const remainder = value.slice(prefix.length);
  const match = /^(\d{1,15});expires=(\d{1,15});nonce="([0-9a-f]{32})";alg="ecdsa-p256-sha256";keyid="([0-9a-f]{64})";tag="([a-z0-9-]{1,64})"$/.exec(
    remainder,
  );
  if (match === null) {
    throw new HttpError("unauthorized");
  }
  const createdRaw = match[1];
  const expiresRaw = match[2];
  const nonce = match[3];
  const keyId = match[4];
  const parsedTag = match[5];
  if (
    createdRaw === undefined ||
    expiresRaw === undefined ||
    nonce === undefined ||
    keyId === undefined ||
    parsedTag === undefined ||
    !STRUCTURED_FIELD_INTEGER.test(createdRaw) ||
    !STRUCTURED_FIELD_INTEGER.test(expiresRaw) ||
    !NONCE.test(nonce) ||
    /^0+$/.test(nonce) ||
    keyId !== serverId ||
    parsedTag !== tag
  ) {
    throw new HttpError("unauthorized");
  }
  const created = Number(createdRaw);
  const expires = Number(expiresRaw);
  if (
    !Number.isSafeInteger(created) ||
    !Number.isSafeInteger(expires) ||
    expires !== created + PUBLISH_SIGNATURE_VALIDITY_SECONDS ||
    created > now + PUBLISH_SIGNATURE_VALIDITY_SECONDS ||
    now > expires
  ) {
    throw new HttpError("unauthorized");
  }
  return {
    serialized: value.slice(`${PUBLISH_SIGNATURE_LABEL}=`.length),
    nonce,
  };
}

function parseSignature(value: string): Uint8Array {
  const prefix = `${PUBLISH_SIGNATURE_LABEL}=:`;
  if (!value.startsWith(prefix) || !value.endsWith(":")) {
    throw new HttpError("unauthorized");
  }
  const signature = decodeCanonicalBase64(
    value.slice(prefix.length, -1),
  );
  if (signature.length !== 64) {
    throw new HttpError("unauthorized");
  }
  return signature;
}

function parseClassicPublishPayload(body: Uint8Array): ClassicPublishPayload {
  return parseClassicPayload(
    body,
    CLASSIC_PUBLISH_SCHEMA,
    "passwordRequired",
  ) as ClassicPublishPayload;
}

function parseClassicV2PublishPayload(
  body: Uint8Array,
): ClassicV2PublishPayload {
  return parseClassicPayload(
    body,
    CLASSIC_V2_PUBLISH_SCHEMA,
    "accessCodeRequired",
  ) as ClassicV2PublishPayload;
}

function parseClassicPayload(
  body: Uint8Array,
  schema: typeof CLASSIC_PUBLISH_SCHEMA | typeof CLASSIC_V2_PUBLISH_SCHEMA,
  policyKey: "passwordRequired" | "accessCodeRequired",
): ClassicPublishPayload | ClassicV2PublishPayload {
  let raw: string;
  let parsed: unknown;
  try {
    raw = TEXT_DECODER.decode(body);
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError("bad_request");
  }
  if (!isRecord(parsed)) {
    throw new HttpError("bad_request");
  }
  const requiredKeys = [
    "schema",
    "serverId",
    "certificate",
    "name",
    "playersCount",
    "version",
    "textComment",
    "public",
    policyKey,
  ] as const;
  const hasHostname = Object.hasOwn(parsed, "hostname");
  const hasPort = Object.hasOwn(parsed, "port");
  const expectedKeys = hasHostname || hasPort
    ? [...requiredKeys, "hostname", "port"]
    : [...requiredKeys];
  if (
    hasHostname !== hasPort ||
    Object.keys(parsed).length !== expectedKeys.length ||
    !expectedKeys.every((key) => Object.hasOwn(parsed, key)) ||
    parsed.schema !== schema ||
    typeof parsed.serverId !== "string" ||
    !SERVER_ID.test(parsed.serverId) ||
    typeof parsed.certificate !== "string" ||
    parsed.certificate.length > 2_732 ||
    !isDirectoryText(parsed.name, 80, false) ||
    !validUnsignedInteger(parsed.playersCount, 4_294_967_295) ||
    !isDirectoryText(parsed.version, 32, false) ||
    !isDirectoryText(parsed.textComment, 256, true) ||
    typeof parsed.public !== "boolean" ||
    typeof parsed[policyKey] !== "boolean" ||
    (hasHostname && !isCanonicalHostname(parsed.hostname)) ||
    (hasPort && !validUnsignedInteger(parsed.port, 65_535, 1))
  ) {
    throw new HttpError("bad_request");
  }

  const common = {
    serverId: parsed.serverId,
    certificate: parsed.certificate,
    name: parsed.name,
    playersCount: parsed.playersCount,
    version: parsed.version,
    textComment: parsed.textComment,
    public: parsed.public,
  } as const;
  if (policyKey === "passwordRequired") {
    const payload: ClassicPublishPayload = {
      schema: CLASSIC_PUBLISH_SCHEMA,
      ...common,
      passwordRequired: parsed.passwordRequired as boolean,
      ...(hasHostname
        ? { hostname: parsed.hostname as string, port: parsed.port as number }
        : {}),
    };
    if (JSON.stringify(payload) !== raw) {
      throw new HttpError("bad_request");
    }
    return Object.freeze(payload);
  }
  const payload: ClassicV2PublishPayload = {
    schema: CLASSIC_V2_PUBLISH_SCHEMA,
    ...common,
    accessCodeRequired: parsed.accessCodeRequired as boolean,
    ...(hasHostname
      ? { hostname: parsed.hostname as string, port: parsed.port as number }
      : {}),
  };
  if (JSON.stringify(payload) !== raw) {
    throw new HttpError("bad_request");
  }
  return Object.freeze(payload);
}

function parseGamePublishPayload(body: Uint8Array): GamePublishPayload {
  let raw: string;
  let parsed: unknown;
  try {
    raw = TEXT_DECODER.decode(body);
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError("bad_request");
  }
  if (!isRecord(parsed)) {
    throw new HttpError("bad_request");
  }
  const hasRegion = Object.hasOwn(parsed, "region");
  const hasEndpoint = Object.hasOwn(parsed, "endpoint");
  const expectedKeys = [
    "schema",
    "serverId",
    "certificate",
    "name",
    "description",
    ...(hasRegion ? ["region"] : []),
    "protocol",
    "content",
    "players",
    "status",
    "public",
    "passwordRequired",
    ...(hasEndpoint ? ["endpoint"] : []),
  ];
  if (
    Object.keys(parsed).length !== expectedKeys.length ||
    !expectedKeys.every((key) => Object.hasOwn(parsed, key)) ||
    parsed.schema !== GAME_PUBLISH_SCHEMA ||
    typeof parsed.serverId !== "string" ||
    !SERVER_ID.test(parsed.serverId) ||
    typeof parsed.certificate !== "string" ||
    parsed.certificate.length > 2_732 ||
    !isGameDirectoryText(parsed.name, 80, false) ||
    !isGameDirectoryText(parsed.description, 512, true) ||
    (hasRegion &&
      (typeof parsed.region !== "string" || !REGION.test(parsed.region))) ||
    !isRecord(parsed.protocol) ||
    Object.keys(parsed.protocol).join(",") !== "major,minor" ||
    parsed.protocol.major !== 1 ||
    !validUnsignedInteger(parsed.protocol.minor, 65_535) ||
    !isRecord(parsed.content) ||
    Object.keys(parsed.content).join(",") !== "id,revisionSha256" ||
    typeof parsed.content.id !== "string" ||
    !CONTENT_ID.test(parsed.content.id) ||
    typeof parsed.content.revisionSha256 !== "string" ||
    !DIGEST.test(parsed.content.revisionSha256) ||
    !isRecord(parsed.players) ||
    Object.keys(parsed.players).join(",") !== "online,capacity" ||
    !validUnsignedInteger(parsed.players.online, 100_000) ||
    !validUnsignedInteger(parsed.players.capacity, 100_000, 1) ||
    parsed.players.online > parsed.players.capacity ||
    (parsed.status !== "online" &&
      parsed.status !== "full" && parsed.status !== "maintenance") ||
    (parsed.status === "online" &&
      parsed.players.online >= parsed.players.capacity) ||
    (parsed.status === "full" &&
      parsed.players.online !== parsed.players.capacity) ||
    (parsed.status === "maintenance" && parsed.players.online !== 0) ||
    typeof parsed.public !== "boolean" ||
    typeof parsed.passwordRequired !== "boolean" ||
    (hasEndpoint &&
      (!isRecord(parsed.endpoint) ||
        Object.keys(parsed.endpoint).join(",") !== "hostname,port" ||
        !isCanonicalHostname(parsed.endpoint.hostname) ||
        !validUnsignedInteger(parsed.endpoint.port, 65_535, 1)))
  ) {
    throw new HttpError("bad_request");
  }

  const payload: GamePublishPayload = {
    schema: GAME_PUBLISH_SCHEMA,
    serverId: parsed.serverId,
    certificate: parsed.certificate,
    name: parsed.name,
    description: parsed.description,
    ...(hasRegion ? { region: parsed.region as string } : {}),
    protocol: {
      major: 1,
      minor: parsed.protocol.minor,
    },
    content: {
      id: parsed.content.id,
      revisionSha256: parsed.content.revisionSha256,
    },
    players: {
      online: parsed.players.online,
      capacity: parsed.players.capacity,
    },
    status: parsed.status,
    public: parsed.public,
    passwordRequired: parsed.passwordRequired,
    ...(hasEndpoint
      ? {
          endpoint: {
            hostname: (parsed.endpoint as Record<string, unknown>).hostname as string,
            port: (parsed.endpoint as Record<string, unknown>).port as number,
          },
        }
      : {}),
  };
  if (JSON.stringify(payload) !== raw) {
    throw new HttpError("bad_request");
  }
  return Object.freeze(payload);
}

export function isValidPublisherSequence(value: string): boolean {
  if (!SEQUENCE.test(value)) {
    return false;
  }
  try {
    const parsed = BigInt(value);
    return parsed > 0n && parsed <= UINT64_MAXIMUM;
  } catch {
    return false;
  }
}

function validUnsignedInteger(
  value: unknown,
  maximum: number,
  minimum = 0,
): value is number {
  return typeof value === "number" && Number.isInteger(value) &&
    value >= minimum && value <= maximum;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireHeader(headers: Headers, name: string): string {
  const value = headers.get(name);
  if (value === null) {
    throw new HttpError("unauthorized");
  }
  return value;
}

function decodeCanonicalBase64(value: string): Uint8Array {
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !PADDED_BASE64.test(value)
  ) {
    throw new HttpError("unauthorized");
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new HttpError("unauthorized");
  }
  const decoded = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (encodeBase64(decoded) !== value) {
    throw new HttpError("unauthorized");
  }
  return decoded;
}

function encodeBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function bytesToHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface DerElement {
  readonly tag: number;
  readonly start: number;
  readonly contentStart: number;
  readonly end: number;
}

function extractSubjectPublicKeyInfo(certificate: Uint8Array): Uint8Array {
  const outer = readDerElement(certificate, 0);
  if (outer.tag !== 0x30 || outer.end !== certificate.length) {
    throw new Error("invalid certificate");
  }

  const tbsCertificate = readDerElement(certificate, outer.contentStart);
  if (tbsCertificate.tag !== 0x30) {
    throw new Error("invalid certificate");
  }
  const signatureAlgorithm = readDerElement(certificate, tbsCertificate.end);
  const signatureValue = readDerElement(certificate, signatureAlgorithm.end);
  if (
    signatureAlgorithm.tag !== 0x30 ||
    signatureValue.tag !== 0x03 ||
    signatureValue.end !== outer.end
  ) {
    throw new Error("invalid certificate");
  }

  let offset = tbsCertificate.contentStart;
  let field = readDerElement(certificate, offset);
  if (field.tag === 0xa0) {
    offset = field.end;
    field = readDerElement(certificate, offset);
  }
  if (field.tag !== 0x02) {
    throw new Error("invalid certificate");
  }
  offset = field.end;
  for (let index = 0; index < 4; index += 1) {
    field = readDerElement(certificate, offset);
    if (field.tag !== 0x30) {
      throw new Error("invalid certificate");
    }
    offset = field.end;
  }
  const subjectPublicKeyInfo = readDerElement(certificate, offset);
  if (
    subjectPublicKeyInfo.tag !== 0x30 ||
    subjectPublicKeyInfo.end > tbsCertificate.end
  ) {
    throw new Error("invalid certificate");
  }
  return certificate.slice(subjectPublicKeyInfo.start, subjectPublicKeyInfo.end);
}

function readDerElement(value: Uint8Array, offset: number): DerElement {
  const start = offset;
  if (offset + 2 > value.length) {
    throw new Error("truncated DER element");
  }
  const tag = value[offset];
  const firstLength = value[offset + 1];
  if (tag === undefined || firstLength === undefined || (tag & 0x1f) === 0x1f) {
    throw new Error("unsupported DER element");
  }
  offset += 2;

  let length = firstLength;
  if ((firstLength & 0x80) !== 0) {
    const lengthBytes = firstLength & 0x7f;
    if (
      lengthBytes === 0 ||
      lengthBytes > 4 ||
      offset + lengthBytes > value.length ||
      value[offset] === 0
    ) {
      throw new Error("invalid DER length");
    }
    length = 0;
    for (let index = 0; index < lengthBytes; index += 1) {
      length = length * 256 + (value[offset + index] ?? 0);
    }
    if (length < 128) {
      throw new Error("non-canonical DER length");
    }
    offset += lengthBytes;
  }
  const end = offset + length;
  if (!Number.isSafeInteger(end) || end > value.length) {
    throw new Error("truncated DER value");
  }
  return { tag, start, contentStart: offset, end };
}
