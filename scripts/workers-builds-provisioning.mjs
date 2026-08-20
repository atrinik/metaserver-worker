import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, open, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  validateBuildEnvironment,
  validateContract as validateProductionContract,
  validateRemoteBindings,
  validateRuntimeExports,
  validateTopology,
} from "./production-delivery.mjs";
import { validateCheckedInContract as validateReviewContract } from "./review-environment.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const productionPath = resolve(root, "deployment/workers-builds-production.json");
const reviewPath = resolve(root, "deployment/workers-builds-review.json");
const accountIdPattern = /^[0-9a-f]{32}$/u;
const scriptTagPattern = /^[0-9a-f]{32}$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const maximumProviderResponseBytes = 1024 * 1024;
const maximumPrivateDocumentBytes = 64 * 1024;
const maximumPinnedIncidentExecutorBytes = 128 * 1024;
const maximumProviderPages = 100;
const stagingBranchPattern = /^review-build-only-sentinel-[0-9a-f]{32}$/u;
const reviewStagingRootPattern = /^\/review-build-only-staging-[0-9a-f]{32}$/u;
const gitShaPattern = /^[0-9a-f]{40}$/u;
const expectedSetupPlanSha256 = "60d101066849be5c1de94f09a2610aa2e3345bae520257e4fbe8b2c01e43b347";
const currentMainProofSource = "authenticated-gh-api-current-main-readback";
const currentMainProofEndpoint = "repos/atrinik/metaserver-worker/git/ref/heads/main";
const currentMainRef = "refs/heads/main";
const reviewActivationAuthorityLifetimeMs = 30 * 60_000;
const reviewActivationTransitionBudgetMs = 5 * 60_000;
const disposableReviewAuthorityLifetimeMs = 60 * 60_000;
const disposableReviewPushReserveMs = 40 * 60_000;
const reviewTokenRotationAuthorityLifetimeMs = 30 * 60_000;
const reviewTokenRotationTransitionBudgetMs = 5 * 60_000;
const blockedReviewTokenDeleteAuthorityLifetimeMs = 15 * 60_000;
const blockedReviewTokenDeleteTransitionBudgetMs = 5 * 60_000;
const reviewMembershipRepairAuthorityLifetimeMs = 15 * 60_000;
export const reviewMembershipRepairIncident = Object.freeze({
  sourceSha: "b97fcefb09fb09d7e7a99daab8ef9ba168ce3b0f",
  rotationJournalSha256:
    "9bf6177c410235baa66036364c1414ce6a2ade2141fe5cff3b2b1ba6e2b73bb3",
  rotationTerminalRecordSha256:
    "e7664db4a3a26d44a54cc457b4297808bc926d8ce052bc195fcba7a3081d0e95",
  rotationCompleteProofFileSha256:
    "fe90b57f5b1bf5e371b25479712a0c00db8365c5311765feaddf9d1aa07118e2",
  rotationCompleteProofDigest:
    "ef7b0f296648a37655c451ba6f01a7d68c4e359c452aea02438667d534b8c6f0",
  reviewBuildTokenUuid: "79a6606b-f3b4-436e-abe9-10e8650c50e8",
  reviewTokenId: "c6be328862f30f76fdc5cf455eae0777",
  ownerUserId: "b33f81835d7dc584622ca841b124a9a5",
  failedDisposableJournalSha256:
    "0b78d6af80756b67be734e5e4b8a749cb3a2483865085fc8ad50e0784193e203",
  failedDisposableTerminalRecordSha256:
    "7b065e986f517bc6ebcdb0081fcbdfe83696b397932d5e1a55bb76d7c60019ce",
  failedBuildDetailSha256:
    "db4e9a7dc4c27c3e1d38a1ec038fd4683a2cb7bc4dc8a156b64683797ff2898a",
  failedBuildLogsSha256:
    "045115bb7ac609281027d4bde1e2fda7bac62e173fc336b91c56464c6a969a05",
  failedBuildUuid: "68747ae8-f5ca-45d4-955b-61151ba9075f",
  failedBuildCommit: "a802d53b934f89c07084784f9dcd8d9215fd5e02",
  failedBuildBranch: "review/issue-66-disposable-120",
  failedBuildStoppedAt: "2026-08-19T18:53:56.540Z",
  failureClass: "accepted-member-user-token-rejected-as-departed",
});
export const reviewMembershipSuccessorRotationIncident = Object.freeze({
  sourceSha: "85cce723eb109a26e9bb9d375bc5382129466ee0",
  predecessorReviewBuildTokenUuid: "79a6606b-f3b4-436e-abe9-10e8650c50e8",
  predecessorReviewTokenId: "c6be328862f30f76fdc5cf455eae0777",
  replacementReviewTokenId: "65b2e92887b640023f74bc79eb3130b1",
  membershipRepairAuthorityFileSha256:
    "ca744001d431e1804a13e0a675814313d4638f6e14e123d6ba729310b4f45de1",
  membershipRepairAuthorityDigest:
    "a4e1c79bf3f0fdfd06f53d60cda32459535263c8fd1b0d55028817091da0c97a",
  membershipRepairJournalSha256:
    "30e92d5717aa8c6f8dfc9042dcf6213d002804d154d42d00c6df3ed9f31d5f42",
  membershipRepairTerminalRecordSha256:
    "dd29e847092294ad7139dcc4bb83253487bcabed4a5ff4a009eb09a8708f0708",
  membershipRepairResultProofFileSha256:
    "1e49fe673e752a24a7980a91fce7deb1beb25541ce815983919160cd3147f025",
  membershipRepairResultProofDigest:
    "941573b734a760e7f1b26c15f497dff88f4628622015d8bd2893c370497846ae",
  membershipRepairSnapshotManifestSha256:
    "e18961b746e9f76d20c2d2b4567ebbea233f2148225530d41cc5e906ad639495",
});
const reviewMembershipSuccessorEvidenceDigest =
  "876b9d46ed1c063cf9ac9d702d5953bad9eb26c366668e3a2bc7d7e7f912cf12";
export const reviewTokenRotationProviderNormalizedIncident = Object.freeze({
  sourceSha: "48f791e60bc0c1d19a7eff28e9cd99ed1bfd317a",
  planDigest: "ab71b8d99980ccdbfe9384bd29e8d690b7d8e91b6b17199e0e1baad182f7b6c1",
  forwardJournalSha256: "cc7ac5c50cbe1bc15f7d065d3f704fdb96bc1773a50a59c12fc46309cda76c7f",
  forwardJournalDigest: "29c05a80e8cdaf2d71356db99f76fa04a1351f5dfe80c9f378a0493183000101",
  incidentSnapshotManifestSha256:
    "24d677a0d07c0a76a94f22f5eaa2991f97137bd2be74c23195ef46d2f93971fe",
  authorityFileSha256: "15e003bd1b94fd7733c9019e991620b7b39899d74e5e8a4ae5dce247cd2a051d",
  incidentProofDigest: "11309f34f508702eab49166169f02366f69fce22f45abdd3b2b36444a78ca731",
  incidentProofDocumentSha256:
    "07a7fe6106d1317b4566b703c3ff5be74315e33dc3068ef8fef82effb06ffd06",
});
export const reviewTokenRotationBlockedDeleteIncident = Object.freeze({
  sourceSha: "c9114b6f5c5625d08c365d3c8409d690209e489d",
  planDigest: "0edc38f1eab7758f3f5820c84fede882f813d63c6c02040ec80449ee6ecd663d",
  executorSha256: "83e01c6a4c2a5051287581c7f21691db01b9838d2944d6f7529d42d663a36ac6",
  rollbackJournalSha256: "d95a4770d916908212106eb5359f057f77055b9cb71c8e12b4b0f563aa2c812d",
  rollbackJournalDigest: "ee8e9e85ae52c544363b9fbe833271e9e9631f94fd94cf72bb1b43927c8dba90",
  rollbackTerminalRecordSha256:
    "279412e25004a493b61b3f98692f01ae1b4a2575688c2c1dcb32b3c112af50df",
  residualSnapshotManifestSha256:
    "8d3ccc92ff003b1c1154644dbbaecb481043667ab0be43cb70c0f64f29f3e8bb",
  residualProofDigest: "a51761d38118a3deda029f7e6d3b25fb18a2d0330a6596be3289bb225e1a3af6",
  residualProofDocumentSha256:
    "432a688aa1db9c1f92f53eed2a84caf7671c3f0da97a3c86717e9699fc0c1040",
  failedGuardResponseSha256:
    "fdb4b1956f095fc97634600784c5f25cc243ccaef5c599c6ee44ce0f58eef24d",
});
export const reviewTokenRotationNoOwnedIncident = Object.freeze({
  sourceSha: "0f9454ba3b66bcafbdebfff188c16f6a578fa03b",
  planDigest: "6088031ae9e138bbbaea7e79d8962dd9dcaff5952307dc78941821d6ab6a3937",
  executorSha256: "b189ca4dd298819a9aec7571838d3e5a36babb679637450f1775fee0f70718dc",
  forwardJournalSha256: "c69a525f8aa47239b1c693ef1355e21d88960050fe980c576b0e06a9628dd6e5",
  forwardJournalDigest: "4e7e23e37ed3c93f4485e0bbf7d520b22d9b45990734611cdfe0c61523671bb2",
  rollbackJournalSha256: "8bca5a998486a403c61463cc543cf4f5803e18d7a1a2c7f2dcc65a04bc546a90",
  rollbackJournalDigest: "0d927073f9f2c31a8350cbbba4f57b70813fa6892f51ff429f2ae429555292c7",
  rollbackTerminalRecordSha256:
    "ecd61537ccb0d1a4211b4ad4c6aba6fcb86354dac71f9e30dc207aa5ade9b210",
  authorityFileSha256: "d5c1c1a02732fe9d01d6527906668922dfdb310a45398da0dcabe7b4c2f68fa5",
  preCreateProofFileSha256:
    "9c68ea979fe0ca6830e5129b5a0f981968f6e60b095f780610d109f657270ac3",
  residualSnapshotManifestSha256:
    "30bda17eb114c4aae1d58126195b06b1229d7900cfecc6dc0fbce1d2c6dd25b5",
  residualProofDigest: "e754373cedc801a8ac915c6e5e13a409aef84789e6dfa014893d8d707a272b31",
  residualProofDocumentSha256:
    "4320d8662cba3aeec206db17fbaebb57af04f5438ecd73cf0224c70973585e7c",
  residualProofFileSha256:
    "2015810a4c78fe0fcdf4d88c96b9c66f1570d59534f278f0d4bb7a033f1b14fe",
});
const reviewTokenRotationRetryProgram = Object.freeze({
  masterIssueNumber: 114,
  masterIssueNodeId: "I_kwDOTu8rSM8AAAABNZty_A",
  leafIssueNumber: 118,
  leafIssueNodeId: "I_kwDOTu8rSM8AAAABNaa8UA",
  ledgerCoordinate: "d7cd09686d6494fdf966faa6015217b31a335e061e5a14f3a5c9d3fcca670335",
  providerNormalizedForwardJournalSha256:
    reviewTokenRotationProviderNormalizedIncident.forwardJournalSha256,
  providerNormalizedRollbackJournalSha256:
    reviewTokenRotationBlockedDeleteIncident.rollbackJournalSha256,
  blockedDeleteRecoveryJournalSha256:
    "a63e84d001d8de38442f9be41aff3155378a6cec885d8413d5443ff86f9d923d",
  blockedDeleteRecoveryTerminalRecordSha256:
    "d5658229404f85a6bb7396640775dbfafd48e5fdd49b69b69fa133d3f599b790",
  blockedDeleteRecoveryProofDigest:
    "d3091640160721383ef4e7a8e5ae6ad0789b3013088e5250b2b3dbdec01aed69",
  noOwnedSuccessorSourceSha: "929870b8427559b49e67c7c42d9db7cbc3b6f9c5",
  noOwnedSuccessorJournalSha256:
    "e02c2a129f133f396bf00a789523a1ed0940eee1a0f21e196987c6d1c3fad87d",
  noOwnedSuccessorTerminalRecordSha256:
    "27762a9096f5ae4b991af80c3ef4ca8fd74112db9918032e7e09870265b89ac0",
  noOwnedSuccessorProofDigest:
    "8d29d2020a4302fe76a8e9a7701c19e62a12f555d133673e5dffcef2bd0060ca",
  noOwnedSuccessorSnapshotManifestSha256:
    "ce4e283933a1d4616c739585b9e13073b006c62fcd13b603b12631d59bc5acb3",
});
const providerNormalizedIncidentTestCapabilities = new WeakSet();
const noOwnedIncidentTestCapabilities = new WeakSet();
const noOwnedTerminalContextReaders = new WeakSet();
export function createProviderNormalizedIncidentTestCapability(coordinate) {
  if (process.env.NODE_TEST_CONTEXT !== "child-v8")
    fail("provider-normalized incident test capability is unavailable");
  const capability = Object.freeze({ coordinate: Object.freeze(structuredClone(coordinate)) });
  providerNormalizedIncidentTestCapabilities.add(capability);
  return capability;
}
function providerNormalizedIncidentCoordinate(testCapability) {
  return providerNormalizedIncidentTestCapabilities.has(testCapability) ?
    testCapability.coordinate : reviewTokenRotationProviderNormalizedIncident;
}
export function createNoOwnedIncidentTestCapability(coordinate) {
  if (process.env.NODE_TEST_CONTEXT !== "child-v8")
    fail("no-owned incident test capability is unavailable");
  const capability = Object.freeze({ coordinate: Object.freeze(structuredClone(coordinate)) });
  noOwnedIncidentTestCapabilities.add(capability);
  return capability;
}
function noOwnedIncidentCoordinate(testCapability) {
  return testCapability && noOwnedIncidentTestCapabilities.has(testCapability) ?
    testCapability.coordinate : reviewTokenRotationNoOwnedIncident;
}
export function createNoOwnedTerminalContextReaderForTest(reader) {
  if (process.env.NODE_TEST_CONTEXT !== "child-v8" || typeof reader !== "function")
    fail("no-owned terminal test reader is unavailable");
  noOwnedTerminalContextReaders.add(reader);
  return reader;
}
const blockedDeleteIncidentTestCapabilities = new WeakSet();
export function createBlockedDeleteIncidentTestCapability(coordinate) {
  if (process.env.NODE_TEST_CONTEXT !== "child-v8")
    fail("blocked delete incident test capability is unavailable");
  const capability = Object.freeze({ coordinate: Object.freeze(structuredClone(coordinate)) });
  blockedDeleteIncidentTestCapabilities.add(capability);
  return capability;
}
function blockedDeleteIncidentCoordinate(testCapability) {
  return blockedDeleteIncidentTestCapabilities.has(testCapability) ?
    testCapability.coordinate : reviewTokenRotationBlockedDeleteIncident;
}
const blockedDeleteTerminalContextReaders = new WeakSet();
export function createBlockedDeleteTerminalContextReaderForTest(reader) {
  if (process.env.NODE_TEST_CONTEXT !== "child-v8" ||
      typeof reader !== "function")
    fail("blocked delete terminal test reader is unavailable");
  blockedDeleteTerminalContextReaders.add(reader);
  return reader;
}
export const reviewBuildTokenNames = Object.freeze({
  predecessor: "Atrinik metaserver review check",
  current: "Atrinik metaserver review check rotation 96",
});
const reviewActivationPredecessorPlanDigest =
  "fb95bcc4e693b6f933dc1bb788b736100dbd6a24c5b601e3533a03097d091892";
const currentMainRepository = Object.freeze({ owner: "atrinik", name: "metaserver-worker" });
const githubRepository = Object.freeze({
  provider_account_id: "6371603",
  provider_account_name: "atrinik",
  provider_type: "github",
  repo_id: "1324297032",
  repo_name: "metaserver-worker",
});
const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
const execFileAsync = promisify(execFile);

export class WorkersBuildsProvisioningError extends Error {}

function fail(message) {
  throw new WorkersBuildsProvisioningError(message);
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
      .map(([key, item]) => [key, canonical(item)]));
  return value;
}

function sameCanonical(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function isUtcTimestamp(value) {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/u
    .exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText,
    fractionText = "0"] = match;
  const [year, month, day, hour, minute, second, milliseconds] = [
    Number(yearText), Number(monthText), Number(dayText), Number(hourText),
    Number(minuteText), Number(secondText), Number(fractionText.padEnd(3, "0")),
  ];
  if (year < 2000 || month < 1 || month > 12 || day < 1 || day > 31 ||
      hour > 23 || minute > 59 || second > 59) return false;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second, milliseconds));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day && date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute && date.getUTCSeconds() === second &&
    date.getUTCMilliseconds() === milliseconds;
}

export function validateReviewMembershipRepairIncident(proof) {
  const keys = [...Object.keys(reviewMembershipRepairIncident), "mutation", "outcome",
    "proof_digest"];
  const unsigned = { ...proof };
  delete unsigned.proof_digest;
  if (!proof || !same(sorted(Object.keys(proof)), sorted(keys)) ||
      proof.outcome !== "workers-builds-review-membership-repair-incident-valid" ||
      proof.mutation !== false)
    fail("review membership repair incident shape drift");
  if (!same(Object.fromEntries(Object.keys(reviewMembershipRepairIncident)
    .map((key) => [key, proof[key]])), { ...reviewMembershipRepairIncident }))
    fail("review membership repair incident coordinate drift");
  if (proof.proof_digest !== digestJson(unsigned))
    fail("review membership repair incident digest drift");
  return proof;
}

function validateReviewMembershipRepairPolicyProof(proof, { accountId, sourceSha,
  expectedUserPermissions, expectedTokenId = reviewMembershipRepairIncident.reviewTokenId,
  expectedKind = "review-membership-repair-predecessor",
  maximumAgeMs = 5 * 60_000 }, now = Date.now()) {
  const keys = ["accountId", "accountPermissions", "accountResources", "capturedAt", "kind",
    "modifiedOn", "ownerUserId", "source", "sourceSha", "tokenId", "userPermissions",
    "zonePermissions", "zoneResources"];
  const captured = Date.parse(proof?.capturedAt ?? "");
  const modified = Date.parse(proof?.modifiedOn ?? "");
  if (!proof || !same(sorted(Object.keys(proof)), sorted(keys)) ||
      proof.source !== "cloudflare-owner-token-policy-readback" ||
      proof.kind !== expectedKind || proof.accountId !== accountId ||
      proof.sourceSha !== sourceSha ||
      proof.tokenId !== expectedTokenId ||
      proof.ownerUserId !== reviewMembershipRepairIncident.ownerUserId ||
      !isUtcTimestamp(proof.capturedAt) || !isUtcTimestamp(proof.modifiedOn) ||
      !Number.isFinite(captured) || !Number.isFinite(modified) || modified > captured ||
      captured > now + 30_000 || now - captured > maximumAgeMs ||
      !same(sorted(proof.userPermissions ?? []), sorted(expectedUserPermissions)) ||
      !same(proof.accountPermissions, []) || !same(proof.accountResources, []) ||
      !same(proof.zonePermissions, []) || !same(proof.zoneResources, []))
    fail("review membership repair token policy drift");
  return proof;
}

export function issueReviewMembershipRepairAuthority({ production, review, accountId, sourceSha,
  incidentProof, predecessorPolicyProof, currentReviewActiveProof,
  permissionGroupProof, currentMainProofDigest }, now = Date.now()) {
  validateReviewMembershipRepairIncident(incidentProof);
  const repair = review?.automaticReview?.membershipReadRepair;
  if (!repair || repair.predecessorTokenId !== reviewMembershipRepairIncident.reviewTokenId ||
      repair.predecessorBuildTokenUuid !==
        reviewMembershipRepairIncident.reviewBuildTokenUuid ||
      repair.mode !== "fresh-user-token-before-wrapper-rotation" ||
      repair.userResource !== `com.cloudflare.api.user.${reviewMembershipRepairIncident.ownerUserId}` ||
      repair.accountOwnedTokenSupported !== false ||
      repair.wrapperMutation !== "delegated-to-journaled-review-token-rotation" ||
      repair.triggerMutation !== "delegated-to-journaled-review-token-rotation" ||
      repair.productionMutation !== false)
    fail("review membership repair contract drift");
  validateReviewMembershipRepairPolicyProof(predecessorPolicyProof, { accountId, sourceSha,
    expectedUserPermissions: repair.predecessorUserPermissions }, now);
  const permissionGroupKeys = ["capturedAt", "groups", "mutation", "outcome", "proof_digest",
    "source", "sourceSha"];
  const groupKeys = ["id", "name", "scope"];
  const permissionCaptured = Date.parse(permissionGroupProof?.capturedAt ?? "");
  const permissionUnsigned = { ...permissionGroupProof };
  delete permissionUnsigned.proof_digest;
  if (!permissionGroupProof ||
      !same(sorted(Object.keys(permissionGroupProof)), sorted(permissionGroupKeys)) ||
      permissionGroupProof.source !== "cloudflare-user-token-permission-groups-readback" ||
      permissionGroupProof.outcome !== "review-membership-permission-groups-valid" ||
      permissionGroupProof.mutation !== false || permissionGroupProof.sourceSha !== sourceSha ||
      !Number.isFinite(permissionCaptured) || permissionCaptured > now + 30_000 ||
      now - permissionCaptured > 5 * 60_000 ||
      !same(permissionGroupProof.groups?.map((group) => group.name).sort(),
        ["Memberships Read", "User Details Read"]) ||
      !permissionGroupProof.groups.every((group) =>
        same(sorted(Object.keys(group)), groupKeys) && /^[0-9a-f]{32}$/u.test(group.id) &&
        group.scope === "com.cloudflare.api.user") ||
      permissionGroupProof.proof_digest !== digestJson(permissionUnsigned))
    fail("review membership repair permission group proof drift");
  validateCurrentDisposableReviewSnapshotProof(currentReviewActiveProof,
    { accountId, sourceSha }, now);
  if (currentReviewActiveProof.liveIdentities.reviewBuildTokenUuid !==
      repair.predecessorBuildTokenUuid || !/^[0-9a-f]{64}$/u.test(currentMainProofDigest ?? ""))
    fail("review membership repair live identity drift");
  const capturedAt = new Date(now).toISOString();
  const unsigned = {
    outcome: "workers-builds-review-membership-repair-authority-valid", mutation: false,
    phase: "review-membership-read-policy-and-proof", accountId, sourceSha, capturedAt,
    expiresAt: new Date(now + reviewMembershipRepairAuthorityLifetimeMs).toISOString(),
    planDigest: digestJson(provisioningSetupPlan(production, review)),
    incidentDigest: incidentProof.proof_digest,
    predecessorPolicyDigest: digestJson(predecessorPolicyProof),
    currentReviewActiveProofDigest: currentReviewActiveProof.proof_digest,
    permissionGroupProofDigest: permissionGroupProof.proof_digest,
    currentMainProofDigest,
    predecessorTokenId: repair.predecessorTokenId,
    predecessorBuildTokenUuid: repair.predecessorBuildTokenUuid,
    replacementTokenName: "Atrinik metaserver review membership-readable",
    permissionGroupIds: Object.fromEntries(permissionGroupProof.groups.map(({ name, id }) =>
      [name, id])),
    predecessorUserPermissions: structuredClone(repair.predecessorUserPermissions),
    requiredUserPermissions: structuredClone(repair.requiredUserPermissions),
    userResource: repair.userResource,
    accountPermissions: [], accountResources: [], zonePermissions: [], zoneResources: [],
    allowedWrites: ["post-one-exact-membership-readable-user-token",
      "delete-only-journal-created-unwrapped-user-token-on-failure"],
    forbidden: ["account-owned-token", "build-token-wrapper-mutation", "trigger-mutation",
      "production-activation", "manual-api-build", "migration-0010", "worker-resource-mutation"],
  };
  return { ...unsigned, proof_digest: digestJson(unsigned) };
}

export function validateReviewMembershipRepairAuthority(proof, arguments_, now = Date.now(),
minimumRemainingMs = 5 * 60_000) {
  const captured = Date.parse(proof?.capturedAt ?? "");
  const expires = Date.parse(proof?.expiresAt ?? "");
  if (!Number.isFinite(captured) || !Number.isFinite(expires))
    fail("review membership repair authority is stale or malformed");
  const expected = issueReviewMembershipRepairAuthority(arguments_, captured);
  if (!same(proof, expected) || now >= expires ||
      expires - now < minimumRemainingMs)
    fail("review membership repair authority is stale or malformed");
  return proof;
}

export function validateReviewMembershipRepairResultProof(proof, { accountId, sourceSha,
  authorityProof, replacementTokenId }, now = Date.now()) {
  const authorityUnsigned = { ...authorityProof };
  delete authorityUnsigned.proof_digest;
  const authorityCaptured = Date.parse(authorityProof?.capturedAt ?? "");
  const authorityExpires = Date.parse(authorityProof?.expiresAt ?? "");
  if (authorityProof?.outcome !== "workers-builds-review-membership-repair-authority-valid" ||
      authorityProof.mutation !== false || authorityProof.accountId !== accountId ||
      authorityProof.sourceSha !== sourceSha || !Number.isFinite(authorityCaptured) ||
      !Number.isFinite(authorityExpires) || now >= authorityExpires ||
      authorityProof.proof_digest !== digestJson(authorityUnsigned) ||
      authorityProof.userResource !==
        `com.cloudflare.api.user.${reviewMembershipRepairIncident.ownerUserId}` ||
      !same(authorityProof.accountPermissions, []) ||
      !same(authorityProof.accountResources, []) ||
      !same(authorityProof.zonePermissions, []) || !same(authorityProof.zoneResources, []))
    fail("review membership repair result authority drift");
  if (!/^[0-9a-f]{32}$/u.test(replacementTokenId ?? "") ||
      replacementTokenId === authorityProof.predecessorTokenId)
    fail("review membership repair replacement token identity drift");
  const repairProof = validateReviewMembershipRepairPolicyProof(proof, { accountId, sourceSha,
    expectedUserPermissions: authorityProof.requiredUserPermissions,
    expectedTokenId: replacementTokenId, expectedKind: "review-replacement" }, now);
  if (Date.parse(repairProof.modifiedOn) <= authorityCaptured)
    fail("review membership repair did not modify the exact token after authority issuance");
  return repairProof;
}

export function validateReviewMembershipSuccessorRotationEvidence({
  incidentProof,
  membershipRepairAuthorityProof,
  membershipRepairAuthorityFileSha256,
  membershipRepairJournalRecords,
  membershipRepairJournalFileSha256,
  membershipRepairResultProof,
  membershipRepairResultProofFileSha256,
  membershipRepairSnapshotManifestFileSha256,
}, { accountId }) {
  validateReviewMembershipRepairIncident(incidentProof);
  const coordinate = reviewMembershipSuccessorRotationIncident;
  if (membershipRepairAuthorityFileSha256 !==
        coordinate.membershipRepairAuthorityFileSha256 ||
      membershipRepairJournalFileSha256 !== coordinate.membershipRepairJournalSha256 ||
      membershipRepairResultProofFileSha256 !==
        coordinate.membershipRepairResultProofFileSha256 ||
      membershipRepairSnapshotManifestFileSha256 !==
        coordinate.membershipRepairSnapshotManifestSha256 ||
      membershipRepairAuthorityProof?.proof_digest !==
        coordinate.membershipRepairAuthorityDigest)
    fail("review membership successor coordinate drift");
  if (digestText(`${JSON.stringify(membershipRepairAuthorityProof)}\n`) !==
        membershipRepairAuthorityFileSha256 ||
      digestText(`${membershipRepairJournalRecords.map((record) => JSON.stringify(record))
        .join("\n")}\n`) !== membershipRepairJournalFileSha256 ||
      digestText(`${JSON.stringify(membershipRepairResultProof)}\n`) !==
        membershipRepairResultProofFileSha256)
    fail("review membership successor evidence file binding drift");
  const authorityUnsigned = { ...membershipRepairAuthorityProof };
  delete authorityUnsigned.proof_digest;
  if (membershipRepairAuthorityProof?.sourceSha !== coordinate.sourceSha ||
      membershipRepairAuthorityProof.accountId !== accountId ||
      membershipRepairAuthorityProof.predecessorTokenId !==
        coordinate.predecessorReviewTokenId ||
      membershipRepairAuthorityProof.predecessorBuildTokenUuid !==
        coordinate.predecessorReviewBuildTokenUuid ||
      membershipRepairAuthorityProof.proof_digest !== digestJson(authorityUnsigned))
    fail("review membership successor authority drift");
  if (!Array.isArray(membershipRepairJournalRecords) ||
      membershipRepairJournalRecords.length !== 4 ||
      !same(membershipRepairJournalRecords.map(({ event, operation, outcome }) =>
        [event, operation ?? null, outcome ?? null]), [
        ["membership-repair-started", null, null],
        ["mutation-intent", "membership-repair-create-user-token", null],
        ["provider-response-classified", "membership-repair-create-user-token",
          "explicit-success"],
        ["membership-repair-complete", null, null],
      ]))
    fail("review membership successor journal sequence drift");
  let previousAt = -Infinity;
  for (const record of membershipRepairJournalRecords) {
    const { recordSha256, ...payload } = record ?? {};
    const at = Date.parse(record?.at ?? "");
    if (record.attempt !== 1 || !Number.isFinite(at) || at <= previousAt ||
        record.at !== new Date(at).toISOString() ||
        recordSha256 !== digestJson(payload))
      fail("review membership successor journal framing drift");
    previousAt = at;
  }
  const [started, intent, classified, terminal] = membershipRepairJournalRecords;
  const forbiddenKeys = ["build", "deployment", "migration0010", "trigger",
    "workerResource", "wrapper"];
  if (started.authorityProofDigest !== membershipRepairAuthorityProof.proof_digest ||
      intent.authorityProofDigest !== membershipRepairAuthorityProof.proof_digest ||
      intent.method !== "POST" || intent.path !== "/user/tokens" ||
      intent.requestDigest !== started.requestDigest ||
      classified.requestDigest !== intent.requestDigest || classified.status !== 200 ||
      classified.tokenId !== coordinate.replacementReviewTokenId ||
      terminal.tokenId !== coordinate.replacementReviewTokenId ||
      terminal.requestDigest !== intent.requestDigest ||
      terminal.resultProofDigest !== coordinate.membershipRepairResultProofDigest ||
      terminal.recordSha256 !== coordinate.membershipRepairTerminalRecordSha256 ||
      !same(sorted(Object.keys(terminal.forbiddenWrites ?? {})), forbiddenKeys) ||
      Object.values(terminal.forbiddenWrites).some((value) => value !== false))
    fail("review membership successor journal semantics drift");
  validateReviewMembershipRepairResultProof(membershipRepairResultProof,
    { accountId, sourceSha: coordinate.sourceSha,
      authorityProof: membershipRepairAuthorityProof,
      replacementTokenId: coordinate.replacementReviewTokenId },
    Date.parse(membershipRepairResultProof?.capturedAt ?? ""));
  if (digestJson(membershipRepairResultProof) !==
      coordinate.membershipRepairResultProofDigest ||
      membershipRepairResultProof.tokenId !== coordinate.replacementReviewTokenId ||
      membershipRepairResultProof.ownerUserId !== reviewMembershipRepairIncident.ownerUserId ||
      Date.parse(membershipRepairResultProof.capturedAt) < Date.parse(classified.at) ||
      Date.parse(membershipRepairResultProof.capturedAt) > Date.parse(terminal.at))
    fail("review membership successor result drift");
  const evidenceDigest = digestJson({
    coordinate,
    incidentProofDigest: incidentProof.proof_digest,
    membershipRepairAuthorityDigest: membershipRepairAuthorityProof.proof_digest,
    membershipRepairJournalFileSha256,
    membershipRepairResultProofDigest: digestJson(membershipRepairResultProof),
    membershipRepairSnapshotManifestFileSha256,
  });
  if (evidenceDigest !== reviewMembershipSuccessorEvidenceDigest)
    fail("review membership successor evidence digest drift");
  return {
    predecessorReviewBuildTokenUuid: coordinate.predecessorReviewBuildTokenUuid,
    predecessorReviewTokenId: coordinate.predecessorReviewTokenId,
    replacementReviewTokenId: coordinate.replacementReviewTokenId,
    evidenceSourceSha: coordinate.sourceSha,
    evidenceDigest,
  };
}

export function reviewTokenRotationLivePredecessorName(membershipSuccessorValidation) {
  if (membershipSuccessorValidation === undefined) return reviewBuildTokenNames.predecessor;
  const coordinate = reviewMembershipSuccessorRotationIncident;
  if (!same(membershipSuccessorValidation, {
    predecessorReviewBuildTokenUuid: coordinate.predecessorReviewBuildTokenUuid,
    predecessorReviewTokenId: coordinate.predecessorReviewTokenId,
    replacementReviewTokenId: coordinate.replacementReviewTokenId,
    evidenceSourceSha: coordinate.sourceSha,
    evidenceDigest: reviewMembershipSuccessorEvidenceDigest,
  })) fail("review membership successor live predecessor drift");
  return reviewBuildTokenNames.current;
}

function digestJson(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function digestText(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function validateReviewedSourceCoordinates({ expected, head, dirty, currentMain }) {
  if (!gitShaPattern.test(expected ?? "") || !gitShaPattern.test(head ?? "") ||
      !gitShaPattern.test(currentMain ?? "") || expected !== head || head !== currentMain ||
      dirty !== "")
    fail("reviewed source is not the exact clean current GitHub main checkout");
  return head;
}

export function validateCurrentMainProof(proof, sourceSha, now = Date.now()) {
  const keys = ["capturedAt", "endpoint", "raw", "ref", "repository", "sha", "source"];
  const rawKeys = ["node_id", "object", "ref", "url"];
  const objectKeys = ["sha", "type", "url"];
  const captured = Date.parse(proof?.capturedAt ?? "");
  const sha = proof?.sha;
  if (!proof || !same(sorted(Object.keys(proof)), keys) ||
      proof.source !== currentMainProofSource || proof.endpoint !== currentMainProofEndpoint ||
      !proof.repository ||
      !same(sorted(Object.keys(proof.repository)), sorted(Object.keys(currentMainRepository))) ||
      proof.repository.owner !== currentMainRepository.owner ||
      proof.repository.name !== currentMainRepository.name || proof.ref !== currentMainRef ||
      !gitShaPattern.test(sha ?? "") || sha !== sourceSha ||
      !isUtcTimestamp(proof.capturedAt) || !Number.isFinite(captured) ||
      captured > now + 30_000 || now - captured > 5 * 60_000 ||
      !proof.raw || !same(sorted(Object.keys(proof.raw)), rawKeys) ||
      proof.raw.ref !== currentMainRef ||
      typeof proof.raw.node_id !== "string" ||
      !/^[A-Za-z0-9_=-]{1,256}$/u.test(proof.raw.node_id) ||
      proof.raw.url !==
        "https://api.github.com/repos/atrinik/metaserver-worker/git/refs/heads/main" ||
      !proof.raw.object || !same(sorted(Object.keys(proof.raw.object)), objectKeys) ||
      proof.raw.object.sha !== sha || proof.raw.object.type !== "commit" ||
      proof.raw.object.url !==
        `https://api.github.com/repos/atrinik/metaserver-worker/git/commits/${sha}`)
    fail("authenticated GitHub current main proof is stale or malformed");
  return sha;
}

export async function readCurrentMainProof(environment, sourceSha, now = Date.now()) {
  const proof = await readPrivateJson(environment.ATRINIK_GITHUB_CURRENT_MAIN_PROOF_FILE,
    "authenticated GitHub current main proof");
  validateCurrentMainProof(proof, sourceSha, now);
  return proof;
}

async function reviewedSourceSha() {
  const expected = await readPrivateValue(process.env.ATRINIK_REVIEWED_SOURCE_SHA_FILE,
    "reviewed source SHA", gitShaPattern);
  const options = { cwd: root, encoding: "utf8", timeout: 10_000,
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" } };
  let head;
  let dirty;
  try {
    ({ stdout: head } = await execFileAsync("git", ["rev-parse", "HEAD"], options));
    ({ stdout: dirty } = await execFileAsync("git",
      ["status", "--porcelain=v1", "--untracked-files=all"], options));
  } catch { fail("reviewed source checkout proof failed"); }
  head = head.trim();
  return { expected, head, dirty };
}

async function reviewedCurrentMainSha(environment = process.env, now = Date.now()) {
  const coordinates = await reviewedSourceSha();
  const proof = await readCurrentMainProof(environment, coordinates.head, now);
  return validateReviewedSourceCoordinates({ ...coordinates,
    currentMain: proof.sha });
}

export function validateSnapshotManifest(manifest, { accountId, sourceSha, production, review },
  now = Date.now()) {
  const keys = ["accountId", "completedAt", "productionContractSha256",
    "reviewContractSha256", "sourceSha", "startedAt"];
  const started = Date.parse(manifest?.startedAt ?? "");
  const completed = Date.parse(manifest?.completedAt ?? "");
  if (!manifest || !same(sorted(Object.keys(manifest)), sorted(keys)) ||
      manifest.accountId !== accountId || manifest.sourceSha !== sourceSha ||
      manifest.productionContractSha256 !== digestJson(production) ||
      manifest.reviewContractSha256 !== digestJson(review) ||
      !Number.isFinite(started) || !Number.isFinite(completed) || started > completed ||
      completed > now + 30_000 || now - completed > 5 * 60_000 ||
      completed - started > 5 * 60_000)
    fail("provider snapshot manifest is stale or does not bind this reviewed source");
}

function normalizedRoot(value) {
  return value === "/" ? "" : value;
}

function isCurrentUserOwned(metadata) {
  return currentUid !== null && metadata.uid === currentUid;
}

function oneBinding(bindings, name, type) {
  const matches = bindings.filter((value) => value.name === name && value.type === type);
  if (matches.length !== 1) fail(`${type} binding ${name} is missing or ambiguous`);
  return matches[0];
}

function expectedBindingInventory(config) {
  return [
    ...Object.keys(config.vars ?? {}).map((name) => ({ name, type: "plain_text" })),
    ...(config.secrets?.required ?? []).map((name) => ({ name, type: "secret_text" })),
    ...(config.d1_databases ?? []).map(({ binding: name }) => ({ name, type: "d1" })),
    ...(config.r2_buckets ?? []).map(({ binding: name }) => ({ name, type: "r2_bucket" })),
    ...(config.analytics_engine_datasets ?? []).map(({ binding: name }) =>
      ({ name, type: "analytics_engine" })),
    ...(config.ratelimits ?? []).map(({ name }) => ({ name, type: "ratelimit" })),
    ...(config.durable_objects?.bindings ?? []).map(({ name }) =>
      ({ name, type: "durable_object_namespace" })),
    ...(config.services ?? []).map(({ binding: name }) => ({ name, type: "service" })),
  ].sort((left, right) => `${left.name}:${left.type}`.localeCompare(`${right.name}:${right.type}`));
}

export function initialBootstrapPredecessorConfiguration(contract, config, worker) {
  const predecessor = structuredClone(config);
  const policy = contract.initialBootstrapPredecessor;
  if (policy?.requiredPhase !== "all-builds-triggers-absent" ||
      !Array.isArray(policy.allowedBindingDelta))
    fail("initial production bootstrap predecessor is malformed");
  for (const delta of policy.allowedBindingDelta.filter(({ role }) => role === worker.role)) {
    if (!same(sorted(Object.keys(delta)), ["desired", "live", "name", "role", "type"]) ||
        delta.type !== "plain_text" || typeof delta.live !== "string" ||
        predecessor.vars?.[delta.name] !== delta.desired)
      fail("initial production bootstrap predecessor binding delta drift");
    if (delta.live === "absent") delete predecessor.vars[delta.name];
    else predecessor.vars[delta.name] = delta.live;
  }
  return predecessor;
}

function requireEnvelope(value, label) {
  if (!value || value.success !== true || !value.result)
    fail(`${label} provider readback failed`);
  return value.result;
}

function requireExhaustiveEnvelope(value, label) {
  const rows = requireEnvelope(value, label);
  const info = value.result_info ?? {};
  if (!Array.isArray(rows) || info.exhaustive !== true || info.page !== 1 ||
      info.total_pages !== 1 || info.total_count !== rows.length)
    fail(`${label} provider inventory is not proven exhaustive`);
  return rows;
}

export function validateSentinelRefAbsence(proof, now = Date.now()) {
  const { repository, branch, refs, capturedAt } = proof ?? {};
  if (!same(repository, githubRepository)) fail("sentinel repository identity drift");
  if (!stagingBranchPattern.test(branch ?? "")) fail("staging sentinel branch is malformed");
  if (!Array.isArray(refs) || refs.length !== 0)
    fail("staging sentinel branch exists or its absence is ambiguous");
  const captured = Date.parse(capturedAt ?? "");
  if (!Number.isFinite(captured) || captured > now + 30_000 || now - captured > 5 * 60_000)
    fail("staging sentinel branch absence proof is stale");
  return { outcome: "staging-sentinel-ref-absent", repository: "atrinik/metaserver-worker",
    branch };
}

export function validateDistinctSentinelRefAbsence(productionProof, reviewProof,
  now = Date.now()) {
  const production = validateSentinelRefAbsence(productionProof, now);
  const review = validateSentinelRefAbsence(reviewProof, now);
  if (production.branch === review.branch)
    fail("production and review staging sentinel branches must be distinct");
  return { production, review };
}

export function validateReviewStagingRootAbsence(proof, rootDirectory, sourceSha,
  expectedPhase, now = Date.now()) {
  const keys = ["absenceChecks", "branches", "capturedAt", "currentMainSha", "pagination",
    "phase", "repository", "rootDirectory", "source"];
  if (!reviewStagingRootPattern.test(rootDirectory ?? "") ||
      !proof || !same(sorted(Object.keys(proof)), sorted(keys)) ||
      proof.source !== "github-complete-branch-root-absence-readback" ||
      !["create", "activation"].includes(expectedPhase) || proof.phase !== expectedPhase ||
      !same(proof.repository, githubRepository) || proof.rootDirectory !== rootDirectory ||
      proof.currentMainSha !== sourceSha || !gitShaPattern.test(sourceSha ?? ""))
    fail("review staging root absence proof identity is malformed");
  const captured = Date.parse(proof.capturedAt ?? "");
  if (!Number.isFinite(captured) || captured > now + 30_000 || now - captured > 5 * 60_000)
    fail("review staging root absence proof is stale");
  if (!Array.isArray(proof.branches) || !Array.isArray(proof.absenceChecks) ||
      proof.branches.length < 1 || proof.branches.length > 200)
    fail("review staging root branch inventory is incomplete");
  if (!proof.pagination || !same(sorted(Object.keys(proof.pagination)),
    ["hasNextPage", "pageCount", "totalCount"]) ||
      proof.pagination.hasNextPage !== false ||
      !Number.isSafeInteger(proof.pagination.pageCount) || proof.pagination.pageCount < 1 ||
      proof.pagination.pageCount > 10 || proof.pagination.totalCount !== proof.branches.length)
    fail("review staging root branch pagination is incomplete");
  const branchKeys = ["ref", "sha"];
  const branches = proof.branches.map((entry) => {
    if (!entry || !same(sorted(Object.keys(entry)), branchKeys) ||
        !/^refs\/heads\/[A-Za-z0-9._/-]{1,200}$/u.test(entry.ref ?? "") ||
        !gitShaPattern.test(entry.sha ?? ""))
      fail("review staging root branch inventory is malformed");
    return entry;
  });
  if (new Set(branches.map(({ ref }) => ref)).size !== branches.length ||
      branches.filter(({ ref, sha }) => ref === "refs/heads/main" && sha === sourceSha).length !== 1)
    fail("review staging root branch inventory is incomplete");
  const nonMain = branches.filter(({ ref }) => ref !== "refs/heads/main");
  const expectedPath = rootDirectory.slice(1);
  const checks = proof.absenceChecks.map((entry) => {
    if (!entry || !same(sorted(Object.keys(entry)), ["path", "ref", "sha", "status"]) ||
        entry.path !== expectedPath || entry.status !== 404)
      fail("review staging root absence check is malformed");
    return entry;
  });
  if (!same(checks.map(({ ref, sha }) => ({ ref, sha })),
    nonMain.map(({ ref, sha }) => ({ ref, sha }))))
    fail("review staging root absence checks are incomplete or reordered");
  return { outcome: "review-staging-root-absent", mutation: false, phase: expectedPhase,
    rootDirectory, sourceSha, capturedAt: proof.capturedAt, proof_digest: digestJson(proof) };
}

export function validateReviewStagingRootProofSequence(create, activation) {
  if (create?.phase !== "create" || activation?.phase !== "activation" ||
      create.rootDirectory !== activation.rootDirectory || create.sourceSha !== activation.sourceSha ||
      Date.parse(activation.capturedAt ?? "") <= Date.parse(create.capturedAt ?? "") ||
      activation.proof_digest === create.proof_digest)
    fail("review staging root activation proof was replayed from create phase");
  return { outcome: "review-staging-root-proof-sequence-valid", mutation: false,
    createProofDigest: create.proof_digest, activationProofDigest: activation.proof_digest };
}

export function validateRepositoryConnectionOwnerProof(proof, accountId, sourceSha,
  now = Date.now()) {
  const expectedKeys = ["accountId", "capturedAt", "connectionPreexisting", "repository",
    "source", "websitePreserved", "githubApp", "mainProtection"];
  const expectedApp = { appId: 85455, installationId: 152311798,
    evidenceLocation: "atrinik/metaserver-worker#66-private-provider-evidence",
    repositorySelection: "selected", selectedRepositories: [
      { fullName: "atrinik/metaserver-worker", id: 1324297032 },
      { fullName: "atrinik/website", id: 1327107093 },
    ] };
  const expectedMain = { repository: "atrinik/metaserver-worker", defaultBranch: "main",
    sha: sourceSha, requiresPullRequest: true, allowsDeletion: false, allowsForcePush: false };
  if (!proof || !same(sorted(Object.keys(proof)), sorted(expectedKeys)) ||
      proof.source !== "cloudflare-owner-ui-readback" || proof.accountId !== accountId ||
      proof.connectionPreexisting !== true || proof.websitePreserved !== true ||
      !same(proof.repository, githubRepository) || !same(proof.githubApp, expectedApp) ||
      !same(proof.mainProtection, expectedMain))
    fail("shared repository connection owner proof drift");
  const captured = Date.parse(proof.capturedAt ?? "");
  if (!Number.isFinite(captured) || captured > now + 30_000 || now - captured > 5 * 60_000)
    fail("shared repository connection owner proof is stale");
}

function validateBuildUsageProof(review, buildUsageProof, accountId, now = Date.now()) {
  const usageKeys = ["accountId", "alertAtMinutes", "capturedAt", "disableAtMinutes",
    "monthlyMinutesUsed", "source"];
  const usageCaptured = Date.parse(buildUsageProof?.capturedAt ?? "");
  if (!buildUsageProof || !same(sorted(Object.keys(buildUsageProof)), sorted(usageKeys)) ||
      buildUsageProof.source !== "cloudflare-owner-build-usage-readback" ||
      buildUsageProof.accountId !== accountId ||
      buildUsageProof.alertAtMinutes !== review.automaticReview.costPolicy.alertAtMinutes ||
      buildUsageProof.disableAtMinutes !==
        review.automaticReview.costPolicy.maximumMonthlyReviewBuildMinutes ||
      !Number.isSafeInteger(buildUsageProof.monthlyMinutesUsed) ||
      buildUsageProof.monthlyMinutesUsed < 0 ||
      buildUsageProof.monthlyMinutesUsed >= buildUsageProof.alertAtMinutes ||
      !Number.isFinite(usageCaptured) || usageCaptured > now + 30_000 ||
      now - usageCaptured > 5 * 60_000)
    fail("Workers Builds private usage boundary is stale or exhausted");
  return buildUsageProof;
}

function reviewActivationEvidenceDigests({ stagedProof, repositoryConnectionProof,
  productionSentinelProof, tokenAuthorityProofs, buildUsageProof }) {
  return {
    stagedProofFile: digestJson(stagedProof),
    repositoryOwner: digestJson(repositoryConnectionProof),
    productionSentinel: digestJson(productionSentinelProof),
    tokenAuthority: Object.fromEntries(tokenAuthorityProofs.map((proof) =>
      [proof.kind, digestJson(proof)])),
    buildUsage: digestJson(buildUsageProof),
  };
}

function validateReviewActivationJournal(records, reviewActivationProof, predecessorSourceSha) {
  if (!Array.isArray(records) || records.length === 0) fail("review activation journal is absent");
  const expected = [
    ["attempt-started", "review-trigger-activation"],
    ["current-main-proof-bound", "fresh-staged-readback"],
    ["current-main-proof-bound", "fresh-staged-verify"],
    ["current-main-proof-bound", "fresh-staged-proof-verify"],
    ["current-main-proof-bound", "review-activation-authority-issue"],
    ["review-gate-preflight-proven", undefined],
    ["current-main-proof-bound", "review-root-create-validate"],
    ["github-proof-bound", "review-root-create"],
    ["review-gate-authorized", undefined],
    ["current-main-proof-bound", "before-review-trigger-create"],
    ["review-activation-authority-checked", "before-review-trigger-create"],
    ["mutation-intent", "review-trigger-create"],
    ["provider-response-classified", "review-trigger-create"],
    ["mutation-bound", "review-trigger-create"],
    ["current-main-proof-bound", "before-review-environment"],
    ["review-activation-authority-checked", "before-review-environment"],
    ["mutation-intent", "review-environment"],
    ["provider-response-classified", "review-environment"],
    ["mutation-bound", "review-environment"],
    ["current-main-proof-bound", "review-staged-environment-verify"],
    ["provider-proof-bound", "review-staged-environment"],
    ["current-main-proof-bound", "review-root-activation-validate"],
    ["github-proof-bound", "review-root-activation"],
    ["current-main-proof-bound", "before-review-trigger-activate"],
    ["review-activation-authority-checked", "before-review-trigger-activate"],
    ["mutation-intent", "review-trigger-activate"],
    ["provider-response-classified", "review-trigger-activate"],
    ["mutation-bound", "review-trigger-activate"],
    ["current-main-proof-bound", "review-activation-verify"],
    ["provider-proof-bound", "review-activation"],
    ["review-trigger-active", undefined],
  ];
  if (!same(records.map(({ event, operation }) => [event, operation]), expected))
    fail("review activation journal operation sequence drift");
  let previousAt = -Infinity;
  for (const record of records) {
    const { recordSha256, ...payload } = record ?? {};
    const at = Date.parse(record?.at ?? "");
    if (!/^[0-9a-f]{64}$/u.test(recordSha256 ?? "") || digestJson(payload) !== recordSha256 ||
        !Number.isFinite(at) || !isUtcTimestamp(record.at) || at <= previousAt ||
        record.attempt !== 1)
      fail("review activation journal checksum drift");
    previousAt = at;
  }
  const first = records[0];
  const terminal = records.at(-1);
  const proofBound = [...records].reverse().find(({ event, operation }) =>
    event === "provider-proof-bound" && operation === "review-activation");
  const preflight = records.find(({ event }) => event === "review-gate-preflight-proven");
  const mutation = (event, operation) => records.find((record) =>
    record.event === event && record.operation === operation);
  const reviewTriggerUuid = terminal.reviewTrigger;
  const mutationSemantics = [
    ["review-trigger-create", "POST", "/builds/triggers"],
    ["review-environment", "PATCH",
      `/builds/triggers/${reviewTriggerUuid}/environment_variables`],
    ["review-trigger-activate", "PATCH", `/builds/triggers/${reviewTriggerUuid}`],
  ];
  const mutationsValid = mutationSemantics.every(([operation, method, path]) => {
    const intent = mutation("mutation-intent", operation);
    const classification = mutation("provider-response-classified", operation);
    const bound = mutation("mutation-bound", operation);
    return intent?.method === method && intent.path === path &&
      /^[0-9a-f]{64}$/u.test(intent.requestDigestSha256 ?? "") &&
      classification?.outcome === "explicit-success" &&
      (operation !== "review-trigger-create" || classification.resourceUuid === reviewTriggerUuid) &&
      bound?.resourceUuid === reviewTriggerUuid && bound.providerResponseExplicitSuccess === true &&
      bound.requestDigestSha256 === intent.requestDigestSha256 &&
      /^[0-9a-f]{64}$/u.test(bound.readbackDigestSha256 ?? "");
  });
  const currentMainValid = records.filter(({ event }) => event === "current-main-proof-bound")
    .every(({ sourceSha, proofFileSha256, rawFileSha256 }) =>
      sourceSha === predecessorSourceSha && /^[0-9a-f]{64}$/u.test(proofFileSha256 ?? "") &&
      /^[0-9a-f]{64}$/u.test(rawFileSha256 ?? ""));
  const authorityDigest = preflight?.reviewActivationAuthorityDigest;
  const authorityChecksValid = /^[0-9a-f]{64}$/u.test(authorityDigest ?? "") &&
    records.filter(({ event }) => event === "review-activation-authority-checked")
      .every(({ proofDigest, expiresAt }) => proofDigest === authorityDigest &&
        isUtcTimestamp(expiresAt));
  if (first.event !== "attempt-started" || first.sourceSha !== predecessorSourceSha ||
      first.planDigestSha256 !== reviewActivationPredecessorPlanDigest ||
      terminal.event !== "review-trigger-active" ||
      !uuidPattern.test(terminal.reviewTrigger ?? "") ||
      terminal.reviewActivationProofDigest !== reviewActivationProof?.proof_digest ||
      terminal.productionActivation !== false || terminal.migration0010 !== false ||
      terminal.initialProductionBuild !== false ||
      records.some(({ event }) => event.startsWith("rollback")) ||
      proofBound?.proofDigest !== reviewActivationProof?.proof_digest ||
      proofBound?.proofFileSha256 !== digestJson(reviewActivationProof) ||
      Date.parse(reviewActivationProof?.capturedAt ?? "") > Date.parse(proofBound?.at ?? "") ||
      Date.parse(proofBound?.at ?? "") > Date.parse(terminal.at) ||
      preflight?.sourceSha !== predecessorSourceSha ||
      preflight?.planDigestSha256 !== reviewActivationPredecessorPlanDigest ||
      !mutationsValid || !currentMainValid || !authorityChecksValid)
    fail("review activation journal terminal provenance drift");
  return { digest: digestJson(records), reviewTriggerUuid: terminal.reviewTrigger,
    terminalAt: terminal.at, predecessorPlanDigest: first.planDigestSha256,
    predecessorSourceSha, preflight };
}

function validateInertSetupProvenance(records, setupResults, activationPreflight) {
  if (!Array.isArray(records) || records.length === 0 || !setupResults || !activationPreflight)
    fail("inert setup predecessor evidence is absent");
  const expected = [
    ["preflight-proven", "execution-preflight"], ["setup-authorized", undefined],
    ["mutation-intent", "repository-connection"],
    ["mutation-bound", "repository-connection"],
    ["mutation-intent", "production-build-token"],
    ["provider-response-classified", "production-build-token"],
    ["mutation-bound", "production-build-token"],
    ["mutation-intent", "review-build-token"],
    ["provider-response-classified", "review-build-token"],
    ["mutation-bound", "review-build-token"],
    ["sentinel-recheck", "sentinel-recheck-before-production-trigger"],
    ["mutation-intent", "production-trigger-staged"],
    ["provider-response-classified", "production-trigger-staged"],
    ["mutation-bound", "production-trigger-staged"],
    ["mutation-proof-bound", "production-trigger-staged"],
    ["sentinel-recheck", "sentinel-recheck-before-production-environment"],
    ["mutation-intent", "production-environment"],
    ["provider-response-classified", "production-environment"],
    ["mutation-bound", "production-environment"],
    ["mutation-proof-bound", "production-environment"],
    ["staged-readback-proven", "staged-readback"], ["inert-setup-complete", undefined],
  ];
  if (!same(records.map(({ event, operation }) => [event, operation]), expected) ||
      !same(sorted(Object.keys(setupResults)), sorted(["planDigest", "productionBuildToken",
        "productionTrigger", "repositoryConnection", "reviewBuildToken", "sourceSha",
        "stagedProofDigest"])))
    fail("inert setup predecessor operation sequence drift");
  let previousAt = -Infinity;
  for (const record of records) {
    const { recordSha256, ...payload } = record ?? {};
    const at = Date.parse(record?.at ?? "");
    if (!/^[0-9a-f]{64}$/u.test(recordSha256 ?? "") ||
        digestJson(payload) !== recordSha256 || !Number.isFinite(at) || at <= previousAt ||
        record.at !== new Date(at).toISOString() || record.attempt !== 1)
      fail("inert setup predecessor journal drift");
    previousAt = at;
  }
  const terminal = records.at(-1);
  const resource = (operation) => [...records].reverse().find(({ event, operation: value }) =>
    event === "mutation-bound" && value === operation)?.resourceUuid;
  const setupAuthorized = records.find(({ event }) => event === "setup-authorized");
  const setupMutationSemantics = [
    ["repository-connection", "PUT", "/builds/repos/connections"],
    ["production-build-token", "POST", "/builds/tokens"],
    ["review-build-token", "POST", "/builds/tokens"],
    ["production-trigger-staged", "POST", "/builds/triggers"],
    ["production-environment", "PATCH",
      `/builds/triggers/${setupResults.productionTrigger}/environment_variables`],
  ];
  const setupMutationsValid = setupMutationSemantics.every(([operation, method, path]) => {
    const intent = records.find((record) => record.event === "mutation-intent" &&
      record.operation === operation);
    const bound = records.find((record) => record.event === "mutation-bound" &&
      record.operation === operation);
    const classification = records.find((record) =>
      record.event === "provider-response-classified" && record.operation === operation);
    const expectedUuid = operation === "repository-connection" ? setupResults.repositoryConnection :
      operation === "production-build-token" ? setupResults.productionBuildToken :
        operation === "review-build-token" ? setupResults.reviewBuildToken :
          setupResults.productionTrigger;
    return intent?.method === method && intent.path === path &&
      /^[0-9a-f]{64}$/u.test(intent.requestDigestSha256 ?? "") &&
      bound?.resourceUuid === expectedUuid && bound.providerResponseExplicitSuccess === true &&
      bound.requestDigestSha256 === intent.requestDigestSha256 &&
      /^[0-9a-f]{64}$/u.test(bound.readbackDigestSha256 ?? "") &&
      (operation === "repository-connection" ||
        (classification?.outcome === "explicit-success" &&
          (operation === "production-environment" || classification.resourceUuid === expectedUuid)));
  });
  if (terminal.event !== "inert-setup-complete" || records.some(({ event }) =>
    event.startsWith("rollback")) || terminal.activation !== false ||
      terminal.migration0010 !== false || terminal.initialProductionBuild !== false ||
      setupResults.sourceSha !== "815076d3d69d358e3b265025d94a9151b9542b96" ||
      setupResults.planDigest !== "856f64dc2027a81ed5fcd7d85b687680e01c950400dbf8965ea40c076b09eb34" ||
      setupAuthorized?.sourceSha !== setupResults.sourceSha ||
      setupAuthorized?.planDigestSha256 !== setupResults.planDigest || !setupMutationsValid ||
      terminal.stagedProofDigest !== setupResults.stagedProofDigest ||
      resource("repository-connection") !== setupResults.repositoryConnection ||
      resource("production-build-token") !== setupResults.productionBuildToken ||
      resource("review-build-token") !== setupResults.reviewBuildToken ||
      resource("production-trigger-staged") !== setupResults.productionTrigger ||
      activationPreflight.setupJournalSha256 !== digestText(
        records.map((record) => JSON.stringify(record)).join("\n")) ||
      activationPreflight.setupResultsSha256 !== digestJson(setupResults))
    fail("inert setup predecessor terminal provenance drift");
  return { journalDigest: activationPreflight.setupJournalSha256,
    resultsDigest: activationPreflight.setupResultsSha256,
    productionTriggerUuid: setupResults.productionTrigger,
    productionBuildTokenUuid: setupResults.productionBuildToken,
    reviewBuildTokenUuid: setupResults.reviewBuildToken,
    repositoryConnectionUuid: setupResults.repositoryConnection,
    stagedProofDigest: setupResults.stagedProofDigest };
}

function validateDisposableReviewCoordinate(coordinate, sourceSha, now = Date.now()) {
  const keys = ["authorEmail", "authorName", "branch", "capturedAt", "commit",
    "commitMetadataSha256", "commitSubject", "contentSha256", "executorSha256", "journalId",
    "journalInitialRecordCount", "journalPath", "parentSha", "proofBlobSha", "proofMode",
    "proofPath", "pushReceiptPath", "deleteReceiptPath", "executorPath",
    "detachedRepositoryPath", "repository", "source", "sourceSha", "treeSha"];
  const captured = Date.parse(coordinate?.capturedAt ?? "");
  const expectedContentSha256 = digestText("issue-66 automatic review build proof\n");
  const expectedMetadataSha256 = digestJson(["test(deploy): verify issue 66 review build",
    "Atrinik Delivery", "delivery@atrinik.org", sourceSha]);
  if (!coordinate || !same(sorted(Object.keys(coordinate)), sorted(keys)) ||
      coordinate.source !== "journaled-disposable-review-coordinate" ||
      coordinate.repository !== "atrinik/metaserver-worker" || coordinate.sourceSha !== sourceSha ||
      !/^review\/issue-66-[a-z0-9-]{1,40}$/u.test(coordinate.branch ?? "") ||
      !gitShaPattern.test(coordinate.commit ?? "") || coordinate.commit === sourceSha ||
      coordinate.parentSha !== sourceSha || !gitShaPattern.test(coordinate.treeSha ?? "") ||
      !gitShaPattern.test(coordinate.proofBlobSha ?? "") ||
      coordinate.proofPath !== "deployment/review-check/.issue-66-build-proof" ||
      coordinate.proofMode !== "100644" || coordinate.contentSha256 !== expectedContentSha256 ||
      coordinate.commitSubject !== "test(deploy): verify issue 66 review build" ||
      coordinate.authorName !== "Atrinik Delivery" ||
      coordinate.authorEmail !== "delivery@atrinik.org" ||
      coordinate.commitMetadataSha256 !== expectedMetadataSha256 ||
      !/^[0-9a-f]{64}$/u.test(coordinate.executorSha256 ?? "") ||
      !/^[0-9a-f]{64}$/u.test(coordinate.journalId ?? "") ||
      coordinate.journalInitialRecordCount !== 0 ||
      ![coordinate.journalPath, coordinate.executorPath, coordinate.detachedRepositoryPath,
        coordinate.pushReceiptPath, coordinate.deleteReceiptPath].every((path) =>
        isAbsolute(path ?? "") && resolve(path) === path) ||
      dirname(coordinate.journalPath) !== dirname(coordinate.executorPath) ||
      coordinate.pushReceiptPath !== resolve(dirname(coordinate.journalPath),
        "push-authorization-receipt.json") ||
      coordinate.deleteReceiptPath !== resolve(dirname(coordinate.journalPath),
        "delete-authorization-receipt.json") ||
      !isUtcTimestamp(coordinate.capturedAt) || !Number.isFinite(captured) ||
      captured > now + 30_000 || now - captured > 5 * 60_000)
    fail("disposable review coordinate proof is stale or malformed");
  return coordinate;
}

export async function validateDisposableCoordinatePreparation(coordinate) {
  const canonicalDirectory = async (path, label) => {
    const metadata = await lstat(path).catch(() => null);
    if (await realpath(path).catch(() => null) !== path || !metadata?.isDirectory() ||
        !isCurrentUserOwned(metadata) || (metadata.mode & 0o077) !== 0)
      fail(`${label} must be an owner-only canonical directory`);
  };
  const privateBytes = async (path, label) => {
    if (await realpath(path).catch(() => null) !== path)
      fail(`${label} must be canonical without linked ancestors`);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
    if (!handle) fail(`${label} cannot be opened without following links`);
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || !isCurrentUserOwned(metadata) || (metadata.mode & 0o077) !== 0 ||
          metadata.size > maximumPrivateDocumentBytes)
        fail(`${label} must be a bounded owner-only regular file`);
      return await handle.readFile();
    } finally { await handle.close(); }
  };
  await canonicalDirectory(coordinate.detachedRepositoryPath,
    "disposable detached repository");
  await canonicalDirectory(dirname(coordinate.journalPath), "disposable evidence directory");
  const gitDirectory = resolve(coordinate.detachedRepositoryPath, ".git");
  await canonicalDirectory(gitDirectory, "disposable repository Git metadata");
  if (await lstat(resolve(gitDirectory, "commondir")).catch(() => null) ||
      await lstat(resolve(gitDirectory, "gitdir")).catch(() => null) ||
      await lstat(resolve(gitDirectory, "info/grafts")).catch(() => null) ||
      await lstat(resolve(gitDirectory, "shallow")).catch(() => null))
    fail("disposable repository uses forbidden shared, graft, or shallow Git metadata");
  const executor = await privateBytes(coordinate.executorPath, "disposable executor");
  const journal = await privateBytes(coordinate.journalPath, "disposable initial journal");
  if (digestText(executor) !== coordinate.executorSha256 || journal.length !== 0 ||
      coordinate.journalId !== digestText(
        `disposable-journal:${coordinate.journalPath}:${coordinate.executorSha256}`))
    fail("disposable executor or empty journal identity drift");
  const git = async (args) => (await execFileAsync("git", args, {
    cwd: coordinate.detachedRepositoryPath, encoding: "utf8", timeout: 10_000,
    maxBuffer: maximumPrivateDocumentBytes,
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
      GIT_NO_REPLACE_OBJECTS: "1" },
  })).stdout;
  const [head, parent, status, diff, treeRow, content, metadata, treeSha] = await Promise.all([
    git(["rev-parse", "HEAD"]), git(["rev-parse", "HEAD^"]),
    git(["status", "--porcelain=v1", "--untracked-files=all"]),
    git(["diff-tree", "--no-commit-id", "--name-status", "-r", "HEAD"]),
    git(["ls-tree", "HEAD", coordinate.proofPath]),
    git(["show", `HEAD:${coordinate.proofPath}`]),
    git(["show", "-s", "--format=%s%n%an%n%ae%n%P", "HEAD"]),
    git(["rev-parse", "HEAD^{tree}"]),
  ]).catch(() => fail("disposable Git object proof cannot be read"));
  const treeMatch = new RegExp(`^100644 blob ([0-9a-f]{40})\\t${coordinate.proofPath.replace(
    /[.*+?^${}()|[\]\\]/gu, "\\$&")}\\n$`, "u").exec(treeRow);
  const metadataRows = metadata.trim().split("\n");
  if (head.trim() !== coordinate.commit || parent.trim() !== coordinate.parentSha || status !== "" ||
      diff !== `A\t${coordinate.proofPath}\n` || !treeMatch ||
      treeMatch[1] !== coordinate.proofBlobSha || treeSha.trim() !== coordinate.treeSha ||
      digestText(content) !== coordinate.contentSha256 ||
      digestJson(metadataRows) !== coordinate.commitMetadataSha256)
    fail("disposable Git object proof drift");
  return coordinate;
}

export function validateBlockedDeleteRecoveryCoordinate(coordinate, sourceSha,
now = Date.now()) {
  const keys = ["authorizationReceiptPath", "capturedAt", "executorPath", "executorSha256",
    "journalId", "journalInitialRecordCount", "journalPath", "source", "sourceSha"];
  const captured = Date.parse(coordinate?.capturedAt ?? "");
  if (!coordinate || !same(sorted(Object.keys(coordinate)), sorted(keys)) ||
      coordinate.source !== "journaled-blocked-review-token-delete-recovery-coordinate" ||
      coordinate.sourceSha !== sourceSha ||
      !/^[0-9a-f]{64}$/u.test(coordinate.executorSha256 ?? "") ||
      !/^[0-9a-f]{64}$/u.test(coordinate.journalId ?? "") ||
      coordinate.journalInitialRecordCount !== 0 ||
      ![coordinate.executorPath, coordinate.journalPath, coordinate.authorizationReceiptPath]
        .every((path) => isAbsolute(path ?? "") && resolve(path) === path) ||
      dirname(coordinate.executorPath) !== dirname(coordinate.journalPath) ||
      coordinate.authorizationReceiptPath !== resolve(dirname(coordinate.journalPath),
        "delete-authorization-receipt.json") ||
      coordinate.journalId !== digestText(
        `blocked-delete-journal:${coordinate.journalPath}:${coordinate.executorSha256}`) ||
      !isUtcTimestamp(coordinate.capturedAt) || !Number.isFinite(captured) ||
      captured > now + 30_000 || now - captured > 5 * 60_000)
    fail("blocked delete recovery coordinate is stale or malformed");
  return coordinate;
}

export async function validateBlockedDeleteRecoveryCoordinatePreparation(coordinate,
sourceSha, now = Date.now()) {
  validateBlockedDeleteRecoveryCoordinate(coordinate, sourceSha, now);
  const directory = dirname(coordinate.journalPath);
  const directoryMetadata = await lstat(directory).catch(() => null);
  if (await realpath(directory).catch(() => null) !== directory ||
      !directoryMetadata?.isDirectory() || !isCurrentUserOwned(directoryMetadata) ||
      (directoryMetadata.mode & 0o077) !== 0)
    fail("blocked delete recovery directory must be owner-only and canonical");
  const readPrivateBytes = async (path, label) => {
    if (await realpath(path).catch(() => null) !== path)
      fail(`${label} must be canonical without linked ancestors`);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
    if (!handle) fail(`${label} cannot be opened without following links`);
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || !isCurrentUserOwned(metadata) ||
          (metadata.mode & 0o077) !== 0 || metadata.size > maximumPrivateDocumentBytes)
        fail(`${label} must be a bounded owner-only regular file`);
      return await handle.readFile();
    } finally { await handle.close(); }
  };
  const executor = await readPrivateBytes(coordinate.executorPath,
    "blocked delete recovery executor");
  const journal = await readPrivateBytes(coordinate.journalPath,
    "blocked delete recovery initial journal");
  if (digestText(executor) !== coordinate.executorSha256 || journal.length !== 0 ||
      await lstat(coordinate.authorizationReceiptPath).catch(() => null))
    fail("blocked delete recovery executor, journal, or receipt state drift");
  return coordinate;
}

function disposableReviewEvidenceDigests({ reviewActivationProof, reviewActivationJournal,
  inertSetupJournal, inertSetupResults, disposableCoordinate,
  reviewTokenRotationProof, reviewTokenRotationJournal, reviewTokenRotationAuthorityProof,
  reviewTokenRotationPreCreateProof, reviewTokenRotationPreProductionProof,
  reviewTokenRotationIntermediateProof, reviewTokenRotationUnreferencedProof,
  rotationAttemptCoordinate,
  replacementTokenOwnerMembershipProof, currentReplacementTokenOwnerMembershipProof,
  currentReviewActiveProof,
  repositoryConnectionProof, productionSentinelProof, tokenAuthorityProofs, buildUsageProof }) {
  return {
    reviewActivationProofFile: digestJson(reviewActivationProof),
    reviewActivationJournal: digestJson(reviewActivationJournal),
    inertSetupJournal: digestJson(inertSetupJournal),
    inertSetupResults: digestJson(inertSetupResults),
    disposableCoordinate: digestJson(disposableCoordinate),
    reviewTokenRotationProof: digestJson(reviewTokenRotationProof),
    reviewTokenRotationJournal: digestJson(reviewTokenRotationJournal),
    reviewTokenRotationAuthorityProof: digestJson(reviewTokenRotationAuthorityProof),
    reviewTokenRotationPreCreateProof: digestJson(reviewTokenRotationPreCreateProof),
    reviewTokenRotationPreProductionProof: digestJson(reviewTokenRotationPreProductionProof),
    reviewTokenRotationIntermediateProof: digestJson(reviewTokenRotationIntermediateProof),
    reviewTokenRotationUnreferencedProof: digestJson(reviewTokenRotationUnreferencedProof),
    rotationAttemptCoordinate: digestJson(rotationAttemptCoordinate),
    replacementTokenOwnerMembership: digestJson(replacementTokenOwnerMembershipProof),
    currentReplacementTokenOwnerMembership:
      digestJson(currentReplacementTokenOwnerMembershipProof),
    currentReviewActiveProofFile: digestJson(currentReviewActiveProof),
    repositoryOwner: digestJson(repositoryConnectionProof),
    productionSentinel: digestJson(productionSentinelProof),
    tokenAuthority: Object.fromEntries(tokenAuthorityProofs.map((proof) =>
      [proof.kind, digestJson(proof)])),
    buildUsage: digestJson(buildUsageProof),
  };
}

const stagedSnapshotProofKeys = ["accountId", "capturedAt", "mutation", "outcome",
  "proof_digest", "snapshotCompletedAt", "snapshotStartedAt", "sourceSha", "state_digest",
  "stagedTriggerCount"];

function validateStagedSnapshotProofEvidence(proof, { accountId, sourceSha },
  now = Date.now(), maximumAgeMs = 5 * 60_000) {
  const captured = Date.parse(proof?.capturedAt ?? "");
  const started = Date.parse(proof?.snapshotStartedAt ?? "");
  const completed = Date.parse(proof?.snapshotCompletedAt ?? "");
  if (!proof || !same(sorted(Object.keys(proof)), sorted(stagedSnapshotProofKeys)) ||
      proof.outcome !== "workers-builds-staged-snapshot-valid" || proof.mutation !== false ||
      proof.accountId !== accountId || proof.sourceSha !== sourceSha ||
      proof.stagedTriggerCount !== 1 || !/^[0-9a-f]{64}$/u.test(proof.proof_digest ?? "") ||
      !/^[0-9a-f]{64}$/u.test(proof.state_digest ?? "") ||
      !isUtcTimestamp(proof.capturedAt) || !isUtcTimestamp(proof.snapshotStartedAt) ||
      !isUtcTimestamp(proof.snapshotCompletedAt) || !Number.isFinite(captured) ||
      !Number.isFinite(started) || !Number.isFinite(completed) || started > completed ||
      completed > captured || captured - completed > 5 * 60_000 ||
      completed - started > 5 * 60_000 || captured > now + 30_000 ||
      now - captured > maximumAgeMs || proof.proof_digest !== digestJson({
        state_digest: proof.state_digest, snapshotStartedAt: proof.snapshotStartedAt,
        snapshotCompletedAt: proof.snapshotCompletedAt, capturedAt: proof.capturedAt,
      }))
    fail("review activation authority staged proof drift");
  return { captured, started, completed };
}

function validateReviewActiveSnapshotProofEvidence(proof, { accountId, sourceSha },
  now = Date.now(), maximumAgeMs = 5 * 60_000) {
  const expected = { ...proof, outcome: "workers-builds-staged-snapshot-valid",
    stagedTriggerCount: 1 };
  validateStagedSnapshotProofEvidence(expected, { accountId, sourceSha }, now, maximumAgeMs);
  if (proof?.outcome !== "workers-builds-review-activation-snapshot-valid" ||
      proof?.stagedTriggerCount !== 2)
    fail("disposable review authority live proof drift");
  return proof;
}

function validateCurrentDisposableReviewSnapshotProof(proof, { accountId, sourceSha },
  now = Date.now()) {
  const identityKeys = ["productionBuildTokenUuid", "productionEnvironmentDigest",
    "productionTriggerUuid", "repositoryConnectionUuid", "reviewBuildTokenUuid",
    "reviewEnvironmentDigest", "reviewTriggerUuid"];
  const expectedKeys = [...stagedSnapshotProofKeys, "liveIdentities"];
  if (!proof || !same(sorted(Object.keys(proof)), sorted(expectedKeys)) ||
      !proof.liveIdentities ||
      !same(sorted(Object.keys(proof.liveIdentities)), sorted(identityKeys)) ||
      !Object.entries(proof.liveIdentities).every(([key, value]) =>
        key.endsWith("Digest") ? /^[0-9a-f]{64}$/u.test(value) : uuidPattern.test(value)) ||
      proof.liveIdentities.productionTriggerUuid === proof.liveIdentities.reviewTriggerUuid ||
      proof.liveIdentities.productionBuildTokenUuid === proof.liveIdentities.reviewBuildTokenUuid)
    fail("disposable review authority live identity proof drift");
  const withoutIdentities = { ...proof };
  delete withoutIdentities.liveIdentities;
  withoutIdentities.proof_digest = digestJson({ state_digest: proof.state_digest,
    snapshotStartedAt: proof.snapshotStartedAt,
    snapshotCompletedAt: proof.snapshotCompletedAt, capturedAt: proof.capturedAt });
  validateReviewActiveSnapshotProofEvidence(withoutIdentities, { accountId, sourceSha }, now,
    30_000);
  if (proof.proof_digest !== digestJson({ state_digest: proof.state_digest,
    snapshotStartedAt: proof.snapshotStartedAt, snapshotCompletedAt: proof.snapshotCompletedAt,
    capturedAt: proof.capturedAt, liveIdentities: proof.liveIdentities }))
    fail("disposable review authority live identity proof drift");
  return proof;
}

export function validateReviewTokenRotationRetryProgramProof(proof, sourceSha,
programLedgerDocument, programLedgerFileSha256, now = Date.now()) {
  const keys = ["capturedAt", "historicalTerminals", "leafIssueNodeId", "leafIssueNumber",
    "masterIssueNodeId", "masterIssueNumber", "mutation", "outcome", "programLedgerCoordinate",
    "programLedgerFileSha256", "programLedgerGeneration", "programLedgerSha256",
    "proof_digest", "sourceSha"];
  const historicalKeys = ["blockedDeleteRecoveryJournalSha256",
    "blockedDeleteRecoveryProofDigest", "blockedDeleteRecoveryTerminalRecordSha256",
    "noOwnedSuccessorJournalSha256", "noOwnedSuccessorProofDigest",
    "noOwnedSuccessorSnapshotManifestSha256", "noOwnedSuccessorSourceSha",
    "noOwnedSuccessorTerminalRecordSha256",
    "providerNormalizedForwardJournalSha256", "providerNormalizedRollbackJournalSha256"];
  const captured = Date.parse(proof?.capturedAt ?? "");
  const unsigned = { ...proof };
  delete unsigned.proof_digest;
  if (!proof || !same(sorted(Object.keys(proof)), sorted(keys)) ||
      !same(sorted(Object.keys(proof.historicalTerminals ?? {})), sorted(historicalKeys)) ||
      proof.outcome !== "workers-builds-review-token-rotation-program-proof-valid" ||
      proof.mutation !== false || proof.sourceSha !== sourceSha ||
      proof.masterIssueNumber !== reviewTokenRotationRetryProgram.masterIssueNumber ||
      proof.masterIssueNodeId !== reviewTokenRotationRetryProgram.masterIssueNodeId ||
      proof.leafIssueNumber !== reviewTokenRotationRetryProgram.leafIssueNumber ||
      proof.leafIssueNodeId !== reviewTokenRotationRetryProgram.leafIssueNodeId ||
      proof.programLedgerCoordinate !== reviewTokenRotationRetryProgram.ledgerCoordinate ||
      !Number.isInteger(proof.programLedgerGeneration) || proof.programLedgerGeneration < 1 ||
      proof.programLedgerSha256 !== digestJson(programLedgerDocument) ||
      proof.programLedgerFileSha256 !== programLedgerFileSha256 ||
      !/^[0-9a-f]{64}$/u.test(programLedgerFileSha256 ?? "") ||
      programLedgerDocument?.schema_version !== 1 ||
      programLedgerDocument?.generation !== proof.programLedgerGeneration ||
      programLedgerDocument?.ledger_id !==
        `delivery-v1:issue:${reviewTokenRotationRetryProgram.leafIssueNodeId}` ||
      programLedgerDocument?.program?.master_issue?.number !==
        reviewTokenRotationRetryProgram.masterIssueNumber ||
      programLedgerDocument?.program?.master_issue?.node_id !==
        reviewTokenRotationRetryProgram.masterIssueNodeId ||
      programLedgerDocument?.program?.leaf_issue?.number !==
        reviewTokenRotationRetryProgram.leafIssueNumber ||
      programLedgerDocument?.program?.leaf_issue?.node_id !==
        reviewTokenRotationRetryProgram.leafIssueNodeId ||
      !same(programLedgerDocument?.authority?.allowed?.issues,
        [reviewTokenRotationRetryProgram.masterIssueNodeId,
          reviewTokenRotationRetryProgram.leafIssueNodeId]) ||
      !same(proof.historicalTerminals, {
        providerNormalizedForwardJournalSha256:
          reviewTokenRotationRetryProgram.providerNormalizedForwardJournalSha256,
        providerNormalizedRollbackJournalSha256:
          reviewTokenRotationRetryProgram.providerNormalizedRollbackJournalSha256,
        blockedDeleteRecoveryJournalSha256:
          reviewTokenRotationRetryProgram.blockedDeleteRecoveryJournalSha256,
        blockedDeleteRecoveryTerminalRecordSha256:
          reviewTokenRotationRetryProgram.blockedDeleteRecoveryTerminalRecordSha256,
        blockedDeleteRecoveryProofDigest:
          reviewTokenRotationRetryProgram.blockedDeleteRecoveryProofDigest,
        noOwnedSuccessorSourceSha:
          reviewTokenRotationRetryProgram.noOwnedSuccessorSourceSha,
        noOwnedSuccessorJournalSha256:
          reviewTokenRotationRetryProgram.noOwnedSuccessorJournalSha256,
        noOwnedSuccessorTerminalRecordSha256:
          reviewTokenRotationRetryProgram.noOwnedSuccessorTerminalRecordSha256,
        noOwnedSuccessorProofDigest:
          reviewTokenRotationRetryProgram.noOwnedSuccessorProofDigest,
        noOwnedSuccessorSnapshotManifestSha256:
          reviewTokenRotationRetryProgram.noOwnedSuccessorSnapshotManifestSha256,
      }) || !isUtcTimestamp(proof.capturedAt) || !Number.isFinite(captured) ||
      captured > now + 30_000 || now - captured > 5 * 60_000 ||
      proof.proof_digest !== digestJson(unsigned))
    fail("review token rotation retry program proof drift");
  return proof;
}

export function validateReviewTokenRotationAttemptCoordinate(coordinate, sourceSha,
attemptFilesystemEvidence, now = Date.now()) {
  const keys = ["attemptNamespace", "capturedAt", "executorSha256", "journalId",
    "initialJournalSha256", "journalPathSha256", "mutation", "proof_digest", "repository",
    "sourceSha"];
  const captured = Date.parse(coordinate?.capturedAt ?? "");
  const unsigned = { ...coordinate };
  delete unsigned.proof_digest;
  if (!coordinate || !same(sorted(Object.keys(coordinate)), sorted(keys)) ||
      coordinate.repository !== "atrinik/metaserver-worker" || coordinate.sourceSha !== sourceSha ||
      coordinate.mutation !== false ||
      !/^review-token-rotation-118-[0-9a-f]{16,64}$/u.test(coordinate.attemptNamespace ?? "") ||
      ![coordinate.executorSha256, coordinate.initialJournalSha256, coordinate.journalId,
        coordinate.journalPathSha256]
        .every((value) => /^[0-9a-f]{64}$/u.test(value ?? "")) ||
      coordinate.initialJournalSha256 !== digestText("") ||
      coordinate.executorSha256 !== attemptFilesystemEvidence?.executorSha256 ||
      coordinate.initialJournalSha256 !== attemptFilesystemEvidence?.initialJournalSha256 ||
      coordinate.journalPathSha256 !== attemptFilesystemEvidence?.journalPathSha256 ||
      coordinate.journalId !== digestJson({
        attemptNamespace: coordinate.attemptNamespace,
        executorSha256: coordinate.executorSha256,
        journalPathSha256: coordinate.journalPathSha256,
      }) ||
      !isUtcTimestamp(coordinate.capturedAt) || !Number.isFinite(captured) ||
      captured > now + 30_000 || now - captured > 5 * 60_000 ||
      coordinate.proof_digest !== digestJson(unsigned))
    fail("review token rotation attempt coordinate drift");
  return coordinate;
}

function reviewTokenRotationEvidenceDigests({ reviewActivationProof, reviewActivationJournal,
  inertSetupJournal, inertSetupResults, currentReviewActiveProof, repositoryConnectionProof,
  productionSentinelProof, predecessorTokenAuthorityProofs,
  replacementTokenAuthorityProof, replacementTokenOwnerMembershipProof, buildUsageProof,
  productionBaselineProof, programDeliveryProof, rotationAttemptCoordinate,
  membershipSuccessorValidation = undefined }) {
  return {
    reviewActivationProof: digestJson(reviewActivationProof),
    reviewActivationJournal: digestJson(reviewActivationJournal),
    inertSetupJournal: digestJson(inertSetupJournal),
    inertSetupResults: digestJson(inertSetupResults),
    currentReviewActiveProof: digestJson(currentReviewActiveProof),
    repositoryOwner: digestJson(repositoryConnectionProof),
    productionSentinel: digestJson(productionSentinelProof),
    predecessorTokenAuthority: Object.fromEntries(predecessorTokenAuthorityProofs.map((proof) =>
      [proof.kind, digestJson(proof)])),
    replacementTokenAuthority: digestJson(replacementTokenAuthorityProof),
    replacementTokenOwnerMembership: digestJson(replacementTokenOwnerMembershipProof),
    buildUsage: digestJson(buildUsageProof),
    productionBaseline: digestJson(productionBaselineProof),
    programDelivery: digestJson(programDeliveryProof),
    rotationAttempt: digestJson(rotationAttemptCoordinate),
    ...(membershipSuccessorValidation ? {
      membershipSuccessor: membershipSuccessorValidation.evidenceDigest,
    } : {}),
  };
}

export function validateReviewTokenRotationProductionBaselineProof(proof, {
  accountId, sourceSha, currentReviewActiveProof,
}, now = Date.now()) {
  const keys = ["accountId", "capturedAt", "currentReviewActiveProofDigest",
    "productionPreservationDigest", "productionScriptTag", "proof_digest", "source",
    "sourceSha"];
  const captured = Date.parse(proof?.capturedAt ?? "");
  const unsigned = { ...proof };
  delete unsigned.proof_digest;
  if (!proof || !same(sorted(Object.keys(proof)), sorted(keys)) ||
      proof.source !== "workers-builds-review-token-rotation-production-baseline" ||
      proof.accountId !== accountId || proof.sourceSha !== sourceSha ||
      proof.currentReviewActiveProofDigest !== currentReviewActiveProof?.proof_digest ||
      !scriptTagPattern.test(proof.productionScriptTag ?? "") ||
      !/^[0-9a-f]{64}$/u.test(proof.productionPreservationDigest ?? "") ||
      !isUtcTimestamp(proof.capturedAt) || !Number.isFinite(captured) ||
      captured > now + 30_000 || now - captured > 5 * 60_000 ||
      proof.proof_digest !== digestJson(unsigned))
    fail("review token rotation production baseline proof drift");
  return proof;
}

export function issueReviewTokenRotationAuthority({ production, review, accountId, sourceSha,
  reviewActivationProof, reviewActivationJournal, inertSetupJournal, inertSetupResults,
  currentReviewActiveProof, repositoryConnectionProof, productionSentinelProof,
  predecessorTokenAuthorityProofs, replacementTokenAuthorityProof, replacementTokenId,
  replacementTokenOwnerMembershipProof, buildUsageProof, tokenRows,
  productionBaselineProof,
  programDeliveryProof, programLedgerDocument, programLedgerFileSha256,
  rotationAttemptCoordinate, attemptFilesystemEvidence,
  replacementTokenSecretSha256,
  membershipSuccessorEvidence = undefined }, now = Date.now()) {
  const membershipSuccessorValidation = membershipSuccessorEvidence ?
    validateReviewMembershipSuccessorRotationEvidence(membershipSuccessorEvidence,
      { accountId }) : undefined;
  validateRepositoryConnectionOwnerProof(repositoryConnectionProof, accountId, sourceSha, now);
  const sentinel = validateSentinelRefAbsence(productionSentinelProof, now);
  validateTokenAuthorityProofs({ production, review, accountId,
    proofs: predecessorTokenAuthorityProofs, tokenRows, sourceSha }, now);
  validateReplacementReviewTokenAuthorityProof({ review, accountId,
    proof: replacementTokenAuthorityProof, tokenId: replacementTokenId, sourceSha }, now);
  validateReplacementTokenOwnerMembershipProof({ accountId, sourceSha,
    proof: replacementTokenOwnerMembershipProof,
    ownerUserId: replacementTokenAuthorityProof.ownerUserId }, now);
  validateBuildUsageProof(review, buildUsageProof, accountId, now);
  validateReviewTokenRotationRetryProgramProof(programDeliveryProof, sourceSha,
    programLedgerDocument, programLedgerFileSha256, now);
  validateReviewTokenRotationAttemptCoordinate(rotationAttemptCoordinate, sourceSha,
    attemptFilesystemEvidence, now);
  const predecessorSourceSha = reviewActivationProof?.sourceSha;
  if (!gitShaPattern.test(predecessorSourceSha ?? ""))
    fail("review token rotation predecessor source drift");
  validateReviewActiveSnapshotProofEvidence(reviewActivationProof,
    { accountId, sourceSha: predecessorSourceSha },
    Date.parse(reviewActivationProof?.capturedAt ?? ""), 0);
  const journal = validateReviewActivationJournal(reviewActivationJournal,
    reviewActivationProof, predecessorSourceSha);
  const setup = validateInertSetupProvenance(inertSetupJournal, inertSetupResults,
    journal.preflight);
  validateCurrentDisposableReviewSnapshotProof(currentReviewActiveProof,
    { accountId, sourceSha }, now);
  const baseline = validateReviewTokenRotationProductionBaselineProof(
    productionBaselineProof, { accountId, sourceSha, currentReviewActiveProof }, now);
  if (Date.parse(currentReviewActiveProof.snapshotStartedAt) < Date.parse(journal.terminalAt))
    fail("review token rotation observations overlap");
  const identities = currentReviewActiveProof.liveIdentities;
  const membershipSuccessorRequired =
    identities.reviewBuildTokenUuid ===
      reviewMembershipSuccessorRotationIncident.predecessorReviewBuildTokenUuid ||
    replacementTokenId === reviewMembershipSuccessorRotationIncident.replacementReviewTokenId;
  if (membershipSuccessorRequired !== Boolean(membershipSuccessorValidation))
    fail("review token rotation membership successor evidence drift");
  const livePredecessorReviewBuildTokenUuid = membershipSuccessorValidation?.
    predecessorReviewBuildTokenUuid ?? setup.reviewBuildTokenUuid;
  if (identities.productionTriggerUuid !== setup.productionTriggerUuid ||
      identities.reviewTriggerUuid !== journal.reviewTriggerUuid ||
      identities.productionBuildTokenUuid !== setup.productionBuildTokenUuid ||
      identities.reviewBuildTokenUuid !== livePredecessorReviewBuildTokenUuid ||
      identities.repositoryConnectionUuid !== setup.repositoryConnectionUuid ||
      tokenRows.review.build_token_uuid !== livePredecessorReviewBuildTokenUuid ||
      tokenRows.production.build_token_uuid !== setup.productionBuildTokenUuid ||
      membershipSuccessorValidation &&
        (tokenRows.review.cloudflare_token_id !==
          membershipSuccessorValidation.predecessorReviewTokenId ||
         replacementTokenId !== membershipSuccessorValidation.replacementReviewTokenId) ||
      replacementTokenId === tokenRows.review.cloudflare_token_id ||
      replacementTokenId === tokenRows.production.cloudflare_token_id ||
      Date.parse(replacementTokenAuthorityProof.modifiedOn) <= Date.parse(journal.terminalAt) ||
      !/^[0-9a-f]{64}$/u.test(replacementTokenSecretSha256 ?? ""))
    fail("review token rotation journal/live/token identity drift");
  const capturedAt = new Date(now).toISOString();
  const authority = {
    outcome: "workers-builds-review-token-rotation-authority-valid",
    mutation: false,
    phase: "review-token-rotation",
    accountId,
    sourceSha,
    predecessorSourceSha,
    capturedAt,
    expiresAt: new Date(now + reviewTokenRotationAuthorityLifetimeMs).toISOString(),
    planDigest: digestJson(provisioningSetupPlan(production, review)),
    productionContractDigest: digestJson(production),
    reviewContractDigest: digestJson(review),
    predecessorProofDigest: currentReviewActiveProof.proof_digest,
    journalIdentities: {
      productionTriggerUuid: setup.productionTriggerUuid,
      reviewTriggerUuid: journal.reviewTriggerUuid,
      productionBuildTokenUuid: setup.productionBuildTokenUuid,
      predecessorReviewBuildTokenUuid: livePredecessorReviewBuildTokenUuid,
      repositoryConnectionUuid: setup.repositoryConnectionUuid,
    },
    replacementToken: {
      name: reviewBuildTokenNames.current,
      tokenId: replacementTokenId,
      modifiedOn: replacementTokenAuthorityProof.modifiedOn,
      ownerUserId: replacementTokenAuthorityProof.ownerUserId,
      secretSha256: replacementTokenSecretSha256,
    },
    productionScriptTag: baseline.productionScriptTag,
    productionPreservationDigest: baseline.productionPreservationDigest,
    repositoryOwner: { capturedAt: repositoryConnectionProof.capturedAt,
      githubApp: structuredClone(repositoryConnectionProof.githubApp),
      websitePreserved: repositoryConnectionProof.websitePreserved },
    productionSentinel: { branch: sentinel.branch,
      capturedAt: productionSentinelProof.capturedAt },
    buildUsage: { capturedAt: buildUsageProof.capturedAt,
      monthlyMinutesUsed: buildUsageProof.monthlyMinutesUsed,
      alertAtMinutes: buildUsageProof.alertAtMinutes,
      disableAtMinutes: buildUsageProof.disableAtMinutes },
    evidenceDigests: reviewTokenRotationEvidenceDigests({ reviewActivationProof,
      reviewActivationJournal, inertSetupJournal, inertSetupResults, currentReviewActiveProof,
      repositoryConnectionProof, productionSentinelProof, predecessorTokenAuthorityProofs,
      replacementTokenAuthorityProof, replacementTokenOwnerMembershipProof, buildUsageProof,
      productionBaselineProof, programDeliveryProof, rotationAttemptCoordinate,
      membershipSuccessorValidation }),
    allowedWrites: ["create-one-exact-replacement-review-build-token-wrapper",
      "patch-only-journaled-production-trigger-token-reference",
      "patch-only-journaled-review-trigger-token-reference",
      "delete-only-exact-unreferenced-predecessor-review-wrapper",
      "rollback-only-journal-created-replacement-wrapper-and-exact-trigger-token-references"],
  };
  return { ...authority, proof_digest: digestJson(authority) };
}

export function validateReviewTokenRotationAuthority(proof, arguments_, now = Date.now(),
minimumRemainingMs = reviewTokenRotationTransitionBudgetMs) {
  const captured = Date.parse(proof?.capturedAt ?? "");
  const expires = Date.parse(proof?.expiresAt ?? "");
  if (!Number.isFinite(captured) || !Number.isFinite(expires) || now >= expires ||
      expires - now < minimumRemainingMs ||
      expires - captured !== reviewTokenRotationAuthorityLifetimeMs)
    fail("review token rotation authority is stale");
  const expected = issueReviewTokenRotationAuthority(arguments_, captured);
  if (!same(proof, expected))
    fail("review token rotation authority proof is malformed or cross-phase");
  return { outcome: proof.outcome, mutation: false, phase: proof.phase,
    proofValidationTime: captured, checkedAt: new Date(now).toISOString(),
    expiresAt: proof.expiresAt, proof_digest: proof.proof_digest };
}

function validateHistoricalReviewTokenRotationAuthority(proof, { production, review, accountId,
  sourceSha, planDigest = digestJson(provisioningSetupPlan(production, review)) }) {
  const keys = ["accountId", "allowedWrites", "buildUsage", "capturedAt", "evidenceDigests",
    "expiresAt", "journalIdentities", "mutation", "outcome", "phase", "planDigest",
    "predecessorProofDigest", "predecessorSourceSha", "productionContractDigest",
    "productionPreservationDigest", "productionScriptTag", "productionSentinel", "proof_digest",
    "replacementToken", "repositoryOwner", "reviewContractDigest", "sourceSha"];
  const evidenceKeys = ["buildUsage", "currentReviewActiveProof", "inertSetupJournal",
    "inertSetupResults", "predecessorTokenAuthority", "productionBaseline",
    "productionSentinel", "programDelivery", "repositoryOwner", "replacementTokenAuthority",
    "replacementTokenOwnerMembership", "reviewActivationJournal", "reviewActivationProof",
    "rotationAttempt"];
  const successorAuthority = proof?.evidenceDigests?.membershipSuccessor !== undefined;
  if (successorAuthority) evidenceKeys.push("membershipSuccessor");
  const captured = Date.parse(proof?.capturedAt ?? "");
  const expires = Date.parse(proof?.expiresAt ?? "");
  const unsigned = { ...proof };
  delete unsigned.proof_digest;
  if (!proof || !same(sorted(Object.keys(proof)), sorted(keys)) ||
      !same(sorted(Object.keys(proof.evidenceDigests ?? {})), sorted(evidenceKeys)) ||
      !same(sorted(Object.keys(proof.evidenceDigests?.predecessorTokenAuthority ?? {})),
        ["production", "review"]) ||
      !Object.entries(proof.evidenceDigests).every(([key, value]) =>
        key === "predecessorTokenAuthority" ? Object.values(value).every(
          (digest) => /^[0-9a-f]{64}$/u.test(digest)) : /^[0-9a-f]{64}$/u.test(value)) ||
      proof.outcome !== "workers-builds-review-token-rotation-authority-valid" ||
      proof.mutation !== false || proof.phase !== "review-token-rotation" ||
      proof.accountId !== accountId || proof.sourceSha !== sourceSha ||
      successorAuthority &&
        (proof.evidenceDigests.membershipSuccessor !== reviewMembershipSuccessorEvidenceDigest ||
         proof.journalIdentities?.predecessorReviewBuildTokenUuid !==
           reviewMembershipSuccessorRotationIncident.predecessorReviewBuildTokenUuid ||
         proof.replacementToken?.tokenId !==
           reviewMembershipSuccessorRotationIncident.replacementReviewTokenId) ||
      proof.planDigest !== planDigest ||
      proof.productionContractDigest !== digestJson(production) ||
      proof.reviewContractDigest !== digestJson(review) ||
      !Number.isFinite(captured) || !Number.isFinite(expires) ||
      expires - captured !== reviewTokenRotationAuthorityLifetimeMs ||
      proof.proof_digest !== digestJson(unsigned) ||
      !scriptTagPattern.test(proof.productionScriptTag ?? "") ||
      !/^[0-9a-f]{64}$/u.test(proof.productionPreservationDigest ?? "") ||
      !/^[0-9a-f]{64}$/u.test(proof.replacementToken?.secretSha256 ?? "") ||
      proof.replacementToken?.name !== reviewBuildTokenNames.current ||
      !/^[0-9a-f]{32}$/u.test(proof.replacementToken?.ownerUserId ?? "") ||
      !same(proof.allowedWrites, ["create-one-exact-replacement-review-build-token-wrapper",
        "patch-only-journaled-production-trigger-token-reference",
        "patch-only-journaled-review-trigger-token-reference",
        "delete-only-exact-unreferenced-predecessor-review-wrapper",
        "rollback-only-journal-created-replacement-wrapper-and-exact-trigger-token-references"]))
    fail("review token rotation historical authority drift");
  return proof;
}

function validateReviewTokenRotationPhaseProof(proof, phase, authorityProof, {
  accountId, sourceSha }, now = Date.now(), maximumAgeMs = Infinity) {
  const keys = ["accountId", "capturedAt", "mutation", "outcome", "phase",
    "productionBuildTokenUuid", "productionPreservationDigest", "productionTriggerUuid",
    "proof_digest", "replacementReviewTokenUuid", "reviewTriggerUuid", "sourceSha",
    "predecessorReviewTokenUuid"];
  const captured = Date.parse(proof?.capturedAt ?? "");
  const identity = authorityProof?.journalIdentities ?? {};
  if (!proof || !same(sorted(Object.keys(proof)), sorted(keys)) ||
      proof.outcome !== `workers-builds-review-token-rotation-${phase}-valid` ||
      proof.mutation !== false || proof.phase !== phase || proof.accountId !== accountId ||
      proof.sourceSha !== sourceSha || !isUtcTimestamp(proof.capturedAt) ||
      !Number.isFinite(captured) || captured > now + 30_000 || now - captured > maximumAgeMs ||
      !/^[0-9a-f]{64}$/u.test(proof.proof_digest ?? "") ||
      proof.productionPreservationDigest !== authorityProof.productionPreservationDigest ||
      proof.productionTriggerUuid !== identity.productionTriggerUuid ||
      proof.reviewTriggerUuid !== identity.reviewTriggerUuid ||
      proof.productionBuildTokenUuid !== identity.productionBuildTokenUuid ||
      proof.predecessorReviewTokenUuid !== identity.predecessorReviewBuildTokenUuid ||
      ![proof.productionBuildTokenUuid, proof.replacementReviewTokenUuid]
        .every((value) => uuidPattern.test(value ?? "")))
    fail("review token rotation phase proof drift");
  return proof;
}

function validateReviewTokenRotationPredecessorProof(proof, authorityProof, {
  accountId, sourceSha,
}, now = Date.now(), maximumAgeMs = Infinity) {
  const keys = ["accountId", "capturedAt", "mutation", "outcome", "phase",
    "predecessorReviewTokenUuid", "productionBuildTokenUuid",
    "productionPreservationDigest", "productionTriggerUuid", "proof_digest",
    "reviewTriggerUuid", "sourceSha"];
  const captured = Date.parse(proof?.capturedAt ?? "");
  const identity = authorityProof?.journalIdentities ?? {};
  if (!proof || !same(sorted(Object.keys(proof)), sorted(keys)) ||
      proof.outcome !== "workers-builds-review-token-rotation-predecessor-valid" ||
      proof.mutation !== false || proof.phase !== "predecessor" ||
      proof.accountId !== accountId || proof.sourceSha !== sourceSha ||
      !isUtcTimestamp(proof.capturedAt) || !Number.isFinite(captured) ||
      captured > now + 30_000 || now - captured > maximumAgeMs ||
      !/^[0-9a-f]{64}$/u.test(proof.proof_digest ?? "") ||
      proof.productionPreservationDigest !== authorityProof.productionPreservationDigest ||
      proof.productionTriggerUuid !== identity.productionTriggerUuid ||
      proof.reviewTriggerUuid !== identity.reviewTriggerUuid ||
      proof.productionBuildTokenUuid !== identity.productionBuildTokenUuid ||
      proof.predecessorReviewTokenUuid !== identity.predecessorReviewBuildTokenUuid)
    fail("review token rotation predecessor proof drift");
  return proof;
}

function validateReviewTokenRotationTerminalProof(proof, { accountId, sourceSha,
  authorityProof },
now = Date.now(), maximumAgeMs = 5 * 60_000) {
  return validateReviewTokenRotationPhaseProof(proof, "complete", authorityProof,
    { accountId, sourceSha }, now, maximumAgeMs);
}

export function reviewTokenRotationRequestDigest({ production, review, authorityProof,
  operation, replacementReviewTokenUuid }) {
  const identity = authorityProof.journalIdentities;
  let method;
  let path;
  let body;
  if (operation === "replacement-review-build-token") {
    method = "POST";
    path = "/builds/tokens";
    body = { build_token_name: authorityProof.replacementToken.name,
      build_token_secret_sha256: authorityProof.replacementToken.secretSha256,
      cloudflare_token_id: authorityProof.replacementToken.tokenId };
  } else if (operation === "repoint-inert-production-trigger") {
    method = "PATCH";
    path = `/builds/triggers/${identity.productionTriggerUuid}`;
    body = productionTriggerSpec(production, { externalScriptId: authorityProof.productionScriptTag,
      repositoryConnectionUuid: identity.repositoryConnectionUuid,
      buildTokenUuid: replacementReviewTokenUuid });
    body.branch_includes = [authorityProof.productionSentinel.branch];
  } else if (operation === "repoint-final-review-trigger") {
    method = "PATCH";
    path = `/builds/triggers/${identity.reviewTriggerUuid}`;
    body = automaticReviewTriggerSpec(review, {
      externalScriptId: authorityProof.productionScriptTag,
      repositoryConnectionUuid: identity.repositoryConnectionUuid,
      buildTokenUuid: replacementReviewTokenUuid });
  } else if (operation === "retire-superseded-review-build-token") {
    method = "DELETE";
    path = `/builds/tokens/${identity.predecessorReviewBuildTokenUuid}`;
    body = null;
  } else fail("unknown review token rotation operation");
  return { method, path, requestDigestSha256: digestJson({ method, path, body }) };
}

export function reviewTokenRotationRollbackRequestDigest({ production, review, authorityProof,
  operation, replacementReviewTokenUuid }) {
  const identity = authorityProof.journalIdentities;
  let method = "PATCH";
  let path;
  let body;
  if (operation === "rotation-restore-review-trigger-old-token") {
    path = `/builds/triggers/${identity.reviewTriggerUuid}`;
    body = automaticReviewTriggerSpec(review, {
      externalScriptId: authorityProof.productionScriptTag,
      repositoryConnectionUuid: identity.repositoryConnectionUuid,
      buildTokenUuid: identity.predecessorReviewBuildTokenUuid,
    });
  } else if (operation === "rotation-restore-production-trigger-old-token") {
    path = `/builds/triggers/${identity.productionTriggerUuid}`;
    body = productionTriggerSpec(production, {
      externalScriptId: authorityProof.productionScriptTag,
      repositoryConnectionUuid: identity.repositoryConnectionUuid,
      buildTokenUuid: identity.predecessorReviewBuildTokenUuid,
    });
    body.branch_includes = [authorityProof.productionSentinel.branch];
  } else if (operation === "rotation-delete-replacement-wrapper") {
    method = "DELETE";
    path = `/builds/tokens/${replacementReviewTokenUuid}`;
    body = null;
  } else fail("unknown review token rotation rollback operation");
  return { method, path, requestDigestSha256: digestJson({ method, path, body }) };
}

function validateReviewTokenRotationProviderNormalizedIncidentCore(forwardRecords,
incidentProof, authorityProof, { production, review, accountId, forwardJournalSha256,
  incidentSnapshotManifestSha256, authorityFileSha256 }, testCapability = undefined) {
  const coordinate = providerNormalizedIncidentCoordinate(testCapability);
  validateHistoricalReviewTokenRotationAuthority(authorityProof, { production, review,
    accountId, sourceSha: coordinate.sourceSha, planDigest: coordinate.planDigest });
  validateReviewTokenRotationPhaseProof(incidentProof,
    "production-repointed-review-augmented", authorityProof,
    { accountId, sourceSha: coordinate.sourceSha }, Date.parse(incidentProof?.capturedAt ?? ""),
    Infinity);
  const expected = [
    ["attempt-started", "review-token-rotation"], ["rotation-authorized", undefined],
    ["current-main-proof-bound", "replacement-review-build-token"],
    ["review-token-rotation-authority-checked", "replacement-review-build-token"],
    ["mutation-intent", "replacement-review-build-token"],
    ["provider-response-classified", "replacement-review-build-token"],
    ["mutation-bound", "replacement-review-build-token"],
    ["current-main-proof-bound", "repoint-inert-production-trigger"],
    ["review-token-rotation-authority-checked", "repoint-inert-production-trigger"],
    ["mutation-intent", "repoint-inert-production-trigger"],
    ["provider-response-classified", "repoint-inert-production-trigger"],
    ["mutation-bound", "repoint-inert-production-trigger"],
  ];
  const pairs = Array.isArray(forwardRecords) ? forwardRecords.map(({ event, operation }) =>
    [event, operation]) : [];
  if (!same(pairs, expected) || digestJson(forwardRecords) !== coordinate.forwardJournalDigest ||
      forwardJournalSha256 !== coordinate.forwardJournalSha256 ||
      incidentSnapshotManifestSha256 !== coordinate.incidentSnapshotManifestSha256 ||
      authorityFileSha256 !== coordinate.authorityFileSha256 ||
      incidentProof.proof_digest !== coordinate.incidentProofDigest ||
      digestJson(incidentProof) !== coordinate.incidentProofDocumentSha256)
    fail("review token rotation provider-normalized incident coordinate drift");
  let previousAt = -Infinity;
  for (const record of forwardRecords) {
    const { recordSha256, ...payload } = record ?? {};
    const at = Date.parse(record?.at ?? "");
    if (!/^[0-9a-f]{64}$/u.test(recordSha256 ?? "") || digestJson(payload) !== recordSha256 ||
        !isUtcTimestamp(record.at) || !Number.isFinite(at) || at <= previousAt ||
        record.attempt !== 1) fail("review token rotation provider-normalized journal drift");
    previousAt = at;
  }
  const identity = authorityProof.journalIdentities;
  const replacement = incidentProof.replacementReviewTokenUuid;
  const find = (event, operation) => forwardRecords.find((record) =>
    record.event === event && record.operation === operation);
  const operations = [["replacement-review-build-token", replacement],
    ["repoint-inert-production-trigger", identity.productionTriggerUuid]];
  for (const [operation, resourceUuid] of operations) {
    const main = find("current-main-proof-bound", operation);
    const checked = find("review-token-rotation-authority-checked", operation);
    const intent = find("mutation-intent", operation);
    const classified = find("provider-response-classified", operation);
    const bound = find("mutation-bound", operation);
    const request = reviewTokenRotationRequestDigest({ production, review, authorityProof,
      operation, replacementReviewTokenUuid: replacement });
    const captured = Date.parse(main?.capturedAt ?? "");
    if (main?.sourceSha !== coordinate.sourceSha || main.ref !== currentMainRef ||
        !isUtcTimestamp(main.capturedAt) || !Number.isFinite(captured) ||
        captured > Date.parse(main.at) || Date.parse(main.at) - captured > 5 * 60_000 ||
        !/^[0-9a-f]{64}$/u.test(main.proofFileSha256 ?? "") ||
        !/^[0-9a-f]{64}$/u.test(main.rawFileSha256 ?? "") ||
        checked?.proofDigest !== authorityProof.proof_digest ||
        checked.expiresAt !== authorityProof.expiresAt ||
        Date.parse(checked.at) > Date.parse(intent?.at ?? "") ||
        Date.parse(intent?.at ?? "") - Date.parse(checked.at) > 30_000 ||
        intent?.method !== request.method || intent.path !== request.path ||
        intent.requestDigestSha256 !== request.requestDigestSha256 ||
        classified?.outcome !== "explicit-success" ||
        operation === "replacement-review-build-token" &&
          classified.resourceUuid !== replacement ||
        bound?.resourceUuid !== resourceUuid || bound.providerResponseExplicitSuccess !== true ||
        bound.requestDigestSha256 !== request.requestDigestSha256 ||
        bound.reconciliation !== "explicit-success-exact-readback" ||
        !/^[0-9a-f]{64}$/u.test(bound.readbackDigestSha256 ?? "") ||
        Date.parse(intent.at) > Date.parse(classified.at) ||
        Date.parse(classified.at) > Date.parse(bound.at) ||
        Date.parse(bound.at) >= Date.parse(authorityProof.expiresAt))
      fail("review token rotation provider-normalized mutation provenance drift");
  }
  if (forwardRecords[1].authorityProofDigest !== authorityProof.proof_digest ||
      Date.parse(forwardRecords.at(-1).at) > Date.parse(incidentProof.capturedAt))
    fail("review token rotation provider-normalized incident chronology drift");
  return { outcome: "workers-builds-review-token-rotation-provider-normalized-incident-valid",
    mutation: false, phase: incidentProof.phase, sourceSha: coordinate.sourceSha,
    replacementReviewTokenUuid: replacement, forwardJournalDigest: digestJson(forwardRecords),
    incidentProofDigest: incidentProof.proof_digest,
    incidentCoordinateDigest: digestJson({ coordinate, authorityProofDigest:
      authorityProof.proof_digest, incidentProofDigest: incidentProof.proof_digest }) };
}

export function validateReviewTokenRotationProviderNormalizedIncident(forwardRecords,
incidentProof, authorityProof, arguments_) {
  return validateReviewTokenRotationProviderNormalizedIncidentCore(forwardRecords,
    incidentProof, authorityProof, arguments_);
}

export function validateReviewTokenRotationProviderNormalizedIncidentForTest(forwardRecords,
incidentProof, authorityProof, arguments_, testCapability) {
  return validateReviewTokenRotationProviderNormalizedIncidentCore(forwardRecords,
    incidentProof, authorityProof, arguments_, testCapability);
}

function validateReviewTokenRotationFreshAugmentedForwardPrefix(forwardRecords,
intermediateProof, authorityProof, { production, review, accountId, sourceSha,
  rotationAttemptCoordinate, attemptFilesystemEvidence, programDeliveryProof,
  programLedgerDocument, programLedgerFileSha256, preCreateProof, preProductionProof,
  recoveryProof }) {
  validateHistoricalReviewTokenRotationAuthority(authorityProof,
    { production, review, accountId, sourceSha });
  validateReviewTokenRotationPredecessorProof(preCreateProof, authorityProof,
    { accountId, sourceSha }, Date.parse(preCreateProof?.capturedAt ?? ""), Infinity);
  validateReviewTokenRotationPhaseProof(preProductionProof, "replacement-created", authorityProof,
    { accountId, sourceSha }, Date.parse(preProductionProof?.capturedAt ?? ""), Infinity);
  const completedExpected = [
    ["attempt-started", "review-token-rotation"], ["rotation-authorized", undefined],
    ["current-main-proof-bound", "replacement-review-build-token"],
    ["review-token-rotation-authority-checked", "replacement-review-build-token"],
    ["provider-proof-bound", "prove-replacement-create-precondition"],
    ["mutation-intent", "replacement-review-build-token"],
    ["provider-response-classified", "replacement-review-build-token"],
    ["mutation-bound", "replacement-review-build-token"],
    ["current-main-proof-bound", "repoint-inert-production-trigger"],
    ["review-token-rotation-authority-checked", "repoint-inert-production-trigger"],
    ["provider-proof-bound", "prove-production-repoint-precondition"],
    ["mutation-intent", "repoint-inert-production-trigger"],
    ["provider-response-classified", "repoint-inert-production-trigger"],
    ["mutation-bound", "repoint-inert-production-trigger"],
    ["current-main-proof-bound", "repoint-final-review-trigger"],
    ["review-token-rotation-authority-checked", "repoint-final-review-trigger"],
    ["provider-proof-bound", "prove-production-repointed-review-still-predecessor"],
  ];
  const pairs = Array.isArray(forwardRecords) ? forwardRecords.map(({ event, operation }) =>
    [event, operation]) : [];
  const productionIntentExpected = completedExpected.slice(0, 12);
  const productionClassifiedExpected = completedExpected.slice(0, 13);
  const reviewIntentExpected = [...completedExpected,
    ["mutation-intent", "repoint-final-review-trigger"]];
  const reviewClassifiedExpected = [...reviewIntentExpected,
    ["provider-response-classified", "repoint-final-review-trigger"]];
  const prefixKind = same(pairs, completedExpected) ? "completed-augmented" :
    same(pairs, productionIntentExpected) ? "production-intent-applied" :
      same(pairs, productionClassifiedExpected) ? "production-classified-applied" :
        same(pairs, reviewIntentExpected) ? "review-intent-no-effect" :
          same(pairs, reviewClassifiedExpected) ? "review-classified-no-effect" : null;
  if (prefixKind === null)
    fail("review token rotation fresh augmented forward sequence drift");
  const exceptionalPrefix = prefixKind !== "completed-augmented";
  const augmentedProof = exceptionalPrefix ? recoveryProof : intermediateProof;
  validateReviewTokenRotationPhaseProof(augmentedProof,
    "production-repointed-review-augmented", authorityProof,
    { accountId, sourceSha }, Date.parse(augmentedProof?.capturedAt ?? ""), Infinity);
  if (prefixKind.startsWith("review-"))
    validateReviewTokenRotationPhaseProof(intermediateProof,
      "production-repointed-review-augmented", authorityProof,
      { accountId, sourceSha }, Date.parse(intermediateProof?.capturedAt ?? ""), Infinity);
  validateReviewTokenRotationAttemptCoordinate(rotationAttemptCoordinate, sourceSha,
    attemptFilesystemEvidence, Date.parse(rotationAttemptCoordinate?.capturedAt ?? ""));
  validateReviewTokenRotationRetryProgramProof(programDeliveryProof, sourceSha,
    programLedgerDocument, programLedgerFileSha256,
    Date.parse(programDeliveryProof?.capturedAt ?? ""));
  if (authorityProof.evidenceDigests?.rotationAttempt !==
        digestJson(rotationAttemptCoordinate) ||
      authorityProof.evidenceDigests?.programDelivery !== digestJson(programDeliveryProof))
    fail("review token rotation fresh augmented authority evidence drift");
  const exactKeys = (record) => {
    const common = ["at", "attempt", "event", "recordSha256"];
    if (record.event === "attempt-started") return [...common, "operation", "attemptNamespace",
      "executorSha256", "journalId", "journalPathSha256", "attemptCoordinateDigest"];
    if (record.event === "rotation-authorized") return [...common, "authorityProofDigest"];
    if (record.event === "current-main-proof-bound") return [...common, "operation", "sourceSha",
      "ref", "capturedAt", "proofFileSha256", "rawFileSha256"];
    if (record.event === "review-token-rotation-authority-checked") return [...common,
      "operation", "proofDigest", "expiresAt"];
    if (record.event === "mutation-intent") return [...common, "operation", "method", "path",
      "requestDigestSha256"];
    if (record.event === "provider-response-classified")
      return record.outcome === "explicit-failure" ? [...common, "operation", "outcome",
        "resourceUuid", "responseDigestSha256", "status"] :
        [...common, "operation", "outcome", "resourceUuid"];
    if (record.event === "mutation-bound") return [...common, "operation", "resourceUuid",
      "providerResponseExplicitSuccess", "requestDigestSha256", "readbackDigestSha256",
      "reconciliation"];
    if (record.event === "provider-proof-bound") return [...common, "operation", "proofDigest",
      "proofFileSha256"];
    return [];
  };
  let previousAt = -Infinity;
  for (const record of forwardRecords) {
    const { recordSha256, ...payload } = record ?? {};
    const at = Date.parse(record?.at ?? "");
    if (!same(sorted(Object.keys(record ?? {})), sorted(exactKeys(record))) ||
        !/^[0-9a-f]{64}$/u.test(recordSha256 ?? "") || digestJson(payload) !== recordSha256 ||
        !isUtcTimestamp(record.at) || !Number.isFinite(at) || at <= previousAt ||
        record.attempt !== 1)
      fail("review token rotation fresh augmented forward checksum drift");
    previousAt = at;
  }
  const identity = authorityProof.journalIdentities;
  const replacement = augmentedProof.replacementReviewTokenUuid;
  const find = (event, operation) => forwardRecords.find((record) =>
    record.event === event && record.operation === operation);
  const completedOperations = [["replacement-review-build-token", replacement],
    ...prefixKind.startsWith("production-") ? [] :
      [["repoint-inert-production-trigger", identity.productionTriggerUuid]]];
  for (const [operation, resourceUuid] of completedOperations) {
    const main = find("current-main-proof-bound", operation);
    const checked = find("review-token-rotation-authority-checked", operation);
    const intent = find("mutation-intent", operation);
    const classified = find("provider-response-classified", operation);
    const bound = find("mutation-bound", operation);
    const request = reviewTokenRotationRequestDigest({ production, review, authorityProof,
      operation, replacementReviewTokenUuid: replacement });
    const captured = Date.parse(main?.capturedAt ?? "");
    const explicit = classified?.outcome === "explicit-success";
    const ambiguous = classified?.outcome === "ambiguous";
    if (main?.sourceSha !== sourceSha || main.ref !== currentMainRef ||
        !isUtcTimestamp(main.capturedAt) || !Number.isFinite(captured) ||
        captured > Date.parse(main.at) || Date.parse(main.at) - captured > 5 * 60_000 ||
        !/^[0-9a-f]{64}$/u.test(main.proofFileSha256 ?? "") ||
        !/^[0-9a-f]{64}$/u.test(main.rawFileSha256 ?? "") ||
        checked?.proofDigest !== authorityProof.proof_digest ||
        checked.expiresAt !== authorityProof.expiresAt ||
        Date.parse(checked.at) < Date.parse(authorityProof.capturedAt) ||
        Date.parse(authorityProof.expiresAt) - Date.parse(checked.at) <
          reviewTokenRotationTransitionBudgetMs ||
        Date.parse(main.at) > Date.parse(checked.at) ||
        Date.parse(checked.at) > Date.parse(intent?.at ?? "") ||
        intent?.method !== request.method || intent.path !== request.path ||
        intent.requestDigestSha256 !== request.requestDigestSha256 ||
        (!explicit && !ambiguous) ||
        explicit && classified.resourceUuid !== resourceUuid ||
        bound?.resourceUuid !== resourceUuid ||
        bound.providerResponseExplicitSuccess !== explicit ||
        bound.requestDigestSha256 !== request.requestDigestSha256 ||
        bound.reconciliation !== (explicit ? "explicit-success-exact-readback" :
          "ambiguous-exact-readback") ||
        !/^[0-9a-f]{64}$/u.test(bound.readbackDigestSha256 ?? "") ||
        Date.parse(intent.at) > Date.parse(classified.at) ||
        Date.parse(classified.at) > Date.parse(bound.at) ||
        Date.parse(bound.at) >= Date.parse(authorityProof.expiresAt))
      fail("review token rotation fresh augmented mutation provenance drift");
  }
  if (prefixKind.startsWith("production-")) {
    const operation = "repoint-inert-production-trigger";
    const main = find("current-main-proof-bound", operation);
    const checked = find("review-token-rotation-authority-checked", operation);
    const proofBound = find("provider-proof-bound", "prove-production-repoint-precondition");
    const intent = find("mutation-intent", operation);
    const classified = find("provider-response-classified", operation);
    const request = reviewTokenRotationRequestDigest({ production, review, authorityProof,
      operation, replacementReviewTokenUuid: replacement });
    const mainCaptured = Date.parse(main?.capturedAt ?? "");
    if (main?.sourceSha !== sourceSha || main.ref !== currentMainRef ||
        !isUtcTimestamp(main.capturedAt) || !Number.isFinite(mainCaptured) ||
        mainCaptured > Date.parse(main.at) || Date.parse(main.at) - mainCaptured > 5 * 60_000 ||
        !/^[0-9a-f]{64}$/u.test(main.proofFileSha256 ?? "") ||
        !/^[0-9a-f]{64}$/u.test(main.rawFileSha256 ?? "") ||
        checked?.proofDigest !== authorityProof.proof_digest ||
        checked.expiresAt !== authorityProof.expiresAt ||
        Date.parse(checked.at) < Date.parse(authorityProof.capturedAt) ||
        Date.parse(authorityProof.expiresAt) - Date.parse(checked.at) <
          reviewTokenRotationTransitionBudgetMs ||
        proofBound?.proofDigest !== preProductionProof.proof_digest ||
        proofBound.proofFileSha256 !== digestJson(preProductionProof) ||
        Date.parse(main.at) > Date.parse(checked.at) ||
        Date.parse(checked.at) > Date.parse(preProductionProof.capturedAt) ||
        Date.parse(preProductionProof.capturedAt) > Date.parse(proofBound.at) ||
        Date.parse(proofBound.at) > Date.parse(intent?.at ?? "") ||
        Date.parse(intent?.at ?? "") - Date.parse(preProductionProof.capturedAt) > 30_000 ||
        Date.parse(intent?.at ?? "") >= Date.parse(authorityProof.expiresAt) ||
        intent?.method !== request.method || intent.path !== request.path ||
        intent.requestDigestSha256 !== request.requestDigestSha256 ||
        classified && !["explicit-success", "ambiguous"].includes(classified.outcome) ||
        classified?.outcome === "explicit-success" &&
          classified.resourceUuid !== identity.productionTriggerUuid ||
        classified?.outcome === "ambiguous" && classified.resourceUuid !== null ||
        classified && Date.parse(intent.at) > Date.parse(classified.at))
      fail("review token rotation fresh augmented partial production provenance drift");
  }
  const includesReviewGate = !prefixKind.startsWith("production-");
  const reviewMain = includesReviewGate ?
    find("current-main-proof-bound", "repoint-final-review-trigger") : null;
  const reviewChecked = find("review-token-rotation-authority-checked",
    "repoint-final-review-trigger");
  const reviewMainCaptured = Date.parse(reviewMain?.capturedAt ?? "");
  if (includesReviewGate && (reviewMain?.sourceSha !== sourceSha ||
      reviewMain.ref !== currentMainRef ||
      !isUtcTimestamp(reviewMain.capturedAt) || !Number.isFinite(reviewMainCaptured) ||
      reviewMainCaptured > Date.parse(reviewMain.at) ||
      Date.parse(reviewMain.at) - reviewMainCaptured > 5 * 60_000 ||
      !/^[0-9a-f]{64}$/u.test(reviewMain.proofFileSha256 ?? "") ||
      !/^[0-9a-f]{64}$/u.test(reviewMain.rawFileSha256 ?? "") ||
      reviewChecked?.proofDigest !== authorityProof.proof_digest ||
      reviewChecked.expiresAt !== authorityProof.expiresAt ||
      Date.parse(reviewChecked.at) < Date.parse(authorityProof.capturedAt) ||
      Date.parse(authorityProof.expiresAt) - Date.parse(reviewChecked.at) <
        reviewTokenRotationTransitionBudgetMs ||
      Date.parse(reviewMain.at) > Date.parse(reviewChecked.at)))
    fail("review token rotation fresh augmented review authorization drift");
  const proofBound = find("provider-proof-bound",
    "prove-production-repointed-review-still-predecessor");
  const productionBound = find("mutation-bound", "repoint-inert-production-trigger");
  const attempt = forwardRecords[0];
  if (attempt.attemptNamespace !== rotationAttemptCoordinate.attemptNamespace ||
      attempt.executorSha256 !== rotationAttemptCoordinate.executorSha256 ||
      attempt.journalId !== rotationAttemptCoordinate.journalId ||
      attempt.journalPathSha256 !== rotationAttemptCoordinate.journalPathSha256 ||
      attempt.attemptCoordinateDigest !== rotationAttemptCoordinate.proof_digest ||
      forwardRecords[1].authorityProofDigest !== authorityProof.proof_digest ||
      includesReviewGate && (proofBound?.proofDigest !== intermediateProof.proof_digest ||
        proofBound.proofFileSha256 !== digestJson(intermediateProof) ||
        Date.parse(productionBound.at) > Date.parse(intermediateProof.capturedAt) ||
        Date.parse(intermediateProof.capturedAt) > Date.parse(proofBound.at)))
    fail("review token rotation fresh augmented proof chronology drift");
  for (const [operation, proof, proofOperation, lower] of [
    ["replacement-review-build-token", preCreateProof,
      "prove-replacement-create-precondition", forwardRecords[1]],
    ["repoint-inert-production-trigger", preProductionProof,
      "prove-production-repoint-precondition",
      find("mutation-bound", "replacement-review-build-token")],
    ...includesReviewGate ? [["repoint-final-review-trigger", intermediateProof,
      "prove-production-repointed-review-still-predecessor", productionBound]] : [],
  ]) {
    const checked = find("review-token-rotation-authority-checked", operation);
    const main = find("current-main-proof-bound", operation);
    const bound = find("provider-proof-bound", proofOperation);
    const intent = find("mutation-intent", operation);
    if (bound?.proofDigest !== proof.proof_digest ||
        bound?.proofFileSha256 !== digestJson(proof) ||
        Date.parse(lower?.at ?? "") > Date.parse(proof.capturedAt) ||
        !reviewTokenRotationRollbackProofChronologyValid({
          currentMainAt: main?.at, authorityAt: checked?.at,
          proofCapturedAt: proof.capturedAt, proofBoundAt: bound?.at,
          intentAt: intent?.at }))
      fail("review token rotation fresh augmented pre-mutation proof drift");
  }
  if (prefixKind.startsWith("review-")) {
    const operation = "repoint-final-review-trigger";
    const intent = find("mutation-intent", operation);
    const classified = find("provider-response-classified", operation);
    const request = reviewTokenRotationRequestDigest({ production, review, authorityProof,
      operation, replacementReviewTokenUuid: replacement });
    if (intent?.method !== request.method || intent.path !== request.path ||
        intent.requestDigestSha256 !== request.requestDigestSha256 ||
        Date.parse(proofBound.at) > Date.parse(intent.at) ||
        Date.parse(intent.at) - Date.parse(intermediateProof.capturedAt) > 30_000 ||
        Date.parse(intent.at) >= Date.parse(authorityProof.expiresAt) ||
        classified && !["explicit-failure", "ambiguous"].includes(classified.outcome) ||
        classified?.outcome === "explicit-failure" &&
          (!Number.isSafeInteger(classified.status) || classified.status < 400 ||
           classified.status > 599 ||
           !/^[0-9a-f]{64}$/u.test(classified.responseDigestSha256 ?? "")) ||
        classified && classified.resourceUuid !== null ||
        classified && Date.parse(intent.at) > Date.parse(classified.at))
      fail("review token rotation fresh augmented review no-effect provenance drift");
  }
  if (exceptionalPrefix && (Date.parse(forwardRecords.at(-1)?.at ?? "") >=
        Date.parse(augmentedProof.capturedAt) ||
      prefixKind.startsWith("production-") &&
        Date.parse(augmentedProof.capturedAt) < Date.parse(authorityProof.expiresAt) ||
      digestJson(augmentedProof) !== digestJson(recoveryProof)))
    fail("review token rotation fresh augmented recovery proof drift");
  return { replacementReviewTokenUuid: replacement,
    forwardJournalDigest: digestJson(forwardRecords),
    intermediateProofDigest: augmentedProof.proof_digest,
    intermediateProofFileSha256: digestJson(augmentedProof), prefixKind };
}

async function validateReviewTokenRotationBlockedDeleteIncidentCore(rollbackRecords,
blockedProof, authorityProof, {
  production, review, accountId, sourceSha, executorSha256, rollbackJournalSha256,
  residualSnapshotManifestSha256, failedGuardResponseSha256, blockedSnapshotDirectory,
  incidentProof, incidentForwardRecords, incidentForwardJournalSha256,
  incidentSnapshotManifestSha256, incidentAuthorityFileSha256,
  peerNormalizationProof, restoredProof,
  productionSentinelProof, predecessorTokenAuthorityProofs,
  replacementTokenAuthorityProof, replacementTokenId, productionBaselineProof,
  providerNormalizedTestCapability = undefined,
} = {}, testCapability = undefined) {
  const coordinate = blockedDeleteIncidentCoordinate(testCapability);
  if (sourceSha !== coordinate.sourceSha || executorSha256 !== coordinate.executorSha256 ||
      rollbackJournalSha256 !== coordinate.rollbackJournalSha256 ||
      residualSnapshotManifestSha256 !== coordinate.residualSnapshotManifestSha256 ||
      failedGuardResponseSha256 !== coordinate.failedGuardResponseSha256 ||
      digestJson(rollbackRecords) !== coordinate.rollbackJournalDigest ||
      rollbackRecords?.at(-1)?.recordSha256 !== coordinate.rollbackTerminalRecordSha256 ||
      blockedProof?.proof_digest !== coordinate.residualProofDigest ||
      digestJson(blockedProof) !== coordinate.residualProofDocumentSha256)
    fail("review token rotation blocked delete incident coordinate drift");
  const terminal = rollbackRecords?.at(-1);
  const replacementReviewTokenUuid = terminal?.residualState?.replacementWrapperPresent === true ?
    rollbackRecords?.[0]?.replacementReviewTokenUuid : null;
  if (!uuidPattern.test(replacementReviewTokenUuid ?? "") ||
      terminal.event !== "review-token-rotation-rollback-blocked" ||
      terminal.residualProofDigest !== blockedProof.proof_digest ||
      terminal.residualProofFileSha256 !== digestJson(blockedProof) ||
      terminal.residualState?.activeMutation !== "rotation-delete-replacement-wrapper" ||
      terminal.residualState.reviewPeerAugmented !== false ||
      terminal.residualState.predecessorWrapperPresent !== true)
    fail("review token rotation blocked delete terminal drift");
  const validation = await classifyReviewTokenRotationProviderNormalizedRollbackPrefixCore(
    rollbackRecords, { production, review, accountId, sourceSha, authorityProof,
      replacementReviewTokenUuid, incidentProof, incidentForwardRecords,
      incidentForwardJournalSha256, incidentSnapshotManifestSha256,
      incidentAuthorityFileSha256, testCapability: providerNormalizedTestCapability,
      peerNormalizationProof, restoredProof,
      blockedSnapshotDirectory, blockedProof, productionSentinelProof,
      predecessorTokenAuthorityProofs, replacementTokenAuthorityProof, replacementTokenId,
      productionBaselineProof });
  if (!validation.terminal || validation.mutation !== false)
    fail("review token rotation blocked delete terminal is not inert");
  return { outcome: "workers-builds-review-token-rotation-blocked-delete-incident-valid",
    mutation: false, sourceSha, replacementReviewTokenUuid,
    authoritySourceSha: authorityProof.sourceSha,
    authorityPlanDigest: authorityProof.planDigest,
    incidentCoordinateDigest: digestJson({ coordinate,
      authorityProofDigest: authorityProof.proof_digest,
      rollbackJournalDigest: digestJson(rollbackRecords),
      residualProofDigest: blockedProof.proof_digest }) };
}

export async function validateReviewTokenRotationBlockedDeleteIncident(rollbackRecords,
blockedProof, authorityProof, arguments_ = {}) {
  const { testCapability: _ignored, providerNormalizedTestCapability: _ignoredProvider,
    ...runtimeArguments } = arguments_;
  return validateReviewTokenRotationBlockedDeleteIncidentCore(rollbackRecords, blockedProof,
    authorityProof, runtimeArguments);
}

export async function validateReviewTokenRotationBlockedDeleteIncidentForTest(rollbackRecords,
blockedProof, authorityProof, arguments_, testCapability) {
  return validateReviewTokenRotationBlockedDeleteIncidentCore(rollbackRecords, blockedProof,
    authorityProof, arguments_, testCapability);
}

export function validateReviewTokenRotationBlockedDeleteResidualChronology({ prefixAt,
  snapshotStartedAt, snapshotCompletedAt, proofCapturedAt, terminalAt }) {
  const values = [prefixAt, snapshotStartedAt, snapshotCompletedAt, proofCapturedAt, terminalAt]
    .map((value) => Date.parse(value ?? ""));
  if (values.some((value) => !Number.isFinite(value)) ||
      values.some((value, index) => index > 0 && value < values[index - 1]))
    fail("blocked delete recovery residual chronology drift");
  return true;
}

export function issueReviewTokenRotationBlockedDeleteAuthority({ production, review, accountId,
  sourceSha, currentMainProof, currentPhaseProof, historicalAuthorityProof,
  blockedIncidentValidation, recoveryCoordinate, capturedAt = new Date().toISOString() }) {
  const now = Date.parse(capturedAt);
  validateBlockedDeleteRecoveryCoordinate(recoveryCoordinate, sourceSha, now);
  validateCurrentMainProof(currentMainProof, sourceSha, now);
  validateHistoricalReviewTokenRotationAuthority(historicalAuthorityProof, { production, review,
    accountId, sourceSha: blockedIncidentValidation?.authoritySourceSha,
    planDigest: blockedIncidentValidation?.authorityPlanDigest });
  validateReviewTokenRotationPhaseProof(currentPhaseProof, "predecessor-restored",
    historicalAuthorityProof, { accountId, sourceSha }, now, 5 * 60_000);
  if (!blockedIncidentValidation || blockedIncidentValidation.mutation !== false ||
      blockedIncidentValidation.replacementReviewTokenUuid !==
        currentPhaseProof.replacementReviewTokenUuid ||
      !/^[0-9a-f]{64}$/u.test(blockedIncidentValidation.incidentCoordinateDigest ?? "") ||
      Date.parse(currentPhaseProof.capturedAt) <
        Date.parse(currentMainProof.capturedAt) - 30_000)
    fail("review token rotation blocked delete authority evidence drift");
  const planDigest = digestJson(provisioningSetupPlan(production, review));
  const unsigned = {
    outcome: "workers-builds-review-token-rotation-blocked-delete-authority-valid",
    mutation: false, phase: "blocked-review-token-delete-recovery", accountId, sourceSha,
    planDigest, productionContractDigest: digestJson(production),
    reviewContractDigest: digestJson(review), capturedAt,
    expiresAt: new Date(now + blockedReviewTokenDeleteAuthorityLifetimeMs).toISOString(),
    replacementReviewTokenUuid: currentPhaseProof.replacementReviewTokenUuid,
    predecessorReviewTokenUuid: currentPhaseProof.predecessorReviewTokenUuid,
    productionBuildTokenUuid: currentPhaseProof.productionBuildTokenUuid,
    productionTriggerUuid: currentPhaseProof.productionTriggerUuid,
    reviewTriggerUuid: currentPhaseProof.reviewTriggerUuid,
    productionPreservationDigest: currentPhaseProof.productionPreservationDigest,
    blockedIncidentCoordinateDigest: blockedIncidentValidation.incidentCoordinateDigest,
    currentPhaseProofDigest: currentPhaseProof.proof_digest,
    currentPhaseProofDocumentDigest: digestJson(currentPhaseProof),
    currentMainProofDigest: digestJson(currentMainProof),
    recoveryCoordinateDigest: digestJson(recoveryCoordinate),
    authorizationReceiptPath: recoveryCoordinate.authorizationReceiptPath,
    allowedWrites: ["delete-only-exact-journal-created-globally-unreferenced-replacement-wrapper"],
    exclusions: ["trigger-post-or-patch", "production-trigger-activation", "migration-0010",
      "manual-api-or-initial-production-build",
      "worker-version-deployment-binding-route-domain-schedule-url-state-secret-or-repository-connection-mutation"],
  };
  return { ...unsigned, proof_digest: digestJson(unsigned) };
}

export function validateReviewTokenRotationBlockedDeleteAuthority(proof, {
  production, review, accountId, sourceSha, currentMainProof, currentPhaseProof,
  historicalAuthorityProof, blockedIncidentValidation, recoveryCoordinate,
  expectedPlanDigest = digestJson(provisioningSetupPlan(production, review)),
}, now = Date.now(), minimumRemainingMs = blockedReviewTokenDeleteTransitionBudgetMs) {
  const keys = ["accountId", "allowedWrites", "authorizationReceiptPath",
    "blockedIncidentCoordinateDigest", "capturedAt",
    "currentMainProofDigest", "currentPhaseProofDigest", "currentPhaseProofDocumentDigest",
    "exclusions", "expiresAt", "mutation",
    "outcome", "phase", "planDigest", "predecessorReviewTokenUuid",
    "productionBuildTokenUuid", "productionContractDigest", "productionPreservationDigest",
    "productionTriggerUuid", "proof_digest", "recoveryCoordinateDigest",
    "replacementReviewTokenUuid",
    "reviewContractDigest", "reviewTriggerUuid", "sourceSha"];
  const captured = Date.parse(proof?.capturedAt ?? "");
  const expires = Date.parse(proof?.expiresAt ?? "");
  const unsigned = { ...proof };
  delete unsigned.proof_digest;
  if (!proof || !same(sorted(Object.keys(proof)), sorted(keys)) ||
      proof.outcome !== "workers-builds-review-token-rotation-blocked-delete-authority-valid" ||
      proof.mutation !== false || proof.phase !== "blocked-review-token-delete-recovery" ||
      proof.accountId !== accountId || proof.sourceSha !== sourceSha ||
      proof.planDigest !== expectedPlanDigest ||
      proof.productionContractDigest !== digestJson(production) ||
      proof.reviewContractDigest !== digestJson(review) ||
      !Number.isFinite(captured) || !Number.isFinite(expires) ||
      expires - captured !== blockedReviewTokenDeleteAuthorityLifetimeMs ||
      captured > now + 30_000 || now >= expires || expires - now < minimumRemainingMs ||
      proof.proof_digest !== digestJson(unsigned) ||
      !same(proof.allowedWrites,
        ["delete-only-exact-journal-created-globally-unreferenced-replacement-wrapper"]) ||
      !same(proof.exclusions, ["trigger-post-or-patch", "production-trigger-activation",
        "migration-0010", "manual-api-or-initial-production-build",
        "worker-version-deployment-binding-route-domain-schedule-url-state-secret-or-repository-connection-mutation"]))
    fail("review token rotation blocked delete authority drift");
  validateCurrentMainProof(currentMainProof, sourceSha, captured);
  validateBlockedDeleteRecoveryCoordinate(recoveryCoordinate, sourceSha, captured);
  validateHistoricalReviewTokenRotationAuthority(historicalAuthorityProof, { production, review,
    accountId, sourceSha: blockedIncidentValidation?.authoritySourceSha,
    planDigest: blockedIncidentValidation?.authorityPlanDigest });
  validateReviewTokenRotationPhaseProof(currentPhaseProof, "predecessor-restored",
    historicalAuthorityProof, { accountId, sourceSha }, captured, 5 * 60_000);
  if (!blockedIncidentValidation || blockedIncidentValidation.mutation !== false ||
      proof.blockedIncidentCoordinateDigest !==
        blockedIncidentValidation.incidentCoordinateDigest ||
      proof.currentPhaseProofDigest !== currentPhaseProof.proof_digest ||
      proof.currentPhaseProofDocumentDigest !== digestJson(currentPhaseProof) ||
      proof.currentMainProofDigest !== digestJson(currentMainProof) ||
      proof.recoveryCoordinateDigest !== digestJson(recoveryCoordinate) ||
      proof.authorizationReceiptPath !== recoveryCoordinate.authorizationReceiptPath ||
      proof.replacementReviewTokenUuid !== currentPhaseProof.replacementReviewTokenUuid ||
      proof.predecessorReviewTokenUuid !== currentPhaseProof.predecessorReviewTokenUuid ||
      proof.productionBuildTokenUuid !== currentPhaseProof.productionBuildTokenUuid ||
      proof.productionTriggerUuid !== currentPhaseProof.productionTriggerUuid ||
      proof.reviewTriggerUuid !== currentPhaseProof.reviewTriggerUuid ||
      proof.productionPreservationDigest !== currentPhaseProof.productionPreservationDigest)
    fail("review token rotation blocked delete authority evidence drift");
  return { outcome: proof.outcome, mutation: false, expiresAt: proof.expiresAt,
    replacementReviewTokenUuid: proof.replacementReviewTokenUuid,
    request: { method: "DELETE", path: `/builds/tokens/${proof.replacementReviewTokenUuid}`,
      requestDigestSha256: digestJson({ method: "DELETE",
        path: `/builds/tokens/${proof.replacementReviewTokenUuid}`, body: null }) } };
}

async function classifyReviewTokenRotationBlockedDeleteRecoveryPrefixCore(records, authorityProof,
{
  production, review, accountId, sourceSha, currentMainProof, currentPhaseProof,
  historicalAuthorityProof, blockedIncidentValidation, recoveryCoordinate,
  authorizationReceipt = undefined, completeProof = undefined,
  blockedProof = undefined, blockedSnapshotDirectory = undefined,
  productionSentinelProof = undefined, predecessorTokenAuthorityProofs = undefined,
  replacementTokenAuthorityProof = undefined, replacementTokenId = undefined,
  productionBaselineProof = undefined, historicalTerminalValidation = false,
  terminalObservationCurrentMainProof = undefined,
} = {}, now = Date.now()) {
  const operation = "rotation-delete-blocked-replacement-wrapper";
  if (historicalTerminalValidation && ![
    "review-token-rotation-blocked-delete-recovery-complete",
    "review-token-rotation-blocked-delete-recovery-blocked",
  ].includes(records?.at(-1)?.event))
    fail("blocked delete historical validation requires a terminal journal");
  const terminalObservationSourceSha = historicalTerminalValidation ?
    (completeProof?.sourceSha ?? blockedProof?.sourceSha) : sourceSha;
  if (!gitShaPattern.test(terminalObservationSourceSha ?? ""))
    fail("blocked delete terminal observation source drift");
  if (historicalTerminalValidation) validateCurrentMainProof(
    terminalObservationCurrentMainProof, terminalObservationSourceSha,
    Date.parse((completeProof ?? blockedProof)?.capturedAt ?? ""));
  validateReviewTokenRotationBlockedDeleteAuthority(authorityProof, { production, review,
    accountId, sourceSha, currentMainProof, currentPhaseProof, historicalAuthorityProof,
    blockedIncidentValidation, recoveryCoordinate,
    expectedPlanDigest: historicalTerminalValidation ? authorityProof?.planDigest : undefined },
  Date.parse(authorityProof?.capturedAt ?? ""), 0);
  const expected = [
    ["review-token-rotation-blocked-delete-recovery-started", undefined],
    ["current-main-proof-bound", operation],
    ["blocked-delete-authority-checked", operation],
    ["provider-proof-bound", "rotation-prove-blocked-replacement-unreferenced"],
    ["mutation-intent", operation],
    ["provider-response-classified", operation],
    ["mutation-bound", operation],
    ["provider-proof-bound", "rotation-prove-blocked-delete-complete"],
    ["review-token-rotation-blocked-delete-recovery-complete", undefined],
  ];
  if (!Array.isArray(records)) fail("blocked delete recovery journal drift");
  const terminalBlocked = records.at(-1)?.event ===
    "review-token-rotation-blocked-delete-recovery-blocked";
  const pairs = records.map(({ event, operation: recordOperation }) =>
    [event, recordOperation]);
  const compared = terminalBlocked ? pairs.slice(0, -1) : pairs;
  if (!same(compared, expected.slice(0, compared.length)) ||
      compared.length > expected.length || terminalBlocked &&
        (compared.length === 0 || compared.length >= expected.length))
    fail("blocked delete recovery journal sequence drift");
  let previousAt = -Infinity;
  for (const record of records) {
    const { recordSha256, ...payload } = record ?? {};
    const at = Date.parse(record?.at ?? "");
    if (!/^[0-9a-f]{64}$/u.test(recordSha256 ?? "") ||
        digestJson(payload) !== recordSha256 || !isUtcTimestamp(record.at) ||
        !Number.isFinite(at) || at <= previousAt || record.attempt !== 1)
      fail("blocked delete recovery journal checksum or chronology drift");
    previousAt = at;
  }
  if (records.length > 0) {
    const start = records[0];
    const startKeys = ["at", "attempt", "authorityProofDigest",
      "blockedIncidentCoordinateDigest", "event", "recordSha256", "recoveryCoordinateDigest",
      "replacementReviewTokenUuid", "startingPhase"];
    if (!same(sorted(Object.keys(start)), sorted(startKeys)) ||
        start.startingPhase !== "predecessor-restored" ||
        start.authorityProofDigest !== authorityProof.proof_digest ||
        start.blockedIncidentCoordinateDigest !==
          blockedIncidentValidation.incidentCoordinateDigest ||
        start.recoveryCoordinateDigest !== authorityProof.recoveryCoordinateDigest ||
        start.replacementReviewTokenUuid !== authorityProof.replacementReviewTokenUuid ||
        Date.parse(currentPhaseProof.capturedAt) > Date.parse(start.at))
      fail("blocked delete recovery starting coordinate drift");
  }
  const mainRecord = records.find(({ event }) => event === "current-main-proof-bound");
  if (mainRecord) {
    const keys = ["at", "attempt", "capturedAt", "event", "operation", "proofFileSha256",
      "rawFileSha256", "recordSha256", "ref", "sourceSha"];
    const captured = Date.parse(mainRecord.capturedAt ?? "");
    if (!same(sorted(Object.keys(mainRecord)), sorted(keys)) ||
        mainRecord.operation !== operation || mainRecord.sourceSha !== sourceSha ||
        mainRecord.ref !== currentMainRef ||
        mainRecord.proofFileSha256 !== digestJson(currentMainProof) ||
        !/^[0-9a-f]{64}$/u.test(mainRecord.rawFileSha256 ?? "") ||
        mainRecord.capturedAt !== currentMainProof.capturedAt ||
        !isUtcTimestamp(mainRecord.capturedAt) ||
        captured > Date.parse(mainRecord.at) || Date.parse(mainRecord.at) - captured > 5 * 60_000)
      fail("blocked delete recovery current-main binding drift");
  }
  const checked = records.find(({ event }) => event === "blocked-delete-authority-checked");
  if (checked) {
    const checkedKeys = ["at", "attempt", "authorizationReceiptDigest",
      "authorizationReceiptFileSha256", "event", "expiresAt", "operation", "proofDigest",
      "recordSha256"];
    const receiptKeys = ["authorityProofDigest", "capturedAt", "mutation", "operation",
      "outcome", "proof_digest", "recoveryCoordinateDigest", "replacementReviewTokenUuid",
      "requestDigestSha256", "sourceSha"];
    const receiptUnsigned = { ...authorizationReceipt };
    delete receiptUnsigned.proof_digest;
    const receiptAt = Date.parse(authorizationReceipt?.capturedAt ?? "");
    if (!same(sorted(Object.keys(checked)), sorted(checkedKeys)) || !authorizationReceipt ||
        !same(sorted(Object.keys(authorizationReceipt)), sorted(receiptKeys)) ||
        authorizationReceipt.outcome !==
          "workers-builds-review-token-rotation-blocked-delete-write-authorized" ||
        authorizationReceipt.mutation !== false || authorizationReceipt.operation !== "delete" ||
        authorizationReceipt.sourceSha !== sourceSha ||
        authorizationReceipt.authorityProofDigest !== authorityProof.proof_digest ||
        authorizationReceipt.recoveryCoordinateDigest !== authorityProof.recoveryCoordinateDigest ||
        authorizationReceipt.replacementReviewTokenUuid !==
          authorityProof.replacementReviewTokenUuid ||
        authorizationReceipt.requestDigestSha256 !== digestJson({ method: "DELETE",
          path: `/builds/tokens/${authorityProof.replacementReviewTokenUuid}`, body: null }) ||
        authorizationReceipt.proof_digest !== digestJson(receiptUnsigned) ||
        !isUtcTimestamp(authorizationReceipt.capturedAt) || !Number.isFinite(receiptAt) ||
        receiptAt < Date.parse(authorityProof.capturedAt) ||
        receiptAt > Date.parse(checked.at) || Date.parse(checked.at) - receiptAt > 30_000 ||
        receiptAt >= Date.parse(authorityProof.expiresAt))
      fail("blocked delete recovery authorization receipt drift");
  }
  if (checked && (checked.operation !== operation ||
      checked.proofDigest !== authorityProof.proof_digest ||
      checked.expiresAt !== authorityProof.expiresAt ||
      checked.authorizationReceiptDigest !== authorizationReceipt.proof_digest ||
      checked.authorizationReceiptFileSha256 !== digestJson(authorizationReceipt) ||
      Date.parse(checked.at) < Date.parse(authorityProof.capturedAt) ||
      Date.parse(authorityProof.expiresAt) - Date.parse(checked.at) <
        blockedReviewTokenDeleteTransitionBudgetMs))
    fail("blocked delete recovery authority binding drift");
  const unreferencedBound = records.find(({ event, operation: recordOperation }) =>
    event === "provider-proof-bound" &&
    recordOperation === "rotation-prove-blocked-replacement-unreferenced");
  if (unreferencedBound && (!same(sorted(Object.keys(unreferencedBound)), sorted([
    "at", "attempt", "event", "operation", "proofDigest", "proofFileSha256", "recordSha256",
  ])) || unreferencedBound.proofDigest !== currentPhaseProof.proof_digest ||
      unreferencedBound.proofFileSha256 !== digestJson(currentPhaseProof) ||
      Date.parse(currentPhaseProof.capturedAt) > Date.parse(unreferencedBound.at) ||
      Date.parse(unreferencedBound.at) - Date.parse(currentPhaseProof.capturedAt) > 30_000))
    fail("blocked delete recovery unreferenced proof binding drift");
  const intent = records.find(({ event }) => event === "mutation-intent");
  const classified = records.find(({ event }) => event === "provider-response-classified");
  const bound = records.find(({ event }) => event === "mutation-bound");
  const request = { method: "DELETE",
    path: `/builds/tokens/${authorityProof.replacementReviewTokenUuid}` };
  request.requestDigestSha256 = digestJson({ ...request, body: null });
  if (intent && (!same(sorted(Object.keys(intent)), sorted([
    "at", "attempt", "event", "method", "operation", "path", "recordSha256",
    "requestDigestSha256",
  ])) || intent.operation !== operation || intent.method !== request.method ||
      intent.path !== request.path || intent.requestDigestSha256 !== request.requestDigestSha256 ||
      Date.parse(checked?.at ?? "") > Date.parse(intent.at) ||
      Date.parse(intent.at) - Date.parse(checked?.at ?? "") > 30_000 ||
      Date.parse(unreferencedBound?.at ?? "") > Date.parse(intent.at) ||
      Date.parse(intent.at) - Date.parse(unreferencedBound?.at ?? "") > 30_000 ||
      Date.parse(intent.at) - Date.parse(mainRecord?.capturedAt ?? "") > 5 * 60_000 ||
      Date.parse(intent.at) >= Date.parse(authorityProof.expiresAt)))
    fail("blocked delete recovery intent drift");
  if (classified) {
    const explicitFailure = classified.outcome === "explicit-failure";
    const classifiedKeys = explicitFailure ? ["at", "attempt", "event", "operation", "outcome",
      "recordSha256", "responseDigestSha256", "status"] :
      ["at", "attempt", "event", "operation", "outcome", "recordSha256"];
    if (!same(sorted(Object.keys(classified)), sorted(classifiedKeys)) ||
        classified.operation !== operation ||
        !["explicit-success", "explicit-failure", "ambiguous"].includes(classified.outcome) ||
        Date.parse(intent?.at ?? "") > Date.parse(classified.at) ||
        (explicitFailure && (!Number.isSafeInteger(classified.status) ||
          classified.status < 400 || classified.status > 599 ||
          !/^[0-9a-f]{64}$/u.test(classified.responseDigestSha256 ?? ""))))
      fail("blocked delete recovery provider classification drift");
  }
  if (bound) {
    const explicit = classified?.outcome === "explicit-success";
    const boundKeys = ["at", "attempt", "deletionTombstone", "event", "operation",
      "providerResponseExplicitSuccess", "readbackDigestSha256", "reconciliation",
      "recordSha256", "requestDigestSha256", "resourceUuid"];
    if (!same(sorted(Object.keys(bound)), sorted(boundKeys)) ||
        !classified || classified.outcome === "explicit-failure" ||
        bound.operation !== operation ||
        bound.resourceUuid !== authorityProof.replacementReviewTokenUuid ||
        bound.requestDigestSha256 !== request.requestDigestSha256 ||
        bound.providerResponseExplicitSuccess !== explicit ||
        bound.reconciliation !== (explicit ? "explicit-success-exact-absence" :
          "ambiguous-exact-absence") || bound.deletionTombstone !== true ||
        !/^[0-9a-f]{64}$/u.test(bound.readbackDigestSha256 ?? "") ||
        Date.parse(classified.at) > Date.parse(bound.at) ||
        Date.parse(bound.at) >= Date.parse(authorityProof.expiresAt))
      fail("blocked delete recovery deletion tombstone drift");
  }
  const completeBound = records.find(({ event, operation: recordOperation }) =>
    event === "provider-proof-bound" &&
    recordOperation === "rotation-prove-blocked-delete-complete");
  if (completeBound) {
    if (!same(sorted(Object.keys(completeBound)), sorted([
      "at", "attempt", "currentMainProofDigest", "currentMainRawDigestSha256", "event",
      "observationSourceSha", "operation", "proofDigest", "proofFileSha256", "recordSha256",
    ]))) fail("blocked delete recovery complete proof binding drift");
    validateReviewTokenRotationPredecessorProof(completeProof, historicalAuthorityProof,
      { accountId, sourceSha: terminalObservationSourceSha },
    Date.parse(completeBound.at), Infinity);
    if (!bound || completeBound.proofDigest !== completeProof.proof_digest ||
        completeBound.proofFileSha256 !== digestJson(completeProof) ||
        completeBound.observationSourceSha !== terminalObservationSourceSha ||
        completeBound.currentMainProofDigest !== digestJson(
          terminalObservationCurrentMainProof) ||
        completeBound.currentMainRawDigestSha256 !== digestJson(
          terminalObservationCurrentMainProof?.raw) ||
        Date.parse(bound.at) > Date.parse(completeProof.capturedAt) ||
        Date.parse(completeProof.capturedAt) > Date.parse(completeBound.at))
      fail("blocked delete recovery complete proof binding drift");
  }
  if (terminalBlocked) {
    const terminal = records.at(-1);
    const terminalKeys = ["at", "attempt", "event", "manualApiOrInitialProductionBuild",
      "migration0010", "mutation", "outcome", "productionActivation", "recordSha256",
      "residualProofDigest", "residualProofFileSha256", "residualSnapshotManifestSha256",
      "residualState", "terminalObservationCurrentMainProofDigest",
      "terminalObservationCurrentMainRawDigestSha256", "terminalObservationSourceSha",
      "triggerPostOrPatch", "workerResourceMutation"];
    const residualKeys = ["activeMutation", "liveProductionTokenReference",
      "liveReviewTokenReference", "predecessorWrapperPresent", "replacementWrapperPresent"];
    const phase = terminal.residualState?.replacementWrapperPresent === true ?
      "predecessor-restored" : "predecessor";
    if (!same(sorted(Object.keys(terminal)), sorted(terminalKeys)) ||
        !same(sorted(Object.keys(terminal.residualState ?? {})), sorted(residualKeys)) ||
        terminal.outcome !== "blocked" || terminal.mutation !== false ||
        terminal.triggerPostOrPatch !== false || terminal.productionActivation !== false ||
        terminal.migration0010 !== false ||
        terminal.manualApiOrInitialProductionBuild !== false ||
        terminal.workerResourceMutation !== false ||
        terminal.terminalObservationSourceSha !== terminalObservationSourceSha ||
        terminal.terminalObservationCurrentMainProofDigest !== digestJson(
          terminalObservationCurrentMainProof) ||
        terminal.terminalObservationCurrentMainRawDigestSha256 !== digestJson(
          terminalObservationCurrentMainProof?.raw) ||
        typeof terminal.residualState.replacementWrapperPresent !== "boolean" ||
        typeof terminal.residualState.predecessorWrapperPresent !== "boolean" ||
        (bound && terminal.residualState.replacementWrapperPresent !== false) ||
        ((!intent || classified?.outcome === "explicit-failure") &&
          terminal.residualState.replacementWrapperPresent !== true) ||
        !["predecessor-restored", "predecessor"].includes(phase) ||
        terminal.residualState?.liveProductionTokenReference !==
          authorityProof.predecessorReviewTokenUuid ||
        terminal.residualState?.liveReviewTokenReference !==
          authorityProof.predecessorReviewTokenUuid ||
        terminal.residualState?.predecessorWrapperPresent !== true ||
        terminal.residualState?.activeMutation !== (intent && !bound &&
          classified?.outcome !== "explicit-failure" ? operation : null) ||
        terminal.residualProofDigest !== blockedProof?.proof_digest ||
        terminal.residualProofFileSha256 !== digestJson(blockedProof))
      fail("blocked delete recovery residual terminal drift");
    const manifest = await loadSnapshot(blockedSnapshotDirectory, "snapshot-manifest.json");
    validateReviewTokenRotationBlockedDeleteResidualChronology({
      prefixAt: records.at(-2)?.at, snapshotStartedAt: manifest?.startedAt,
      snapshotCompletedAt: manifest?.completedAt, proofCapturedAt: blockedProof?.capturedAt,
      terminalAt: terminal.at,
    });
    if (terminal.residualSnapshotManifestSha256 !== await readPrivateFileSha256(
          resolve(blockedSnapshotDirectory, "snapshot-manifest.json"),
          "blocked delete recovery residual snapshot manifest"))
      fail("blocked delete recovery residual chronology drift");
    const result = await validateReviewTokenRotationSnapshotDirectory({
      snapshotDirectory: blockedSnapshotDirectory, production, review, accountId,
      sourceSha: terminalObservationSourceSha,
      phase, productionSentinelProof, predecessorTokenAuthorityProofs,
      replacementTokenAuthorityProof, replacementTokenId,
      productionTriggerUuid: authorityProof.productionTriggerUuid,
      reviewTriggerUuid: authorityProof.reviewTriggerUuid,
      predecessorReviewTokenUuid: authorityProof.predecessorReviewTokenUuid,
      replacementReviewTokenUuid: phase === "predecessor-restored" ?
        authorityProof.replacementReviewTokenUuid : undefined,
      productionPreservationDigest: authorityProof.productionPreservationDigest,
      authorityProof: historicalAuthorityProof, productionBaselineProof,
      authoritySourceSha: historicalAuthorityProof.sourceSha,
      authorityPlanDigest: historicalAuthorityProof.planDigest,
      now: Date.parse(blockedProof.capturedAt),
    });
    if (result.proof_digest !== blockedProof.proof_digest ||
        digestJson(result) !== digestJson(blockedProof))
      fail("blocked delete recovery residual snapshot drift");
    return { outcome: "workers-builds-review-token-rotation-blocked-delete-prefix-valid",
      mutation: false, terminal: true, nextEvent: null, reconcile: false };
  }
  if (records.at(-1)?.event ===
      "review-token-rotation-blocked-delete-recovery-complete") {
    const terminal = records.at(-1);
    const terminalKeys = ["at", "attempt", "event", "manualApiOrInitialProductionBuild",
      "migration0010", "mutation", "outcome", "productionActivation", "proofDigest",
      "proofFileSha256", "recordSha256", "triggerPostOrPatch", "workerResourceMutation"];
    if (!same(sorted(Object.keys(terminal)), sorted(terminalKeys)) ||
        terminal.outcome !== "complete" || terminal.mutation !== false ||
        terminal.triggerPostOrPatch !== false || terminal.productionActivation !== false ||
        terminal.migration0010 !== false ||
        terminal.manualApiOrInitialProductionBuild !== false ||
        terminal.workerResourceMutation !== false || !completeBound ||
        terminal.proofDigest !== completeProof.proof_digest ||
        terminal.proofFileSha256 !== digestJson(completeProof))
      fail("blocked delete recovery terminal proof drift");
    return { outcome: "workers-builds-review-token-rotation-blocked-delete-prefix-valid",
      mutation: false, terminal: true, nextEvent: null, reconcile: false };
  }
  if (classified?.outcome === "explicit-failure") return {
    outcome: "workers-builds-review-token-rotation-blocked-delete-prefix-valid",
    mutation: false, terminal: false,
    nextEvent: "review-token-rotation-blocked-delete-recovery-blocked", reconcile: false };
  if (classified && !bound) return {
    outcome: "workers-builds-review-token-rotation-blocked-delete-prefix-valid",
    mutation: false, terminal: false, nextEvent: "mutation-bound", reconcile: true };
  const next = expected[records.length];
  return { outcome: "workers-builds-review-token-rotation-blocked-delete-prefix-valid",
    mutation: false, terminal: !next, nextEvent: next?.[0] ?? null,
    nextOperation: next?.[1] ?? null,
    reconcile: records.at(-1)?.event === "mutation-intent" };
}

export async function classifyReviewTokenRotationBlockedDeleteRecoveryPrefix(records,
authorityProof, arguments_ = {}, now = Date.now()) {
  return classifyReviewTokenRotationBlockedDeleteRecoveryPrefixCore(records, authorityProof,
    arguments_, now);
}

export async function validateReviewTokenRotationBlockedDeleteRecoveryJournal(records,
authorityProof, arguments_ = {}, now = Date.now()) {
  const result = await classifyReviewTokenRotationBlockedDeleteRecoveryPrefixCore(records,
    authorityProof, arguments_, now);
  if (!result.terminal || !["review-token-rotation-blocked-delete-recovery-complete",
    "review-token-rotation-blocked-delete-recovery-blocked"].includes(records.at(-1)?.event))
    fail("blocked delete recovery journal is not terminal");
  return { outcome: "workers-builds-review-token-rotation-blocked-delete-journal-valid",
    mutation: false, terminal: records.at(-1).event,
    proof_digest: records.at(-1).proofDigest ?? records.at(-1).residualProofDigest };
}

export function validateReviewTokenRotationJournal(records, terminalProof, authorityProof, {
  production, review, accountId, sourceSha, preCreateProof, preProductionProof,
  intermediateProof, unreferencedProof, rotationAttemptCoordinate },
now = Date.now()) {
  validateHistoricalReviewTokenRotationAuthority(authorityProof,
    { production, review, accountId, sourceSha });
  if (!["production-repointed", "production-repointed-review-augmented"]
    .includes(intermediateProof?.phase))
    fail("review token rotation intermediate provider disposition drift");
  validateReviewTokenRotationPhaseProof(intermediateProof, intermediateProof.phase,
    authorityProof, { accountId, sourceSha }, now, Infinity);
  validateReviewTokenRotationPhaseProof(unreferencedProof, "old-wrapper-unreferenced",
    authorityProof, { accountId, sourceSha }, now, Infinity);
  validateReviewTokenRotationPredecessorProof(preCreateProof, authorityProof,
    { accountId, sourceSha }, now, Infinity);
  validateReviewTokenRotationPhaseProof(preProductionProof, "replacement-created",
    authorityProof, { accountId, sourceSha }, now, Infinity);
  validateReviewTokenRotationAttemptCoordinate(rotationAttemptCoordinate, sourceSha,
    { executorSha256: rotationAttemptCoordinate?.executorSha256,
      initialJournalSha256: rotationAttemptCoordinate?.initialJournalSha256,
      journalPathSha256: rotationAttemptCoordinate?.journalPathSha256 },
    Date.parse(authorityProof.capturedAt));
  if (authorityProof.evidenceDigests?.rotationAttempt !==
      digestJson(rotationAttemptCoordinate))
    fail("review token rotation attempt authority binding drift");
  validateReviewTokenRotationTerminalProof(terminalProof,
    { accountId, sourceSha, authorityProof }, now, Infinity);
  const forwardExpected = [
    ["attempt-started", "review-token-rotation"],
    ["rotation-authorized", undefined],
    ["current-main-proof-bound", "replacement-review-build-token"],
    ["review-token-rotation-authority-checked", "replacement-review-build-token"],
    ["provider-proof-bound", "prove-replacement-create-precondition"],
    ["mutation-intent", "replacement-review-build-token"],
    ["provider-response-classified", "replacement-review-build-token"],
    ["mutation-bound", "replacement-review-build-token"],
    ["current-main-proof-bound", "repoint-inert-production-trigger"],
    ["review-token-rotation-authority-checked", "repoint-inert-production-trigger"],
    ["provider-proof-bound", "prove-production-repoint-precondition"],
    ["mutation-intent", "repoint-inert-production-trigger"],
    ["provider-response-classified", "repoint-inert-production-trigger"],
    ["mutation-bound", "repoint-inert-production-trigger"],
    ["current-main-proof-bound", "repoint-final-review-trigger"],
    ["review-token-rotation-authority-checked", "repoint-final-review-trigger"],
    ["provider-proof-bound", "prove-production-repointed-review-still-predecessor"],
    ["mutation-intent", "repoint-final-review-trigger"],
    ["provider-response-classified", "repoint-final-review-trigger"],
    ["mutation-bound", "repoint-final-review-trigger"],
    ["current-main-proof-bound", "retire-superseded-review-build-token"],
    ["review-token-rotation-authority-checked", "retire-superseded-review-build-token"],
    ["provider-proof-bound", "prove-superseded-wrapper-unreferenced"],
    ["mutation-intent", "retire-superseded-review-build-token"],
    ["provider-response-classified", "retire-superseded-review-build-token"],
    ["mutation-bound", "retire-superseded-review-build-token"],
    ["provider-proof-bound", "review-token-rotation-readback"],
    ["review-token-rotation-complete", undefined],
  ];
  const recoveryStartIndex = Array.isArray(records) ? records.findIndex(({ event }) =>
    event === "review-token-rotation-complete-recovery-started") : -1;
  const recovered = recoveryStartIndex !== -1;
  const recoveryExpected = [
    ["review-token-rotation-complete-recovery-started", undefined],
    ["provider-proof-bound", "review-token-rotation-recovery-readback"],
    ["deletion-recovery-bound", "retire-superseded-review-build-token"],
    ["review-token-rotation-complete-recovered", undefined],
  ];
  const actualPairs = Array.isArray(records) ? records.map(({ event, operation }) =>
    [event, operation]) : [];
  const recoveryMinimumPrefixLength = forwardExpected.findIndex(([event, operation]) =>
    event === "mutation-intent" && operation === "retire-superseded-review-build-token") + 1;
  const recoveryMaximumPrefixLength = forwardExpected.findIndex(([event, operation]) =>
    event === "provider-proof-bound" && operation === "review-token-rotation-readback");
  if (!Array.isArray(records) || (!recovered && !same(actualPairs, forwardExpected)) ||
      recovered && (recoveryStartIndex < recoveryMinimumPrefixLength ||
        recoveryStartIndex > recoveryMaximumPrefixLength ||
        !same(actualPairs.slice(0, recoveryStartIndex),
          forwardExpected.slice(0, recoveryStartIndex)) ||
        !same(actualPairs.slice(recoveryStartIndex), recoveryExpected)))
    fail("review token rotation journal operation sequence drift");
  let previousAt = -Infinity;
  for (const record of records) {
    const { recordSha256, ...payload } = record ?? {};
    const at = Date.parse(record?.at ?? "");
    if (!/^[0-9a-f]{64}$/u.test(recordSha256 ?? "") || digestJson(payload) !== recordSha256 ||
        !Number.isFinite(at) || !isUtcTimestamp(record.at) || at <= previousAt ||
        record.attempt !== 1) fail("review token rotation journal checksum drift");
    previousAt = at;
  }
  const identity = authorityProof?.journalIdentities ?? {};
  const replacement = terminalProof?.replacementReviewTokenUuid;
  const mutation = (event, operation) => records.find((record) =>
    record.event === event && record.operation === operation);
  const semantics = [
    ["replacement-review-build-token", replacement],
    ["repoint-inert-production-trigger", identity.productionTriggerUuid],
    ["repoint-final-review-trigger", identity.reviewTriggerUuid],
    ["retire-superseded-review-build-token", identity.predecessorReviewBuildTokenUuid],
  ];
  const mutationsValid = semantics.every(([operation, resourceUuid], operationIndex) => {
    const intent = mutation("mutation-intent", operation);
    const classified = mutation("provider-response-classified", operation);
    const bound = mutation("mutation-bound", operation);
    const expectedRequest = reviewTokenRotationRequestDigest({ production, review,
      authorityProof, operation, replacementReviewTokenUuid: replacement });
    const explicit = classified?.outcome === "explicit-success";
    const ambiguous = classified?.outcome === "ambiguous";
    const recoveryDelete = recovered && operationIndex === semantics.length - 1;
    return intent?.method === expectedRequest.method && intent.path === expectedRequest.path &&
      intent.requestDigestSha256 === expectedRequest.requestDigestSha256 &&
      (recoveryDelete ? (!classified || explicit || ambiguous) : (explicit || ambiguous)) &&
      (!explicit || operation !== "replacement-review-build-token" ||
        classified.resourceUuid === resourceUuid) && (recoveryDelete && !bound ||
        bound?.resourceUuid === resourceUuid &&
        bound.providerResponseExplicitSuccess === explicit &&
        bound.reconciliation === (operation === "retire-superseded-review-build-token" ?
          (explicit ? "explicit-success-exact-absence" : "ambiguous-exact-absence") :
          (explicit ? "explicit-success-exact-readback" : "ambiguous-exact-readback")) &&
        (operation !== "retire-superseded-review-build-token" ||
          bound.deletionTombstone === true) &&
        bound.requestDigestSha256 === intent.requestDigestSha256 &&
        /^[0-9a-f]{64}$/u.test(bound.readbackDigestSha256 ?? ""));
  });
  const terminal = records.at(-1);
  const proofBound = mutation("provider-proof-bound", recovered ?
    "review-token-rotation-recovery-readback" : "review-token-rotation-readback");
  const intermediateBound = mutation("provider-proof-bound",
    "prove-production-repointed-review-still-predecessor");
  const preCreateBound = mutation("provider-proof-bound", "prove-replacement-create-precondition");
  const preProductionBound = mutation("provider-proof-bound",
    "prove-production-repoint-precondition");
  const unreferencedBound = mutation("provider-proof-bound",
    "prove-superseded-wrapper-unreferenced");
  const authorityChecks = records.filter(({ event }) =>
    event === "review-token-rotation-authority-checked");
  const currentMainChecks = records.filter(({ event }) => event === "current-main-proof-bound");
  const currentMainValid = currentMainChecks.length === 4 && currentMainChecks.every((record) => {
    const captured = Date.parse(record.capturedAt ?? "");
    const at = Date.parse(record.at ?? "");
    return record.sourceSha === sourceSha && record.ref === "refs/heads/main" &&
      /^[0-9a-f]{64}$/u.test(record.proofFileSha256 ?? "") &&
      /^[0-9a-f]{64}$/u.test(record.rawFileSha256 ?? "") &&
      isUtcTimestamp(record.capturedAt) && captured <= at && at - captured <= 5 * 60_000;
  });
  const operationChronologyValid = semantics.every(([operation], operationIndex) => {
    const main = mutation("current-main-proof-bound", operation);
    const checked = mutation("review-token-rotation-authority-checked", operation);
    const intent = mutation("mutation-intent", operation);
    const classified = mutation("provider-response-classified", operation);
    const bound = mutation("mutation-bound", operation);
    const recoveryDelete = recovered && operationIndex === semantics.length - 1;
    return Date.parse(main?.at ?? "") <= Date.parse(checked?.at ?? "") &&
      Date.parse(checked?.at ?? "") <= Date.parse(intent?.at ?? "") &&
      (recoveryDelete ? (!classified || Date.parse(intent.at) <= Date.parse(classified.at)) &&
        (!bound || classified && Date.parse(classified.at) <= Date.parse(bound.at) &&
          Date.parse(bound.at) < Date.parse(authorityProof.expiresAt)) :
        Date.parse(intent?.at ?? "") <= Date.parse(classified?.at ?? "") &&
        Date.parse(classified?.at ?? "") <= Date.parse(bound?.at ?? "") &&
        Date.parse(bound?.at ?? "") < Date.parse(authorityProof.expiresAt));
  });
  const proofChronologyValid = [
    [null, preCreateProof, "prove-replacement-create-precondition"],
    ["replacement-review-build-token", preProductionProof,
      "prove-production-repoint-precondition"],
    ["repoint-inert-production-trigger", intermediateProof,
      "prove-production-repointed-review-still-predecessor"],
    ["repoint-final-review-trigger", unreferencedProof,
      "prove-superseded-wrapper-unreferenced"],
    ...(recovered ? [] : [["retire-superseded-review-build-token", terminalProof,
      "review-token-rotation-readback"]]),
  ].every(([mutationOperation, proof, proofOperation]) =>
    (mutationOperation === null ? Date.parse(records[1]?.at ?? "") :
      Date.parse(mutation("mutation-bound", mutationOperation)?.at ?? "")) <=
      Date.parse(proof?.capturedAt ?? "") &&
    Date.parse(proof?.capturedAt ?? "") <=
      Date.parse(mutation("provider-proof-bound", proofOperation)?.at ?? ""));
  const retireIntent = mutation("mutation-intent", "retire-superseded-review-build-token");
  const preMutationChronologyValid = [
    ["replacement-review-build-token", preCreateProof, preCreateBound],
    ["repoint-inert-production-trigger", preProductionProof, preProductionBound],
    ["repoint-final-review-trigger", intermediateProof, intermediateBound],
  ].every(([operation, proof, bound]) => {
    const main = mutation("current-main-proof-bound", operation);
    const checked = mutation("review-token-rotation-authority-checked", operation);
    const intent = mutation("mutation-intent", operation);
    return reviewTokenRotationRollbackProofChronologyValid({
      currentMainAt: main?.at, authorityAt: checked?.at,
      proofCapturedAt: proof?.capturedAt, proofBoundAt: bound?.at,
      intentAt: intent?.at,
    });
  });
  let unreferencedDeleteChronologyValid = true;
  try {
    validateReviewTokenRotationDeleteProofChronology(unreferencedProof,
      unreferencedBound, retireIntent);
  } catch {
    unreferencedDeleteChronologyValid = false;
  }
  const recoveryStart = recovered ? records[recoveryStartIndex] : null;
  const recoveryBound = recovered ? mutation("deletion-recovery-bound",
    "retire-superseded-review-build-token") : null;
  const recoveryStartKeys = ["at", "attempt", "authorityProofDigest", "event",
    "predecessorReviewTokenUuid", "providerMutation", "recordSha256",
    "replacementReviewTokenUuid"];
  const recoveryProofBoundKeys = ["at", "attempt", "event", "operation", "proofDigest",
    "proofFileSha256", "recordSha256"];
  const recoveryBoundKeys = ["at", "attempt", "authorityProofDigest", "deletionTombstone",
    "event", "operation", "proofDigest", "proofFileSha256", "providerMutation",
    "readbackDigestSha256", "reconciliation", "recordSha256", "requestDigestSha256",
    "resourceUuid"];
  const recoveredTerminalKeys = ["at", "attempt", "event", "historicalAuthorityRecovery",
    "initialProductionBuild", "migration0010", "predecessorReviewTokenUuid",
    "productionActivation", "productionPreservationDigest", "productionTriggerUuid",
    "proofDigest", "providerMutation", "recordSha256",
    "replacementReviewTokenUuid", "replacementTokenOwnerMembershipProofDigest",
    "reviewTriggerUuid"];
  const recoveryValid = !recovered ||
      same(sorted(Object.keys(recoveryStart ?? {})), sorted(recoveryStartKeys)) &&
      same(sorted(Object.keys(proofBound ?? {})), sorted(recoveryProofBoundKeys)) &&
      same(sorted(Object.keys(recoveryBound ?? {})), sorted(recoveryBoundKeys)) &&
      same(sorted(Object.keys(terminal ?? {})), sorted(recoveredTerminalKeys)) &&
      recoveryStart?.authorityProofDigest ===
      authorityProof.proof_digest && recoveryStart.predecessorReviewTokenUuid ===
      identity.predecessorReviewBuildTokenUuid && recoveryStart.replacementReviewTokenUuid ===
      replacement && recoveryStart.providerMutation === false &&
      Date.parse(recoveryStart.at) >= Date.parse(authorityProof.expiresAt) &&
      proofBound?.proofDigest === terminalProof?.proof_digest &&
      proofBound?.proofFileSha256 === digestJson(terminalProof) &&
      Date.parse(recoveryStart.at) <= Date.parse(terminalProof?.capturedAt ?? "") &&
      Date.parse(terminalProof?.capturedAt ?? "") <= Date.parse(proofBound?.at ?? "") &&
      recoveryBound?.authorityProofDigest === authorityProof.proof_digest &&
      recoveryBound?.requestDigestSha256 === retireIntent?.requestDigestSha256 &&
      recoveryBound?.resourceUuid === identity.predecessorReviewBuildTokenUuid &&
      recoveryBound?.proofDigest === terminalProof?.proof_digest &&
      recoveryBound?.proofFileSha256 === digestJson(terminalProof) &&
      recoveryBound?.readbackDigestSha256 === terminalProof?.proof_digest &&
      recoveryBound?.reconciliation === "historical-authority-exact-absence" &&
      recoveryBound?.deletionTombstone === true && recoveryBound?.providerMutation === false &&
      Date.parse(proofBound?.at ?? "") <= Date.parse(recoveryBound?.at ?? "");
  if (!mutationsValid || records.some(({ event }) => event.startsWith("rollback")) ||
      records[1]?.authorityProofDigest !== authorityProof?.proof_digest ||
      !currentMainValid || !operationChronologyValid || !proofChronologyValid ||
      !preMutationChronologyValid || !unreferencedDeleteChronologyValid || !recoveryValid ||
      records[0]?.attemptCoordinateDigest !== rotationAttemptCoordinate.proof_digest ||
      records[0]?.attemptNamespace !== rotationAttemptCoordinate.attemptNamespace ||
      records[0]?.executorSha256 !== rotationAttemptCoordinate.executorSha256 ||
      records[0]?.journalId !== rotationAttemptCoordinate.journalId ||
      records[0]?.journalPathSha256 !== rotationAttemptCoordinate.journalPathSha256 ||
      authorityChecks.length !== 4 || authorityChecks.some(({ proofDigest }) =>
        proofDigest !== authorityProof?.proof_digest) || authorityChecks.some((record) =>
        record.expiresAt !== authorityProof.expiresAt ||
        Date.parse(record.at) < Date.parse(authorityProof.capturedAt) ||
        Date.parse(authorityProof.expiresAt) - Date.parse(record.at) <
          reviewTokenRotationTransitionBudgetMs) ||
      intermediateBound?.proofDigest !== intermediateProof.proof_digest ||
      intermediateBound?.proofFileSha256 !== digestJson(intermediateProof) ||
      preCreateBound?.proofDigest !== preCreateProof.proof_digest ||
      preCreateBound?.proofFileSha256 !== digestJson(preCreateProof) ||
      preProductionBound?.proofDigest !== preProductionProof.proof_digest ||
      preProductionBound?.proofFileSha256 !== digestJson(preProductionProof) ||
      unreferencedBound?.proofDigest !== unreferencedProof.proof_digest ||
      unreferencedBound?.proofFileSha256 !== digestJson(unreferencedProof) ||
      proofBound?.proofDigest !== terminalProof?.proof_digest ||
      proofBound?.proofFileSha256 !== digestJson(terminalProof) ||
      terminal?.proofDigest !== terminalProof?.proof_digest ||
      terminal?.productionTriggerUuid !== identity.productionTriggerUuid ||
      terminal?.reviewTriggerUuid !== identity.reviewTriggerUuid ||
      terminal?.predecessorReviewTokenUuid !== identity.predecessorReviewBuildTokenUuid ||
      terminal?.replacementReviewTokenUuid !== replacement ||
      terminal?.productionPreservationDigest !== authorityProof.productionPreservationDigest ||
      terminal?.replacementTokenOwnerMembershipProofDigest !==
        authorityProof.evidenceDigests.replacementTokenOwnerMembership ||
      terminal?.productionActivation !== false || terminal?.migration0010 !== false ||
      terminal?.initialProductionBuild !== false ||
      Date.parse(terminalProof?.capturedAt ?? "") > Date.parse(proofBound?.at ?? "") ||
      Date.parse(proofBound?.at ?? "") > Date.parse(terminal?.at ?? "") ||
      recovered && (terminal?.event !== "review-token-rotation-complete-recovered" ||
        terminal?.historicalAuthorityRecovery !== true || terminal?.providerMutation !== false ||
        Date.parse(recoveryBound?.at ?? "") > Date.parse(terminal?.at ?? "")))
    fail("review token rotation journal terminal provenance drift");
  return { digest: digestJson(records), terminalAt: terminal.at,
    productionTriggerUuid: identity.productionTriggerUuid,
    reviewTriggerUuid: identity.reviewTriggerUuid,
    productionBuildTokenUuid: terminalProof.productionBuildTokenUuid,
    predecessorReviewTokenUuid: identity.predecessorReviewBuildTokenUuid,
    replacementReviewTokenUuid: replacement,
    replacementTokenOwnerMembershipProofDigest:
      authorityProof.evidenceDigests.replacementTokenOwnerMembership,
    productionPreservationDigest: authorityProof.productionPreservationDigest,
    repositoryConnectionUuid: identity.repositoryConnectionUuid };
}

export function classifyReviewTokenRotationCompleteRecoveryPrefix(records, terminalProof,
authorityProof, { production, review, accountId, sourceSha, intermediateProof,
  preCreateProof, preProductionProof, unreferencedProof, rotationAttemptCoordinate },
now = Date.now()) {
  validateHistoricalReviewTokenRotationAuthority(authorityProof,
    { production, review, accountId, sourceSha });
  if (!Number.isFinite(now) || now < Date.parse(authorityProof.expiresAt))
    fail("review token rotation recovery prefix authority remains active");
  const forwardExpected = [
    ["attempt-started", "review-token-rotation"],
    ["rotation-authorized", undefined],
    ["current-main-proof-bound", "replacement-review-build-token"],
    ["review-token-rotation-authority-checked", "replacement-review-build-token"],
    ["provider-proof-bound", "prove-replacement-create-precondition"],
    ["mutation-intent", "replacement-review-build-token"],
    ["provider-response-classified", "replacement-review-build-token"],
    ["mutation-bound", "replacement-review-build-token"],
    ["current-main-proof-bound", "repoint-inert-production-trigger"],
    ["review-token-rotation-authority-checked", "repoint-inert-production-trigger"],
    ["provider-proof-bound", "prove-production-repoint-precondition"],
    ["mutation-intent", "repoint-inert-production-trigger"],
    ["provider-response-classified", "repoint-inert-production-trigger"],
    ["mutation-bound", "repoint-inert-production-trigger"],
    ["current-main-proof-bound", "repoint-final-review-trigger"],
    ["review-token-rotation-authority-checked", "repoint-final-review-trigger"],
    ["provider-proof-bound", "prove-production-repointed-review-still-predecessor"],
    ["mutation-intent", "repoint-final-review-trigger"],
    ["provider-response-classified", "repoint-final-review-trigger"],
    ["mutation-bound", "repoint-final-review-trigger"],
    ["current-main-proof-bound", "retire-superseded-review-build-token"],
    ["review-token-rotation-authority-checked", "retire-superseded-review-build-token"],
    ["provider-proof-bound", "prove-superseded-wrapper-unreferenced"],
    ["mutation-intent", "retire-superseded-review-build-token"],
    ["provider-response-classified", "retire-superseded-review-build-token"],
    ["mutation-bound", "retire-superseded-review-build-token"],
  ];
  const recoveryExpected = [
    ["review-token-rotation-complete-recovery-started", undefined],
    ["provider-proof-bound", "review-token-rotation-recovery-readback"],
    ["deletion-recovery-bound", "retire-superseded-review-build-token"],
    ["review-token-rotation-complete-recovered", undefined],
  ];
  const recoveryIndex = records.findIndex(({ event }) =>
    event === "review-token-rotation-complete-recovery-started");
  const originalLength = recoveryIndex === -1 ? records.length : recoveryIndex;
  const recoveryRecords = recoveryIndex === -1 ? [] : records.slice(recoveryIndex);
  const pairs = records.slice(0, originalLength).map(({ event, operation }) =>
    [event, operation]);
  const recoveryPairs = recoveryRecords.map(({ event, operation }) => [event, operation]);
  const deleteIntentIndex = forwardExpected.findIndex(([event, operation]) =>
    event === "mutation-intent" && operation === "retire-superseded-review-build-token");
  if (![deleteIntentIndex + 1, deleteIntentIndex + 2, deleteIntentIndex + 3]
    .includes(originalLength) ||
      !same(pairs, forwardExpected.slice(0, originalLength)) ||
      recoveryRecords.length > recoveryExpected.length ||
      !same(recoveryPairs, recoveryExpected.slice(0, recoveryRecords.length)))
    fail("review token rotation recovery prefix drift");
  let previousAt = -Infinity;
  for (const record of records) {
    const { recordSha256, ...payload } = record ?? {};
    const at = Date.parse(record?.at ?? "");
    if (!/^[0-9a-f]{64}$/u.test(recordSha256 ?? "") || digestJson(payload) !== recordSha256 ||
        !isUtcTimestamp(record.at) || !Number.isFinite(at) || at <= previousAt ||
        record.attempt !== 1) fail("review token rotation recovery prefix checksum drift");
    previousAt = at;
  }
  const identity = authorityProof.journalIdentities;
  const replacementReviewTokenUuid = records.find(({ event, operation }) =>
    event === "mutation-bound" && operation === "replacement-review-build-token")?.resourceUuid;
  if (!uuidPattern.test(replacementReviewTokenUuid ?? ""))
    fail("review token rotation recovery prefix replacement identity drift");
  if (!["production-repointed", "production-repointed-review-augmented"]
    .includes(intermediateProof?.phase))
    fail("review token rotation recovery prefix intermediate phase drift");
  validateReviewTokenRotationPhaseProof(intermediateProof, intermediateProof.phase,
    authorityProof, { accountId, sourceSha }, now, Infinity);
  validateReviewTokenRotationPredecessorProof(preCreateProof, authorityProof,
    { accountId, sourceSha }, now, Infinity);
  validateReviewTokenRotationPhaseProof(preProductionProof, "replacement-created",
    authorityProof, { accountId, sourceSha }, now, Infinity);
  validateReviewTokenRotationAttemptCoordinate(rotationAttemptCoordinate, sourceSha,
    { executorSha256: rotationAttemptCoordinate?.executorSha256,
      initialJournalSha256: rotationAttemptCoordinate?.initialJournalSha256,
      journalPathSha256: rotationAttemptCoordinate?.journalPathSha256 },
    Date.parse(authorityProof.capturedAt));
  if (authorityProof.evidenceDigests?.rotationAttempt !==
      digestJson(rotationAttemptCoordinate))
    fail("review token rotation recovery prefix attempt authority drift");
  validateReviewTokenRotationPhaseProof(unreferencedProof, "old-wrapper-unreferenced",
    authorityProof, { accountId, sourceSha }, now, Infinity);
  if (records[1]?.authorityProofDigest !== authorityProof.proof_digest)
    fail("review token rotation recovery prefix authority drift");
  const completedOperations = [
    ["replacement-review-build-token", replacementReviewTokenUuid],
    ["repoint-inert-production-trigger", identity.productionTriggerUuid],
    ["repoint-final-review-trigger", identity.reviewTriggerUuid],
  ];
  for (const [operation, resourceUuid] of completedOperations) {
    const operationMain = records.find((record) =>
      record.event === "current-main-proof-bound" && record.operation === operation);
    const operationAuthority = records.find((record) =>
      record.event === "review-token-rotation-authority-checked" &&
      record.operation === operation);
    const operationIntent = records.find((record) =>
      record.event === "mutation-intent" && record.operation === operation);
    const operationClassified = records.find((record) =>
      record.event === "provider-response-classified" && record.operation === operation);
    const operationBound = records.find((record) =>
      record.event === "mutation-bound" && record.operation === operation);
    const expected = reviewTokenRotationRequestDigest({ production, review, authorityProof,
      operation, replacementReviewTokenUuid });
    const explicit = operationClassified?.outcome === "explicit-success";
    if (operationIntent?.method !== expected.method || operationIntent.path !== expected.path ||
        operationIntent.requestDigestSha256 !== expected.requestDigestSha256 ||
        !["explicit-success", "ambiguous"].includes(operationClassified?.outcome) ||
        explicit && operation === "replacement-review-build-token" &&
          operationClassified.resourceUuid !== resourceUuid ||
        operationBound?.resourceUuid !== resourceUuid ||
        operationBound.requestDigestSha256 !== operationIntent.requestDigestSha256 ||
        operationBound.providerResponseExplicitSuccess !== explicit ||
        operationBound.reconciliation !== (explicit ?
          "explicit-success-exact-readback" : "ambiguous-exact-readback") ||
        !/^[0-9a-f]{64}$/u.test(operationBound.readbackDigestSha256 ?? "") ||
        Date.parse(operationMain?.at ?? "") > Date.parse(operationAuthority?.at ?? "") ||
        Date.parse(operationAuthority?.at ?? "") > Date.parse(operationIntent?.at ?? "") ||
        Date.parse(operationIntent?.at ?? "") > Date.parse(operationClassified?.at ?? "") ||
        Date.parse(operationClassified?.at ?? "") > Date.parse(operationBound?.at ?? "") ||
        Date.parse(operationBound?.at ?? "") >=
          Date.parse(authorityProof.expiresAt))
      fail("review token rotation recovery prefix mutation drift");
  }
  const currentMainRecords = records.filter(({ event }) => event === "current-main-proof-bound");
  const authorityRecords = records.filter(({ event }) =>
    event === "review-token-rotation-authority-checked");
  if (currentMainRecords.length !== 4 || authorityRecords.length !== 4 ||
      currentMainRecords.some((record) => {
        const capturedAt = Date.parse(record.capturedAt ?? "");
        const recordAt = Date.parse(record.at ?? "");
        return record.sourceSha !== sourceSha || record.ref !== currentMainRef ||
          !/^[0-9a-f]{64}$/u.test(record.proofFileSha256 ?? "") ||
          !/^[0-9a-f]{64}$/u.test(record.rawFileSha256 ?? "") ||
          !isUtcTimestamp(record.capturedAt) || capturedAt > recordAt ||
          recordAt - capturedAt > 5 * 60_000;
      }) || authorityRecords.some((record) =>
        record.proofDigest !== authorityProof.proof_digest ||
        record.expiresAt !== authorityProof.expiresAt ||
        Date.parse(record.at) < Date.parse(authorityProof.capturedAt) ||
        Date.parse(authorityProof.expiresAt) - Date.parse(record.at) <
          reviewTokenRotationTransitionBudgetMs))
    fail("review token rotation recovery prefix authorization drift");
  const intermediateBound = records.find(({ event, operation }) =>
    event === "provider-proof-bound" &&
    operation === "prove-production-repointed-review-still-predecessor");
  const unreferencedBound = records.find(({ event, operation }) =>
    event === "provider-proof-bound" && operation === "prove-superseded-wrapper-unreferenced");
  const preCreateBound = records.find(({ event, operation }) =>
    event === "provider-proof-bound" && operation === "prove-replacement-create-precondition");
  const preProductionBound = records.find(({ event, operation }) =>
    event === "provider-proof-bound" && operation === "prove-production-repoint-precondition");
  if (records[0]?.attemptCoordinateDigest !== rotationAttemptCoordinate.proof_digest ||
      records[0]?.attemptNamespace !== rotationAttemptCoordinate.attemptNamespace ||
      records[0]?.executorSha256 !== rotationAttemptCoordinate.executorSha256 ||
      records[0]?.journalId !== rotationAttemptCoordinate.journalId ||
      records[0]?.journalPathSha256 !== rotationAttemptCoordinate.journalPathSha256 ||
      preCreateBound?.proofDigest !== preCreateProof.proof_digest ||
      preCreateBound?.proofFileSha256 !== digestJson(preCreateProof) ||
      preProductionBound?.proofDigest !== preProductionProof.proof_digest ||
      preProductionBound?.proofFileSha256 !== digestJson(preProductionProof) ||
      intermediateBound?.proofDigest !== intermediateProof.proof_digest ||
      intermediateBound.proofFileSha256 !== digestJson(intermediateProof) ||
      unreferencedBound?.proofDigest !== unreferencedProof.proof_digest ||
      unreferencedBound.proofFileSha256 !== digestJson(unreferencedProof) ||
      Date.parse(records.find(({ event, operation }) => event === "mutation-bound" &&
        operation === "repoint-inert-production-trigger")?.at ?? "") >
        Date.parse(intermediateProof.capturedAt) ||
      Date.parse(intermediateProof.capturedAt) > Date.parse(intermediateBound?.at ?? "") ||
      Date.parse(records.find(({ event, operation }) => event === "mutation-bound" &&
        operation === "repoint-final-review-trigger")?.at ?? "") >
        Date.parse(unreferencedProof.capturedAt) ||
      Date.parse(unreferencedProof.capturedAt) > Date.parse(unreferencedBound?.at ?? ""))
    fail("review token rotation recovery prefix phase proof drift");
  for (const [operation, proof, proofBound] of [
    ["replacement-review-build-token", preCreateProof, preCreateBound],
    ["repoint-inert-production-trigger", preProductionProof, preProductionBound],
    ["repoint-final-review-trigger", intermediateProof, intermediateBound],
  ]) {
    const checked = records.find((record) =>
      record.event === "review-token-rotation-authority-checked" &&
      record.operation === operation);
    const main = records.find((record) => record.event === "current-main-proof-bound" &&
      record.operation === operation);
    const operationIntent = records.find((record) =>
      record.event === "mutation-intent" && record.operation === operation);
    if (!reviewTokenRotationRollbackProofChronologyValid({
      currentMainAt: main?.at, authorityAt: checked?.at,
      proofCapturedAt: proof.capturedAt, proofBoundAt: proofBound?.at,
      intentAt: operationIntent?.at }))
      fail("review token rotation recovery prefix pre-mutation proof drift");
  }
  const intent = records[deleteIntentIndex];
  const deleteMain = records.find(({ event, operation }) =>
    event === "current-main-proof-bound" &&
      operation === "retire-superseded-review-build-token");
  const deleteAuthority = records.find(({ event, operation }) =>
    event === "review-token-rotation-authority-checked" &&
      operation === "retire-superseded-review-build-token");
  const expectedDelete = reviewTokenRotationRequestDigest({ production, review, authorityProof,
    operation: "retire-superseded-review-build-token",
    replacementReviewTokenUuid });
  if (intent?.method !== expectedDelete.method || intent?.path !== expectedDelete.path ||
      intent?.requestDigestSha256 !== expectedDelete.requestDigestSha256 ||
      Date.parse(deleteMain?.at ?? "") > Date.parse(deleteAuthority?.at ?? "") ||
      Date.parse(deleteAuthority?.at ?? "") > Date.parse(unreferencedBound?.at ?? "") ||
      Date.parse(unreferencedBound?.at ?? "") > Date.parse(intent?.at ?? "") ||
      Date.parse(intent?.at ?? "") >= Date.parse(authorityProof.expiresAt))
    fail("review token rotation recovery prefix delete intent drift");
  try {
    validateReviewTokenRotationDeleteProofChronology(unreferencedProof,
      unreferencedBound, intent);
  } catch {
    fail("review token rotation recovery prefix delete proof chronology drift");
  }
  const classified = originalLength >= deleteIntentIndex + 2 ? records[deleteIntentIndex + 1] : null;
  const bound = originalLength >= deleteIntentIndex + 3 ? records[deleteIntentIndex + 2] : null;
  const deleteExplicit = classified?.outcome === "explicit-success";
  if (classified && (!deleteExplicit && classified.outcome !== "ambiguous" ||
        Date.parse(intent.at) > Date.parse(classified.at)) ||
      bound && (bound.resourceUuid !== identity.predecessorReviewBuildTokenUuid ||
        bound.requestDigestSha256 !== intent.requestDigestSha256 ||
        !classified || Date.parse(classified.at) > Date.parse(bound.at) ||
        Date.parse(bound.at) >= Date.parse(authorityProof.expiresAt) ||
        bound.providerResponseExplicitSuccess !== deleteExplicit ||
        bound.reconciliation !== (deleteExplicit ? "explicit-success-exact-absence" :
          "ambiguous-exact-absence") ||
        bound.deletionTombstone !== true ||
        !/^[0-9a-f]{64}$/u.test(bound.readbackDigestSha256 ?? "")))
    fail("review token rotation recovery prefix deletion evidence drift");
  if (recoveryRecords.length > 0) {
    const start = recoveryRecords[0];
    if (!same(sorted(Object.keys(start)), sorted(["at", "attempt", "authorityProofDigest",
      "event", "predecessorReviewTokenUuid", "providerMutation", "recordSha256",
      "replacementReviewTokenUuid"])) ||
        start.authorityProofDigest !== authorityProof.proof_digest ||
        start.predecessorReviewTokenUuid !== identity.predecessorReviewBuildTokenUuid ||
        start.replacementReviewTokenUuid !== replacementReviewTokenUuid ||
        start.providerMutation !== false ||
        Date.parse(start.at) < Date.parse(authorityProof.expiresAt))
      fail("review token rotation recovery prefix start drift");
  }
  if (recoveryRecords.length > 1) {
    validateReviewTokenRotationTerminalProof(terminalProof,
      { accountId, sourceSha, authorityProof }, now, Infinity);
    const proofBound = recoveryRecords[1];
    if (terminalProof.replacementReviewTokenUuid !== replacementReviewTokenUuid ||
        !same(sorted(Object.keys(proofBound)), sorted(["at", "attempt", "event", "operation",
      "proofDigest", "proofFileSha256", "recordSha256"])) ||
        proofBound.proofDigest !== terminalProof.proof_digest ||
        proofBound.proofFileSha256 !== digestJson(terminalProof) ||
        Date.parse(recoveryRecords[0].at) > Date.parse(terminalProof.capturedAt) ||
        Date.parse(terminalProof.capturedAt) > Date.parse(proofBound.at))
      fail("review token rotation recovery prefix proof drift");
  }
  if (recoveryRecords.length > 2) {
    const recoveryBound = recoveryRecords[2];
    if (!same(sorted(Object.keys(recoveryBound)), sorted(["at", "attempt",
      "authorityProofDigest", "deletionTombstone", "event", "operation", "proofDigest",
      "proofFileSha256", "providerMutation", "readbackDigestSha256", "reconciliation",
      "recordSha256", "requestDigestSha256", "resourceUuid"])) ||
        recoveryBound.authorityProofDigest !== authorityProof.proof_digest ||
        recoveryBound.requestDigestSha256 !== intent.requestDigestSha256 ||
        recoveryBound.resourceUuid !== identity.predecessorReviewBuildTokenUuid ||
        recoveryBound.proofDigest !== terminalProof.proof_digest ||
        recoveryBound.proofFileSha256 !== digestJson(terminalProof) ||
        recoveryBound.readbackDigestSha256 !== terminalProof.proof_digest ||
        recoveryBound.reconciliation !== "historical-authority-exact-absence" ||
        recoveryBound.deletionTombstone !== true || recoveryBound.providerMutation !== false)
      fail("review token rotation recovery prefix tombstone drift");
  }
  if (recoveryRecords.length === recoveryExpected.length) {
    validateReviewTokenRotationJournal(records, terminalProof, authorityProof,
      { production, review, accountId, sourceSha, preCreateProof, preProductionProof,
        intermediateProof, unreferencedProof, rotationAttemptCoordinate }, now);
    return { outcome: "workers-builds-review-token-rotation-recovery-terminal",
      mutation: false, terminal: true, nextEvent: null };
  }
  return { outcome: "workers-builds-review-token-rotation-recovery-prefix-valid",
    mutation: false, terminal: false,
    nextEvent: recoveryExpected[recoveryRecords.length][0],
    nextOperation: recoveryExpected[recoveryRecords.length][1] ?? null };
}

export function validateReviewTokenRotationDeleteProofChronology(proof, bound, intent) {
  const capturedAt = Date.parse(proof?.capturedAt ?? "");
  const boundAt = Date.parse(bound?.at ?? "");
  const intentAt = Date.parse(intent?.at ?? "");
  if (!Number.isFinite(capturedAt) || !Number.isFinite(boundAt) || !Number.isFinite(intentAt) ||
      capturedAt > boundAt || boundAt > intentAt || intentAt - capturedAt > 30_000)
    fail("review token rotation delete proof chronology drift");
  return true;
}

export function reviewTokenRotationUnresolvedReplacementCoordinate(authorityProof) {
  const value = digestJson({ kind: "unresolved-review-token-rotation-coordinate",
    authority: authorityProof?.proof_digest });
  if (!/^[0-9a-f]{64}$/u.test(value))
    fail("review token rotation unresolved coordinate drift");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(13, 16)}-` +
    `8${value.slice(17, 20)}-${value.slice(20, 32)}`;
}

function validateReviewTokenRotationRollbackMutationPrefix(records, authorityProof, {
  production, review, sourceSha, replacementReviewTokenUuid, operation,
  terminalBlocked = false, providerNormalizedIncident = false,
  historicalProviderNormalizedIncident = false,
}) {
  const find = (event) => records.find((record) =>
    record.event === event && record.operation === operation);
  const currentMain = find("current-main-proof-bound");
  const authority = find("rollback-authority-checked");
  const intent = find("mutation-intent");
  const classified = find("provider-response-classified");
  const bound = find("mutation-bound");
  const present = [currentMain, authority, intent, classified, bound];
  if (!present.some(Boolean)) return { currentMain, authority, intent, classified, bound };
  const expectedRequest = reviewTokenRotationRollbackRequestDigest({ production, review,
    authorityProof, operation, replacementReviewTokenUuid });
  const explicit = classified?.outcome === "explicit-success";
  const explicitFailure = classified?.outcome === "explicit-failure";
  const resourceUuid = operation === "rotation-restore-review-trigger-old-token" ?
    authorityProof.journalIdentities.reviewTriggerUuid :
    operation === "rotation-restore-production-trigger-old-token" ?
      authorityProof.journalIdentities.productionTriggerUuid : replacementReviewTokenUuid;
  const mainCaptured = Date.parse(currentMain?.capturedAt ?? "");
  const mainAt = Date.parse(currentMain?.at ?? "");
  if (currentMain && (currentMain.sourceSha !== sourceSha || currentMain.ref !== currentMainRef ||
      !/^[0-9a-f]{64}$/u.test(currentMain.proofFileSha256 ?? "") ||
      !/^[0-9a-f]{64}$/u.test(currentMain.rawFileSha256 ?? "") ||
      !isUtcTimestamp(currentMain.capturedAt) || !Number.isFinite(mainCaptured) ||
      mainCaptured > mainAt || mainAt - mainCaptured > 5 * 60_000) ||
      authority && (authority.proofDigest !== authorityProof.proof_digest ||
        authority.historicalRollbackAuthority !== true) ||
      intent && (intent.method !== expectedRequest.method || intent.path !== expectedRequest.path ||
        intent.requestDigestSha256 !== expectedRequest.requestDigestSha256) ||
      classified && !["explicit-success", "ambiguous",
        ...(terminalBlocked ? ["explicit-failure"] : [])].includes(classified.outcome) ||
      explicitFailure && (!Number.isInteger(classified.status) || classified.status < 400 ||
        classified.status > 599 ||
        !/^[0-9a-f]{64}$/u.test(classified.responseDigestSha256 ?? "")) ||
      explicitFailure && bound ||
      bound && (bound.requestDigestSha256 !== intent?.requestDigestSha256 ||
        bound.providerResponseExplicitSuccess !== explicit || bound.resourceUuid !== resourceUuid ||
        !/^[0-9a-f]{64}$/u.test(bound.readbackDigestSha256 ?? "") ||
        bound.reconciliation !== (operation === "rotation-delete-replacement-wrapper" ?
          (explicit ? "explicit-success-exact-absence" : "ambiguous-exact-absence") :
          (explicit ? "explicit-success-exact-readback" : "ambiguous-exact-readback")) ||
        (operation === "rotation-delete-replacement-wrapper" && bound.deletionTombstone !== true) ||
        providerNormalizedIncident &&
          operation === "rotation-restore-production-trigger-old-token" &&
          typeof bound.reviewPeerAugmented !== "boolean"))
    fail("review token rotation rollback mutation provenance drift");
  const ordered = present.filter(Boolean).map(({ at }) => Date.parse(at));
  if (ordered.some((at, index) => index > 0 && at < ordered[index - 1]) ||
      historicalProviderNormalizedIncident && intent && authority &&
        Date.parse(intent.at) - Date.parse(authority.at) > 30_000)
    fail("review token rotation rollback mutation chronology drift");
  return { currentMain, authority, intent, classified, bound };
}

const rollbackPreconditionOperation = (operation) =>
  operation === "rotation-restore-review-trigger-old-token" ?
    "rotation-prove-review-restore-precondition" :
    "rotation-prove-production-restore-precondition";

export function reviewTokenRotationRollbackProofChronologyValid({
  currentMainAt, authorityAt, proofCapturedAt, proofBoundAt, intentAt = undefined,
}) {
  const ordered = [currentMainAt, authorityAt, proofCapturedAt, proofBoundAt]
    .map((value) => Date.parse(value ?? ""));
  if (ordered.some((value) => !Number.isFinite(value)) ||
      ordered.some((value, index) => index > 0 && value < ordered[index - 1])) return false;
  if (intentAt === undefined) return true;
  const intent = Date.parse(intentAt);
  return Number.isFinite(intent) && ordered.at(-1) <= intent &&
    intent - ordered[2] <= 30_000;
}

function validateReviewTokenRotationRollbackPreconditionBinding(records, proof,
authorityProof, { accountId, sourceSha, operation, phase, lowerRecord }) {
  const currentMain = records.find((record) => record.event === "current-main-proof-bound" &&
    record.operation === operation);
  const checked = records.find((record) => record.event === "rollback-authority-checked" &&
    record.operation === operation);
  const bound = records.find((record) => record.event === "provider-proof-bound" &&
    record.operation === rollbackPreconditionOperation(operation));
  if (!bound) return null;
  validateReviewTokenRotationPhaseProof(proof, phase, authorityProof,
    { accountId, sourceSha }, Date.parse(bound.at), Infinity);
  const intent = records.find((record) => record.event === "mutation-intent" &&
    record.operation === operation);
  if (!currentMain || !checked ||
      !same(sorted(Object.keys(bound)), sorted(["at", "attempt", "event", "operation",
    "proofDigest", "proofFileSha256", "recordSha256"])) ||
      bound.proofDigest !== proof.proof_digest ||
      bound.proofFileSha256 !== digestJson(proof) ||
      Date.parse(lowerRecord?.at ?? "") > Date.parse(proof.capturedAt) ||
      !reviewTokenRotationRollbackProofChronologyValid({
        currentMainAt: currentMain.at, authorityAt: checked.at,
        proofCapturedAt: proof.capturedAt, proofBoundAt: bound.at,
        intentAt: intent?.at }))
    fail("review token rotation rollback precondition proof drift");
  return bound;
}

function validateReviewTokenRotationPeerNormalizationBinding(records, peerNormalizationProof,
authorityProof, { accountId, sourceSha, historicalIncident = false }) {
  const find = (event, operation) => records.find((record) =>
    record.event === event && record.operation === operation);
  const peerNormalizationBound = find("provider-proof-bound",
    "rotation-prove-provider-peer-normalization");
  if (!peerNormalizationBound) return null;
  if (!["predecessor-restored", "production-restored-review-augmented"]
    .includes(peerNormalizationProof?.phase))
    fail("review token rotation provider peer normalization phase drift");
  validateReviewTokenRotationPhaseProof(peerNormalizationProof,
    peerNormalizationProof.phase, authorityProof, { accountId, sourceSha },
    Date.parse(peerNormalizationBound.at), Infinity);
  const productionBound = find("mutation-bound",
    "rotation-restore-production-trigger-old-token");
  const reviewMain = find("current-main-proof-bound",
    "rotation-restore-review-trigger-old-token");
  const reviewChecked = find("rollback-authority-checked",
    "rotation-restore-review-trigger-old-token");
  const reviewIntent = find("mutation-intent",
    "rotation-restore-review-trigger-old-token");
  if (Date.parse(productionBound?.at ?? "") > Date.parse(peerNormalizationProof.capturedAt) ||
      Date.parse(peerNormalizationProof.capturedAt) > Date.parse(peerNormalizationBound.at) ||
      reviewIntent && !historicalIncident && (!reviewMain || !reviewChecked ||
        !reviewTokenRotationRollbackProofChronologyValid({
          currentMainAt: reviewMain.at, authorityAt: reviewChecked.at,
          proofCapturedAt: peerNormalizationProof.capturedAt,
          proofBoundAt: peerNormalizationBound.at, intentAt: reviewIntent.at })) ||
      peerNormalizationBound.proofDigest !== peerNormalizationProof.proof_digest ||
      peerNormalizationBound.proofFileSha256 !== digestJson(peerNormalizationProof) ||
      productionBound.reviewPeerAugmented !==
        (peerNormalizationProof.phase === "production-restored-review-augmented"))
    fail("review token rotation provider peer normalization proof drift");
  return peerNormalizationBound;
}

async function classifyReviewTokenRotationProviderNormalizedRollbackPrefixCore(records, {
  production, review, accountId, sourceSha, authorityProof, replacementReviewTokenUuid,
  incidentProof, incidentForwardRecords, incidentForwardJournalSha256,
  incidentSnapshotManifestSha256, incidentAuthorityFileSha256,
  testCapability = undefined,
  peerNormalizationProof = undefined, restoredProof = undefined, completeProof = undefined,
  blockedSnapshotDirectory = undefined, blockedProof = undefined,
  productionSentinelProof = undefined, predecessorTokenAuthorityProofs = undefined,
  replacementTokenAuthorityProof = undefined, replacementTokenId = undefined,
  productionBaselineProof = undefined,
} = {}) {
  const incidentCoordinate = providerNormalizedIncidentCoordinate(testCapability);
  const incident = validateReviewTokenRotationProviderNormalizedIncidentCore(incidentForwardRecords,
    incidentProof, authorityProof, { production, review, accountId,
      forwardJournalSha256: incidentForwardJournalSha256,
      incidentSnapshotManifestSha256, authorityFileSha256: incidentAuthorityFileSha256 },
    testCapability);
  const peerProofPresent = records.some((record) => record.event === "provider-proof-bound" &&
    record.operation === "rotation-prove-provider-peer-normalization");
  const peerNormalizationPhase = peerProofPresent ? peerNormalizationProof?.phase ?? null : null;
  if (![null, "predecessor-restored", "production-restored-review-augmented"]
    .includes(peerNormalizationPhase))
    fail("review token rotation provider-normalized rollback phase drift");
  const group = (operation) => [
    ["current-main-proof-bound", operation], ["rollback-authority-checked", operation],
    ["mutation-intent", operation], ["provider-response-classified", operation],
    ["mutation-bound", operation],
  ];
  const expected = [["review-token-rotation-rollback-started", undefined],
    ...group("rotation-restore-production-trigger-old-token"),
    ["provider-proof-bound", "rotation-prove-provider-peer-normalization"],
    ...(peerNormalizationPhase === "production-restored-review-augmented" ?
      group("rotation-restore-review-trigger-old-token") : []),
    ["provider-proof-bound", "rotation-prove-predecessor-restored"],
    ...group("rotation-delete-replacement-wrapper"),
    ["provider-proof-bound", "rotation-prove-rollback-complete"],
    ["review-token-rotation-rollback-complete", undefined],
  ];
  if (!Array.isArray(records)) fail("review token rotation provider-normalized prefix drift");
  const pairs = records.map(({ event, operation }) => [event, operation]);
  const terminalBlocked = records.at(-1)?.event === "review-token-rotation-rollback-blocked";
  if (peerProofPresent && peerNormalizationPhase === null)
    fail("review token rotation provider-normalized peer disposition is missing");
  const comparedPairs = terminalBlocked ? pairs.slice(0, -1) : pairs;
  if (!same(comparedPairs, expected.slice(0, comparedPairs.length)))
    fail("review token rotation provider-normalized rollback prefix drift");
  let previousAt = -Infinity;
  for (const record of records) {
    const { recordSha256, ...payload } = record ?? {};
    const at = Date.parse(record?.at ?? "");
    if (!/^[0-9a-f]{64}$/u.test(recordSha256 ?? "") || digestJson(payload) !== recordSha256 ||
        !Number.isFinite(at) || !isUtcTimestamp(record.at) || at <= previousAt ||
        record.attempt !== 1) fail("review token rotation provider-normalized prefix checksum drift");
    previousAt = at;
  }
  const startKeys = ["at", "attempt", "authorityProofDigest", "event",
    "forwardJournalDigest", "incidentCoordinateDigest", "incidentProofDigest",
    "recordSha256", "replacementReviewTokenUuid", "startingPhase"];
  if (records.length > 0 && (!same(sorted(Object.keys(records[0])), sorted(startKeys)) ||
      records[0].startingPhase !== "production-repointed-review-augmented" ||
      Date.parse(incidentProof.capturedAt) > Date.parse(records[0].at) ||
      records[0].authorityProofDigest !== authorityProof.proof_digest ||
      records[0].replacementReviewTokenUuid !== replacementReviewTokenUuid ||
      records[0].incidentCoordinateDigest !== incident.incidentCoordinateDigest ||
      records[0].incidentProofDigest !== incidentProof.proof_digest ||
      records[0].forwardJournalDigest !== incident.forwardJournalDigest))
    fail("review token rotation provider-normalized prefix starting state drift");
  const operations = ["rotation-restore-production-trigger-old-token",
    ...(peerNormalizationPhase === "production-restored-review-augmented" ?
      ["rotation-restore-review-trigger-old-token"] : []),
    "rotation-delete-replacement-wrapper"];
  for (const operation of operations) validateReviewTokenRotationRollbackMutationPrefix(records,
    authorityProof, { production, review, sourceSha, replacementReviewTokenUuid, operation,
      terminalBlocked: terminalBlocked || records.at(-1)?.event ===
        "provider-response-classified",
      providerNormalizedIncident: true });
  const peerBound = validateReviewTokenRotationPeerNormalizationBinding(records,
    peerNormalizationProof, authorityProof, { accountId, sourceSha,
      historicalIncident: true });
  if (peerProofPresent && !peerBound)
    fail("review token rotation provider-normalized peer proof is missing");
  const restoredBound = records.find((record) => record.event === "provider-proof-bound" &&
    record.operation === "rotation-prove-predecessor-restored");
  if (restoredBound) {
    validateReviewTokenRotationPhaseProof(restoredProof, "predecessor-restored", authorityProof,
      { accountId, sourceSha }, Date.parse(restoredBound.at), Infinity);
    const finalRestore = peerNormalizationPhase === "production-restored-review-augmented" ?
      "rotation-restore-review-trigger-old-token" :
      "rotation-restore-production-trigger-old-token";
    const finalRestoreBound = records.find((record) => record.event === "mutation-bound" &&
      record.operation === finalRestore);
    if (restoredBound.proofDigest !== restoredProof.proof_digest ||
        restoredBound.proofFileSha256 !== digestJson(restoredProof) ||
        Date.parse(finalRestoreBound?.at ?? "") > Date.parse(restoredProof.capturedAt) ||
        Date.parse(restoredProof.capturedAt) > Date.parse(restoredBound.at))
      fail("review token rotation provider-normalized restored proof drift");
  }
  const completeBound = records.find((record) => record.event === "provider-proof-bound" &&
    record.operation === "rotation-prove-rollback-complete");
  if (completeBound) {
    validateReviewTokenRotationPredecessorProof(completeProof, authorityProof,
      { accountId, sourceSha }, Date.parse(completeBound.at), Infinity);
    const deletionBound = records.find((record) => record.event === "mutation-bound" &&
      record.operation === "rotation-delete-replacement-wrapper");
    if (completeBound.proofDigest !== completeProof.proof_digest ||
        completeBound.proofFileSha256 !== digestJson(completeProof) ||
        Date.parse(deletionBound?.at ?? "") > Date.parse(completeProof.capturedAt) ||
        Date.parse(completeProof.capturedAt) > Date.parse(completeBound.at))
      fail("review token rotation provider-normalized complete proof drift");
  }
  const validatorArguments = { production, review, accountId, sourceSha, authorityProof,
    replacementReviewTokenUuid, incidentProof, incidentForwardRecords,
    incidentForwardJournalSha256, incidentSnapshotManifestSha256,
    incidentAuthorityFileSha256, testCapability, peerNormalizationProof, restoredProof,
    completeProof, blockedSnapshotDirectory, blockedProof, productionSentinelProof,
    predecessorTokenAuthorityProofs, replacementTokenAuthorityProof, replacementTokenId,
    productionBaselineProof, authoritySourceSha: incidentCoordinate.sourceSha,
    authorityPlanDigest: incidentCoordinate.planDigest };
  if (["review-token-rotation-rollback-complete",
    "review-token-rotation-rollback-blocked"].includes(records.at(-1)?.event)) {
    await validateReviewTokenRotationRollbackJournalCore(records, authorityProof,
      validatorArguments);
    return { outcome: "workers-builds-review-token-rotation-provider-normalized-prefix-valid",
      mutation: false, nextEvent: null, nextOperation: null, reconcile: false, terminal: true };
  }
  const classified = records.at(-1)?.event === "provider-response-classified" ?
    records.at(-1) : null;
  if (classified?.outcome === "explicit-failure") return {
    outcome: "workers-builds-review-token-rotation-provider-normalized-prefix-valid",
    mutation: false, nextEvent: "review-token-rotation-rollback-blocked",
    reconcile: false, terminal: false };
  if (classified?.outcome === "ambiguous") return {
    outcome: "workers-builds-review-token-rotation-provider-normalized-prefix-valid",
    mutation: false, nextEvent: "mutation-bound", reconcile: true, terminal: false };
  if (classified?.outcome === "explicit-success") return {
    outcome: "workers-builds-review-token-rotation-provider-normalized-prefix-valid",
    mutation: false, nextEvent: "mutation-bound", reconcile: true, terminal: false };
  const next = expected[records.length];
  return { outcome: "workers-builds-review-token-rotation-provider-normalized-prefix-valid",
    mutation: false, nextEvent: next?.[0] ?? null, nextOperation: next?.[1] ?? null,
    reconcile: records.at(-1)?.event === "mutation-intent", terminal: !next };
}

export async function classifyReviewTokenRotationProviderNormalizedRollbackPrefix(records,
arguments_ = {}) {
  const { testCapability: _ignored, ...runtimeArguments } = arguments_;
  return classifyReviewTokenRotationProviderNormalizedRollbackPrefixCore(records,
    runtimeArguments);
}

export async function classifyReviewTokenRotationProviderNormalizedRollbackPrefixForTest(records,
arguments_, testCapability) {
  return classifyReviewTokenRotationProviderNormalizedRollbackPrefixCore(records,
    { ...arguments_, testCapability });
}

export async function validateReviewTokenRotationNoOwnedPreIntentTerminal(forwardRecords,
authorityProof, { production, review, accountId, sourceSha, preCreateProof,
  rollbackRecords, rollbackArguments,
  authorityPlanDigest = digestJson(provisioningSetupPlan(production, review)) },
now = Date.now()) {
  validateHistoricalReviewTokenRotationAuthority(authorityProof,
    { production, review, accountId, sourceSha, planDigest: authorityPlanDigest });
  const expected = [
    ["attempt-started", "review-token-rotation"],
    ["rotation-authorized", undefined],
    ["current-main-proof-bound", "replacement-review-build-token"],
    ["review-token-rotation-authority-checked", "replacement-review-build-token"],
    ["provider-proof-bound", "prove-replacement-create-precondition"],
  ];
  const pairs = Array.isArray(forwardRecords) ? forwardRecords.map(({ event, operation }) =>
    [event, operation]) : [];
  if (pairs.length < 1 || pairs.length > expected.length ||
      !same(pairs, expected.slice(0, pairs.length)) ||
      now < Date.parse(authorityProof.expiresAt))
    fail("review token rotation no-owned prefix drift");
  let previousAt = -Infinity;
  const exactKeys = (record) => {
    const common = ["at", "attempt", "event", "recordSha256"];
    if (record.event === "attempt-started") return [...common, "operation", "attemptNamespace",
      "executorSha256", "journalId", "journalPathSha256", "attemptCoordinateDigest"];
    if (record.event === "rotation-authorized") return [...common, "authorityProofDigest"];
    if (record.event === "current-main-proof-bound") return [...common, "operation", "sourceSha",
      "ref", "capturedAt", "proofFileSha256", "rawFileSha256"];
    if (record.event === "review-token-rotation-authority-checked") return [...common,
      "operation", "proofDigest", "expiresAt"];
    if (record.event === "provider-proof-bound") return [...common, "operation", "proofDigest",
      "proofFileSha256"];
    return [];
  };
  for (const record of forwardRecords) {
    const { recordSha256, ...payload } = record ?? {};
    const at = Date.parse(record?.at ?? "");
    if (!same(sorted(Object.keys(record ?? {})), sorted(exactKeys(record))) ||
        !/^[0-9a-f]{64}$/u.test(recordSha256 ?? "") || digestJson(payload) !== recordSha256 ||
        !isUtcTimestamp(record.at) || !Number.isFinite(at) || at <= previousAt ||
        record.attempt !== 1) fail("review token rotation no-owned prefix checksum drift");
    previousAt = at;
  }
  const authorized = forwardRecords.find(({ event }) => event === "rotation-authorized");
  const currentMain = forwardRecords.find(({ event }) => event === "current-main-proof-bound");
  const checked = forwardRecords.find(({ event }) =>
    event === "review-token-rotation-authority-checked");
  const preCreateBound = forwardRecords.find(({ event, operation }) =>
    event === "provider-proof-bound" &&
      operation === "prove-replacement-create-precondition");
  const captured = Date.parse(currentMain?.capturedAt ?? "");
  const firstAt = Date.parse(forwardRecords[0]?.at ?? "");
  const expiresAt = Date.parse(authorityProof.expiresAt);
  const authorityCapturedAt = Date.parse(authorityProof.capturedAt);
  if (firstAt < authorityCapturedAt || previousAt >= expiresAt ||
      authorized && (authorized.authorityProofDigest !== authorityProof.proof_digest ||
        Date.parse(authorized.at) < authorityCapturedAt ||
        Date.parse(authorized.at) >= expiresAt) ||
      currentMain && (currentMain.sourceSha !== sourceSha || currentMain.ref !== currentMainRef ||
        !/^[0-9a-f]{64}$/u.test(currentMain.proofFileSha256 ?? "") ||
        !/^[0-9a-f]{64}$/u.test(currentMain.rawFileSha256 ?? "") ||
        !isUtcTimestamp(currentMain.capturedAt) || !Number.isFinite(captured) ||
        captured > Date.parse(currentMain.at) || Date.parse(currentMain.at) - captured > 5 * 60_000) ||
      checked && (!currentMain || checked.proofDigest !== authorityProof.proof_digest ||
        checked.expiresAt !== authorityProof.expiresAt ||
        Date.parse(checked.at) < Date.parse(currentMain.at) ||
        Date.parse(authorityProof.expiresAt) - Date.parse(checked.at) <
          reviewTokenRotationTransitionBudgetMs) ||
      preCreateBound && (!checked ||
        validateReviewTokenRotationPredecessorProof(preCreateProof, authorityProof,
          { accountId, sourceSha }, Date.parse(preCreateProof?.capturedAt ?? ""), Infinity)
          .phase !== "predecessor" ||
        preCreateBound.proofDigest !== preCreateProof.proof_digest ||
        preCreateBound.proofFileSha256 !== digestJson(preCreateProof) ||
        Date.parse(checked.at) > Date.parse(preCreateProof.capturedAt) ||
        Date.parse(preCreateProof.capturedAt) > Date.parse(preCreateBound.at)))
    fail("review token rotation no-owned prefix provenance drift");
  const replacementReviewTokenUuid =
    reviewTokenRotationUnresolvedReplacementCoordinate(authorityProof);
  if (rollbackRecords?.[0]?.replacementReviewTokenUuid !== replacementReviewTokenUuid ||
      Date.parse(rollbackRecords?.[0]?.at ?? "") < Date.parse(authorityProof.expiresAt) ||
      Date.parse(rollbackRecords?.[0]?.at ?? "") <=
        Date.parse(forwardRecords.at(-1)?.at ?? ""))
    fail("review token rotation no-owned residual coordinate drift");
  const validation = await validateReviewTokenRotationRollbackJournal(rollbackRecords,
    authorityProof, { ...rollbackArguments, production, review, accountId, sourceSha,
      replacementReviewTokenUuid });
  const residual = validation?.residualState;
  if (validation?.outcome !== "workers-builds-review-token-rotation-rollback-blocked-valid" ||
      rollbackRecords[0]?.startingPhase !== "predecessor" || residual?.activeMutation !== null ||
      residual?.liveProductionTokenReference !==
        authorityProof.journalIdentities.predecessorReviewBuildTokenUuid ||
      residual?.liveReviewTokenReference !==
        authorityProof.journalIdentities.predecessorReviewBuildTokenUuid ||
      residual?.predecessorWrapperPresent !== true ||
      residual?.replacementWrapperPresent !== false)
    fail("review token rotation no-owned residual terminal drift");
  return { outcome: "workers-builds-review-token-rotation-no-owned-predecessor-blocked-valid",
    mutation: false, replacementReviewTokenUuid,
    forwardJournalDigest: digestJson(forwardRecords), rollbackJournalDigest: digestJson(rollbackRecords) };
}

async function validateReviewTokenRotationNoOwnedIncidentSuccessorCore(records, {
  production, review, accountId, terminalSourceSha,
  terminalCurrentMainProofStart, terminalCurrentMainProofFinish,
  freshSnapshotDirectory, freshPredecessorProof,
  forwardRecords, rollbackRecords, authorityProof, preCreateProof,
  rollbackArguments, incidentFileDigests,
}, now = Date.now(), testCapability = undefined) {
  const coordinate = noOwnedIncidentCoordinate(testCapability);
  const digestKeys = ["authorityFileSha256", "executorSha256", "forwardJournalSha256",
    "preCreateProofFileSha256", "residualProofFileSha256",
    "residualSnapshotManifestSha256", "rollbackJournalSha256"];
  if (!same(sorted(Object.keys(incidentFileDigests ?? {})), digestKeys) ||
      digestKeys.some((key) => incidentFileDigests[key] !== coordinate[key]) ||
      authorityProof?.sourceSha !== coordinate.sourceSha ||
      authorityProof?.planDigest !== coordinate.planDigest ||
      digestJson(forwardRecords) !== coordinate.forwardJournalDigest ||
      digestJson(rollbackRecords) !== coordinate.rollbackJournalDigest ||
      rollbackRecords?.at(-1)?.recordSha256 !== coordinate.rollbackTerminalRecordSha256 ||
      rollbackArguments?.blockedProof?.proof_digest !== coordinate.residualProofDigest ||
      digestJson(rollbackArguments?.blockedProof) !== coordinate.residualProofDocumentSha256)
    fail("review token rotation no-owned incident coordinate drift");
  const historical = await validateReviewTokenRotationNoOwnedPreIntentTerminal(forwardRecords,
    authorityProof, { production, review, accountId, sourceSha: coordinate.sourceSha,
      preCreateProof, rollbackRecords,
      rollbackArguments: { ...rollbackArguments, authoritySourceSha: coordinate.sourceSha,
        authorityPlanDigest: coordinate.planDigest },
      authorityPlanDigest: coordinate.planDigest }, now);
  if (historical.forwardJournalDigest !== coordinate.forwardJournalDigest ||
      historical.rollbackJournalDigest !== coordinate.rollbackJournalDigest)
    fail("review token rotation no-owned historical terminal drift");
  const identities = authorityProof.journalIdentities;
  const manifest = await loadSnapshot(freshSnapshotDirectory, "snapshot-manifest.json");
  const snapshotManifestSha256 = await readPrivateFileSha256(
    resolve(freshSnapshotDirectory, "snapshot-manifest.json"),
    "no-owned successor snapshot manifest");
  const validatedProof = await validateReviewTokenRotationSnapshotDirectory({
    snapshotDirectory: freshSnapshotDirectory, production, review, accountId,
    sourceSha: terminalSourceSha, phase: "predecessor",
    productionSentinelProof: rollbackArguments.productionSentinelProof,
    predecessorTokenAuthorityProofs: rollbackArguments.predecessorTokenAuthorityProofs,
    replacementTokenAuthorityProof: rollbackArguments.replacementTokenAuthorityProof,
    replacementTokenId: rollbackArguments.replacementTokenId,
    productionTriggerUuid: identities.productionTriggerUuid,
    reviewTriggerUuid: identities.reviewTriggerUuid,
    predecessorReviewTokenUuid: identities.predecessorReviewBuildTokenUuid,
    replacementReviewTokenUuid: undefined,
    productionPreservationDigest: authorityProof.productionPreservationDigest,
    authorityProof, productionBaselineProof: rollbackArguments.productionBaselineProof,
    authoritySourceSha: coordinate.sourceSha, authorityPlanDigest: authorityProof.planDigest,
    now: Date.parse(freshPredecessorProof?.capturedAt ?? ""),
  });
  const historicalTerminalAt = Date.parse(rollbackRecords.at(-1)?.at ?? "");
  const mainStartCapturedAt = Date.parse(terminalCurrentMainProofStart?.capturedAt ?? "");
  const mainFinishCapturedAt = Date.parse(terminalCurrentMainProofFinish?.capturedAt ?? "");
  const snapshotStartedAt = Date.parse(manifest?.startedAt ?? "");
  const snapshotCompletedAt = Date.parse(manifest?.completedAt ?? "");
  const proofCapturedAt = Date.parse(freshPredecessorProof?.capturedAt ?? "");
  validateCurrentMainProof(terminalCurrentMainProofStart, terminalSourceSha,
    snapshotStartedAt);
  validateCurrentMainProof(terminalCurrentMainProofFinish, terminalSourceSha,
    mainFinishCapturedAt);
  if (digestJson(validatedProof) !== digestJson(freshPredecessorProof) ||
      ![historicalTerminalAt, mainStartCapturedAt, snapshotStartedAt, snapshotCompletedAt,
        proofCapturedAt, mainFinishCapturedAt].every(Number.isFinite) ||
      historicalTerminalAt > snapshotStartedAt || mainStartCapturedAt > snapshotStartedAt ||
      snapshotStartedAt > snapshotCompletedAt || snapshotCompletedAt > proofCapturedAt ||
      proofCapturedAt > mainFinishCapturedAt)
    fail("review token rotation no-owned successor proof drift");
  const expected = ["review-token-rotation-no-owned-successor-started",
    "review-token-rotation-no-owned-successor-complete"];
  const exactKeys = [
    ["at", "attempt", "currentMainProofFinishDigest", "currentMainProofStartDigest",
      "event", "freshProofDigest", "freshProofFileSha256", "incidentCoordinateDigest", "providerMutation",
      "recordSha256", "snapshotManifestSha256", "terminalSourceSha"],
    ["at", "attempt", "event", "freshProofDigest", "freshProofFileSha256",
      "initialProductionBuild", "migration0010", "outcome", "productionActivation",
      "providerMutation", "recordSha256", "triggerPostOrPatch", "workerResourceMutation"],
  ];
  if (!Array.isArray(records) || records.length !== expected.length)
    fail("review token rotation no-owned successor sequence drift");
  let previousAt = proofCapturedAt;
  for (const [index, record] of records.entries()) {
    const { recordSha256, ...payload } = record ?? {};
    const at = Date.parse(record?.at ?? "");
    if (record?.event !== expected[index] || record.attempt !== 1 ||
        !same(sorted(Object.keys(record)), sorted(exactKeys[index])) ||
        !/^[0-9a-f]{64}$/u.test(recordSha256 ?? "") ||
        digestJson(payload) !== recordSha256 || !isUtcTimestamp(record.at) ||
        !Number.isFinite(at) || at <= previousAt)
      fail("review token rotation no-owned successor sequence drift");
    previousAt = at;
  }
  const start = records[0];
  const terminal = records[1];
  if (start.incidentCoordinateDigest !== digestJson(coordinate) ||
      start.terminalSourceSha !== terminalSourceSha || start.providerMutation !== false ||
      start.currentMainProofStartDigest !== digestJson(terminalCurrentMainProofStart) ||
      start.currentMainProofFinishDigest !== digestJson(terminalCurrentMainProofFinish) ||
      start.freshProofDigest !== freshPredecessorProof.proof_digest ||
      start.freshProofFileSha256 !== digestJson(freshPredecessorProof) ||
      start.snapshotManifestSha256 !== snapshotManifestSha256 ||
      mainFinishCapturedAt > Date.parse(start.at) ||
      Date.parse(start.at) - proofCapturedAt > 30_000 ||
      terminal.outcome !== "predecessor-no-owned" || terminal.providerMutation !== false ||
      terminal.freshProofDigest !== start.freshProofDigest ||
      terminal.freshProofFileSha256 !== start.freshProofFileSha256 ||
      terminal.triggerPostOrPatch !== false || terminal.productionActivation !== false ||
      terminal.migration0010 !== false || terminal.initialProductionBuild !== false ||
      terminal.workerResourceMutation !== false || Date.parse(terminal.at) > now + 30_000)
    fail("review token rotation no-owned successor terminal drift");
  return { outcome: "workers-builds-review-token-rotation-no-owned-successor-valid",
    mutation: false, terminal: true, proof_digest: freshPredecessorProof.proof_digest,
    terminalSourceSha };
}

export async function validateReviewTokenRotationNoOwnedIncidentSuccessor(records,
arguments_, now = Date.now()) {
  const { testCapability: _ignored, ...runtimeArguments } = arguments_ ?? {};
  return validateReviewTokenRotationNoOwnedIncidentSuccessorCore(records,
    runtimeArguments, now);
}

export async function validateReviewTokenRotationNoOwnedIncidentSuccessorForTest(records,
arguments_, now, testCapability) {
  return validateReviewTokenRotationNoOwnedIncidentSuccessorCore(records,
    arguments_, now, testCapability);
}

async function validateReviewTokenRotationRollbackJournalCore(records, authorityProof, {
  production, review, accountId, sourceSha, restoredProof, completeProof,
  peerNormalizationProof,
  incidentProof, incidentForwardRecords, incidentForwardJournalSha256,
  incidentSnapshotManifestSha256, incidentAuthorityFileSha256,
  forwardRecords, forwardIntermediateProof, forwardRecoveryProof, forwardPreCreateProof,
  forwardPreProductionProof, rotationAttemptCoordinate, attemptFilesystemEvidence,
  programDeliveryProof, programLedgerDocument, programLedgerFileSha256,
  rollbackPreconditionProofs = {},
  testCapability = undefined,
  replacementReviewTokenUuid, blockedSnapshotDirectory, productionSentinelProof,
  predecessorTokenAuthorityProofs, replacementTokenAuthorityProof, replacementTokenId,
  productionBaselineProof, blockedProof,
  authoritySourceSha = sourceSha,
  authorityPlanDigest = digestJson(provisioningSetupPlan(production, review)),
}) {
  validateHistoricalReviewTokenRotationAuthority(authorityProof,
    { production, review, accountId, sourceSha: authoritySourceSha,
      planDigest: authorityPlanDigest });
  if (!Array.isArray(records) || records.length < 2 ||
      records[0]?.event !== "review-token-rotation-rollback-started")
    fail("review token rotation rollback journal sequence drift");
  let previousAt = -Infinity;
  for (const record of records) {
    const { recordSha256, ...payload } = record ?? {};
    const at = Date.parse(record?.at ?? "");
    if (!/^[0-9a-f]{64}$/u.test(recordSha256 ?? "") || digestJson(payload) !== recordSha256 ||
        !isUtcTimestamp(record.at) || !Number.isFinite(at) || at <= previousAt ||
        record.attempt !== 1) fail("review token rotation rollback journal checksum drift");
    previousAt = at;
  }
  const startingPhase = records[0].startingPhase;
  const providerNormalizedPhase =
    startingPhase === "production-repointed-review-augmented";
  const historicalProviderNormalizedIncident = providerNormalizedPhase &&
    records[0]?.incidentCoordinateDigest !== undefined;
  const incidentValidation = historicalProviderNormalizedIncident ?
    validateReviewTokenRotationProviderNormalizedIncidentCore(incidentForwardRecords,
      incidentProof, authorityProof, { production, review, accountId,
        forwardJournalSha256: incidentForwardJournalSha256,
        incidentSnapshotManifestSha256, authorityFileSha256: incidentAuthorityFileSha256 },
      testCapability) : null;
  const freshAugmentedValidation = providerNormalizedPhase &&
    !historicalProviderNormalizedIncident ?
      validateReviewTokenRotationFreshAugmentedForwardPrefix(forwardRecords,
        forwardIntermediateProof, authorityProof, { production, review, accountId, sourceSha,
          rotationAttemptCoordinate, preCreateProof: forwardPreCreateProof,
          preProductionProof: forwardPreProductionProof, recoveryProof: forwardRecoveryProof,
          programDeliveryProof,
          attemptFilesystemEvidence, programLedgerDocument, programLedgerFileSha256 }) :
      null;
  const peerAutomaticallyNormalized = providerNormalizedPhase &&
    peerNormalizationProof?.phase === "predecessor-restored";
  const phaseOperations = {
    predecessor: [],
    "replacement-created": [],
    "production-repointed": ["rotation-restore-production-trigger-old-token"],
    "review-repointed": ["rotation-restore-review-trigger-old-token",
      "rotation-restore-production-trigger-old-token"],
    "production-repointed-review-augmented": [
      "rotation-restore-production-trigger-old-token",
      ...(peerAutomaticallyNormalized ? [] : ["rotation-restore-review-trigger-old-token"]),
    ],
  };
  const incidentStartKeys = ["at", "attempt", "authorityProofDigest", "event",
    "forwardJournalDigest", "incidentCoordinateDigest", "incidentProofDigest",
    "recordSha256", "replacementReviewTokenUuid", "startingPhase"];
  const freshAugmentedStartKeys = ["at", "attempt", "authorityProofDigest", "event",
    "forwardIntermediateProofDigest", "forwardIntermediateProofFileSha256",
    "forwardJournalDigest", "forwardAttemptCoordinateDigest", "recordSha256",
    "replacementReviewTokenUuid", "startingPhase"];
  const freshAugmentedRecoveryStartKeys = [...freshAugmentedStartKeys,
    "forwardPrefixKind", "forwardRecoveryProof"]
    .filter((key) => !["forwardIntermediateProofDigest",
      "forwardIntermediateProofFileSha256"].includes(key));
  if (!Object.hasOwn(phaseOperations, startingPhase) ||
      records[0].authorityProofDigest !== authorityProof.proof_digest ||
      records[0].replacementReviewTokenUuid !== replacementReviewTokenUuid ||
      historicalProviderNormalizedIncident &&
        (!same(sorted(Object.keys(records[0])), sorted(incidentStartKeys)) ||
         Date.parse(incidentProof.capturedAt) > Date.parse(records[0].at) ||
         records[0].incidentCoordinateDigest !== incidentValidation.incidentCoordinateDigest ||
         records[0].incidentProofDigest !== incidentProof.proof_digest ||
         records[0].forwardJournalDigest !== incidentValidation.forwardJournalDigest) ||
      providerNormalizedPhase && !historicalProviderNormalizedIncident &&
        (!same(sorted(Object.keys(records[0])), sorted(
          freshAugmentedValidation.prefixKind === "completed-augmented" ?
            freshAugmentedStartKeys : freshAugmentedRecoveryStartKeys)) ||
         Date.parse((freshAugmentedValidation.prefixKind === "completed-augmented" ?
           forwardIntermediateProof : forwardRecoveryProof).capturedAt) >
           Date.parse(records[0].at) ||
         Date.parse(forwardRecords.at(-1)?.at ?? "") >= Date.parse(records[0].at) ||
         records[0].replacementReviewTokenUuid !==
           freshAugmentedValidation.replacementReviewTokenUuid ||
         records[0].forwardJournalDigest !== freshAugmentedValidation.forwardJournalDigest ||
         records[0].forwardAttemptCoordinateDigest !== rotationAttemptCoordinate.proof_digest ||
         (freshAugmentedValidation.prefixKind === "completed-augmented" ?
           records[0].forwardIntermediateProofDigest !==
             freshAugmentedValidation.intermediateProofDigest ||
           records[0].forwardIntermediateProofFileSha256 !==
             freshAugmentedValidation.intermediateProofFileSha256 :
           records[0].forwardPrefixKind !== freshAugmentedValidation.prefixKind ||
           !same(sorted(Object.keys(records[0].forwardRecoveryProof ?? {})),
             ["proofDigest", "proofFileSha256"]) ||
           records[0].forwardRecoveryProof?.proofDigest !==
             freshAugmentedValidation.intermediateProofDigest ||
           records[0].forwardRecoveryProof?.proofFileSha256 !==
             freshAugmentedValidation.intermediateProofFileSha256)))
    fail("review token rotation rollback starting state drift");
  const mutationOperations = [...phaseOperations[startingPhase],
    ...(startingPhase === "predecessor" ? [] : ["rotation-delete-replacement-wrapper"])];
  const expected = [["review-token-rotation-rollback-started", undefined]];
  for (const [index, operation] of phaseOperations[startingPhase].entries()) {
    expected.push(["current-main-proof-bound", operation],
      ["rollback-authority-checked", operation]);
    if (!historicalProviderNormalizedIncident) expected.push(
      ["provider-proof-bound", providerNormalizedPhase && index > 0 ?
        "rotation-prove-provider-peer-normalization" :
        rollbackPreconditionOperation(operation)]);
    expected.push(["mutation-intent", operation],
      ["provider-response-classified", operation], ["mutation-bound", operation]);
    if (providerNormalizedPhase && index === 0 &&
        (historicalProviderNormalizedIncident || phaseOperations[startingPhase].length === 1))
      expected.push(
      ["provider-proof-bound", "rotation-prove-provider-peer-normalization"]);
  }
  if (startingPhase !== "predecessor") expected.push(
    ...(historicalProviderNormalizedIncident ?
      [["provider-proof-bound", "rotation-prove-predecessor-restored"]] : []),
    ["current-main-proof-bound", "rotation-delete-replacement-wrapper"],
    ["rollback-authority-checked", "rotation-delete-replacement-wrapper"],
    ...(!historicalProviderNormalizedIncident ?
      [["provider-proof-bound", "rotation-prove-predecessor-restored"]] : []),
    ["mutation-intent", "rotation-delete-replacement-wrapper"],
    ["provider-response-classified", "rotation-delete-replacement-wrapper"],
    ["mutation-bound", "rotation-delete-replacement-wrapper"]);
  expected.push(["provider-proof-bound", "rotation-prove-rollback-complete"],
    ["review-token-rotation-rollback-complete", undefined]);
  const terminalBlocked = records.at(-1)?.event === "review-token-rotation-rollback-blocked";
  const actualPairs = records.map(({ event, operation }) => [event, operation]);
  const effectivePairs = terminalBlocked ? actualPairs.slice(0, -1) : actualPairs;
  if (!same(effectivePairs, expected.slice(0, effectivePairs.length)) ||
      (!terminalBlocked && !same(actualPairs, expected)))
    fail("review token rotation rollback journal sequence drift");
  const find = (event, operation) => records.find((record) =>
    record.event === event && record.operation === operation);
  for (const operation of mutationOperations)
    validateReviewTokenRotationRollbackMutationPrefix(records, authorityProof,
      { production, review, sourceSha, replacementReviewTokenUuid, operation,
        terminalBlocked, providerNormalizedIncident: providerNormalizedPhase,
        historicalProviderNormalizedIncident });
  if (!historicalProviderNormalizedIncident) {
    for (const [index, operation] of phaseOperations[startingPhase].entries()) {
      if (providerNormalizedPhase && index > 0) continue;
      const phase = startingPhase === "review-repointed" && index > 0 ?
        "production-repointed" : startingPhase;
      const lowerRecord = index === 0 ? records[0] : find("mutation-bound",
        phaseOperations[startingPhase][index - 1]);
      const bound = validateReviewTokenRotationRollbackPreconditionBinding(records,
        rollbackPreconditionProofs[operation], authorityProof,
        { accountId, sourceSha, operation, phase, lowerRecord });
      if (!bound && !terminalBlocked)
        fail("review token rotation rollback precondition proof is missing");
    }
  }
  const peerNormalizationBound = providerNormalizedPhase ?
    validateReviewTokenRotationPeerNormalizationBinding(records, peerNormalizationProof,
      authorityProof, { accountId, sourceSha,
        historicalIncident: historicalProviderNormalizedIncident }) : null;
  if (providerNormalizedPhase && !peerNormalizationBound && !terminalBlocked)
    fail("review token rotation provider peer normalization proof is missing");
  if (providerNormalizedPhase && peerNormalizationBound) {
    const reviewIntent = find("mutation-intent", "rotation-restore-review-trigger-old-token");
    if (reviewIntent && (Date.parse(peerNormalizationBound.at) > Date.parse(reviewIntent.at) ||
        Date.parse(reviewIntent.at) - Date.parse(peerNormalizationBound.at) > 30_000))
      fail("review token rotation provider peer normalization proof drift");
  }

  if (terminalBlocked) {
    const terminal = records.at(-1);
    const residual = terminal.residualState;
    const terminalKeys = ["at", "attempt", "event", "recordSha256", "residualProofDigest",
      "residualProofFileSha256", "residualState"];
    const residualKeys = ["activeMutation", "liveProductionTokenReference",
      "liveReviewTokenReference", "predecessorWrapperPresent", "replacementWrapperPresent",
      ...(providerNormalizedPhase ? ["reviewPeerAugmented"] : [])];
    const completed = new Set(mutationOperations.filter((operation) =>
      find("mutation-bound", operation)));
    const active = mutationOperations.find((operation) => !completed.has(operation) &&
      find("mutation-intent", operation) &&
      find("provider-response-classified", operation)?.outcome !== "explicit-failure") ?? null;
    const predecessor = authorityProof.journalIdentities.predecessorReviewBuildTokenUuid;
    const replacement = replacementReviewTokenUuid;
    const state = startingPhase === "predecessor" ? {
      liveProductionTokenReference: predecessor, liveReviewTokenReference: predecessor,
      predecessorWrapperPresent: true, replacementWrapperPresent: false,
    } : startingPhase === "replacement-created" ? {
      liveProductionTokenReference: predecessor, liveReviewTokenReference: predecessor,
      predecessorWrapperPresent: true, replacementWrapperPresent: true,
    } : startingPhase === "production-repointed" ? {
      liveProductionTokenReference: replacement, liveReviewTokenReference: predecessor,
      predecessorWrapperPresent: true, replacementWrapperPresent: true,
    } : startingPhase === "production-repointed-review-augmented" ? {
      liveProductionTokenReference: replacement, liveReviewTokenReference: predecessor,
      predecessorWrapperPresent: true, replacementWrapperPresent: true,
      reviewPeerAugmented: true,
    } : {
      liveProductionTokenReference: replacement, liveReviewTokenReference: replacement,
      predecessorWrapperPresent: true, replacementWrapperPresent: true,
    };
    const apply = (value, operation) => {
      const next = { ...value };
      if (operation === "rotation-restore-review-trigger-old-token")
        next.liveReviewTokenReference = predecessor;
      if (operation === "rotation-restore-review-trigger-old-token" &&
          Object.hasOwn(next, "reviewPeerAugmented")) next.reviewPeerAugmented = false;
      if (operation === "rotation-restore-production-trigger-old-token") {
        next.liveProductionTokenReference = predecessor;
        const bound = find("mutation-bound", operation);
        if (Object.hasOwn(next, "reviewPeerAugmented") &&
            typeof bound?.reviewPeerAugmented === "boolean")
          next.reviewPeerAugmented = bound.reviewPeerAugmented;
      }
      if (operation === "rotation-delete-replacement-wrapper")
        next.replacementWrapperPresent = false;
      return next;
    };
    let completedState = state;
    for (const operation of mutationOperations) {
      if (completed.has(operation)) completedState = apply(completedState, operation);
    }
    const activeClassification = active ? find("provider-response-classified", active) : null;
    let allowedStates = !active ? [completedState] :
      activeClassification?.outcome === "explicit-success" ? [apply(completedState, active)] :
        activeClassification?.outcome === "explicit-failure" ? [completedState] :
          [completedState, apply(completedState, active)];
    if (providerNormalizedPhase &&
        active === "rotation-restore-production-trigger-old-token" &&
        activeClassification?.outcome !== "explicit-failure") {
      const normalized = apply(completedState, active);
      const providerOutcomes = [{ ...normalized, reviewPeerAugmented: true },
        { ...normalized, reviewPeerAugmented: false }];
      allowedStates = activeClassification?.outcome === "explicit-success" ?
        providerOutcomes : [completedState, ...providerOutcomes];
    }
    const residualWithoutActive = { ...residual };
    delete residualWithoutActive.activeMutation;
    const prefixAt = Date.parse(records.at(-2)?.at ?? records[0].at);
    const blockedManifest = await loadSnapshot(blockedSnapshotDirectory,
      "snapshot-manifest.json");
    if (Date.parse(blockedManifest?.startedAt ?? "") < prefixAt ||
        Date.parse(blockedManifest?.completedAt ?? "") >
          Date.parse(blockedProof?.capturedAt ?? ""))
      fail("review token rotation rollback residual snapshot chronology drift");
    const residualPhase = !residual.replacementWrapperPresent ? "predecessor" :
      residual.liveProductionTokenReference === predecessor &&
        residual.liveReviewTokenReference === predecessor &&
        residual.reviewPeerAugmented === true ? "production-restored-review-augmented" :
        residual.liveProductionTokenReference === predecessor &&
          residual.liveReviewTokenReference === predecessor ? "predecessor-restored" :
      residual.liveProductionTokenReference === replacement &&
          residual.liveReviewTokenReference === predecessor &&
          residual.reviewPeerAugmented === true ?
            "production-repointed-review-augmented" :
        residual.liveProductionTokenReference === replacement &&
          residual.liveReviewTokenReference === predecessor ? "production-repointed" :
          residual.liveProductionTokenReference === replacement &&
            residual.liveReviewTokenReference === replacement ? "review-repointed" : null;
    if (!residualPhase) fail("review token rotation rollback residual phase drift");
    const validatedBlockedProof = await validateReviewTokenRotationSnapshotDirectory({
      snapshotDirectory: blockedSnapshotDirectory, production, review, accountId, sourceSha,
      phase: residualPhase, productionSentinelProof, predecessorTokenAuthorityProofs,
      replacementTokenAuthorityProof, replacementTokenId,
      productionTriggerUuid: authorityProof.journalIdentities.productionTriggerUuid,
      reviewTriggerUuid: authorityProof.journalIdentities.reviewTriggerUuid,
      predecessorReviewTokenUuid:
        authorityProof.journalIdentities.predecessorReviewBuildTokenUuid,
      replacementReviewTokenUuid: residualPhase === "predecessor" ? undefined :
        replacementReviewTokenUuid, productionPreservationDigest:
        authorityProof.productionPreservationDigest, authorityProof, productionBaselineProof,
      authoritySourceSha, authorityPlanDigest,
      now: Date.parse(blockedProof?.capturedAt ?? ""),
    });
    if (!same(sorted(Object.keys(terminal ?? {})), sorted(terminalKeys)) ||
        !same(sorted(Object.keys(residual ?? {})), sorted(residualKeys)) ||
        residual.activeMutation !== active ||
        !allowedStates.some((allowed) => same(residualWithoutActive, allowed)) ||
        !same(blockedProof, validatedBlockedProof) ||
        terminal.residualProofDigest !== blockedProof.proof_digest ||
        terminal.residualProofFileSha256 !== digestJson(blockedProof) ||
        Date.parse(blockedProof.capturedAt) < prefixAt ||
        Date.parse(blockedProof.capturedAt) > Date.parse(terminal.at))
      fail("review token rotation rollback residual state drift");
    const restoredBound = find("provider-proof-bound", "rotation-prove-predecessor-restored");
    if (restoredBound) {
      validateReviewTokenRotationPhaseProof(restoredProof, "predecessor-restored", authorityProof,
        { accountId, sourceSha }, Date.parse(restoredBound.at), Infinity);
      const finalRestore = phaseOperations[startingPhase].at(-1);
      const deleteMain = find("current-main-proof-bound",
        "rotation-delete-replacement-wrapper");
      const deleteChecked = find("rollback-authority-checked",
        "rotation-delete-replacement-wrapper");
      const deleteIntent = find("mutation-intent", "rotation-delete-replacement-wrapper");
      if (restoredBound.proofDigest !== restoredProof.proof_digest ||
          restoredBound.proofFileSha256 !== digestJson(restoredProof) ||
          (finalRestore && Date.parse(find("mutation-bound", finalRestore)?.at ?? "") >
            Date.parse(restoredProof.capturedAt)) ||
          !historicalProviderNormalizedIncident && (!deleteMain || !deleteChecked ||
            !reviewTokenRotationRollbackProofChronologyValid({
              currentMainAt: deleteMain.at, authorityAt: deleteChecked.at,
              proofCapturedAt: restoredProof.capturedAt, proofBoundAt: restoredBound.at,
              intentAt: deleteIntent?.at })) ||
          Date.parse(restoredProof.capturedAt) > Date.parse(restoredBound.at) ||
          find("mutation-intent", "rotation-delete-replacement-wrapper") &&
            Date.parse(find("mutation-intent", "rotation-delete-replacement-wrapper").at) -
              Date.parse(restoredBound.at) > 30_000)
        fail("review token rotation rollback restored proof chronology drift");
    }
    const completeBound = find("provider-proof-bound", "rotation-prove-rollback-complete");
    if (completeBound) {
      validateReviewTokenRotationPredecessorProof(completeProof, authorityProof,
        { accountId, sourceSha }, Date.parse(completeBound.at), Infinity);
      const finalMutation = mutationOperations.at(-1);
      const lowerBound = finalMutation ? find("mutation-bound", finalMutation) : records[0];
      if (Date.parse(lowerBound?.at ?? "") > Date.parse(completeProof.capturedAt) ||
          completeBound.proofDigest !== completeProof.proof_digest ||
          completeBound.proofFileSha256 !== digestJson(completeProof) ||
          Date.parse(completeProof.capturedAt) > Date.parse(completeBound.at))
        fail("review token rotation rollback terminal provenance drift");
    }
    return { outcome: "workers-builds-review-token-rotation-rollback-blocked-valid",
      mutation: false, residualState: residual, proofDigest: blockedProof.proof_digest };
  }
  if (startingPhase !== "predecessor") {
    validateReviewTokenRotationPhaseProof(restoredProof, "predecessor-restored", authorityProof,
      { accountId, sourceSha }, Date.now(), Infinity);
    const restoredBound = find("provider-proof-bound", "rotation-prove-predecessor-restored");
    const finalRestore = phaseOperations[startingPhase].at(-1);
    const deleteMain = find("current-main-proof-bound", "rotation-delete-replacement-wrapper");
    const deleteChecked = find("rollback-authority-checked",
      "rotation-delete-replacement-wrapper");
    const deleteIntent = find("mutation-intent", "rotation-delete-replacement-wrapper");
    if (restoredBound?.proofDigest !== restoredProof.proof_digest ||
        restoredBound?.proofFileSha256 !== digestJson(restoredProof) ||
        (finalRestore && Date.parse(find("mutation-bound", finalRestore)?.at ?? "") >
          Date.parse(restoredProof.capturedAt)) ||
        !historicalProviderNormalizedIncident && (!deleteMain || !deleteChecked ||
          !reviewTokenRotationRollbackProofChronologyValid({
            currentMainAt: deleteMain.at, authorityAt: deleteChecked.at,
            proofCapturedAt: restoredProof.capturedAt, proofBoundAt: restoredBound?.at,
            intentAt: deleteIntent?.at })) ||
        Date.parse(restoredProof.capturedAt) > Date.parse(restoredBound?.at ?? "") ||
        Date.parse(find("mutation-intent", "rotation-delete-replacement-wrapper")?.at ?? "") -
          Date.parse(restoredBound?.at ?? "") > 30_000)
      fail("review token rotation rollback restored proof chronology drift");
  }
  const completeBound = find("provider-proof-bound", "rotation-prove-rollback-complete");
  validateReviewTokenRotationPredecessorProof(completeProof, authorityProof,
    { accountId, sourceSha }, Date.parse(completeBound?.at ?? ""), Infinity);
  const finalMutation = mutationOperations.at(-1);
  const lowerBound = finalMutation ? find("mutation-bound", finalMutation) : records[0];
  if (Date.parse(lowerBound?.at ?? "") > Date.parse(completeProof.capturedAt) ||
      completeBound?.proofDigest !== completeProof.proof_digest ||
      completeBound?.proofFileSha256 !== digestJson(completeProof) ||
      Date.parse(completeProof.capturedAt ?? "") > Date.parse(completeBound?.at ?? "") ||
      records.at(-1).proofDigest !== completeProof.proof_digest ||
      records.at(-1).productionActivation !== false || records.at(-1).migration0010 !== false ||
      records.at(-1).initialProductionBuild !== false)
    fail("review token rotation rollback terminal provenance drift");
  return { outcome: "workers-builds-review-token-rotation-rollback-complete-valid",
    mutation: false, digest: digestJson(records), startingPhase };
}

export async function validateReviewTokenRotationRollbackJournal(records, authorityProof,
arguments_) {
  const { testCapability: _ignored, ...runtimeArguments } = arguments_ ?? {};
  return validateReviewTokenRotationRollbackJournalCore(records, authorityProof,
    runtimeArguments);
}

export async function validateReviewTokenRotationRollbackJournalForTest(records, authorityProof,
arguments_, testCapability) {
  return validateReviewTokenRotationRollbackJournalCore(records, authorityProof,
    { ...arguments_, testCapability });
}

function membershipReadableReviewContract(review) {
  const contract = structuredClone(review);
  contract.automaticReview.tokenAuthority.userPermissions = structuredClone(
    review.automaticReview.membershipReadRepair.requiredUserPermissions);
  return contract;
}

export function issueDisposableReviewAuthority({ production, review, accountId, sourceSha,
  reviewActivationProof, reviewActivationJournal, inertSetupJournal, inertSetupResults,
  disposableCoordinate, reviewTokenRotationProof, reviewTokenRotationJournal,
  reviewTokenRotationAuthorityProof, reviewTokenRotationIntermediateProof,
  reviewTokenRotationPreCreateProof, reviewTokenRotationPreProductionProof,
  reviewTokenRotationUnreferencedProof, rotationAttemptCoordinate,
  replacementTokenOwnerMembershipProof,
  currentReplacementTokenOwnerMembershipProof,
  currentReviewActiveProof,
  repositoryConnectionProof,
  productionSentinelProof, tokenAuthorityProofs, buildUsageProof, tokenRows }, now = Date.now()) {
  validateRepositoryConnectionOwnerProof(repositoryConnectionProof, accountId, sourceSha, now);
  const sentinel = validateSentinelRefAbsence(productionSentinelProof, now);
  validateTokenAuthorityProofs({ production, review: membershipReadableReviewContract(review),
    accountId, proofs: tokenAuthorityProofs,
    tokenRows, sourceSha }, now);
  validateBuildUsageProof(review, buildUsageProof, accountId, now);
  if (buildUsageProof.monthlyMinutesUsed + review.automaticReview.providerBuildTimeoutMinutes >=
      buildUsageProof.alertAtMinutes)
    fail("disposable review authority lacks reserved build-minute budget");
  const predecessorSourceSha = reviewActivationProof?.sourceSha;
  if (!gitShaPattern.test(predecessorSourceSha ?? ""))
    fail("disposable review authority predecessor source drift");
  validateReviewActiveSnapshotProofEvidence(reviewActivationProof,
    { accountId, sourceSha: predecessorSourceSha },
    Date.parse(reviewActivationProof?.capturedAt ?? ""), 0);
  const journal = validateReviewActivationJournal(reviewActivationJournal,
    reviewActivationProof, predecessorSourceSha);
  const setupProvenance = validateInertSetupProvenance(inertSetupJournal, inertSetupResults,
    journal.preflight);
  const coordinate = validateDisposableReviewCoordinate(disposableCoordinate, sourceSha, now);
  const rotation = validateReviewTokenRotationJournal(reviewTokenRotationJournal,
    reviewTokenRotationProof, reviewTokenRotationAuthorityProof, { production, review,
      accountId, sourceSha, intermediateProof: reviewTokenRotationIntermediateProof,
      preCreateProof: reviewTokenRotationPreCreateProof,
      preProductionProof: reviewTokenRotationPreProductionProof,
      unreferencedProof: reviewTokenRotationUnreferencedProof, rotationAttemptCoordinate });
  validateReplacementTokenOwnerMembershipProof({ accountId, sourceSha,
    proof: replacementTokenOwnerMembershipProof,
    ownerUserId: reviewTokenRotationAuthorityProof.replacementToken.ownerUserId },
  Date.parse(reviewTokenRotationAuthorityProof.capturedAt));
  if (reviewTokenRotationAuthorityProof.evidenceDigests.replacementTokenOwnerMembership !==
      digestJson(replacementTokenOwnerMembershipProof))
    fail("disposable review authority replacement owner evidence drift");
  validateReplacementTokenOwnerMembershipProof({ accountId, sourceSha,
    proof: currentReplacementTokenOwnerMembershipProof,
    ownerUserId: reviewTokenRotationAuthorityProof.replacementToken.ownerUserId }, now);
  validateCurrentDisposableReviewSnapshotProof(currentReviewActiveProof,
    { accountId, sourceSha }, now);
  const currentMembershipCaptured = Date.parse(
    currentReplacementTokenOwnerMembershipProof.capturedAt);
  if (digestJson(currentReplacementTokenOwnerMembershipProof) ===
      digestJson(replacementTokenOwnerMembershipProof) ||
      currentMembershipCaptured <= Date.parse(rotation.terminalAt) ||
      currentMembershipCaptured > Date.parse(currentReviewActiveProof.snapshotStartedAt) ||
      Date.parse(currentReviewActiveProof.snapshotStartedAt) < Date.parse(rotation.terminalAt))
    fail("disposable review authority observations overlap");
  const identities = currentReviewActiveProof.liveIdentities;
  if (rotation.productionTriggerUuid !== setupProvenance.productionTriggerUuid ||
      rotation.reviewTriggerUuid !== journal.reviewTriggerUuid ||
      rotation.productionBuildTokenUuid !== setupProvenance.productionBuildTokenUuid ||
      rotation.predecessorReviewTokenUuid !== setupProvenance.reviewBuildTokenUuid ||
      rotation.repositoryConnectionUuid !== setupProvenance.repositoryConnectionUuid ||
      identities.reviewTriggerUuid !== journal.reviewTriggerUuid ||
      identities.productionTriggerUuid !== setupProvenance.productionTriggerUuid ||
      identities.productionBuildTokenUuid !== setupProvenance.productionBuildTokenUuid ||
      identities.reviewBuildTokenUuid !== rotation.replacementReviewTokenUuid ||
      identities.repositoryConnectionUuid !== setupProvenance.repositoryConnectionUuid)
    fail("disposable review authority journal/live identity drift");
  const capturedAt = new Date(now).toISOString();
  const authority = {
    outcome: "workers-builds-disposable-review-authority-valid", mutation: false,
    phase: "disposable-review-build-and-proof", accountId, sourceSha, capturedAt,
    predecessorSourceSha,
    expiresAt: new Date(now + disposableReviewAuthorityLifetimeMs).toISOString(),
    planDigest: digestJson(provisioningSetupPlan(production, review)),
    productionContractDigest: digestJson(production),
    reviewContractDigest: digestJson(review),
    reviewActiveSnapshot: {
      predecessorProofDigest: reviewActivationProof.proof_digest,
      stateDigest: currentReviewActiveProof.state_digest,
      proofDigest: currentReviewActiveProof.proof_digest,
      capturedAt: currentReviewActiveProof.capturedAt,
      startedAt: currentReviewActiveProof.snapshotStartedAt,
      completedAt: currentReviewActiveProof.snapshotCompletedAt,
      liveIdentities: structuredClone(currentReviewActiveProof.liveIdentities),
    },
    reviewActivationJournal: journal,
    inertSetup: setupProvenance,
    reviewTokenRotation: rotation,
    disposableCoordinate: structuredClone(coordinate),
    repositoryOwner: { capturedAt: repositoryConnectionProof.capturedAt,
      githubApp: structuredClone(repositoryConnectionProof.githubApp),
      websitePreserved: repositoryConnectionProof.websitePreserved },
    productionSentinel: { branch: sentinel.branch, capturedAt: productionSentinelProof.capturedAt },
    tokenAuthority: tokenAuthorityProofs.map(({ kind, tokenId, modifiedOn, capturedAt: value }) =>
      ({ kind, tokenId, modifiedOn, capturedAt: value })),
    buildUsage: { capturedAt: buildUsageProof.capturedAt,
      monthlyMinutesUsed: buildUsageProof.monthlyMinutesUsed,
      alertAtMinutes: buildUsageProof.alertAtMinutes,
      disableAtMinutes: buildUsageProof.disableAtMinutes },
    reservedBuildMinutes: review.automaticReview.providerBuildTimeoutMinutes,
    evidenceDigests: disposableReviewEvidenceDigests({ reviewActivationProof,
      reviewActivationJournal, inertSetupJournal, inertSetupResults, disposableCoordinate,
      reviewTokenRotationProof, reviewTokenRotationJournal, reviewTokenRotationAuthorityProof,
      reviewTokenRotationPreCreateProof, reviewTokenRotationPreProductionProof,
      reviewTokenRotationIntermediateProof, reviewTokenRotationUnreferencedProof,
      rotationAttemptCoordinate,
      replacementTokenOwnerMembershipProof,
      currentReplacementTokenOwnerMembershipProof,
      currentReviewActiveProof, repositoryConnectionProof, productionSentinelProof,
      tokenAuthorityProofs, buildUsageProof }),
    allowedWrites: ["push-one-exact-review-issue-66-branch",
      "delete-that-exact-sha-bound-branch",
      "cancel-only-journal-owned-automatic-review-build-during-cleanup"],
  };
  return { ...authority, proof_digest: digestJson(authority) };
}

export function validateDisposableReviewAuthority(proof, { production, review, accountId,
  sourceSha, reviewActivationProof, reviewActivationJournal, inertSetupJournal,
  inertSetupResults, disposableCoordinate, reviewTokenRotationProof,
  reviewTokenRotationJournal, reviewTokenRotationAuthorityProof,
  reviewTokenRotationPreCreateProof, reviewTokenRotationPreProductionProof,
  reviewTokenRotationIntermediateProof, reviewTokenRotationUnreferencedProof,
  rotationAttemptCoordinate,
  replacementTokenOwnerMembershipProof,
  currentReplacementTokenOwnerMembershipProof,
  currentReviewActiveProof,
  repositoryConnectionProof,
  productionSentinelProof, tokenAuthorityProofs, buildUsageProof }, now = Date.now(),
minimumRemainingMs = reviewActivationTransitionBudgetMs) {
  const keys = ["accountId", "allowedWrites", "buildUsage", "capturedAt", "evidenceDigests",
    "disposableCoordinate", "expiresAt", "inertSetup", "mutation", "outcome", "phase",
    "planDigest", "predecessorSourceSha", "productionContractDigest",
    "productionSentinel", "proof_digest", "repositoryOwner", "reviewActiveSnapshot",
    "reservedBuildMinutes", "reviewActivationJournal", "reviewContractDigest",
    "reviewTokenRotation", "sourceSha",
    "tokenAuthority"];
  const captured = Date.parse(proof?.capturedAt ?? "");
  const expires = Date.parse(proof?.expiresAt ?? "");
  if (!proof || !same(sorted(Object.keys(proof)), sorted(keys)) ||
      proof.outcome !== "workers-builds-disposable-review-authority-valid" ||
      proof.mutation !== false || proof.phase !== "disposable-review-build-and-proof" ||
      proof.accountId !== accountId || proof.sourceSha !== sourceSha ||
      proof.predecessorSourceSha !== reviewActivationProof?.sourceSha ||
      !isUtcTimestamp(proof.capturedAt) || !isUtcTimestamp(proof.expiresAt) ||
      !Number.isFinite(captured) || !Number.isFinite(expires) || captured > now + 30_000 ||
      expires - captured !== disposableReviewAuthorityLifetimeMs || now >= expires ||
      expires - now < minimumRemainingMs ||
      proof.planDigest !== digestJson(provisioningSetupPlan(production, review)) ||
      proof.productionContractDigest !== digestJson(production) ||
      proof.reviewContractDigest !== digestJson(review) ||
      proof.reservedBuildMinutes !== review.automaticReview.providerBuildTimeoutMinutes ||
      !same(proof.allowedWrites, ["push-one-exact-review-issue-66-branch",
        "delete-that-exact-sha-bound-branch",
        "cancel-only-journal-owned-automatic-review-build-during-cleanup"]) ||
      proof.proof_digest !== digestJson(Object.fromEntries(Object.entries(proof)
        .filter(([key]) => key !== "proof_digest"))))
    fail("disposable review authority proof is stale, malformed, or cross-phase");
  validateReviewActiveSnapshotProofEvidence(reviewActivationProof,
    { accountId, sourceSha: proof.predecessorSourceSha },
    Date.parse(reviewActivationProof?.capturedAt ?? ""), 0);
  const journal = validateReviewActivationJournal(reviewActivationJournal,
    reviewActivationProof, proof.predecessorSourceSha);
  const setupProvenance = validateInertSetupProvenance(inertSetupJournal, inertSetupResults,
    journal.preflight);
  const coordinate = validateDisposableReviewCoordinate(disposableCoordinate, sourceSha, captured);
  const rotation = validateReviewTokenRotationJournal(reviewTokenRotationJournal,
    reviewTokenRotationProof, reviewTokenRotationAuthorityProof, { production, review,
      accountId, sourceSha, intermediateProof: reviewTokenRotationIntermediateProof,
      preCreateProof: reviewTokenRotationPreCreateProof,
      preProductionProof: reviewTokenRotationPreProductionProof,
      unreferencedProof: reviewTokenRotationUnreferencedProof, rotationAttemptCoordinate });
  validateReplacementTokenOwnerMembershipProof({ accountId, sourceSha,
    proof: replacementTokenOwnerMembershipProof,
    ownerUserId: reviewTokenRotationAuthorityProof.replacementToken.ownerUserId },
  Date.parse(reviewTokenRotationAuthorityProof.capturedAt));
  if (reviewTokenRotationAuthorityProof.evidenceDigests.replacementTokenOwnerMembership !==
      digestJson(replacementTokenOwnerMembershipProof))
    fail("disposable review authority replacement owner evidence drift");
  validateReplacementTokenOwnerMembershipProof({ accountId, sourceSha,
    proof: currentReplacementTokenOwnerMembershipProof,
    ownerUserId: reviewTokenRotationAuthorityProof.replacementToken.ownerUserId }, captured);
  validateCurrentDisposableReviewSnapshotProof(currentReviewActiveProof,
    { accountId, sourceSha }, captured);
  const currentMembershipCaptured = Date.parse(
    currentReplacementTokenOwnerMembershipProof.capturedAt);
  validateRepositoryConnectionOwnerProof(repositoryConnectionProof, accountId, sourceSha, captured);
  const sentinel = validateSentinelRefAbsence(productionSentinelProof, captured);
  const proofByKind = Object.fromEntries(tokenAuthorityProofs.map((item) => [item.kind, item]));
  validateTokenAuthorityProofs({ production, review: membershipReadableReviewContract(review),
    accountId, proofs: tokenAuthorityProofs,
    tokenRows: { production: { cloudflare_token_id: proofByKind.production?.tokenId },
      review: { cloudflare_token_id: proofByKind.review?.tokenId } }, sourceSha }, captured);
  validateBuildUsageProof(review, buildUsageProof, accountId, captured);
  if (buildUsageProof.monthlyMinutesUsed + proof.reservedBuildMinutes >=
      buildUsageProof.alertAtMinutes)
    fail("disposable review authority lacks reserved build-minute budget");
  const active = proof.reviewActiveSnapshot;
  if (!active || !same(sorted(Object.keys(active)), sorted(["capturedAt", "completedAt",
    "liveIdentities", "predecessorProofDigest", "proofDigest", "startedAt", "stateDigest"])) ||
      active.predecessorProofDigest !== reviewActivationProof.proof_digest ||
      active.stateDigest !== currentReviewActiveProof.state_digest ||
      active.proofDigest !== currentReviewActiveProof.proof_digest ||
      active.capturedAt !== currentReviewActiveProof.capturedAt ||
      active.startedAt !== currentReviewActiveProof.snapshotStartedAt ||
      active.completedAt !== currentReviewActiveProof.snapshotCompletedAt ||
      Date.parse(reviewActivationProof.capturedAt) > Date.parse(journal.terminalAt) ||
      Date.parse(journal.terminalAt) > Date.parse(rotation.terminalAt) ||
      digestJson(currentReplacementTokenOwnerMembershipProof) ===
        digestJson(replacementTokenOwnerMembershipProof) ||
      currentMembershipCaptured <= Date.parse(rotation.terminalAt) ||
      currentMembershipCaptured > Date.parse(currentReviewActiveProof.snapshotStartedAt) ||
      Date.parse(rotation.terminalAt) > Date.parse(currentReviewActiveProof.snapshotStartedAt) ||
      !same(active.liveIdentities, currentReviewActiveProof.liveIdentities) ||
      !same(proof.reviewActivationJournal, journal) ||
      !same(proof.inertSetup, setupProvenance) ||
      !same(proof.reviewTokenRotation, rotation) ||
      !same(proof.disposableCoordinate, coordinate) ||
      rotation.productionTriggerUuid !== setupProvenance.productionTriggerUuid ||
      rotation.reviewTriggerUuid !== journal.reviewTriggerUuid ||
      rotation.productionBuildTokenUuid !== setupProvenance.productionBuildTokenUuid ||
      rotation.predecessorReviewTokenUuid !== setupProvenance.reviewBuildTokenUuid ||
      rotation.repositoryConnectionUuid !== setupProvenance.repositoryConnectionUuid ||
      currentReviewActiveProof.liveIdentities.reviewTriggerUuid !== journal.reviewTriggerUuid ||
      currentReviewActiveProof.liveIdentities.productionTriggerUuid !==
        setupProvenance.productionTriggerUuid ||
      currentReviewActiveProof.liveIdentities.productionBuildTokenUuid !==
        setupProvenance.productionBuildTokenUuid ||
      currentReviewActiveProof.liveIdentities.reviewBuildTokenUuid !==
        rotation.replacementReviewTokenUuid ||
      currentReviewActiveProof.liveIdentities.repositoryConnectionUuid !==
        setupProvenance.repositoryConnectionUuid ||
      !same(proof.evidenceDigests, disposableReviewEvidenceDigests({ reviewActivationProof,
        reviewActivationJournal, inertSetupJournal, inertSetupResults, disposableCoordinate,
        reviewTokenRotationProof, reviewTokenRotationJournal, reviewTokenRotationAuthorityProof,
        reviewTokenRotationPreCreateProof, reviewTokenRotationPreProductionProof,
        reviewTokenRotationIntermediateProof, reviewTokenRotationUnreferencedProof,
        rotationAttemptCoordinate,
        replacementTokenOwnerMembershipProof,
        currentReplacementTokenOwnerMembershipProof,
        currentReviewActiveProof, repositoryConnectionProof, productionSentinelProof,
        tokenAuthorityProofs, buildUsageProof })) ||
      !same(proof.repositoryOwner, { capturedAt: repositoryConnectionProof.capturedAt,
        githubApp: repositoryConnectionProof.githubApp,
        websitePreserved: repositoryConnectionProof.websitePreserved }) ||
      !same(proof.productionSentinel, { branch: sentinel.branch,
        capturedAt: productionSentinelProof.capturedAt }) ||
      !same(proof.tokenAuthority, tokenAuthorityProofs.map(
        ({ kind, tokenId, modifiedOn, capturedAt: value }) =>
          ({ kind, tokenId, modifiedOn, capturedAt: value }))) ||
      !same(proof.buildUsage, { capturedAt: buildUsageProof.capturedAt,
        monthlyMinutesUsed: buildUsageProof.monthlyMinutesUsed,
        alertAtMinutes: buildUsageProof.alertAtMinutes,
        disableAtMinutes: buildUsageProof.disableAtMinutes }))
    fail("disposable review authority evidence binding drift");
  return { outcome: proof.outcome, mutation: false, phase: proof.phase,
    proofValidationTime: captured, checkedAt: new Date(now).toISOString(),
    expiresAt: proof.expiresAt, proof_digest: proof.proof_digest };
}

export function issueReviewActivationAuthority({ production, review, accountId, sourceSha,
  stagedProof, currentStagedProof, repositoryConnectionProof, productionSentinelProof,
  tokenAuthorityProofs, buildUsageProof, tokenRows }, now = Date.now()) {
  validateRepositoryConnectionOwnerProof(repositoryConnectionProof, accountId, sourceSha, now);
  const sentinel = validateSentinelRefAbsence(productionSentinelProof, now);
  validateTokenAuthorityProofs({ production, review, accountId, proofs: tokenAuthorityProofs,
    tokenRows, sourceSha }, now);
  validateBuildUsageProof(review, buildUsageProof, accountId, now);
  validateStagedProof(stagedProof, currentStagedProof, now);
  const capturedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + reviewActivationAuthorityLifetimeMs).toISOString();
  const authority = {
    outcome: "workers-builds-review-activation-authority-valid",
    mutation: false,
    phase: "review-trigger-activation-and-proof",
    accountId,
    sourceSha,
    capturedAt,
    expiresAt,
    planDigest: digestJson(provisioningSetupPlan(production, review)),
    productionContractDigest: digestJson(production),
    reviewContractDigest: digestJson(review),
    stagedSnapshot: {
      predecessorProofDigest: stagedProof.proof_digest,
      stateDigest: currentStagedProof.state_digest,
      proofDigest: currentStagedProof.proof_digest,
      capturedAt: currentStagedProof.capturedAt,
      startedAt: currentStagedProof.snapshotStartedAt,
      completedAt: currentStagedProof.snapshotCompletedAt,
    },
    repositoryOwner: {
      capturedAt: repositoryConnectionProof.capturedAt,
      githubApp: structuredClone(repositoryConnectionProof.githubApp),
      websitePreserved: repositoryConnectionProof.websitePreserved,
    },
    productionSentinel: { branch: sentinel.branch,
      capturedAt: productionSentinelProof.capturedAt },
    tokenAuthority: tokenAuthorityProofs.map(({ kind, tokenId, modifiedOn, capturedAt: captured }) =>
      ({ kind, tokenId, modifiedOn, capturedAt: captured })),
    buildUsage: {
      capturedAt: buildUsageProof.capturedAt,
      monthlyMinutesUsed: buildUsageProof.monthlyMinutesUsed,
      alertAtMinutes: buildUsageProof.alertAtMinutes,
      disableAtMinutes: buildUsageProof.disableAtMinutes,
    },
    evidenceDigests: reviewActivationEvidenceDigests({ stagedProof, repositoryConnectionProof,
      productionSentinelProof, tokenAuthorityProofs, buildUsageProof }),
  };
  return { ...authority, proof_digest: digestJson(authority) };
}

export function validateReviewActivationAuthority(proof, { production, review, accountId,
  sourceSha, stagedProof, repositoryConnectionProof, productionSentinelProof,
  tokenAuthorityProofs, buildUsageProof }, now = Date.now(),
minimumRemainingMs = reviewActivationTransitionBudgetMs) {
  const keys = ["accountId", "buildUsage", "capturedAt", "evidenceDigests", "expiresAt",
    "mutation", "outcome", "phase", "planDigest", "productionContractDigest",
    "productionSentinel", "proof_digest", "repositoryOwner", "reviewContractDigest",
    "sourceSha", "stagedSnapshot", "tokenAuthority"];
  const captured = Date.parse(proof?.capturedAt ?? "");
  const expires = Date.parse(proof?.expiresAt ?? "");
  if (!proof || !same(sorted(Object.keys(proof)), sorted(keys)) ||
      proof.outcome !== "workers-builds-review-activation-authority-valid" ||
      proof.mutation !== false || proof.phase !== "review-trigger-activation-and-proof" ||
      proof.accountId !== accountId || proof.sourceSha !== sourceSha ||
      !isUtcTimestamp(proof.capturedAt) || !isUtcTimestamp(proof.expiresAt) ||
      !Number.isFinite(captured) || !Number.isFinite(expires) ||
      captured > now + 30_000 || expires - captured !== reviewActivationAuthorityLifetimeMs ||
      now >= expires || expires - now < minimumRemainingMs ||
      proof.planDigest !== digestJson(provisioningSetupPlan(production, review)) ||
      proof.productionContractDigest !== digestJson(production) ||
      proof.reviewContractDigest !== digestJson(review) ||
      proof.proof_digest !== digestJson(Object.fromEntries(Object.entries(proof)
        .filter(([key]) => key !== "proof_digest"))))
    fail("review activation authority proof is stale, malformed, or cross-phase");
  validateStagedSnapshotProofEvidence(stagedProof, { accountId, sourceSha }, captured);
  const stagedCaptured = Date.parse(proof.stagedSnapshot?.capturedAt ?? "");
  const stagedStarted = Date.parse(proof.stagedSnapshot?.startedAt ?? "");
  const stagedCompleted = Date.parse(proof.stagedSnapshot?.completedAt ?? "");
  validateRepositoryConnectionOwnerProof(repositoryConnectionProof, accountId, sourceSha,
    captured);
  const sentinel = validateSentinelRefAbsence(productionSentinelProof, captured);
  const proofByKind = Object.fromEntries(tokenAuthorityProofs.map((item) => [item.kind, item]));
  validateTokenAuthorityProofs({ production, review, accountId, proofs: tokenAuthorityProofs,
    tokenRows: {
      production: { cloudflare_token_id: proofByKind.production?.tokenId },
      review: { cloudflare_token_id: proofByKind.review?.tokenId },
    }, sourceSha }, captured);
  validateBuildUsageProof(review, buildUsageProof, accountId, captured);
  if (!proof.stagedSnapshot ||
      !same(sorted(Object.keys(proof.stagedSnapshot)), sorted(["capturedAt", "completedAt",
        "predecessorProofDigest", "proofDigest", "startedAt", "stateDigest"])) ||
      proof.stagedSnapshot.predecessorProofDigest !== stagedProof.proof_digest ||
      proof.stagedSnapshot.stateDigest !== stagedProof.state_digest ||
      !/^[0-9a-f]{64}$/u.test(proof.stagedSnapshot.proofDigest ?? "") ||
      proof.stagedSnapshot.proofDigest !== digestJson({
        state_digest: proof.stagedSnapshot.stateDigest,
        snapshotStartedAt: proof.stagedSnapshot.startedAt,
        snapshotCompletedAt: proof.stagedSnapshot.completedAt,
        capturedAt: proof.stagedSnapshot.capturedAt,
      }) ||
      !isUtcTimestamp(proof.stagedSnapshot.capturedAt) ||
      !isUtcTimestamp(proof.stagedSnapshot.startedAt) ||
      !isUtcTimestamp(proof.stagedSnapshot.completedAt) ||
      !Number.isFinite(stagedCaptured) || !Number.isFinite(stagedStarted) ||
      !Number.isFinite(stagedCompleted) || stagedStarted > stagedCompleted ||
      stagedCompleted > stagedCaptured || stagedCaptured > captured ||
      stagedCompleted - stagedStarted > 5 * 60_000 ||
      !same(proof.evidenceDigests, reviewActivationEvidenceDigests({ stagedProof,
    repositoryConnectionProof, productionSentinelProof, tokenAuthorityProofs,
    buildUsageProof })) ||
      !same(proof.repositoryOwner, { capturedAt: repositoryConnectionProof.capturedAt,
        githubApp: repositoryConnectionProof.githubApp,
        websitePreserved: repositoryConnectionProof.websitePreserved }) ||
      !same(proof.productionSentinel, { branch: sentinel.branch,
        capturedAt: productionSentinelProof.capturedAt }) ||
      !same(proof.tokenAuthority, tokenAuthorityProofs.map(
        ({ kind, tokenId, modifiedOn, capturedAt: capturedAt_ }) =>
          ({ kind, tokenId, modifiedOn, capturedAt: capturedAt_ }))) ||
      !same(proof.buildUsage, { capturedAt: buildUsageProof.capturedAt,
        monthlyMinutesUsed: buildUsageProof.monthlyMinutesUsed,
        alertAtMinutes: buildUsageProof.alertAtMinutes,
        disableAtMinutes: buildUsageProof.disableAtMinutes }))
    fail("review activation authority evidence binding drift");
  return { outcome: proof.outcome, mutation: false, phase: proof.phase,
    proofValidationTime: captured, checkedAt: new Date(now).toISOString(),
    expiresAt: proof.expiresAt, proof_digest: proof.proof_digest };
}

export function validateReviewActivationAuthorityCheckpoint(proof, arguments_, checkpoint,
  now = Date.now()) {
  const checked = Date.parse(checkpoint?.checkedAt ?? "");
  if (!checkpoint || !same(sorted(Object.keys(checkpoint)), sorted(["checkedAt", "expiresAt",
    "mutation", "outcome", "phase", "proofValidationTime", "proof_digest"])) ||
      checkpoint.outcome !== "workers-builds-review-activation-authority-valid" ||
      checkpoint.mutation !== false || checkpoint.phase !== "review-trigger-activation-and-proof" ||
      checkpoint.proof_digest !== proof?.proof_digest || !isUtcTimestamp(checkpoint.checkedAt) ||
      !Number.isFinite(checked) || checked > now)
    fail("review activation authority checkpoint is stale or malformed");
  const start = validateReviewActivationAuthority(proof, arguments_, checked,
    reviewActivationTransitionBudgetMs);
  if (!same(start, checkpoint)) fail("review activation authority checkpoint drift");
  return validateReviewActivationAuthority(proof, arguments_, now, 0);
}

export function productionTriggerSpec(contract, {
  externalScriptId, repositoryConnectionUuid, buildTokenUuid,
}) {
  if (!scriptTagPattern.test(externalScriptId ?? "")) fail("external script tag is malformed");
  for (const [label, value] of [
    ["repository connection", repositoryConnectionUuid],
    ["build token", buildTokenUuid],
  ]) if (!uuidPattern.test(value ?? "")) fail(`${label} UUID is malformed`);
  return {
    trigger_name: "Atrinik automatic production main",
    external_script_id: externalScriptId,
    repo_connection_uuid: repositoryConnectionUuid,
    build_token_uuid: buildTokenUuid,
    build_command: contract.installCommand,
    deploy_command: contract.deployCommand,
    root_directory: contract.rootDirectory,
    branch_includes: [contract.productionBranch],
    branch_excludes: [],
    path_includes: contract.pathIncludes,
    path_excludes: contract.pathExcludes,
    build_caching_enabled: false,
  };
}

export function automaticReviewTriggerSpec(contract, {
  externalScriptId, repositoryConnectionUuid, buildTokenUuid,
}) {
  if (!scriptTagPattern.test(externalScriptId ?? "")) fail("external script tag is malformed");
  for (const [label, value] of [
    ["repository connection", repositoryConnectionUuid],
    ["build token", buildTokenUuid],
  ]) if (!uuidPattern.test(value ?? "")) fail(`${label} UUID is malformed`);
  const automatic = contract.automaticReview;
  return {
    trigger_name: "Atrinik build-only review",
    external_script_id: externalScriptId,
    repo_connection_uuid: repositoryConnectionUuid,
    build_token_uuid: buildTokenUuid,
    build_command: automatic.buildCommand,
    deploy_command: automatic.deployCommand,
    root_directory: automatic.rootDirectory,
    branch_includes: automatic.previewBranchIncludes,
    branch_excludes: automatic.previewBranchExcludes,
    path_includes: automatic.pathIncludes,
    path_excludes: automatic.pathExcludes,
    build_caching_enabled: false,
  };
}

export function validateTriggerSnapshot(actual, expected, label) {
  const keys = [
    "external_script_id", "build_token_uuid", "build_command", "deploy_command",
    "branch_includes", "branch_excludes", "path_includes", "path_excludes",
    "build_caching_enabled",
  ];
  for (const key of keys) if (!same(actual?.[key], expected[key]))
    fail(`${label} trigger ${key} drift`);
  if (
    actual.trigger_name !== expected.trigger_name ||
    !uuidPattern.test(actual.trigger_uuid ?? "") ||
    actual.deleted_on != null
  ) fail(`${label} trigger identity drift`);
  if (normalizedRoot(actual.root_directory) !== normalizedRoot(expected.root_directory))
    fail(`${label} trigger root_directory drift`);
  const connection = actual.repo_connection ?? {};
  if (
    connection.repo_connection_uuid !== expected.repo_connection_uuid ||
    connection.provider_type !== "github" ||
    connection.provider_account_id !== "6371603" ||
    connection.provider_account_name !== "atrinik" ||
    connection.repo_id !== "1324297032" ||
    connection.repo_name !== "metaserver-worker"
  ) fail(`${label} repository connection drift`);
}

export function productionEnvironmentSpec(contract, values) {
  const protectedNames = Object.values(contract.protectedInputs);
  const result = {
    SKIP_DEPENDENCY_INSTALL: { is_secret: false, value: "1" },
  };
  for (const name of protectedNames) {
    if (typeof values?.[name] !== "string" || values[name].length === 0)
      fail(`protected input ${name} is missing`);
    if (Buffer.byteLength(values[name]) > 5 * 1024)
      fail(`protected input ${name} exceeds the provider limit`);
    result[name] = { is_secret: true, value: values[name] };
  }
  return result;
}

export function automaticReviewEnvironmentSpec(review) {
  if (!same(review.automaticReview.buildEnvironment, { SKIP_DEPENDENCY_INSTALL: "1" }))
    fail("review trigger environment drift");
  return { SKIP_DEPENDENCY_INSTALL: { is_secret: false, value: "1" } };
}

function resultReference(operation, field) {
  return { resultReference: `${operation}.${field}` };
}

function apiPathReference(template, operation, field) {
  return { template, resultReference: `${operation}.${field}` };
}

function privateFileReference(environmentVariable) {
  return { privateFileEnvironment: environmentVariable };
}

function reviewActivationAuthorityPrecondition() {
  return {
    proof: resultReference("review-activation-authority", "proof_digest"),
    command: "npm run provision:workers-builds:verify-review-activation-authority-proof",
    minimumRemainingSeconds: reviewActivationTransitionBudgetMs / 1000,
  };
}

function disposableReviewAuthorityPrecondition() {
  return {
    proof: resultReference("disposable-review-proof-authority", "proof_digest"),
    command: "npm run provision:workers-builds:verify-disposable-review-authority-proof",
    minimumRemainingSeconds: reviewActivationTransitionBudgetMs / 1000,
  };
}

function reviewTokenRotationAuthorityPrecondition() {
  return {
    proof: resultReference("review-token-rotation-authority", "proof_digest"),
    command: "npm run provision:workers-builds:verify-review-token-rotation-authority-proof",
    minimumRemainingSeconds: reviewTokenRotationTransitionBudgetMs / 1000,
  };
}

function currentMainMutationPrecondition() {
  return { command: "authenticated-current-main-proof-immediately-before-mutation",
    ref: currentMainRef, sourceSha: "exact-reviewed-current-main-sha", maximumAgeSeconds: 300 };
}

function historicalReviewTokenRotationAuthorityPrecondition() {
  return { proof: resultReference("review-token-rotation-authority", "proof_digest"),
    command: "npm run provision:workers-builds:verify-review-token-rotation-authority-proof-historical",
    purpose: "rollback-only-no-expiry-reuse" };
}

function providerNormalizedIncidentHistoricalAuthorityPrecondition() {
  return { proof: resultReference("review-token-rotation-authority", "proof_digest"),
    command: "npm run provision:workers-builds:verify-review-token-rotation-provider-normalized-authority-proof-historical",
    exactIncidentCoordinate: structuredClone(reviewTokenRotationProviderNormalizedIncident),
    purpose: "provider-normalized-incident-rollback-only-no-expiry-reuse" };
}

function triggerPlanSpec(spec, scriptOperation, tokenOperation) {
  return {
    ...spec,
    root_directory: spec.root_directory || "/",
    external_script_id: resultReference(scriptOperation, "script_tag"),
    repo_connection_uuid: resultReference("repository-connection", "repo_connection_uuid"),
    build_token_uuid: resultReference(tokenOperation, "build_token_uuid"),
  };
}

function productionEnvironmentPlan(contract) {
  const valueSources = {
    [contract.protectedInputs.accountVariable]: privateFileReference(
      "ATRINIK_CLOUDFLARE_ACCOUNT_ID_FILE"),
    [contract.protectedInputs.coreConfigVariable]: privateFileReference(
      "ATRINIK_PRODUCTION_CORE_CONFIG_FILE"),
    [contract.protectedInputs.publisherConfigVariable]: privateFileReference(
      "ATRINIK_PRODUCTION_PUBLISHER_CONFIG_FILE"),
    [contract.protectedInputs.rendezvousConfigVariable]: privateFileReference(
      "ATRINIK_PRODUCTION_RENDEZVOUS_CONFIG_FILE"),
    [contract.protectedInputs.buildsApiTokenVariable]: privateFileReference(
      "ATRINIK_PRODUCTION_LEASE_TOKEN_FILE"),
    [contract.protectedInputs.controlPlaneGateVariable]: { literal: "routine" },
  };
  return Object.fromEntries([
    ["SKIP_DEPENDENCY_INSTALL", { is_secret: false, valueSource: { literal: "1" } }],
    ...Object.values(contract.protectedInputs).map((name) =>
      [name, { is_secret: true, valueSource: valueSources[name] }]),
  ]);
}

export function provisioningSetupPlan(production, review) {
  const placeholderTag = "1".repeat(32);
  const placeholderUuid = "11111111-1111-4111-8111-111111111111";
  const productionSentinel = privateFileReference(
    "ATRINIK_PRODUCTION_STAGING_SENTINEL_BRANCH_FILE");
  const productionFinal = productionTriggerSpec(production, {
    externalScriptId: placeholderTag,
    repositoryConnectionUuid: placeholderUuid,
    buildTokenUuid: placeholderUuid,
  });
  const reviewFinal = automaticReviewTriggerSpec(review, {
    externalScriptId: placeholderTag,
    repositoryConnectionUuid: placeholderUuid,
    buildTokenUuid: placeholderUuid,
  });
  const productionStaged = structuredClone(productionFinal);
  productionStaged.branch_includes = [productionSentinel];
  const reviewStagingRoot = privateFileReference(
    "ATRINIK_REVIEW_STAGING_ROOT_DIRECTORY_FILE");
  const reviewStaged = structuredClone(reviewFinal);
  reviewStaged.root_directory = reviewStagingRoot;
  reviewStaged.build_command = "exit 1";
  reviewStaged.deploy_command = "exit 1";
  const plan = {
    schemaVersion: 1,
    outcome: "workers-builds-reviewed-setup-plan",
    mutation: false,
    providerTopology: structuredClone(review.automaticReview.providerTopology),
    retainedFailedRequest: {
      error: 12002,
      topology: "one-repository-connection-two-workers",
      disposition: "forbidden-never-retry-or-vary",
    },
    retainedRejectedPreviewRequest: {
      error: 12002,
      topology: "one-worker-two-triggers-private-sentinel-preview",
      disposition: "forbidden-never-retry-or-normalize",
    },
    repositoryConnection: structuredClone(githubRepository),
    gates: [
      "provider-setup-authorization",
      "review-trigger-activation-and-proof",
      "review-token-rotation",
      "review-membership-read-policy-and-proof",
      "production-trigger-activation",
      "migration-0010",
      "initial-automatic-production-proof",
    ],
    privateInputs: [
      "ATRINIK_CLOUDFLARE_ACCOUNT_ID_FILE",
      "ATRINIK_GITHUB_CURRENT_MAIN_PROOF_FILE",
      "ATRINIK_REVIEWED_SOURCE_SHA_FILE",
      "ATRINIK_WORKERS_BUILDS_API_TOKEN_FILE",
      "ATRINIK_PRODUCTION_STAGING_SENTINEL_BRANCH_FILE",
      "ATRINIK_PRODUCTION_STAGING_SENTINEL_REFS_FILE",
      "ATRINIK_REVIEW_STAGING_ROOT_DIRECTORY_FILE",
      "ATRINIK_REVIEW_STAGING_ROOT_CREATE_PROOF_FILE",
      "ATRINIK_REVIEW_STAGING_ROOT_ACTIVATION_PROOF_FILE",
      "ATRINIK_PRODUCTION_STAGED_TRIGGER_UUID_FILE",
      "ATRINIK_REVIEW_STAGED_TRIGGER_UUID_FILE",
      "ATRINIK_REVIEW_STAGED_ENVIRONMENT_PROOF_OUTPUT_FILE",
      "ATRINIK_REVIEW_ACTIVATION_AUTHORITY_PROOF_OUTPUT_FILE",
      "ATRINIK_REVIEW_ACTIVATION_AUTHORITY_PROOF_FILE",
      "ATRINIK_REPOSITORY_CONNECTION_OWNER_PROOF_FILE",
      "ATRINIK_WORKERS_BUILDS_USAGE_PROOF_FILE",
      "ATRINIK_STAGED_PROOF_OUTPUT_FILE",
      "ATRINIK_STAGED_PROOF_FILE",
      "ATRINIK_REVIEW_ACTIVATION_PROOF_OUTPUT_FILE",
      "ATRINIK_REVIEW_ACTIVATION_PROOF_FILE",
      "ATRINIK_REVIEW_ACTIVATION_JOURNAL_FILE",
      "ATRINIK_INERT_SETUP_JOURNAL_FILE",
      "ATRINIK_INERT_SETUP_RESULTS_FILE",
      "ATRINIK_DISPOSABLE_REVIEW_COORDINATE_FILE",
      "ATRINIK_CURRENT_REVIEW_ACTIVE_PROOF_OUTPUT_FILE",
      "ATRINIK_CURRENT_REVIEW_ACTIVE_PROOF_FILE",
      "ATRINIK_DISPOSABLE_REVIEW_AUTHORITY_PROOF_OUTPUT_FILE",
      "ATRINIK_DISPOSABLE_REVIEW_AUTHORITY_PROOF_FILE",
      "ATRINIK_DISPOSABLE_REVIEW_PUSH_AUTHORIZATION_RECEIPT_OUTPUT_FILE",
      "ATRINIK_DISPOSABLE_REVIEW_DELETE_AUTHORIZATION_RECEIPT_OUTPUT_FILE",
      "ATRINIK_PRODUCTION_ACTIVATION_PROOF_OUTPUT_FILE",
      "ATRINIK_REVIEW_RESULT_PROOF_FILE",
      "ATRINIK_PRODUCTION_BUILD_TOKEN_SECRET_FILE",
      "ATRINIK_PRODUCTION_BUILD_TOKEN_ID_FILE",
      "ATRINIK_PRODUCTION_BUILD_TOKEN_PERMISSION_PROOF_FILE",
      "ATRINIK_REVIEW_BUILD_TOKEN_SECRET_FILE",
      "ATRINIK_REVIEW_BUILD_TOKEN_ID_FILE",
      "ATRINIK_REVIEW_BUILD_TOKEN_PERMISSION_PROOF_FILE",
      "ATRINIK_REPLACEMENT_REVIEW_BUILD_TOKEN_SECRET_FILE",
      "ATRINIK_REPLACEMENT_REVIEW_BUILD_TOKEN_ID_FILE",
      "ATRINIK_REPLACEMENT_REVIEW_BUILD_TOKEN_UUID_FILE",
      "ATRINIK_REPLACEMENT_REVIEW_BUILD_TOKEN_PERMISSION_PROOF_FILE",
      "ATRINIK_REPLACEMENT_REVIEW_TOKEN_OWNER_MEMBERSHIP_PROOF_FILE",
      "ATRINIK_CURRENT_REPLACEMENT_REVIEW_TOKEN_OWNER_MEMBERSHIP_PROOF_FILE",
      "ATRINIK_REVIEW_MEMBERSHIP_SUCCESSOR_INCIDENT_PROOF_FILE",
      "ATRINIK_REVIEW_MEMBERSHIP_SUCCESSOR_AUTHORITY_PROOF_FILE",
      "ATRINIK_REVIEW_MEMBERSHIP_SUCCESSOR_JOURNAL_FILE",
      "ATRINIK_REVIEW_MEMBERSHIP_SUCCESSOR_RESULT_PROOF_FILE",
      "ATRINIK_REVIEW_MEMBERSHIP_SUCCESSOR_SNAPSHOT_MANIFEST_FILE",
      "ATRINIK_REVIEW_TOKEN_ROTATION_AUTHORITY_PROOF_OUTPUT_FILE",
      "ATRINIK_REVIEW_TOKEN_ROTATION_AUTHORITY_PROOF_FILE",
      "ATRINIK_REVIEW_TOKEN_ROTATION_PREDECESSOR_PROOF_FILE",
      "ATRINIK_REVIEW_TOKEN_ROTATION_PREDECESSOR_PROOF_OUTPUT_FILE",
      "ATRINIK_REVIEW_TOKEN_ROTATION_PRODUCTION_BASELINE_PROOF_FILE",
      "ATRINIK_REVIEW_TOKEN_ROTATION_PRODUCTION_BASELINE_PROOF_OUTPUT_FILE",
      "ATRINIK_REVIEW_TOKEN_ROTATION_PROGRAM_PROOF_FILE",
      "ATRINIK_REVIEW_TOKEN_ROTATION_PROGRAM_LEDGER_FILE",
      "ATRINIK_REVIEW_TOKEN_ROTATION_ATTEMPT_COORDINATE_FILE",
      "ATRINIK_REVIEW_TOKEN_ROTATION_EXECUTOR_FILE",
      "ATRINIK_REVIEW_TOKEN_ROTATION_PRE_CREATE_PROOF_FILE",
      "ATRINIK_REVIEW_TOKEN_ROTATION_PRE_CREATE_PROOF_OUTPUT_FILE",
      "ATRINIK_REVIEW_TOKEN_ROTATION_PRE_PRODUCTION_PROOF_FILE",
      "ATRINIK_REVIEW_TOKEN_ROTATION_PRE_PRODUCTION_PROOF_OUTPUT_FILE",
      "ATRINIK_REVIEW_TOKEN_ROTATION_ROLLBACK_PRECONDITION_PHASE_FILE",
      "ATRINIK_REVIEW_TOKEN_ROTATION_ROLLBACK_PRECONDITION_PROOF_OUTPUT_FILE",
      "ATRINIK_REVIEW_TOKEN_ROTATION_INTERMEDIATE_PROOF_OUTPUT_FILE",
      "ATRINIK_REVIEW_TOKEN_ROTATION_INTERMEDIATE_PROOF_FILE",
      "ATRINIK_REVIEW_TOKEN_ROTATION_PROVIDER_NORMALIZED_FORWARD_JOURNAL_FILE",
      "ATRINIK_REVIEW_TOKEN_ROTATION_PROVIDER_NORMALIZED_INCIDENT_SNAPSHOT_DIRECTORY_FILE",
      "ATRINIK_REVIEW_TOKEN_ROTATION_PROVIDER_NORMALIZED_INCIDENT_PROOF_FILE",
      "ATRINIK_REVIEW_TOKEN_ROTATION_PROVIDER_NORMALIZED_INCIDENT_PROOF_OUTPUT_FILE",
      "ATRINIK_REVIEW_TOKEN_ROTATION_PROVIDER_NORMALIZED_ROLLBACK_JOURNAL_FILE",
      "ATRINIK_REVIEW_TOKEN_ROTATION_PROVIDER_NORMALIZED_BLOCKED_PROOF_FILE",
      "ATRINIK_REVIEW_TOKEN_ROTATION_PROVIDER_NORMALIZED_BLOCKED_SNAPSHOT_DIRECTORY_FILE",
      "ATRINIK_REVIEW_TOKEN_ROTATION_PROVIDER_NORMALIZED_EXECUTOR_FILE",
      "ATRINIK_REVIEW_TOKEN_ROTATION_FAILED_DELETE_GUARD_RESPONSE_FILE",
      "ATRINIK_REVIEW_TOKEN_ROTATION_PEER_NORMALIZATION_PROOF_FILE",
      "ATRINIK_REVIEW_TOKEN_ROTATION_PEER_NORMALIZATION_PROOF_OUTPUT_FILE",
      "ATRINIK_REVIEW_TOKEN_ROTATION_ROLLBACK_RESTORED_PROOF_FILE",
      "ATRINIK_REVIEW_TOKEN_ROTATION_BLOCKED_DELETE_CURRENT_PROOF_OUTPUT_FILE",
      "ATRINIK_REVIEW_TOKEN_ROTATION_BLOCKED_DELETE_CURRENT_PROOF_FILE",
      "ATRINIK_REVIEW_TOKEN_ROTATION_BLOCKED_DELETE_RECOVERY_COORDINATE_FILE",
      "ATRINIK_REVIEW_TOKEN_ROTATION_BLOCKED_DELETE_AUTHORITY_PROOF_OUTPUT_FILE",
      "ATRINIK_REVIEW_TOKEN_ROTATION_BLOCKED_DELETE_AUTHORITY_PROOF_FILE",
      "ATRINIK_REVIEW_TOKEN_ROTATION_BLOCKED_DELETE_AUTHORIZATION_RECEIPT_OUTPUT_FILE",
      "ATRINIK_REVIEW_TOKEN_ROTATION_BLOCKED_DELETE_AUTHORIZATION_RECEIPT_FILE",
      "ATRINIK_REVIEW_TOKEN_ROTATION_BLOCKED_DELETE_AUTHORITY_CURRENT_MAIN_PROOF_FILE",
      "ATRINIK_REVIEW_TOKEN_ROTATION_BLOCKED_DELETE_JOURNAL_FILE",
      "ATRINIK_REVIEW_TOKEN_ROTATION_BLOCKED_DELETE_COMPLETE_PROOF_FILE",
      "ATRINIK_REVIEW_TOKEN_ROTATION_BLOCKED_DELETE_BLOCKED_PROOF_FILE",
      "ATRINIK_REVIEW_TOKEN_ROTATION_BLOCKED_DELETE_BLOCKED_SNAPSHOT_DIRECTORY_FILE",
      "ATRINIK_REVIEW_TOKEN_ROTATION_BLOCKED_DELETE_TERMINAL_CURRENT_MAIN_PROOF_FILE",
      "ATRINIK_REVIEW_TOKEN_ROTATION_UNREFERENCED_PROOF_OUTPUT_FILE",
      "ATRINIK_REVIEW_TOKEN_ROTATION_UNREFERENCED_PROOF_FILE",
      "ATRINIK_REVIEW_TOKEN_ROTATION_COMPLETE_PROOF_OUTPUT_FILE",
      "ATRINIK_REVIEW_TOKEN_ROTATION_COMPLETE_PROOF_FILE",
      "ATRINIK_REVIEW_TOKEN_ROTATION_ROLLBACK_RESTORED_PROOF_OUTPUT_FILE",
      "ATRINIK_REVIEW_TOKEN_ROTATION_ROLLBACK_COMPLETE_PROOF_OUTPUT_FILE",
      "ATRINIK_REVIEW_TOKEN_ROTATION_JOURNAL_FILE",
      "ATRINIK_PRODUCTION_CORE_CONFIG_FILE",
      "ATRINIK_PRODUCTION_PUBLISHER_CONFIG_FILE",
      "ATRINIK_PRODUCTION_RENDEZVOUS_CONFIG_FILE",
      "ATRINIK_PRODUCTION_LEASE_TOKEN_FILE",
    ],
    credentialAuthority: {
      controlPlaneOperator: {
        tokenType: review.automaticReview.controlPlaneOperator.tokenType,
        contractPermission: review.automaticReview.controlPlaneOperator.permission,
        providerAccountPermissions: [
          "Workers Builds Configuration:Edit",
          "Workers Scripts:Read",
        ],
        credentialBuildReadable: false,
      },
      productionBuildToken: {
        accountPermissions: ["Workers Scripts:Edit", "D1:Read"],
        purpose: "read-exact-worker-config-and-migration-ledger-deploy-three-workers",
        forbiddenAuthority: ["D1:Edit", "DNS", "WAF", "Account Administration",
          "Secrets:Read", "destructive-resource-authority"],
      },
      productionLeaseToken: {
        accountPermissions: ["Workers Builds Configuration:Edit"],
        purpose: "read-trigger-and-build-inventory-cancel-only-competing-main-builds",
      },
      reviewBuildToken: structuredClone(review.automaticReview.tokenAuthority),
      stagingBuildToken: {
        source: "review-build-token",
        accountPermissions: [],
        zonePermissions: [],
        accountResources: [],
        purpose: "inert-trigger-staging-only-before-atomic-production-activation",
      },
      replacementReviewBuildToken: structuredClone(review.automaticReview.tokenAuthority),
    },
    setupOperations: [
      { id: "preflight", actor: "workers-builds-control-plane-operator",
        action: "require-exact-private-readback-no-competing-trigger-and-validate-private-random-production-sentinel-ref-absence",
        mutation: false,
        commands: [
          "gh api repos/atrinik/metaserver-worker/git/matching-refs/heads/{private-random-production-sentinel} outside-sandbox",
        ],
        produces: { production_sentinel_branch: "private-random-branch-name",
          production_sentinel_refs: "exact-empty-array",
          repository_connection_owner_proof: "fresh-exact-cloudflare-owner-ui-proof" } },
      { id: "production-script", actor: "workers-builds-control-plane-operator",
        action: "select-exact-existing-production-script-tag", mutation: false,
        expected: { worker: production.workers[0].name },
        produces: { script_tag: { sourceField: "tag", pattern: "32-lowercase-hex" } } },
      { id: "repository-connection", actor: "workers-builds-control-plane-operator",
        action: "put-or-reuse-exact-repository-connection-and-always-retain-on-rollback", mutation: true,
        request: { method: "PUT", path: "/builds/repos/connections",
          body: structuredClone(githubRepository) },
        produces: { repo_connection_uuid: "provider-repository-connection-uuid" } },
      { id: "production-build-token", actor: "workers-builds-control-plane-operator",
        action: "post-build-token-only-after-exact-list-proves-no-match-or-resume-journal-binds-one",
        mutation: true,
        request: { method: "POST", path: "/builds/tokens", body: {
          build_token_name: "Atrinik metaserver production",
          build_token_secret: privateFileReference("ATRINIK_PRODUCTION_BUILD_TOKEN_SECRET_FILE"),
          cloudflare_token_id: privateFileReference("ATRINIK_PRODUCTION_BUILD_TOKEN_ID_FILE"),
        } }, produces: { build_token_uuid: "provider-build-token-uuid",
          cloudflare_token_id: "exact-private-input-token-id" } },
      { id: "review-build-token", actor: "workers-builds-control-plane-operator",
        action: "post-build-token-only-after-exact-list-proves-no-match-or-resume-journal-binds-one",
        mutation: true,
        request: { method: "POST", path: "/builds/tokens", body: {
          build_token_name: reviewBuildTokenNames.predecessor,
          build_token_secret: privateFileReference("ATRINIK_REVIEW_BUILD_TOKEN_SECRET_FILE"),
          cloudflare_token_id: privateFileReference("ATRINIK_REVIEW_BUILD_TOKEN_ID_FILE"),
        } }, produces: { build_token_uuid: "provider-build-token-uuid",
          cloudflare_token_id: "exact-private-input-token-id" } },
      { id: "sentinel-recheck-before-production-trigger", actor: "github-owner-readback",
        action: "repeat-exact-private-random-production-sentinel-ref-absence-proof-outside-sandbox",
        mutation: false, branch: productionSentinel,
        produces: { proof_digest: "fresh-production-sentinel-absence-proof-digest" } },
      { id: "production-trigger-staged", actor: "workers-builds-control-plane-operator",
        action: "post-inert-trigger-with-zero-resource-token", mutation: true,
        precondition: { productionSentinelProof: resultReference(
          "sentinel-recheck-before-production-trigger", "proof_digest") },
        request: { method: "POST", path: "/builds/triggers",
          body: triggerPlanSpec(productionStaged, "production-script",
            "review-build-token") },
        produces: { trigger_uuid: "provider-trigger-uuid" } },
      { id: "sentinel-recheck-before-production-environment", actor: "github-owner-readback",
        action: "repeat-exact-private-random-production-sentinel-ref-absence-proof-outside-sandbox",
        mutation: false, branch: productionSentinel,
        produces: { proof_digest: "fresh-production-sentinel-absence-proof-digest" } },
      { id: "production-environment", actor: "workers-builds-control-plane-operator",
        action: "patch-exact-environment", mutation: true,
        precondition: { productionSentinelProof: resultReference(
          "sentinel-recheck-before-production-environment", "proof_digest") },
        request: { method: "PATCH",
          path: apiPathReference("/builds/triggers/{trigger_uuid}/environment_variables",
            "production-trigger-staged", "trigger_uuid"),
          body: productionEnvironmentPlan(production) } },
      { id: "staged-readback", actor: "workers-builds-control-plane-operator",
        action: "prove-one-inert-production-trigger-review-trigger-absent-tokens-and-no-deploy-hooks",
        mutation: false, command: "npm run provision:workers-builds:verify-staged",
        produces: { proof_digest: "fresh-private-staged-verifier-digest" } },
    ],
    reviewActivation: {
      gate: "review-trigger-activation-and-proof",
      precondition: { stagedProof: resultReference("staged-readback", "proof_digest") },
      preconditionCommand: "npm run provision:workers-builds:verify-staged-proof",
      operations: [
        { id: "review-activation-authority", actor: "workers-builds-control-plane-operator",
          action: "bind-fresh-owner-token-sentinel-usage-and-staged-evidence-into-bounded-review-phase-authority",
          mutation: false,
          command: "npm run provision:workers-builds:verify-review-activation-authority",
          precondition: { stagedProof: resultReference("staged-readback", "proof_digest") },
          produces: { proof_digest: "bounded-review-activation-authority-proof-digest" } },
        { id: "review-root-recheck-before-trigger", actor: "github-owner-readback",
          action: "prove-private-random-review-staging-root-absent-from-every-current-non-main-ref-outside-sandbox",
          mutation: false, rootDirectory: reviewStagingRoot,
          command: "npm run provision:workers-builds:verify-review-staging-root-create",
          precondition: { reviewActivationAuthority: reviewActivationAuthorityPrecondition() },
          proof: privateFileReference("ATRINIK_REVIEW_STAGING_ROOT_CREATE_PROOF_FILE"),
          produces: { proof_digest: "fresh-review-staging-root-absence-proof-digest" } },
        { id: "review-trigger-create", actor: "workers-builds-control-plane-operator",
          action: "post-preview-role-trigger-with-private-absent-root-inert-commands-and-zero-resource-token",
          mutation: true,
          precondition: { reviewActivationAuthority: reviewActivationAuthorityPrecondition(),
            reviewRootProof: resultReference(
              "review-root-recheck-before-trigger", "proof_digest") },
          request: { method: "POST", path: "/builds/triggers",
            body: triggerPlanSpec(reviewStaged, "production-script", "review-build-token") },
          produces: { trigger_uuid: "provider-trigger-uuid" } },
        { id: "review-environment", actor: "workers-builds-control-plane-operator",
          action: "patch-exact-nonsecret-review-environment", mutation: true,
          precondition: { reviewActivationAuthority: reviewActivationAuthorityPrecondition() },
          request: { method: "PATCH",
            path: apiPathReference("/builds/triggers/{trigger_uuid}/environment_variables",
              "review-trigger-create", "trigger_uuid"),
            body: Object.fromEntries(Object.entries(automaticReviewEnvironmentSpec(review))
              .map(([name, value]) => [name, { is_secret: value.is_secret,
                valueSource: { literal: value.value } }])) } },
        { id: "review-environment-readback-before-activation",
          actor: "workers-builds-control-plane-operator",
          action: "prove-three-stable-reads-of-journaled-triggers-private-root-environments-and-no-competing-build-path",
          mutation: false,
          journalInputs: {
            productionTriggerUuid: privateFileReference(
              "ATRINIK_PRODUCTION_STAGED_TRIGGER_UUID_FILE"),
            reviewTriggerUuid: privateFileReference(
              "ATRINIK_REVIEW_STAGED_TRIGGER_UUID_FILE"),
          },
          requests: [
            { method: "GET", path: apiPathReference(
              "/builds/workers/{external_script_id}/triggers",
              "production-script", "script_tag") },
            { method: "GET", path: apiPathReference(
              "/builds/triggers/{trigger_uuid}/environment_variables",
              "review-trigger-create", "trigger_uuid") },
          ],
          stability: "two-complete-identical-passes-plus-final-identical-sweep",
          validator: "exact-journaled-production-and-review-staged-triggers-environments-no-hooks-or-active-builds",
          command: "npm run provision:workers-builds:verify-review-staged-environment",
          precondition: { reviewActivationAuthority: reviewActivationAuthorityPrecondition() },
          produces: { proof_digest: "fresh-staged-review-environment-readback-digest" } },
        { id: "review-root-recheck-before-activation", actor: "github-owner-readback",
          action: "repeat-private-random-review-staging-root-absence-proof-immediately-before-final-preview-patch-outside-sandbox",
          mutation: false, rootDirectory: reviewStagingRoot,
          command: "npm run provision:workers-builds:verify-review-staging-root-activation",
          precondition: { reviewActivationAuthority: reviewActivationAuthorityPrecondition() },
          proof: privateFileReference("ATRINIK_REVIEW_STAGING_ROOT_ACTIVATION_PROOF_FILE"),
          produces: { proof_digest: "fresh-review-staging-root-absence-proof-digest" } },
        { id: "review-trigger-activate", actor: "workers-builds-control-plane-operator",
          action: "patch-preview-trigger-atomically-to-reviewed-root-and-commands",
          mutation: true,
          precondition: {
            reviewActivationAuthority: reviewActivationAuthorityPrecondition(),
            reviewEnvironmentProof: resultReference(
              "review-environment-readback-before-activation", "proof_digest"),
            reviewRootProof: resultReference(
              "review-root-recheck-before-activation", "proof_digest"),
          },
          request: { method: "PATCH",
            path: apiPathReference("/builds/triggers/{trigger_uuid}",
              "review-trigger-create", "trigger_uuid"),
            body: triggerPlanSpec(reviewFinal, "production-script", "review-build-token") } },
        { id: "review-activation-readback", actor: "workers-builds-control-plane-operator",
          action: "prove-final-review-trigger-production-staged-and-no-build-active",
          mutation: false, command: "npm run provision:workers-builds:verify-review-activation",
          precondition: { reviewActivationAuthority: reviewActivationAuthorityPrecondition() },
          produces: { proof_digest: "fresh-live-review-active-production-staged-proof-digest" } },
      ],
      proof: "disposable-same-repository-non-main-build-only-branch",
    },
    reviewTokenRotation: {
      gate: "review-token-rotation",
      predecessor: "exact-terminal-review-active-state-with-predecessor-zero-resource-wrapper",
      operations: [
        { id: "review-token-rotation-authority", actor: "workers-builds-control-plane-operator",
          action: "bind-fresh-main-program-ledger-historical-terminals-membership-successor-attempt-owner-usage-token-authority-and-exact-review-active-state",
          mutation: false,
          command: "npm run provision:workers-builds:verify-review-token-rotation-authority",
          precondition: {
            programDeliveryProof: privateFileReference(
              "ATRINIK_REVIEW_TOKEN_ROTATION_PROGRAM_PROOF_FILE"),
            attemptCoordinate: privateFileReference(
              "ATRINIK_REVIEW_TOKEN_ROTATION_ATTEMPT_COORDINATE_FILE"),
            historicalTerminals: structuredClone(
              reviewTokenRotationRetryProgram),
            membershipSuccessor: {
              incident: structuredClone(reviewMembershipSuccessorRotationIncident),
              incidentProof: privateFileReference(
                "ATRINIK_REVIEW_MEMBERSHIP_SUCCESSOR_INCIDENT_PROOF_FILE"),
              authorityProof: privateFileReference(
                "ATRINIK_REVIEW_MEMBERSHIP_SUCCESSOR_AUTHORITY_PROOF_FILE"),
              journal: privateFileReference(
                "ATRINIK_REVIEW_MEMBERSHIP_SUCCESSOR_JOURNAL_FILE"),
              resultProof: privateFileReference(
                "ATRINIK_REVIEW_MEMBERSHIP_SUCCESSOR_RESULT_PROOF_FILE"),
              snapshotManifest: privateFileReference(
                "ATRINIK_REVIEW_MEMBERSHIP_SUCCESSOR_SNAPSHOT_MANIFEST_FILE"),
            },
          },
          produces: { proof_digest: "bounded-review-token-rotation-authority-digest",
            production_trigger_uuid: "exact-journaled-inert-production-trigger-uuid",
            review_trigger_uuid: "exact-journaled-final-review-trigger-uuid",
            predecessor_review_build_token_uuid: "exact-superseded-wrapper-uuid" } },
        { id: "prove-replacement-create-precondition",
          actor: "workers-builds-control-plane-operator",
          action: "prove-fresh-stable-exhaustive-exact-predecessor-state-immediately-before-wrapper-create",
          mutation: false,
          command: "npm run provision:workers-builds:verify-review-token-rotation-pre-create",
          precondition: { reviewTokenRotationAuthority:
            reviewTokenRotationAuthorityPrecondition() },
          produces: { proof_digest: "fresh-exact-predecessor-pre-create-proof-digest" } },
        { id: "replacement-review-build-token", actor: "workers-builds-control-plane-operator",
          action: "create-one-exact-replacement-zero-resource-build-token-wrapper",
          mutation: true,
          precondition: { reviewTokenRotationAuthority:
            reviewTokenRotationAuthorityPrecondition(),
          currentMainProof: currentMainMutationPrecondition(),
          providerStateProof: resultReference(
            "prove-replacement-create-precondition", "proof_digest") },
          request: { method: "POST", path: "/builds/tokens", body: {
            build_token_name: reviewBuildTokenNames.current,
            build_token_secret: privateFileReference(
              "ATRINIK_REPLACEMENT_REVIEW_BUILD_TOKEN_SECRET_FILE"),
            cloudflare_token_id: privateFileReference(
              "ATRINIK_REPLACEMENT_REVIEW_BUILD_TOKEN_ID_FILE"),
          } },
          produces: { build_token_uuid: "provider-build-token-uuid",
            cloudflare_token_id: "exact-private-input-token-id" } },
        { id: "prove-production-repoint-precondition",
          actor: "workers-builds-control-plane-operator",
          action: "prove-fresh-stable-exhaustive-exact-replacement-created-state-immediately-before-production-repoint",
          mutation: false,
          command: "npm run provision:workers-builds:verify-review-token-rotation-pre-production",
          precondition: { reviewTokenRotationAuthority:
            reviewTokenRotationAuthorityPrecondition() },
          produces: { proof_digest:
            "fresh-exact-replacement-created-pre-production-proof-digest" } },
        { id: "repoint-inert-production-trigger", actor: "workers-builds-control-plane-operator",
          action: "patch-only-journaled-inert-production-trigger-token-reference-with-all-other-fields-exact",
          mutation: true,
          precondition: { reviewTokenRotationAuthority:
            reviewTokenRotationAuthorityPrecondition(),
          currentMainProof: currentMainMutationPrecondition(),
          providerStateProof: resultReference(
            "prove-production-repoint-precondition", "proof_digest") },
          request: { method: "PATCH", path: apiPathReference(
            "/builds/triggers/{trigger_uuid}", "review-token-rotation-authority",
            "production_trigger_uuid"),
          body: triggerPlanSpec(productionStaged, "production-script",
            "replacement-review-build-token") } },
        { id: "prove-production-repointed-review-still-predecessor",
          actor: "workers-builds-control-plane-operator",
          action: "prove-stable-exact-production-new-review-old-token-references-and-bind-either-no-peer-drift-or-only-provider-added-sentinel-review-exclusion",
          mutation: false,
          command: "npm run provision:workers-builds:verify-review-token-rotation-intermediate",
          precondition: { reviewTokenRotationAuthority:
            reviewTokenRotationAuthorityPrecondition() },
          produces: { proof_digest: "fresh-exact-intermediate-provider-disposition-readback-digest",
            phase: { oneOf: ["production-repointed",
              "production-repointed-review-augmented"] } } },
        { id: "repoint-final-review-trigger", actor: "workers-builds-control-plane-operator",
          action: "patch-only-journaled-final-review-trigger-token-reference-with-all-other-fields-exact",
          mutation: true,
          precondition: { reviewTokenRotationAuthority:
            reviewTokenRotationAuthorityPrecondition(),
            currentMainProof: currentMainMutationPrecondition(),
            providerStateProof: resultReference(
              "prove-production-repointed-review-still-predecessor", "proof_digest"),
            providerDisposition: resultReference(
              "prove-production-repointed-review-still-predecessor", "phase") },
          request: { method: "PATCH", path: apiPathReference(
            "/builds/triggers/{trigger_uuid}", "review-token-rotation-authority",
            "review_trigger_uuid"),
          body: triggerPlanSpec(reviewFinal, "production-script",
            "replacement-review-build-token") } },
        { id: "prove-superseded-wrapper-unreferenced",
          actor: "workers-builds-control-plane-operator",
          action: "prove-both-journaled-triggers-stably-reference-replacement-and-old-wrapper-is-unreferenced",
          mutation: false,
          command: "npm run provision:workers-builds:verify-review-token-rotation-unreferenced",
          precondition: { reviewTokenRotationAuthority:
            reviewTokenRotationAuthorityPrecondition() },
          produces: { proof_digest: "fresh-old-wrapper-unreferenced-readback-digest" } },
        { id: "retire-superseded-review-build-token",
          actor: "workers-builds-control-plane-operator",
          action: "delete-only-exact-superseded-review-build-token-after-unreferenced-proof",
          mutation: true,
          precondition: { reviewTokenRotationAuthority:
            reviewTokenRotationAuthorityPrecondition(),
            currentMainProof: currentMainMutationPrecondition(),
            providerStateProof: resultReference(
              "prove-superseded-wrapper-unreferenced", "proof_digest") },
          request: { method: "DELETE", path: apiPathReference(
            "/builds/tokens/{build_token_uuid}", "review-token-rotation-authority",
            "predecessor_review_build_token_uuid") } },
        { id: "review-token-rotation-readback",
          actor: "workers-builds-control-plane-operator",
          action: "prove-exact-review-active-state-on-replacement-wrapper-old-wrapper-absent-and-production-resources-unchanged",
          mutation: false,
          command: "npm run provision:workers-builds:verify-review-token-rotation-complete",
          produces: { proof_digest: "fresh-terminal-review-token-rotation-proof-digest" } },
      ],
      rollbackOperations: [
        { id: "rotation-terminalize-no-owned-pre-intent-prefix",
          actor: "workers-builds-control-plane-operator", mutation: false,
          action: "after-expired-first-create-authorization-prefix-prove-exact-predecessor-state-and-journal-no-owned-replacement-residual",
          condition: "no-replacement-create-intent-or-provider-mutation-exists",
          precondition: {
            preCreateProof: privateFileReference(
              "ATRINIK_REVIEW_TOKEN_ROTATION_PRE_CREATE_PROOF_FILE"),
            providerStateProof: resultReference(
              "prove-replacement-create-precondition", "proof_digest") },
          produces: { residual_proof_digest:
            "fresh-exhaustive-predecessor-no-owned-replacement-residual-digest" } },
        { id: "rotation-reconcile-superseded-wrapper",
          actor: "workers-builds-control-plane-operator", mutation: false,
          action: "reconcile-journaled-delete-intent-by-exact-uuid-and-complete-forward-if-absent",
          condition: "only-when-retire-intent-exists-without-a-bound-deletion-tombstone",
          produces: { disposition: "exact-predecessor-present-or-exact-predecessor-absent" } },
        { id: "rotation-forward-complete-after-old-wrapper-absent",
          actor: "workers-builds-control-plane-operator", mutation: false,
          action: "after-old-wrapper-absence-prove-terminal-replacement-state-never-recreate-old-wrapper-including-historical-authority-crash-recovery",
          condition: "predecessor-wrapper-delete-is-bound-or-reconciled-absent",
          command: "npm run provision:workers-builds:verify-review-token-rotation-complete-historical",
          produces: { proof_digest: "fresh-terminal-review-token-rotation-proof-digest" } },
        { id: "rotation-prove-review-restore-precondition",
          actor: "workers-builds-control-plane-operator", mutation: false,
          action: "prove-fresh-exhaustive-exact-review-repointed-state-before-review-restore",
          condition: "predecessor-wrapper-exists-and-journaled-review-trigger-references-replacement",
          command: "npm run provision:workers-builds:verify-review-token-rotation-rollback-precondition",
          privateInputs: { phase:
            "ATRINIK_REVIEW_TOKEN_ROTATION_ROLLBACK_PRECONDITION_PHASE_FILE" },
          produces: { proof_digest: "fresh-review-restore-precondition-digest" } },
        { id: "rotation-restore-review-trigger-old-token",
          actor: "workers-builds-control-plane-operator", mutation: true,
          action: "before-old-wrapper-deletion-restore-only-journaled-review-trigger-exact-predecessor-body",
          condition: "predecessor-wrapper-exists-and-journaled-review-trigger-references-replacement",
          precondition: { historicalReviewTokenRotationAuthority:
            historicalReviewTokenRotationAuthorityPrecondition(),
          currentMainProof: currentMainMutationPrecondition(),
          providerStateProof: resultReference(
            "rotation-prove-review-restore-precondition", "proof_digest") },
          request: { method: "PATCH", path: apiPathReference(
            "/builds/triggers/{trigger_uuid}", "review-token-rotation-authority",
            "review_trigger_uuid"),
          body: triggerPlanSpec(reviewFinal, "production-script", "review-build-token") },
          produces: { readback_digest: "exact-journaled-review-trigger-predecessor-body-digest" } },
        { id: "rotation-prove-production-restore-precondition",
          actor: "workers-builds-control-plane-operator", mutation: false,
          action: "prove-fresh-exhaustive-exact-production-repointed-state-before-production-restore",
          condition: "predecessor-wrapper-exists-and-journaled-production-trigger-references-replacement",
          command: "npm run provision:workers-builds:verify-review-token-rotation-rollback-precondition",
          privateInputs: { phase:
            "ATRINIK_REVIEW_TOKEN_ROTATION_ROLLBACK_PRECONDITION_PHASE_FILE" },
          produces: { proof_digest: "fresh-production-restore-precondition-digest" } },
        { id: "rotation-restore-production-trigger-old-token",
          actor: "workers-builds-control-plane-operator", mutation: true,
          action: "before-old-wrapper-deletion-restore-only-journaled-inert-production-trigger-exact-predecessor-body",
          condition: "predecessor-wrapper-exists-and-journaled-production-trigger-references-replacement",
          precondition: { historicalReviewTokenRotationAuthority:
            historicalReviewTokenRotationAuthorityPrecondition(),
          currentMainProof: currentMainMutationPrecondition(),
          providerStateProof: resultReference(
            "rotation-prove-production-restore-precondition", "proof_digest") },
          request: { method: "PATCH", path: apiPathReference(
            "/builds/triggers/{trigger_uuid}", "review-token-rotation-authority",
            "production_trigger_uuid"),
          body: triggerPlanSpec(productionStaged, "production-script", "review-build-token") },
          produces: { readback_digest: "exact-journaled-production-trigger-predecessor-body-digest" } },
        { id: "rotation-prove-predecessor-restored",
          actor: "workers-builds-control-plane-operator", mutation: false,
          action: "prove-both-trigger-bodies-old-wrapper-environments-hooks-builds-and-production-resources-exact-and-replacement-unreferenced",
          command: "npm run provision:workers-builds:verify-review-token-rotation-rollback-restored",
          produces: { proof_digest: "fresh-predecessor-restored-and-replacement-unreferenced-digest" } },
        { id: "rotation-delete-replacement-wrapper",
          actor: "workers-builds-control-plane-operator", mutation: true,
          action: "delete-only-journal-created-replacement-wrapper-after-it-is-unreferenced",
          precondition: { restoredProof: resultReference(
            "rotation-prove-predecessor-restored", "proof_digest"),
          historicalReviewTokenRotationAuthority:
            historicalReviewTokenRotationAuthorityPrecondition(),
          currentMainProof: currentMainMutationPrecondition() },
          request: { method: "DELETE", path: apiPathReference(
            "/builds/tokens/{build_token_uuid}", "replacement-review-build-token",
            "build_token_uuid") },
          produces: { deletion_tombstone: "exact-replacement-wrapper-uuid-absent" } },
        { id: "rotation-prove-rollback-complete",
          actor: "workers-builds-control-plane-operator", mutation: false,
          action: "prove-exact-predecessor-review-active-state-and-no-residual-replacement-wrapper",
          command: "npm run provision:workers-builds:verify-review-token-rotation-rollback-complete",
          produces: { proof_digest: "fresh-exact-predecessor-state-digest" } },
      ],
      noOwnedIncidentRecovery: {
        mode: "read-only-distinct-successor-terminal",
        coordinates: structuredClone(reviewTokenRotationNoOwnedIncident),
        operations: [
          { id: "rotation-no-owned-successor-capture",
            actor: "workers-builds-control-plane-operator", mutation: false,
            action: "capture-fresh-exhaustive-predecessor-no-owned-state-under-authenticated-current-main-without-touching-historical-journals",
            command: "npm run provision:workers-builds:verify-review-token-rotation-rollback-complete",
            produces: { proof_digest: "fresh-no-owned-successor-predecessor-proof-digest",
              current_main_start_proof_digest:
                "authenticated-terminal-observation-start-current-main-proof-digest",
              current_main_finish_proof_digest:
                "authenticated-terminal-observation-finish-current-main-proof-digest" } },
          { id: "rotation-no-owned-successor-finalize",
            actor: "journaled-no-owned-successor-executor", mutation: false,
            action: "write-new-two-record-checksummed-terminal-journal-bound-to-exact-historical-inputs-and-fresh-proof",
            precondition: { freshProof: resultReference(
              "rotation-no-owned-successor-capture", "proof_digest") },
            produces: { terminal: "predecessor-no-owned",
              proof_digest: "fresh-no-owned-successor-predecessor-proof-digest" } },
          { id: "rotation-no-owned-successor-validate",
            actor: "workers-builds-control-plane-operator", mutation: false,
            action: "validate-distinct-idempotent-no-owned-successor-terminal-with-no-provider-read-or-write",
            command:
              "npm run provision:workers-builds:verify-review-token-rotation-no-owned-successor",
            precondition: { terminal: resultReference(
              "rotation-no-owned-successor-finalize", "terminal") },
            produces: { proof_digest: "fresh-no-owned-successor-predecessor-proof-digest" } },
        ],
      },
      freshProviderNormalizedRecovery: {
        mode: "rollback-only-current-attempt-provider-augmented",
        startingPhase: "production-repointed-review-augmented",
        precondition: {
          forwardJournal: { oneOf: [
            "exact-checksummed-seventeen-record-current-attempt-prefix",
            "exact-production-intent-or-classification-prefix-with-applied-augmented-readback",
            "exact-seventeen-record-prefix-plus-review-intent-or-no-effect-classification",
          ] },
          attemptCoordinate: privateFileReference(
            "ATRINIK_REVIEW_TOKEN_ROTATION_ATTEMPT_COORDINATE_FILE"),
          preCreateProof: privateFileReference(
            "ATRINIK_REVIEW_TOKEN_ROTATION_PRE_CREATE_PROOF_FILE"),
          preProductionProof: privateFileReference(
            "ATRINIK_REVIEW_TOKEN_ROTATION_PRE_PRODUCTION_PROOF_FILE"),
          prefixEvidence: { oneOf: [
            { forwardPrefixKind: "completed-augmented",
              intermediateProof: privateFileReference(
                "ATRINIK_REVIEW_TOKEN_ROTATION_INTERMEDIATE_PROOF_FILE") },
            { forwardPrefixKind: { oneOf: ["production-intent-applied",
              "production-classified-applied"] },
            exceptionalHandoffProof: privateFileReference(
              "ATRINIK_REVIEW_TOKEN_ROTATION_ROLLBACK_PRECONDITION_PROOF_FILE") },
            { forwardPrefixKind: { oneOf: ["review-intent-no-effect",
              "review-classified-no-effect"] },
            intermediateProof: privateFileReference(
              "ATRINIK_REVIEW_TOKEN_ROTATION_INTERMEDIATE_PROOF_FILE"),
            exceptionalHandoffProof: privateFileReference(
              "ATRINIK_REVIEW_TOKEN_ROTATION_ROLLBACK_PRECONDITION_PROOF_FILE") },
          ] },
        },
        operations: [
          { id: "rotation-fresh-augmented-prove-exceptional-handoff",
            actor: "workers-builds-control-plane-operator", mutation: false,
            condition: "forward-prefix-is-not-the-completed-seventeen-record-prefix",
            action: "prove-fresh-exhaustive-exact-provider-augmented-state-after-the-final-forward-record-without-retrying-or-backdating-the-forward-mutation",
            command: "npm run provision:workers-builds:verify-review-token-rotation-rollback-precondition",
            privateInputs: { phase:
              "ATRINIK_REVIEW_TOKEN_ROTATION_ROLLBACK_PRECONDITION_PHASE_FILE" },
            produces: { proof_digest:
              "fresh-exact-exceptional-augmented-handoff-proof-digest" } },
          { id: "rotation-fresh-augmented-validate-prefix",
            actor: "journaled-review-token-rotation-executor", mutation: false,
            action: "validate-exact-authority-bound-attempt-and-enumerated-provider-augmented-forward-prefix-plus-any-required-post-prefix-handoff-proof",
            precondition: { prefixEvidence: { oneOf: [
              { forwardPrefixKind: "completed-augmented",
                intermediateProof: privateFileReference(
                  "ATRINIK_REVIEW_TOKEN_ROTATION_INTERMEDIATE_PROOF_FILE") },
              { forwardPrefixKind: { oneOf: ["production-intent-applied",
                "production-classified-applied", "review-intent-no-effect",
                "review-classified-no-effect"] },
              exceptionalHandoffProof: resultReference(
                "rotation-fresh-augmented-prove-exceptional-handoff", "proof_digest") },
            ] } },
            produces: { forward_journal_digest: "authority-bound-current-attempt-prefix-digest",
              replacement_review_build_token_uuid: "exact-journal-created-wrapper-uuid" } },
          { id: "rotation-fresh-augmented-prove-production-restore-precondition",
            actor: "workers-builds-control-plane-operator", mutation: false,
            action: "prove-fresh-exhaustive-exact-provider-augmented-state-before-production-restore",
            command: "npm run provision:workers-builds:verify-review-token-rotation-rollback-precondition",
            privateInputs: { phase:
              "ATRINIK_REVIEW_TOKEN_ROTATION_ROLLBACK_PRECONDITION_PHASE_FILE" },
            produces: { proof_digest:
              "fresh-provider-augmented-production-restore-precondition-digest" } },
          { id: "rotation-fresh-augmented-restore-production-trigger-old-token",
            journalOperation: "rotation-restore-production-trigger-old-token",
            actor: "workers-builds-control-plane-operator", mutation: true,
            action: "restore-production-predecessor-body-first-and-read-back-both-triggers",
            precondition: { forwardJournal: resultReference(
              "rotation-fresh-augmented-validate-prefix", "forward_journal_digest"),
            providerStateProof: resultReference(
              "rotation-fresh-augmented-prove-production-restore-precondition", "proof_digest"),
            historicalReviewTokenRotationAuthority:
              historicalReviewTokenRotationAuthorityPrecondition(),
            currentMainProof: currentMainMutationPrecondition() },
            request: { method: "PATCH", path: apiPathReference(
              "/builds/triggers/{trigger_uuid}", "review-token-rotation-authority",
              "production_trigger_uuid"),
            body: triggerPlanSpec(productionStaged, "production-script", "review-build-token") } },
          { id: "rotation-fresh-augmented-prove-provider-peer-normalization",
            actor: "workers-builds-control-plane-operator", mutation: false,
            action: "prove-exact-auto-normalized-predecessor-review-or-only-retained-sentinel-exclusion",
            command: "npm run provision:workers-builds:verify-review-token-rotation-provider-peer-normalization",
            produces: { proof_digest: "fresh-exact-provider-peer-normalization-digest" } },
          { id: "rotation-fresh-augmented-restore-review-trigger-old-token",
            journalOperation: "rotation-restore-review-trigger-old-token",
            actor: "workers-builds-control-plane-operator", mutation: true,
            condition: "only-when-peer-normalization-proof-retains-the-sentinel-exclusion",
            action: "restore-only-the-exact-journaled-review-trigger-predecessor-body",
            precondition: { peerNormalizationProof: resultReference(
              "rotation-fresh-augmented-prove-provider-peer-normalization", "proof_digest"),
            historicalReviewTokenRotationAuthority:
              historicalReviewTokenRotationAuthorityPrecondition(),
            currentMainProof: currentMainMutationPrecondition() },
            request: { method: "PATCH", path: apiPathReference(
              "/builds/triggers/{trigger_uuid}", "review-token-rotation-authority",
              "review_trigger_uuid"),
            body: triggerPlanSpec(reviewFinal, "production-script", "review-build-token") } },
          { id: "rotation-fresh-augmented-prove-predecessor-restored",
            actor: "workers-builds-control-plane-operator", mutation: false,
            action: "prove-exact-predecessor-state-production-preservation-no-active-builds-and-no-hooks",
            command: "npm run provision:workers-builds:verify-review-token-rotation-rollback-restored",
            produces: { proof_digest:
              "fresh-predecessor-restored-and-replacement-unreferenced-digest" } },
          { id: "rotation-fresh-augmented-delete-replacement-wrapper",
            journalOperation: "rotation-delete-replacement-wrapper",
            actor: "workers-builds-control-plane-operator", mutation: true,
            action: "delete-only-the-current-attempt-globally-unreferenced-replacement-wrapper",
            precondition: { restoredProof: resultReference(
              "rotation-fresh-augmented-prove-predecessor-restored", "proof_digest"),
            historicalReviewTokenRotationAuthority:
              historicalReviewTokenRotationAuthorityPrecondition(),
            currentMainProof: currentMainMutationPrecondition() },
            request: { method: "DELETE", path: apiPathReference(
              "/builds/tokens/{build_token_uuid}",
              "rotation-fresh-augmented-validate-prefix",
              "replacement_review_build_token_uuid") },
            produces: { deletion_tombstone: "exact-replacement-wrapper-uuid-absent" } },
          { id: "rotation-fresh-augmented-prove-rollback-complete",
            actor: "workers-builds-control-plane-operator", mutation: false,
            action: "bind-exact-terminal-predecessor-state-and-checksum-valid-rollback-journal",
            command: "npm run provision:workers-builds:verify-review-token-rotation-rollback-complete",
            produces: { proof_digest: "fresh-exact-predecessor-state-digest" } },
        ],
        blockedTerminal: "fresh-exhaustive-phase-exact-residual-snapshot",
        forbidden: ["forward-rotation-retry", "production-trigger-activation", "migration-0010",
          "manual-build", "initial-production-build",
          "worker-version-deployment-binding-route-domain-schedule-url-state-secret-or-repository-connection-mutation"],
      },
      providerNormalizedIncidentRecovery: {
        mode: "rollback-only",
        incidentPhase: "production-repointed-review-augmented",
        coordinates: structuredClone(reviewTokenRotationProviderNormalizedIncident),
        operations: [
          { id: "rotation-validate-provider-normalized-incident",
            actor: "workers-builds-control-plane-operator", mutation: false,
            action: "bind-exact-twelve-record-forward-prefix-historical-authority-and-exhaustive-peer-augmented-snapshot",
            command: "npm run provision:workers-builds:verify-review-token-rotation-provider-normalized-incident",
            produces: { proof_digest: "exact-provider-normalized-incident-coordinate-digest" } },
          { id: "rotation-incident-restore-production-trigger-old-token",
            journalOperation: "rotation-restore-production-trigger-old-token",
            actor: "workers-builds-control-plane-operator", mutation: true,
            action: "restore-production-predecessor-body-first-and-read-back-both-triggers",
            precondition: { incidentProof: resultReference(
              "rotation-validate-provider-normalized-incident", "proof_digest"),
            historicalReviewTokenRotationAuthority:
              providerNormalizedIncidentHistoricalAuthorityPrecondition(),
            currentMainProof: currentMainMutationPrecondition() },
            request: { method: "PATCH", path: apiPathReference(
              "/builds/triggers/{trigger_uuid}", "review-token-rotation-authority",
              "production_trigger_uuid"),
            body: triggerPlanSpec(productionStaged, "production-script", "review-build-token") } },
          { id: "rotation-prove-provider-peer-normalization",
            actor: "workers-builds-control-plane-operator", mutation: false,
            action: "prove-exact-auto-normalized-predecessor-review-or-only-retained-sentinel-exclusion",
            command: "npm run provision:workers-builds:verify-review-token-rotation-provider-peer-normalization",
            produces: { proof_digest: "fresh-exact-provider-peer-normalization-digest" } },
          { id: "rotation-incident-restore-review-trigger-old-token",
            journalOperation: "rotation-restore-review-trigger-old-token",
            actor: "workers-builds-control-plane-operator", mutation: true,
            condition: "only-when-peer-normalization-proof-retains-the-sentinel-exclusion",
            action: "restore-only-the-exact-journaled-review-trigger-predecessor-body",
            precondition: { peerNormalizationProof: resultReference(
              "rotation-prove-provider-peer-normalization", "proof_digest"),
            historicalReviewTokenRotationAuthority:
              providerNormalizedIncidentHistoricalAuthorityPrecondition(),
            currentMainProof: currentMainMutationPrecondition() },
            request: { method: "PATCH", path: apiPathReference(
              "/builds/triggers/{trigger_uuid}", "review-token-rotation-authority",
              "review_trigger_uuid"),
            body: triggerPlanSpec(reviewFinal, "production-script", "review-build-token") } },
          { id: "rotation-incident-prove-predecessor-restored",
            actor: "workers-builds-control-plane-operator", mutation: false,
            action: "prove-exact-predecessor-state-production-preservation-no-active-builds-and-no-hooks",
            command: "npm run provision:workers-builds:verify-review-token-rotation-rollback-restored",
            produces: { proof_digest: "fresh-predecessor-restored-and-replacement-unreferenced-digest" } },
          { id: "rotation-incident-delete-replacement-wrapper",
            journalOperation: "rotation-delete-replacement-wrapper",
            actor: "workers-builds-control-plane-operator", mutation: true,
            action: "delete-only-the-journal-created-globally-unreferenced-replacement-wrapper",
            precondition: { restoredProof: resultReference(
              "rotation-incident-prove-predecessor-restored", "proof_digest"),
            historicalReviewTokenRotationAuthority:
              providerNormalizedIncidentHistoricalAuthorityPrecondition(),
            currentMainProof: currentMainMutationPrecondition() },
            request: { method: "DELETE", path: apiPathReference(
              "/builds/tokens/{build_token_uuid}", "replacement-review-build-token",
              "build_token_uuid") },
            produces: { deletion_tombstone: "exact-replacement-wrapper-uuid-absent" } },
          { id: "rotation-incident-prove-rollback-complete",
            actor: "workers-builds-control-plane-operator", mutation: false,
            action: "bind-exact-terminal-predecessor-state-and-checksum-valid-rollback-journal",
            command: "npm run provision:workers-builds:verify-review-token-rotation-rollback-complete",
            produces: { proof_digest: "fresh-exact-predecessor-state-digest" } },
        ],
        blockedTerminal: "fresh-exhaustive-phase-exact-residual-snapshot",
        forbidden: ["forward-rotation-retry", "production-trigger-activation", "migration-0010",
          "manual-build", "initial-production-build",
          "worker-version-deployment-binding-route-domain-schedule-url-state-secret-or-repository-connection-mutation"],
      },
      blockedDeleteRecovery: {
        mode: "one-write-successor-to-immutable-provider-normalized-blocked-terminal",
        coordinates: structuredClone(reviewTokenRotationBlockedDeleteIncident),
        authorityLifetimeMinutes: blockedReviewTokenDeleteAuthorityLifetimeMs / 60_000,
        minimumRemainingMinutes: blockedReviewTokenDeleteTransitionBudgetMs / 60_000,
        operations: [
          { id: "rotation-blocked-delete-authority",
            actor: "workers-builds-control-plane-operator", mutation: false,
            action: "bind-exact-blocked-terminal-and-fresh-exhaustive-predecessor-restored-global-unreference-proof",
            command: "npm run provision:workers-builds:verify-review-token-rotation-blocked-delete-authority",
            precondition: { recoveryCoordinate: privateFileReference(
              "ATRINIK_REVIEW_TOKEN_ROTATION_BLOCKED_DELETE_RECOVERY_COORDINATE_FILE") },
            produces: { proof_digest: "bounded-one-write-blocked-delete-authority-digest",
              replacement_review_build_token_uuid:
                "exact-journal-created-globally-unreferenced-replacement-wrapper" } },
          { id: "rotation-blocked-delete-replacement-wrapper",
            journalOperation: "rotation-delete-blocked-replacement-wrapper",
            actor: "workers-builds-control-plane-operator", mutation: true,
            action: "delete-only-the-exact-journal-created-replacement-wrapper-after-fresh-exhaustive-global-unreference",
            precondition: { blockedDeleteAuthority: resultReference(
              "rotation-blocked-delete-authority", "proof_digest"),
            currentMainProof: currentMainMutationPrecondition() },
            request: { method: "DELETE", path: apiPathReference(
              "/builds/tokens/{build_token_uuid}", "rotation-blocked-delete-authority",
              "replacement_review_build_token_uuid") },
            produces: { deletion_tombstone: "exact-replacement-wrapper-uuid-absent" } },
          { id: "rotation-blocked-delete-prove-provider-complete",
            actor: "workers-builds-control-plane-operator", mutation: false,
            action: "capture-fresh-exact-predecessor-state-after-replacement-absence",
            command: "npm run provision:workers-builds:verify-review-token-rotation-rollback-complete",
            produces: { proof_digest: "fresh-exact-predecessor-state-digest",
              current_main_proof_digest:
                "authenticated-terminal-observation-main-proof-digest" } },
          { id: "rotation-blocked-delete-finalize-journal",
            actor: "journaled-blocked-delete-executor", mutation: false,
            action: "bind-complete-proof-and-append-exact-successor-terminal",
            precondition: { completeProof: resultReference(
              "rotation-blocked-delete-prove-provider-complete", "proof_digest"),
            terminalObservationCurrentMainProof: resultReference(
              "rotation-blocked-delete-prove-provider-complete",
              "current_main_proof_digest") },
            produces: { terminal: "checksum-valid-blocked-delete-recovery-complete" } },
          { id: "rotation-blocked-delete-validate-terminal",
            actor: "workers-builds-control-plane-operator", mutation: false,
            action: "validate-exact-complete-successor-journal-and-bound-proof",
            command: "npm run provision:workers-builds:verify-review-token-rotation-blocked-delete-complete",
            precondition: { terminal: resultReference(
              "rotation-blocked-delete-finalize-journal", "terminal") },
            produces: { proof_digest: "validated-terminal-predecessor-state-digest" } },
        ],
        blockedTerminal: {
          evidence: "fresh-exhaustive-predecessor-or-predecessor-restored-residual-snapshot",
          command: "npm run provision:workers-builds:verify-review-token-rotation-blocked-delete-blocked",
        },
        forbidden: ["trigger-post-or-patch", "production-trigger-activation", "migration-0010",
          "manual-build", "initial-production-build",
          "worker-version-deployment-binding-route-domain-schedule-url-state-secret-or-repository-connection-mutation"],
      },
      forbidden: ["production-trigger-activation", "migration-0010", "manual-build",
        "initial-production-build", "worker-version-deployment-binding-route-domain-schedule-url-state-secret-or-repository-connection-mutation"],
    },
    reviewMembershipRepair: {
      gate: "review-membership-read-policy-and-proof",
      incident: structuredClone(reviewMembershipRepairIncident),
      successorRotation: {
        mode: "current-terminal-wrapper-to-membership-readable-token",
        incident: structuredClone(reviewMembershipSuccessorRotationIncident),
        predecessorSource:
          "immutable-blocked-delete-recovery-terminal-not-original-inert-setup-wrapper",
        evidence: [
          privateFileReference("ATRINIK_REVIEW_MEMBERSHIP_SUCCESSOR_INCIDENT_PROOF_FILE"),
          privateFileReference("ATRINIK_REVIEW_MEMBERSHIP_SUCCESSOR_AUTHORITY_PROOF_FILE"),
          privateFileReference("ATRINIK_REVIEW_MEMBERSHIP_SUCCESSOR_JOURNAL_FILE"),
          privateFileReference("ATRINIK_REVIEW_MEMBERSHIP_SUCCESSOR_RESULT_PROOF_FILE"),
          privateFileReference(
            "ATRINIK_REVIEW_MEMBERSHIP_SUCCESSOR_SNAPSHOT_MANIFEST_FILE"),
        ],
        handoff: "reviewTokenRotation",
        forbidden: ["original-inert-setup-wrapper-as-live-predecessor",
          "recreate-membership-readable-token", "amend-prior-terminal-journal"],
      },
      authorityLifetimeMinutes: reviewMembershipRepairAuthorityLifetimeMs / 60_000,
      operations: [
        { id: "membership-repair-bind-incident", actor: "workers-builds-control-plane-operator",
          action: "validate-exact-terminal-rotation-and-failed-disposable-build-evidence",
          mutation: false,
          produces: { proof_digest: "exact-membership-repair-incident-digest" } },
        { id: "membership-repair-current-state", actor: "workers-builds-control-plane-operator",
          action: "prove-exact-review-active-trigger-wrapper-predecessor-token-policy-and-user-permission-groups",
          mutation: false,
          produces: { proof_digest: "fresh-predecessor-token-policy-and-provider-state-digest" } },
        { id: "membership-repair-authority", actor: "cloudflare-user-token-owner",
          action: "bind-current-main-incident-current-state-and-one-exact-fresh-user-token-request",
          mutation: false,
          command: "npm run provision:workers-builds:verify-review-membership-repair-authority",
          produces: { proof_digest: "bounded-membership-repair-authority-digest" } },
        { id: "membership-repair-create-user-token", actor: "cloudflare-user-token-owner",
          action: "post-one-exact-user-owned-membership-readable-token-with-no-account-or-zone-scope",
          mutation: true,
          precondition: { authority: resultReference(
            "membership-repair-authority", "proof_digest") },
          request: { method: "POST", path: "/user/tokens",
            body: { name: "Atrinik metaserver review membership-readable",
              policies: [{ effect: "allow", resources: {
                [`com.cloudflare.api.user.${reviewMembershipRepairIncident.ownerUserId}`]: "*",
              }, permission_groups: [
                { id: privateFileReference("ATRINIK_USER_DETAILS_READ_PERMISSION_GROUP_ID_FILE") },
                { id: privateFileReference("ATRINIK_MEMBERSHIPS_READ_PERMISSION_GROUP_ID_FILE") },
              ] }] } },
          produces: { token_id: "exact-explicit-success-user-token-id",
            token_secret: "owner-only-never-journaled-token-secret" } },
        { id: "membership-repair-policy-readback", actor: "cloudflare-user-token-owner",
          action: "prove-new-token-owner-and-exact-two-user-permissions-with-no-resource-scope",
          mutation: false,
          command: "npm run provision:workers-builds:verify-review-membership-repair-result",
          produces: { proof_digest: "fresh-membership-readable-replacement-token-policy-digest",
            token_id: "exact-explicit-success-user-token-id" } },
        { id: "membership-repair-handoff", actor: "workers-builds-control-plane-operator",
          action: "handoff-owner-only-token-secret-id-policy-proof-and-incident-to-journaled-review-token-rotation-then-disposable-proof",
          mutation: false,
          precondition: { policyProof: resultReference(
            "membership-repair-policy-readback", "proof_digest") },
          produces: { next: "reviewTokenRotation-then-disposableProof" } },
      ],
      failureRollback: {
        actor: "cloudflare-user-token-owner", mutation: true,
        action: "delete-only-the-journal-created-user-token-before-any-wrapper-adopts-it",
        request: { method: "DELETE", path: "/user/tokens/{journal_created_token_id}" },
      },
      forbidden: ["account-owned-token", "predecessor-token-policy-update",
        "production-trigger-activation", "migration-0010", "manual-api-build",
        "initial-production-build", "worker-resource-or-repository-connection-mutation"],
    },
    disposableProof: {
      gate: "review-trigger-activation-and-proof",
      authorityOperation: { id: "disposable-review-proof-authority",
        actor: "workers-builds-control-plane-operator",
        action: "bind-fresh-post-rotation-review-active-owner-token-sentinel-usage-evidence-into-bounded-disposable-proof-authority",
        mutation: false,
        command: "npm run provision:workers-builds:verify-disposable-review-authority",
        precondition: { reviewTokenRotationProof: { oneOf: [resultReference(
          "review-token-rotation-readback", "proof_digest"), resultReference(
          "rotation-forward-complete-after-old-wrapper-absent", "proof_digest")] } },
        produces: { proof_digest: "bounded-disposable-review-proof-authority-digest" } },
      precondition: { disposableReviewAuthority: disposableReviewAuthorityPrecondition(),
        reviewTokenRotationProof: { oneOf: [resultReference(
          "review-token-rotation-readback", "proof_digest"), resultReference(
          "rotation-forward-complete-after-old-wrapper-absent", "proof_digest")] } },
      authorityLifetimeMinutes: disposableReviewAuthorityLifetimeMs / 60_000,
      pushMinimumRemainingMinutes: disposableReviewPushReserveMs / 60_000,
      maximumAutomaticBuildMinutes: review.automaticReview.providerBuildTimeoutMinutes,
      allowedWrites: ["push-one-exact-review-issue-66-branch",
        "delete-that-exact-sha-bound-branch",
        "cancel-only-journal-owned-automatic-review-build-during-cleanup"],
      forbidden: ["manual-build", "production-trigger-activation", "migration-0010",
        "initial-production-build", "production-resource-mutation"],
      proof: "authenticated-cloudflare-github-disposable-review-readback",
    },
    productionActivation: {
      gate: "production-trigger-activation",
      preconditionOperations: [
        { id: "production-activation-readback",
          actor: "workers-builds-control-plane-operator",
          action: "prove-review-active-production-staged-and-disposable-review-result",
          mutation: false,
          command: "npm run provision:workers-builds:verify-production-activation",
          produces: { proof_digest: "fresh-live-review-active-production-staged-proof-digest" } },
        { id: "sentinel-recheck-before-production-activation",
          actor: "github-owner-readback",
          action: "repeat-exact-private-random-production-sentinel-ref-absence-proof-outside-sandbox",
          mutation: false, branch: productionSentinel,
          produces: { proof_digest: "fresh-production-sentinel-absence-proof-digest" } },
      ],
      precondition: {
        productionSentinelProof: resultReference(
          "sentinel-recheck-before-production-activation", "proof_digest"),
        reviewPath: "fresh-private-successful-disposable-review-build-and-cleanup-proof",
        productionProof: resultReference("production-activation-readback", "proof_digest"),
      },
      preconditionCommand: "npm run provision:workers-builds:verify-production-activation",
      request: { method: "PATCH",
        path: apiPathReference("/builds/triggers/{trigger_uuid}",
          "production-trigger-staged", "trigger_uuid"),
        body: triggerPlanSpec(productionFinal, "production-script", "production-build-token") },
      initialGate: "routine-fails-closed-until-exact-main-sha-is-known-and-separately-approved",
      proof: "automatic-main-build-then-exact-sha-provider-retry-if-first-annotation-gate-stops",
    },
    partialFailure: {
      journal: "owner-only-append-after-each-mutation-with-operation-request-digest-resource-uuid-and-readback-digest",
      policy: "stop-at-first-ambiguous-response-read-back-before-retry-and-never-recreate-an-unknown-resource",
      rollbackScope: "delete-or-restore-only-exact-resources-proven-created-or-changed-by-this-journal",
      productionWorkerPolicy: "never-delete-or-roll-back-existing-production-workers-versions-state-or-secrets",
    },
    rollbackOperations: [
      { id: "delete-review-trigger-before-quiescence",
        actor: "workers-builds-control-plane-operator",
        action: "delete-exact-journaled-review-trigger-before-any-non-main-push-can-race-quiescence",
        mutation: true, condition: "only-if-review-trigger-create-is-journal-bound-or-ambiguously-reconciled",
        request: { method: "DELETE", path: apiPathReference(
          "/builds/triggers/{trigger_uuid}", "review-trigger-create", "trigger_uuid") } },
      { id: "prove-review-trigger-deleted-before-quiescence",
        actor: "workers-builds-control-plane-operator",
        action: "prove-phase-aware-exhaustive-inventory-is-empty-or-exactly-journaled-production-trigger",
        mutation: false,
        journalInputs: {
          productionTriggerUuid: "optional-journal-bound-production-trigger-staged-uuid",
          reviewTriggerUuid: "optional-journal-bound-or-ambiguously-reconciled-review-trigger-create-uuid",
        },
        request: { method: "GET", path: apiPathReference(
          "/builds/workers/{external_script_id}/triggers",
          "production-script", "script_tag") },
        stability: "two-complete-identical-passes-plus-final-identical-sweep",
        validator: "validateRollbackTriggerInventory",
        produces: { proof_digest: "fresh-review-trigger-absence-readback-digest" } },
      { id: "sentinel-recheck-before-production-rollback", actor: "github-owner-readback",
        action: "repeat-exact-private-random-production-sentinel-ref-absence-proof-outside-sandbox",
        mutation: false, branch: productionSentinel,
        produces: { proof_digest: "fresh-production-sentinel-absence-proof-digest" } },
      { id: "restore-production-trigger-to-inert-sentinel",
        actor: "workers-builds-control-plane-operator",
        action: "restore-production-trigger-to-its-exact-inert-production-sentinel-before-cancelling-exact-active-builds",
        mutation: true,
        condition: "only-if-production-trigger-staged-is-journal-bound-or-ambiguously-reconciled",
        precondition: { productionSentinelProof: resultReference(
          "sentinel-recheck-before-production-rollback", "proof_digest") },
        request: { method: "PATCH",
          path: apiPathReference("/builds/triggers/{trigger_uuid}",
            "production-trigger-staged", "trigger_uuid"),
          body: triggerPlanSpec(productionStaged, "production-script", "review-build-token") } },
      { id: "prove-production-trigger-inert-before-quiescence",
        actor: "workers-builds-control-plane-operator",
        action: "prove-phase-aware-production-trigger-is-absent-or-exactly-restored-to-inert-sentinel",
        mutation: false,
        journalInputs: {
          productionTriggerUuid: "optional-journal-bound-or-ambiguously-reconciled-production-trigger-staged-uuid",
        },
        expectedTrigger: triggerPlanSpec(productionStaged,
          "production-script", "review-build-token"),
        request: { method: "GET", path: apiPathReference(
          "/builds/workers/{external_script_id}/triggers",
          "production-script", "script_tag") },
        stability: "two-complete-identical-passes-plus-final-identical-sweep",
        validator: "validateRollbackProductionTriggerReadback",
        produces: { proof_digest: "fresh-production-trigger-inert-readback-digest" } },
      { id: "prove-rollback-quiescence", actor: "workers-builds-control-plane-operator",
        action: "prove-no-build-or-upload-remains-active", mutation: false,
        precondition: { reviewDeletionProof: resultReference(
          "prove-review-trigger-deleted-before-quiescence", "proof_digest"),
        productionInertProof: resultReference(
          "prove-production-trigger-inert-before-quiescence", "proof_digest") } },
      { id: "delete-production-trigger", actor: "workers-builds-control-plane-operator",
        action: "delete-exact-journaled-production-trigger-after-quiescence",
        mutation: true, condition: "only-if-production-trigger-staged-is-journal-bound-or-ambiguously-reconciled",
        request: { method: "DELETE", path: apiPathReference(
          "/builds/triggers/{trigger_uuid}", "production-trigger-staged", "trigger_uuid") } },
      { id: "prove-setup-triggers-deleted", actor: "workers-builds-control-plane-operator",
        action: "prove-exhaustive-shared-core-trigger-inventory-is-empty",
        mutation: false,
        request: { method: "GET", path: apiPathReference(
          "/builds/workers/{external_script_id}/triggers",
          "production-script", "script_tag") },
        stability: "two-complete-identical-passes-plus-final-identical-sweep",
        produces: { proof_digest: "fresh-zero-trigger-readback-digest" } },
      { id: "delete-setup-build-tokens", actor: "workers-builds-control-plane-operator",
        action: "delete-only-the-two-recorded-build-token-uuids", mutation: true,
        condition: "delete-each-only-if-its-create-is-journal-bound-or-ambiguously-reconciled",
        precondition: { triggerDeletionProof: resultReference(
          "prove-setup-triggers-deleted", "proof_digest") },
        requests: [
          { method: "DELETE", path: apiPathReference(
            "/builds/tokens/{build_token_uuid}", "production-build-token", "build_token_uuid") },
          { method: "DELETE", path: apiPathReference(
            "/builds/tokens/{build_token_uuid}", "review-build-token", "build_token_uuid") },
        ] },
      { id: "prove-setup-build-tokens-deleted", actor: "workers-builds-control-plane-operator",
        action: "prove-exhaustive-build-token-inventory-excludes-both-journaled-token-uuids",
        mutation: false,
        request: { method: "GET", path: "/builds/tokens" },
        stability: "two-complete-identical-passes-plus-final-identical-sweep",
        produces: { proof_digest: "fresh-setup-token-absence-readback-digest" } },
      { id: "retain-repository-connection", actor: "workers-builds-control-plane-operator",
        action: "retain-shared-metaserver-repository-connection-provider-has-no-read-inventory-and-website-must-survive",
        mutation: false },
      { id: "prove-production-preserved", actor: "workers-builds-control-plane-operator",
        action: "prove-three-production-workers-and-website-app-selection-unchanged",
        mutation: false,
        precondition: { tokenDeletionProof: resultReference(
          "prove-setup-build-tokens-deleted", "proof_digest") },
        command: "npm run provision:workers-builds:verify-preflight" },
    ],
  };
  validateSetupPlan(plan);
  return plan;
}

export function validateSetupPlan(plan) {
  if (!same(plan?.providerTopology, {
    mode: "one-worker-two-triggers", maximumTriggersPerWorker: 2,
    productionTriggerRole: "production", reviewTriggerRole: "preview",
    triggerEnvironmentIsolation: true,
    documentation: "https://developers.cloudflare.com/workers/ci-cd/builds/api-reference/",
    documentedContract:
      "each-worker-up-to-two-triggers-production-and-preview-with-per-trigger-build-token-commands-and-environment",
    lastVerifiedOn: "2026-08-16",
    retained12002Constraint: "one-repository-connection-two-workers-rejected-never-retry",
  }) || !same(plan?.retainedFailedRequest, {
    error: 12002, topology: "one-repository-connection-two-workers",
    disposition: "forbidden-never-retry-or-vary",
  }) || !same(plan?.retainedRejectedPreviewRequest, {
    error: 12002, topology: "one-worker-two-triggers-private-sentinel-preview",
    disposition: "forbidden-never-retry-or-normalize",
  })) fail("provider trigger topology or retained failure constraint drift");
  const operations = plan?.setupOperations;
  const expectedOperations = [
    ["preflight", "workers-builds-control-plane-operator", false,
      "require-exact-private-readback-no-competing-trigger-and-validate-private-random-production-sentinel-ref-absence"],
    ["production-script", "workers-builds-control-plane-operator", false,
      "select-exact-existing-production-script-tag"],
    ["repository-connection", "workers-builds-control-plane-operator", true,
      "put-or-reuse-exact-repository-connection-and-always-retain-on-rollback"],
    ["production-build-token", "workers-builds-control-plane-operator", true,
      "post-build-token-only-after-exact-list-proves-no-match-or-resume-journal-binds-one"],
    ["review-build-token", "workers-builds-control-plane-operator", true,
      "post-build-token-only-after-exact-list-proves-no-match-or-resume-journal-binds-one"],
    ["sentinel-recheck-before-production-trigger", "github-owner-readback", false,
      "repeat-exact-private-random-production-sentinel-ref-absence-proof-outside-sandbox"],
    ["production-trigger-staged", "workers-builds-control-plane-operator", true,
      "post-inert-trigger-with-zero-resource-token"],
    ["sentinel-recheck-before-production-environment", "github-owner-readback", false,
      "repeat-exact-private-random-production-sentinel-ref-absence-proof-outside-sandbox"],
    ["production-environment", "workers-builds-control-plane-operator", true,
      "patch-exact-environment"],
    ["staged-readback", "workers-builds-control-plane-operator", false,
      "prove-one-inert-production-trigger-review-trigger-absent-tokens-and-no-deploy-hooks"],
  ];
  if (!Array.isArray(operations) || new Set(operations.map(({ id }) => id)).size !== operations.length)
    fail("setup operation identity is incomplete or duplicated");
  if (!same(operations.map(({ id, actor, mutation, action }) => [id, actor, mutation, action]),
    expectedOperations))
    fail("setup operation set, order, actor, or mutation boundary drift");
  const expectedProduces = new Map([
    ["preflight", { production_sentinel_branch: "private-random-branch-name",
      production_sentinel_refs: "exact-empty-array",
      repository_connection_owner_proof: "fresh-exact-cloudflare-owner-ui-proof" }],
    ["production-script", { script_tag: { sourceField: "tag", pattern: "32-lowercase-hex" } }],
    ["repository-connection", { repo_connection_uuid: "provider-repository-connection-uuid" }],
    ["production-build-token", { build_token_uuid: "provider-build-token-uuid",
      cloudflare_token_id: "exact-private-input-token-id" }],
    ["review-build-token", { build_token_uuid: "provider-build-token-uuid",
      cloudflare_token_id: "exact-private-input-token-id" }],
    ["sentinel-recheck-before-production-trigger",
      { proof_digest: "fresh-production-sentinel-absence-proof-digest" }],
    ["production-trigger-staged", { trigger_uuid: "provider-trigger-uuid" }],
    ["sentinel-recheck-before-production-environment",
      { proof_digest: "fresh-production-sentinel-absence-proof-digest" }],
    ["staged-readback", { proof_digest: "fresh-private-staged-verifier-digest" }],
  ]);
  for (const operation of operations) {
    const expected = expectedProduces.get(operation.id);
    if ((expected !== undefined && !same(operation.produces, expected)) ||
        (expected === undefined && operation.produces !== undefined))
      fail(`setup producer schema ${operation.id} drift`);
  }
  const available = new Map();
  const inspect = (value) => {
    if (Array.isArray(value)) return value.forEach(inspect);
    if (!value || typeof value !== "object") return;
    if (typeof value.resultReference === "string") {
      const [operation, field, ...extra] = value.resultReference.split(".");
      if (extra.length || !available.get(operation)?.has(field))
        fail(`setup result reference ${value.resultReference} is dangling or forward`);
    }
    for (const nested of Object.values(value)) inspect(nested);
  };
  for (const operation of operations) {
    inspect(operation);
    const fields = Object.keys(operation.produces ?? {});
    available.set(operation.id, new Set(fields));
  }
  const reviewOperations = plan.reviewActivation?.operations;
  const expectedReviewOperations = [
    ["review-activation-authority", "workers-builds-control-plane-operator", false,
      "bind-fresh-owner-token-sentinel-usage-and-staged-evidence-into-bounded-review-phase-authority"],
    ["review-root-recheck-before-trigger", "github-owner-readback", false,
      "prove-private-random-review-staging-root-absent-from-every-current-non-main-ref-outside-sandbox"],
    ["review-trigger-create", "workers-builds-control-plane-operator", true,
      "post-preview-role-trigger-with-private-absent-root-inert-commands-and-zero-resource-token"],
    ["review-environment", "workers-builds-control-plane-operator", true,
      "patch-exact-nonsecret-review-environment"],
    ["review-environment-readback-before-activation", "workers-builds-control-plane-operator",
      false, "prove-three-stable-reads-of-journaled-triggers-private-root-environments-and-no-competing-build-path"],
    ["review-root-recheck-before-activation", "github-owner-readback", false,
      "repeat-private-random-review-staging-root-absence-proof-immediately-before-final-preview-patch-outside-sandbox"],
    ["review-trigger-activate", "workers-builds-control-plane-operator", true,
      "patch-preview-trigger-atomically-to-reviewed-root-and-commands"],
    ["review-activation-readback", "workers-builds-control-plane-operator", false,
      "prove-final-review-trigger-production-staged-and-no-build-active"],
  ];
  if (!Array.isArray(reviewOperations) || !same(reviewOperations.map(
    ({ id, actor, mutation, action }) => [id, actor, mutation, action]), expectedReviewOperations))
    fail("review activation operation set, order, or authority drift");
  inspect({ ...plan.reviewActivation, operations: undefined });
  for (const operation of reviewOperations) {
    inspect(operation);
    available.set(operation.id, new Set(Object.keys(operation.produces ?? {})));
  }
  const rotationOperations = plan.reviewTokenRotation?.operations;
  const expectedRotationOperations = [
    ["review-token-rotation-authority", "workers-builds-control-plane-operator", false,
      "bind-fresh-main-program-ledger-historical-terminals-membership-successor-attempt-owner-usage-token-authority-and-exact-review-active-state"],
    ["prove-replacement-create-precondition", "workers-builds-control-plane-operator", false,
      "prove-fresh-stable-exhaustive-exact-predecessor-state-immediately-before-wrapper-create"],
    ["replacement-review-build-token", "workers-builds-control-plane-operator", true,
      "create-one-exact-replacement-zero-resource-build-token-wrapper"],
    ["prove-production-repoint-precondition", "workers-builds-control-plane-operator", false,
      "prove-fresh-stable-exhaustive-exact-replacement-created-state-immediately-before-production-repoint"],
    ["repoint-inert-production-trigger", "workers-builds-control-plane-operator", true,
      "patch-only-journaled-inert-production-trigger-token-reference-with-all-other-fields-exact"],
    ["prove-production-repointed-review-still-predecessor",
      "workers-builds-control-plane-operator", false,
      "prove-stable-exact-production-new-review-old-token-references-and-bind-either-no-peer-drift-or-only-provider-added-sentinel-review-exclusion"],
    ["repoint-final-review-trigger", "workers-builds-control-plane-operator", true,
      "patch-only-journaled-final-review-trigger-token-reference-with-all-other-fields-exact"],
    ["prove-superseded-wrapper-unreferenced", "workers-builds-control-plane-operator", false,
      "prove-both-journaled-triggers-stably-reference-replacement-and-old-wrapper-is-unreferenced"],
    ["retire-superseded-review-build-token", "workers-builds-control-plane-operator", true,
      "delete-only-exact-superseded-review-build-token-after-unreferenced-proof"],
    ["review-token-rotation-readback", "workers-builds-control-plane-operator", false,
      "prove-exact-review-active-state-on-replacement-wrapper-old-wrapper-absent-and-production-resources-unchanged"],
  ];
  if (!Array.isArray(rotationOperations) || !same(rotationOperations.map(
    ({ id, actor, mutation, action }) => [id, actor, mutation, action]),
  expectedRotationOperations))
    fail("review token rotation operation set, order, or authority drift");
  inspect({ ...plan.reviewTokenRotation, operations: undefined, rollbackOperations: undefined,
    noOwnedIncidentRecovery: undefined,
    freshProviderNormalizedRecovery: undefined,
    providerNormalizedIncidentRecovery: undefined, blockedDeleteRecovery: undefined });
  for (const operation of rotationOperations) {
    inspect(operation);
    available.set(operation.id, new Set(Object.keys(operation.produces ?? {})));
  }
  for (const operation of plan.reviewTokenRotation.rollbackOperations) {
    inspect(operation);
    available.set(operation.id, new Set(Object.keys(operation.produces ?? {})));
  }
  const noOwnedRecovery = plan.reviewTokenRotation.noOwnedIncidentRecovery;
  const expectedNoOwnedRecoveryOperations = [
    ["rotation-no-owned-successor-capture", "workers-builds-control-plane-operator", false],
    ["rotation-no-owned-successor-finalize", "journaled-no-owned-successor-executor", false],
    ["rotation-no-owned-successor-validate", "workers-builds-control-plane-operator", false],
  ];
  if (!noOwnedRecovery || noOwnedRecovery.mode !== "read-only-distinct-successor-terminal" ||
      !same(noOwnedRecovery.coordinates, reviewTokenRotationNoOwnedIncident) ||
      !same(noOwnedRecovery.operations?.map(({ id, actor, mutation }) =>
        [id, actor, mutation]), expectedNoOwnedRecoveryOperations))
    fail("review token rotation no-owned successor operation drift");
  inspect({ ...noOwnedRecovery, operations: undefined });
  for (const operation of noOwnedRecovery.operations) {
    inspect(operation);
    available.set(operation.id, new Set(Object.keys(operation.produces ?? {})));
  }
  const freshRecovery = plan.reviewTokenRotation.freshProviderNormalizedRecovery;
  const freshRecoveryOperations = freshRecovery?.operations;
  const expectedFreshRecoveryOperations = [
    ["rotation-fresh-augmented-prove-exceptional-handoff",
      "workers-builds-control-plane-operator", false, undefined],
    ["rotation-fresh-augmented-validate-prefix", "journaled-review-token-rotation-executor",
      false, undefined],
    ["rotation-fresh-augmented-prove-production-restore-precondition",
      "workers-builds-control-plane-operator", false, undefined],
    ["rotation-fresh-augmented-restore-production-trigger-old-token",
      "workers-builds-control-plane-operator", true,
      "rotation-restore-production-trigger-old-token"],
    ["rotation-fresh-augmented-prove-provider-peer-normalization",
      "workers-builds-control-plane-operator", false, undefined],
    ["rotation-fresh-augmented-restore-review-trigger-old-token",
      "workers-builds-control-plane-operator", true,
      "rotation-restore-review-trigger-old-token"],
    ["rotation-fresh-augmented-prove-predecessor-restored",
      "workers-builds-control-plane-operator", false, undefined],
    ["rotation-fresh-augmented-delete-replacement-wrapper",
      "workers-builds-control-plane-operator", true,
      "rotation-delete-replacement-wrapper"],
    ["rotation-fresh-augmented-prove-rollback-complete",
      "workers-builds-control-plane-operator", false, undefined],
  ];
  if (!freshRecovery || !same(freshRecoveryOperations?.map(
    ({ id, actor, mutation, journalOperation }) => [id, actor, mutation, journalOperation]),
  expectedFreshRecoveryOperations))
    fail("review token rotation fresh provider-normalized recovery operation drift");
  inspect({ ...freshRecovery, operations: undefined });
  for (const operation of freshRecoveryOperations) {
    inspect(operation);
    available.set(operation.id, new Set(Object.keys(operation.produces ?? {})));
  }
  inspect({ ...plan.reviewTokenRotation.providerNormalizedIncidentRecovery,
    operations: undefined });
  const incidentOperations = plan.reviewTokenRotation.providerNormalizedIncidentRecovery.operations;
  const expectedIncidentOperations = [
    ["rotation-validate-provider-normalized-incident", "workers-builds-control-plane-operator",
      false, undefined],
    ["rotation-incident-restore-production-trigger-old-token",
      "workers-builds-control-plane-operator", true,
      "rotation-restore-production-trigger-old-token"],
    ["rotation-prove-provider-peer-normalization", "workers-builds-control-plane-operator",
      false, undefined],
    ["rotation-incident-restore-review-trigger-old-token",
      "workers-builds-control-plane-operator", true,
      "rotation-restore-review-trigger-old-token"],
    ["rotation-incident-prove-predecessor-restored", "workers-builds-control-plane-operator",
      false, undefined],
    ["rotation-incident-delete-replacement-wrapper", "workers-builds-control-plane-operator",
      true, "rotation-delete-replacement-wrapper"],
    ["rotation-incident-prove-rollback-complete", "workers-builds-control-plane-operator",
      false, undefined],
  ];
  if (!same(incidentOperations.map(({ id, actor, mutation, journalOperation }) =>
    [id, actor, mutation, journalOperation]), expectedIncidentOperations))
    fail("review token rotation provider-normalized incident operation drift");
  for (const operation of incidentOperations.filter(({ mutation }) => mutation)) {
    const precondition = operation.precondition?.historicalReviewTokenRotationAuthority;
    if (precondition?.command !==
        "npm run provision:workers-builds:verify-review-token-rotation-provider-normalized-authority-proof-historical" ||
        !same(precondition.exactIncidentCoordinate,
          reviewTokenRotationProviderNormalizedIncident))
      fail("review token rotation provider-normalized historical authority drift");
  }
  for (const operation of incidentOperations) {
    inspect(operation);
    available.set(operation.id, new Set(Object.keys(operation.produces ?? {})));
  }
  const blockedDelete = plan.reviewTokenRotation.blockedDeleteRecovery;
  const blockedDeleteOperations = blockedDelete?.operations;
  const expectedBlockedDeleteOperations = [
    ["rotation-blocked-delete-authority", "workers-builds-control-plane-operator", false,
      undefined,
      "npm run provision:workers-builds:verify-review-token-rotation-blocked-delete-authority"],
    ["rotation-blocked-delete-replacement-wrapper", "workers-builds-control-plane-operator",
      true, "rotation-delete-blocked-replacement-wrapper", undefined],
    ["rotation-blocked-delete-prove-provider-complete", "workers-builds-control-plane-operator", false,
      undefined,
      "npm run provision:workers-builds:verify-review-token-rotation-rollback-complete"],
    ["rotation-blocked-delete-finalize-journal", "journaled-blocked-delete-executor", false,
      undefined, undefined],
    ["rotation-blocked-delete-validate-terminal", "workers-builds-control-plane-operator", false,
      undefined,
      "npm run provision:workers-builds:verify-review-token-rotation-blocked-delete-complete"],
  ];
  if (!blockedDelete || !same(blockedDelete.coordinates,
    reviewTokenRotationBlockedDeleteIncident) ||
      !same(blockedDeleteOperations?.map(({ id, actor, mutation, journalOperation, command }) =>
        [id, actor, mutation, journalOperation, command]), expectedBlockedDeleteOperations) ||
      blockedDeleteOperations[1].request?.method !== "DELETE")
    fail("review token rotation blocked delete recovery operation drift");
  inspect({ ...blockedDelete, operations: undefined });
  for (const operation of blockedDeleteOperations) {
    inspect(operation);
    available.set(operation.id, new Set(Object.keys(operation.produces ?? {})));
  }
  const membershipRepair = plan.reviewMembershipRepair;
  const expectedMembershipRepairOperations = [
    ["membership-repair-bind-incident", "workers-builds-control-plane-operator", false],
    ["membership-repair-current-state", "workers-builds-control-plane-operator", false],
    ["membership-repair-authority", "cloudflare-user-token-owner", false],
    ["membership-repair-create-user-token", "cloudflare-user-token-owner", true],
    ["membership-repair-policy-readback", "cloudflare-user-token-owner", false],
    ["membership-repair-handoff", "workers-builds-control-plane-operator", false],
  ];
  if (!membershipRepair || !same(membershipRepair.incident, reviewMembershipRepairIncident) ||
      !same(membershipRepair.successorRotation, {
        mode: "current-terminal-wrapper-to-membership-readable-token",
        incident: structuredClone(reviewMembershipSuccessorRotationIncident),
        predecessorSource:
          "immutable-blocked-delete-recovery-terminal-not-original-inert-setup-wrapper",
        evidence: [
          privateFileReference("ATRINIK_REVIEW_MEMBERSHIP_SUCCESSOR_INCIDENT_PROOF_FILE"),
          privateFileReference("ATRINIK_REVIEW_MEMBERSHIP_SUCCESSOR_AUTHORITY_PROOF_FILE"),
          privateFileReference("ATRINIK_REVIEW_MEMBERSHIP_SUCCESSOR_JOURNAL_FILE"),
          privateFileReference("ATRINIK_REVIEW_MEMBERSHIP_SUCCESSOR_RESULT_PROOF_FILE"),
          privateFileReference(
            "ATRINIK_REVIEW_MEMBERSHIP_SUCCESSOR_SNAPSHOT_MANIFEST_FILE"),
        ],
        handoff: "reviewTokenRotation",
        forbidden: ["original-inert-setup-wrapper-as-live-predecessor",
          "recreate-membership-readable-token", "amend-prior-terminal-journal"],
      }) ||
      membershipRepair.authorityLifetimeMinutes !==
        reviewMembershipRepairAuthorityLifetimeMs / 60_000 ||
      !same(membershipRepair.operations?.map(({ id, actor, mutation }) =>
        [id, actor, mutation]), expectedMembershipRepairOperations) ||
      membershipRepair.operations[3].request?.method !== "POST" ||
      membershipRepair.operations[3].request?.path !== "/user/tokens" ||
      !same(membershipRepair.operations[3].request?.body?.policies?.[0]?.resources,
        { [`com.cloudflare.api.user.${reviewMembershipRepairIncident.ownerUserId}`]: "*" }) ||
      membershipRepair.failureRollback?.request?.method !== "DELETE" ||
      membershipRepair.failureRollback?.request?.path !==
        "/user/tokens/{journal_created_token_id}" ||
      membershipRepair.failureRollback?.actor !== "cloudflare-user-token-owner" ||
      membershipRepair.failureRollback?.mutation !== true)
    fail("review membership repair plan drift");
  inspect({ ...membershipRepair, operations: undefined, failureRollback: undefined });
  for (const operation of membershipRepair.operations) {
    inspect(operation);
    available.set(operation.id, new Set(Object.keys(operation.produces ?? {})));
  }
  inspect(membershipRepair.failureRollback);
  const disposableAuthority = plan.disposableProof?.authorityOperation;
  if (!same(disposableAuthority && [disposableAuthority.id, disposableAuthority.actor,
    disposableAuthority.mutation, disposableAuthority.action],
  ["disposable-review-proof-authority", "workers-builds-control-plane-operator", false,
    "bind-fresh-post-rotation-review-active-owner-token-sentinel-usage-evidence-into-bounded-disposable-proof-authority"]))
    fail("disposable review authority operation drift");
  inspect(disposableAuthority);
  available.set(disposableAuthority.id, new Set(Object.keys(disposableAuthority.produces ?? {})));
  inspect(plan.disposableProof);
  const activationOperations = plan.productionActivation?.preconditionOperations;
  const expectedActivationOperations = [
    ["production-activation-readback", "workers-builds-control-plane-operator", false,
      "prove-review-active-production-staged-and-disposable-review-result"],
    ["sentinel-recheck-before-production-activation", "github-owner-readback", false,
      "repeat-exact-private-random-production-sentinel-ref-absence-proof-outside-sandbox"],
  ];
  if (!Array.isArray(activationOperations) ||
      !same(activationOperations.map(({ id, actor, mutation, action }) =>
        [id, actor, mutation, action]), expectedActivationOperations))
    fail("production activation proof operation set, order, or authority drift");
  for (const operation of activationOperations) {
    inspect(operation);
    available.set(operation.id, new Set(Object.keys(operation.produces ?? {})));
  }
  inspect(plan.productionActivation);
  const rollbackOperations = plan.rollbackOperations;
  if (!Array.isArray(rollbackOperations) ||
      new Set(rollbackOperations.map(({ id }) => id)).size !== rollbackOperations.length)
    fail("rollback operation identity is incomplete or duplicated");
  const expectedRollback = [
    ["delete-review-trigger-before-quiescence", "workers-builds-control-plane-operator", true,
      "delete-exact-journaled-review-trigger-before-any-non-main-push-can-race-quiescence"],
    ["prove-review-trigger-deleted-before-quiescence", "workers-builds-control-plane-operator",
      false, "prove-phase-aware-exhaustive-inventory-is-empty-or-exactly-journaled-production-trigger"],
    ["sentinel-recheck-before-production-rollback", "github-owner-readback", false,
      "repeat-exact-private-random-production-sentinel-ref-absence-proof-outside-sandbox"],
    ["restore-production-trigger-to-inert-sentinel", "workers-builds-control-plane-operator", true,
      "restore-production-trigger-to-its-exact-inert-production-sentinel-before-cancelling-exact-active-builds"],
    ["prove-production-trigger-inert-before-quiescence", "workers-builds-control-plane-operator",
      false, "prove-phase-aware-production-trigger-is-absent-or-exactly-restored-to-inert-sentinel"],
    ["prove-rollback-quiescence", "workers-builds-control-plane-operator", false,
      "prove-no-build-or-upload-remains-active"],
    ["delete-production-trigger", "workers-builds-control-plane-operator", true,
      "delete-exact-journaled-production-trigger-after-quiescence"],
    ["prove-setup-triggers-deleted", "workers-builds-control-plane-operator", false,
      "prove-exhaustive-shared-core-trigger-inventory-is-empty"],
    ["delete-setup-build-tokens", "workers-builds-control-plane-operator", true,
      "delete-only-the-two-recorded-build-token-uuids"],
    ["prove-setup-build-tokens-deleted", "workers-builds-control-plane-operator", false,
      "prove-exhaustive-build-token-inventory-excludes-both-journaled-token-uuids"],
    ["retain-repository-connection", "workers-builds-control-plane-operator", false,
      "retain-shared-metaserver-repository-connection-provider-has-no-read-inventory-and-website-must-survive"],
    ["prove-production-preserved", "workers-builds-control-plane-operator", false,
      "prove-three-production-workers-and-website-app-selection-unchanged"],
  ];
  if (!same(rollbackOperations.map(({ id, actor, mutation, action }) =>
    [id, actor, mutation, action]), expectedRollback))
    fail("rollback operation set, order, actor, or mutation boundary drift");
  for (const operation of rollbackOperations) {
    inspect(operation);
    available.set(operation.id, new Set(Object.keys(operation.produces ?? {})));
  }
  const actualDigest = digestJson(plan);
  if (actualDigest !== expectedSetupPlanSha256)
    fail(`complete setup plan schema drift (${actualDigest})`);
  return plan;
}

export function validateAutomaticReviewEnvironment(actual, review) {
  const expected = automaticReviewEnvironmentSpec(review);
  if (!same(sorted(Object.keys(actual ?? {})), sorted(Object.keys(expected))))
    fail("review environment inventory drift");
  const bootstrap = actual.SKIP_DEPENDENCY_INSTALL ?? {};
  if (
    bootstrap.is_secret !== expected.SKIP_DEPENDENCY_INSTALL.is_secret ||
    bootstrap.value !== expected.SKIP_DEPENDENCY_INSTALL.value ||
    (bootstrap.created_on !== undefined &&
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(bootstrap.created_on)) ||
    !Object.keys(bootstrap).every((key) => ["created_on", "is_secret", "value"].includes(key))
  )
    fail("review trigger environment drift");
}

export function validateReviewStagedEnvironmentReadback({ trigger, environment },
  expectedTrigger, review) {
  if (!reviewStagingRootPattern.test(expectedTrigger?.root_directory ?? "") ||
      expectedTrigger.build_command !== "exit 1" || expectedTrigger.deploy_command !== "exit 1")
    fail("review staged trigger expectation is unsafe");
  validateTriggerSnapshot(trigger, expectedTrigger, "staged review");
  validateAutomaticReviewEnvironment(requireEnvelope(environment,
    "staged review environment"), review);
  return { outcome: "review-staged-environment-readback-valid", mutation: false,
    proof_digest: digestJson({ trigger, environment }) };
}

export function validateNoDeployHooks(envelope, label) {
  const hooks = requireExhaustiveEnvelope(envelope, `${label} deploy hooks`);
  if (hooks.length !== 0)
    fail(`${label} gained a Deploy Hook`);
}

export function validateRollbackTriggerInventory(envelope, {
  productionTriggerUuid = null, reviewTriggerUuid = null,
} = {}) {
  if (productionTriggerUuid !== null && !uuidPattern.test(productionTriggerUuid) ||
      reviewTriggerUuid !== null && !uuidPattern.test(reviewTriggerUuid) ||
      productionTriggerUuid !== null && productionTriggerUuid === reviewTriggerUuid)
    fail("rollback journaled trigger identity is malformed");
  const rows = requireExhaustiveEnvelope(envelope, "rollback shared core triggers");
  const expected = productionTriggerUuid === null ? [] : [productionTriggerUuid];
  if (!same(rows.map(({ trigger_uuid: id }) => id), expected) ||
      rows.some(({ trigger_uuid: id }) => !uuidPattern.test(id ?? "")) ||
      (reviewTriggerUuid !== null && rows.some(({ trigger_uuid: id }) => id === reviewTriggerUuid)))
    fail("rollback trigger inventory contains a competing or unreconciled trigger");
  return { outcome: "rollback-trigger-inventory-exact", mutation: false,
    proof_digest: digestJson({ productionTriggerUuid, reviewTriggerUuid, rows }) };
}

export function validateRollbackProductionTriggerReadback(envelope, {
  productionTriggerUuid = null, expectedTrigger = null,
} = {}) {
  if (productionTriggerUuid !== null && !uuidPattern.test(productionTriggerUuid))
    fail("rollback production trigger identity is malformed");
  const rows = requireExhaustiveEnvelope(envelope, "rollback production trigger readback");
  if (productionTriggerUuid === null) {
    if (rows.length !== 0)
      fail("rollback production trigger must be absent before creation");
  } else {
    if (rows.length !== 1 || rows[0]?.trigger_uuid !== productionTriggerUuid)
      fail("rollback production trigger inventory is not exact");
    validateTriggerSnapshot(rows[0], expectedTrigger, "rollback production inert");
  }
  return { outcome: "rollback-production-trigger-inert", mutation: false,
    proof_digest: digestJson({ productionTriggerUuid, expectedTrigger, rows }) };
}

export function validateNoActiveBuilds(envelope, label) {
  const builds = requireExhaustiveEnvelope(envelope, `${label} builds`);
  if (builds.some(({ status }) =>
    !["queued", "initializing", "running", "stopped"].includes(status)))
    fail(`${label} build inventory is malformed`);
  if (builds.some(({ status }) => status !== "stopped"))
    fail(`${label} has an active Workers Build`);
}

function validateRetiredReviewWorkerAbsent(scriptRows, review, label) {
  const retiredName = review?.automaticReview?.localValidation?.workerName;
  if (review?.automaticReview?.costPolicy?.persistentWorkers !== 0 ||
      typeof retiredName !== "string" || !retiredName ||
      retiredName === review?.automaticReview?.project)
    fail("retired review Worker contract is malformed");
  const count = scriptRows.filter(({ id }) => id === retiredName).length;
  if (count !== 0) fail(`${label} contains the retired review Worker`);
  return count;
}

export function validateFreshBuildsSnapshot({ production, review, scripts,
  triggers, deployHooks, builds, buildTokens, accountTriggers,
  productionSentinelProof, repositoryConnectionProof, accountId,
  sourceSha }) {
  const scriptRows = requireEnvelope(scripts, "scripts");
  if (!Array.isArray(scriptRows)) fail("script inventory is invalid");
  const reviewPersistentWorkerCount = validateRetiredReviewWorkerAbsent(
    scriptRows, review, "fresh Worker inventory");
  const requiredNames = production.workers.map(({ name }) => name);
  for (const name of requiredNames) {
    const matches = scriptRows.filter(({ id }) => id === name);
    if (matches.length !== 1 || !scriptTagPattern.test(matches[0].tag ?? ""))
      fail(`required production Worker ${name} is missing or ambiguous`);
  }
  const expectedLabels = production.workers.map(({ role }) => role);
  for (const [label, envelope] of exactLabeledInventories(triggers,
    expectedLabels, "fresh trigger")) {
    const rows = requireExhaustiveEnvelope(envelope, `${label} triggers`);
    if (rows.length !== 0)
      fail(`${label} has a competing Workers Builds trigger`);
  }
  for (const [label, envelope] of exactLabeledInventories(deployHooks,
    expectedLabels, "fresh Deploy Hook")) validateNoDeployHooks(envelope, label);
  for (const [label, envelope] of exactLabeledInventories(builds,
    expectedLabels, "fresh build")) validateNoActiveBuilds(envelope, label);
  const allTriggers = requireExhaustiveEnvelope(accountTriggers, "account triggers")
    .filter(({ repo_connection: connection }) => connection?.provider_type === "github" &&
      connection.provider_account_id === githubRepository.provider_account_id &&
      connection.repo_id === githubRepository.repo_id);
  if (allTriggers.length !== 0)
    fail("account has a competing Workers Builds trigger");
  const tokenRows = requireExhaustiveEnvelope(buildTokens, "build tokens");
  const reservedNames = new Set([
    "Atrinik metaserver production", reviewBuildTokenNames.predecessor,
    reviewBuildTokenNames.current,
  ]);
  if (tokenRows.some(({ build_token_name: name }) => reservedNames.has(name)))
    fail("reserved Workers Builds token name already exists");
  validateSentinelRefAbsence(productionSentinelProof);
  validateRepositoryConnectionOwnerProof(repositoryConnectionProof, accountId, sourceSha);
  return { outcome: "workers-builds-fresh-preflight-valid", mutation: false,
    productionProjectCount: production.workers.length,
    reviewPersistentWorkerCount, repositoryConnectionInventory: "provider-not-readable" };
}

export function validateInitialBootstrapSnapshot({ production, review, scripts,
  triggers, deployHooks, builds, buildTokens, accountTriggers }) {
  if (production.initialBootstrapPredecessor?.requiredPhase !==
      "all-builds-triggers-absent")
    fail("initial production bootstrap predecessor phase drift");
  const scriptRows = requireEnvelope(scripts, "initial bootstrap scripts");
  if (!Array.isArray(scriptRows) || production.workers.some(({ name }) =>
    scriptRows.filter(({ id }) => id === name).length !== 1))
    fail("initial bootstrap Worker inventory drift");
  validateRetiredReviewWorkerAbsent(scriptRows, review, "initial bootstrap Worker inventory");
  const expectedLabels = production.workers.map(({ role }) => role);
  for (const [label, envelope] of exactLabeledInventories(triggers,
    expectedLabels, "initial bootstrap trigger")) {
    if (requireExhaustiveEnvelope(envelope, `${label} triggers`).length !== 0)
      fail(`${label} trigger makes the initial bootstrap predecessor unavailable`);
  }
  for (const [label, envelope] of exactLabeledInventories(deployHooks,
    expectedLabels, "initial bootstrap Deploy Hook")) validateNoDeployHooks(envelope, label);
  for (const [label, envelope] of exactLabeledInventories(builds,
    expectedLabels, "initial bootstrap build")) validateNoActiveBuilds(envelope, label);
  const allTriggers = requireExhaustiveEnvelope(accountTriggers, "initial bootstrap account triggers")
    .filter(({ repo_connection: connection }) => connection?.provider_type === "github" &&
      connection.provider_account_id === githubRepository.provider_account_id &&
      connection.repo_id === githubRepository.repo_id);
  if (allTriggers.length !== 0)
    fail("repository trigger makes the initial bootstrap predecessor unavailable");
  const reservedNames = new Set([
    "Atrinik metaserver production", reviewBuildTokenNames.predecessor,
    reviewBuildTokenNames.current,
  ]);
  if (requireExhaustiveEnvelope(buildTokens, "initial bootstrap build tokens")
    .some(({ build_token_name: name }) => reservedNames.has(name)))
    fail("reserved build token makes the initial bootstrap predecessor unavailable");
  return { outcome: "initial-production-bootstrap-predecessor-proven", mutation: false };
}

function exactLabeledInventories(actual, expectedLabels, label) {
  if (!Array.isArray(actual) || actual.some((entry) =>
    !Array.isArray(entry) || entry.length !== 2) ||
      !same(sorted(actual.map(([name]) => name)), sorted(expectedLabels)))
    fail(`${label} inventory is incomplete or ambiguous`);
  return actual;
}

export function validateBuildTokenInventory(envelope, expectedTokens) {
  const tokens = requireExhaustiveEnvelope(envelope, "build tokens");
  const underlyingIds = new Set();
  for (const { uuid, name, cloudflareTokenId } of expectedTokens) {
    const matches = tokens.filter(({ build_token_uuid: candidate }) => candidate === uuid);
    if (matches.length !== 1) fail("configured build token is missing or ambiguous");
    const token = matches[0];
    if (
      token.owner_type !== "user" ||
      token.build_token_name !== name ||
      typeof token.cloudflare_token_id !== "string" || !token.cloudflare_token_id.trim() ||
      (cloudflareTokenId !== undefined && token.cloudflare_token_id !== cloudflareTokenId)
    ) fail("configured build token authority is malformed");
    if (underlyingIds.has(token.cloudflare_token_id))
      fail("production and review reuse one underlying API token");
    underlyingIds.add(token.cloudflare_token_id);
  }
}

export function validateTokenAuthorityProofs({ production, review, accountId, proofs,
  tokenRows, sourceSha }, now = Date.now()) {
  const expected = [
    { kind: "production", tokenId: tokenRows.production.cloudflare_token_id,
      userPermissions: [], accountPermissions: ["D1:Read", "Workers Scripts:Edit"],
      accountResources: [accountId], zonePermissions: [], zoneResources: [] },
    { kind: "review", tokenId: tokenRows.review.cloudflare_token_id,
      userPermissions: review.automaticReview.tokenAuthority.userPermissions,
      accountPermissions: review.automaticReview.tokenAuthority.accountPermissions,
      accountResources: review.automaticReview.tokenAuthority.accountResources,
      zonePermissions: review.automaticReview.tokenAuthority.zonePermissions,
      zoneResources: review.automaticReview.tokenAuthority.zoneResources },
  ];
  if (!Array.isArray(proofs) || proofs.length !== expected.length)
    fail("build token permission proof inventory is incomplete");
  for (const item of expected) {
    const proof = proofs.find(({ kind }) => kind === item.kind);
    const captured = Date.parse(proof?.capturedAt ?? "");
    const modified = Date.parse(proof?.modifiedOn ?? "");
    if (!proof || proof.source !== "cloudflare-owner-token-policy-readback" ||
        !same(Object.keys(proof).sort(), ["accountId", "accountPermissions", "accountResources",
          "capturedAt", "kind", "modifiedOn", "source", "sourceSha", "tokenId",
          "userPermissions", "zonePermissions", "zoneResources"].sort()) ||
        !Number.isFinite(captured) || captured > now + 30_000 || now - captured > 5 * 60_000 ||
        !Number.isFinite(modified) || modified > captured ||
        ![proof.userPermissions, proof.accountPermissions, proof.accountResources,
          proof.zonePermissions, proof.zoneResources].every(Array.isArray) ||
        proof.accountId !== accountId || proof.sourceSha !== sourceSha ||
        proof.tokenId !== item.tokenId ||
        !same(sorted(proof.userPermissions ?? []), sorted(item.userPermissions)) ||
        !same(sorted(proof.accountPermissions ?? []), sorted(item.accountPermissions)) ||
        !same(sorted(proof.accountResources ?? []), sorted(item.accountResources)) ||
        !same(sorted(proof.zonePermissions ?? []), sorted(item.zonePermissions)) ||
        !same(sorted(proof.zoneResources ?? []), sorted(item.zoneResources)))
      fail(`${item.kind} build token permission proof drift`);
  }
  if (production.workers.length !== 3) fail("production token resource boundary drift");
}

export function validateReplacementReviewTokenAuthorityProof({ review, accountId, proof,
  tokenId, sourceSha }, now = Date.now()) {
  const keys = ["accountId", "accountPermissions", "accountResources", "capturedAt", "kind",
    "modifiedOn", "ownerUserId", "source", "sourceSha", "tokenId", "userPermissions",
    "zonePermissions", "zoneResources"];
  const captured = Date.parse(proof?.capturedAt ?? "");
  const modified = Date.parse(proof?.modifiedOn ?? "");
  const expected = {
    ...review.automaticReview.tokenAuthority,
    userPermissions: review.automaticReview.membershipReadRepair.requiredUserPermissions,
  };
  if (!proof || !same(sorted(Object.keys(proof)), sorted(keys)) ||
      proof.source !== "cloudflare-owner-token-policy-readback" ||
      proof.kind !== "review-replacement" || proof.accountId !== accountId ||
      proof.sourceSha !== sourceSha || proof.tokenId !== tokenId ||
      !/^[0-9a-f]{32}$/u.test(proof.ownerUserId ?? "") ||
      !isUtcTimestamp(proof.capturedAt) || !isUtcTimestamp(proof.modifiedOn) ||
      !Number.isFinite(captured) || captured > now + 30_000 || now - captured > 5 * 60_000 ||
      !Number.isFinite(modified) || modified > captured ||
      !same(sorted(proof.userPermissions ?? []), sorted(expected.userPermissions)) ||
      !same(sorted(proof.accountPermissions ?? []), sorted(expected.accountPermissions)) ||
      !same(sorted(proof.accountResources ?? []), sorted(expected.accountResources)) ||
      !same(sorted(proof.zonePermissions ?? []), sorted(expected.zonePermissions)) ||
      !same(sorted(proof.zoneResources ?? []), sorted(expected.zoneResources)))
    fail("replacement review build token permission proof drift");
  return proof;
}

export function validateReplacementTokenOwnerMembershipProof({ accountId, sourceSha, proof,
  ownerUserId }, now = Date.now()) {
  const keys = ["accountId", "capturedAt", "membershipStatus", "ownerUserId", "source",
    "sourceSha"];
  const captured = Date.parse(proof?.capturedAt ?? "");
  if (!proof || !same(sorted(Object.keys(proof)), sorted(keys)) ||
      proof.source !== "cloudflare-owner-account-membership-readback" ||
      proof.accountId !== accountId || proof.sourceSha !== sourceSha ||
      proof.ownerUserId !== ownerUserId || proof.membershipStatus !== "accepted" ||
      !isUtcTimestamp(proof.capturedAt) || !Number.isFinite(captured) ||
      captured > now + 30_000 || now - captured > 5 * 60_000)
    fail("replacement token owner active membership proof drift");
  return proof;
}

export function validateReviewTokenRotationReadback({ production, review, phase,
  productionTrigger, reviewTrigger, productionEnvironment, reviewEnvironment,
  buildTokens, accountTriggers, productionScriptTag, productionSentinel,
  productionTriggerUuid, reviewTriggerUuid, predecessorReviewTokenUuid,
  replacementReviewTokenUuid, repositoryConnectionUuid }) {
  if (!["predecessor", "replacement-created", "predecessor-restored",
    "production-repointed", "production-repointed-review-augmented",
    "production-restored-review-augmented", "review-repointed",
    "old-wrapper-unreferenced", "complete"]
    .includes(phase)) fail("review token rotation phase is malformed");
  for (const value of [productionTriggerUuid, reviewTriggerUuid, predecessorReviewTokenUuid,
    repositoryConnectionUuid]) if (!uuidPattern.test(value ?? ""))
    fail("review token rotation journal identity is malformed");
  const replacementRequired = phase !== "predecessor";
  if (replacementRequired !== uuidPattern.test(replacementReviewTokenUuid ?? ""))
    fail("review token rotation replacement identity is malformed");
  if (new Set([productionTriggerUuid, reviewTriggerUuid, predecessorReviewTokenUuid,
    ...(replacementRequired ? [replacementReviewTokenUuid] : [])]).size !==
      (replacementRequired ? 4 : 3))
    fail("review token rotation identities overlap");
  if (productionTrigger?.trigger_uuid !== productionTriggerUuid ||
      reviewTrigger?.trigger_uuid !== reviewTriggerUuid)
    fail("review token rotation trigger identity drift");
  const tokens = requireExhaustiveEnvelope(buildTokens, "review token rotation build tokens");
  const productionRows = tokens.filter(({ build_token_name: name }) =>
    name === "Atrinik metaserver production");
  const predecessorRows = tokens.filter(({ build_token_name: name }) =>
    name === reviewBuildTokenNames.predecessor);
  const replacementRows = tokens.filter(({ build_token_name: name }) =>
    name === reviewBuildTokenNames.current);
  const expectedTokenCount = phase === "predecessor" || phase === "complete" ? 2 : 3;
  if (tokens.length !== expectedTokenCount || productionRows.length !== 1 ||
      predecessorRows.length !== (phase === "complete" ? 0 : 1) ||
      replacementRows.length !== (replacementRequired ? 1 : 0) ||
      (predecessorRows[0] && predecessorRows[0].build_token_uuid !== predecessorReviewTokenUuid) ||
      (replacementRows[0] && replacementRows[0].build_token_uuid !== replacementReviewTokenUuid))
    fail("review token rotation wrapper inventory drift");
  const productionTokenUuid = productionRows[0].build_token_uuid;
  if (!uuidPattern.test(productionTokenUuid ?? "") || productionTokenUuid ===
      predecessorReviewTokenUuid || productionTokenUuid === replacementReviewTokenUuid)
    fail("review token rotation production wrapper drift");
  const productionUsesReplacement = ["production-repointed",
    "production-repointed-review-augmented", "review-repointed",
    "old-wrapper-unreferenced", "complete"].includes(phase);
  const reviewUsesReplacement = ["review-repointed", "old-wrapper-unreferenced",
    "complete"].includes(phase);
  const expectedProduction = productionTriggerSpec(production, {
    externalScriptId: productionScriptTag,
    repositoryConnectionUuid,
    buildTokenUuid: productionUsesReplacement ? replacementReviewTokenUuid :
      predecessorReviewTokenUuid,
  });
  expectedProduction.branch_includes = [productionSentinel];
  const expectedReview = automaticReviewTriggerSpec(review, {
    externalScriptId: productionScriptTag,
    repositoryConnectionUuid,
    buildTokenUuid: reviewUsesReplacement ? replacementReviewTokenUuid :
      predecessorReviewTokenUuid,
  });
  if (["production-repointed-review-augmented",
    "production-restored-review-augmented"].includes(phase))
    expectedReview.branch_excludes = [production.productionBranch, productionSentinel];
  validateTriggerSnapshot(productionTrigger, expectedProduction,
    `review token rotation ${phase} production`);
  validateTriggerSnapshot(reviewTrigger, expectedReview,
    `review token rotation ${phase} review`);
  validateBuildEnvironment(production,
    requireEnvelope(productionEnvironment, "review token rotation production environment"));
  validateAutomaticReviewEnvironment(requireEnvelope(reviewEnvironment,
    "review token rotation review environment"), review);
  const accountRows = requireExhaustiveEnvelope(accountTriggers,
    "review token rotation account triggers").filter(({ repo_connection: connection }) =>
    connection?.provider_type === "github" &&
    connection.provider_account_id === githubRepository.provider_account_id &&
    connection.repo_id === githubRepository.repo_id);
  if (!same(sorted(accountRows.map(({ trigger_uuid: id }) => id)),
    sorted([productionTriggerUuid, reviewTriggerUuid])))
    fail("review token rotation account trigger inventory drift");
  const globallyUnreferencedTokenUuid = phase === "old-wrapper-unreferenced" ?
    predecessorReviewTokenUuid : phase === "predecessor-restored" ?
      replacementReviewTokenUuid : null;
  if (globallyUnreferencedTokenUuid && requireExhaustiveEnvelope(accountTriggers,
    "review token rotation account triggers").some(({ build_token_uuid: id }) =>
    id === globallyUnreferencedTokenUuid))
    fail("review token rotation wrapper expected to be unreferenced is still referenced");
  return { outcome: `workers-builds-review-token-rotation-${phase}-valid`, mutation: false,
    phase, productionTriggerUuid, reviewTriggerUuid, productionBuildTokenUuid: productionTokenUuid,
    predecessorReviewTokenUuid,
    ...(replacementRequired ? { replacementReviewTokenUuid } : {}) };
}

export function validateReviewBuildBoundary({ review, builds, buildLimits,
  buildUsageProof, accountId }, now = Date.now()) {
  validateNoActiveBuilds(builds, "review trigger");
  const limits = requireEnvelope(buildLimits, "Workers Builds account limits");
  if (typeof limits.has_reached_build_minutes_limit !== "boolean" ||
      (limits.build_minutes_refresh_on !== undefined &&
       !Number.isFinite(Date.parse(limits.build_minutes_refresh_on))))
    fail("Workers Builds account limit readback is malformed");
  if (limits.has_reached_build_minutes_limit)
    fail("Workers Builds account has reached its monthly limit");
  validateBuildUsageProof(review, buildUsageProof, accountId, now);
}

export function validateConfiguredBuildsSnapshot({ production, review, scripts,
  productionTriggers, productionEnvironment, reviewTriggers, reviewEnvironment,
  nonEntrypointTriggers, deployHooks, buildTokens, accountTriggers,
  reviewBuildState, accountId, tokenAuthorityProofs, sourceSha }) {
  const scriptRows = requireEnvelope(scripts, "scripts");
  if (!Array.isArray(scriptRows)) fail("script inventory is invalid");
  validateRetiredReviewWorkerAbsent(scriptRows, review, "configured Worker inventory");
  const matches = scriptRows.filter(({ id }) => id === production.workers[0].name);
  if (matches.length !== 1 || review.automaticReview.project !== production.workers[0].name ||
      !scriptTagPattern.test(matches[0].tag ?? ""))
    fail("configured shared Builds project is missing or malformed");
  const productionScript = matches[0];
  const reviewScript = matches[0];
  const sharedRows = requireExhaustiveEnvelope(productionTriggers, "shared core triggers");
  if (!same(productionTriggers, reviewTriggers) || sharedRows.length !== 2)
    fail("configured core project does not have exactly two shared triggers");
  const productionRows = sharedRows.filter(({ trigger_name: name }) =>
    name === "Atrinik automatic production main");
  const reviewRows = sharedRows.filter(({ trigger_name: name }) =>
    name === "Atrinik build-only review");
  if (productionRows.length !== 1 || reviewRows.length !== 1)
    fail("configured production/preview trigger roles are missing or ambiguous");
  for (const [label, envelope] of exactLabeledInventories(nonEntrypointTriggers,
    production.workers.slice(1).map(({ role }) => role), "non-entrypoint trigger")) {
    const rows = requireExhaustiveEnvelope(envelope, `${label} triggers`);
    if (rows.length !== 0)
      fail(`${label} gained an independent Builds trigger`);
  }
  const productionActual = productionRows[0];
  const reviewActual = reviewRows[0];
  if (productionActual.trigger_uuid === reviewActual.trigger_uuid ||
      productionActual.build_token_uuid === reviewActual.build_token_uuid)
    fail("production and review trigger/token identities are not isolated");
  const tokenRows = requireExhaustiveEnvelope(buildTokens, "build tokens");
  const productionToken = tokenRows.find(({ build_token_uuid: id }) =>
    id === productionActual.build_token_uuid);
  const reviewToken = tokenRows.find(({ build_token_uuid: id }) => id === reviewActual.build_token_uuid);
  validateBuildTokenInventory(buildTokens, [
    { uuid: productionActual.build_token_uuid, name: "Atrinik metaserver production",
      cloudflareTokenId: tokenAuthorityProofs?.find(({ kind }) => kind === "production")?.tokenId },
    { uuid: reviewActual.build_token_uuid, name: reviewBuildTokenNames.current,
      cloudflareTokenId: tokenAuthorityProofs?.find(({ kind }) => kind === "review")?.tokenId },
  ]);
  validateTokenAuthorityProofs({ production, review, accountId, proofs: tokenAuthorityProofs,
    tokenRows: { production: productionToken, review: reviewToken }, sourceSha });
  const productionExpected = productionTriggerSpec(production, {
    externalScriptId: productionScript.tag,
    repositoryConnectionUuid: productionActual.repo_connection?.repo_connection_uuid,
    buildTokenUuid: productionActual.build_token_uuid,
  });
  const reviewExpected = automaticReviewTriggerSpec(review, {
    externalScriptId: reviewScript.tag,
    repositoryConnectionUuid: reviewActual.repo_connection?.repo_connection_uuid,
    buildTokenUuid: reviewActual.build_token_uuid,
  });
  validateTriggerSnapshot(productionActual, productionExpected, "production");
  validateTriggerSnapshot(reviewActual, reviewExpected, "review");
  if (productionActual.repo_connection.repo_connection_uuid !==
      reviewActual.repo_connection.repo_connection_uuid)
    fail("production and review triggers do not reuse one repository connection");
  validateBuildEnvironment(production, requireEnvelope(productionEnvironment,
    "production environment"));
  validateAutomaticReviewEnvironment(requireEnvelope(reviewEnvironment,
    "review environment"), review);
  const allTriggers = requireExhaustiveEnvelope(accountTriggers, "account triggers")
    .filter(({ repo_connection: connection }) => connection?.provider_type === "github" &&
      connection.provider_account_id === githubRepository.provider_account_id &&
      connection.repo_id === githubRepository.repo_id);
  if (allTriggers.length !== 2 || !same(sorted(allTriggers.map(({ trigger_uuid: id }) => id)),
    sorted([productionActual.trigger_uuid, reviewActual.trigger_uuid])))
    fail("account has a competing or missing Workers Builds trigger");
  validateReviewBuildBoundary({ review, ...reviewBuildState, accountId });
  for (const [label, envelope] of exactLabeledInventories(deployHooks,
    production.workers.map(({ role }) => role), "Deploy Hook"))
    validateNoDeployHooks(envelope, label);
  return {
    outcome: "workers-builds-configured-snapshot-valid",
    mutation: false,
    productionTriggerCount: 1,
    reviewTriggerCount: 1,
    deployHookCount: 0,
  };
}

export function validateReviewResultProof({ proof, reviewTrigger, reviewToken, builds, mainSha },
  now = Date.now()) {
  const keys = ["branch", "buildTokenUuid", "buildUuid", "capturedAt", "cleanupPolicy",
    "evidenceLocation", "githubEvidence", "repository", "reviewCommitSha", "source",
    "triggerUuid", "productionMainSha"];
  const captured = Date.parse(proof?.capturedAt ?? "");
  const rows = requireExhaustiveEnvelope(builds, "review result builds");
  const matches = rows.filter(({ build_uuid: id }) => id === proof?.buildUuid);
  const row = matches[0];
  const metadata = row?.build_trigger_metadata ?? {};
  const created = Date.parse(row?.created_on ?? "");
  const stopped = Date.parse(row?.stopped_on ?? "");
  const evidenceCaptured = Date.parse(proof?.githubEvidence?.capturedAt ?? "");
  const checkRuns = proof?.githubEvidence?.checkRuns;
  const check = checkRuns?.check_runs?.[0];
  const checkStarted = Date.parse(check?.started_at ?? "");
  const checkCompleted = Date.parse(check?.completed_at ?? "");
  let details;
  try { details = new URL(check?.details_url ?? ""); } catch { details = null; }
  const triggerKeys = ["branch_excludes", "branch_includes", "build_caching_enabled",
    "build_command", "deploy_command", "external_script_id", "path_excludes", "path_includes",
    "root_directory", "trigger_name", "trigger_uuid"];
  const liveTriggerView = Object.fromEntries(triggerKeys.map((key) => [key,
    key === "root_directory" ? normalizedRoot(reviewTrigger[key]) : reviewTrigger[key]]));
  const buildTriggerView = Object.fromEntries(triggerKeys.map((key) => [key,
    key === "root_directory" ? normalizedRoot(row?.trigger?.[key]) : row?.trigger?.[key]]));
  if (!proof || !same(sorted(Object.keys(proof)), sorted(keys)) ||
      proof.source !== "cloudflare-github-disposable-review-readback" ||
      proof.repository !== "atrinik/metaserver-worker" ||
      proof.productionMainSha !== mainSha || proof.reviewCommitSha === mainSha ||
      !/^review\/issue-66-[a-z0-9-]{1,40}$/u.test(proof.branch ?? "") ||
      !gitShaPattern.test(proof.reviewCommitSha ?? "") || !uuidPattern.test(proof.buildUuid ?? "") ||
      proof.triggerUuid !== reviewTrigger.trigger_uuid ||
      proof.buildTokenUuid !== reviewToken.build_token_uuid ||
      proof.cleanupPolicy !== "build-only-no-version-binding-route-url-or-resource-created" ||
      proof.evidenceLocation !== "atrinik/metaserver-worker#66-private-provider-evidence" ||
      !Number.isFinite(captured) || captured > now + 30_000 || now - captured > 5 * 60_000 ||
      matches.length !== 1 || row.status !== "stopped" || row.build_outcome !== "success" ||
      row.trigger?.trigger_uuid !== proof.triggerUuid || metadata.branch !== proof.branch ||
      metadata.commit_hash !== proof.reviewCommitSha ||
      metadata.build_token_uuid !== proof.buildTokenUuid ||
      metadata.build_trigger_source !== "push_event" ||
      metadata.provider_type !== "github" || metadata.provider_account_name !== "atrinik" ||
      metadata.repo_name !== githubRepository.repo_name ||
      row.trigger?.repo_connection?.provider_account_id !==
        githubRepository.provider_account_id ||
      row.trigger?.repo_connection?.repo_id !== githubRepository.repo_id ||
      row.trigger?.repo_connection?.repo_connection_uuid !==
        reviewTrigger.repo_connection?.repo_connection_uuid ||
      metadata.build_command !== reviewTrigger.build_command ||
      metadata.deploy_command !== reviewTrigger.deploy_command ||
      normalizedRoot(metadata.root_directory) !== normalizedRoot(reviewTrigger.root_directory) ||
      !same(buildTriggerView, liveTriggerView) ||
      !Number.isFinite(created) || !Number.isFinite(stopped) || created > stopped ||
      stopped - created > 20 * 60_000 || stopped > captured || captured - stopped > 5 * 60_000 ||
      !Number.isFinite(evidenceCaptured) || evidenceCaptured > now + 30_000 ||
      evidenceCaptured < stopped || now - evidenceCaptured > 5 * 60_000 ||
      !Array.isArray(proof.githubEvidence?.refs) || proof.githubEvidence.refs.length !== 0 ||
      proof.githubEvidence?.comparison?.status === "ahead" ||
      proof.githubEvidence?.comparison?.status === "identical" ||
      !["behind", "diverged"].includes(proof.githubEvidence?.comparison?.status) ||
      proof.githubEvidence?.comparison?.base_commit?.sha !== proof.reviewCommitSha ||
      proof.githubEvidence?.comparison?.head_commit?.sha !== mainSha ||
      checkRuns?.total_count !== 1 || !Array.isArray(checkRuns?.check_runs) ||
      checkRuns.check_runs.length !== 1 || !Number.isSafeInteger(check?.id) ||
      check.name !== "Workers Builds: atrinik-metaserver" || check.status !== "completed" ||
      check.conclusion !== "success" || check.head_sha !== proof.reviewCommitSha ||
      check.app?.id !== 85455 || typeof check.external_id !== "string" || !check.external_id ||
      details?.protocol !== "https:" || details.hostname !== "dash.cloudflare.com" ||
      !details.pathname.includes(proof.buildUuid) || !Number.isFinite(checkStarted) ||
      !Number.isFinite(checkCompleted) || checkStarted > checkCompleted ||
      checkCompleted > evidenceCaptured)
    fail("disposable review result proof is missing, stale, failed, or mismatched");
  return proof;
}

function validateActivationSnapshot({ production, review, scripts,
  productionTriggers, productionEnvironment, reviewTriggers, reviewEnvironment,
  nonEntrypointTriggers, deployHooks, builds, buildTokens, accountTriggers, reviewBuildState,
  accountId, tokenAuthorityProofs, sourceSha,
  productionSentinelProof,
  snapshotManifest, reviewResultProof, reviewActivationAuthorityProof,
  reviewActivationAuthorityEvidence, reviewActivationAuthorityCheckpoint },
{ reviewActive, requireReviewResult = reviewActive,
  authorityRequired = reviewActive && !requireReviewResult,
  includeLiveIdentities = false,
  reviewTokenName = reviewBuildTokenNames.current }) {
  const reviewAuthority = reviewActive && !requireReviewResult && authorityRequired ?
    (reviewActivationAuthorityCheckpoint ? validateReviewActivationAuthorityCheckpoint(
      reviewActivationAuthorityProof, {
        production, review, accountId, sourceSha, ...reviewActivationAuthorityEvidence,
      }, reviewActivationAuthorityCheckpoint) :
      validateReviewActivationAuthority(reviewActivationAuthorityProof, {
        production, review, accountId, sourceSha, ...reviewActivationAuthorityEvidence,
      })) : null;
  const proofValidationTime = reviewAuthority?.proofValidationTime ?? Date.now();
  if (reviewAuthority &&
      (!same(productionSentinelProof, reviewActivationAuthorityEvidence.productionSentinelProof) ||
       !same(tokenAuthorityProofs, reviewActivationAuthorityEvidence.tokenAuthorityProofs) ||
       !same(reviewBuildState.buildUsageProof,
         reviewActivationAuthorityEvidence.buildUsageProof)))
    fail("review activation snapshot authority evidence drift");
  validateSentinelRefAbsence(productionSentinelProof, proofValidationTime);
  const scriptRows = requireEnvelope(scripts, "scripts");
  if (!Array.isArray(scriptRows)) fail("script inventory is invalid");
  validateRetiredReviewWorkerAbsent(scriptRows, review, "staged Worker inventory");
  const matches = scriptRows.filter(({ id }) => id === production.workers[0].name);
  if (matches.length !== 1 || review.automaticReview.project !== production.workers[0].name ||
      !scriptTagPattern.test(matches[0].tag ?? ""))
    fail("staged shared Builds project is missing or malformed");
  const productionScript = matches[0];
  const reviewScript = matches[0];
  const sharedRows = requireExhaustiveEnvelope(productionTriggers, "staged shared core triggers");
  const expectedTriggerCount = reviewActive ? 2 : 1;
  if (!same(productionTriggers, reviewTriggers) || sharedRows.length !== expectedTriggerCount)
    fail(`staged core project does not have exactly ${expectedTriggerCount} shared trigger(s)`);
  const productionRows = sharedRows.filter(({ trigger_name: name }) =>
    name === "Atrinik automatic production main");
  const reviewRows = sharedRows.filter(({ trigger_name: name }) =>
    name === "Atrinik build-only review");
  if (productionRows.length !== 1 || reviewRows.length !== (reviewActive ? 1 : 0))
    fail("staged production/preview trigger phase is missing or ambiguous");
  const tokenRows = requireExhaustiveEnvelope(buildTokens, "build tokens");
  const reviewToken = tokenRows.find(({ build_token_name: name }) =>
    name === reviewTokenName);
  const productionToken = tokenRows.find(({ build_token_name: name }) =>
    name === "Atrinik metaserver production");
  if (!productionToken || !reviewToken ||
      productionRows[0].build_token_uuid !== reviewToken.build_token_uuid ||
      (reviewActive && reviewRows[0].build_token_uuid !== reviewToken.build_token_uuid))
    fail("staged trigger phase does not use the zero-resource review token");
  validateBuildTokenInventory(buildTokens, [
    { uuid: productionToken.build_token_uuid, name: "Atrinik metaserver production",
      cloudflareTokenId: tokenAuthorityProofs?.find(({ kind }) => kind === "production")?.tokenId },
    { uuid: reviewToken.build_token_uuid, name: reviewTokenName,
      cloudflareTokenId: tokenAuthorityProofs?.find(({ kind }) => kind === "review")?.tokenId },
  ]);
  validateTokenAuthorityProofs({ production, review, accountId, proofs: tokenAuthorityProofs,
    tokenRows: { production: productionToken, review: reviewToken }, sourceSha },
  proofValidationTime);
  const productionExpected = productionTriggerSpec(production, {
    externalScriptId: productionScript.tag,
    repositoryConnectionUuid: productionRows[0].repo_connection?.repo_connection_uuid,
    buildTokenUuid: reviewToken.build_token_uuid,
  });
  productionExpected.branch_includes = [productionSentinelProof.branch];
  validateTriggerSnapshot(productionRows[0], productionExpected, "staged production");
  if (reviewActive) {
    const reviewExpected = automaticReviewTriggerSpec(review, {
      externalScriptId: reviewScript.tag,
      repositoryConnectionUuid: reviewRows[0].repo_connection?.repo_connection_uuid,
      buildTokenUuid: reviewToken.build_token_uuid,
    });
    validateTriggerSnapshot(reviewRows[0], reviewExpected, "staged review");
    if (productionRows[0].repo_connection.repo_connection_uuid !==
        reviewRows[0].repo_connection.repo_connection_uuid)
      fail("staged triggers do not share the journaled repository connection");
  }
  validateBuildEnvironment(production, requireEnvelope(productionEnvironment,
    "staged production environment"));
  if (reviewActive) validateAutomaticReviewEnvironment(requireEnvelope(reviewEnvironment,
    "staged review environment"), review);
  else if (reviewEnvironment !== undefined)
    fail("staged review environment exists before review activation");
  for (const [label, envelope] of exactLabeledInventories(nonEntrypointTriggers,
    production.workers.slice(1).map(({ role }) => role), "staged non-entrypoint trigger"))
    if (requireExhaustiveEnvelope(envelope, `${label} staged triggers`).length !== 0)
      fail(`${label} has an independent staged Builds trigger`);
  const metaserverTriggers = requireExhaustiveEnvelope(accountTriggers, "account triggers")
    .filter(({ repo_connection: connection }) => connection?.provider_type === "github" &&
      connection.provider_account_id === githubRepository.provider_account_id &&
      connection.repo_id === githubRepository.repo_id);
  if (!same(sorted(metaserverTriggers.map(({ trigger_uuid: id }) => id)),
    sorted(reviewActive ? [productionRows[0].trigger_uuid, reviewRows[0].trigger_uuid] :
      [productionRows[0].trigger_uuid])))
    fail("staged account trigger inventory drift");
  const stagedLabels = production.workers.map(({ role }) => role);
  for (const [label, envelope] of exactLabeledInventories(deployHooks, stagedLabels,
    "staged Deploy Hook")) validateNoDeployHooks(envelope, label);
  for (const [label, envelope] of exactLabeledInventories(builds, stagedLabels,
    "staged build")) validateNoActiveBuilds(envelope, label);
  validateReviewBuildBoundary({ review, ...reviewBuildState, accountId }, proofValidationTime);
  if (requireReviewResult) validateReviewResultProof({ proof: reviewResultProof,
    reviewTrigger: reviewRows[0], reviewToken,
    builds: reviewBuildState.builds, mainSha: sourceSha });
  validateSnapshotManifest(snapshotManifest, { accountId, sourceSha, production, review });
  const capturedAt = new Date().toISOString();
  const snapshotCoordinate = { accountId: snapshotManifest.accountId,
    sourceSha: snapshotManifest.sourceSha,
    productionContractSha256: snapshotManifest.productionContractSha256,
    reviewContractSha256: snapshotManifest.reviewContractSha256 };
  const sentinelCoordinates = {
    production: { repository: productionSentinelProof.repository,
      branch: productionSentinelProof.branch, refs: productionSentinelProof.refs },
  };
  const state_digest = digestJson({ snapshotCoordinate, sentinelCoordinates, scripts,
    productionTriggers, productionEnvironment, reviewTriggers, reviewEnvironment,
    nonEntrypointTriggers, deployHooks, builds, buildTokens, accountTriggers,
    reviewBuildState, tokenAuthorityProofs,
    ...(reviewAuthority ? { reviewActivationAuthorityProof } : {}),
    ...(requireReviewResult ? { reviewResultProof } : {}) });
  const liveIdentities = includeLiveIdentities ? {
    productionTriggerUuid: productionRows[0].trigger_uuid,
    reviewTriggerUuid: reviewRows[0].trigger_uuid,
    productionBuildTokenUuid: productionToken.build_token_uuid,
    reviewBuildTokenUuid: reviewToken.build_token_uuid,
    repositoryConnectionUuid: reviewRows[0].repo_connection.repo_connection_uuid,
    productionEnvironmentDigest: digestJson(productionEnvironment),
    reviewEnvironmentDigest: digestJson(reviewEnvironment),
  } : undefined;
  const proof_digest = digestJson({ state_digest,
    snapshotStartedAt: snapshotManifest.startedAt,
    snapshotCompletedAt: snapshotManifest.completedAt, capturedAt,
    ...(liveIdentities ? { liveIdentities } : {}) });
  return { outcome: requireReviewResult ? "workers-builds-production-activation-snapshot-valid" :
    reviewActive ? "workers-builds-review-activation-snapshot-valid" :
      "workers-builds-staged-snapshot-valid", mutation: false,
    stagedTriggerCount: expectedTriggerCount, accountId, sourceSha, capturedAt,
    snapshotStartedAt: snapshotManifest.startedAt,
    snapshotCompletedAt: snapshotManifest.completedAt, state_digest, proof_digest,
    ...(liveIdentities ? { liveIdentities } : {}) };
}

export function validateStagedBuildsSnapshot(arguments_) {
  return validateActivationSnapshot(arguments_, { reviewActive: false });
}

export function validateProductionActivationSnapshot(arguments_) {
  return validateActivationSnapshot(arguments_, { reviewActive: true });
}

export function validateReviewActivationSnapshot(arguments_) {
  return validateActivationSnapshot(arguments_, { reviewActive: true,
    requireReviewResult: false });
}

export function validateStagedProof(proof, current, now = Date.now()) {
  if (!proof || !current ||
      proof.accountId !== current.accountId || proof.sourceSha !== current.sourceSha ||
      proof.state_digest !== current.state_digest)
    fail("staged activation proof is missing, stale, or mismatched");
  try {
    validateStagedSnapshotProofEvidence(proof,
      { accountId: proof.accountId, sourceSha: proof.sourceSha }, now);
    validateStagedSnapshotProofEvidence(current,
      { accountId: proof.accountId, sourceSha: proof.sourceSha }, now, 30_000);
  } catch { fail("staged activation proof is missing, stale, or mismatched"); }
  if (Date.parse(current.capturedAt) < Date.parse(proof.capturedAt) ||
      Date.parse(current.snapshotStartedAt) < Date.parse(proof.snapshotCompletedAt) ||
      Date.parse(current.snapshotCompletedAt) < Date.parse(proof.snapshotCompletedAt))
    fail("staged activation proof chronology did not advance");
  return { outcome: "workers-builds-staged-activation-proof-valid", mutation: false,
    state_digest: current.state_digest, proof_digest: current.proof_digest };
}

export function publicStagedProofSummary(proof) {
  return { outcome: proof.outcome, mutation: false,
    ...(proof.stagedTriggerCount === 1 ? { stagedTriggerCount: 1 } : {}),
    sourceSha: proof.sourceSha, proof_digest: proof.proof_digest };
}

export function materializeProductionConfiguration({
  base, liveBase = base, worker, settingsEnvelope, subdomainEnvelope, accountId,
}) {
  if (!accountIdPattern.test(accountId ?? "")) fail("production account ID is malformed");
  const settings = requireEnvelope(settingsEnvelope, `${worker.role} settings`);
  const subdomain = requireEnvelope(subdomainEnvelope, `${worker.role} subdomain`);
  if (subdomain.enabled !== false || subdomain.previews_enabled !== false)
    fail(`${worker.role} enables an alternate production URL`);
  if (
    liveBase.compatibility_date !== settings.compatibility_date ||
    !same(liveBase.compatibility_flags ?? [], settings.compatibility_flags ?? [])
  ) fail(`${worker.role} compatibility settings drift`);

  const config = structuredClone(base);
  const bindings = settings.bindings ?? [];
  if (!Array.isArray(bindings)) fail(`${worker.role} binding inventory is malformed`);
  const actualBindingInventory = bindings.map(({ name, type }) => ({ name, type }))
    .sort((left, right) => `${left.name}:${left.type}`.localeCompare(`${right.name}:${right.type}`));
  if (!same(actualBindingInventory, expectedBindingInventory(liveBase)))
    fail(`${worker.role} binding inventory drift`);
  config.account_id = accountId;
  config.workers_dev = false;
  config.preview_urls = false;
  config.routes = worker.customDomains.map((pattern) => ({ pattern, custom_domain: true }));
  if (Object.hasOwn(config.vars ?? {}, "DIRECTORY_CACHE_ZONE_ID")) {
    const live = oneBinding(bindings, "DIRECTORY_CACHE_ZONE_ID", "plain_text");
    config.vars.DIRECTORY_CACHE_ZONE_ID = live.text;
  }
  for (const [name, expected] of Object.entries(liveBase.vars ?? {})) {
    if (name === "DIRECTORY_CACHE_ZONE_ID") continue;
    if (oneBinding(bindings, name, "plain_text").text !== expected)
      fail(`${worker.role} plain-text binding ${name} drift`);
  }
  for (const { name, class_name: expectedClass } of config.durable_objects?.bindings ?? [])
    if (oneBinding(bindings, name, "durable_object_namespace").class_name !== expectedClass)
      fail(`${worker.role} Durable Object binding ${name} drift`);
  if (config.d1_databases) config.d1_databases = config.d1_databases.map((item) => {
    const live = oneBinding(bindings, item.binding, "d1");
    if (live.id !== undefined && live.database_id !== undefined &&
        live.id !== live.database_id)
      fail(`${worker.role} D1 binding ${item.binding} has ambiguous identifiers`);
    return { ...item, database_id: live.database_id ?? live.id };
  });
  if (config.r2_buckets) config.r2_buckets = config.r2_buckets.map((item) => {
    const live = oneBinding(bindings, item.binding, "r2_bucket");
    return { ...item, bucket_name: live.bucket_name };
  });
  if (config.analytics_engine_datasets)
    config.analytics_engine_datasets = config.analytics_engine_datasets.map((item) => {
      const live = oneBinding(bindings, item.binding, "analytics_engine");
      return { ...item, dataset: live.dataset };
    });
  if (config.ratelimits) config.ratelimits = config.ratelimits.map((item) => {
    const live = oneBinding(bindings, item.name, "ratelimit");
    return { ...item, namespace_id: String(live.namespace_id), simple: live.simple };
  });
  if (config.services) config.services = config.services.map((item) => {
    const live = oneBinding(bindings, item.binding, "service");
    if (live.environment !== undefined && live.environment !== "production")
      fail(`${worker.role} service binding ${item.binding} targets a nonproduction environment`);
    return { ...item, service: live.service, entrypoint: live.entrypoint };
  });
  const actualSecrets = sorted(bindings.filter(({ type }) => type === "secret_text")
    .map(({ name }) => name));
  if (!same(actualSecrets, sorted(config.secrets?.required ?? [])))
    fail(`${worker.role} secret-name inventory drift`);
  return config;
}

export function materializeProductionConfigurations({
  contract, bases, snapshots, accountId, initialBootstrapPredecessor = false,
}) {
  if (!Array.isArray(bases) || bases.length !== 3 || !Array.isArray(snapshots) || snapshots.length !== 3)
    fail("exactly three production configuration snapshots are required");
  const liveConfigurations = contract.workers.map((worker, index) =>
    initialBootstrapPredecessor
      ? initialBootstrapPredecessorConfiguration(contract, bases[index], worker)
      : bases[index]);
  const configurations = contract.workers.map((worker, index) =>
    materializeProductionConfiguration({
      base: bases[index], liveBase: liveConfigurations[index], worker,
      settingsEnvelope: snapshots[index].settings,
      subdomainEnvelope: snapshots[index].subdomain, accountId,
    }));
  validateTopology(contract, configurations, { production: true });
  for (const [index, config] of configurations.entries())
    if (Buffer.byteLength(JSON.stringify(config)) > 5 * 1024)
      fail(`${contract.workers[index].role} protected configuration exceeds the provider limit`);
  return configurations;
}

export function validateProductionControlPlane({ contract, configurations, snapshots, domains }) {
  const expectedDomains = contract.workers.flatMap((worker) =>
    worker.customDomains.map((hostname) => ({ hostname, service: worker.name })));
  const liveDomainRows = requireExhaustiveEnvelope(domains, "Custom Domain")
    .filter(({ service }) => contract.workers.some((worker) => worker.name === service));
  const actualDomains = liveDomainRows.map(({ hostname, service }) => ({ hostname, service }));
  if (!same(actualDomains.sort((a, b) => a.hostname.localeCompare(b.hostname)),
    expectedDomains.sort((a, b) => a.hostname.localeCompare(b.hostname))))
    fail("production Custom Domain inventory drift");
  const expectedZoneId = configurations[0]?.vars?.DIRECTORY_CACHE_ZONE_ID;
  if (liveDomainRows.some(({ zone_id: zoneId, zone_name: zoneName }) =>
    zoneId !== expectedZoneId || zoneName !== "atrinik.org"))
    fail("production Custom Domain zone authority drift");
  for (const [index, snapshot] of snapshots.entries()) {
    const expected = configurations[index].triggers?.crons ?? [];
    const schedules = requireEnvelope(snapshot.schedules, `${contract.workers[index].role} schedules`);
    const actual = (schedules.schedules ?? []).map(({ cron }) => cron);
    if (!same(sorted(actual), sorted(expected)))
      fail(`${contract.workers[index].role} schedule drift`);
    const routes = requireEnvelope(snapshot.routes, `${contract.workers[index].role} routes`);
    if (!Array.isArray(routes) || routes.length !== 0)
      fail(`${contract.workers[index].role} gained an alternate production route`);
    const scriptSettings = requireEnvelope(snapshot.scriptSettings,
      `${contract.workers[index].role} script settings`);
    if ((scriptSettings.tail_consumers ?? []).length !== 0 || scriptSettings.logpush === true)
      fail(`${contract.workers[index].role} gained an external log consumer`);
    const observability = requireEnvelope(snapshot.settings,
      `${contract.workers[index].role} settings`).observability;
    for (const channel of [observability?.logs, observability?.traces])
      if ((channel?.destinations ?? []).length !== 0)
        fail(`${contract.workers[index].role} gained an observability destination`);
    const expectedObservability = structuredClone(configurations[index].observability);
    if (observability?.head_sampling_rate === 1 &&
        expectedObservability.head_sampling_rate === undefined)
      expectedObservability.head_sampling_rate = 1;
    if (!sameCanonical(observability, expectedObservability))
      fail(`${contract.workers[index].role} observability configuration drift`);
  }
}

export function validateProductionRuntimeProof({ contract, configurations, deployments,
  activeVersions, migrationEnvelope, migrationNames, liveConfigurations = configurations }) {
  if (!Array.isArray(deployments) || deployments.length !== contract.workers.length ||
      !Array.isArray(activeVersions) || activeVersions.length !== contract.workers.length ||
      !Array.isArray(liveConfigurations) || liveConfigurations.length !== contract.workers.length)
    fail("production runtime proof inventory is incomplete");
  for (const [index, worker] of contract.workers.entries()) {
    const rows = requireEnvelope(deployments[index], `${worker.role} deployments`).deployments;
    const active = requireEnvelope(activeVersions[index], `${worker.role} active version`);
    const assigned = rows?.[0]?.versions ?? [];
    if (!Array.isArray(rows) || rows.length === 0 || assigned.length !== 1 ||
        assigned[0].percentage !== 100 || assigned[0].version_id !== active.id)
      fail(`${worker.role} active deployment is ambiguous`);
    const runtime = active.resources?.script_runtime ?? {};
    if (runtime.compatibility_date !== configurations[index].compatibility_date ||
        !same(runtime.compatibility_flags ?? [], configurations[index].compatibility_flags ?? []))
      fail(`${worker.role} active runtime configuration drift`);
    validateRemoteBindings(worker, liveConfigurations[index], active);
    validateRuntimeExports(worker, configurations[index], runtime.exports ?? {});
  }
  const queryResults = requireEnvelope(migrationEnvelope, "production migration ledger");
  if (!Array.isArray(queryResults) || queryResults.length !== 1 ||
      !Array.isArray(queryResults[0].results))
    fail("production migration ledger result is malformed");
  const liveRows = queryResults[0].results;
  for (const [index, row] of liveRows.entries())
    if (!same(sorted(Object.keys(row)), ["id", "name"]) ||
        row.id !== index + 1 || typeof row.name !== "string")
      fail("production migration ledger sequence is malformed");
  const liveNames = liveRows.map(({ name }) => name);
  if (!same(liveNames, migrationNames.slice(0, liveNames.length)) ||
      liveNames.length < migrationNames.length - 1 || liveNames.length > migrationNames.length)
    fail("production migration ledger is not an exact reviewed prefix");
  return { appliedMigrations: liveNames.length,
    pendingMigrations: migrationNames.slice(liveNames.length) };
}

async function checkedInInputs() {
  const production = JSON.parse(await readFile(productionPath, "utf8"));
  const review = JSON.parse(await readFile(reviewPath, "utf8"));
  const bases = await Promise.all([
    "wrangler.jsonc", "wrangler.publisher.jsonc", "wrangler.rendezvous.jsonc",
  ].map(async (path) => JSON.parse(await readFile(resolve(root, path), "utf8"))));
  validateProductionContract(production);
  await validateReviewContract();
  return { production, review, bases };
}

export async function createPrivateDirectory(path) {
  if (!isAbsolute(path ?? "")) fail("private output directory must be absolute");
  if (resolve(path) !== path) fail("private output directory must be normalized");
  const parent = dirname(path);
  const canonicalParent = await realpath(parent).catch(() => null);
  if (canonicalParent !== parent) fail("private output parent must be canonical and symlink-free");
  try {
    await lstat(path);
    fail("private output directory already exists");
  } catch (error) {
    if (error instanceof WorkersBuildsProvisioningError) throw error;
    if (error?.code !== "ENOENT") fail("private output directory cannot be inspected");
  }
  await mkdir(path, { mode: 0o700 });
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    .catch(() => null);
  if (!handle) fail("private output directory cannot be pinned");
  try {
    const metadata = await handle.stat();
    if (!metadata.isDirectory() || !isCurrentUserOwned(metadata))
      fail("private output path is not an owner-controlled directory");
    await handle.chmod(0o700);
  } finally { await handle.close(); }
}

export async function readPrivateValue(path, label, pattern = null) {
  if (!isAbsolute(path ?? "")) fail(`${label} file path must be absolute`);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  if (!handle) fail(`${label} file cannot be opened without following links`);
  let value;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || !isCurrentUserOwned(metadata) ||
        (metadata.mode & 0o077) !== 0 ||
        metadata.size > maximumPrivateDocumentBytes)
      fail(`${label} file must be a bounded private regular file`);
    value = (await handle.readFile("utf8")).trim();
  } finally { await handle.close(); }
  if (!value || value.includes("\n") || (pattern && !pattern.test(value)))
    fail(`${label} file is malformed`);
  return value;
}

export async function readPrivateJson(path, label) {
  if (!isAbsolute(path ?? "")) fail(`${label} file path must be absolute`);
  if (await realpath(path).catch(() => null) !== resolve(path))
    fail(`${label} file path must be canonical without linked ancestors`);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  if (!handle) fail(`${label} file cannot be opened without following links`);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || !isCurrentUserOwned(metadata) ||
        (metadata.mode & 0o077) !== 0 || metadata.size > maximumPrivateDocumentBytes)
      fail(`${label} file must be a bounded private regular file`);
    return JSON.parse(await handle.readFile("utf8"));
  } catch (error) {
    if (error instanceof WorkersBuildsProvisioningError) throw error;
    fail(`${label} file is malformed`);
  } finally { await handle.close(); }
}

async function readPrivateFileSha256(path, label,
maximumBytes = maximumPrivateDocumentBytes) {
  if (!isAbsolute(path ?? "")) fail(`${label} file path must be absolute`);
  if (await realpath(path).catch(() => null) !== resolve(path))
    fail(`${label} file path must be canonical without linked ancestors`);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  if (!handle) fail(`${label} file cannot be opened without following links`);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || !isCurrentUserOwned(metadata) ||
        (metadata.mode & 0o077) !== 0 || metadata.size > maximumBytes)
      fail(`${label} file must be a bounded private regular file`);
    return createHash("sha256").update(await handle.readFile()).digest("hex");
  } finally { await handle.close(); }
}

export async function readPinnedIncidentExecutorSha256(path,
expectedSha256 = reviewTokenRotationBlockedDeleteIncident.executorSha256) {
  const actual = await readPrivateFileSha256(path, "blocked delete incident executor",
    maximumPinnedIncidentExecutorBytes);
  if (!/^[0-9a-f]{64}$/u.test(expectedSha256 ?? "") || actual !== expectedSha256)
    fail("blocked delete incident executor digest drift");
  return actual;
}

async function readPrivateJsonLines(path, label) {
  if (!isAbsolute(path ?? "")) fail(`${label} file path must be absolute`);
  if (await realpath(path).catch(() => null) !== resolve(path))
    fail(`${label} file path must be canonical without linked ancestors`);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  if (!handle) fail(`${label} file cannot be opened without following links`);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || !isCurrentUserOwned(metadata) || (metadata.mode & 0o077) !== 0 ||
        metadata.size > maximumPrivateDocumentBytes)
      fail(`${label} file must be a bounded private regular file`);
    const raw = await handle.readFile("utf8");
    if (!raw.endsWith("\n") || raw.length === 1) fail(`${label} is not fully framed`);
    return raw.slice(0, -1).split("\n").map((line) => {
      if (!line) fail(`${label} contains an empty frame`);
      try { return JSON.parse(line); }
      catch { fail(`${label} is malformed`); }
    });
  } finally { await handle.close(); }
}

async function loadProductionSentinelProof(environment = process.env) {
  const productionBranch = await readPrivateValue(
    environment.ATRINIK_PRODUCTION_STAGING_SENTINEL_BRANCH_FILE,
    "production staging sentinel branch", stagingBranchPattern);
  const productionProof = await readPrivateJson(
    environment.ATRINIK_PRODUCTION_STAGING_SENTINEL_REFS_FILE,
    "production staging sentinel refs");
  if (productionProof.branch !== productionBranch)
    fail("production staging sentinel proof branch drift");
  return productionProof;
}

export async function readProductionSentinelProof(environment = process.env, now = Date.now()) {
  const productionProof = await loadProductionSentinelProof(environment);
  validateSentinelRefAbsence(productionProof, now);
  return { productionSentinelProof: productionProof };
}

async function readReviewActivationAuthorityEvidence(environment = process.env) {
  return {
    stagedProof: await readPrivateJson(environment.ATRINIK_STAGED_PROOF_FILE,
      "staged activation proof"),
    repositoryConnectionProof: await readPrivateJson(
      environment.ATRINIK_REPOSITORY_CONNECTION_OWNER_PROOF_FILE,
      "shared repository connection owner proof"),
    productionSentinelProof: await loadProductionSentinelProof(environment),
    tokenAuthorityProofs: [
      await readPrivateJson(environment.ATRINIK_PRODUCTION_BUILD_TOKEN_PERMISSION_PROOF_FILE,
        "production build token permission proof"),
      await readPrivateJson(environment.ATRINIK_REVIEW_BUILD_TOKEN_PERMISSION_PROOF_FILE,
        "review build token permission proof"),
    ],
    buildUsageProof: await readPrivateJson(environment.ATRINIK_WORKERS_BUILDS_USAGE_PROOF_FILE,
      "Workers Builds usage proof"),
  };
}

async function readDisposableReviewAuthorityEvidence(environment = process.env,
{ requireCurrent = true } = {}) {
  return {
    reviewActivationProof: await readPrivateJson(
      environment.ATRINIK_REVIEW_ACTIVATION_PROOF_FILE, "review activation proof"),
    reviewActivationJournal: await readPrivateJsonLines(
      environment.ATRINIK_REVIEW_ACTIVATION_JOURNAL_FILE, "review activation journal"),
    inertSetupJournal: await readPrivateJsonLines(environment.ATRINIK_INERT_SETUP_JOURNAL_FILE,
      "inert setup journal"),
    inertSetupResults: await readPrivateJson(environment.ATRINIK_INERT_SETUP_RESULTS_FILE,
      "inert setup results"),
    disposableCoordinate: await readPrivateJson(
      environment.ATRINIK_DISPOSABLE_REVIEW_COORDINATE_FILE,
      "disposable review coordinate"),
    reviewTokenRotationProof: await readPrivateJson(
      environment.ATRINIK_REVIEW_TOKEN_ROTATION_COMPLETE_PROOF_FILE,
      "terminal review token rotation proof"),
    reviewTokenRotationJournal: await readPrivateJsonLines(
      environment.ATRINIK_REVIEW_TOKEN_ROTATION_JOURNAL_FILE,
      "review token rotation journal"),
    reviewTokenRotationAuthorityProof: await readPrivateJson(
      environment.ATRINIK_REVIEW_TOKEN_ROTATION_AUTHORITY_PROOF_FILE,
      "review token rotation authority proof"),
    reviewTokenRotationPreCreateProof: await readPrivateJson(
      environment.ATRINIK_REVIEW_TOKEN_ROTATION_PRE_CREATE_PROOF_FILE,
      "pre-create review token rotation proof"),
    reviewTokenRotationPreProductionProof: await readPrivateJson(
      environment.ATRINIK_REVIEW_TOKEN_ROTATION_PRE_PRODUCTION_PROOF_FILE,
      "pre-production review token rotation proof"),
    reviewTokenRotationIntermediateProof: await readPrivateJson(
      environment.ATRINIK_REVIEW_TOKEN_ROTATION_INTERMEDIATE_PROOF_FILE,
      "intermediate review token rotation proof"),
    reviewTokenRotationUnreferencedProof: await readPrivateJson(
      environment.ATRINIK_REVIEW_TOKEN_ROTATION_UNREFERENCED_PROOF_FILE,
      "unreferenced review token rotation proof"),
    rotationAttemptCoordinate: await readPrivateJson(
      environment.ATRINIK_REVIEW_TOKEN_ROTATION_ATTEMPT_COORDINATE_FILE,
      "review token rotation attempt coordinate"),
    replacementTokenOwnerMembershipProof: await readPrivateJson(
      environment.ATRINIK_REPLACEMENT_REVIEW_TOKEN_OWNER_MEMBERSHIP_PROOF_FILE,
      "replacement review token owner membership proof"),
    currentReplacementTokenOwnerMembershipProof: await readPrivateJson(
      environment.ATRINIK_CURRENT_REPLACEMENT_REVIEW_TOKEN_OWNER_MEMBERSHIP_PROOF_FILE,
      "current replacement review token owner membership proof"),
    ...(requireCurrent ? { currentReviewActiveProof: await readPrivateJson(
      environment.ATRINIK_CURRENT_REVIEW_ACTIVE_PROOF_FILE, "current review active proof") } : {}),
    repositoryConnectionProof: await readPrivateJson(
      environment.ATRINIK_REPOSITORY_CONNECTION_OWNER_PROOF_FILE,
      "shared repository connection owner proof"),
    productionSentinelProof: await loadProductionSentinelProof(environment),
    tokenAuthorityProofs: [
      await readPrivateJson(environment.ATRINIK_PRODUCTION_BUILD_TOKEN_PERMISSION_PROOF_FILE,
        "production build token permission proof"),
      await readPrivateJson(environment.ATRINIK_REVIEW_BUILD_TOKEN_PERMISSION_PROOF_FILE,
        "review build token permission proof"),
    ],
    buildUsageProof: await readPrivateJson(environment.ATRINIK_WORKERS_BUILDS_USAGE_PROOF_FILE,
      "Workers Builds usage proof"),
  };
}

async function readReviewTokenRotationAuthorityEvidence(environment = process.env,
{ requireCurrent = true, verifyInitialAttempt = false } = {}) {
  const programLedgerPath = environment.ATRINIK_REVIEW_TOKEN_ROTATION_PROGRAM_LEDGER_FILE;
  const attemptCoordinate = await readPrivateJson(
    environment.ATRINIK_REVIEW_TOKEN_ROTATION_ATTEMPT_COORDINATE_FILE,
    "review token rotation attempt coordinate");
  const attemptFilesystemEvidence = verifyInitialAttempt ? {
    executorSha256: await readPrivateFileSha256(
      environment.ATRINIK_REVIEW_TOKEN_ROTATION_EXECUTOR_FILE,
      "review token rotation executor"),
    initialJournalSha256: await readPrivateFileSha256(
      environment.ATRINIK_REVIEW_TOKEN_ROTATION_JOURNAL_FILE,
      "initial review token rotation journal"),
    journalPathSha256: digestText(resolve(
      environment.ATRINIK_REVIEW_TOKEN_ROTATION_JOURNAL_FILE ?? "")),
  } : {
    executorSha256: attemptCoordinate.executorSha256,
    initialJournalSha256: attemptCoordinate.initialJournalSha256,
    journalPathSha256: attemptCoordinate.journalPathSha256,
  };
  const membershipSuccessorInputNames = [
    "ATRINIK_REVIEW_MEMBERSHIP_SUCCESSOR_INCIDENT_PROOF_FILE",
    "ATRINIK_REVIEW_MEMBERSHIP_SUCCESSOR_AUTHORITY_PROOF_FILE",
    "ATRINIK_REVIEW_MEMBERSHIP_SUCCESSOR_JOURNAL_FILE",
    "ATRINIK_REVIEW_MEMBERSHIP_SUCCESSOR_RESULT_PROOF_FILE",
    "ATRINIK_REVIEW_MEMBERSHIP_SUCCESSOR_SNAPSHOT_MANIFEST_FILE",
  ];
  const membershipSuccessorInputCount = membershipSuccessorInputNames
    .filter((name) => environment[name]).length;
  if (membershipSuccessorInputCount !== 0 &&
      membershipSuccessorInputCount !== membershipSuccessorInputNames.length)
    fail("review membership successor private input set is incomplete");
  const membershipSuccessorEvidence = membershipSuccessorInputCount ? {
    incidentProof: await readPrivateJson(
      environment.ATRINIK_REVIEW_MEMBERSHIP_SUCCESSOR_INCIDENT_PROOF_FILE,
      "review membership successor incident proof"),
    membershipRepairAuthorityProof: await readPrivateJson(
      environment.ATRINIK_REVIEW_MEMBERSHIP_SUCCESSOR_AUTHORITY_PROOF_FILE,
      "review membership successor authority proof"),
    membershipRepairAuthorityFileSha256: await readPrivateFileSha256(
      environment.ATRINIK_REVIEW_MEMBERSHIP_SUCCESSOR_AUTHORITY_PROOF_FILE,
      "review membership successor authority proof"),
    membershipRepairJournalRecords: await readPrivateJsonLines(
      environment.ATRINIK_REVIEW_MEMBERSHIP_SUCCESSOR_JOURNAL_FILE,
      "review membership successor journal"),
    membershipRepairJournalFileSha256: await readPrivateFileSha256(
      environment.ATRINIK_REVIEW_MEMBERSHIP_SUCCESSOR_JOURNAL_FILE,
      "review membership successor journal"),
    membershipRepairResultProof: await readPrivateJson(
      environment.ATRINIK_REVIEW_MEMBERSHIP_SUCCESSOR_RESULT_PROOF_FILE,
      "review membership successor result proof"),
    membershipRepairResultProofFileSha256: await readPrivateFileSha256(
      environment.ATRINIK_REVIEW_MEMBERSHIP_SUCCESSOR_RESULT_PROOF_FILE,
      "review membership successor result proof"),
    membershipRepairSnapshotManifestFileSha256: await readPrivateFileSha256(
      environment.ATRINIK_REVIEW_MEMBERSHIP_SUCCESSOR_SNAPSHOT_MANIFEST_FILE,
      "review membership successor snapshot manifest"),
  } : undefined;
  return {
    reviewActivationProof: await readPrivateJson(
      environment.ATRINIK_REVIEW_ACTIVATION_PROOF_FILE, "review activation proof"),
    reviewActivationJournal: await readPrivateJsonLines(
      environment.ATRINIK_REVIEW_ACTIVATION_JOURNAL_FILE, "review activation journal"),
    inertSetupJournal: await readPrivateJsonLines(environment.ATRINIK_INERT_SETUP_JOURNAL_FILE,
      "inert setup journal"),
    inertSetupResults: await readPrivateJson(environment.ATRINIK_INERT_SETUP_RESULTS_FILE,
      "inert setup results"),
    ...(requireCurrent ? {
      currentReviewActiveProof: await readPrivateJson(
        environment.ATRINIK_REVIEW_TOKEN_ROTATION_PREDECESSOR_PROOF_FILE,
        "review token rotation predecessor proof"),
      productionBaselineProof: await readPrivateJson(
        environment.ATRINIK_REVIEW_TOKEN_ROTATION_PRODUCTION_BASELINE_PROOF_FILE,
        "review token rotation production baseline proof"),
    } : {}),
    repositoryConnectionProof: await readPrivateJson(
      environment.ATRINIK_REPOSITORY_CONNECTION_OWNER_PROOF_FILE,
      "shared repository connection owner proof"),
    productionSentinelProof: await loadProductionSentinelProof(environment),
    predecessorTokenAuthorityProofs: [
      await readPrivateJson(environment.ATRINIK_PRODUCTION_BUILD_TOKEN_PERMISSION_PROOF_FILE,
        "production build token permission proof"),
      await readPrivateJson(environment.ATRINIK_REVIEW_BUILD_TOKEN_PERMISSION_PROOF_FILE,
        "predecessor review build token permission proof"),
    ],
    replacementTokenAuthorityProof: await readPrivateJson(
      environment.ATRINIK_REPLACEMENT_REVIEW_BUILD_TOKEN_PERMISSION_PROOF_FILE,
      "replacement review build token permission proof"),
    replacementTokenOwnerMembershipProof: await readPrivateJson(
      environment.ATRINIK_REPLACEMENT_REVIEW_TOKEN_OWNER_MEMBERSHIP_PROOF_FILE,
      "replacement review token owner membership proof"),
    replacementTokenId: await readPrivateValue(
      environment.ATRINIK_REPLACEMENT_REVIEW_BUILD_TOKEN_ID_FILE,
      "replacement review build token ID"),
    replacementTokenSecretSha256: digestText(await readPrivateValue(
      environment.ATRINIK_REPLACEMENT_REVIEW_BUILD_TOKEN_SECRET_FILE,
      "replacement review build token secret")),
    programDeliveryProof: await readPrivateJson(
      environment.ATRINIK_REVIEW_TOKEN_ROTATION_PROGRAM_PROOF_FILE,
      "review token rotation program proof"),
    programLedgerDocument: await readPrivateJson(programLedgerPath,
      "review token rotation program delivery ledger"),
    programLedgerFileSha256: await readPrivateFileSha256(programLedgerPath,
      "review token rotation program delivery ledger"),
    rotationAttemptCoordinate: attemptCoordinate,
    attemptFilesystemEvidence,
    ...(membershipSuccessorEvidence ? { membershipSuccessorEvidence } : {}),
    buildUsageProof: await readPrivateJson(environment.ATRINIK_WORKERS_BUILDS_USAGE_PROOF_FILE,
      "Workers Builds usage proof"),
  };
}

async function readReviewMembershipRepairAuthorityEvidence(environment, sourceSha) {
  const currentMainProof = await readCurrentMainProof(environment, sourceSha);
  return {
    incidentProof: await readPrivateJson(
      environment.ATRINIK_REVIEW_MEMBERSHIP_REPAIR_INCIDENT_PROOF_FILE,
      "review membership repair incident proof"),
    predecessorPolicyProof: await readPrivateJson(
      environment.ATRINIK_REVIEW_MEMBERSHIP_REPAIR_PREDECESSOR_POLICY_PROOF_FILE,
      "review membership repair predecessor policy proof"),
    permissionGroupProof: await readPrivateJson(
      environment.ATRINIK_REVIEW_MEMBERSHIP_REPAIR_PERMISSION_GROUP_PROOF_FILE,
      "review membership repair permission group proof"),
    currentReviewActiveProof: await readPrivateJson(
      environment.ATRINIK_REVIEW_MEMBERSHIP_REPAIR_CURRENT_STATE_PROOF_FILE,
      "review membership repair current state proof"),
    currentMainProofDigest: digestJson(currentMainProof),
  };
}

async function readBlockedReviewTokenDeleteIncident({ production, review, accountId,
  environment = process.env, testCapability = undefined,
  providerNormalizedTestCapability = undefined }) {
  const authorityPath = environment.ATRINIK_REVIEW_TOKEN_ROTATION_AUTHORITY_PROOF_FILE;
  const authorityProof = await readPrivateJson(authorityPath,
    "blocked delete historical review token rotation authority proof");
  const evidence = await readReviewTokenRotationAuthorityEvidence(environment);
  const replacementReviewTokenUuid = await readPrivateValue(
    environment.ATRINIK_REPLACEMENT_REVIEW_BUILD_TOKEN_UUID_FILE,
    "blocked delete replacement review build token UUID", uuidPattern);
  const incidentForwardPath =
    environment.ATRINIK_REVIEW_TOKEN_ROTATION_PROVIDER_NORMALIZED_FORWARD_JOURNAL_FILE;
  const incidentForwardRecords = await readPrivateJsonLines(incidentForwardPath,
    "blocked delete provider-normalized forward journal");
  const incidentProof = await readPrivateJson(
    environment.ATRINIK_REVIEW_TOKEN_ROTATION_PROVIDER_NORMALIZED_INCIDENT_PROOF_FILE,
    "blocked delete provider-normalized incident proof");
  const peerNormalizationProof = await readPrivateJson(
    environment.ATRINIK_REVIEW_TOKEN_ROTATION_PEER_NORMALIZATION_PROOF_FILE,
    "blocked delete peer normalization proof");
  const restoredProof = await readPrivateJson(
    environment.ATRINIK_REVIEW_TOKEN_ROTATION_ROLLBACK_RESTORED_PROOF_FILE,
    "blocked delete predecessor-restored proof");
  const rollbackPath =
    environment.ATRINIK_REVIEW_TOKEN_ROTATION_PROVIDER_NORMALIZED_ROLLBACK_JOURNAL_FILE;
  const rollbackRecords = await readPrivateJsonLines(rollbackPath,
    "blocked delete provider-normalized rollback journal");
  const blockedProof = await readPrivateJson(
    environment.ATRINIK_REVIEW_TOKEN_ROTATION_PROVIDER_NORMALIZED_BLOCKED_PROOF_FILE,
    "blocked delete residual proof");
  const blockedSnapshotDirectory = await readPrivateValue(
    environment.ATRINIK_REVIEW_TOKEN_ROTATION_PROVIDER_NORMALIZED_BLOCKED_SNAPSHOT_DIRECTORY_FILE,
    "blocked delete residual snapshot directory");
  const incidentSnapshotDirectory = await readPrivateValue(
    environment.ATRINIK_REVIEW_TOKEN_ROTATION_PROVIDER_NORMALIZED_INCIDENT_SNAPSHOT_DIRECTORY_FILE,
    "blocked delete provider-normalized incident snapshot directory");
  const validation = await validateReviewTokenRotationBlockedDeleteIncidentCore(
    rollbackRecords, blockedProof, authorityProof, { production, review, accountId,
      sourceSha: blockedDeleteIncidentCoordinate(testCapability).sourceSha,
      executorSha256: await readPinnedIncidentExecutorSha256(
        environment.ATRINIK_REVIEW_TOKEN_ROTATION_PROVIDER_NORMALIZED_EXECUTOR_FILE,
        blockedDeleteIncidentCoordinate(testCapability).executorSha256),
      rollbackJournalSha256: await readPrivateFileSha256(rollbackPath,
        "blocked delete provider-normalized rollback journal"),
      residualSnapshotManifestSha256: await readPrivateFileSha256(
        resolve(blockedSnapshotDirectory, "snapshot-manifest.json"),
        "blocked delete residual snapshot manifest"),
      failedGuardResponseSha256: await readPrivateFileSha256(
        environment.ATRINIK_REVIEW_TOKEN_ROTATION_FAILED_DELETE_GUARD_RESPONSE_FILE,
        "blocked delete failed guard response"), blockedSnapshotDirectory,
      incidentProof, incidentForwardRecords,
      incidentForwardJournalSha256: await readPrivateFileSha256(incidentForwardPath,
        "blocked delete provider-normalized forward journal"),
      incidentSnapshotManifestSha256: await readPrivateFileSha256(resolve(
        incidentSnapshotDirectory, "snapshot-manifest.json"),
      "blocked delete provider-normalized incident manifest"),
      incidentAuthorityFileSha256: await readPrivateFileSha256(authorityPath,
        "blocked delete historical authority"), peerNormalizationProof, restoredProof,
      productionSentinelProof: evidence.productionSentinelProof,
      predecessorTokenAuthorityProofs: evidence.predecessorTokenAuthorityProofs,
      replacementTokenAuthorityProof: evidence.replacementTokenAuthorityProof,
      replacementTokenId: evidence.replacementTokenId,
      productionBaselineProof: evidence.productionBaselineProof,
      providerNormalizedTestCapability }, testCapability);
  if (validation.replacementReviewTokenUuid !== replacementReviewTokenUuid)
    fail("blocked delete replacement UUID file drift");
  return { authorityProof, evidence, incidentProof, peerNormalizationProof, restoredProof,
    rollbackRecords, blockedProof, blockedSnapshotDirectory, validation,
    replacementReviewTokenUuid };
}

async function readAndValidateReviewTokenRotationAuthority({ production, review, accountId,
  sourceSha, environment = process.env,
  minimumRemainingMs = reviewTokenRotationTransitionBudgetMs }) {
  const evidence = await readReviewTokenRotationAuthorityEvidence(environment);
  const proof = await readPrivateJson(
    environment.ATRINIK_REVIEW_TOKEN_ROTATION_AUTHORITY_PROOF_FILE,
    "review token rotation authority proof");
  const tokenRows = {
    production: {
      build_token_uuid: evidence.currentReviewActiveProof.liveIdentities.productionBuildTokenUuid,
      cloudflare_token_id: evidence.predecessorTokenAuthorityProofs
        .find(({ kind }) => kind === "production")?.tokenId,
    },
    review: {
      build_token_uuid: evidence.currentReviewActiveProof.liveIdentities.reviewBuildTokenUuid,
      cloudflare_token_id: evidence.predecessorTokenAuthorityProofs
        .find(({ kind }) => kind === "review")?.tokenId,
    },
  };
  const validation = validateReviewTokenRotationAuthority(proof,
    { production, review, accountId, sourceSha, ...evidence, tokenRows }, Date.now(),
  minimumRemainingMs);
  return { proof, evidence, validation };
}

async function readAndValidateDisposableReviewAuthority({ production, review, accountId,
  sourceSha, environment = process.env,
  minimumRemainingMs = reviewActivationTransitionBudgetMs }) {
  const evidence = await readDisposableReviewAuthorityEvidence(environment);
  const proof = await readPrivateJson(environment.ATRINIK_DISPOSABLE_REVIEW_AUTHORITY_PROOF_FILE,
    "disposable review authority proof");
  const validation = validateDisposableReviewAuthority(proof,
    { production, review, accountId, sourceSha, ...evidence }, Date.now(), minimumRemainingMs);
  return { proof, evidence, validation };
}

async function readAndValidateReviewActivationAuthority({ production, review, accountId,
  sourceSha, environment = process.env, minimumRemainingMs = reviewActivationTransitionBudgetMs }) {
  const evidence = await readReviewActivationAuthorityEvidence(environment);
  const proof = await readPrivateJson(environment.ATRINIK_REVIEW_ACTIVATION_AUTHORITY_PROOF_FILE,
    "review activation authority proof");
  const validation = validateReviewActivationAuthority(proof, {
    production, review, accountId, sourceSha, ...evidence,
  }, Date.now(), minimumRemainingMs);
  return { proof, evidence, validation };
}

export async function readReviewStagingRootProof(proofVariable, expectedPhase,
  environment = process.env, sourceSha, now = Date.now()) {
  const rootDirectory = await readPrivateValue(
    environment.ATRINIK_REVIEW_STAGING_ROOT_DIRECTORY_FILE,
    "review staging root directory", reviewStagingRootPattern);
  const proof = await readPrivateJson(environment[proofVariable],
    "review staging root absence proof");
  return validateReviewStagingRootAbsence(proof, rootDirectory, sourceSha, expectedPhase, now);
}

async function writePrivateJson(path, value) {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT |
    constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.chmod(0o600);
  } finally { await handle.close(); }
}

async function writePrivateProof(path, value) {
  if (!isAbsolute(path ?? "") || resolve(path) !== path)
    fail("private proof output path must be absolute and normalized");
  const parent = dirname(path);
  const metadata = await lstat(parent).catch(() => null);
  if (await realpath(parent).catch(() => null) !== parent || !metadata?.isDirectory() ||
      !isCurrentUserOwned(metadata) || (metadata.mode & 0o077) !== 0)
    fail("private proof output parent must be owner-only and symlink-free");
  await writePrivateJson(path, value);
}

export async function boundedResponseText(response, label) {
  if (!response.body) fail(`${label} returned an empty provider body`);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumProviderResponseBytes) {
        await reader.cancel();
        fail(`${label} exceeded the provider response limit`);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}

async function providerGet({ accountId, token, outputDirectory, fetchImpl = fetch }, label, path) {
  const response = await fetchImpl(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`, {
    method: "GET", redirect: "error",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  let body;
  try { body = JSON.parse(await boundedResponseText(response, label)); }
  catch { fail(`${label} returned non-JSON provider data`); }
  await writePrivateJson(resolve(outputDirectory, `${label}.json`), body);
  if (!response.ok || body.success !== true) fail(`${label} provider readback failed`);
  return body;
}

async function providerPost({ accountId, token, outputDirectory, fetchImpl = fetch }, label, path,
  requestBody) {
  const response = await fetchImpl(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`, {
    method: "POST", redirect: "error",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json",
      "Content-Type": "application/json" },
    body: JSON.stringify(requestBody), signal: AbortSignal.timeout(20_000),
  });
  let body;
  try { body = JSON.parse(await boundedResponseText(response, label)); }
  catch { fail(`${label} returned non-JSON provider data`); }
  await writePrivateJson(resolve(outputDirectory, `${label}.json`), body);
  if (!response.ok || body.success !== true) fail(`${label} provider readback failed`);
  return body;
}

async function providerGetStable(context, label, path) {
  const first = await providerGet(context, `${label}.pass-1`, path);
  const second = await providerGet(context, `${label}.pass-2`, path);
  if (!same(first.result, second.result))
    fail(`${label} provider state changed between complete passes`);
  await writePrivateJson(resolve(context.outputDirectory, `${label}.json`), second);
  context.stableReadbacks.push({ kind: "get", label, path, expected: second.result });
  return second;
}

async function providerPostStable(context, label, path, requestBody, projection = ({ result }) =>
  result) {
  const first = await providerPost(context, `${label}.pass-1`, path, requestBody);
  const second = await providerPost(context, `${label}.pass-2`, path, requestBody);
  if (!same(projection(first), projection(second)))
    fail(`${label} provider state changed between complete passes`);
  await writePrivateJson(resolve(context.outputDirectory, `${label}.json`), second);
  context.stableReadbacks.push({ kind: "post", label, path, requestBody, token: context.token,
    expected: projection(second), projection });
  return second;
}

export function combineProviderPages(envelopes, label, identity) {
  if (!Array.isArray(envelopes) || envelopes.length === 0 ||
      envelopes.length > maximumProviderPages)
    fail(`${label} provider pagination is unbounded`);
  const rows = [];
  const identities = new Set();
  let totalPages;
  let totalCount;
  let perPage;
  for (const [index, envelope] of envelopes.entries()) {
    const pageRows = requireEnvelope(envelope, `${label} page ${index + 1}`);
    const info = envelope.result_info ?? {};
    if (!Array.isArray(pageRows) || !Number.isSafeInteger(info.page) ||
        !Number.isSafeInteger(info.total_pages) || !Number.isSafeInteger(info.total_count) ||
        info.page !== index + 1 || info.total_pages < 1 ||
        info.total_pages > maximumProviderPages || info.total_count < 0)
      fail(`${label} provider pagination metadata is malformed`);
    totalPages ??= info.total_pages;
    totalCount ??= info.total_count;
    if (info.per_page !== undefined) {
      if (!Number.isSafeInteger(info.per_page) || info.per_page < 1 ||
          (perPage !== undefined && info.per_page !== perPage))
        fail(`${label} provider pagination changed during readback`);
      perPage ??= info.per_page;
    }
    if (info.count !== undefined &&
        (!Number.isSafeInteger(info.count) || info.count !== pageRows.length))
      fail(`${label} provider pagination metadata is malformed`);
    if (info.total_pages !== totalPages || info.total_count !== totalCount ||
        envelopes.length !== totalPages)
      fail(`${label} provider pagination changed during readback`);
    for (const row of pageRows) {
      const key = identity(row);
      if (typeof key !== "string" || key.length === 0 || identities.has(key))
        fail(`${label} provider pagination identity is missing or duplicated`);
      identities.add(key);
      rows.push(row);
    }
  }
  if (rows.length !== totalCount) fail(`${label} provider pagination count drift`);
  return { success: true, result: rows, result_info: {
    page: 1, total_pages: 1, total_count: rows.length, exhaustive: true,
    source_total_pages: totalPages,
  } };
}

export function normalizeBuildsListPage(envelope, label, page) {
  const rows = requireEnvelope(envelope, label);
  if (envelope.result_info !== undefined) {
    const info = envelope.result_info;
    if (info?.total_pages !== 0) return envelope;
    const zeroPageKeys = ["count", "next_page", "page", "per_page", "total_count",
      "total_pages"];
    if (page !== 1 || rows.length !== 0 || !info ||
        !same(sorted(Object.keys(info)), zeroPageKeys) || info.page !== 1 ||
        !Number.isSafeInteger(info.per_page) || info.per_page < 1 || info.count !== 0 ||
        info.total_count !== 0 || info.next_page !== false)
      fail(`${label} provider Builds pagination metadata is malformed`);
    return { ...envelope,
      result_info: { page: 1, total_pages: 1, total_count: 0 } };
  }
  if (page !== 1 || rows.length !== 0)
    fail(`${label} provider Builds pagination metadata is malformed`);
  return { ...envelope, result_info: { page: 1, total_pages: 1, total_count: 0 } };
}

export function normalizeTriggerListPage(envelope, label, page,
  maximumTriggersPerWorker) {
  const rows = requireEnvelope(envelope, label);
  if (maximumTriggersPerWorker !== 2)
    fail(`${label} provider trigger pagination metadata is malformed`);
  if (envelope.result_info !== undefined) {
    const normalized = normalizeBuildsListPage(envelope, label, page);
    if (Number.isSafeInteger(normalized.result_info?.total_count) &&
        normalized.result_info.total_count > maximumTriggersPerWorker)
      fail(`${label} provider trigger pagination metadata is malformed`);
    return normalized;
  }
  const envelopeKeys = ["errors", "messages", "result", "success"];
  if (page !== 1 ||
      !same(sorted(Object.keys(envelope)), envelopeKeys) ||
      !Array.isArray(envelope.errors) || !Array.isArray(envelope.messages) ||
      !Array.isArray(rows) || rows.length > maximumTriggersPerWorker)
    fail(`${label} provider trigger pagination metadata is malformed`);
  return { ...envelope, result_info: {
    page: 1, total_pages: 1, total_count: rows.length,
  } };
}

export function normalizeDomainListPage(envelope, label, page) {
  const rows = requireEnvelope(envelope, label);
  const info = envelope.result_info;
  const keysWithoutTotalPages = ["count", "page", "per_page", "total_count"];
  const keysWithTotalPages = [...keysWithoutTotalPages, "total_pages"];
  if (!Array.isArray(rows) || !info ||
      (!same(sorted(Object.keys(info)), keysWithoutTotalPages) &&
       !same(sorted(Object.keys(info)), keysWithTotalPages)) ||
      !Number.isSafeInteger(info.page) || !Number.isSafeInteger(info.count) ||
      !Number.isSafeInteger(info.per_page) || !Number.isSafeInteger(info.total_count) ||
      info.page !== page || info.page < 1 || info.count < 0 || info.per_page < 1 ||
      info.total_count < 0 || info.count !== rows.length)
    fail(`${label} provider domain pagination metadata is malformed`);
  const derivedTotalPages = Math.max(1, Math.ceil(info.total_count / info.per_page));
  const expectedCount = info.page < derivedTotalPages
    ? info.per_page
    : info.total_count - (info.per_page * (derivedTotalPages - 1));
  if (info.page > derivedTotalPages || info.count > info.per_page ||
      info.count !== expectedCount ||
      (info.total_pages !== undefined &&
       (!Number.isSafeInteger(info.total_pages) || info.total_pages !== derivedTotalPages)))
    fail(`${label} provider domain pagination metadata is malformed`);
  return { ...envelope, result_info: { ...info, total_pages: derivedTotalPages } };
}

function normalizeWorkerVersionPage(envelope, label) {
  const result = requireEnvelope(envelope, label);
  const info = envelope.result_info ?? {};
  if (!result || !Array.isArray(result.items) || !Number.isSafeInteger(info.page) ||
      !Number.isSafeInteger(info.count) || !Number.isSafeInteger(info.per_page) ||
      !Number.isSafeInteger(info.total_count) || info.page < 1 || info.count < 0 ||
      info.per_page < 1 || info.total_count < 0 || info.count !== result.items.length)
    fail(`${label} provider version pagination metadata is malformed`);
  const derivedTotalPages = Math.max(1, Math.ceil(info.total_count / info.per_page));
  const expectedCount = info.page < derivedTotalPages
    ? info.per_page
    : info.total_count - (info.per_page * (derivedTotalPages - 1));
  if (info.page > derivedTotalPages ||
      info.count > info.per_page || info.count !== expectedCount ||
      (info.total_pages !== undefined &&
       (!Number.isSafeInteger(info.total_pages) || info.total_pages !== derivedTotalPages)))
    fail(`${label} provider version pagination metadata is malformed`);
  return { ...envelope, result_info: { ...info, total_pages: derivedTotalPages } };
}

export function combineWorkerVersionPages(envelopes, label = "Worker versions") {
  if (!Array.isArray(envelopes)) fail(`${label} provider pagination is unbounded`);
  let perPage;
  return combineProviderPages(envelopes.map((rawEnvelope, index) => {
    const envelope = normalizeWorkerVersionPage(rawEnvelope, `${label} page ${index + 1}`);
    const result = requireEnvelope(envelope, `${label} page ${index + 1}`);
    perPage ??= envelope.result_info.per_page;
    if (envelope.result_info.per_page !== perPage)
      fail(`${label} provider version pagination metadata changed during readback`);
    return { ...envelope, result: result.items };
  }), label, ({ id }) => id);
}

export function validateStableProviderPasses(first, second, label) {
  const firstRows = requireExhaustiveEnvelope(first, `${label} first pass`);
  const secondRows = requireExhaustiveEnvelope(second, `${label} second pass`);
  if (!same(firstRows, secondRows))
    fail(`${label} provider inventory changed between complete passes`);
  return second;
}

async function providerGetPaginatedPass(context, label, path, identity, perPage,
  normalizePage = (envelope) => envelope) {
  const pages = [];
  for (let page = 1; page <= maximumProviderPages; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const pageLabel = `${label}.page-${page}`;
    const envelope = normalizePage(await providerGet(context, pageLabel,
      `${path}${separator}page=${page}&per_page=${perPage}`), pageLabel, page);
    pages.push(envelope);
    const totalPages = envelope.result_info?.total_pages;
    if (!Number.isSafeInteger(totalPages) || totalPages < 1 ||
        totalPages > maximumProviderPages)
      fail(`${label} provider pagination metadata is malformed`);
    if (page === totalPages) {
      return combineProviderPages(pages, label, identity);
    }
    if (page > totalPages) fail(`${label} provider pagination changed during readback`);
  }
  fail(`${label} provider pagination exceeded its bound`);
}

async function providerGetPaginated(context, label, path, identity, perPage = 50,
  normalizePage = (envelope) => envelope) {
  const first = await providerGetPaginatedPass(context, `${label}.pass-1`, path, identity,
    perPage, normalizePage);
  const second = await providerGetPaginatedPass(context, `${label}.pass-2`, path, identity,
    perPage, normalizePage);
  validateStableProviderPasses(first, second, label);
  await writePrivateJson(resolve(context.outputDirectory, `${label}.json`), second);
  context.stableReadbacks.push({ kind: "paginated", label, path, identity, perPage,
    normalizePage, expected: second.result });
  return second;
}

async function providerGetBuildsList(context, label, path, identity, perPage = 50) {
  return providerGetPaginated(context, label, path, identity, perPage,
    normalizeBuildsListPage);
}

async function providerGetTriggerList(context, label, path, identity,
  maximumTriggersPerWorker, perPage = 50) {
  if (!/^\/builds\/workers\/[^/?]+\/triggers$/u.test(path))
    fail(`${label} is not a per-Worker trigger inventory`);
  return providerGetPaginated(context, label, path, identity, perPage,
    (envelope, pageLabel, page) => normalizeTriggerListPage(
      envelope, pageLabel, page, maximumTriggersPerWorker));
}

async function providerGetWorkerVersionsPass(context, label, path, perPage) {
  const pages = [];
  for (let page = 1; page <= maximumProviderPages; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const envelope = normalizeWorkerVersionPage(await providerGet(context,
      `${label}.page-${page}`, `${path}${separator}page=${page}&per_page=${perPage}`),
    `${label} page ${page}`);
    pages.push(envelope);
    const totalPages = envelope.result_info?.total_pages;
    if (!Number.isSafeInteger(totalPages) || totalPages < 1 ||
        totalPages > maximumProviderPages)
      fail(`${label} provider pagination metadata is malformed`);
    if (page === totalPages) {
      return combineWorkerVersionPages(pages, label);
    }
    if (page > totalPages) fail(`${label} provider pagination changed during readback`);
  }
  fail(`${label} provider pagination exceeded its bound`);
}

async function providerGetWorkerVersions(context, label, path, perPage = 50) {
  const first = await providerGetWorkerVersionsPass(context, `${label}.pass-1`, path, perPage);
  const second = await providerGetWorkerVersionsPass(context, `${label}.pass-2`, path, perPage);
  validateStableProviderPasses(first, second, label);
  await writePrivateJson(resolve(context.outputDirectory, `${label}.json`), second);
  context.stableReadbacks.push({ kind: "versions", label, path, perPage,
    expected: second.result });
  return second;
}

async function verifyCompleteProviderSweep(context) {
  const readbacks = [...context.stableReadbacks];
  for (const item of readbacks) {
    let actual;
    if (item.kind === "get")
      actual = (await providerGet(context, `${item.label}.sweep-final`, item.path)).result;
    else if (item.kind === "post")
      actual = item.projection(await providerPost({ ...context, token: item.token },
        `${item.label}.sweep-final`,
        item.path, item.requestBody));
    else if (item.kind === "paginated")
      actual = (await providerGetPaginatedPass(context, `${item.label}.sweep-final`,
        item.path, item.identity, item.perPage, item.normalizePage)).result;
    else if (item.kind === "versions")
      actual = (await providerGetWorkerVersionsPass(context, `${item.label}.sweep-final`,
        item.path, item.perPage)).result;
    else fail("provider sweep readback kind is malformed");
    if (!same(item.expected, actual))
      fail(`${item.label} changed between complete provider sweeps`);
  }
}

export async function readProviderSnapshot({ accountId, token, productionReadToken,
  outputDirectory, production, review, sourceSha, fetchImpl = fetch }) {
  const startedAt = new Date().toISOString();
  await createPrivateDirectory(outputDirectory);
  const context = { accountId, token, outputDirectory, stableReadbacks: [], fetchImpl };
  const scriptsFirst = await providerGet(context, "scripts.pass-1", "/workers/scripts");
  const scripts = await providerGet(context, "scripts.pass-2", "/workers/scripts");
  if (!same(scriptsFirst.result, scripts.result))
    fail("account Worker inventory changed between complete passes");
  await writePrivateJson(resolve(outputDirectory, "scripts.json"), scripts);
  context.stableReadbacks.push({ kind: "get", label: "scripts", path: "/workers/scripts",
    expected: scripts.result });
  const scriptRows = requireEnvelope(scripts, "scripts");
  if (!Array.isArray(scriptRows) || scriptRows.length > 1000)
    fail("account Worker inventory is invalid or unbounded");
  const reviewPersistentWorkerCount = validateRetiredReviewWorkerAbsent(
    scriptRows, review, "provider Worker inventory");
  const names = [...new Set(production.workers.map(({ name }) => name))];
  let productionDatabaseId;
  for (const name of names) {
    const script = (scripts.result ?? []).find(({ id }) => id === name);
    if (!script) {
      fail(`required production Worker ${name} is absent`);
    }
    if (!scriptTagPattern.test(script.tag ?? "")) fail(`${name} script tag is malformed`);
    const settings = await providerGetStable(context, `${name}.settings`,
      `/workers/scripts/${encodeURIComponent(name)}/settings`);
    if (name === production.workers[0].name) {
      const database = (settings.result?.bindings ?? []).filter(({ name: binding, type }) =>
        binding === "DB" && type === "d1");
      if (database.length !== 1 || !uuidPattern.test(database[0].id ?? database[0].database_id ?? ""))
        fail("production D1 binding is missing or ambiguous");
      productionDatabaseId = database[0].id ?? database[0].database_id;
    }
    await providerGetStable(context, `${name}.subdomain`,
      `/workers/scripts/${encodeURIComponent(name)}/subdomain`);
    await providerGetStable(context, `${name}.schedules`,
      `/workers/scripts/${encodeURIComponent(name)}/schedules`);
    await providerGetStable(context, `${name}.routes`,
      `/workers/services/${encodeURIComponent(name)}/environments/production/routes?show_zonename=true`);
    await providerGetStable(context, `${name}.script-settings`,
      `/workers/scripts/${encodeURIComponent(name)}/script-settings`);
    const deployments = await providerGetStable(context, `${name}.deployments`,
      `/workers/scripts/${encodeURIComponent(name)}/deployments`);
    const deploymentRows = deployments.result?.deployments;
    const activeVersions = deploymentRows?.[0]?.versions ?? [];
    if (!Array.isArray(deploymentRows) || deploymentRows.length === 0 ||
        activeVersions.length !== 1 || activeVersions[0].percentage !== 100 ||
        !uuidPattern.test(activeVersions[0].version_id ?? ""))
      fail(`${name} does not have one unambiguous active version`);
    await providerGetStable(context, `${name}.active-version`,
      `/workers/scripts/${encodeURIComponent(name)}/versions/${encodeURIComponent(activeVersions[0].version_id)}`);
    const deploymentsFinal = await providerGetStable(context, `${name}.deployments-final`,
      `/workers/scripts/${encodeURIComponent(name)}/deployments`);
    if (!same(deployments.result, deploymentsFinal.result))
      fail(`${name} active deployment changed during version readback`);
    await providerGetWorkerVersions(context, `${name}.versions`,
      `/workers/scripts/${encodeURIComponent(name)}/versions`);
    await providerGetBuildsList(context, `${name}.deploy-hooks`,
      `/builds/workers/${encodeURIComponent(name)}/deploy_hooks`,
      ({ deploy_hook_uuid: id }) => id);
    const triggers = await providerGetTriggerList(context, `${name}.triggers`,
      `/builds/workers/${encodeURIComponent(script.tag)}/triggers`,
      ({ trigger_uuid: id }) => id,
      review.automaticReview.providerTopology.maximumTriggersPerWorker);
    await providerGetBuildsList(context, `${name}.builds`,
      `/builds/workers/${encodeURIComponent(script.tag)}/builds`,
      ({ build_uuid: id }) => id, 200);
    for (const trigger of triggers.result ?? []) {
      if (!uuidPattern.test(trigger.trigger_uuid ?? "")) fail(`${name} trigger UUID is malformed`);
      await providerGetStable(context,
        `${name}.trigger-${trigger.trigger_uuid}.environment`,
        `/builds/triggers/${encodeURIComponent(trigger.trigger_uuid)}/environment_variables`);
    }
  }
  const collectAccountTriggers = async (pass) => {
    const rows = [];
    for (const [index, script] of scriptRows.entries()) {
      if (!scriptTagPattern.test(script.tag ?? "")) fail("account Worker tag is malformed");
      const triggerInventory = await providerGetTriggerList(context,
        `account-trigger-pass-${pass}-script-${index}`,
        `/builds/workers/${encodeURIComponent(script.tag)}/triggers`,
        ({ trigger_uuid: id }) => id,
        review.automaticReview.providerTopology.maximumTriggersPerWorker);
      rows.push(...triggerInventory.result);
    }
    return combineProviderPages([{
      success: true, result: rows,
      result_info: { page: 1, total_pages: 1, total_count: rows.length },
    }], `account triggers pass ${pass}`, ({ trigger_uuid: id }) => id);
  };
  const accountTriggersFirst = await collectAccountTriggers(1);
  const accountTriggers = await collectAccountTriggers(2);
  validateStableProviderPasses(accountTriggersFirst, accountTriggers, "account triggers");
  const scriptsFinal = await providerGet(context, "scripts.pass-final", "/workers/scripts");
  if (!same(scripts.result, scriptsFinal.result))
    fail("account Worker inventory changed during trigger aggregation");
  await writePrivateJson(resolve(outputDirectory, "account-triggers.json"), accountTriggers);
  await providerGetPaginated(context, "domains", "/workers/domains",
    ({ hostname, service }) => `${hostname}\0${service}`, 50, normalizeDomainListPage);
  await providerGetBuildsList(context, "build-tokens", "/builds/tokens",
    ({ build_token_uuid: id }) => id);
  await providerGetStable(context, "build-limits", "/builds/account/limits");
  if (!productionDatabaseId) fail("production D1 database identity is unavailable");
  await providerPostStable({ ...context, token: productionReadToken },
    "production-migrations", `/d1/database/${encodeURIComponent(productionDatabaseId)}/query`,
    { sql: "SELECT id, name FROM d1_migrations ORDER BY id", params: [] },
    ({ result }) => result?.map(({ results }) => results));
  await verifyCompleteProviderSweep(context);
  await writePrivateJson(resolve(outputDirectory, "snapshot-manifest.json"), {
    accountId, sourceSha, startedAt, completedAt: new Date().toISOString(),
    productionContractSha256: digestJson(production), reviewContractSha256: digestJson(review),
  });
  return { outcome: "workers-builds-private-readback-complete", mutation: false,
    productionWorkers: production.workers.length,
    reviewPersistentWorkerCount };
}

export async function loadSnapshot(directory, name) {
  if (!isAbsolute(directory ?? "")) fail("private snapshot directory must be absolute");
  if (resolve(directory) !== directory || await realpath(directory).catch(() => null) !== directory)
    fail("private snapshot directory must be canonical and symlink-free");
  const metadata = await lstat(directory).catch(() => null);
  if (!metadata?.isDirectory() || !isCurrentUserOwned(metadata) ||
      (metadata.mode & 0o077) !== 0)
    fail("private snapshot directory must be private");
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/u.test(name))
    fail("private snapshot name must be a safe JSON basename");
  const path = resolve(directory, name);
  if (dirname(path) !== directory) fail("private snapshot escaped its directory");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  if (!handle) fail(`private snapshot ${name} is missing or linked`);
  try {
    const file = await handle.stat();
    if (!file.isFile() || !isCurrentUserOwned(file) ||
        (file.mode & 0o077) !== 0 || file.size > maximumProviderResponseBytes)
      fail(`private snapshot ${name} is not a bounded private regular file`);
    return JSON.parse(await handle.readFile("utf8"));
  } catch (error) {
    if (error instanceof WorkersBuildsProvisioningError) throw error;
    fail(`private snapshot ${name} is missing or malformed`);
  } finally { await handle.close(); }
}

async function materializeSnapshot({ snapshotDirectory, outputDirectory, accountId,
  production, review, bases, sourceSha }) {
  validateSnapshotManifest(await loadSnapshot(snapshotDirectory, "snapshot-manifest.json"),
    { accountId, sourceSha, production, review });
  const snapshots = await Promise.all(production.workers.map(async ({ name }) => ({
    settings: await loadSnapshot(snapshotDirectory, `${name}.settings.json`),
    subdomain: await loadSnapshot(snapshotDirectory, `${name}.subdomain.json`),
    schedules: await loadSnapshot(snapshotDirectory, `${name}.schedules.json`),
    routes: await loadSnapshot(snapshotDirectory, `${name}.routes.json`),
    scriptSettings: await loadSnapshot(snapshotDirectory, `${name}.script-settings.json`),
  })));
  const domains = await loadSnapshot(snapshotDirectory, "domains.json");
  const projects = production.workers.map(({ role, name }) => [role, name]);
  const bootstrap = validateInitialBootstrapSnapshot({
    production,
    review,
    scripts: await loadSnapshot(snapshotDirectory, "scripts.json"),
    triggers: await Promise.all(projects.map(async ([role, name]) =>
      [role, await loadSnapshot(snapshotDirectory, `${name}.triggers.json`)])),
    deployHooks: await Promise.all(projects.map(async ([role, name]) =>
      [role, await loadSnapshot(snapshotDirectory, `${name}.deploy-hooks.json`)])),
    builds: await Promise.all(projects.map(async ([role, name]) =>
      [role, await loadSnapshot(snapshotDirectory, `${name}.builds.json`)])),
    buildTokens: await loadSnapshot(snapshotDirectory, "build-tokens.json"),
    accountTriggers: await loadSnapshot(snapshotDirectory, "account-triggers.json"),
  });
  const configurations = materializeProductionConfigurations({
    contract: production, bases, snapshots, accountId, initialBootstrapPredecessor: true,
  });
  validateProductionControlPlane({ contract: production, configurations, snapshots, domains });
  const deployments = await Promise.all(production.workers.map(({ name }) =>
    loadSnapshot(snapshotDirectory, `${name}.deployments.json`)));
  const activeVersions = await Promise.all(production.workers.map(({ name }) =>
    loadSnapshot(snapshotDirectory, `${name}.active-version.json`)));
  const migrationEnvelope = await loadSnapshot(snapshotDirectory, "production-migrations.json");
  const migrationNames = (await readdir(resolve(root, "migrations")))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort();
  const runtime = validateProductionRuntimeProof({ contract: production, configurations,
    liveConfigurations: production.workers.map((worker, index) =>
      initialBootstrapPredecessorConfiguration(production, configurations[index], worker)),
    deployments, activeVersions, migrationEnvelope, migrationNames });
  await createPrivateDirectory(outputDirectory);
  const results = [];
  for (const [index, worker] of production.workers.entries()) {
    const bytes = Buffer.byteLength(JSON.stringify(configurations[index]));
    await writePrivateJson(resolve(outputDirectory, `${worker.role}.json`), configurations[index]);
    results.push({ role: worker.role, bytes });
  }
  return { outcome: "production-protected-documents-materialized", mutation: false, results,
    bootstrap, runtime };
}

async function validateConfiguredSnapshotDirectory({ snapshotDirectory, production, review,
  accountId, tokenAuthorityProofs, sourceSha }) {
  validateSnapshotManifest(await loadSnapshot(snapshotDirectory, "snapshot-manifest.json"),
    { accountId, sourceSha, production, review });
  const [core, publisher, rendezvous] = production.workers;
  const reviewProject = review.automaticReview.project;
  const scripts = await loadSnapshot(snapshotDirectory, "scripts.json");
  const buildTokens = await loadSnapshot(snapshotDirectory, "build-tokens.json");
  const productionTriggers = await loadSnapshot(snapshotDirectory, `${core.name}.triggers.json`);
  const reviewTriggers = productionTriggers;
  const rows = requireEnvelope(productionTriggers, "shared core triggers");
  if (!Array.isArray(rows) || rows.length !== 2)
    fail("configured core trigger inventory is not exactly two");
  for (const trigger of rows)
    if (!uuidPattern.test(trigger.trigger_uuid ?? "")) fail("configured trigger UUID is malformed");
  const productionRows = rows.filter(({ trigger_name: name }) =>
    name === "Atrinik automatic production main");
  const reviewRows = rows.filter(({ trigger_name: name }) => name === "Atrinik build-only review");
  if (productionRows.length !== 1 || reviewRows.length !== 1)
    fail("configured production/preview trigger roles are missing or ambiguous");
  const productionEnvironment = await loadSnapshot(snapshotDirectory,
    `${core.name}.trigger-${productionRows[0].trigger_uuid}.environment.json`);
  const reviewEnvironment = await loadSnapshot(snapshotDirectory,
    `${reviewProject}.trigger-${reviewRows[0].trigger_uuid}.environment.json`);
  const nonEntrypointTriggers = await Promise.all([publisher, rendezvous].map(async (worker) => [
    worker.role,
    await loadSnapshot(snapshotDirectory, `${worker.name}.triggers.json`),
  ]));
  const deployHooks = await Promise.all(production.workers.map(({ role, name }) =>
    [role, name]).map(async ([label, name]) => [
    label,
    await loadSnapshot(snapshotDirectory, `${name}.deploy-hooks.json`),
  ]));
  const accountTriggers = await loadSnapshot(snapshotDirectory, "account-triggers.json");
  const reviewBuildState = {
    builds: await loadSnapshot(snapshotDirectory, `${reviewProject}.builds.json`),
    buildLimits: await loadSnapshot(snapshotDirectory, "build-limits.json"),
    buildUsageProof: await readPrivateJson(process.env.ATRINIK_WORKERS_BUILDS_USAGE_PROOF_FILE,
      "Workers Builds usage proof"),
  };
  return validateConfiguredBuildsSnapshot({
    production, review, scripts, productionTriggers, productionEnvironment,
    reviewTriggers, reviewEnvironment, nonEntrypointTriggers, deployHooks, buildTokens,
    accountTriggers, reviewBuildState,
    accountId, tokenAuthorityProofs, sourceSha,
  });
}

async function validateStagedSnapshotDirectory({ snapshotDirectory, production, review,
  accountId, tokenAuthorityProofs, sourceSha },
{ reviewActive = false, requireReviewResult = reviewActive,
  authorityRequired = reviewActive && !requireReviewResult,
  includeLiveIdentities = false,
  reviewTokenName = reviewBuildTokenNames.current,
  reviewResultProof = undefined, reviewActivationAuthorityProof = undefined,
  reviewActivationAuthorityEvidence = undefined,
  reviewActivationAuthorityCheckpoint = undefined } = {}) {
  const snapshotManifest = await loadSnapshot(snapshotDirectory, "snapshot-manifest.json");
  validateSnapshotManifest(snapshotManifest, { accountId, sourceSha, production, review });
  const core = production.workers[0];
  const reviewProject = review.automaticReview.project;
  const scripts = await loadSnapshot(snapshotDirectory, "scripts.json");
  const buildTokens = await loadSnapshot(snapshotDirectory, "build-tokens.json");
  const productionTriggers = await loadSnapshot(snapshotDirectory, `${core.name}.triggers.json`);
  const reviewTriggers = productionTriggers;
  const rows = requireExhaustiveEnvelope(productionTriggers, "staged shared core triggers");
  const expectedTriggerCount = reviewActive ? 2 : 1;
  if (rows.length !== expectedTriggerCount)
    fail(`staged core trigger inventory is not exactly ${expectedTriggerCount}`);
  for (const trigger of rows)
    if (!uuidPattern.test(trigger.trigger_uuid ?? "")) fail("staged trigger UUID is malformed");
  const productionRows = rows.filter(({ trigger_name: name }) =>
    name === "Atrinik automatic production main");
  const reviewRows = rows.filter(({ trigger_name: name }) => name === "Atrinik build-only review");
  if (productionRows.length !== 1 || reviewRows.length !== (reviewActive ? 1 : 0))
    fail("staged production/preview trigger phase is missing or ambiguous");
  const productionEnvironment = await loadSnapshot(snapshotDirectory,
    `${core.name}.trigger-${productionRows[0].trigger_uuid}.environment.json`);
  const reviewEnvironment = reviewActive ? await loadSnapshot(snapshotDirectory,
    `${reviewProject}.trigger-${reviewRows[0].trigger_uuid}.environment.json`) : undefined;
  const deployHooks = await Promise.all(production.workers.map(({ role, name }) =>
    [role, name]).map(async ([label, name]) =>
    [label, await loadSnapshot(snapshotDirectory, `${name}.deploy-hooks.json`)]));
  const builds = await Promise.all(production.workers.map(({ role, name }) => [role, name])
    .map(async ([label, name]) =>
      [label, await loadSnapshot(snapshotDirectory, `${name}.builds.json`)]));
  const nonEntrypointTriggers = await Promise.all(production.workers.slice(1)
    .map(async ({ role, name }) =>
      [role, await loadSnapshot(snapshotDirectory, `${name}.triggers.json`)]));
  const reviewBuildState = {
    builds: await loadSnapshot(snapshotDirectory, `${reviewProject}.builds.json`),
    buildLimits: await loadSnapshot(snapshotDirectory, "build-limits.json"),
    buildUsageProof: await readPrivateJson(process.env.ATRINIK_WORKERS_BUILDS_USAGE_PROOF_FILE,
      "Workers Builds usage proof"),
  };
  const productionSentinelProof = reviewActivationAuthorityEvidence?.productionSentinelProof ??
    (await readProductionSentinelProof()).productionSentinelProof;
  const arguments_ = { production, review, scripts, productionTriggers,
    productionEnvironment, reviewTriggers, reviewEnvironment, nonEntrypointTriggers,
    deployHooks, builds, buildTokens,
    accountTriggers: await loadSnapshot(snapshotDirectory, "account-triggers.json"),
    reviewBuildState, accountId, tokenAuthorityProofs, sourceSha,
    productionSentinelProof, snapshotManifest, reviewResultProof,
    reviewActivationAuthorityProof, reviewActivationAuthorityEvidence,
    reviewActivationAuthorityCheckpoint };
  if (!reviewActive) return validateStagedBuildsSnapshot(arguments_);
  if (requireReviewResult) return validateProductionActivationSnapshot(arguments_);
  return authorityRequired ? validateReviewActivationSnapshot(arguments_) :
    validateActivationSnapshot(arguments_, { reviewActive: true, requireReviewResult: false,
      authorityRequired: false, includeLiveIdentities, reviewTokenName });
}

export async function snapshotProductionPreservationDigest(snapshotDirectory, production) {
  const names = ["scripts.json", "domains.json", "production-migrations.json"];
  for (const { name } of production.workers) names.push(
    `${name}.settings.json`, `${name}.subdomain.json`, `${name}.schedules.json`,
    `${name}.routes.json`, `${name}.script-settings.json`, `${name}.deployments.json`,
    `${name}.deployments-final.json`, `${name}.active-version.json`, `${name}.versions.json`,
    `${name}.deploy-hooks.json`);
  const documents = {};
  for (const name of names) {
    const value = structuredClone(await loadSnapshot(snapshotDirectory, name));
    if (name === "production-migrations.json") {
      for (const row of value?.result ?? []) {
        if (row?.meta && typeof row.meta === "object") {
          delete row.meta.duration;
          if (row.meta.timings && typeof row.meta.timings === "object")
            delete row.meta.timings.sql_duration_ms;
        }
      }
    }
    documents[name] = value;
  }
  return digestJson(canonical(documents));
}

export async function validateReviewTokenRotationSnapshotDirectory({ snapshotDirectory,
  production, review, accountId, sourceSha, phase, productionSentinelProof,
  predecessorTokenAuthorityProofs, replacementTokenAuthorityProof, replacementTokenId,
  productionTriggerUuid, reviewTriggerUuid, predecessorReviewTokenUuid,
  replacementReviewTokenUuid, productionPreservationDigest, authorityProof,
  productionBaselineProof, authoritySourceSha = authorityProof?.sourceSha,
  authorityPlanDigest = authorityProof?.planDigest, now = Date.now() }) {
  validateHistoricalReviewTokenRotationAuthority(authorityProof, { production, review,
    accountId, sourceSha: authoritySourceSha, planDigest: authorityPlanDigest });
  const proofValidationTime = Date.parse(authorityProof?.capturedAt ?? "");
  if (!Number.isFinite(proofValidationTime) ||
      authorityProof?.evidenceDigests?.productionSentinel !==
        digestJson(productionSentinelProof) ||
      authorityProof?.evidenceDigests?.replacementTokenAuthority !==
        digestJson(replacementTokenAuthorityProof) ||
      authorityProof?.evidenceDigests?.productionBaseline !==
        digestJson(productionBaselineProof) ||
      !same(authorityProof?.evidenceDigests?.predecessorTokenAuthority,
        Object.fromEntries(predecessorTokenAuthorityProofs.map((proof) =>
          [proof.kind, digestJson(proof)]))))
    fail("review token rotation authority evidence drift");
  validateReviewTokenRotationProductionBaselineProof(productionBaselineProof,
    { accountId, sourceSha: authoritySourceSha,
      currentReviewActiveProof: { proof_digest:
        productionBaselineProof?.currentReviewActiveProofDigest } }, proofValidationTime);
  if (productionBaselineProof.productionPreservationDigest !== productionPreservationDigest ||
      productionBaselineProof.productionScriptTag !== authorityProof.productionScriptTag)
    fail("review token rotation production baseline authority drift");
  const manifest = await loadSnapshot(snapshotDirectory, "snapshot-manifest.json");
  validateSnapshotManifest(manifest, { accountId, sourceSha, production, review }, now);
  const currentPreservationDigest = await snapshotProductionPreservationDigest(
    snapshotDirectory, production);
  if (currentPreservationDigest !== productionPreservationDigest)
    fail("review token rotation production resource preservation drift");
  validateSentinelRefAbsence(productionSentinelProof, proofValidationTime);
  const core = production.workers[0];
  const scripts = requireEnvelope(await loadSnapshot(snapshotDirectory, "scripts.json"),
    "review token rotation scripts");
  const script = scripts.filter(({ id }) => id === core.name);
  if (script.length !== 1 || !scriptTagPattern.test(script[0].tag ?? ""))
    fail("review token rotation core script is missing or ambiguous");
  const triggerEnvelope = await loadSnapshot(snapshotDirectory, `${core.name}.triggers.json`);
  const triggerRows = requireExhaustiveEnvelope(triggerEnvelope,
    "review token rotation core triggers");
  const productionRows = triggerRows.filter(({ trigger_uuid: id }) => id === productionTriggerUuid);
  const reviewRows = triggerRows.filter(({ trigger_uuid: id }) => id === reviewTriggerUuid);
  if (triggerRows.length !== 2 || productionRows.length !== 1 || reviewRows.length !== 1)
    fail("review token rotation journaled trigger inventory drift");
  const productionTrigger = productionRows[0];
  const reviewTrigger = reviewRows[0];
  if (productionTrigger.repo_connection?.repo_connection_uuid !==
      reviewTrigger.repo_connection?.repo_connection_uuid)
    fail("review token rotation repository connection drift");
  const productionEnvironment = await loadSnapshot(snapshotDirectory,
    `${core.name}.trigger-${productionTriggerUuid}.environment.json`);
  const reviewEnvironment = await loadSnapshot(snapshotDirectory,
    `${core.name}.trigger-${reviewTriggerUuid}.environment.json`);
  const buildTokens = await loadSnapshot(snapshotDirectory, "build-tokens.json");
  const accountTriggers = await loadSnapshot(snapshotDirectory, "account-triggers.json");
  const result = validateReviewTokenRotationReadback({ production, review, phase,
    productionTrigger, reviewTrigger, productionEnvironment, reviewEnvironment,
    buildTokens, accountTriggers, productionScriptTag: script[0].tag,
    productionSentinel: productionSentinelProof.branch, productionTriggerUuid,
    reviewTriggerUuid, predecessorReviewTokenUuid, replacementReviewTokenUuid,
    repositoryConnectionUuid: productionTrigger.repo_connection.repo_connection_uuid });
  for (const { role, name } of production.workers) {
    validateNoDeployHooks(await loadSnapshot(snapshotDirectory, `${name}.deploy-hooks.json`), role);
    validateNoActiveBuilds(await loadSnapshot(snapshotDirectory, `${name}.builds.json`), role);
  }
  for (const { role, name } of production.workers.slice(1)) {
    if (requireExhaustiveEnvelope(await loadSnapshot(snapshotDirectory,
      `${name}.triggers.json`), `${role} review token rotation triggers`).length !== 0)
      fail(`${role} has a competing review token rotation trigger`);
  }
  const tokenRows = requireExhaustiveEnvelope(buildTokens, "review token rotation build tokens");
  const productionToken = tokenRows.find(({ build_token_name: name }) =>
    name === "Atrinik metaserver production");
  const predecessorToken = tokenRows.find(({ build_token_uuid: id }) =>
    id === predecessorReviewTokenUuid);
  const replacementToken = tokenRows.find(({ build_token_uuid: id }) =>
    id === replacementReviewTokenUuid);
  const productionProof = predecessorTokenAuthorityProofs?.find(({ kind }) =>
    kind === "production");
  const predecessorProof = predecessorTokenAuthorityProofs?.find(({ kind }) => kind === "review");
  if (!productionToken || !productionProof || !predecessorProof)
    fail("review token rotation predecessor authority evidence is incomplete");
  validateReplacementReviewTokenAuthorityProof({ review, accountId,
    proof: replacementTokenAuthorityProof, tokenId: replacementTokenId,
    sourceSha: authoritySourceSha },
  proofValidationTime);
  if (phase !== "predecessor") {
    if (!replacementToken) fail("replacement review wrapper is absent during rotation");
    validateBuildTokenInventory(buildTokens, [{ uuid: replacementReviewTokenUuid,
      name: reviewBuildTokenNames.current, cloudflareTokenId: replacementTokenId }]);
  }
  if (phase !== "complete") {
    if (!predecessorToken) fail("superseded review wrapper disappeared before retirement");
    validateTokenAuthorityProofs({ production, review, accountId,
      proofs: [productionProof, predecessorProof],
      tokenRows: { production: productionToken, review: predecessorToken },
      sourceSha: authoritySourceSha },
    proofValidationTime);
  } else {
    if (!replacementToken) fail("replacement review wrapper is absent after rotation");
    const { ownerUserId: _ownerUserId, ...replacementReviewProof } =
      replacementTokenAuthorityProof;
    validateTokenAuthorityProofs({ production,
      review: membershipReadableReviewContract(review), accountId,
      proofs: [productionProof, { ...replacementReviewProof, kind: "review" }],
      tokenRows: { production: productionToken, review: replacementToken },
      sourceSha: authoritySourceSha },
    proofValidationTime);
  }
  const capturedAt = new Date(now).toISOString();
  return { ...result, accountId, sourceSha, capturedAt, productionPreservationDigest,
    proof_digest: digestJson({ manifest, result, productionTrigger, reviewTrigger,
      productionEnvironment, reviewEnvironment, buildTokens, accountTriggers,
      productionSentinelProof, predecessorTokenAuthorityProofs,
      replacementTokenAuthorityProof, productionPreservationDigest }) };
}

export async function validateReviewTokenRotationProviderPeerNormalizationSnapshotDirectory(
arguments_) {
  const accepted = [];
  for (const phase of ["predecessor-restored", "production-restored-review-augmented"]) {
    try {
      accepted.push(await validateReviewTokenRotationSnapshotDirectory({ ...arguments_, phase }));
    } catch {
      // The exhaustive snapshot must match exactly one provider outcome.
    }
  }
  if (accepted.length !== 1)
    fail("review token rotation provider peer normalization is missing or ambiguous");
  return accepted[0];
}

export async function validateReviewTokenRotationForwardPeerNormalizationSnapshotDirectory(
arguments_) {
  const accepted = [];
  for (const phase of ["production-repointed",
    "production-repointed-review-augmented"]) {
    try {
      accepted.push(await validateReviewTokenRotationSnapshotDirectory({ ...arguments_, phase }));
    } catch {
      // The exhaustive snapshot must match exactly one provider outcome.
    }
  }
  if (accepted.length !== 1)
    fail("review token rotation forward provider normalization is missing or ambiguous");
  return accepted[0];
}

export async function validateReviewStagedEnvironmentSnapshotDirectory({ snapshotDirectory,
  production, review, accountId, sourceSha, tokenAuthorityProofs,
  reviewActivationAuthorityProof, reviewActivationAuthorityEvidence,
  reviewActivationAuthorityCheckpoint }) {
  const authorityArguments = { production, review, accountId, sourceSha,
    ...reviewActivationAuthorityEvidence };
  const { proofValidationTime } = reviewActivationAuthorityCheckpoint ?
    validateReviewActivationAuthorityCheckpoint(reviewActivationAuthorityProof,
      authorityArguments, reviewActivationAuthorityCheckpoint) :
    validateReviewActivationAuthority(reviewActivationAuthorityProof, authorityArguments);
  if (!same(tokenAuthorityProofs, reviewActivationAuthorityEvidence.tokenAuthorityProofs))
    fail("review staged token authority evidence drift");
  const manifest = await loadSnapshot(snapshotDirectory, "snapshot-manifest.json");
  validateSnapshotManifest(manifest, { accountId, sourceSha, production, review });
  const core = production.workers[0];
  const scripts = requireEnvelope(await loadSnapshot(snapshotDirectory, "scripts.json"),
    "review staged scripts");
  const script = scripts.filter(({ id }) => id === core.name);
  if (script.length !== 1 || !scriptTagPattern.test(script[0].tag ?? ""))
    fail("review staged core script is missing or ambiguous");
  const triggerEnvelope = await loadSnapshot(snapshotDirectory, `${core.name}.triggers.json`);
  const triggerRows = requireExhaustiveEnvelope(triggerEnvelope, "review staged core triggers");
  const productionTriggerUuid = await readPrivateValue(
    process.env.ATRINIK_PRODUCTION_STAGED_TRIGGER_UUID_FILE,
    "journaled production staged trigger UUID", uuidPattern);
  const reviewTriggerUuid = await readPrivateValue(
    process.env.ATRINIK_REVIEW_STAGED_TRIGGER_UUID_FILE,
    "journaled review staged trigger UUID", uuidPattern);
  if (productionTriggerUuid === reviewTriggerUuid)
    fail("journaled staged trigger identities overlap");
  const productionRows = triggerRows.filter(({ trigger_uuid: id }) => id === productionTriggerUuid);
  const reviewRows = triggerRows.filter(({ trigger_name: name, trigger_uuid: id }) =>
    name === "Atrinik build-only review" && id === reviewTriggerUuid);
  if (triggerRows.length !== 2 || productionRows.length !== 1 || reviewRows.length !== 1 ||
      reviewRows[0].trigger_uuid !== reviewTriggerUuid)
    fail("review staged trigger inventory is incomplete or competing");
  const productionActual = productionRows[0];
  const reviewActual = reviewRows[0];
  const tokenEnvelope = await loadSnapshot(snapshotDirectory, "build-tokens.json");
  const tokenRows = requireExhaustiveEnvelope(tokenEnvelope, "review staged build tokens");
  const productionToken = tokenRows.filter(({ build_token_name: name }) =>
    name === "Atrinik metaserver production");
  const reviewToken = tokenRows.filter(({ build_token_name: name }) =>
    name === reviewBuildTokenNames.current);
  if (productionToken.length !== 1 || reviewToken.length !== 1)
    fail("review staged token inventory is incomplete or ambiguous");
  validateBuildTokenInventory(tokenEnvelope, [
    { uuid: productionToken[0].build_token_uuid, name: "Atrinik metaserver production" },
    { uuid: reviewToken[0].build_token_uuid, name: reviewBuildTokenNames.current },
  ]);
  validateTokenAuthorityProofs({ production, review, accountId, proofs: tokenAuthorityProofs,
    tokenRows: { production: productionToken[0], review: reviewToken[0] }, sourceSha },
  proofValidationTime);
  const rootDirectory = await readPrivateValue(
    process.env.ATRINIK_REVIEW_STAGING_ROOT_DIRECTORY_FILE,
    "review staging root directory", reviewStagingRootPattern);
  const productionSentinelProof = reviewActivationAuthorityEvidence.productionSentinelProof;
  validateSentinelRefAbsence(productionSentinelProof, proofValidationTime);
  const productionExpected = productionTriggerSpec(production, {
    externalScriptId: script[0].tag,
    repositoryConnectionUuid: productionActual.repo_connection?.repo_connection_uuid,
    buildTokenUuid: reviewToken[0].build_token_uuid,
  });
  productionExpected.branch_includes = [productionSentinelProof.branch];
  validateTriggerSnapshot(productionActual, productionExpected, "review staged production");
  const expected = automaticReviewTriggerSpec(review, {
    externalScriptId: script[0].tag,
    repositoryConnectionUuid: reviewActual.repo_connection?.repo_connection_uuid,
    buildTokenUuid: reviewToken[0].build_token_uuid,
  });
  expected.root_directory = rootDirectory;
  expected.build_command = "exit 1";
  expected.deploy_command = "exit 1";
  if (productionActual.repo_connection?.repo_connection_uuid !==
      reviewActual.repo_connection?.repo_connection_uuid)
    fail("review staged triggers do not share the repository connection");
  const environment = await loadSnapshot(snapshotDirectory,
    `${core.name}.trigger-${reviewActual.trigger_uuid}.environment.json`);
  const result = validateReviewStagedEnvironmentReadback({ trigger: reviewActual, environment },
    expected, review);
  for (const { role, name } of production.workers) {
    validateNoDeployHooks(await loadSnapshot(snapshotDirectory, `${name}.deploy-hooks.json`), role);
    validateNoActiveBuilds(await loadSnapshot(snapshotDirectory, `${name}.builds.json`), role);
  }
  for (const { role, name } of production.workers.slice(1)) {
    const rows = requireExhaustiveEnvelope(await loadSnapshot(snapshotDirectory,
      `${name}.triggers.json`), `${role} review staged triggers`);
    if (rows.length !== 0) fail(`${role} has an independent review staged trigger`);
  }
  const accountRows = requireExhaustiveEnvelope(await loadSnapshot(snapshotDirectory,
    "account-triggers.json"), "review staged account triggers").filter(
    ({ repo_connection: connection }) => connection?.provider_type === "github" &&
      connection.provider_account_id === githubRepository.provider_account_id &&
      connection.repo_id === githubRepository.repo_id);
  if (!same(sorted(accountRows.map(({ trigger_uuid: id }) => id)),
    sorted([productionTriggerUuid, reviewTriggerUuid])))
    fail("review staged account trigger inventory drift");
  const capturedAt = new Date().toISOString();
  return { outcome: result.outcome, mutation: false, accountId, sourceSha, capturedAt,
    proof_digest: digestJson({ manifest, productionTrigger: productionActual,
      reviewTrigger: reviewActual, environment,
      tokenIds: [productionToken[0].build_token_uuid, reviewToken[0].build_token_uuid],
      reviewActivationAuthorityProof }) };
}

async function validateFreshSnapshotDirectory({ snapshotDirectory, production, review,
  accountId, sourceSha }) {
  validateSnapshotManifest(await loadSnapshot(snapshotDirectory, "snapshot-manifest.json"),
    { accountId, sourceSha, production, review });
  const scripts = await loadSnapshot(snapshotDirectory, "scripts.json");
  const scriptRows = requireEnvelope(scripts, "scripts");
  if (!Array.isArray(scriptRows)) fail("script inventory is invalid");
  const projects = production.workers.map(({ role, name }) => [role, name]);
  const tagged = projects.map(([label, name]) => {
    const row = scriptRows.find(({ id }) => id === name);
    if (!row || !scriptTagPattern.test(row.tag ?? ""))
      fail(`${label} Builds script is missing or malformed`);
    return [label, name];
  });
  const triggers = await Promise.all(tagged.map(async ([label, name]) =>
    [label, await loadSnapshot(snapshotDirectory, `${name}.triggers.json`)]));
  const deployHooks = await Promise.all(tagged.map(async ([label, name]) =>
    [label, await loadSnapshot(snapshotDirectory, `${name}.deploy-hooks.json`)]));
  const builds = await Promise.all(tagged.map(async ([label, name]) =>
    [label, await loadSnapshot(snapshotDirectory, `${name}.builds.json`)]));
  const buildTokens = await loadSnapshot(snapshotDirectory, "build-tokens.json");
  const accountTriggers = await loadSnapshot(snapshotDirectory, "account-triggers.json");
  const { productionSentinelProof } = await readProductionSentinelProof();
  const repositoryConnectionProof = await readPrivateJson(
    process.env.ATRINIK_REPOSITORY_CONNECTION_OWNER_PROOF_FILE,
    "shared repository connection owner proof");
  return validateFreshBuildsSnapshot({
    production, review, scripts, triggers, deployHooks, builds, buildTokens,
    accountTriggers,
    productionSentinelProof, repositoryConnectionProof, accountId,
    sourceSha,
  });
}

export async function validateCheckedInProvisioning() {
  const { production, review } = await checkedInInputs();
  const id = "11111111-1111-4111-8111-111111111111";
  const tag = "1".repeat(32);
  productionTriggerSpec(production, {
    externalScriptId: tag, repositoryConnectionUuid: id, buildTokenUuid: id,
  });
  automaticReviewTriggerSpec(review, {
    externalScriptId: tag, repositoryConnectionUuid: id, buildTokenUuid: id,
  });
  automaticReviewEnvironmentSpec(review);
  provisioningSetupPlan(production, review);
  return { production, review };
}

export function provisioningDryRunSummary(production, review) {
  const setupPlan = provisioningSetupPlan(production, review);
  return {
    outcome: "workers-builds-provisioning-plan-valid", mutation: false,
    production: { project: production.workers[0].name, branch: production.productionBranch,
      triggerCount: 1, protectedInputCount: Object.keys(production.protectedInputs).length },
    automaticReview: { project: review.automaticReview.project, triggerCount: 1,
      protectedInputCount: review.automaticReview.protectedInputs.length },
    setupOperationCount: setupPlan.setupOperations.length,
    rollbackOperationCount: setupPlan.rollbackOperations.length,
    gates: structuredClone(setupPlan.gates),
  };
}

export const credentialedProvisioningModes = Object.freeze([
  "--materialize-production",
  "--readback",
  "--verify-configured",
  "--verify-disposable-review-authority",
  "--verify-disposable-review-authority-proof",
  "--verify-disposable-review-authority-push",
  "--verify-preflight",
  "--verify-production-activation",
  "--verify-review-activation",
  "--verify-review-activation-authority",
  "--verify-review-activation-authority-proof",
  "--verify-review-membership-repair-authority",
  "--verify-review-membership-repair-result",
  "--verify-review-token-rotation-authority",
  "--verify-review-token-rotation-authority-proof-historical",
  "--verify-review-token-rotation-provider-normalized-authority-proof-historical",
  "--verify-review-token-rotation-authority-proof",
  "--verify-review-token-rotation-blocked-delete-authority",
  "--verify-review-token-rotation-blocked-delete-authority-proof",
  "--verify-review-token-rotation-blocked-delete-complete",
  "--verify-review-token-rotation-blocked-delete-blocked",
  "--verify-review-token-rotation-complete",
  "--verify-review-token-rotation-complete-historical",
  "--verify-review-token-rotation-pre-create",
  "--verify-review-token-rotation-pre-production",
  "--verify-review-token-rotation-intermediate",
  "--verify-review-token-rotation-no-owned-successor",
  "--verify-review-token-rotation-provider-normalized-incident",
  "--verify-review-token-rotation-provider-peer-normalization",
  "--verify-review-token-rotation-rollback-precondition",
  "--verify-review-token-rotation-rollback-restored",
  "--verify-review-token-rotation-rollback-complete",
  "--verify-review-token-rotation-unreferenced",
  "--verify-review-staged-environment",
  "--verify-review-staging-root-activation",
  "--verify-review-staging-root-create",
  "--verify-staged",
  "--verify-staged-proof",
]);

export async function credentialedSourceSha(mode, load = reviewedCurrentMainSha) {
  return credentialedProvisioningModes.includes(mode) ? await load() : undefined;
}

async function runProvisioningCliCore(mode = process.argv[2] ?? "--validate-only",
  sourceShaLoader = reviewedCurrentMainSha, providerSnapshotReader = readProviderSnapshot,
  testCapabilities = undefined, blockedDeleteTerminalContextReader = undefined,
  noOwnedTerminalContextReader = undefined) {
  const { production, review } = await validateCheckedInProvisioning();
  const providerNormalizedTestCapability = testCapabilities?.providerNormalized ??
    testCapabilities;
  const blockedDeleteTestCapability = testCapabilities?.blockedDelete ?? testCapabilities;
  const incidentCoordinate = providerNormalizedIncidentCoordinate(
    providerNormalizedTestCapability);
  if (mode === "--validate-only") {
    process.stdout.write(`${JSON.stringify({ outcome: "workers-builds-provisioning-valid" })}\n`);
    return;
  }
  if (mode === "--dry-run") {
    process.stdout.write(`${JSON.stringify(provisioningDryRunSummary(production, review))}\n`);
    return;
  }
  if (mode === "--plan-setup") {
    process.stdout.write(`${JSON.stringify(provisioningSetupPlan(production, review))}\n`);
    return;
  }
  const sourceSha = await credentialedSourceSha(mode, sourceShaLoader);
  if (mode === "--readback") {
    const accountId = await readPrivateValue(process.env.ATRINIK_CLOUDFLARE_ACCOUNT_ID_FILE,
      "Cloudflare account ID", accountIdPattern);
    const token = await readPrivateValue(process.env.ATRINIK_WORKERS_BUILDS_API_TOKEN_FILE,
      "Workers Builds API token");
    const productionReadToken = await readPrivateValue(
      process.env.ATRINIK_PRODUCTION_BUILD_TOKEN_SECRET_FILE,
      "production D1 read API token");
    const outputDirectory = process.env.ATRINIK_PROVIDER_SNAPSHOT_OUTPUT;
    process.stdout.write(`${JSON.stringify(await providerSnapshotReader({
      accountId, token, productionReadToken, outputDirectory, production, review, sourceSha,
    }))}\n`);
    return;
  }
  if (mode === "--materialize-production") {
    const accountId = await readPrivateValue(process.env.ATRINIK_CLOUDFLARE_ACCOUNT_ID_FILE,
      "Cloudflare account ID", accountIdPattern);
    const { bases } = await checkedInInputs();
    process.stdout.write(`${JSON.stringify(await materializeSnapshot({
      snapshotDirectory: process.env.ATRINIK_PROVIDER_SNAPSHOT_DIRECTORY,
      outputDirectory: process.env.ATRINIK_PRODUCTION_CONFIG_OUTPUT,
      accountId, production, review, bases, sourceSha,
    }))}\n`);
    return;
  }
  if (mode === "--verify-preflight") {
    const accountId = await readPrivateValue(process.env.ATRINIK_CLOUDFLARE_ACCOUNT_ID_FILE,
      "Cloudflare account ID", accountIdPattern);
    process.stdout.write(`${JSON.stringify(await validateFreshSnapshotDirectory({
      snapshotDirectory: process.env.ATRINIK_PROVIDER_SNAPSHOT_DIRECTORY,
      production, review, accountId, sourceSha,
    }))}\n`);
    return;
  }
  if (mode === "--verify-staged") {
    const accountId = await readPrivateValue(process.env.ATRINIK_CLOUDFLARE_ACCOUNT_ID_FILE,
      "Cloudflare account ID", accountIdPattern);
    const tokenAuthorityProofs = [
      await readPrivateJson(process.env.ATRINIK_PRODUCTION_BUILD_TOKEN_PERMISSION_PROOF_FILE,
        "production build token permission proof"),
      await readPrivateJson(process.env.ATRINIK_REVIEW_BUILD_TOKEN_PERMISSION_PROOF_FILE,
        "review build token permission proof"),
    ];
    const stagedProof = await validateStagedSnapshotDirectory({
      snapshotDirectory: process.env.ATRINIK_PROVIDER_SNAPSHOT_DIRECTORY,
      production, review, accountId, tokenAuthorityProofs, sourceSha,
    });
    await writePrivateProof(process.env.ATRINIK_STAGED_PROOF_OUTPUT_FILE, stagedProof);
    process.stdout.write(`${JSON.stringify(publicStagedProofSummary(stagedProof))}\n`);
    return;
  }
  if (mode === "--verify-review-activation-authority") {
    const accountId = await readPrivateValue(process.env.ATRINIK_CLOUDFLARE_ACCOUNT_ID_FILE,
      "Cloudflare account ID", accountIdPattern);
    const evidence = await readReviewActivationAuthorityEvidence();
    const current = await validateStagedSnapshotDirectory({
      snapshotDirectory: process.env.ATRINIK_PROVIDER_SNAPSHOT_DIRECTORY,
      production, review, accountId, tokenAuthorityProofs: evidence.tokenAuthorityProofs,
      sourceSha,
    });
    validateStagedProof(evidence.stagedProof, current);
    const tokenRows = requireExhaustiveEnvelope(await loadSnapshot(
      process.env.ATRINIK_PROVIDER_SNAPSHOT_DIRECTORY, "build-tokens.json"),
    "review activation authority build tokens");
    const productionToken = tokenRows.find(({ build_token_name: name }) =>
      name === "Atrinik metaserver production");
    const reviewToken = tokenRows.find(({ build_token_name: name }) =>
      name === reviewBuildTokenNames.current);
    if (!productionToken || !reviewToken)
      fail("review activation authority token inventory drift");
    const proof = issueReviewActivationAuthority({ production, review, accountId, sourceSha,
      ...evidence, currentStagedProof: current,
      tokenRows: { production: productionToken, review: reviewToken } });
    await writePrivateProof(
      process.env.ATRINIK_REVIEW_ACTIVATION_AUTHORITY_PROOF_OUTPUT_FILE, proof);
    process.stdout.write(`${JSON.stringify({ outcome: proof.outcome, mutation: false,
      sourceSha, expiresAt: proof.expiresAt, proof_digest: proof.proof_digest })}\n`);
    return;
  }
  if (mode === "--verify-disposable-review-authority") {
    const accountId = await readPrivateValue(process.env.ATRINIK_CLOUDFLARE_ACCOUNT_ID_FILE,
      "Cloudflare account ID", accountIdPattern);
    const evidence = await readDisposableReviewAuthorityEvidence(process.env,
      { requireCurrent: false });
    await validateDisposableCoordinatePreparation(evidence.disposableCoordinate);
    const current = await validateStagedSnapshotDirectory({
      snapshotDirectory: process.env.ATRINIK_PROVIDER_SNAPSHOT_DIRECTORY,
      production, review, accountId, tokenAuthorityProofs: evidence.tokenAuthorityProofs,
      sourceSha,
    }, { reviewActive: true, requireReviewResult: false, authorityRequired: false,
      includeLiveIdentities: true });
    await writePrivateProof(process.env.ATRINIK_CURRENT_REVIEW_ACTIVE_PROOF_OUTPUT_FILE, current);
    const tokenRows = requireExhaustiveEnvelope(await loadSnapshot(
      process.env.ATRINIK_PROVIDER_SNAPSHOT_DIRECTORY, "build-tokens.json"),
    "disposable review authority build tokens");
    const productionToken = tokenRows.find(({ build_token_name: name }) =>
      name === "Atrinik metaserver production");
    const reviewToken = tokenRows.find(({ build_token_name: name }) =>
      name === reviewBuildTokenNames.current);
    if (!productionToken || !reviewToken)
      fail("disposable review authority token inventory drift");
    const proof = issueDisposableReviewAuthority({ production, review, accountId, sourceSha,
      ...evidence, currentReviewActiveProof: current,
      tokenRows: { production: productionToken, review: reviewToken } });
    await writePrivateProof(process.env.ATRINIK_DISPOSABLE_REVIEW_AUTHORITY_PROOF_OUTPUT_FILE,
      proof);
    process.stdout.write(`${JSON.stringify({ outcome: proof.outcome, mutation: false,
      sourceSha, expiresAt: proof.expiresAt, proof_digest: proof.proof_digest })}\n`);
    return;
  }
  if (mode === "--verify-review-token-rotation-blocked-delete-authority") {
    const accountId = await readPrivateValue(process.env.ATRINIK_CLOUDFLARE_ACCOUNT_ID_FILE,
      "Cloudflare account ID", accountIdPattern);
    const token = await readPrivateValue(process.env.ATRINIK_WORKERS_BUILDS_API_TOKEN_FILE,
      "Workers Builds API token");
    const productionReadToken = await readPrivateValue(
      process.env.ATRINIK_PRODUCTION_BUILD_TOKEN_SECRET_FILE,
      "production D1 read API token");
    const incident = await readBlockedReviewTokenDeleteIncident({ production, review, accountId,
      testCapability: blockedDeleteTestCapability,
      providerNormalizedTestCapability });
    const recoveryCoordinate = await readPrivateJson(
      process.env.ATRINIK_REVIEW_TOKEN_ROTATION_BLOCKED_DELETE_RECOVERY_COORDINATE_FILE,
      "blocked delete recovery coordinate");
    await validateBlockedDeleteRecoveryCoordinatePreparation(recoveryCoordinate, sourceSha);
    const outputDirectory = process.env.ATRINIK_PROVIDER_SNAPSHOT_OUTPUT;
    await providerSnapshotReader({ accountId, token, productionReadToken,
      outputDirectory, production, review, sourceSha });
    const identity = incident.authorityProof.journalIdentities;
    const currentPhaseProof = await validateReviewTokenRotationSnapshotDirectory({
      snapshotDirectory: outputDirectory, production, review, accountId, sourceSha,
      phase: "predecessor-restored",
      productionSentinelProof: incident.evidence.productionSentinelProof,
      predecessorTokenAuthorityProofs: incident.evidence.predecessorTokenAuthorityProofs,
      replacementTokenAuthorityProof: incident.evidence.replacementTokenAuthorityProof,
      replacementTokenId: incident.evidence.replacementTokenId,
      productionTriggerUuid: identity.productionTriggerUuid,
      reviewTriggerUuid: identity.reviewTriggerUuid,
      predecessorReviewTokenUuid: identity.predecessorReviewBuildTokenUuid,
      replacementReviewTokenUuid: incident.replacementReviewTokenUuid,
      productionPreservationDigest: incident.authorityProof.productionPreservationDigest,
      authorityProof: incident.authorityProof,
      productionBaselineProof: incident.evidence.productionBaselineProof,
      authoritySourceSha: incident.authorityProof.sourceSha,
      authorityPlanDigest: incident.authorityProof.planDigest,
    });
    const currentMainProof = await readCurrentMainProof(process.env, sourceSha);
    const authority = issueReviewTokenRotationBlockedDeleteAuthority({ production, review,
      accountId, sourceSha, currentMainProof, currentPhaseProof,
      historicalAuthorityProof: incident.authorityProof,
      blockedIncidentValidation: incident.validation, recoveryCoordinate });
    await writePrivateProof(
      process.env.ATRINIK_REVIEW_TOKEN_ROTATION_BLOCKED_DELETE_CURRENT_PROOF_OUTPUT_FILE,
      currentPhaseProof);
    await writePrivateProof(
      process.env.ATRINIK_REVIEW_TOKEN_ROTATION_BLOCKED_DELETE_AUTHORITY_PROOF_OUTPUT_FILE,
      authority);
    process.stdout.write(`${JSON.stringify({ outcome: authority.outcome, mutation: false,
      sourceSha, expiresAt: authority.expiresAt, proof_digest: authority.proof_digest,
      replacement_review_build_token_uuid: authority.replacementReviewTokenUuid })}\n`);
    return;
  }
  if (mode === "--verify-review-token-rotation-blocked-delete-authority-proof") {
    const accountId = await readPrivateValue(process.env.ATRINIK_CLOUDFLARE_ACCOUNT_ID_FILE,
      "Cloudflare account ID", accountIdPattern);
    const incident = await readBlockedReviewTokenDeleteIncident({ production, review, accountId,
      testCapability: blockedDeleteTestCapability,
      providerNormalizedTestCapability });
    const authority = await readPrivateJson(
      process.env.ATRINIK_REVIEW_TOKEN_ROTATION_BLOCKED_DELETE_AUTHORITY_PROOF_FILE,
      "blocked delete recovery authority proof");
    const currentPhaseProof = await readPrivateJson(
      process.env.ATRINIK_REVIEW_TOKEN_ROTATION_BLOCKED_DELETE_CURRENT_PROOF_FILE,
      "blocked delete current predecessor-restored proof");
    const currentMainProof = await readCurrentMainProof(process.env, sourceSha);
    const recoveryCoordinate = await readPrivateJson(
      process.env.ATRINIK_REVIEW_TOKEN_ROTATION_BLOCKED_DELETE_RECOVERY_COORDINATE_FILE,
      "blocked delete recovery coordinate");
    const validation = validateReviewTokenRotationBlockedDeleteAuthority(authority,
      { production, review, accountId, sourceSha, currentMainProof, currentPhaseProof,
        historicalAuthorityProof: incident.authorityProof,
        blockedIncidentValidation: incident.validation, recoveryCoordinate });
    const requestedReceiptPath =
      process.env.ATRINIK_REVIEW_TOKEN_ROTATION_BLOCKED_DELETE_AUTHORIZATION_RECEIPT_OUTPUT_FILE;
    if (requestedReceiptPath !== recoveryCoordinate.authorizationReceiptPath)
      fail("blocked delete recovery authorization receipt path drift");
    const receiptUnsigned = {
      outcome: "workers-builds-review-token-rotation-blocked-delete-write-authorized",
      mutation: false, operation: "delete", sourceSha,
      authorityProofDigest: authority.proof_digest,
      recoveryCoordinateDigest: authority.recoveryCoordinateDigest,
      replacementReviewTokenUuid: authority.replacementReviewTokenUuid,
      requestDigestSha256: validation.request.requestDigestSha256,
      capturedAt: new Date().toISOString(),
    };
    const receipt = { ...receiptUnsigned, proof_digest: digestJson(receiptUnsigned) };
    await writePrivateProof(requestedReceiptPath, receipt);
    process.stdout.write(`${JSON.stringify({ ...validation, sourceSha,
      proof_digest: authority.proof_digest, receipt_digest: receipt.proof_digest })}\n`);
    return;
  }
  if (mode === "--verify-review-token-rotation-no-owned-successor") {
    if (noOwnedTerminalContextReader &&
        !noOwnedTerminalContextReaders.has(noOwnedTerminalContextReader))
      fail("no-owned terminal test reader is unavailable");
    const injected = noOwnedTerminalContextReader ?
      await noOwnedTerminalContextReader(mode) : null;
    if (injected) {
      const result = await validateReviewTokenRotationNoOwnedIncidentSuccessorForTest(
        injected.records, injected.arguments, injected.now, injected.testCapability);
      process.stdout.write(`${JSON.stringify({ ...result, sourceSha })}\n`);
      return;
    }
    const accountId = await readPrivateValue(process.env.ATRINIK_CLOUDFLARE_ACCOUNT_ID_FILE,
      "Cloudflare account ID", accountIdPattern);
    const forwardPath =
      process.env.ATRINIK_REVIEW_TOKEN_ROTATION_NO_OWNED_FORWARD_JOURNAL_FILE;
    const rollbackPath =
      process.env.ATRINIK_REVIEW_TOKEN_ROTATION_NO_OWNED_ROLLBACK_JOURNAL_FILE;
    const authorityPath = process.env.ATRINIK_REVIEW_TOKEN_ROTATION_AUTHORITY_PROOF_FILE;
    const preCreatePath = process.env.ATRINIK_REVIEW_TOKEN_ROTATION_PRE_CREATE_PROOF_FILE;
    const blockedProofPath =
      process.env.ATRINIK_REVIEW_TOKEN_ROTATION_NO_OWNED_RESIDUAL_PROOF_FILE;
    const blockedSnapshotDirectory = await readPrivateValue(
      process.env.ATRINIK_REVIEW_TOKEN_ROTATION_NO_OWNED_RESIDUAL_SNAPSHOT_DIRECTORY_FILE,
      "no-owned historical residual snapshot directory");
    const freshSnapshotDirectory = await readPrivateValue(
      process.env.ATRINIK_REVIEW_TOKEN_ROTATION_NO_OWNED_SUCCESSOR_SNAPSHOT_DIRECTORY_FILE,
      "no-owned successor snapshot directory");
    const evidence = await readReviewTokenRotationAuthorityEvidence(process.env);
    const authorityProof = await readPrivateJson(authorityPath,
      "no-owned historical rotation authority");
    const preCreateProof = await readPrivateJson(preCreatePath,
      "no-owned historical pre-create proof");
    const blockedProof = await readPrivateJson(blockedProofPath,
      "no-owned historical residual proof");
    const freshPredecessorProof = await readPrivateJson(
      process.env.ATRINIK_REVIEW_TOKEN_ROTATION_NO_OWNED_SUCCESSOR_PROOF_FILE,
      "no-owned successor predecessor proof");
    const terminalCurrentMainProofStart = await readPrivateJson(
      process.env.ATRINIK_REVIEW_TOKEN_ROTATION_NO_OWNED_SUCCESSOR_CURRENT_MAIN_START_PROOF_FILE,
      "no-owned successor observation start current-main proof");
    const terminalCurrentMainProofFinish = await readPrivateJson(
      process.env.ATRINIK_REVIEW_TOKEN_ROTATION_NO_OWNED_SUCCESSOR_CURRENT_MAIN_FINISH_PROOF_FILE,
      "no-owned successor observation finish current-main proof");
    const records = await readPrivateJsonLines(
      process.env.ATRINIK_REVIEW_TOKEN_ROTATION_NO_OWNED_SUCCESSOR_JOURNAL_FILE,
      "no-owned successor journal");
    const forwardRecords = await readPrivateJsonLines(forwardPath,
      "no-owned historical forward journal");
    const rollbackRecords = await readPrivateJsonLines(rollbackPath,
      "no-owned historical rollback journal");
    const result = await validateReviewTokenRotationNoOwnedIncidentSuccessor(records, {
      production, review, accountId, terminalSourceSha: freshPredecessorProof.sourceSha,
      terminalCurrentMainProofStart, terminalCurrentMainProofFinish,
      freshSnapshotDirectory, freshPredecessorProof,
      forwardRecords, rollbackRecords, authorityProof, preCreateProof,
      rollbackArguments: {
        blockedSnapshotDirectory, blockedProof,
        productionSentinelProof: evidence.productionSentinelProof,
        predecessorTokenAuthorityProofs: evidence.predecessorTokenAuthorityProofs,
        replacementTokenAuthorityProof: evidence.replacementTokenAuthorityProof,
        replacementTokenId: evidence.replacementTokenId,
        productionBaselineProof: evidence.productionBaselineProof,
      },
      incidentFileDigests: {
        authorityFileSha256: await readPrivateFileSha256(authorityPath,
          "no-owned historical rotation authority"),
        executorSha256: await readPrivateFileSha256(
          process.env.ATRINIK_REVIEW_TOKEN_ROTATION_NO_OWNED_EXECUTOR_FILE,
          "no-owned failed executor"),
        forwardJournalSha256: await readPrivateFileSha256(forwardPath,
          "no-owned historical forward journal"),
        preCreateProofFileSha256: await readPrivateFileSha256(preCreatePath,
          "no-owned historical pre-create proof"),
        residualProofFileSha256: await readPrivateFileSha256(blockedProofPath,
          "no-owned historical residual proof"),
        residualSnapshotManifestSha256: await readPrivateFileSha256(
          resolve(blockedSnapshotDirectory, "snapshot-manifest.json"),
          "no-owned historical residual snapshot manifest"),
        rollbackJournalSha256: await readPrivateFileSha256(rollbackPath,
          "no-owned historical rollback journal"),
      },
    });
    process.stdout.write(`${JSON.stringify({ ...result, sourceSha,
      terminalObservationSourceSha: freshPredecessorProof.sourceSha })}\n`);
    return;
  }
  if (["--verify-review-token-rotation-blocked-delete-complete",
    "--verify-review-token-rotation-blocked-delete-blocked"].includes(mode)) {
    if (blockedDeleteTerminalContextReader &&
        !blockedDeleteTerminalContextReaders.has(blockedDeleteTerminalContextReader))
      fail("blocked delete terminal test reader is unavailable");
    const injected = blockedDeleteTerminalContextReader ?
      await blockedDeleteTerminalContextReader(mode) : null;
    if (injected) {
      const result = await validateReviewTokenRotationBlockedDeleteRecoveryJournal(
        injected.records, injected.authority, injected.arguments, injected.now);
      const expectedTerminal = mode.endsWith("-complete") ?
        "review-token-rotation-blocked-delete-recovery-complete" :
        "review-token-rotation-blocked-delete-recovery-blocked";
      if (result.terminal !== expectedTerminal)
        fail("blocked delete recovery terminal mode drift");
      process.stdout.write(`${JSON.stringify({ ...result, sourceSha,
        authoritySourceSha: injected.authority.sourceSha,
        terminalObservationSourceSha: (injected.arguments.completeProof ??
          injected.arguments.blockedProof).sourceSha })}\n`);
      return;
    }
    const accountId = await readPrivateValue(process.env.ATRINIK_CLOUDFLARE_ACCOUNT_ID_FILE,
      "Cloudflare account ID", accountIdPattern);
    const incident = await readBlockedReviewTokenDeleteIncident({ production, review, accountId,
      testCapability: blockedDeleteTestCapability,
      providerNormalizedTestCapability });
    const authority = await readPrivateJson(
      process.env.ATRINIK_REVIEW_TOKEN_ROTATION_BLOCKED_DELETE_AUTHORITY_PROOF_FILE,
      "blocked delete recovery authority proof");
    const currentPhaseProof = await readPrivateJson(
      process.env.ATRINIK_REVIEW_TOKEN_ROTATION_BLOCKED_DELETE_CURRENT_PROOF_FILE,
      "blocked delete current predecessor-restored proof");
    const currentMainProof = await readPrivateJson(
      process.env.ATRINIK_REVIEW_TOKEN_ROTATION_BLOCKED_DELETE_AUTHORITY_CURRENT_MAIN_PROOF_FILE,
      "blocked delete authority current-main proof");
    const recoveryCoordinate = await readPrivateJson(
      process.env.ATRINIK_REVIEW_TOKEN_ROTATION_BLOCKED_DELETE_RECOVERY_COORDINATE_FILE,
      "blocked delete recovery coordinate");
    const records = await readPrivateJsonLines(
      process.env.ATRINIK_REVIEW_TOKEN_ROTATION_BLOCKED_DELETE_JOURNAL_FILE,
      "blocked delete recovery journal");
    const authorizationReceipt = records.some(({ event }) =>
      event === "blocked-delete-authority-checked") ? await readPrivateJson(
        process.env.ATRINIK_REVIEW_TOKEN_ROTATION_BLOCKED_DELETE_AUTHORIZATION_RECEIPT_FILE,
        "blocked delete recovery authorization receipt") : undefined;
    const completeMode = mode.endsWith("-complete");
    const completeProof = completeMode ? await readPrivateJson(
      process.env.ATRINIK_REVIEW_TOKEN_ROTATION_BLOCKED_DELETE_COMPLETE_PROOF_FILE,
      "blocked delete recovery complete proof") : undefined;
    const blockedProof = completeMode ? undefined : await readPrivateJson(
      process.env.ATRINIK_REVIEW_TOKEN_ROTATION_BLOCKED_DELETE_BLOCKED_PROOF_FILE,
      "blocked delete recovery blocked proof");
    const blockedSnapshotDirectory = completeMode ? undefined : await readPrivateValue(
      process.env.ATRINIK_REVIEW_TOKEN_ROTATION_BLOCKED_DELETE_BLOCKED_SNAPSHOT_DIRECTORY_FILE,
      "blocked delete recovery blocked snapshot directory");
    const terminalObservationCurrentMainProof = await readPrivateJson(
      process.env.ATRINIK_REVIEW_TOKEN_ROTATION_BLOCKED_DELETE_TERMINAL_CURRENT_MAIN_PROOF_FILE,
      "blocked delete terminal observation current-main proof");
    const result = await validateReviewTokenRotationBlockedDeleteRecoveryJournal(records,
      authority, { production, review, accountId, sourceSha: authority.sourceSha,
        currentMainProof, currentPhaseProof,
        historicalAuthorityProof: incident.authorityProof,
        blockedIncidentValidation: incident.validation, recoveryCoordinate,
        authorizationReceipt, completeProof, blockedProof, blockedSnapshotDirectory,
        productionSentinelProof: incident.evidence.productionSentinelProof,
        predecessorTokenAuthorityProofs: incident.evidence.predecessorTokenAuthorityProofs,
        replacementTokenAuthorityProof: incident.evidence.replacementTokenAuthorityProof,
        replacementTokenId: incident.evidence.replacementTokenId,
        productionBaselineProof: incident.evidence.productionBaselineProof,
        historicalTerminalValidation: true, terminalObservationCurrentMainProof });
    const expectedTerminal = completeMode ?
      "review-token-rotation-blocked-delete-recovery-complete" :
      "review-token-rotation-blocked-delete-recovery-blocked";
    if (result.terminal !== expectedTerminal)
      fail("blocked delete recovery terminal mode drift");
    process.stdout.write(`${JSON.stringify({ ...result, sourceSha,
      authoritySourceSha: authority.sourceSha,
      terminalObservationSourceSha: (completeProof ?? blockedProof).sourceSha })}\n`);
    return;
  }
  if (mode === "--verify-review-membership-repair-authority") {
    const accountId = await readPrivateValue(process.env.ATRINIK_CLOUDFLARE_ACCOUNT_ID_FILE,
      "Cloudflare account ID", accountIdPattern);
    const evidence = await readReviewMembershipRepairAuthorityEvidence(process.env, sourceSha);
    const proof = issueReviewMembershipRepairAuthority({ production, review, accountId,
      sourceSha, ...evidence });
    await writePrivateProof(
      process.env.ATRINIK_REVIEW_MEMBERSHIP_REPAIR_AUTHORITY_PROOF_OUTPUT_FILE, proof);
    process.stdout.write(`${JSON.stringify({ outcome: proof.outcome, mutation: false,
      sourceSha, expiresAt: proof.expiresAt, proof_digest: proof.proof_digest })}\n`);
    return;
  }
  if (mode === "--verify-review-membership-repair-result") {
    const accountId = await readPrivateValue(process.env.ATRINIK_CLOUDFLARE_ACCOUNT_ID_FILE,
      "Cloudflare account ID", accountIdPattern);
    const evidence = await readReviewMembershipRepairAuthorityEvidence(process.env, sourceSha);
    const authorityProof = await readPrivateJson(
      process.env.ATRINIK_REVIEW_MEMBERSHIP_REPAIR_AUTHORITY_PROOF_FILE,
      "review membership repair authority proof");
    validateReviewMembershipRepairAuthority(authorityProof,
      { production, review, accountId, sourceSha, ...evidence }, Date.now(), 0);
    const replacementTokenId = await readPrivateValue(
      process.env.ATRINIK_REPLACEMENT_REVIEW_BUILD_TOKEN_ID_FILE,
      "membership-readable replacement token ID", /^[0-9a-f]{32}$/u);
    const resultProof = await readPrivateJson(
      process.env.ATRINIK_REPLACEMENT_REVIEW_BUILD_TOKEN_PERMISSION_PROOF_FILE,
      "membership-readable replacement token policy proof");
    validateReviewMembershipRepairResultProof(resultProof,
      { accountId, sourceSha, authorityProof, replacementTokenId });
    process.stdout.write(`${JSON.stringify({
      outcome: "workers-builds-review-membership-repair-result-valid", mutation: false,
      sourceSha, tokenId: replacementTokenId, proof_digest: digestJson(resultProof) })}\n`);
    return;
  }
  if (mode === "--verify-review-token-rotation-authority") {
    const accountId = await readPrivateValue(process.env.ATRINIK_CLOUDFLARE_ACCOUNT_ID_FILE,
      "Cloudflare account ID", accountIdPattern);
    const evidence = await readReviewTokenRotationAuthorityEvidence(process.env,
      { requireCurrent: false, verifyInitialAttempt: true });
    const membershipSuccessorValidation = evidence.membershipSuccessorEvidence ?
      validateReviewMembershipSuccessorRotationEvidence(
        evidence.membershipSuccessorEvidence, { accountId }) : undefined;
    const livePredecessorName = reviewTokenRotationLivePredecessorName(
      membershipSuccessorValidation);
    const current = await validateStagedSnapshotDirectory({
      snapshotDirectory: process.env.ATRINIK_PROVIDER_SNAPSHOT_DIRECTORY,
      production, review, accountId,
      tokenAuthorityProofs: evidence.predecessorTokenAuthorityProofs, sourceSha,
    }, { reviewActive: true, requireReviewResult: false, authorityRequired: false,
      includeLiveIdentities: true, reviewTokenName: livePredecessorName });
    await writePrivateProof(
      process.env.ATRINIK_REVIEW_TOKEN_ROTATION_PREDECESSOR_PROOF_OUTPUT_FILE, current);
    const tokenRows = requireExhaustiveEnvelope(await loadSnapshot(
      process.env.ATRINIK_PROVIDER_SNAPSHOT_DIRECTORY, "build-tokens.json"),
    "review token rotation authority build tokens");
    const productionToken = tokenRows.find(({ build_token_name: name }) =>
      name === "Atrinik metaserver production");
    const reviewToken = tokenRows.find(({ build_token_name: name }) =>
      name === livePredecessorName);
    if (!productionToken || !reviewToken || tokenRows.some(({ build_token_name: name }) =>
      name === (membershipSuccessorValidation ? reviewBuildTokenNames.predecessor :
        reviewBuildTokenNames.current)))
      fail("review token rotation predecessor wrapper inventory drift");
    const productionPreservationDigest = await snapshotProductionPreservationDigest(
      process.env.ATRINIK_PROVIDER_SNAPSHOT_DIRECTORY, production);
    const scriptRows = requireEnvelope(await loadSnapshot(
      process.env.ATRINIK_PROVIDER_SNAPSHOT_DIRECTORY, "scripts.json"),
    "review token rotation authority scripts");
    const coreScriptRows = scriptRows.filter(({ id }) => id === production.workers[0].name);
    if (coreScriptRows.length !== 1 || !scriptTagPattern.test(coreScriptRows[0].tag ?? ""))
      fail("review token rotation authority core script identity drift");
    const productionBaselineUnsigned = {
      source: "workers-builds-review-token-rotation-production-baseline",
      accountId, sourceSha, capturedAt: new Date().toISOString(),
      currentReviewActiveProofDigest: current.proof_digest,
      productionPreservationDigest, productionScriptTag: coreScriptRows[0].tag,
    };
    const productionBaselineProof = { ...productionBaselineUnsigned,
      proof_digest: digestJson(productionBaselineUnsigned) };
    await writePrivateProof(
      process.env.ATRINIK_REVIEW_TOKEN_ROTATION_PRODUCTION_BASELINE_PROOF_OUTPUT_FILE,
      productionBaselineProof);
    const proof = issueReviewTokenRotationAuthority({ production, review, accountId, sourceSha,
      ...evidence, currentReviewActiveProof: current,
      tokenRows: { production: productionToken, review: reviewToken },
      productionBaselineProof });
    await writePrivateProof(process.env.ATRINIK_REVIEW_TOKEN_ROTATION_AUTHORITY_PROOF_OUTPUT_FILE,
      proof);
    process.stdout.write(`${JSON.stringify({ outcome: proof.outcome, mutation: false,
      sourceSha, expiresAt: proof.expiresAt, proof_digest: proof.proof_digest,
      production_trigger_uuid: proof.journalIdentities.productionTriggerUuid,
      review_trigger_uuid: proof.journalIdentities.reviewTriggerUuid,
      predecessor_review_build_token_uuid:
        proof.journalIdentities.predecessorReviewBuildTokenUuid })}\n`);
    return;
  }
  if (mode === "--verify-review-token-rotation-authority-proof") {
    const accountId = await readPrivateValue(process.env.ATRINIK_CLOUDFLARE_ACCOUNT_ID_FILE,
      "Cloudflare account ID", accountIdPattern);
    const { proof, validation } = await readAndValidateReviewTokenRotationAuthority({
      production, review, accountId, sourceSha });
    process.stdout.write(`${JSON.stringify({ outcome: validation.outcome, mutation: false,
      sourceSha, expiresAt: validation.expiresAt, proof_digest: proof.proof_digest })}\n`);
    return;
  }
  if (mode === "--verify-review-token-rotation-authority-proof-historical") {
    const accountId = await readPrivateValue(process.env.ATRINIK_CLOUDFLARE_ACCOUNT_ID_FILE,
      "Cloudflare account ID", accountIdPattern);
    const proof = await readPrivateJson(
      process.env.ATRINIK_REVIEW_TOKEN_ROTATION_AUTHORITY_PROOF_FILE,
      "review token rotation authority proof");
    validateHistoricalReviewTokenRotationAuthority(proof,
      { production, review, accountId, sourceSha });
    process.stdout.write(`${JSON.stringify({ outcome: "workers-builds-review-token-rotation-historical-authority-valid",
      mutation: false, sourceSha, proof_digest: proof.proof_digest })}\n`);
    return;
  }
  if (mode ===
      "--verify-review-token-rotation-provider-normalized-authority-proof-historical") {
    const accountId = await readPrivateValue(process.env.ATRINIK_CLOUDFLARE_ACCOUNT_ID_FILE,
      "Cloudflare account ID", accountIdPattern);
    const authorityPath = process.env.ATRINIK_REVIEW_TOKEN_ROTATION_AUTHORITY_PROOF_FILE;
    const proof = await readPrivateJson(authorityPath,
      "provider-normalized incident review token rotation authority proof");
    validateHistoricalReviewTokenRotationAuthority(proof, { production, review, accountId,
      sourceSha: incidentCoordinate.sourceSha, planDigest: incidentCoordinate.planDigest });
    if (await readPrivateFileSha256(authorityPath,
      "provider-normalized incident review token rotation authority proof") !==
        incidentCoordinate.authorityFileSha256)
      fail("provider-normalized incident authority file drift");
    process.stdout.write(`${JSON.stringify({
      outcome: "workers-builds-review-token-rotation-provider-normalized-historical-authority-valid",
      mutation: false, sourceSha, authoritySourceSha: incidentCoordinate.sourceSha,
      proof_digest: proof.proof_digest })}\n`);
    return;
  }
  if (mode === "--verify-review-token-rotation-provider-normalized-incident") {
    const accountId = await readPrivateValue(process.env.ATRINIK_CLOUDFLARE_ACCOUNT_ID_FILE,
      "Cloudflare account ID", accountIdPattern);
    const authorityPath = process.env.ATRINIK_REVIEW_TOKEN_ROTATION_AUTHORITY_PROOF_FILE;
    const authorityProof = await readPrivateJson(authorityPath,
      "review token rotation authority proof");
    const evidence = await readReviewTokenRotationAuthorityEvidence(process.env);
    validateHistoricalReviewTokenRotationAuthority(authorityProof, { production, review,
      accountId, sourceSha: incidentCoordinate.sourceSha,
      planDigest: incidentCoordinate.planDigest });
    const replacementReviewTokenUuid = await readPrivateValue(
      process.env.ATRINIK_REPLACEMENT_REVIEW_BUILD_TOKEN_UUID_FILE,
      "replacement review build token UUID", uuidPattern);
    const snapshotDirectory = await readPrivateValue(
      process.env.ATRINIK_REVIEW_TOKEN_ROTATION_PROVIDER_NORMALIZED_INCIDENT_SNAPSHOT_DIRECTORY_FILE,
      "provider-normalized incident snapshot directory");
    const forwardJournalPath =
      process.env.ATRINIK_REVIEW_TOKEN_ROTATION_PROVIDER_NORMALIZED_FORWARD_JOURNAL_FILE;
    const forwardRecords = await readPrivateJsonLines(forwardJournalPath,
      "provider-normalized forward journal");
    const incidentProof = await validateReviewTokenRotationSnapshotDirectory({
      snapshotDirectory, production, review, accountId,
      sourceSha: incidentCoordinate.sourceSha,
      phase: "production-repointed-review-augmented",
      productionSentinelProof: evidence.productionSentinelProof,
      predecessorTokenAuthorityProofs: evidence.predecessorTokenAuthorityProofs,
      replacementTokenAuthorityProof: evidence.replacementTokenAuthorityProof,
      replacementTokenId: evidence.replacementTokenId,
      productionTriggerUuid: authorityProof.journalIdentities.productionTriggerUuid,
      reviewTriggerUuid: authorityProof.journalIdentities.reviewTriggerUuid,
      predecessorReviewTokenUuid:
        authorityProof.journalIdentities.predecessorReviewBuildTokenUuid,
      replacementReviewTokenUuid, productionPreservationDigest:
        authorityProof.productionPreservationDigest, authorityProof,
      productionBaselineProof: evidence.productionBaselineProof,
      authoritySourceSha: incidentCoordinate.sourceSha,
      authorityPlanDigest: incidentCoordinate.planDigest,
      now: Date.parse((await loadSnapshot(snapshotDirectory,
        "snapshot-manifest.json")).completedAt),
    });
    const validation = validateReviewTokenRotationProviderNormalizedIncidentCore(forwardRecords,
      incidentProof, authorityProof, { production, review, accountId,
        forwardJournalSha256: await readPrivateFileSha256(forwardJournalPath,
          "provider-normalized forward journal"),
        incidentSnapshotManifestSha256: await readPrivateFileSha256(
          resolve(snapshotDirectory, "snapshot-manifest.json"),
          "provider-normalized incident snapshot manifest"),
        authorityFileSha256: await readPrivateFileSha256(authorityPath,
          "review token rotation authority proof") }, providerNormalizedTestCapability);
    await writePrivateProof(
      process.env.ATRINIK_REVIEW_TOKEN_ROTATION_PROVIDER_NORMALIZED_INCIDENT_PROOF_OUTPUT_FILE,
      incidentProof);
    process.stdout.write(`${JSON.stringify({ ...validation,
      proof_digest: incidentProof.proof_digest })}\n`);
    return;
  }
  if (["--verify-review-token-rotation-pre-create",
    "--verify-review-token-rotation-pre-production",
    "--verify-review-token-rotation-intermediate",
    "--verify-review-token-rotation-provider-peer-normalization",
    "--verify-review-token-rotation-rollback-precondition",
    "--verify-review-token-rotation-unreferenced",
    "--verify-review-token-rotation-complete",
    "--verify-review-token-rotation-complete-historical",
    "--verify-review-token-rotation-rollback-restored",
    "--verify-review-token-rotation-rollback-complete"].includes(mode)) {
    const accountId = await readPrivateValue(process.env.ATRINIK_CLOUDFLARE_ACCOUNT_ID_FILE,
      "Cloudflare account ID", accountIdPattern);
    const token = await readPrivateValue(process.env.ATRINIK_WORKERS_BUILDS_API_TOKEN_FILE,
      "Workers Builds API token");
    const productionReadToken = await readPrivateValue(
      process.env.ATRINIK_PRODUCTION_BUILD_TOKEN_SECRET_FILE,
      "production D1 read API token");
    const rollbackMode = mode.includes("-rollback-");
    const historicalCompleteMode = mode.endsWith("-complete-historical");
    const peerNormalizationMode = mode.endsWith("-provider-peer-normalization");
    const rollbackPreconditionMode = mode.endsWith("-rollback-precondition");
    const historicalMode = rollbackMode || historicalCompleteMode || peerNormalizationMode;
    const authority = historicalMode ? {
      proof: await readPrivateJson(process.env.ATRINIK_REVIEW_TOKEN_ROTATION_AUTHORITY_PROOF_FILE,
        "review token rotation authority proof"),
      evidence: await readReviewTokenRotationAuthorityEvidence(process.env),
    } : await readAndValidateReviewTokenRotationAuthority({ production, review,
      accountId, sourceSha });
    if (historicalMode) {
      const historicalIncident = authority.proof.sourceSha ===
          reviewTokenRotationProviderNormalizedIncident.sourceSha &&
        authority.proof.planDigest === reviewTokenRotationProviderNormalizedIncident.planDigest;
      validateHistoricalReviewTokenRotationAuthority(authority.proof,
      { production, review, accountId,
        sourceSha: historicalIncident ?
          reviewTokenRotationProviderNormalizedIncident.sourceSha : sourceSha,
        planDigest: historicalIncident ?
          reviewTokenRotationProviderNormalizedIncident.planDigest :
          digestJson(provisioningSetupPlan(production, review)) });
    }
    const preCreateMode = mode.endsWith("-pre-create");
    const preProductionMode = mode.endsWith("-pre-production");
    const replacementReviewTokenUuid = preCreateMode ? undefined : await readPrivateValue(
      process.env.ATRINIK_REPLACEMENT_REVIEW_BUILD_TOKEN_UUID_FILE,
      "replacement review build token UUID", uuidPattern);
    const outputDirectory = process.env.ATRINIK_PROVIDER_SNAPSHOT_OUTPUT;
    await providerSnapshotReader({ accountId, token, productionReadToken,
      outputDirectory, production, review, sourceSha });
    const phase = rollbackPreconditionMode ? await readPrivateValue(
      process.env.ATRINIK_REVIEW_TOKEN_ROTATION_ROLLBACK_PRECONDITION_PHASE_FILE,
      "review token rotation rollback precondition phase",
      /^(?:production-repointed|review-repointed|production-repointed-review-augmented)$/u) :
      preCreateMode ? "predecessor" :
      preProductionMode ? "replacement-created" :
      mode.endsWith("-intermediate") ? "production-repointed" :
      mode.endsWith("-unreferenced") ? "old-wrapper-unreferenced" :
      mode.endsWith("-rollback-restored") ? "predecessor-restored" :
      mode.endsWith("-rollback-complete") ? "predecessor" : "complete";
    const identities = authority.proof.journalIdentities;
    const snapshotArguments = {
      snapshotDirectory: outputDirectory, production, review, accountId, sourceSha, phase,
      productionSentinelProof: authority.evidence.productionSentinelProof,
      predecessorTokenAuthorityProofs: authority.evidence.predecessorTokenAuthorityProofs,
      replacementTokenAuthorityProof: authority.evidence.replacementTokenAuthorityProof,
      replacementTokenId: authority.evidence.replacementTokenId,
      productionTriggerUuid: identities.productionTriggerUuid,
      reviewTriggerUuid: identities.reviewTriggerUuid,
      predecessorReviewTokenUuid: identities.predecessorReviewBuildTokenUuid,
      replacementReviewTokenUuid: phase === "predecessor" ? undefined :
        replacementReviewTokenUuid,
      productionPreservationDigest: authority.proof.productionPreservationDigest,
      authorityProof: authority.proof,
      productionBaselineProof: authority.evidence.productionBaselineProof,
      authoritySourceSha: authority.proof.sourceSha,
      authorityPlanDigest: authority.proof.planDigest,
    };
    const result = mode.endsWith("-intermediate") ?
      await validateReviewTokenRotationForwardPeerNormalizationSnapshotDirectory(
        snapshotArguments) : peerNormalizationMode ?
      await validateReviewTokenRotationProviderPeerNormalizationSnapshotDirectory(
        snapshotArguments) :
      await validateReviewTokenRotationSnapshotDirectory(snapshotArguments);
    const observationCurrentMainProof = await readCurrentMainProof(process.env, sourceSha);
    const output = preCreateMode ?
      process.env.ATRINIK_REVIEW_TOKEN_ROTATION_PRE_CREATE_PROOF_OUTPUT_FILE :
      preProductionMode ?
      process.env.ATRINIK_REVIEW_TOKEN_ROTATION_PRE_PRODUCTION_PROOF_OUTPUT_FILE :
      rollbackPreconditionMode ?
        process.env.ATRINIK_REVIEW_TOKEN_ROTATION_ROLLBACK_PRECONDITION_PROOF_OUTPUT_FILE :
      peerNormalizationMode ?
      process.env.ATRINIK_REVIEW_TOKEN_ROTATION_PEER_NORMALIZATION_PROOF_OUTPUT_FILE :
      phase === "production-repointed" ?
      process.env.ATRINIK_REVIEW_TOKEN_ROTATION_INTERMEDIATE_PROOF_OUTPUT_FILE :
      phase === "old-wrapper-unreferenced" ?
        process.env.ATRINIK_REVIEW_TOKEN_ROTATION_UNREFERENCED_PROOF_OUTPUT_FILE :
        phase === "predecessor-restored" ?
          process.env.ATRINIK_REVIEW_TOKEN_ROTATION_ROLLBACK_RESTORED_PROOF_OUTPUT_FILE :
          phase === "predecessor" ?
            process.env.ATRINIK_REVIEW_TOKEN_ROTATION_ROLLBACK_COMPLETE_PROOF_OUTPUT_FILE :
            process.env.ATRINIK_REVIEW_TOKEN_ROTATION_COMPLETE_PROOF_OUTPUT_FILE;
    await writePrivateProof(output, result);
    process.stdout.write(`${JSON.stringify({ outcome: result.outcome, mutation: false,
      sourceSha, proof_digest: result.proof_digest,
      current_main_proof_digest: digestJson(observationCurrentMainProof) })}\n`);
    return;
  }
  if (mode === "--verify-disposable-review-authority-proof" ||
      mode === "--verify-disposable-review-authority-push") {
    const accountId = await readPrivateValue(process.env.ATRINIK_CLOUDFLARE_ACCOUNT_ID_FILE,
      "Cloudflare account ID", accountIdPattern);
    const { proof, evidence, validation } = await readAndValidateDisposableReviewAuthority({
      production, review, accountId, sourceSha,
      minimumRemainingMs: mode === "--verify-disposable-review-authority-push" ?
        disposableReviewPushReserveMs : reviewActivationTransitionBudgetMs });
    const operation = mode === "--verify-disposable-review-authority-push" ? "push" : "delete";
    const receiptPath = operation === "push" ? evidence.disposableCoordinate.pushReceiptPath :
      evidence.disposableCoordinate.deleteReceiptPath;
    const requestedReceiptPath = operation === "push" ?
      process.env.ATRINIK_DISPOSABLE_REVIEW_PUSH_AUTHORIZATION_RECEIPT_OUTPUT_FILE :
      process.env.ATRINIK_DISPOSABLE_REVIEW_DELETE_AUTHORIZATION_RECEIPT_OUTPUT_FILE;
    if (requestedReceiptPath !== receiptPath)
      fail("disposable review authorization receipt path drift");
    const receipt = { outcome: "workers-builds-disposable-review-write-authorized",
      mutation: false, operation, sourceSha, authorityProofDigest: proof.proof_digest,
      journalId: evidence.disposableCoordinate.journalId,
      branch: evidence.disposableCoordinate.branch, commit: evidence.disposableCoordinate.commit,
      checkedAt: validation.checkedAt, expiresAt: validation.expiresAt };
    await writePrivateProof(receiptPath, receipt);
    process.stdout.write(`${JSON.stringify({ outcome: validation.outcome, mutation: false,
      sourceSha, expiresAt: validation.expiresAt, proof_digest: proof.proof_digest,
      authorizationReceiptDigest: digestJson(receipt) })}\n`);
    return;
  }
  if (mode === "--verify-review-activation-authority-proof") {
    const accountId = await readPrivateValue(process.env.ATRINIK_CLOUDFLARE_ACCOUNT_ID_FILE,
      "Cloudflare account ID", accountIdPattern);
    const { proof, validation } = await readAndValidateReviewActivationAuthority({
      production, review, accountId, sourceSha,
    });
    process.stdout.write(`${JSON.stringify({ outcome: validation.outcome, mutation: false,
      sourceSha, expiresAt: validation.expiresAt, proof_digest: proof.proof_digest })}\n`);
    return;
  }
  if (mode === "--verify-review-staging-root-create" ||
      mode === "--verify-review-staging-root-activation") {
    const accountId = await readPrivateValue(process.env.ATRINIK_CLOUDFLARE_ACCOUNT_ID_FILE,
      "Cloudflare account ID", accountIdPattern);
    await readAndValidateReviewActivationAuthority({ production, review, accountId, sourceSha });
    const activation = mode === "--verify-review-staging-root-activation";
    const proofVariable = activation ? "ATRINIK_REVIEW_STAGING_ROOT_ACTIVATION_PROOF_FILE" :
      "ATRINIK_REVIEW_STAGING_ROOT_CREATE_PROOF_FILE";
    const proof = await readReviewStagingRootProof(proofVariable,
      activation ? "activation" : "create", process.env, sourceSha);
    if (activation) {
      const create = await readReviewStagingRootProof(
        "ATRINIK_REVIEW_STAGING_ROOT_CREATE_PROOF_FILE", "create", process.env, sourceSha);
      validateReviewStagingRootProofSequence(create, proof);
    }
    process.stdout.write(`${JSON.stringify({ outcome: proof.outcome, mutation: false,
      sourceSha: proof.sourceSha, proof_digest: proof.proof_digest })}\n`);
    return;
  }
  if (mode === "--verify-review-staged-environment") {
    const accountId = await readPrivateValue(process.env.ATRINIK_CLOUDFLARE_ACCOUNT_ID_FILE,
      "Cloudflare account ID", accountIdPattern);
    const token = await readPrivateValue(process.env.ATRINIK_WORKERS_BUILDS_API_TOKEN_FILE,
      "Workers Builds API token");
    const productionReadToken = await readPrivateValue(
      process.env.ATRINIK_PRODUCTION_BUILD_TOKEN_SECRET_FILE,
      "production D1 read API token");
    const authority = await readAndValidateReviewActivationAuthority({ production, review,
      accountId, sourceSha });
    const tokenAuthorityProofs = authority.evidence.tokenAuthorityProofs;
    const outputDirectory = process.env.ATRINIK_PROVIDER_SNAPSHOT_OUTPUT;
    await providerSnapshotReader({ accountId, token, productionReadToken, outputDirectory,
      production, review, sourceSha });
    const proof = await validateReviewStagedEnvironmentSnapshotDirectory({
      snapshotDirectory: outputDirectory, production, review, accountId, sourceSha,
      tokenAuthorityProofs, reviewActivationAuthorityProof: authority.proof,
      reviewActivationAuthorityEvidence: authority.evidence,
      reviewActivationAuthorityCheckpoint: authority.validation,
    });
    await writePrivateProof(process.env.ATRINIK_REVIEW_STAGED_ENVIRONMENT_PROOF_OUTPUT_FILE,
      proof);
    process.stdout.write(`${JSON.stringify({ outcome: proof.outcome, mutation: false,
      sourceSha, proof_digest: proof.proof_digest })}\n`);
    return;
  }
  if (mode === "--verify-staged-proof") {
    const accountId = await readPrivateValue(process.env.ATRINIK_CLOUDFLARE_ACCOUNT_ID_FILE,
      "Cloudflare account ID", accountIdPattern);
    const token = await readPrivateValue(process.env.ATRINIK_WORKERS_BUILDS_API_TOKEN_FILE,
      "Workers Builds API token");
    const productionReadToken = await readPrivateValue(
      process.env.ATRINIK_PRODUCTION_BUILD_TOKEN_SECRET_FILE,
      "production D1 read API token");
    const tokenAuthorityProofs = [
      await readPrivateJson(process.env.ATRINIK_PRODUCTION_BUILD_TOKEN_PERMISSION_PROOF_FILE,
        "production build token permission proof"),
      await readPrivateJson(process.env.ATRINIK_REVIEW_BUILD_TOKEN_PERMISSION_PROOF_FILE,
        "review build token permission proof"),
    ];
    const activationSnapshotDirectory = process.env.ATRINIK_PROVIDER_SNAPSHOT_OUTPUT;
    await providerSnapshotReader({ accountId, token, productionReadToken,
      outputDirectory: activationSnapshotDirectory, production, review, sourceSha });
    const current = await validateStagedSnapshotDirectory({
      snapshotDirectory: activationSnapshotDirectory,
      production, review, accountId, tokenAuthorityProofs, sourceSha,
    });
    const proof = await readPrivateJson(process.env.ATRINIK_STAGED_PROOF_FILE,
      "staged activation proof");
    process.stdout.write(`${JSON.stringify(validateStagedProof(proof, current))}\n`);
    return;
  }
  if (mode === "--verify-review-activation" || mode === "--verify-production-activation") {
    const accountId = await readPrivateValue(process.env.ATRINIK_CLOUDFLARE_ACCOUNT_ID_FILE,
      "Cloudflare account ID", accountIdPattern);
    const token = await readPrivateValue(process.env.ATRINIK_WORKERS_BUILDS_API_TOKEN_FILE,
      "Workers Builds API token");
    const productionReadToken = await readPrivateValue(
      process.env.ATRINIK_PRODUCTION_BUILD_TOKEN_SECRET_FILE,
      "production D1 read API token");
    const tokenAuthorityProofs = [
      await readPrivateJson(process.env.ATRINIK_PRODUCTION_BUILD_TOKEN_PERMISSION_PROOF_FILE,
        "production build token permission proof"),
      await readPrivateJson(process.env.ATRINIK_REVIEW_BUILD_TOKEN_PERMISSION_PROOF_FILE,
        "review build token permission proof"),
    ];
    const requireReviewResult = mode === "--verify-production-activation";
    const authority = requireReviewResult ? null :
      await readAndValidateReviewActivationAuthority({ production, review, accountId, sourceSha });
    const outputDirectory = process.env.ATRINIK_PROVIDER_SNAPSHOT_OUTPUT;
    await providerSnapshotReader({ accountId, token, productionReadToken, outputDirectory,
      production, review, sourceSha });
    const reviewResultProof = requireReviewResult ? await readPrivateJson(
      process.env.ATRINIK_REVIEW_RESULT_PROOF_FILE, "disposable review result proof") : undefined;
    const proof = await validateStagedSnapshotDirectory({ snapshotDirectory: outputDirectory,
      production, review, accountId, tokenAuthorityProofs, sourceSha,
    }, { reviewActive: true, requireReviewResult, reviewResultProof,
      reviewActivationAuthorityProof: authority?.proof,
      reviewActivationAuthorityEvidence: authority?.evidence,
      reviewActivationAuthorityCheckpoint: authority?.validation });
    await writePrivateProof(requireReviewResult ?
      process.env.ATRINIK_PRODUCTION_ACTIVATION_PROOF_OUTPUT_FILE :
      process.env.ATRINIK_REVIEW_ACTIVATION_PROOF_OUTPUT_FILE, proof);
    process.stdout.write(`${JSON.stringify(publicStagedProofSummary(proof))}\n`);
    return;
  }
  if (mode === "--verify-configured") {
    const accountId = await readPrivateValue(process.env.ATRINIK_CLOUDFLARE_ACCOUNT_ID_FILE,
      "Cloudflare account ID", accountIdPattern);
    const tokenAuthorityProofs = [
      await readPrivateJson(process.env.ATRINIK_PRODUCTION_BUILD_TOKEN_PERMISSION_PROOF_FILE,
        "production build token permission proof"),
      await readPrivateJson(process.env.ATRINIK_REVIEW_BUILD_TOKEN_PERMISSION_PROOF_FILE,
        "review build token permission proof"),
    ];
    process.stdout.write(`${JSON.stringify(await validateConfiguredSnapshotDirectory({
      snapshotDirectory: process.env.ATRINIK_PROVIDER_SNAPSHOT_DIRECTORY,
      production, review, accountId, tokenAuthorityProofs, sourceSha,
    }))}\n`);
    return;
  }
  fail("unknown Workers Builds provisioning mode");
}

export async function runProvisioningCli(mode = process.argv[2] ?? "--validate-only",
sourceShaLoader = reviewedCurrentMainSha, providerSnapshotReader = readProviderSnapshot) {
  return runProvisioningCliCore(mode, sourceShaLoader, providerSnapshotReader);
}

export async function runProvisioningCliForTest(mode, sourceShaLoader,
providerSnapshotReader, testCapabilities, blockedDeleteTerminalContextReader = undefined,
noOwnedTerminalContextReader = undefined) {
  return runProvisioningCliCore(mode, sourceShaLoader, providerSnapshotReader, testCapabilities,
    blockedDeleteTerminalContextReader, noOwnedTerminalContextReader);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  runProvisioningCli().catch((error) => {
    const reason = error instanceof WorkersBuildsProvisioningError
      ? error.message : "unexpected-internal-error";
    process.stderr.write(`${JSON.stringify({ outcome: "workers-builds-provisioning-stopped", reason })}\n`);
    process.exitCode = 1;
  });
