import {
  isDirectoryText,
  isGameDirectoryText,
  MAX_DIRECTORY_ENTRIES_PER_PROFILE,
} from "./directory-state";
import { isCanonicalHostname } from "./hostname";

export const CLASSIC_DIRECTORY_SCHEMA = "atrinik-classic-directory-v4";
export const CLASSIC_DIRECTORY_PROTOCOL = 4;
export const GAME_DIRECTORY_SCHEMA = "atrinik-directory-v1";
export const MAX_CLASSIC_DIRECTORY_ARTIFACT_BYTES = 4 * 1024 * 1024;
export const MAX_GAME_DIRECTORY_JSON_BYTES = 262_144;
export const MAX_GAME_DIRECTORY_PROJECTION_BYTES = 4 * 1024 * 1024;
export const MAX_DIRECTORY_LIFETIME_SECONDS = 14_400;
// The maximum-size canonical envelope with an empty server array is 139 bytes.
// Reserving that full amount (rather than subtracting the two array brackets)
// leaves a small fail-closed margin while D1 accounts for server objects and
// their separating commas.
export const MAX_GAME_DIRECTORY_JSON_SERVER_SET_BYTES =
  MAX_GAME_DIRECTORY_JSON_BYTES - 139;

const MAX_DIRECTORY_TIMESTAMP = 253_402_300_799;
const MAX_CLASSIC_PLAYERS = 4_294_967_295;
const MAX_UINT64 = 18_446_744_073_709_551_615n;
const HEX_64 = /^[0-9a-f]{64}$/;
const CANONICAL_GENERATION = /^[1-9][0-9]{0,19}$/;
const REGION = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const CONTENT_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const TEXT_ENCODER = new TextEncoder();

export type DirectoryArtifactProfile = "classic-v1" | "game-v1";
export type DirectoryArtifactFormat = "html" | "json" | "xml";

export interface DirectDirectoryEndpoint {
  readonly hostname: string;
  readonly port: number;
}

export interface ClassicDirectoryServer {
  readonly serverId: string;
  readonly name: string;
  readonly playersCount: number;
  readonly version: string;
  readonly textComment: string;
  readonly certificateSha256: string;
  readonly passwordRequired: boolean;
  readonly endpoint?: DirectDirectoryEndpoint;
}

export interface GameDirectoryServer {
  readonly serverId: string;
  readonly certificateSha256: string;
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
  readonly passwordRequired: boolean;
  readonly endpoint?: DirectDirectoryEndpoint;
}

interface DirectorySnapshotMetadata {
  readonly revision: number;
  readonly generation: string;
  readonly generatedAt: number;
  readonly expiresAt: number;
}

export interface ClassicDirectorySnapshot extends DirectorySnapshotMetadata {
  readonly profile: "classic-v1";
  readonly servers: readonly ClassicDirectoryServer[];
}

export interface GameDirectorySnapshot extends DirectorySnapshotMetadata {
  readonly profile: "game-v1";
  readonly servers: readonly GameDirectoryServer[];
}

export type DirectorySnapshot =
  | ClassicDirectorySnapshot
  | GameDirectorySnapshot;

