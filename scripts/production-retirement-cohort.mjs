// Copyright (C) 2026 Atrinik contributors
import { callerRetirementDigest, requireRetiredCallerProof } from "./production-caller-retirement.mjs";

const fail = () => { throw new Error("retirement cohort identity changed outside an authorized transition"); };
const same = (left, right) => callerRetirementDigest(left) === callerRetirementDigest(right);
const names = ["atrinik-metaserver", "atrinik-metaserver-publisher", "atrinik-metaserver-rendezvous",
  "atrinik-metaserver-development", "atrinik-metaserver-development-publisher", "atrinik-metaserver-development-rendezvous"];
function graph(snapshot, accountId) {
  if (snapshot.accountId !== accountId || !Array.isArray(snapshot.peers?.workers) ||
      !Array.isArray(snapshot.peers?.namespaces)) fail();
  const { accountId: _account, capturedAt: _time, peers: _peers, ...own } = snapshot;
  const rows = [own, ...snapshot.peers.workers];
  if (rows.length !== names.length || new Set(rows.map(row => row.name)).size !== names.length ||
      rows.some(row => !names.includes(row.name))) fail();
  return new Map(rows.map(row => [row.name, structuredClone(row)]));
}

// This guard belongs to one delivery invocation. A transition can be registered
// only by that invocation's successful upload/readback callback. The supplied
// validator binds the exact uploaded UUID, selected bytes, configuration and
// annotation; all other Workers and global namespaces remain byte-identical.
export function createRetirementCohortGuard({ accountId, scope }) {
  let expected, namespaces;
  const transitions = new Map();
  function compare(snapshot, excludedName) {
    const current = graph(snapshot, accountId);
    if (!expected) return current;
    if (!same(snapshot.peers.namespaces, namespaces)) fail();
    const accepted = [];
    for (const [name, value] of current) {
      if (name === excludedName) continue;
      const transition = transitions.get(name);
      if (transition) {
        if (value.activeVersion !== transition.versionId || value.latestVersion !== transition.versionId ||
            transition.validate(structuredClone(value), structuredClone(expected.get(name)), snapshot.capturedAt) !== true) fail();
        accepted.push(name);
      } else if (!same(value, expected.get(name))) fail();
    }
    // Commit only after the complete graph passes; a failed peer never teaches
    // the guard a new expected state or consumes another peer's transition.
    for (const name of accepted) { expected.set(name, current.get(name)); transitions.delete(name); }
    return current;
  }
  return Object.freeze({
    recordUpload({ name, versionId, validate }) {
      if (!expected) return;
      if (!names.slice(0, 3).includes(name) || typeof validate !== "function" ||
          !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(versionId ?? "") ||
          transitions.size !== 0 || versionId === expected.get(name).activeVersion) fail();
      transitions.set(name, { versionId, validate });
    },
    check(snapshot) { compare(snapshot); return true; },
    acceptRetirement({ snapshot, proof, role, selectedIdentity, now = Date.now }) {
      requireRetiredCallerProof({ snapshot, proof, role, scope, selectedIdentity, now });
      const current = compare(snapshot, snapshot.name);
      if (transitions.has(snapshot.name)) fail();
      if (!expected) {
        expected = current;
        namespaces = structuredClone(snapshot.peers.namespaces);
      } else expected.set(snapshot.name, current.get(snapshot.name));
      return true;
    },
  });
}
