// Copyright (C) 2026 Atrinik contributors
import publicNames from "./diagnostic-public-names.json" with { type: "json" };

const resourceTypes = ["d1", "r2", "durable-object", "analytics", "rate-limit"];
const reject = () => { throw new Error("diagnostic projection rejected"); };

// Validate before sorting or walking paths: provider objects must never supply
// path segments, output names, getters or serialization hooks.
function record(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) reject();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.length ||
      keys.some(key => !Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key], "value"))) reject();
  return value;
}
function strings(value, keys) {
  record(value, keys);
  if (keys.some(key => typeof value[key] !== "string")) reject();
}
function array(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 4096 ||
      Reflect.ownKeys(value).length !== value.length + 1) reject();
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !Object.hasOwn(descriptor, "value")) reject();
  }
}
export function validateDiagnosticWorker(worker) {
  record(worker, ["name", "role", "resources", "services", "origins", "variables", "routes", "secrets"]);
  if (typeof worker.name !== "string" || typeof worker.role !== "string" || !Object.hasOwn(publicNames, worker.role)) reject();
  for (const key of ["resources", "services", "origins", "variables", "routes", "secrets"]) array(worker[key]);
  for (const resource of worker.resources) {
    const descriptor = Object.getOwnPropertyDescriptor(resource, "type");
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !resourceTypes.includes(descriptor.value)) reject();
    strings(resource, descriptor.value === "durable-object"
      ? ["binding", "type", "id", "owner", "className"] : ["binding", "type", "id"]);
  }
  for (const service of worker.services) strings(service, ["binding", "service", "entrypoint"]);
  for (const variable of [...worker.origins, ...worker.variables]) strings(variable, ["binding", "value"]);
  if ([...worker.routes, ...worker.secrets].some(value => typeof value !== "string")) reject();
  // Preserve the policy parser's collection-scoped uniqueness contract. The
  // live projector already rejects name collisions across binding types.
  for (const key of ["resources", "services", "origins", "variables", "routes", "secrets"]) {
    const names = worker[key].map(value => typeof value === "string" ? value : value.binding);
    if (new Set(names).size !== names.length) reject();
  }
}

// Only call with validated projections. Public labels come from the reviewed
// manifest, never from either private inventory. Unknown identities are not
// paired or hashed; their only disclosure is the count on each side.
export function collectionDifferences(expected, actual, changedCollections) {
  const output = {};
  for (const collection of ["resources", "variables", "secrets"]) {
    if (!changedCollections.includes(collection)) continue;
    const policy = expected[collection], live = actual[collection];
    const allowed = publicNames[expected.role][collection];
    const nameOf = value => collection === "secrets" ? value : value.binding;
    const rows = [];
    for (const binding of allowed) {
      for (const type of collection === "resources" ? resourceTypes : [null]) {
        const matches = value => nameOf(value) === binding && (type === null || value.type === type);
        const policyItem = policy.find(matches), liveItem = live.find(matches);
        if (policyItem === undefined && liveItem === undefined) continue;
        const both = policyItem !== undefined && liveItem !== undefined;
        rows.push({ binding, ...(type === null ? {} : { type }),
          membership: both ? "both" : policyItem === undefined ? "live-only" : "policy-only",
          ...(both && collection === "resources" ? { idDiffers: policyItem.id !== liveItem.id } : {}),
          ...(both && collection === "variables" ? { valueDiffers: policyItem.value !== liveItem.value } : {}) });
      }
    }
    output[collection] = { policyCount: policy.length, liveCount: live.length, publicNames: rows,
      unrecognized: { policyCount: policy.filter(value => !allowed.includes(nameOf(value))).length,
        liveCount: live.filter(value => !allowed.includes(nameOf(value))).length } };
  }
  return output;
}