export interface DirectoryArtifactDescriptor {
  readonly format: DirectoryArtifactFormat;
  readonly path: "/index.html" | "/index.json" | "/index.xml";
  readonly contentType: string;
  readonly body: string;
  readonly bodyBytes: Uint8Array;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface RenderedDirectoryGeneration {
  readonly profile: DirectoryArtifactProfile;
  readonly schema: string;
  readonly revision: number;
  readonly generation: string;
  readonly generatedAt: number;
  readonly expiresAt: number;
  readonly serverCount: number;
  readonly artifacts: {
    readonly html: DirectoryArtifactDescriptor;
    readonly xml: DirectoryArtifactDescriptor;
    readonly json: DirectoryArtifactDescriptor;
  };
}

/**
 * Validate one bounded profile model, render every representation from the
 * same isolated canonical copy, then calculate representation-specific body
 * metadata. Body hashes deliberately remain outside the hashed bodies and are
 * independent of the static origin's opaque HTTP validators.
 */
export async function renderDirectoryArtifacts(
  snapshot: DirectorySnapshot,
): Promise<RenderedDirectoryGeneration> {
  const canonical = canonicalizeSnapshot(snapshot);
  const schema = canonical.profile === "classic-v1"
    ? CLASSIC_DIRECTORY_SCHEMA
    : GAME_DIRECTORY_SCHEMA;
  const htmlBody = renderHtml(canonical);
  const jsonBody = canonical.profile === "classic-v1"
    ? renderClassicJson(canonical)
    : renderGameJson(canonical);
  const xmlBody = canonical.profile === "classic-v1"
    ? renderClassicXml(canonical)
    : renderGameXml(canonical);

  const [html, xml, json] = await Promise.all([
    createArtifact(canonical.profile, "html", htmlBody),
    createArtifact(canonical.profile, "xml", xmlBody),
    createArtifact(canonical.profile, "json", jsonBody),
  ]);

  return {
    profile: canonical.profile,
    schema,
    revision: canonical.revision,
    generation: canonical.generation,
    generatedAt: canonical.generatedAt,
    expiresAt: canonical.expiresAt,
    serverCount: canonical.servers.length,
    artifacts: { html, xml, json },
  };
}

/**
 * Return the exact UTF-8 byte length contributed by one canonical Game v1
 * server object. Publication persists this derived value so D1 can enforce the
 * complete-snapshot limit atomically across independently publishing servers.
 */
export function gameDirectoryServerJsonByteLength(
  server: GameDirectoryServer,
): number {
  const canonical = canonicalizeGameServer(server, 0);
  return TEXT_ENCODER.encode(JSON.stringify(gameJsonServer(canonical)))
    .byteLength;
}

function canonicalizeSnapshot(snapshot: DirectorySnapshot): DirectorySnapshot {
  const value = exactRecord(snapshot, [
    "profile",
    "revision",
    "generation",
    "generatedAt",
    "expiresAt",
    "servers",
  ], [], "snapshot");
  const metadata = canonicalizeMetadata(value);
  const serverInputs = exactArray(
    value.servers,
    MAX_DIRECTORY_ENTRIES_PER_PROFILE,
    "servers",
  );

  if (value.profile === "classic-v1") {
    const servers = serverInputs.map((server, index) =>
      canonicalizeClassicServer(server, index)
    );
    sortAndRejectDuplicateServers(servers);
    return { profile: "classic-v1", ...metadata, servers };
  }
  if (value.profile === "game-v1") {
    const servers = serverInputs.map((server, index) =>
      canonicalizeGameServer(server, index)
    );
    sortAndRejectDuplicateServers(servers);
    return { profile: "game-v1", ...metadata, servers };
  }
  return invalidModel("profile");
}

function canonicalizeMetadata(
  value: Readonly<Record<string, unknown>>,
): DirectorySnapshotMetadata {
  const revision = integer(value.revision, 0, Number.MAX_SAFE_INTEGER, "revision");
  if (
    typeof value.generation !== "string" ||
    !CANONICAL_GENERATION.test(value.generation) ||
    BigInt(value.generation) > MAX_UINT64
  ) {
    invalidModel("generation");
  }
  const generatedAt = integer(
    value.generatedAt,
    0,
    MAX_DIRECTORY_TIMESTAMP,
    "generatedAt",
  );
  const expiresAt = integer(
    value.expiresAt,
    1,
    MAX_DIRECTORY_TIMESTAMP,
    "expiresAt",
  );
  if (
    expiresAt <= generatedAt ||
    expiresAt - generatedAt > MAX_DIRECTORY_LIFETIME_SECONDS
  ) {
    invalidModel("freshness");
  }
  return {
    revision,
    generation: value.generation,
    generatedAt,
    expiresAt,
  };
}

function canonicalizeClassicServer(
  input: unknown,
  index: number,
): ClassicDirectoryServer {
  const context = `classic server ${index}`;
  const value = exactRecord(input, [
    "serverId",
    "name",
    "playersCount",
    "version",
    "textComment",
    "certificateSha256",
    "passwordRequired",
  ], ["endpoint"], context);
  const serverId = digest(value.serverId, `${context} identity`);
  const certificateSha256 = digest(
    value.certificateSha256,
    `${context} certificate`,
  );
  if (serverId !== certificateSha256) {
    invalidModel(`${context} identity`);
  }
  const name = directoryText(value.name, 80, false, false, `${context} name`);
  const version = directoryText(
    value.version,
    32,
    false,
    false,
    `${context} version`,
  );
  const textComment = directoryText(
    value.textComment,
    256,
    true,
    false,
    `${context} comment`,
  );
  if (typeof value.passwordRequired !== "boolean") {
    invalidModel(`${context} password requirement`);
  }
  const endpoint = Object.hasOwn(value, "endpoint")
    ? canonicalizeEndpoint(value.endpoint, `${context} endpoint`)
    : undefined;

  return {
    serverId,
    name,
    playersCount: integer(
      value.playersCount,
      0,
      MAX_CLASSIC_PLAYERS,
      `${context} players`,
    ),
    version,
    textComment,
    certificateSha256,
    passwordRequired: value.passwordRequired,
    ...(endpoint === undefined ? {} : { endpoint }),
  };
}

function canonicalizeGameServer(
  input: unknown,
  index: number,
): GameDirectoryServer {
  const context = `game server ${index}`;
  const value = exactRecord(input, [
    "serverId",
    "certificateSha256",
    "name",
    "description",
    "protocol",
    "content",
    "players",
    "status",
    "passwordRequired",
  ], ["region", "endpoint"], context);
  const serverId = digest(value.serverId, `${context} identity`);
  const certificateSha256 = digest(
    value.certificateSha256,
    `${context} certificate`,
  );
  if (serverId !== certificateSha256) {
    invalidModel(`${context} identity`);
  }
  const protocol = exactRecord(
    value.protocol,
    ["major", "minor"],
    [],
    `${context} protocol`,
  );
  if (protocol.major !== 1) {
    invalidModel(`${context} protocol`);
  }
  const content = exactRecord(
    value.content,
    ["id", "revisionSha256"],
    [],
    `${context} content`,
  );
  if (
    typeof content.id !== "string" ||
    content.id.length > 64 ||
    TEXT_ENCODER.encode(content.id).byteLength > 64 ||
    !CONTENT_ID.test(content.id)
  ) {
    invalidModel(`${context} content`);
  }
  const players = exactRecord(
    value.players,
    ["online", "capacity"],
    [],
    `${context} players`,
  );
  const online = integer(players.online, 0, 100_000, `${context} players`);
  const capacity = integer(players.capacity, 1, 100_000, `${context} players`);
  if (online > capacity) {
    invalidModel(`${context} players`);
  }
  if (
    value.status !== "online" &&
    value.status !== "full" &&
    value.status !== "maintenance"
  ) {
    invalidModel(`${context} status`);
  }
  if (
    (value.status === "online" && online >= capacity) ||
    (value.status === "full" && online !== capacity) ||
    (value.status === "maintenance" && online !== 0)
  ) {
    invalidModel(`${context} status`);
  }
  if (typeof value.passwordRequired !== "boolean") {
    invalidModel(`${context} password requirement`);
  }
  let region: string | undefined;
  if (Object.hasOwn(value, "region")) {
    if (
      typeof value.region !== "string" ||
      value.region.length > 32 ||
      TEXT_ENCODER.encode(value.region).byteLength > 32 ||
      !REGION.test(value.region)
    ) {
      invalidModel(`${context} region`);
    }
    region = value.region;
  }
  const endpoint = Object.hasOwn(value, "endpoint")
    ? canonicalizeEndpoint(value.endpoint, `${context} endpoint`)
    : undefined;

  return {
    serverId,
    certificateSha256,
    name: directoryText(value.name, 80, false, true, `${context} name`),
    description: directoryText(
      value.description,
      512,
      true,
      true,
      `${context} description`,
    ),
    ...(region === undefined ? {} : { region }),
    protocol: {
      major: 1,
      minor: integer(protocol.minor, 0, 65_535, `${context} protocol`),
    },
    content: {
      id: content.id,
      revisionSha256: digest(
        content.revisionSha256,
        `${context} content revision`,
      ),
    },
    players: { online, capacity },
    status: value.status,
    passwordRequired: value.passwordRequired,
    ...(endpoint === undefined ? {} : { endpoint }),
  };
}

function canonicalizeEndpoint(
  input: unknown,
  context: string,
): DirectDirectoryEndpoint {
  const value = exactRecord(input, ["hostname", "port"], [], context);
  if (!isCanonicalHostname(value.hostname)) {
    invalidModel(context);
  }
  return {
    hostname: value.hostname,
    port: integer(value.port, 1, 65_535, context),
  };
}

function renderClassicJson(snapshot: ClassicDirectorySnapshot): string {
  return JSON.stringify({
    schema: CLASSIC_DIRECTORY_SCHEMA,
    protocol: CLASSIC_DIRECTORY_PROTOCOL,
    generation: snapshot.generation,
    generatedAt: snapshot.generatedAt,
    expiresAt: snapshot.expiresAt,
    servers: snapshot.servers.map((server) => ({
      serverId: server.serverId,
      name: server.name,
      playersCount: server.playersCount,
      version: server.version,
      textComment: server.textComment,
      certificateSha256: server.certificateSha256,
      passwordRequired: server.passwordRequired,
      ...(server.endpoint === undefined
        ? {}
        : { endpoint: { ...server.endpoint } }),
    })),
  }) + "\n";
}

function renderGameJson(snapshot: GameDirectorySnapshot): string {
  return JSON.stringify({
    schema: GAME_DIRECTORY_SCHEMA,
    generation: snapshot.generation,
    generatedAt: String(snapshot.generatedAt),
    expiresAt: String(snapshot.expiresAt),
    servers: snapshot.servers.map(gameJsonServer),
  }) + "\n";
}

function gameJsonServer(server: GameDirectoryServer): object {
  return {
    serverId: server.serverId,
    certificateSha256: server.certificateSha256,
    name: server.name,
    description: server.description,
    ...(server.region === undefined ? {} : { region: server.region }),
    protocol: { ...server.protocol },
    content: { ...server.content },
    players: { ...server.players },
    status: server.status,
    passwordRequired: server.passwordRequired,
    ...(server.endpoint === undefined
      ? {}
      : { endpoint: { ...server.endpoint } }),
  };
}

function renderClassicXml(snapshot: ClassicDirectorySnapshot): string {
  const servers = snapshot.servers.map((server) => {
    const endpoint = server.endpoint === undefined
      ? ""
      : `\n    <Address>${escapeXml(server.endpoint.hostname)}</Address>` +
        `\n    <Port>${server.endpoint.port}</Port>`;
    return (
      "  <Server>\n" +
      `    <Id>${server.serverId}</Id>\n` +
      `    <Name>${escapeXml(server.name)}</Name>\n` +
      `    <PlayersCount>${server.playersCount}</PlayersCount>\n` +
      `    <Version>${escapeXml(server.version)}</Version>\n` +
      `    <TextComment>${escapeXml(server.textComment)}</TextComment>` +
      endpoint + "\n" +
      `    <CertificateSha256>${server.certificateSha256}</CertificateSha256>\n` +
      `    <PasswordRequired>${server.passwordRequired}</PasswordRequired>\n` +
      "  </Server>"
    );
  }).join("\n");
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<Servers protocol="${CLASSIC_DIRECTORY_PROTOCOL}" ` +
    `schema="${CLASSIC_DIRECTORY_SCHEMA}" ` +
    `generation="${snapshot.generation}" ` +
    `generated-at="${snapshot.generatedAt}" ` +
    `expires-at="${snapshot.expiresAt}">` +
    (servers === "" ? "" : `\n${servers}`) +
    "\n</Servers>\n"
  );
}

function renderGameXml(snapshot: GameDirectorySnapshot): string {
  const servers = snapshot.servers.map((server) => {
    const region = server.region === undefined
      ? ""
      : `\n    <region>${escapeXml(server.region)}</region>`;
    const endpoint = server.endpoint === undefined
      ? ""
      : `\n    <endpoint hostname="${escapeXml(server.endpoint.hostname)}" ` +
        `port="${server.endpoint.port}"/>`;
    return (
      `  <server id="${server.serverId}" ` +
      `certificate-sha256="${server.certificateSha256}" ` +
      `status="${server.status}" ` +
      `password-required="${server.passwordRequired}">\n` +
      `    <name>${escapeXml(server.name)}</name>\n` +
      `    <description>${escapeXml(server.description)}</description>` +
      region + "\n" +
      `    <protocol major="1" minor="${server.protocol.minor}"/>\n` +
      `    <content id="${escapeXml(server.content.id)}" ` +
      `revision-sha256="${server.content.revisionSha256}"/>\n` +
      `    <players online="${server.players.online}" ` +
      `capacity="${server.players.capacity}"/>` +
      endpoint + "\n" +
      "  </server>"
    );
  }).join("\n");
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<directory schema="${GAME_DIRECTORY_SCHEMA}" ` +
    `generation="${snapshot.generation}" ` +
    `generated-at="${snapshot.generatedAt}" ` +
    `expires-at="${snapshot.expiresAt}">` +
    (servers === "" ? "" : `\n${servers}`) +
    "\n</directory>\n"
  );
}

