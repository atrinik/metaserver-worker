// Copyright (C) 2026 Atrinik contributors
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDurableCallerRetirementRecorder, decryptRecoveryDocument,
  downloadRecoveryArtifact, encryptRecoveryDocument, verifyRecoveryArtifactProof,
  recoveryArtifactFailureReason } from "./production-recovery-artifacts.mjs";

// Disposable test keys only. Never read an owner private key or contact a provider.
const pair = generateKeyPairSync("rsa", { modulusLength: 3072 });
const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
const privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const recovery = { recipientSpkiSha256: hash(pair.publicKey.export({ type: "spki", format: "der" })), retentionDays: 90 };
const context = { repository: "atrinik/metaserver-worker", runId: "1001", runAttempt: "1",
  controllerSha: "a".repeat(40), sourceSha: "b".repeat(40), deployableDigest: "c".repeat(64) };
const role = "publisher", instant = Date.parse("2026-10-10T12:00:00Z");
const now = () => instant;
const environment = { GITHUB_TOKEN: "fixture-token" };
const document = { role, schema: "private-intent", before: { accountId: "private-account", modules: ["private-module"] } };
const decryptOptions = { privateKey, expectedContext: context, expectedRole: role, expectedKind: "intent", recovery };
async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "atrinik-recovery-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const archives = new Map(), calls = [];
  let metadataTransform = (v) => v, downloadTransform = (v) => v;
  const artifactClient = {
    async uploadArtifact(name, files, root, options) {
      calls.push("upload");
      assert.equal(files.length, 1);
      assert.equal(files[0], path.join(root, "recovery.jwe"));
      assert.deepEqual(await readdir(root), ["recovery.jwe"]);
      assert.deepEqual(options, { retentionDays: 90, compressionLevel: 0 });
      const ciphertext = await readFile(files[0], "utf8");
      assert.equal((await stat(files[0])).mode & 0o777, 0o600);
      assert.equal(ciphertext.includes("private-account"), false);
      const id = archives.size + 101, archiveDigest = hash(`fixture-zip:${ciphertext}`);
      archives.set(id, { ciphertext, archiveDigest, metadata: { id, name, digest: `sha256:${archiveDigest}`,
        expired: false, created_at: new Date(instant).toISOString(),
        expires_at: new Date(instant + 90 * 86400000).toISOString(),
        workflow_run: { id: Number(context.runId), head_sha: context.controllerSha } } });
      return { id, size: ciphertext.length + 128, digest: archiveDigest };
    },
    async downloadArtifact(id, options) {
      calls.push("download");
      assert.deepEqual(await readdir(options.path), []);
      assert.deepEqual(options.findBy, { token: environment.GITHUB_TOKEN, workflowRunId: Number(context.runId),
        repositoryOwner: "atrinik", repositoryName: "metaserver-worker" });
      const stored = archives.get(id);
      assert.equal(options.expectedHash, stored.archiveDigest);
      await writeFile(path.join(options.path, "recovery.jwe"), stored.ciphertext);
      return downloadTransform({ digestMismatch: false, downloadPath: options.path });
    }, ...overrides,
  };
  const fetcher = async (url, options) => {
    calls.push("metadata");
    assert.equal(options.method, "GET"); assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, `Bearer ${environment.GITHUB_TOKEN}`);
    const id = Number(url.split("/").at(-1));
    assert.equal(url, `https://api.github.com/repos/atrinik/metaserver-worker/actions/artifacts/${id}`);
    return new Response(JSON.stringify(metadataTransform(structuredClone(archives.get(id).metadata))));
  };
  return { directory, artifactClient, fetcher, archives, calls,
    mutateMetadata: (f) => { metadataTransform = f; }, mutateDownload: (f) => { downloadTransform = f; },
    options: { directory, role, context, recovery, publicKey, artifactClient, fetcher, environment, now } };
}

