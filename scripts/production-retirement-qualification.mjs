// Copyright (C) 2026 Atrinik contributors
// The checked controller document is the trust anchor: only a reviewed source
// change may attest actual canary evidence. Parsing a caller-supplied document is
// useful for fixtures, but runDelivery never accepts one from input/environment.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";

const schema = "atrinik-caller-retirement-provider-qualification-v2";
const documentUrl = new URL("../deployment/caller-retirement-provider-qualification.json", import.meta.url);
const proofs = new WeakMap();
const sha = /^[a-f0-9]{64}$/u;
const hash = value => createHash("sha256").update(value).digest("hex");
const fail = () => { throw new Error("caller retirement provider qualification missing or invalid"); };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const keys = (value, expected) => {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !same(Object.keys(value).sort(), [...expected].sort())) fail();
};
const contract = Object.freeze({ method: "PATCH", contentType: "application/merge-patch+json",
  endpoint: "https://api.cloudflare.com/client/v4/accounts/{account_id}/workers/scripts/{script_name}/secrets-bulk",
  bodyKeys: ["secrets"], secretNames: ["SOURCE_TAG_KEY_CURRENT", "SOURCE_TAG_KEY_PREVIOUS"],
  secretOperation: "null-delete", postAnnotations: { "workers/triggered_by": "secret" } });
const measurementNames = ["secretPairRemoved", "versionSecretPairRemoved", "settingsAnnotationsExact", "versionAnnotationsExact",
  "newVersion", "soleDeployment", "codeUnchanged", "nonsecretBindingsUnchanged", "controlUnchanged"];
const evidenceNames = ["probeControllerSha256", "requestSha256", "beforeSha256", "afterSha256", "resultSha256"];
function timestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail();
  return Date.parse(value);
}

export function parseCallerRetirementQualification(bytes, { accountId, now = Date.now } = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 16384 || bytes.length === 0 ||
      !/^[a-f0-9]{32}$/u.test(accountId ?? "")) fail();
  let document;
  try { document = JSON.parse(bytes.toString("utf8")); } catch { fail(); }
  // One canonical, reviewable source encoding also rejects duplicate JSON keys.
  if (bytes.toString("utf8") !== `${JSON.stringify(document, null, 2)}\n`) fail();
  keys(document, ["schema", "qualification"]);
  if (document.schema !== schema || document.qualification === null) fail();
  const q = document.qualification;
  keys(q, ["accountIdSha256", "contract", "measuredAt", "result", "evidence", "review"]);
  if (q.accountIdSha256 !== hash(accountId) || !same(q.contract, contract)) fail();
  keys(q.result, ["status", "scope", "measurement", "contractObserved", "productionAuthorized", "productionContractSatisfied"]);
  if (q.result.status !== "canary-measured-and-absent" || q.result.scope !== "isolated" ||
      q.result.contractObserved !== true || q.result.productionAuthorized !== false ||
      q.result.productionContractSatisfied !== false) fail();
  keys(q.result.measurement, measurementNames);
  if (measurementNames.some(name => q.result.measurement[name] !== true)) fail();
  keys(q.evidence, evidenceNames);
  if (evidenceNames.some(name => !sha.test(q.evidence[name] ?? ""))) fail();
  keys(q.review, ["reviewedAt", "recordSha256", "resultSha256"]);
  const measured = timestamp(q.measuredAt), reviewed = timestamp(q.review.reviewedAt), current = now();
  if (!Number.isFinite(current) || measured > reviewed || reviewed > current ||
      !sha.test(q.review.recordSha256 ?? "") || q.review.resultSha256 !== q.evidence.resultSha256) fail();
  return Object.freeze({ digest: hash(bytes), accountIdSha256: q.accountIdSha256 });
}

// Fixed controller-owned path. Neither selected release content, environment,
// a protected boolean nor caller input can replace this attestation.
export async function loadCallerRetirementQualification({ accountId, now = Date.now } = {}) {
  if (!/^[a-f0-9]{32}$/u.test(accountId ?? "")) fail();
  const expectedAccount = accountId;
  const file = await fs.open(documentUrl, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > 16384) fail();
    const bytes = Buffer.alloc(16385);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== stat.size) fail();
    const validated = parseCallerRetirementQualification(bytes.subarray(0, bytesRead), { accountId: expectedAccount, now });
    const proof = Object.freeze({ digest: validated.digest });
    proofs.set(proof, validated);
    return proof;
  } finally { await file.close(); }
}

export function requireCallerRetirementQualification(proof, accountId) {
  const value = proof && proofs.get(proof);
  if (!value || (accountId !== undefined &&
      (!/^[a-f0-9]{32}$/u.test(accountId) || value.accountIdSha256 !== hash(accountId)))) fail();
  return value.digest;
}