function renderHtml(snapshot: DirectorySnapshot): string {
  const isClassic = snapshot.profile === "classic-v1";
  const schema = isClassic ? CLASSIC_DIRECTORY_SCHEMA : GAME_DIRECTORY_SCHEMA;
  const title = isClassic ? "Atrinik Classic servers" : "Atrinik servers";
  const headings = isClassic
    ? [
      "Server ID",
      "Name",
      "Version",
      "Players",
      "Comment",
      "Certificate SHA-256",
      "Status",
      "Password",
      "Direct endpoint",
    ]
    : [
      "Server ID",
      "Certificate SHA-256",
      "Name",
      "Description",
      "Region",
      "Protocol",
      "Content ID",
      "Content revision SHA-256",
      "Players",
      "Status",
      "Password",
      "Direct endpoint",
    ];
  const rows = isClassic
    ? snapshot.servers.map(renderClassicHtmlRow)
    : snapshot.servers.map(renderGameHtmlRow);
  return (
    "<!doctype html>\n" +
    '<html lang="en">\n' +
    "<head>\n" +
    '  <meta charset="utf-8">\n' +
    '  <meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    "  <meta http-equiv=\"Content-Security-Policy\" " +
    "content=\"default-src 'none'; base-uri 'none'; form-action 'none'\">\n" +
    `  <title>${title}</title>\n` +
    "</head>\n" +
    "<body>\n" +
    "<main>\n" +
    `  <h1>${title}</h1>\n` +
    "  <dl>\n" +
    `    <dt>Schema</dt><dd><code>${schema}</code></dd>\n` +
    `    <dt>Generation</dt><dd>${snapshot.generation}</dd>\n` +
    `    <dt>Generated at</dt><dd>${snapshot.generatedAt}</dd>\n` +
    `    <dt>Expires at</dt><dd>${snapshot.expiresAt}</dd>\n` +
    "  </dl>\n" +
    "  <table>\n" +
    `    <thead><tr>${headings.map((heading) =>
      `<th scope="col">${heading}</th>`
    ).join("")}</tr></thead>\n` +
    `    <tbody>${rows.length === 0 ? "" : `\n${rows.join("\n")}\n    `}</tbody>\n` +
    "  </table>\n" +
    "</main>\n" +
    "</body>\n" +
    "</html>\n"
  );
}

