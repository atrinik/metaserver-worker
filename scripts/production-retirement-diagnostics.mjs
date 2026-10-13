// Copyright (C) 2026 Atrinik contributors
import { productionReadFailure } from "./production-read-pacing.mjs";

const failures = new WeakMap(), patches = new WeakMap(), observations = new WeakMap();
const phases = new Set(["initial-fence", "initial-read", "initial-compare", "initial-staged-proof",
  "intent-proof", "post-intent-fence", "current-read", "current-compare", "staged-proof",
  "final-authority", "freshness", "patch", "post-read", "postverify", "post-fence", "receipt-proof"]);
const states = new Set(["not-invoked", "not-dispatched", "dispatched-outcome-unknown", "response-received", "response-accepted"]);
const object = value => value !== null && ["object", "function"].includes(typeof value);

export function markRetirementPatchFailure(error, state) {
  if (!states.has(state)) throw new Error("invalid retirement diagnostic state");
  const value = object(error) ? error : new Error("retirement transport stopped");
  patches.set(value, state);
  return value;
}

export function markRetirementFailure(error, phase, mutationState) {
  if (!phases.has(phase) || !states.has(mutationState)) throw new Error("invalid retirement diagnostic phase");
  const value = object(error) ? error : new Error("retirement stopped");
  const transport = productionReadFailure(value);
  failures.set(value, Object.freeze({ phase, category: transport?.category ?? "verification-failed",
    mutationState: patches.get(value) ?? mutationState,
    ...(transport ? { readTransportState: transport.transportState,
      ...(transport.httpStatus === undefined ? {} : { httpStatus: transport.httpStatus }) } : {}) }));
  return value;
}

export function retirementFailureDiagnostic(error) {
  for (let depth = 0; depth < 4 && object(error); depth++) {
    const result = failures.get(error);
    if (result) return { ...result };
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(error, "cause"); } catch { return null; }
    if (!descriptor || !Object.hasOwn(descriptor, "value")) return null;
    error = descriptor.value;
  }
  return null;
}

// Carry only the original closed diagnostic through a stronger failure wrapper.
// Keeping its public reason intact also preserves existing retention precedence.
export function preserveRetirementFailure(wrapper, original) {
  const diagnostic = retirementFailureDiagnostic(original);
  if (diagnostic) failures.set(wrapper, Object.freeze(diagnostic));
  const observation = callerObservationFailureDiagnostic(original);
  if (observation) observations.set(wrapper, Object.freeze(observation));
  return wrapper;
}

// Observation failures are separate from retirement transport outcomes.
export function markCallerObservationFailure(error, phase) {
  if (!["staged-observation", "activation"].includes(phase)) throw new Error("invalid caller observation phase");
  const value = object(error) ? error : new Error("caller observation stopped");
  observations.set(value, Object.freeze({ phase, mutationState: "not-invoked" }));
  return value;
}
export function callerObservationFailureDiagnostic(error) {
  for (let depth = 0; depth < 4 && object(error); depth++) {
    const result = observations.get(error);
    if (result) return { ...result };
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(error, "cause"); } catch { return null; }
    if (!descriptor || !Object.hasOwn(descriptor, "value")) return null;
    error = descriptor.value;
  }
  return null;
}
