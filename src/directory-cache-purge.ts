import type { DirectoryProfile } from "./directory-state";

const CLOUDFLARE_API_ORIGIN = "https://api.cloudflare.com";
const MAXIMUM_PURGE_RESPONSE_BYTES = 8_192;
const PURGE_TIMEOUT_MILLISECONDS = 10_000;
const ZONE_ID = /^[0-9a-f]{32}$/;
const PURGE_ID = /^[0-9a-f]{32}$/;
const TOKEN = /^[\x21-\x7e]{20,256}$/;
const PUBLIC_ALIAS_PATHS = Object.freeze([
  "/index.html",
  "/index.json",
  "/index.xml",
] as const);

export interface DirectoryCachePurgeEnvironment {
  readonly DIRECTORY_CACHE_PURGE_TOKEN?: string;
  readonly DIRECTORY_CACHE_ZONE_ID?: string;
  readonly CLASSIC_DIRECTORY_PUBLIC_ORIGIN?: string;
  readonly GAME_DIRECTORY_PUBLIC_ORIGIN?: string;
}

type PurgeFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Globally invalidate only the three public directory representations.
 *
 * `caches.default.delete()` is intentionally not used: it affects only the
 * invoking data center. The zone purge API is the sole global invalidation
 * capability and receives a dedicated least-privilege token.
 */
export async function purgeDirectoryAliases(
  environment: DirectoryCachePurgeEnvironment,
  profile: DirectoryProfile,
  fetcher: PurgeFetch = fetch,
): Promise<void> {
  const configuration = cachePurgeConfiguration(environment, profile);
  const files = PUBLIC_ALIAS_PATHS.map((path) =>
    `${configuration.publicOrigin}${path}`
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PURGE_TIMEOUT_MILLISECONDS);
  try {
    const response = await fetcher(
      `${CLOUDFLARE_API_ORIGIN}/client/v4/zones/${configuration.zoneId}/purge_cache`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${configuration.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ files }),
        signal: controller.signal,
      },
    );
    const envelope = await readPurgeEnvelope(response);
    if (!response.ok || !exactSuccessfulEnvelope(envelope)) {
      throw new Error("Directory cache purge was not accepted");
    }
  } finally {
    clearTimeout(timeout);
  }
}

function cachePurgeConfiguration(
  environment: DirectoryCachePurgeEnvironment,
  profile: DirectoryProfile,
): Readonly<{ token: string; zoneId: string; publicOrigin: string }> {
  const token = environment.DIRECTORY_CACHE_PURGE_TOKEN;
  const zoneId = environment.DIRECTORY_CACHE_ZONE_ID;
  const publicOrigin = profile === "classic-v1"
    ? environment.CLASSIC_DIRECTORY_PUBLIC_ORIGIN
    : environment.GAME_DIRECTORY_PUBLIC_ORIGIN;
  if (typeof token !== "string" || !TOKEN.test(token)) {
    throw new Error("Directory cache purge token is invalid");
  }
  if (typeof zoneId !== "string" || !ZONE_ID.test(zoneId)) {
    throw new Error("Directory cache purge zone is invalid");
  }
  if (typeof publicOrigin !== "string" || !isExactHttpsOrigin(publicOrigin)) {
    throw new Error("Directory cache purge origin is invalid");
  }
  return Object.freeze({ token, zoneId, publicOrigin });
}

function isExactHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" &&
      url.password === "" && url.port === "" && url.pathname === "/" &&
      url.search === "" && url.hash === "" && url.origin === value;
  } catch {
    return false;
  }
}

async function readPurgeEnvelope(response: Response): Promise<unknown> {
  const contentType = response.headers.get("Content-Type")?.split(";", 1)[0]
    .trim().toLowerCase();
  if (contentType !== "application/json" || response.body === null) {
    throw new Error("Directory cache purge response is invalid");
  }
  const declaredLength = response.headers.get("Content-Length");
  if (declaredLength !== null &&
    (!/^(0|[1-9][0-9]{0,4})$/.test(declaredLength) ||
      Number(declaredLength) > MAXIMUM_PURGE_RESPONSE_BYTES)) {
    throw new Error("Directory cache purge response is invalid");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) {
        break;
      }
      size += part.value.byteLength;
      if (size > MAXIMUM_PURGE_RESPONSE_BYTES) {
        throw new Error("Directory cache purge response is invalid");
      }
      chunks.push(part.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false,
    }).decode(bytes));
  } catch {
    throw new Error("Directory cache purge response is invalid");
  }
}

function exactSuccessfulEnvelope(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, ["errors", "messages", "result", "success"]) ||
    record.success !== true || !emptyArray(record.errors) ||
    !emptyArray(record.messages) || record.result === null ||
    typeof record.result !== "object" || Array.isArray(record.result)) {
    return false;
  }
  const result = record.result as Record<string, unknown>;
  return exactKeys(result, ["id"]) && typeof result.id === "string" &&
    PURGE_ID.test(result.id);
}

function exactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(record).sort();
  return keys.length === expected.length &&
    keys.every((key, index) => key === expected[index]);
}

function emptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0;
}