function renderClassicHtmlRow(server: ClassicDirectoryServer): string {
  return (
    "      <tr>" +
    `<td><code>${server.serverId}</code></td>` +
    `<td>${escapeHtml(server.name)}</td>` +
    `<td>${escapeHtml(server.version)}</td>` +
    `<td>${server.playersCount}</td>` +
    `<td>${escapeHtml(server.textComment)}</td>` +
    `<td><code>${server.certificateSha256}</code></td>` +
    "<td>listed</td>" +
    `<td>${server.passwordRequired ? "required" : "not required"}</td>` +
    `<td>${renderHtmlEndpoint(server.endpoint)}</td>` +
    "</tr>"
  );
}

function renderGameHtmlRow(server: GameDirectoryServer): string {
  return (
    "      <tr>" +
    `<td><code>${server.serverId}</code></td>` +
    `<td><code>${server.certificateSha256}</code></td>` +
    `<td>${escapeHtml(server.name)}</td>` +
    `<td>${escapeHtml(server.description)}</td>` +
    `<td>${server.region === undefined ? "not published" : escapeHtml(server.region)}</td>` +
    `<td>1.${server.protocol.minor}</td>` +
    `<td>${escapeHtml(server.content.id)}</td>` +
    `<td><code>${server.content.revisionSha256}</code></td>` +
    `<td>${server.players.online}/${server.players.capacity}</td>` +
    `<td>${server.status}</td>` +
    `<td>${server.passwordRequired ? "required" : "not required"}</td>` +
    `<td>${renderHtmlEndpoint(server.endpoint)}</td>` +
    "</tr>"
  );
}

