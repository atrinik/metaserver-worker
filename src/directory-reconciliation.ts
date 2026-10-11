import { WorkerEntrypoint } from "cloudflare:workers";

import type { CoreEnv } from "./core-env";
import { directoryArtifactConfiguration } from "./config";
import {
  CLASSIC_DIRECTORY_SCHEMA,
  GAME_DIRECTORY_SCHEMA,
} from "./directory-artifacts";
import { directoryAliasPrefix } from "./directory-builder";
import type { DirectoryBuildResult } from "./directory-builder";
import {
  DIRECTORY_PROFILES,
  readDirectoryArtifactPublication,
  readDirectoryRevision,
} from "./directory-state";
import type {
  DirectoryArtifactPublication,
  DirectoryProfile,
} from "./directory-state";
import {
  directoryOriginValidatorsMatchBytes,
  isDirectoryOriginPublicationTime,
  isDirectoryOriginStrongEtag,
} from "./directory-origin";

export const INTERNAL_DIRECTORY_RECONCILIATION_URL =
  "https://internal.atrinik.invalid/v1/directory-reconciliation";
const MANIFEST_SCHEMA = "atrinik-directory-manifest-v2";
const MAX_MANIFEST_BYTES = 4_096;

/** A deployment-only Service Binding capability; it has no public dispatcher. */
export class DirectoryReconciliation extends WorkerEntrypoint<CoreEnv> {
  async fetch(request: Request): Promise<Response> {
    return handleDirectoryReconciliationRequest(request, this.env);
  }
}