test("durable intent and receipt upload only ciphertext and require exact finalized archive readback", async (t) => {
  const f = await fixture(t), recorder = await createDurableCallerRetirementRecorder(f.options);
  const intent = await recorder.recordIntent(document);
  const receipt = await recorder.recordReceipt({ ...document, status: "complete" });
  assert.deepEqual(f.calls, ["upload", "metadata", "download", "upload", "metadata", "download"]);
  assert.equal(intent.artifactName, "production-recovery-1001-1-publisher-intent");
  assert.notEqual(intent.archiveDigest, intent.ciphertextSha256);
  assert.equal(receipt.artifactName, "production-recovery-1001-1-publisher-receipt");
  assert.equal((await stat(path.join(f.directory, "caller-retirement-publisher.intent.json"))).mode & 0o777, 0o600);
  const ciphertext = f.archives.get(intent.artifactId).ciphertext;
  assert.deepEqual(JSON.parse(Buffer.from(ciphertext.split(".")[0], "base64url")),
    { alg: "RSA-OAEP-256", enc: "A256GCM", typ: "atrinik-recovery+jwe" });
  assert.deepEqual(await decryptRecoveryDocument({ ...decryptOptions, ciphertext, artifactProof: intent }), document);
  await assert.rejects(recorder.recordIntent(document), /EEXIST/u);
});

test("owner recovers authenticated artifact after complete local attempt deletion", async (t) => {
  const f = await fixture(t), recorder = await createDurableCallerRetirementRecorder(f.options);
  const proof = await recorder.recordIntent(document);
  await rm(f.directory, { recursive: true });
  const directory = await mkdtemp(path.join(os.tmpdir(), "atrinik-owner-recovery-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const recovered = await downloadRecoveryArtifact({ ...f.options, directory, kind: "intent",
    artifactId: proof.artifactId, archiveDigest: proof.archiveDigest, minimumRetentionDays: 0 });
  assert.deepEqual(await decryptRecoveryDocument({ ...decryptOptions, ...recovered }), document);
});

test("recipient drift, weak RSA, private PEM and absent runtime capability fail before upload", async (t) => {
  const f = await fixture(t);
  for (const patch of [
    { recovery: { ...recovery, recipientSpkiSha256: "d".repeat(64) } },
    { recovery: { ...recovery, retentionDays: 89 } }, { publicKey: privateKey },
    { context: { ...context, runId: 1001 } }, { context: { ...context, extra: "private" } },
    { artifactClient: undefined }, { environment: {} },
  ]) await assert.rejects(createDurableCallerRetirementRecorder({ ...f.options, ...patch }));
  const weak = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey;
  await assert.rejects(createDurableCallerRetirementRecorder({ ...f.options,
    publicKey: weak.export({ type: "spki", format: "pem" }).toString(), recovery: { ...recovery,
      recipientSpkiSha256: hash(weak.export({ type: "spki", format: "der" })) } }), /3072/u);
  assert.deepEqual(f.calls, []);
});

test("failed upload finalization permanently consumes local intent and prevents receipt", async (t) => {
  for (const upload of [undefined, { id: 1 }, { id: 1, size: 20, digest: "invalid" }]) {
    const f = await fixture(t, { uploadArtifact: async () => upload });
    const recorder = await createDurableCallerRetirementRecorder(f.options);
    await assert.rejects(recorder.recordIntent(document), /finalization/u);
    await assert.rejects(recorder.recordReceipt({ ...document, status: "complete" }), /durable intent/u);
    await assert.rejects(recorder.recordIntent(document), /EEXIST/u);
  }
});