function renderHtmlEndpoint(endpoint: DirectDirectoryEndpoint | undefined): string {
  return endpoint === undefined
    ? "not published"
    : `<code>${escapeHtml(endpoint.hostname)}:${endpoint.port}</code>`;
}

async function createArtifact(
  profile: DirectoryArtifactProfile,
  format: DirectoryArtifactFormat,
  body: string,
): Promise<DirectoryArtifactDescriptor> {
  const bodyBytes = TEXT_ENCODER.encode(body);
  const byteLength = bodyBytes.byteLength;
  const maximum = profile === "classic-v1"
    ? MAX_CLASSIC_DIRECTORY_ARTIFACT_BYTES
    : format === "json"
    ? MAX_GAME_DIRECTORY_JSON_BYTES
    : MAX_GAME_DIRECTORY_PROJECTION_BYTES;
  if (byteLength > maximum) {
    throw new RangeError("Directory artifact exceeds its byte limit");
  }
  const sha256 = bytesToHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bodyBytes)),
  );
  const path = `/index.${format}` as DirectoryArtifactDescriptor["path"];
  const contentType = format === "html"
    ? "text/html; charset=utf-8"
    : format === "json"
    ? "application/json; charset=utf-8"
    : "application/xml; charset=utf-8";
  return {
    format,
    path,
    contentType,
    body,
    bodyBytes,
    byteLength,
    sha256,
  };
}