export async function handleDirectoryReconciliationRequest(
  request: Request,
  env: CoreEnv,
): Promise<Response> {
  // Reject the complete envelope before configuration, D1, R2 or DO access.
  if (!isExactRequest(request)) return failure(400);
  try {
    const control = directoryArtifactConfiguration(env);
    const configuration = {
      classicCutoverMode: control.classicDirectoryCutoverMode,
      gameCutoverMode: control.gameDirectoryCutoverMode,
      classicOrigin: exactOrigin(env.CLASSIC_DIRECTORY_PUBLIC_ORIGIN),
      gameOrigin: exactOrigin(env.GAME_DIRECTORY_PUBLIC_ORIGIN),
    };
    // Exactly one call per fixed profile. Retries/coalescing belong to the
    // builder; no request data can select an object, profile or destination.
    const results = await Promise.all(DIRECTORY_PROFILES.map((profile) =>
      env.DIRECTORY_BUILDER.getByName(profile).reconcile()
    ));
    const checkpoints = await Promise.all(DIRECTORY_PROFILES.map(
      async (profile, index) => {
        const checkpoint = await readDirectoryArtifactPublication(env.DB, profile);
        assertBuildResult(results[index]!, profile, checkpoint);
        await verifyAliases(
          profile === "classic-v3"
            ? env.CLASSIC_DIRECTORY_PUBLIC : env.GAME_DIRECTORY_PUBLIC,
          profile,
          checkpoint,
          directoryAliasPrefix(profile, configuration.classicCutoverMode,
            configuration.gameCutoverMode),
        );
        return checkpoint;
      },
    ));
    // Fence alias reads against a concurrent publisher or builder checkpoint.
    await Promise.all(DIRECTORY_PROFILES.map(async (profile, index) => {
      const [revision, checkpoint] = await Promise.all([
        readDirectoryRevision(env.DB, profile),
        readDirectoryArtifactPublication(env.DB, profile),
      ]);
      if (revision.revision !== checkpoint.publishedRevision ||
        JSON.stringify(checkpoint) !== JSON.stringify(checkpoints[index])) {
        throw new Error("Directory publication changed");
      }
    }));
    const completedAt = Math.floor(Date.now() / 1_000);
    const profiles = DIRECTORY_PROFILES.map((profile, index) => {
      const checkpoint = checkpoints[index]!;
      if (!isDirectoryOriginPublicationTime(completedAt * 1_000,
        checkpoint.generatedAt, checkpoint.expiresAt)) {
        throw new Error("Directory publication is stale");
      }
      return {
        profile,
        outcome: results[index]!.outcome,
        generation: checkpoint.generation,
        generatedAt: checkpoint.generatedAt,
        expiresAt: checkpoint.expiresAt,
      };
    });
    return Response.json({
      schema: "directory-reconciliation-v1", completedAt, configuration, profiles,
    }, { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  } catch {
    // Never export D1 revisions, digests, provider errors or listing data.
    return failure(503);
  }
}

function isExactRequest(request: Request): boolean {
  if (request.url !== INTERNAL_DIRECTORY_RECONCILIATION_URL ||
    request.method !== "POST" || request.body !== null) return false;
  for (const [name, value] of request.headers) {
    if ((name === "host" && value === "internal.atrinik.invalid") ||
      (name === "content-length" && value === "0")) continue;
    return false;
  }
  return true;
}

function exactOrigin(value: string | undefined): string {
  if (typeof value !== "string") throw new Error("Invalid directory origin");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value || url.username !== "" ||
    url.password !== "" || url.port !== "") throw new Error("Invalid directory origin");
  return value;
}

function assertBuildResult(
  result: DirectoryBuildResult,
  profile: DirectoryProfile,
  checkpoint: DirectoryArtifactPublication,
): void {
  if (result.profile !== profile ||
    (result.outcome !== "current" && result.outcome !== "published") ||
    checkpoint.generation < 1 || result.generation !== checkpoint.generation ||
    result.revision !== checkpoint.publishedRevision ||
    !isDirectoryOriginPublicationTime(Date.now(), checkpoint.generatedAt,
      checkpoint.expiresAt)) throw new Error("Directory build did not complete");
}

async function verifyAliases(
  bucket: R2Bucket,
  profile: DirectoryProfile,
  checkpoint: DirectoryArtifactPublication,
  prefix: string,
): Promise<void> {
  const descriptors = [
    ["html", "index.html", "text/html; charset=utf-8", checkpoint.htmlBytes, checkpoint.htmlSha256],
    ["xml", "index.xml", "application/xml; charset=utf-8", checkpoint.xmlBytes, checkpoint.xmlSha256],
    ["json", "index.json", "application/json; charset=utf-8", checkpoint.jsonBytes, checkpoint.jsonSha256],
    ["manifest", "manifest.json", "application/json; charset=utf-8", checkpoint.manifestBytes, checkpoint.manifestSha256],
  ] as const;
  const validators: Array<{ etag: string; bodySha256: string }> = [];
  for (const [format, name, contentType, size, digest] of descriptors) {
    const head = await bucket.head(prefix + name);
    const metadata = {
      schema: MANIFEST_SCHEMA, profile, format,
      generation: String(checkpoint.generation),
      "generated-at": String(checkpoint.generatedAt),
      "expires-at": String(checkpoint.expiresAt),
      "model-sha256": checkpoint.modelSha256, "body-sha256": digest,
    };
    if (head === null || head.size !== size || head.checksums.sha256 === undefined ||
      hex(head.checksums.sha256) !== digest ||
      !isDirectoryOriginStrongEtag(head.httpEtag) ||
      !isDirectoryOriginPublicationTime(head.uploaded.getTime(),
        checkpoint.generatedAt, checkpoint.expiresAt) ||
      !sameMetadata(head.customMetadata, metadata) ||
      head.httpMetadata?.contentType !== contentType ||
      head.httpMetadata.cacheControl !== "public, must-revalidate, stale-if-error=0, no-transform" ||
      head.httpMetadata.cacheExpiry?.getTime() !== checkpoint.expiresAt * 1_000 ||
      head.httpMetadata.contentEncoding !== undefined ||
      head.httpMetadata.contentLanguage !== undefined ||
      head.httpMetadata.contentDisposition !== undefined) {
      throw new Error("Directory alias verification failed");
    }
    if (format !== "manifest") validators.push({ etag: head.httpEtag, bodySha256: digest });
    else {
      if (size > MAX_MANIFEST_BYTES) throw new Error("Directory manifest exceeds bound");
      const body = await bucket.get(prefix + name, { onlyIf: { etagMatches: head.etag } });
      if (body === null || !("arrayBuffer" in body) || body.etag !== head.etag ||
        body.size !== size) throw new Error("Directory manifest changed");
      const bytes = await body.arrayBuffer();
      if (bytes.byteLength !== size ||
        hex(await crypto.subtle.digest("SHA-256", bytes)) !== digest) {
        throw new Error("Directory manifest integrity failed");
      }
      const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)) as Record<string, unknown>;
      if (manifest.schema !== MANIFEST_SCHEMA || manifest.profile !== profile ||
        manifest.directorySchema !== (profile === "classic-v3"
          ? CLASSIC_DIRECTORY_SCHEMA : GAME_DIRECTORY_SCHEMA) ||
        manifest.generation !== String(checkpoint.generation) ||
        manifest.generatedAt !== checkpoint.generatedAt ||
        manifest.expiresAt !== checkpoint.expiresAt) {
        throw new Error("Directory manifest schema mismatch");
      }
    }
  }
  if (!directoryOriginValidatorsMatchBytes(validators)) {
    throw new Error("Directory alias validators mismatch");
  }
}

function sameMetadata(actual: Record<string, string> | undefined,
  expected: Record<string, string>): boolean {
  return actual !== undefined && Object.keys(actual).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, value]) => actual[key] === value);
}

function hex(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function failure(status: number): Response {
  return new Response("Directory reconciliation unavailable", {
    status,
    headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff" },
  });
}
