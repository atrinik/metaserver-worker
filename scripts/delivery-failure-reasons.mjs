// Copyright (C) 2026 Atrinik contributors
// Closed, secret-free delivery failure reasons branded by error identity.
// Messages are never reflected: a reason exists only for an error object that a
// delivery module branded when it threw it.
const allowed = new Set([
  "development-authority-context-rejected",
  "development-authority-run-fence-rejected",
  "development-authority-check-rejected",
  "development-authority-concurrent-writer",
  "development-authority-environment-rejected",
  "development-authority-github-read-rejected",
  "delivery-resource-policy-rejected",
  "production-rate-bootstrap-rejected",
]);
const reasons = new WeakMap();

export function brandDeliveryFailure(error, reason) {
  if (!allowed.has(reason)) throw new TypeError("unknown delivery failure reason");
  reasons.set(error, reason);
  return error;
}

// Inspect a bounded chain of own data properties without invoking getters.
export function deliveryFailureReason(error) {
  for (let depth = 0; depth < 4 && error && typeof error === "object"; depth++) {
    const reason = reasons.get(error);
    if (reason) return reason;
    error = Object.getOwnPropertyDescriptor(error, "cause")?.value;
  }
  return null;
}