function exactRecord(
  input: unknown,
  required: readonly string[],
  optional: readonly string[],
  context: string,
): Readonly<Record<string, unknown>> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return invalidModel(context);
  }
  try {
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) {
      return invalidModel(context);
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Reflect.ownKeys(descriptors);
    const allowed = new Set([...required, ...optional]);
    if (
      keys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
      required.some((key) => !Object.hasOwn(descriptors, key))
    ) {
      return invalidModel(context);
    }
    const result: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      if (typeof key !== "string") {
        return invalidModel(context);
      }
      const descriptor = descriptors[key];
      if (!("value" in descriptor)) {
        return invalidModel(context);
      }
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return invalidModel(context);
  }
}

function exactArray(
  input: unknown,
  maximumLength: number,
  context: string,
): readonly unknown[] {
  if (!Array.isArray(input)) {
    return invalidModel(context);
  }
  try {
    if (Object.getPrototypeOf(input) !== Array.prototype) {
      return invalidModel(context);
    }
    const descriptors = Object.getOwnPropertyDescriptors(input) as unknown as
      Record<PropertyKey, PropertyDescriptor | undefined>;
    const lengthDescriptor = descriptors.length;
    if (
      lengthDescriptor === undefined ||
      !("value" in lengthDescriptor) ||
      typeof lengthDescriptor.value !== "number" ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0 ||
      lengthDescriptor.value > maximumLength
    ) {
      return invalidModel(context);
    }
    const length = lengthDescriptor.value as number;
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== length + 1 ||
      keys.some((key) =>
        typeof key !== "string" ||
        (key !== "length" && !/^(?:0|[1-9][0-9]*)$/.test(key))
      )
    ) {
      return invalidModel(context);
    }
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || !("value" in descriptor)) {
        return invalidModel(context);
      }
      result.push(descriptor.value);
    }
    return result;
  } catch {
    return invalidModel(context);
  }
}

function sortAndRejectDuplicateServers<T extends { readonly serverId: string }>(
  servers: T[],
): void {
  servers.sort((left, right) =>
    left.serverId < right.serverId ? -1 : left.serverId > right.serverId ? 1 : 0
  );
  for (let index = 1; index < servers.length; index += 1) {
    if (servers[index - 1].serverId === servers[index].serverId) {
      invalidModel("duplicate server identity");
    }
  }
}

function directoryText(
  input: unknown,
  maximumBytes: number,
  allowEmpty: boolean,
  gameProfile: boolean,
  context: string,
): string {
  const valid = gameProfile ? isGameDirectoryText : isDirectoryText;
  return valid(input, maximumBytes, allowEmpty) ? input : invalidModel(context);
}

function digest(input: unknown, context: string): string {
  if (typeof input !== "string" || !HEX_64.test(input)) {
    return invalidModel(context);
  }
  return input;
}

function integer(
  input: unknown,
  minimum: number,
  maximum: number,
  context: string,
): number {
  if (
    typeof input !== "number" ||
    !Number.isSafeInteger(input) ||
    input < minimum ||
    input > maximum
  ) {
    return invalidModel(context);
  }
  return input;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (current) => {
    switch (current) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (current) => {
    switch (current) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&apos;";
    }
  });
}

function bytesToHex(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) {
    result += byte.toString(16).padStart(2, "0");
  }
  return result;
}

function invalidModel(context: string): never {
  throw new TypeError(`Invalid directory artifact model: ${context}`);
}
