// Copyright (C) 2026 Atrinik contributors
// Ciphertext is confidential, not sender-authenticated. Recovery always verifies
// GitHub provenance and the archive bytes before accepting decrypted documents.
import { createHash, createPublicKey } from "node:crypto";
import { lstat, mkdtemp, open, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createCallerRetirementRecorder } from "./production-caller-retirement.mjs";

const repository = "atrinik/metaserver-worker";
const header = Object.freeze({ alg: "RSA-OAEP-256", enc: "A256GCM", typ: "atrinik-recovery+jwe" });
const schema = "atrinik-production-recovery-v1";
const sha = /^[a-f0-9]{64}$/u;
const day = 86400000;
const proofs = new WeakSet();
const retentionFailures = new WeakSet();
const fail = (message) => { throw new Error(`production recovery artifact: ${message}`); };
function failRetention() {
  const error = new Error("production recovery artifact: effective retention mismatch");
  retentionFailures.add(error);
  throw error;
}
// Only this module can brand a verified retention failure. Inspect a bounded
// chain of own data properties without invoking getters or reflecting messages.
export function recoveryArtifactFailureReason(error) {
  for (let depth = 0; depth < 4 && error && typeof error === "object"; depth++) {
    if (retentionFailures.has(error)) return "recovery-artifact-effective-retention-rejected";
    error = Object.getOwnPropertyDescriptor(error, "cause")?.value;
  }
  return null;
}
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const sameContext = (a, b) => Object.keys(a).every((key) => a[key] === b[key]);
function validateContext(context) {
  if (!exactKeys(context, ["repository", "runId", "runAttempt", "controllerSha", "sourceSha", "deployableDigest"]) ||
      context.repository !== repository || typeof context.runId !== "string" || typeof context.runAttempt !== "string" ||
      !/^[1-9][0-9]*$/u.test(context.runId) ||
      !Number.isSafeInteger(Number(context.runId)) || !/^[1-9][0-9]*$/u.test(context.runAttempt) ||
      !Number.isSafeInteger(Number(context.runAttempt)) ||
      !/^[a-f0-9]{40}$/u.test(context.controllerSha) || !/^[a-f0-9]{40}$/u.test(context.sourceSha) ||
      !sha.test(context.deployableDigest)) fail("invalid exact execution context");
}
function validateRecovery(recovery) {
  const minimum = recovery?.minimumEffectiveRetentionDays;
  if (!exactKeys(recovery, minimum === undefined ? ["recipientSpkiSha256", "retentionDays"] :
    ["recipientSpkiSha256", "retentionDays", "minimumEffectiveRetentionDays"]) ||
      !sha.test(recovery.recipientSpkiSha256) || recovery.retentionDays !== 90 ||
      (minimum !== undefined && minimum !== 89))
    fail("invalid approved recipient or retention");
}
function artifactName(context, role, kind) {
  validateContext(context);
  if (!["publisher", "rendezvous"].includes(role) || !["intent", "receipt"].includes(kind))
    fail("invalid artifact coordinate");
  return `production-recovery-${context.runId}-${context.runAttempt}-${role}-${kind}`;
}
function recipient(publicKey, recovery) {
  validateRecovery(recovery);
  if (typeof publicKey !== "string" || publicKey.length > 16384 ||
      !/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END PUBLIC KEY-----\s*$/u.test(publicKey))
    fail("public SPKI PEM required");
  const key = createPublicKey(publicKey);
  if (key.asymmetricKeyType !== "rsa" || key.asymmetricKeyDetails?.modulusLength < 3072)
    fail("RSA recipient must have at least 3072 bits");
  if (digest(key.export({ format: "der", type: "spki" })) !== recovery.recipientSpkiSha256)
    fail("approved recipient drift");
  return key.export({ format: "pem", type: "spki" }).toString();
}
export async function encryptRecoveryDocument({ document, kind, role, context, recovery, publicKey }) {
  artifactName(context, role, kind);
  const pem = recipient(publicKey, recovery);
  if (!document || typeof document !== "object" || Array.isArray(document) || document.role !== role)
    fail("document role mismatch");
  const plaintext = Buffer.from(JSON.stringify({ schema, context, role, kind,
    recipientSpkiSha256: recovery.recipientSpkiSha256, document }));
  if (plaintext.length > 1024 * 1024) fail("recovery document exceeds bound");
  const { CompactEncrypt, importSPKI } = await import("jose");
  return new CompactEncrypt(plaintext).setProtectedHeader(header)
    .encrypt(await importSPKI(pem, header.alg));
}

