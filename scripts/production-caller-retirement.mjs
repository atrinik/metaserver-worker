// Copyright (C) 2026 Atrinik contributors
// Source-only machinery: no provider access occurs on import. The caller supplies
// selected-source/config/module verification and the complete authority/global fence.
import { markRetirementFailure, markRetirementPatchFailure, markCallerObservationFailure } from "./production-retirement-diagnostics.mjs";
import { requireCallerRetirementQualification } from "./production-retirement-qualification.mjs";
import { createHash } from "node:crypto";
import { lstat, open, readFile } from "node:fs/promises";
import path from "node:path";

export const callerRetirementSecrets = Object.freeze([
  "SOURCE_TAG_KEY_CURRENT", "SOURCE_TAG_KEY_PREVIOUS",
]);
const fail = (reason) => { throw new Error(`production caller retirement: ${reason}`); };
const sha = /^[a-f0-9]{64}$/u;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const canonical = (value) => Array.isArray(value) ? value.map(canonical) :
  value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort()
    .map((key) => [key, canonical(value[key])])) : value;
export const callerRetirementDigest = (value) => createHash("sha256")
  .update(JSON.stringify(canonical(value))).digest("hex");
const same = (a, b) => callerRetirementDigest(a) === callerRetirementDigest(b);
const workerName = (role) => {
  if (!["publisher", "rendezvous"].includes(role)) fail("invalid role");
  return `atrinik-metaserver-${role}`;
};
function bindings(rows) {
  if (!Array.isArray(rows) || new Set(rows.map((b) => b.name)).size !== rows.length)
    fail("binding inventory invalid");
  for (const binding of rows) {
    if (!binding || typeof binding.name !== "string" || !binding.name ||
        !["plain_text", "service", "ratelimit", "secret_text"].includes(binding.type))
      fail("caller gained state or unknown binding authority");
    if (binding.type === "secret_text" &&
        !same(Object.keys(binding).sort(), ["name", "type"])) fail("secret value or field exposed");
  }
  return rows;
}
function assertSnapshot(role, value, retired = false, stagedEmpty = false, annotationLoss = false) {
  if (!value || !Number.isFinite(value.capturedAt) || value.name !== workerName(role) || !/^[a-f0-9]{32}$/u.test(value.accountId ?? "") ||
      !uuid.test(value.activeVersion ?? "") || value.latestVersion !== value.activeVersion ||
      !uuid.test(value.deploymentId ?? "") || !value.peers || !value.code ||
      !Array.isArray(value.code.modules) || value.code.modules.length < 1 ||
      value.code.modules.some((m) => !sha.test(m.sha256 ?? "") || typeof m.name !== "string" || !m.name || !Number.isSafeInteger(m.bytes) || m.bytes < 1) ||
      new Set(value.code.modules.map((m) => m.name)).size !== value.code.modules.length ||
      value.code.etag !== value.resources?.script?.etag)
    fail("active identity or module proof incomplete");
  assertServiceMetadata(value);
  const rows = bindings(value.settings?.bindings);
  bindings(value.resources?.bindings);
  if (!same(rows, value.resources.bindings)) fail("settings/version binding mismatch");
  const secrets = rows.filter((b) => b.type === "secret_text").map((b) => b.name).sort();
  if (!same(secrets, retired || stagedEmpty ? [] : [...callerRetirementSecrets].sort())) fail("exact secret pair required");
  if (rows.some((b) => callerRetirementSecrets.some((name) => b.name === `${name}_ID`)))
    fail("legacy caller has key IDs; selected stateless caller must be staged first");
  const circuits = role === "publisher" ? ["PUBLISH_ENABLED", "GAME_PUBLISH_ENABLED"] : ["RENDEZVOUS_ENABLED"];
  if (!circuits.every((name) => rows.some((b) => b.name === name && b.type === "plain_text" && b.text === "disabled")))
    fail("caller circuits not disabled");
  const services = rows.filter((b) => b.type === "service");
  if (services.length !== 1 || services[0].name !== "COORDINATOR" ||
      services[0].service !== "atrinik-metaserver" ||
      services[0].entrypoint !== (role === "publisher" ? "PublisherCoordinator" : "RendezvousCoordinator") ||
      (services[0].environment !== undefined && services[0].environment !== "production"))
    fail("named production core authority mismatch");
  const annotations = value.settings.annotations;
  if (annotationLoss) {
    if (!exactKeys(annotations, ["workers/triggered_by"]) || annotations["workers/triggered_by"] !== "secret" ||
        !exactKeys(value.versionAnnotations, ["workers/triggered_by"]) || !same(annotations, value.versionAnnotations))
      fail("retired annotation object mismatch");
    return;
  }
  if (!/^[a-f0-9]{40}$/u.test(annotations?.["workers/tag"] ?? "") ||
      !new RegExp(`^atrinik-delivery-v1 source=${annotations["workers/tag"]} deploy=[a-f0-9]{64} migration=[a-f0-9]{64} horizon=[1-9][0-9]* control=[a-f0-9]{64} role=${role} phase=staged$`, "u")
        .test(annotations["workers/message"] ?? "")) fail("selected staged annotation missing");
  if (annotations["workers/triggered_by"] !== (retired ? "secret" : "version_upload"))
    fail("unsupported exact provider operation annotation");
}
// The service environment endpoint embeds script deployment metadata. It is not
// a second source of deployment authority: any nonempty deployment identifier
// must agree with the separately read deployment/version endpoint. The legacy
// endpoint also legitimately reports an empty deployment_id, which stays empty.
function metadataTime(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(value))
    fail("service metadata timestamp invalid");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 19) !== value.slice(0, 19))
    fail("service metadata timestamp invalid");
  return parsed;
}
function assertServiceMetadata(snapshot) {
  const environment = snapshot.control?.environment, script = environment?.script;
  if (!environment || !script || environment.environment !== "production" ||
      environment.script_tag !== snapshot.tag || script.tag !== snapshot.tag ||
      !/^[a-f0-9]{32}$/u.test(snapshot.tag ?? "") || script.id !== snapshot.name ||
      script.etag !== snapshot.code.etag || !same(script.handlers, snapshot.resources.script.handlers) ||
      typeof script.deployment_id !== "string" ||
      !["", snapshot.activeVersion, snapshot.deploymentId].includes(script.deployment_id) ||
      !["wrangler", "api"].includes(script.last_deployed_from) ||
      !Array.isArray(script.tags) || script.tags.some((tag) => typeof tag !== "string") ||
      typeof script.has_modules !== "boolean" || !script.has_modules ||
      typeof script.has_assets !== "boolean" || typeof script.logpush !== "boolean" ||
      (script.tail_consumers !== null && !Array.isArray(script.tail_consumers)) ||
      !script.observability || typeof script.observability !== "object" ||
      typeof script.compatibility_date !== "string" || !Array.isArray(script.compatibility_flags) ||
      script.compatibility_flags.some((flag) => typeof flag !== "string") || typeof script.usage_model !== "string")
    fail("service metadata identity or schema invalid");
  for (const value of [environment, script]) {
    const created = metadataTime(value.created_on), modified = metadataTime(value.modified_on);
    if (created > modified || modified > snapshot.capturedAt) fail("service metadata chronology invalid");
  }
}
function expectedServiceMetadata(before, after) {
  assertServiceMetadata(before);
  assertServiceMetadata(after);
  const expected = structuredClone(before.control.environment);
  for (const [old, current, target] of [[before.control.environment, after.control.environment, expected],
    [before.control.environment.script, after.control.environment.script, expected.script]]) {
    if (old.modified_on !== current.modified_on) {
      const previous = metadataTime(old.modified_on), next = metadataTime(current.modified_on);
      if (next < previous || next < before.capturedAt || next > after.capturedAt)
        fail("service modification outside observed transition window");
      target.modified_on = current.modified_on;
    }
  }
  const previous = before.control.environment.script, current = after.control.environment.script;
  expected.script.deployment_id = previous.deployment_id === "" ? "" :
    previous.deployment_id === before.activeVersion ? after.activeVersion : after.deploymentId;
  // The documented field denotes the deployment client. The pinned Wrangler
  // implementation recognizes `api` as an update through the script API. Only
  // this exact transport-induced provenance transition is accepted, never dash,
  // workersci, arbitrary strings, or a return to wrangler after an API update.
  if (previous.last_deployed_from === "wrangler" && current.last_deployed_from === "api")
    expected.script.last_deployed_from = "api";
  return expected;
}
// Active-version script metadata may reflect the same exact deployment client
// transition as the service environment. No other resource metadata is mutable.
function expectedResourceScript(before, after) {
  const expected = structuredClone(before.resources.script);
  if (expected.last_deployed_from === "wrangler" && after.resources.script.last_deployed_from === "api" &&
      before.control.environment.script.last_deployed_from === "wrangler" &&
      after.control.environment.script.last_deployed_from === "api")
    expected.last_deployed_from = "api";
  return expected;
}
function withoutTime(value) {
  const copy = structuredClone(value);
  delete copy.capturedAt;
  return copy;
}
function fresh(value, now) {
  if (!Number.isFinite(value?.capturedAt) || now() < value.capturedAt || now() - value.capturedAt > 10000)
    fail("observation expired");
}
// Historical v1 settings requests are observation-only. Keep this digest input
// unchanged; it never authorizes or describes the new bulk-secret operation.
function historicalCallerRetirementSettings(role, snapshot) {
  assertSnapshot(role, snapshot);
  const annotations = structuredClone(snapshot.settings.annotations);
  delete annotations["workers/triggered_by"];
  return { bindings: snapshot.settings.bindings.filter((b) => !callerRetirementSecrets.includes(b.name)), annotations };
}
export function callerRetirementBody(role, snapshot) {
  assertSnapshot(role, snapshot);
  return { secrets: { SOURCE_TAG_KEY_CURRENT: null, SOURCE_TAG_KEY_PREVIOUS: null } };
}
const mergePatchType = "application/merge-patch+json";
const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
  Reflect.ownKeys(value).every((key) => typeof key === "string" &&
    Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value")) &&
  same(Reflect.ownKeys(value).sort(), [...keys].sort()) && Object.keys(value).length === keys.length;
function retirementRequest(role, accountId) {
  const name = workerName(role);
  const body = { secrets: { SOURCE_TAG_KEY_CURRENT: null, SOURCE_TAG_KEY_PREVIOUS: null } };
  const request = { role, accountId, name, method: "PATCH",
    endpoint: `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${name}/secrets-bulk`,
    contentType: mergePatchType, body, bodyDigest: callerRetirementDigest(body) };
  return { ...request, requestDigest: callerRetirementDigest(request) };
}
function assertRetirementRequest(role, accountId, request) {
  const expected = retirementRequest(role, accountId);
  // Inspect keys as well as digests: JSON hashing alone would omit undefined
  // injections. There is no annotation or version_tags mapping in this contract.
  if (!exactKeys(request, Object.keys(expected)) ||
      !exactKeys(request.body, ["secrets"]) || !exactKeys(request.body.secrets, [...callerRetirementSecrets]) ||
      callerRetirementSecrets.some((name) => request.body.secrets[name] !== null) || !same(request, expected))
    fail("mutation request authority drift");
  return expected;
}
function assertV2Intent(role, before, intent) {
  const request = retirementRequest(role, before.accountId);
  const expected = { schema: "atrinik-production-caller-retirement-v2", ...request,
    before: structuredClone(before), beforeDigest: callerRetirementDigest(before) };
  if (!Number.isFinite(before.capturedAt) || !exactKeys(intent, Object.keys(expected)) || !same(intent, expected))
    fail("recovery intent does not bind timestamped predecessor and exact request");
  assertRetirementRequest(role, before.accountId, Object.fromEntries(Object.keys(request).map((key) => [key, intent[key]])));
}
// v2 request reconstruction above is immutable historical evidence. New writes
// use v3, binding the selected stage annotations explicitly in version_tags.
function approvedVersionTags(role, tags) {
  if (!exactKeys(tags, ["workers/tag", "workers/message"]) ||
      typeof tags["workers/tag"] !== "string" || !/^[a-f0-9]{40}$/u.test(tags["workers/tag"]) ||
      typeof tags["workers/message"] !== "string" || tags["workers/message"].length > 1024 ||
      !new RegExp(`^atrinik-delivery-v1 source=${tags["workers/tag"]} deploy=[a-f0-9]{64} migration=[a-f0-9]{64} horizon=[1-9][0-9]* control=[a-f0-9]{64} role=${role} phase=staged$`, "u")
        .test(tags["workers/message"])) fail("approved version tags invalid");
  return { "workers/tag": tags["workers/tag"], "workers/message": tags["workers/message"] };
}
export function callerRetirementBodyV3(role, snapshot) {
  assertSnapshot(role, snapshot);
  const tags = snapshot.settings.annotations;
  return { ...callerRetirementBody(role, snapshot), version_tags: approvedVersionTags(role, {
    "workers/tag": tags["workers/tag"], "workers/message": tags["workers/message"],
  }) };
}
function retirementRequestV3(role, accountId, tags) {
  const { requestDigest: _requestDigest, ...request } = retirementRequest(role, accountId);
  request.body = { secrets: { SOURCE_TAG_KEY_CURRENT: null, SOURCE_TAG_KEY_PREVIOUS: null },
    version_tags: approvedVersionTags(role, tags) };
  request.bodyDigest = callerRetirementDigest(request.body);
  return { ...request, requestDigest: callerRetirementDigest(request) };
}
function assertRetirementRequestV3(role, accountId, request) {
  if (!exactKeys(request, Object.keys(retirementRequest(role, accountId))) ||
      !exactKeys(request.body, ["secrets", "version_tags"]) ||
      !exactKeys(request.body.secrets, [...callerRetirementSecrets]) ||
      callerRetirementSecrets.some(name => request.body.secrets[name] !== null))
    fail("mutation request authority drift");
  const expected = retirementRequestV3(role, accountId, request.body.version_tags);
  if (!same(request, expected)) fail("mutation request authority drift");
  return expected;
}
function assertV3Intent(role, before, intent, expectedQualificationDigest =
  Object.getOwnPropertyDescriptor(intent ?? {}, "providerQualificationDigest")?.value) {
  if (!sha.test(expectedQualificationDigest ?? "")) fail("recovery provider qualification digest invalid");
  const request = retirementRequestV3(role, before.accountId, callerRetirementBodyV3(role, before).version_tags);
  const expected = { schema: "atrinik-production-caller-retirement-v3", ...request,
    providerQualificationDigest: expectedQualificationDigest, before: structuredClone(before), beforeDigest: callerRetirementDigest(before) };
  if (!Number.isFinite(before.capturedAt) || !exactKeys(intent, Object.keys(expected)) || !same(intent, expected))
    fail("recovery intent does not bind timestamped predecessor and exact request");
  assertRetirementRequestV3(role, before.accountId, Object.fromEntries(Object.keys(request).map(key => [key, intent[key]])));
}

const retiredProofs = new WeakMap();
function retirementRequestV4(role, accountId) {
  const { requestDigest: _digest, ...request } = retirementRequest(role, accountId);
  const operation = { ...request, contract: "atrinik-production-caller-retirement-v4" };
  return { ...operation, requestDigest: callerRetirementDigest(operation) };
}
function assertRetirementRequestV4(role, accountId, request) {
  const expected = retirementRequestV4(role, accountId);
  if (!exactKeys(request, Object.keys(expected)) || !same(request, expected)) fail("mutation request authority drift");
  const { contract: _contract, requestDigest: _digest, ...legacy } = request;
  assertRetirementRequest(role, accountId, { ...legacy, requestDigest: callerRetirementDigest(legacy) });
  return expected;
}
function assertSelectedIdentity(role, before, selected) {
  if (!same(before.settings.annotations, before.versionAnnotations)) fail("predecessor version annotations missing or different");
  if (!exactKeys(selected, ["sourceSha", "deployableDigest", "configurationDigest", "bundleDigest", "uploadedVersion",
    "controllerSha", "runId", "runAttempt"]) ||
    !/^[a-f0-9]{40}$/u.test(selected.controllerSha ?? "") ||
    !/^[1-9][0-9]*$/u.test(selected.runId ?? "") || !/^[1-9][0-9]*$/u.test(selected.runAttempt ?? "") ||
    ![selected.deployableDigest, selected.configurationDigest, selected.bundleDigest].every(v => sha.test(v ?? "")) ||
    selected.sourceSha !== before.settings.annotations["workers/tag"] || selected.uploadedVersion !== before.activeVersion ||
    before.code.modules.length !== 1 || before.code.modules[0].sha256 !== selected.bundleDigest ||
    !before.settings.annotations["workers/message"].includes(` deploy=${selected.deployableDigest} `))
    fail("selected retirement identity invalid");
}
function assertV4Intent(role, before, intent, qualificationDigest = intent?.providerQualificationDigest) {
  assertSnapshot(role, before);
  assertSelectedIdentity(role, before, intent?.selectedIdentity);
  if (!sha.test(qualificationDigest ?? "")) fail("recovery provider qualification digest invalid");
  const request = retirementRequestV4(role, before.accountId);
  const expected = { schema: "atrinik-production-caller-retirement-v4", ...request,
    providerQualificationDigest: qualificationDigest, selectedIdentity: intent.selectedIdentity,
    before: structuredClone(before), beforeDigest: callerRetirementDigest(before) };
  if (!exactKeys(intent, Object.keys(expected)) || !same(intent, expected)) fail("recovery intent does not bind predecessor and exact request");
  assertRetirementRequestV4(role, before.accountId, Object.fromEntries(Object.keys(request).map(key => [key, intent[key]])));
}
// This validator is pure evidence inspection. It cannot mint a runtime capability.
export function verifyCallerRetirementReceiptV4(receipt, expectedQualificationDigest) {
  if (!receipt || !sha.test(expectedQualificationDigest ?? "")) fail("receipt qualification binding missing");
  const { status, after, afterDigest, capturedAt, ...intent } = receipt;
  assertV4Intent(intent.role, intent.before, intent, expectedQualificationDigest);
  verifyCallerRetirementPostV4(intent.role, intent.before, after);
  if (status !== "observed-disabled-caller-secrets-retired" || capturedAt !== after.capturedAt ||
      afterDigest !== callerRetirementDigest(withoutTime(after))) fail("retirement receipt mismatch");
  return true;
}
function ownSnapshot(snapshot) {
  const result = withoutTime(snapshot);
  delete result.peers;
  return result;
}
// Only a fulfilled durable receipt in this process creates the key in this map.
// A serialized receipt, a recovered historical observation, or a new run cannot.
export function requireRetiredCallerProof({ proof, role, scope, selectedIdentity, snapshot, now = Date.now }) {
  const value = proof && retiredProofs.get(proof);
  if (!value || value.role !== role || value.scope !== scope || !same(value.selectedIdentity, selectedIdentity))
    fail("retired caller capability invalid");
  if (snapshot) {
    fresh(snapshot, now);
    assertSnapshot(role, snapshot, true, false, true);
    if (!same(ownSnapshot(snapshot), value.ownSnapshot)) fail("retired caller snapshot changed");
  }
  return Object.freeze({ versionId: value.versionId, message: value.message, sourceSha: value.selectedIdentity.sourceSha });
}

// A distinct read-only operation for an explicitly approved empty baseline after
// fresh Wrangler staging. No intent, receipt or retirement transport is accepted.
export async function observeSecretFreeCaller({ role, read, fence, verifyStaged, now = Date.now }) {
  try {
  workerName(role);
  if ([read, fence, verifyStaged].some(f => typeof f !== "function")) fail("required observation proof missing");
  await fence();
  const snapshot = await read();
  fresh(snapshot, now);
  assertSnapshot(role, snapshot, false, true);
  if (await verifyStaged(snapshot, { retired: true }) !== true) fail("secret-free staged proof rejected");
  await fence();
  return { snapshot, observation: Object.freeze({ status: "observed-new-disabled-secret-free-caller",
    role, versionId: snapshot.activeVersion, snapshotDigest: callerRetirementDigest(snapshot),
    capturedAt: snapshot.capturedAt, retirementArtifacts: 0, mutationState: "not-invoked" }) };
  } catch (error) { throw markCallerObservationFailure(error, "staged-observation"); }
}

export function verifyCallerRetirementPost(role, before, after) {
  return verifyRetirementPost(role, before, after, false);
}
export function verifyCallerRetirementPostV4(role, before, after) {
  return verifyRetirementPost(role, before, after, true);
}
function verifyRetirementPost(role, before, after, annotationLoss) {
  assertSnapshot(role, before);
  assertSnapshot(role, after, true, false, annotationLoss);
  if (after.capturedAt < before.capturedAt) fail("postwrite observation predates predecessor");
  if (after.activeVersion === before.activeVersion || after.deploymentId === before.deploymentId)
    fail("no new active version observed");
  const expected = withoutTime(before);
  for (const key of ["activeVersion", "latestVersion", "deploymentId"]) expected[key] = after[key];
  for (const field of ["settings", "resources"])
    expected[field].bindings = expected[field].bindings.filter((b) => !callerRetirementSecrets.includes(b.name));
  if (annotationLoss) {
    expected.settings.annotations = { "workers/triggered_by": "secret" };
    expected.versionAnnotations = { "workers/triggered_by": "secret" };
  }
  else expected.settings.annotations["workers/triggered_by"] = "secret";
  expected.control.environment = expectedServiceMetadata(before, after);
  expected.resources.script = expectedResourceScript(before, after);
  if (!same(expected, withoutTime(after))) fail("postwrite preservation mismatch");
  return after;
}

/** read(): normalized snapshot containing complete settings/resources, pinned code
 * {etag,modules:[{name,type,sha256,bytes}]}, latest/active/deployment IDs, and
 * all peer/global invariants. authorize() is the final authority-only fence.
 * verifyStaged(snapshot,{retired}) MUST prove exact selected-source module bytes,
 * exact disabled config and annotation, account and prior staged deployment receipt.
 * fence() MUST refresh both execution authority and the complete cohort/Builds fence.
 * recordIntent MUST consume a durable O_EXCL role coordinate; recordReceipt likewise.
 * Failure after intent is permanent: no retry or rollback is provided here.
 */
export async function retireCallerSecrets({ role, read, fence, verifyStaged, patch,
  recordIntent, recordReceipt, authorize, qualification, selectedIdentity, scope, now = Date.now }) {
  workerName(role);
  if ([read, fence, verifyStaged, patch, recordIntent, recordReceipt, authorize].some((f) => typeof f !== "function"))
    fail("required authority or durable recorder missing");
  let phase = "initial-fence", mutationState = "not-invoked";
  try {
    const providerQualificationDigest = requireCallerRetirementQualification(qualification);
    await fence();
    phase = "initial-read";
    const before = await read();
    phase = "initial-compare";
    fresh(before, now);
    assertSnapshot(role, before);
    requireCallerRetirementQualification(qualification, before.accountId);
    phase = "initial-staged-proof";
    if (await verifyStaged(before, { retired: false }) !== true) fail("selected staged proof rejected");
    assertSelectedIdentity(role, before, selectedIdentity);
    if (!scope || typeof scope !== "object") fail("retirement run scope missing");
    const request = retirementRequestV4(role, before.accountId);
    const intent = { schema: "atrinik-production-caller-retirement-v4", ...request,
      providerQualificationDigest, selectedIdentity: structuredClone(selectedIdentity), before: structuredClone(before), beforeDigest: callerRetirementDigest(before) };
    phase = "intent-proof";
    await recordIntent(structuredClone(intent));
    // Intent is consumed first. Re-read module, latest, bindings and peers, then do
    // the final authority/global fence. Neither check is permission to retry.
    phase = "post-intent-fence";
    await fence();
    phase = "current-read";
    const current = await read();
    phase = "current-compare";
    fresh(current, now);
    assertSnapshot(role, current);
    if (!same(withoutTime(before), withoutTime(current))) fail("predecessor changed after intent");
    phase = "staged-proof";
    if (await verifyStaged(current, { retired: false }) !== true) fail("staged proof changed after intent");
    phase = "final-authority";
    await authorize();
    phase = "freshness";
    fresh(current, now);
    phase = "patch";
    assertV4Intent(role, before, intent, requireCallerRetirementQualification(qualification, before.accountId));
    mutationState = "dispatched-outcome-unknown";
    await patch(structuredClone(request));
    mutationState = "response-accepted";
    phase = "post-read";
    const after = await read();
    phase = "postverify";
    fresh(after, now);
    verifyCallerRetirementPostV4(role, before, after);
    if (await verifyStaged(after, { retired: true, predecessor: structuredClone(before) }) !== true) fail("retired staged proof rejected");
    phase = "post-fence";
    await fence();
    const receipt = { ...intent, status: "observed-disabled-caller-secrets-retired",
      after: structuredClone(after), afterDigest: callerRetirementDigest(withoutTime(after)), capturedAt: after.capturedAt };
    phase = "receipt-proof";
    verifyCallerRetirementReceiptV4(receipt, providerQualificationDigest);
    await recordReceipt(structuredClone(receipt));
    const proof = Object.freeze({ role, versionId: after.activeVersion });
    retiredProofs.set(proof, { role, scope, selectedIdentity: structuredClone(selectedIdentity),
      versionId: after.activeVersion, ownSnapshot: ownSnapshot(after),
      message: before.settings.annotations["workers/message"], receiptDigest: callerRetirementDigest(receipt) });
    return { snapshot: after, receipt, proof };
  } catch (error) { throw markRetirementFailure(error, phase, mutationState); }
}

// An ambiguous prior dispatch may only be OBSERVED, never replayed. A successful
// recovery terminal is a new document and is not a fabricated original receipt.
export async function observeCallerRetirement({ role, before, intent, read, fence, verifyStaged, now = Date.now }) {
  assertSnapshot(role, before);
  if (intent?.schema === "atrinik-production-caller-retirement-v4") assertV4Intent(role, before, intent);
  else if (intent?.schema === "atrinik-production-caller-retirement-v3") assertV3Intent(role, before, intent);
  else if (intent?.schema === "atrinik-production-caller-retirement-v2") assertV2Intent(role, before, intent);
  else {
    if (intent?.schema !== "atrinik-production-caller-retirement-v1" || intent.role !== role ||
        intent.accountId !== before.accountId || intent.name !== workerName(role) ||
        intent.method !== "PATCH" || intent.path !== `/workers/scripts/${workerName(role)}/settings` ||
        !same(intent.before, withoutTime(before)) || intent.beforeDigest !== callerRetirementDigest(withoutTime(before)) ||
        intent.settingsDigest !== callerRetirementDigest(historicalCallerRetirementSettings(role, before)))
      fail("recovery intent does not bind predecessor");
    // Digest validation preserves the historical observation contract; it cannot
    // authenticate any capture time supplied outside the consumed v1 document.
    fail("historical intent lacks authenticated observation timestamp");
  }
  await fence();
  const after = await read();
  fresh(after, now);
  if (intent.schema === "atrinik-production-caller-retirement-v4") verifyCallerRetirementPostV4(role, before, after);
  else verifyCallerRetirementPost(role, before, after);
  if (await verifyStaged(after, { retired: true }) !== true) fail("recovery staged proof rejected");
  await fence();
  return { status: "observed-retirement-recovery-only", originalReceiptCreated: false,
    intentDigest: callerRetirementDigest(intent), snapshot: after };
}

export function createCallerRetirementPatch({ accountId, token, role, qualification, fetcher = fetch }) {
  workerName(role);
  requireCallerRetirementQualification(qualification, accountId);
  if (!/^[a-f0-9]{32}$/u.test(accountId ?? "") || typeof token !== "string" || !token || /\s/u.test(token))
    fail("mutation transport authority invalid");
  let consumed = false;
  return async (request) => {
    let transportState = "not-dispatched";
    try {
      if (consumed) fail("mutation transport already consumed");
      requireCallerRetirementQualification(qualification, accountId);
      const validated = assertRetirementRequestV4(role, accountId, request);
      // Serialize reconstructed primitives, never caller object hooks.
      const data = JSON.stringify(validated.body);
      if (Buffer.byteLength(data) > 65536) fail("bulk-secret request exceeds bound");
      consumed = true;
      // Exactly one request, bounded response, no redirect or automatic retry.
      transportState = "dispatched-outcome-unknown";
      const response = await fetcher(validated.endpoint, {
        method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": mergePatchType }, body: data,
        redirect: "error", signal: AbortSignal.timeout(20000),
      });
      transportState = "response-received";
      let length = 0;
      const chunks = [];
      for await (const chunk of response.body) {
        length += chunk.length;
        if (length > 1024 * 1024) fail("provider response exceeds bound; completion unknown");
        chunks.push(Buffer.from(chunk));
      }
      let envelope;
      try { envelope = JSON.parse(Buffer.concat(chunks)); } catch { fail("provider response invalid; completion unknown"); }
      if (!response.ok || envelope.success !== true || envelope.errors?.length)
        fail("provider rejected request; preserve intent and do not retry");
    } catch (error) { throw markRetirementPatchFailure(error, transportState); }
  };
}

async function durableDocument(filename, document) {
  const directory = path.dirname(filename), stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid())
    fail("private attempt directory required");
  const bytes = `${JSON.stringify(document)}\n`;
  if (Buffer.byteLength(bytes) > 1024 * 1024) fail("private document exceeds bound");
  const file = await open(filename, "wx", 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
export function createCallerRetirementRecorder({ directory, role }) {
  workerName(role);
  if (!path.isAbsolute(directory)) fail("absolute private attempt directory required");
  const intentPath = path.join(directory, `caller-retirement-${role}.intent.json`);
  return {
    recordIntent: (intent) => durableDocument(intentPath, intent),
    recordReceipt: async (receipt) => {
      const stat = await lstat(intentPath);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid())
        fail("private consumed intent missing");
      const intent = JSON.parse(await readFile(intentPath, "utf8"));
      if (Object.entries(intent).some(([key, value]) => !same(receipt[key], value))) fail("receipt intent mismatch");
      return durableDocument(path.join(directory, `caller-retirement-${role}.receipt.json`), receipt);
    },
  };
}

const cohortNames = ["atrinik-metaserver", "atrinik-metaserver-publisher", "atrinik-metaserver-rendezvous",
  "atrinik-metaserver-development", "atrinik-metaserver-development-publisher", "atrinik-metaserver-development-rendezvous"];
async function responseBytes(response, maximum = 8 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maximum) fail("read response exceeds bound");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
function uniqueRows(rows, key) {
  if (!Array.isArray(rows) || rows.some((r) => typeof r?.[key] !== "string" || !r[key]) ||
      new Set(rows.map((r) => r[key])).size !== rows.length) fail("inventory duplicates or shape");
  return [...rows].sort((a, b) => a[key].localeCompare(b[key]));
}
function completeRows(envelope, key = "id") {
  const rows = uniqueRows(envelope.result, key), i = envelope.result_info;
  if (rows.length > 10000 || (i && ((i.count !== undefined && i.count !== rows.length) ||
      (i.total_count !== undefined && i.total_count !== rows.length) ||
      (i.total_pages !== undefined && i.total_pages > 1) || (i.page !== undefined && i.page !== 1) ||
      i.has_more || i.next_page || i.cursor || i.next_cursor))) fail("inventory completeness unproven");
  return rows;
}
function safeBindings(rows) {
  return uniqueRows(rows, "name").map((binding) => {
    if (binding.type.startsWith("secret") && !same(Object.keys(binding).sort(), ["name", "type"]))
      fail("unexpected secret value or field");
    return binding;
  });
}
export async function parseCallerRetirementModules(bytes, contentType, etag) {
  if (!contentType?.startsWith("multipart/form-data;") || !/^"[a-f0-9]{64}"$/u.test(etag ?? ""))
    fail("module response identity missing");
  const entries = [...await new Response(bytes, { headers: { "Content-Type": contentType } }).formData()];
  if (entries.length < 1 || entries.length > 20) fail("module inventory size");
  const modules = [];
  for (const [name, value] of entries) {
    if (typeof value === "string" || modules.some((m) => m.name === name)) fail("module inventory shape");
    const data = Buffer.from(await value.arrayBuffer());
    if (!data.length || data.length > 8 * 1024 * 1024) fail("module size");
    modules.push({ name, type: value.type, bytes: data.length,
      sha256: createHash("sha256").update(data).digest("hex") });
  }
  return { etag: etag.slice(1, -1), modules: uniqueRows(modules, "name") };
}
export function createCallerRetirementReader({ accountId, token, role, fetcher = fetch, now = Date.now }) {
  const name = workerName(role);
  if (!/^[a-f0-9]{32}$/u.test(accountId ?? "") || typeof token !== "string" || !token || /\s/u.test(token))
    fail("read transport authority invalid");
  const get = async (suffix, raw = false) => {
    const response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${accountId}${suffix}`, {
      method: "GET", headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(20000),
    });
    const bytes = await responseBytes(response);
    if (!response.ok) fail("provider read rejected");
    if (raw) return { bytes, type: response.headers.get("content-type"), etag: response.headers.get("etag") };
    let envelope;
    try { envelope = JSON.parse(bytes); } catch { fail("read envelope invalid"); }
    if (envelope.success !== true || envelope.errors?.length) fail("provider read unsuccessful");
    return envelope;
  };
  const namespaces = async () => {
    let total, pages;
    const all = [];
    for (let page = 1; page <= 100; page++) {
      const e = await get(`/workers/durable_objects/namespaces?page=${page}&per_page=1000`);
      const rows = uniqueRows(e.result, "id"), i = e.result_info;
      const countPages = i?.total_pages ?? (i?.per_page === 1000 && Number.isSafeInteger(i.total_count) ? Math.max(1, Math.ceil(i.total_count / 1000)) : NaN);
      if (!i || i.page !== page || i.count !== rows.length || rows.length > 1000 ||
          !Number.isSafeInteger(i.total_count) || i.total_count < 0 || !Number.isSafeInteger(countPages) || countPages < 1 || countPages > 100)
        fail("namespace pagination unproven");
      total ??= i.total_count; pages ??= countPages;
      if (total !== i.total_count || pages !== countPages) fail("namespace pagination drift");
      all.push(...rows);
      if (page === pages) {
        if (all.length !== total) fail("namespace total mismatch");
        return uniqueRows(all, "id");
      }
    }
    fail("namespace page bound");
  };
  const capture = async () => {
    const scripts = completeRows(await get("/workers/scripts"));
    const globalNamespaces = await namespaces();
    const workers = await Promise.all(cohortNames.map(async (worker) => {
      const identity = scripts.find((s) => s.id === worker);
      if (!identity || !/^[a-f0-9]{32}$/u.test(identity.tag ?? "") || identity.deleted_on != null)
        fail("cohort Worker identity absent");
      const script = `/workers/scripts/${worker}`, service = `/workers/services/${worker}/environments/production`;
      const [settings, deployments, versions, routes, domains, subdomain, environment, schedules, raw] = await Promise.all([
        get(`${script}/settings`), get(`${script}/deployments`), get(`${script}/versions?page=1&per_page=1`),
        get(`${service}/routes?show_zonename=true`), get(`/workers/domains?service=${worker}&environment=production`),
        get(`${service}/subdomain`), get(service), get(`${script}/schedules`), get(`${script}/content/v2`, true),
      ]);
      const active = deployments.result?.deployments?.[0], latest = versions.result?.items?.[0];
      if (!uuid.test(active?.id ?? "") || active.versions?.length !== 1 || active.versions[0].percentage !== 100 ||
          !uuid.test(active.versions[0].version_id ?? "") || latest?.id !== active.versions[0].version_id)
        fail("cohort latest is not sole active version");
      const detail = (await get(`${script}/versions/${latest.id}`)).result;
      if (detail?.id !== latest.id) fail("active detail mismatch");
      if (!same(settings.result?.annotations, detail.annotations)) fail("settings/version annotations mismatch");
      const code = await parseCallerRetirementModules(raw.bytes, raw.type, raw.etag);
      if (code.etag !== detail.resources?.script?.etag) fail("active module changed during read");
      return { name: worker, tag: identity.tag, activeVersion: latest.id, latestVersion: latest.id, deploymentId: active.id,
        versionAnnotations: structuredClone(detail.annotations),
        settings: { ...settings.result, bindings: safeBindings(settings.result?.bindings) },
        resources: { ...detail.resources, bindings: safeBindings(detail.resources?.bindings) }, code,
        control: { routes: completeRows(routes), domains: completeRows(domains), subdomain: subdomain.result,
          environment: environment.result, schedules: schedules.result } };
    }));
    const target = workers.find((w) => w.name === name);
    // Keep full service metadata. The post comparator types the narrow timestamp,
    // identifier and API-client transition and preserves every other field.
    return { accountId, ...target, peers: { workers: uniqueRows(workers.filter((w) => w.name !== name), "name"), namespaces: globalNamespaces } };
  };
  return async () => {
    const started = now(), first = await capture(), second = await capture();
    if (now() - started > 120000 || !same(first, second)) fail("cohort unstable or read expired");
    return { ...second, capturedAt: now() };
  };
}