test("metadata rejects wrong name, ID, run, SHA, digest, expiry and shortened retention", async (t) => {
  const mutations = [
    (m) => ({ ...m, id: m.id + 1 }), (m) => ({ ...m, name: `${m.name}-other` }),
    (m) => ({ ...m, workflow_run: { ...m.workflow_run, id: 999 } }),
    (m) => ({ ...m, workflow_run: { ...m.workflow_run, head_sha: context.sourceSha } }),
    (m) => ({ ...m, digest: `sha256:${"d".repeat(64)}` }), (m) => ({ ...m, expired: true }),
    (m) => ({ ...m, expires_at: new Date(instant + 89 * 86400000).toISOString() }),
  ];
  for (const mutate of mutations) {
    const f = await fixture(t); f.mutateMetadata(mutate);
    const recorder = await createDurableCallerRetirementRecorder(f.options);
    await assert.rejects(recorder.recordIntent(document), /effective retention/u);
    assert.equal(f.calls.includes("download"), false);
  }
});

test("digest mismatch or missing SDK digest verification stops durable success", async (t) => {
  for (const digestMismatch of [true, undefined]) {
    const f = await fixture(t); f.mutateDownload((r) => ({ ...r, digestMismatch }));
    const recorder = await createDurableCallerRetirementRecorder(f.options);
    await assert.rejects(recorder.recordIntent(document), /archive verification/u);
  }
});

test("substituted ciphertext, extra artifact file and nonregular payload fail readback", async (t) => {
  for (const variation of ["substitute", "extra", "symlink"]) {
    const f = await fixture(t), download = f.artifactClient.downloadArtifact;
    f.artifactClient.downloadArtifact = async (id, options) => {
      const result = await download(id, options);
      if (variation === "substitute") await writeFile(path.join(options.path, "recovery.jwe"),
        await encryptRecoveryDocument({ ...f.options, kind: "intent", document: { role, alternate: true } }));
      if (variation === "extra") await writeFile(path.join(options.path, "raw.json"), "unsafe");
      if (variation === "symlink") {
        const { symlink } = await import("node:fs/promises");
        await rm(path.join(options.path, "recovery.jwe"));
        await symlink(path.join(f.directory, "caller-retirement-publisher.intent.json"), path.join(options.path, "recovery.jwe"));
      }
      return result;
    };
    await assert.rejects((await createDurableCallerRetirementRecorder(f.options)).recordIntent(document));
  }
});

test("decryption rejects unauthenticated proof, tamper, wrong key and wrong context", async (t) => {
  const f = await fixture(t), proof = await (await createDurableCallerRetirementRecorder(f.options)).recordIntent(document);
  const ciphertext = f.archives.get(proof.artifactId).ciphertext;
  const tampered = `${ciphertext.slice(0, -1)}${ciphertext.endsWith("A") ? "B" : "A"}`;
  assert.notEqual(tampered, ciphertext);
  for (const patch of [ { artifactProof: { ...proof } }, { ciphertext: tampered },
    { expectedContext: { ...context, sourceSha: "d".repeat(40) } }, { expectedKind: "receipt" },
    { recovery: { ...recovery, recipientSpkiSha256: "d".repeat(64) } } ])
    await assert.rejects(decryptRecoveryDocument({ ...decryptOptions, ciphertext, artifactProof: proof, ...patch }));
  const wrong = generateKeyPairSync("rsa", { modulusLength: 3072 }).privateKey;
  await assert.rejects(decryptRecoveryDocument({ ...decryptOptions, ciphertext, artifactProof: proof,
    privateKey: wrong.export({ format: "pem", type: "pkcs8" }).toString() }));
  // Authenticated GitHub provenance cannot override an encrypted context mismatch.
  const changed = await encryptRecoveryDocument({ ...f.options, kind: "intent", document,
    context: { ...context, sourceSha: "d".repeat(40) } });
  f.archives.get(proof.artifactId).ciphertext = changed;
  const downloaded = await downloadRecoveryArtifact({ ...f.options, kind: "intent", artifactId: proof.artifactId,
    archiveDigest: proof.archiveDigest });
  await assert.rejects(decryptRecoveryDocument({ ...decryptOptions, ...downloaded }), /coordinate mismatch/u);
});