async function privateDirectory(directory) {
  if (!path.isAbsolute(directory)) fail("absolute private directory required");
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077))
    fail("owned private directory required");
}
async function writeCiphertext(directory, ciphertext) {
  const filename = path.join(directory, "recovery.jwe");
  const handle = await open(filename, "wx", 0o600);
  try { await handle.writeFile(ciphertext); await handle.sync(); } finally { await handle.close(); }
  const parent = await open(directory, "r");
  try { await parent.sync(); } finally { await parent.close(); }
  return filename;
}
async function defaultClient() {
  const { DefaultArtifactClient } = await import("@actions/artifact");
  return new DefaultArtifactClient();
}
async function readMetadata({ artifactId, fetcher, environment }) {
  const token = environment.GITHUB_TOKEN;
  if (typeof token !== "string" || !token || /\s/u.test(token)) fail("artifact read token required");
  const response = await fetcher(`https://api.github.com/repos/${repository}/actions/artifacts/${artifactId}`, {
    method: "GET", headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28" }, redirect: "error", signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) fail("authenticated artifact metadata unavailable");
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 65536) fail("artifact metadata exceeds bound");
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks)); } catch { fail("invalid artifact metadata"); }
}

// Only call with a metadata response fetched using authenticated GitHub REST.
// This validator alone does not authenticate ciphertext; downloadRecoveryArtifact
// couples it to the SDK's exact-ID archive-integrity check and creates the proof.
export function verifyRecoveryArtifactProof({ metadata, artifactId, artifactName: name,
  archiveDigest, context, now = Date.now, minimumRetentionDays = 90 }) {
  validateContext(context);
  if (!Number.isSafeInteger(artifactId) || artifactId < 1 || !sha.test(archiveDigest) ||
      !Number.isFinite(minimumRetentionDays) || minimumRetentionDays < 0 || minimumRetentionDays > 90)
    fail("invalid artifact identity or retention requirement");
  const created = Date.parse(metadata?.created_at), expires = Date.parse(metadata?.expires_at);
  const current = now();
  if (metadata?.id !== artifactId || metadata.name !== name || metadata.expired !== false ||
      metadata.digest !== `sha256:${archiveDigest}` || metadata.workflow_run?.id !== Number(context.runId) ||
      metadata.workflow_run?.head_sha !== context.controllerSha ||
      !Number.isFinite(created) || !Number.isFinite(expires) || !Number.isFinite(current) ||
      created > current + 1000 || expires <= current)
    fail("artifact identity, digest, execution provenance or effective retention mismatch");
  // Preserve the historical 90-day timestamp rounding allowance. The explicit
  // 89-day policy requires the full interval, with no extra shortfall allowance.
  const rounding = minimumRetentionDays === 90 ? 1000 : 0;
  if (expires - created < minimumRetentionDays * day - rounding) failRetention();
  return { artifactId, artifactName: name, archiveDigest, expiresAt: metadata.expires_at };
}

/** Downloads an exact immutable archive into a fresh private directory. Recovery
 * may set minimumRetentionDays to 0 to read a still-live older artifact. Neither
 * names nor caller-supplied JSON proof objects substitute for authenticated REST.
 */
export async function downloadRecoveryArtifact({ artifactId, archiveDigest, context, role, kind,
  directory, artifactClient, fetcher = fetch, environment = process.env, now = Date.now,
  minimumRetentionDays = 90 }) {
  const name = artifactName(context, role, kind);
  context = Object.freeze({ ...context });
  environment = Object.freeze({ ...environment });
  if (!Number.isSafeInteger(artifactId) || artifactId < 1 || !sha.test(archiveDigest))
    fail("invalid finalized artifact identity");
  await privateDirectory(directory);
  const metadata = await readMetadata({ artifactId, fetcher, environment });
  const verified = verifyRecoveryArtifactProof({ metadata, artifactId, artifactName: name,
    archiveDigest, context, now, minimumRetentionDays });
  const downloadDirectory = await mkdtemp(path.join(directory, "recovery-download-"));
  const client = artifactClient ?? await defaultClient();
  const result = await client.downloadArtifact(artifactId, { path: downloadDirectory, expectedHash: `sha256:${archiveDigest}`,
    findBy: { token: environment.GITHUB_TOKEN, workflowRunId: Number(context.runId),
      repositoryOwner: "atrinik", repositoryName: "metaserver-worker" } });
  if (result?.digestMismatch !== false || result.downloadPath !== downloadDirectory)
    fail("artifact archive verification failed");
  await privateDirectory(downloadDirectory);
  const names = await readdir(downloadDirectory);
  if (names.length !== 1 || names[0] !== "recovery.jwe") fail("unexpected artifact contents");
  const filename = path.join(downloadDirectory, names[0]), stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.nlink !== 1 ||
      stat.size < 1 || stat.size > 2 * 1024 * 1024) fail("invalid recovery ciphertext file");
  const ciphertext = await readFile(filename, "utf8");
  if (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){4}$/u.test(ciphertext)) fail("invalid compact ciphertext");
  const artifactProof = Object.freeze({ ...verified, ciphertextSha256: digest(ciphertext),
    context: Object.freeze({ ...context }), role, kind });
  proofs.add(artifactProof);
  return { ciphertext, artifactProof };
}

