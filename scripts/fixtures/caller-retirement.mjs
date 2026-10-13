// Copyright (C) 2026 Atrinik contributors
// Offline fixtures invoke the actual retirement state machine; no proof-mint API.
import { callerRetirementSecrets, callerRetirementDigest, retireCallerSecrets } from "../production-caller-retirement.mjs";
import { fixtureQualification } from "./retirement-qualification.mjs";
const accountId = "a".repeat(32), hash = "b".repeat(64), source = "c".repeat(40);
const oldId = "00000000-0000-0000-0000-000000000001", newId = "00000000-0000-0000-0000-000000000002";
function serviceEnvironment(name = "atrinik-metaserver-publisher") {
  return { environment: "production", script_tag: accountId,
    created_on: "1970-01-01T00:00:00.000Z", modified_on: "1970-01-01T00:00:00.500Z",
    script: { created_on: "1970-01-01T00:00:00.000Z", modified_on: "1970-01-01T00:00:00.500Z",
      id: name, tag: accountId, tags: [], deployment_id: "", tail_consumers: null, logpush: false,
      observability: { enabled: true, head_sampling_rate: 1, redact_query_string: false,
        logs: { enabled: true, destinations: [], head_sampling_rate: 1, persist: true, invocation_logs: false },
        traces: { enabled: false, destinations: [], persist: true, head_sampling_rate: 1 } },
      has_assets: false, has_modules: true, etag: hash, handlers: ["fetch"], last_deployed_from: "wrangler",
      compatibility_date: "2026-10-01", compatibility_flags: ["nodejs_compat"], usage_model: "standard" } };
}
export function retirementBaseline(role = "publisher") {
  const rows = [
    ...callerRetirementSecrets.map((name) => ({ name, type: "secret_text" })),
    { name: "COORDINATOR", type: "service", service: "atrinik-metaserver", entrypoint: role === "publisher" ? "PublisherCoordinator" : "RendezvousCoordinator" },
    ...(role === "publisher" ? ["PUBLISH_ENABLED", "GAME_PUBLISH_ENABLED"] : ["RENDEZVOUS_ENABLED"])
      .map((name) => ({ name, type: "plain_text", text: "disabled" })),
  ];
  const value = { accountId, tag: accountId, name: `atrinik-metaserver-${role}`, activeVersion: oldId, latestVersion: oldId, deploymentId: oldId,
    settings: { bindings: rows, annotations: { "workers/tag": source, "workers/message": `atrinik-delivery-v1 source=${source} deploy=${hash} migration=${hash} horizon=16 control=${hash} role=${role} phase=staged`, "workers/triggered_by": "version_upload" }, compatibility_date: "2026-10-01" },
    resources: { bindings: structuredClone(rows), script: { etag: hash, handlers: ["fetch"] } },
    code: { etag: hash, modules: [{ name: `${role}.js`, type: "application/javascript+module", sha256: hash, bytes: 100 }] },
    control: { environment: serviceEnvironment(`atrinik-metaserver-${role}`), routes: [], domains: [] },
    peers: { workers: [{ name: "core", signingSecrets: [...callerRetirementSecrets] }], namespaces: [] }, capturedAt: 1000 };
  value.versionAnnotations = structuredClone(value.settings.annotations);
  value.resources.script.last_deployed_from = "wrangler";
  return value;
}
export function retirementAfter(before = retirementBaseline()) {
  const after = structuredClone(before);
  for (const f of ["settings", "resources"]) after[f].bindings = after[f].bindings.filter((b) => b.type !== "secret_text");
  after.settings.annotations = { "workers/triggered_by": "secret" };
  after.versionAnnotations = structuredClone(after.settings.annotations);
  after.activeVersion = after.latestVersion = after.deploymentId = newId;
  return after;
}

export function retirementSelectedIdentity(before) {
  return { sourceSha: before.settings.annotations["workers/tag"], deployableDigest: hash,
    configurationDigest: hash, bundleDigest: before.code.modules[0].sha256,
    uploadedVersion: before.activeVersion, controllerSha: source, runId: "1", runAttempt: "1" };
}
export async function retirementFixture({ role = "publisher", provenance = "api", versionId = newId } = {}) {
  const before = retirementBaseline(role), after = retirementAfter(before);
  after.activeVersion = after.latestVersion = after.deploymentId = versionId;
  after.resources.script.last_deployed_from = after.control.environment.script.last_deployed_from = provenance;
  const qualification = await fixtureQualification(), scope = Object.freeze({}), selectedIdentity = retirementSelectedIdentity(before);
  let reads = 0;
  const artifacts = [];
  const options = { qualification, role, scope, selectedIdentity, now: () => 1000,
    fence: async () => {}, authorize: async () => {}, verifyStaged: async () => true,
    read: async () => structuredClone(++reads < 3 ? before : after), patch: async () => {},
    recordIntent: async document => { artifacts.push(structuredClone(document)); },
    recordReceipt: async document => { artifacts.push(structuredClone(document)); } };
  return { before, after, scope, selectedIdentity, options, artifacts, retire: () => retireCallerSecrets(options) };
}