test("receipt persistence failure prevents successful completion", async (t) => {
  const f = await fixture(t), recorder = await createDurableCallerRetirementRecorder(f.options);
  await recorder.recordIntent(document);
  f.mutateMetadata((m) => ({ ...m, expired: true }));
  await assert.rejects(recorder.recordReceipt({ ...document, status: "complete" }));
  await assert.rejects(recorder.recordReceipt({ ...document, status: "complete" }), /EEXIST/u);
});

test("retention rounding tolerance is bounded to one second", () => {
  const metadata = { id: 101, name: "name", expired: false, digest: `sha256:${"d".repeat(64)}`,
    workflow_run: { id: 1001, head_sha: context.controllerSha }, created_at: new Date(instant).toISOString(),
    expires_at: new Date(instant + 90 * 86400000 - 1000).toISOString() };
  const args = { metadata, artifactId: 101, artifactName: "name", archiveDigest: "d".repeat(64), context, now };
  assert.doesNotThrow(() => verifyRecoveryArtifactProof(args));
  metadata.expires_at = new Date(instant + 90 * 86400000 - 1001).toISOString();
  assert.throws(() => verifyRecoveryArtifactProof(args));
});

test("explicit effective retention opt-in requests 90 days and requires 89 full days", async (t) => {
  for (const duration of [90 * 86400000 - 281000, 89 * 86400000]) {
    const f = await fixture(t);
    const approved = { ...recovery, minimumEffectiveRetentionDays: 89 };
    f.mutateMetadata((m) => ({ ...m, expires_at: new Date(instant + duration).toISOString() }));
    const recorder = await createDurableCallerRetirementRecorder({ ...f.options, recovery: approved });
    const proof = await recorder.recordIntent(document);
    await recorder.recordReceipt({ ...document, status: "complete" });
    assert.deepEqual(f.calls, ["upload", "metadata", "download", "upload", "metadata", "download"]);
    const ciphertext = f.archives.get(proof.artifactId).ciphertext;
    assert.deepEqual(await decryptRecoveryDocument({ ...decryptOptions, recovery: approved,
      ciphertext, artifactProof: proof }), document);
    // Owner inspection of an existing artifact is distinct from writer qualification.
    const inspected = await downloadRecoveryArtifact({ ...f.options, kind: "intent", artifactId: proof.artifactId,
      archiveDigest: proof.archiveDigest, minimumRetentionDays: 0 });
    assert.deepEqual(await decryptRecoveryDocument({ ...decryptOptions, recovery: approved, ...inspected }), document);
  }
});

test("legacy 90-day policy still rejects the observed workflow-age shortfall", async (t) => {
  const f = await fixture(t);
  f.mutateMetadata((m) => ({ ...m, expires_at: new Date(instant + 90 * 86400000 - 281000).toISOString() }));
  const recorder = await createDurableCallerRetirementRecorder(f.options);
  await assert.rejects(recorder.recordIntent(document), /effective retention/u);
  assert.deepEqual(f.calls, ["upload", "metadata"]);
  await assert.rejects(recorder.recordReceipt(document), /durable intent/u);
  await assert.rejects(recorder.recordIntent(document), /EEXIST/u);
});

test("explicit 89-day policy rejects lower caps and any fractional-day shortfall before durable success", async (t) => {
  for (const duration of [89 * 86400000 - 1, 89 * 86400000 - 1000, 88 * 86400000, 0]) {
    const f = await fixture(t);
    f.mutateMetadata((m) => ({ ...m, expires_at: new Date(instant + duration).toISOString() }));
    const approved = { ...recovery, minimumEffectiveRetentionDays: 89 };
    const recorder = await createDurableCallerRetirementRecorder({ ...f.options, recovery: approved });
    approved.minimumEffectiveRetentionDays = 0; // Cannot alter captured writer authority.
    await assert.rejects(recorder.recordIntent(document), /effective retention/u);
    assert.deepEqual(f.calls, ["upload", "metadata"]);
    await assert.rejects(recorder.recordReceipt(document), /durable intent/u);
    await assert.rejects(recorder.recordIntent(document), /EEXIST/u);
  }
});