/** Owner-only helper: privateKey is supplied by the owner outside Actions. JWE
 * authenticates encryption integrity, NOT the sender; the download proof is mandatory. */
export async function decryptRecoveryDocument({ ciphertext, privateKey, expectedContext,
  expectedRole, expectedKind, recovery, artifactProof }) {
  artifactName(expectedContext, expectedRole, expectedKind);
  validateRecovery(recovery);
  if (!proofs.has(artifactProof) || artifactProof.ciphertextSha256 !== digest(ciphertext) ||
      !sameContext(expectedContext, artifactProof.context) || artifactProof.role !== expectedRole ||
      artifactProof.kind !== expectedKind) fail("authenticated artifact provenance required");
  const { compactDecrypt, importPKCS8 } = await import("jose");
  const key = typeof privateKey === "string" ? await importPKCS8(privateKey, header.alg) : privateKey;
  const { plaintext, protectedHeader } = await compactDecrypt(ciphertext, key, {
    keyManagementAlgorithms: [header.alg], contentEncryptionAlgorithms: [header.enc],
  });
  if (!exactKeys(protectedHeader, Object.keys(header)) ||
      Object.keys(header).some((name) => protectedHeader[name] !== header[name])) fail("unexpected JWE header");
  let envelope;
  try { envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)); }
  catch { fail("invalid recovery plaintext"); }
  if (!exactKeys(envelope, ["schema", "context", "role", "kind", "recipientSpkiSha256", "document"]))
    fail("invalid recovery envelope");
  validateContext(envelope.context);
  if (envelope.schema !== schema || !sameContext(expectedContext, envelope.context) ||
      envelope.role !== expectedRole || envelope.kind !== expectedKind ||
      envelope.recipientSpkiSha256 !== recovery.recipientSpkiSha256 || envelope.document?.role !== expectedRole)
    fail("decrypted recovery coordinate mismatch");
  return envelope.document;
}

export async function createDurableCallerRetirementRecorder({ directory, role, context, recovery,
  publicKey, artifactClient, fetcher = fetch, environment = process.env, now = Date.now }) {
  artifactName(context, role, "intent");
  // Capture approved inputs before any awaits or caller mutation of shared objects.
  context = Object.freeze({ ...context }); recovery = Object.freeze({ ...recovery });
  environment = Object.freeze({ ...environment });
  publicKey = recipient(publicKey ?? environment.ATRINIK_PRODUCTION_RECOVERY_PUBLIC_KEY, recovery);
  if (!artifactClient && ["ACTIONS_RUNTIME_TOKEN", "ACTIONS_RESULTS_URL"].some((name) =>
    typeof environment[name] !== "string" || !environment[name] || /\s/u.test(environment[name])))
    fail("Actions artifact runtime capability required");
  if (typeof environment.GITHUB_TOKEN !== "string" || !environment.GITHUB_TOKEN || /\s/u.test(environment.GITHUB_TOKEN))
    fail("artifact read token required");
  await privateDirectory(directory);
  const local = createCallerRetirementRecorder({ directory, role });
  const client = artifactClient ?? await defaultClient();
  let durableIntent = false;
  async function record(kind, document) {
    document = structuredClone(document);
    if (kind === "receipt" && !durableIntent) fail("durable intent required before receipt");
    // Consume the raw private O_EXCL coordinate before attempting external writes.
    await local[kind === "intent" ? "recordIntent" : "recordReceipt"](document);
    const ciphertext = await encryptRecoveryDocument({ document, kind, role, context, recovery, publicKey });
    const uploadDirectory = await mkdtemp(path.join(directory, `recovery-${role}-${kind}-`));
    const filename = await writeCiphertext(uploadDirectory, ciphertext);
    const name = artifactName(context, role, kind);
    const upload = await client.uploadArtifact(name, [filename], uploadDirectory,
      { retentionDays: recovery.retentionDays, compressionLevel: 0 });
    if (!Number.isSafeInteger(upload?.id) || upload.id < 1 || !sha.test(upload.digest) ||
        !Number.isSafeInteger(upload.size) || upload.size < 1) fail("artifact finalization incomplete");
    const downloaded = await downloadRecoveryArtifact({ artifactId: upload.id, archiveDigest: upload.digest,
      context, role, kind, directory, artifactClient: client, fetcher, environment, now,
      minimumRetentionDays: recovery.minimumEffectiveRetentionDays ?? recovery.retentionDays });
    if (downloaded.ciphertext !== ciphertext) fail("artifact ciphertext differs from intent");
    if (kind === "intent") durableIntent = true;
    return downloaded.artifactProof;
  }
  return { recordIntent: (document) => record("intent", document), recordReceipt: (document) => record("receipt", document) };
}
