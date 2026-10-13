// Copyright (C) 2026 Atrinik contributors
// Synthetic offline fixture only. Never a measured qualification attestation.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import { mock } from "node:test";
import assert from "node:assert/strict";
import { loadCallerRetirementQualification } from "../production-retirement-qualification.mjs";
export function qualificationDocument(accountId = "a".repeat(32)) {
  return { schema: "atrinik-caller-retirement-provider-qualification-v1", qualification: {
    accountIdSha256: createHash("sha256").update(accountId).digest("hex"),
    contract: { method: "PATCH", contentType: "application/merge-patch+json",
      endpoint: "https://api.cloudflare.com/client/v4/accounts/{account_id}/workers/scripts/{script_name}/secrets-bulk",
      bodyKeys: ["secrets", "version_tags"], secretNames: ["SOURCE_TAG_KEY_CURRENT", "SOURCE_TAG_KEY_PREVIOUS"],
      secretOperation: "null-delete", versionTagKeys: ["workers/tag", "workers/message"] },
    measuredAt: "1970-01-01T00:00:00.000Z",
    result: { status: "canary-measured-and-absent", scope: "isolated", measurement: {
      secretPairRemoved: true, versionSecretPairRemoved: true, tagPreserved: true, messagePreserved: true,
      versionTagPreserved: true, versionMessagePreserved: true, settingsTriggerSecret: true,
      versionTriggerSecret: true, newVersion: true, codeUnchanged: true,
    }, mappingObserved: true, productionAuthorized: false, productionContractSatisfied: false },
    evidence: Object.fromEntries(["probeControllerSha256", "requestSha256", "beforeSha256", "afterSha256", "resultSha256"]
      .map((name, index) => [name, String(index + 1).repeat(64)])),
    review: { reviewedAt: "1970-01-01T00:00:01.000Z", recordSha256: "6".repeat(64), resultSha256: "5".repeat(64) },
  } };
}
export const qualificationBytes = document => Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
export async function fixtureQualification({ accountId = "a".repeat(32), document = qualificationDocument(accountId),
  bytes = qualificationBytes(document), regular = true, size = bytes.length, now = () => 1000 } = {}) {
  let closed = false;
  const interception = mock.method(fs, "open", async (url, flags) => {
    assert.equal(url.href, new URL("../../deployment/caller-retirement-provider-qualification.json", import.meta.url).href);
    assert.equal(flags, constants.O_RDONLY | constants.O_NOFOLLOW);
    return { stat: async () => ({ isFile: () => regular, size }),
      read: async target => { bytes.copy(target); return { bytesRead: bytes.length }; },
      close: async () => { closed = true; } };
  });
  try { return await loadCallerRetirementQualification({ accountId, now }); }
  finally { interception.mock.restore(); assert.equal(closed, true); }
}