test("effective-retention opt-in does not weaken provenance, digest, expiry or recipient checks", async (t) => {
  for (const mutate of [
    (m) => ({ ...m, workflow_run: { ...m.workflow_run, id: 999 } }),
    (m) => ({ ...m, digest: `sha256:${"d".repeat(64)}` }),
    (m) => ({ ...m, expired: true }),
  ]) {
    const f = await fixture(t); f.mutateMetadata(mutate);
    const recorder = await createDurableCallerRetirementRecorder({ ...f.options,
      recovery: { ...recovery, minimumEffectiveRetentionDays: 89 } });
    await assert.rejects(recorder.recordIntent(document));
    assert.deepEqual(f.calls, ["upload", "metadata"]);
  }
  const f = await fixture(t);
  const approved = { ...recovery, minimumEffectiveRetentionDays: 89 };
  const proof = await (await createDurableCallerRetirementRecorder({ ...f.options, recovery: approved })).recordIntent(document);
  const ciphertext = f.archives.get(proof.artifactId).ciphertext;
  await assert.rejects(decryptRecoveryDocument({ ...decryptOptions, ciphertext, artifactProof: { ...proof }, recovery: approved }));
  await assert.rejects(decryptRecoveryDocument({ ...decryptOptions, ciphertext, artifactProof: proof,
    recovery: { ...approved, recipientSpkiSha256: "d".repeat(64) } }));
});

test("writer policy accepts only the explicit 89-day floor with the 90-day upload request", async (t) => {
  const f = await fixture(t);
  for (const minimum of [0, 88, 90, 89.5, "89", null, undefined])
    await assert.rejects(createDurableCallerRetirementRecorder({ ...f.options,
      recovery: { ...recovery, minimumEffectiveRetentionDays: minimum } }));
  for (const patch of [{ minimumRetentionDays: 0 }, { unknown: 89 },
    { minimumEffectiveRetentionDays: 89, retentionDays: 89 }, { minimumEffectiveRetentionDays: 89, retentionDays: 91 }])
    await assert.rejects(createDurableCallerRetirementRecorder({ ...f.options, recovery: { ...recovery, ...patch } }));
  assert.deepEqual(f.calls, []);
});

test("retention diagnostics recognize only branded failures through bounded own data causes", () => {
  const metadata = { id: 101, name: "name", expired: false, digest: `sha256:${"d".repeat(64)}`,
    workflow_run: { id: 1001, head_sha: context.controllerSha }, created_at: new Date(instant).toISOString(),
    expires_at: new Date(instant + 89 * 86400000).toISOString() };
  let branded;
  try { verifyRecoveryArtifactProof({ metadata, artifactId: 101, artifactName: "name",
    archiveDigest: "d".repeat(64), context, now }); } catch (error) { branded = error; }
  assert(branded);
  const expected = "recovery-artifact-effective-retention-rejected";
  assert.equal(recoveryArtifactFailureReason(branded), expected);
  let wrapped = branded;
  for (let i = 0; i < 3; i++) wrapped = new Error("SECRET private path", { cause: wrapped });
  assert.equal(recoveryArtifactFailureReason(wrapped), expected);
  assert.equal(recoveryArtifactFailureReason(new Error("SECRET", { cause: wrapped })), null);
  assert.equal(recoveryArtifactFailureReason(new Error(branded.message)), null);
  assert.equal(recoveryArtifactFailureReason({ ...branded }), null);
  assert.equal(recoveryArtifactFailureReason(Object.create({ cause: branded })), null);
  const getter = Object.defineProperty({}, "cause", { get() { throw new Error("must not execute"); } });
  assert.equal(recoveryArtifactFailureReason(getter), null);
  const cycle = {}; cycle.cause = cycle;
  assert.equal(recoveryArtifactFailureReason(cycle), null);
});
