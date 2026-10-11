// Copyright (C) 2026 Atrinik contributors
// Closed child-to-parent diagnostics. Never forward provider messages or receipts.
const phases = new Set(["configuration", "authority-before-proxy", "proxy-initialization",
  "authority-before-request", "request", "response", "receipt", "authority-after-receipt", "cleanup"]);
const reasons = new Set(["operation-failed", "deadline-exceeded", "response-rejected", "receipt-missing",
  "receipt-too-large", "receipt-invalid", "cleanup-deadline-exceeded", "cleanup-failed"]);
const knownMessages = new Map([
  ["directory proxy deadline exceeded", "deadline-exceeded"],
  ["directory proxy initialization expired", "deadline-exceeded"],
  ["directory proxy response rejected", "response-rejected"],
  ["directory proxy receipt missing", "receipt-missing"],
  ["directory proxy receipt too large", "receipt-too-large"],
  ["directory proxy receipt invalid", "receipt-invalid"],
  ["directory proxy cleanup deadline exceeded", "cleanup-deadline-exceeded"],
  ["directory proxy cleanup failed", "cleanup-failed"],
]);
for (const status of [400, 401, 403, 404, 429, 500, 502, 503, 504]) {
  const reason = `http-${status}`;
  reasons.add(reason);
  knownMessages.set(`directory proxy response rejected (http=${status})`, reason);
}
const failures = new WeakMap();
const prefix = "ATRINIK_DIRECTORY_FAILURE ";
export function markDirectoryFailure(error, phase) {
  const failure = error instanceof Error ? error : new Error("directory proxy operation failed");
  failures.set(failure, { phase: phases.has(phase) ? phase : "configuration",
    reason: knownMessages.get(failure.message) ?? "operation-failed" });
  return failure;
}
export function directoryFailureLine(error) {
  const failure = failures.get(error) ?? { phase: "configuration", reason: "operation-failed" };
  return prefix + JSON.stringify({ schema: "directory-failure-v1", ...failure });
}
export function parseDirectoryFailure(stderr) {
  if (typeof stderr !== "string" || stderr.length > 8192) return null;
  const lines = stderr.split(/\r?\n/u).filter(line => line.startsWith(prefix));
  if (lines.length !== 1 || lines[0].length > 256) return null;
  let record;
  try { record = JSON.parse(lines[0].slice(prefix.length)); } catch { return null; }
  if (!record || typeof record !== "object" || Array.isArray(record) ||
      Object.keys(record).sort().join() !== "phase,reason,schema" ||
      record.schema !== "directory-failure-v1" || !phases.has(record.phase) || !reasons.has(record.reason)) return null;
  return record;
}
