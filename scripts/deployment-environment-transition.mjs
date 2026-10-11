// Copyright (C) 2026 Atrinik contributors
// Operator-only provider transition. No Worker upload, secret deletion, or PROD reactivation.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, mkdir, rmdir, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const fail = (message) => { throw new Error(`deployment transition: ${message}`); };
const same = (a, b) => transitionDigest(a) === transitionDigest(b);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const identifier = /^[a-zA-Z0-9_-]{1,128}$/u;
const hash = /^[0-9a-f]{64}$/u;
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
export const transitionDigest = (value) => createHash("sha256")
  .update(JSON.stringify(canonical(value))).digest("hex");

export function normalizeTransitionTrigger(trigger) {
  // Provider timestamps are observation metadata, never editable configuration.
  if (trigger?.deleted_on != null) fail("deleted trigger in live inventory");
  if (trigger?.repo_connection?.deleted_on != null)
    fail("deleted repository connection in live inventory");
  const result = structuredClone(trigger);
  for (const key of ["created_on", "modified_on", "deleted_on", "build_token_name"])
    delete result[key];
  if (result.repo_connection) for (const key of ["created_on", "modified_on", "deleted_on"])
    delete result.repo_connection[key];
  return result;
}
function normalizedTriggers(rows) {
  if (!Array.isArray(rows)) fail("missing trigger inventory");
  const result = rows.map(normalizeTransitionTrigger).sort((a, b) =>
    a.trigger_uuid.localeCompare(b.trigger_uuid));
  if (new Set(result.map((r) => r.trigger_uuid)).size !== result.length)
    fail("duplicate trigger identity");
  return result;
}
function secretManifest(environment) {
  if (!environment || typeof environment !== "object" || Array.isArray(environment))
    fail("missing environment inventory");
  for (const [name, item] of Object.entries(environment)) {
    if (!/^[A-Z][A-Z0-9_]*$/u.test(name) || typeof item?.is_secret !== "boolean" ||
        (item.is_secret ? item.value !== null : typeof item.value !== "string"))
      fail("environment must contain redacted secret classifications");
  }
  return environment;
}
function selected(rows, id) {
  const matches = rows.filter((r) => r.trigger_uuid === id);
  if (matches.length !== 1) fail("trigger identity missing or ambiguous");
  return matches[0];
}
function activeBuilds(builds, policy) {
  if (!Array.isArray(builds)) fail("missing exhaustive build inventory");
  const ids = new Set();
  return builds.filter((build) => {
    if (!uuid.test(build.build_uuid) || ids.has(build.build_uuid) ||
        !["queued", "initializing", "running", "stopped"].includes(build.status) ||
        ![policy.productionTriggerUuid, policy.reviewTriggerUuid].includes(build.trigger?.trigger_uuid) ||
        build.trigger?.external_script_id !== policy.externalScriptId)
      fail("unknown or duplicate production build identity/status");
    ids.add(build.build_uuid);
    if (build.trigger.trigger_uuid === policy.reviewTriggerUuid && build.status !== "stopped") {
      const review = policy.reviewTrigger;
      const metadata = build.build_trigger_metadata;
      const { build_token_uuid: expectedToken, ...expectedTrigger } = review ?? {};
      const { build_token_uuid: observedToken, ...observedTrigger } = normalizeTransitionTrigger(build.trigger);
      if (!review || !same(observedTrigger, expectedTrigger) ||
          (observedToken !== undefined && observedToken !== expectedToken) ||
          metadata?.build_token_uuid !== expectedToken || metadata.build_command !== "npm run build" ||
          metadata.deploy_command !== "npm run validate" || metadata.root_directory !== "/deployment/review-check" ||
          typeof metadata.branch !== "string" || metadata.branch === "main" ||
          metadata.provider_type !== "github" || metadata.provider_account_name !== "atrinik" ||
          metadata.repo_name !== "metaserver-worker")
        fail("in-flight review build launch authority is unsafe or unproven");
    }
    return build.trigger.trigger_uuid === policy.productionTriggerUuid && build.status !== "stopped";
  });
}
function validateRetainedInertEnvironment(environment, role) {
  const allowedSecrets = role === "production" ? [
    "ATRINIK_PRODUCTION_CONTROL_PLANE_READY", "ATRINIK_PRODUCTION_CORE_CONFIG",
    "ATRINIK_PRODUCTION_PUBLISHER_CONFIG", "ATRINIK_PRODUCTION_RENDEZVOUS_CONFIG",
    "ATRINIK_WORKERS_BUILDS_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID",
  ] : ["ATRINIK_WORKERS_BUILDS_API_TOKEN"];
  secretManifest(environment);
  if (!environment.SKIP_DEPENDENCY_INSTALL ||
      !same(environment.SKIP_DEPENDENCY_INSTALL, { is_secret: false, value: "1" }) ||
      Object.entries(environment).some(([name, value]) => name !== "SKIP_DEPENDENCY_INSTALL" &&
        (!allowedSecrets.includes(name) || value.is_secret !== true || value.value !== null)))
    fail("retained inert Builds environment is unsafe");
}

export function validateProductionWriterFence({ triggers, builds, environments }, policy) {
  const disposition = policy.disposition ?? "credential-free-review";
  if (!["credential-free-review", "retained-inert-builds"].includes(disposition))
    fail("unknown production writer fence disposition");
  const rows = normalizedTriggers(triggers);
  if (rows.length !== 2) fail("unexpected production trigger count");
  const production = selected(rows, policy.productionTriggerUuid);
  const review = selected(rows, policy.reviewTriggerUuid);
  if (production.external_script_id !== policy.externalScriptId ||
      review.external_script_id !== policy.externalScriptId ||
      !uuid.test(production.build_token_uuid) || !uuid.test(review.build_token_uuid) ||
      !same(production.branch_includes, ["main"]) ||
      !same(production.branch_excludes, ["*"]) ||
      !same(review.branch_includes, ["*"]) ||
      !hash.test(policy.productionTriggerDigest) || !hash.test(policy.reviewTriggerDigest) ||
      transitionDigest(production) !== policy.productionTriggerDigest ||
      transitionDigest(review) !== policy.reviewTriggerDigest)
    fail("production writer fence or review trigger drift");
  for (const [id, expected] of [[policy.productionTriggerUuid, policy.productionEnvironmentDigest],
    [policy.reviewTriggerUuid, policy.reviewEnvironmentDigest]]) {
    if (!hash.test(expected) || transitionDigest(secretManifest(environments?.[id])) !== expected)
      fail("production environment drift");
  }
  if (disposition === "retained-inert-builds") {
    // Cloudflare retry uses current build configuration. Exclusion alone cannot stop manual retries.
    // https://developers.cloudflare.com/workers/ci-cd/builds/configuration/#build-settings
    // This disposition validates an operator-established state; it never creates or restores authority.
    for (const [index, trigger] of [production, review].entries()) {
      if (!same(trigger.branch_excludes, index === 0 ? ["*"] : ["main", "*"]) || trigger.build_command !== "exit 1" ||
          trigger.deploy_command !== "exit 1" || trigger.build_caching_enabled !== false)
        fail("retained Builds trigger is executable or not excluded");
    }
    validateRetainedInertEnvironment(environments[policy.productionTriggerUuid], "production");
    validateRetainedInertEnvironment(environments[policy.reviewTriggerUuid], "review");
    if (!Array.isArray(builds) || builds.some(build => build.status !== "stopped"))
      fail("retained Builds writer still in flight");
  } else {
    if (production.build_command !== "exit 1" || production.deploy_command !== "exit 1")
      fail("former production trigger remains executable");
    validateRetainedInertEnvironment(environments[policy.productionTriggerUuid], "production");
    if (!same(review.branch_excludes, ["main"]) ||
        review.build_command !== "npm run build" || review.deploy_command !== "npm run validate" ||
        review.root_directory !== "/deployment/review-check" ||
        !same(review.path_includes, ["*"]) || !same(review.path_excludes, []) ||
        review.build_caching_enabled !== false ||
        !same(environments?.[policy.reviewTriggerUuid],
          { SKIP_DEPENDENCY_INSTALL: { is_secret: false, value: "1" } }) ||
        production.build_token_uuid === review.build_token_uuid)
      fail("production writer fence or review trigger drift");
  }
  if (activeBuilds(builds, { ...policy, reviewTrigger: review }).length) fail("production writer still in flight");
  return { outcome: "production-writer-fenced", disposition, mutation: false };
}

function snapshotCheck(snapshot, coordinates, now) {
  if (snapshot.accountId !== coordinates.accountId || snapshot.complete !== true ||
      snapshot.stable !== true || !Number.isFinite(Date.parse(snapshot.capturedAt)) ||
      Date.parse(snapshot.capturedAt) > now || now - Date.parse(snapshot.capturedAt) > 30_000)
    fail("snapshot account, completeness, stability or freshness mismatch");
  if (!same(snapshot.workers, coordinates.workers)) fail("worker environment identity drift");
  for (const target of ["production", "development"]) {
    if (coordinates.workers[target]?.length !== 3) fail("three workers required per environment");
    const expectedNames = target === "production" ?
      ["atrinik-metaserver", "atrinik-metaserver-publisher", "atrinik-metaserver-rendezvous"] :
      ["atrinik-metaserver-development", "atrinik-metaserver-development-publisher", "atrinik-metaserver-development-rendezvous"];
    if (!same(coordinates.workers[target].map((w) => w.name).sort(), expectedNames))
      fail("wrong environment worker names");
    const roles = coordinates.workers[target].map((w) => w.role).sort();
    if (!same(roles, ["core", "publisher", "rendezvous"])) fail("worker roles mismatch");
    for (const worker of coordinates.workers[target]) {
      const expectedName = `atrinik-metaserver${target === "development" ? "-development" : ""}${worker.role === "core" ? "" : `-${worker.role}`}`;
      if (worker.name !== expectedName || !identifier.test(worker.name) || !/^[0-9a-f]{32}$/u.test(worker.tag))
        fail("invalid worker role identity");
      const active = snapshot.activeVersions?.[worker.name];
      if (!uuid.test(active)) fail("missing exact active worker version");
    }
  }
  const workers = Object.values(coordinates.workers).flat();
  if (new Set(workers.map((w) => w.name)).size !== 6 ||
      new Set(workers.map((w) => w.tag)).size !== 6) fail("cross-environment worker identity");
  if (!/^[0-9a-f]{32}$/u.test(coordinates.accountId) ||
      !uuid.test(coordinates.productionTriggerUuid) || !uuid.test(coordinates.reviewTriggerUuid) ||
      coordinates.productionTriggerUuid === coordinates.reviewTriggerUuid ||
      !uuid.test(coordinates.repositoryConnectionUuid)) fail("invalid account or trigger identity");
  const prodCore = coordinates.workers.production.find((w) => w.role === "core");
  for (const worker of workers.filter((w) => w.tag !== prodCore.tag)) {
    const inventory = snapshot.otherWorkers?.[worker.tag];
    if (!inventory || !Array.isArray(inventory.triggers) || inventory.triggers.length ||
        !Array.isArray(inventory.builds) || inventory.builds.some((b) => b.status !== "stopped"))
      fail("competing caller or development writer");
  }
}
function core(coordinates, environment) {
  return coordinates.workers[environment].find((w) => w.role === "core");
}
export function createTransitionPlan({ snapshot, coordinates, now = Date.now() }) {
  snapshotCheck(snapshot, coordinates, now);
  const prod = normalizedTriggers(snapshot.productionTriggers);
  if (prod.length !== 2 || normalizedTriggers(snapshot.developmentTriggers).length !== 0)
    fail("transition predecessor requires two PROD triggers and no DEV trigger");
  const old = selected(prod, coordinates.productionTriggerUuid);
  const review = selected(prod, coordinates.reviewTriggerUuid);
  if (old.external_script_id !== core(coordinates, "production").tag ||
      review.external_script_id !== old.external_script_id ||
      !same(old.branch_includes, ["main"]) ||
      ![transitionDigest([]), transitionDigest(["*"])].includes(transitionDigest(old.branch_excludes)) ||
      !same(review.branch_includes, ["*"]) || !same(review.branch_excludes, ["main"]) ||
      old.build_token_uuid === review.build_token_uuid ||
      old.repo_connection?.repo_connection_uuid !== coordinates.repositoryConnectionUuid ||
      !same(old.repo_connection, review.repo_connection) ||
      old.repo_connection.provider_type !== "github" ||
      old.repo_connection.provider_account_name !== "atrinik" ||
      old.repo_connection.repo_name !== "metaserver-worker") fail("predecessor trigger identity mismatch");
  if (review.build_command !== "npm run build" || review.deploy_command !== "npm run validate" ||
      review.root_directory !== "/deployment/review-check" ||
      !same(snapshot.environments?.[review.trigger_uuid],
        { SKIP_DEPENDENCY_INSTALL: { is_secret: false, value: "1" } }))
    fail("unsafe review predecessor");
  validateRetainedInertEnvironment(snapshot.environments?.[old.trigger_uuid], "production");
  productionFencePatchBody(old);
  const baselineVersions = Object.fromEntries(coordinates.workers.production.map((w) =>
    [w.name, snapshot.activeVersions[w.name]]));
  const plan = { schemaVersion: 1, kind: "metaserver-production-writer-fence", coordinates,
    predecessorDigest: transitionDigest(snapshot),
    predecessorProduction: old, review, baselineVersions,
    productionEnvironments: Object.fromEntries(prod.map((r) => [r.trigger_uuid,
      secretManifest(snapshot.environments?.[r.trigger_uuid])])),
  };
  plan.planDigest = transitionDigest(plan);
  activeBuilds(snapshot.productionBuilds, { ...coordinates, externalScriptId: old.external_script_id, reviewTrigger: review });
  return plan;
}
function checkPlan(plan) {
  const { planDigest, ...body } = plan;
  if (!hash.test(planDigest) || transitionDigest(body) !== planDigest) fail("plan digest mismatch");
}
function fencedProduction(trigger) {
  return { ...trigger, branch_excludes: ["*"], build_command: "exit 1", deploy_command: "exit 1" };
}
export function productionFencePatchBody(trigger) {
  const fenced = fencedProduction(normalizeTransitionTrigger(trigger));
  const fields = ["trigger_name", "external_script_id", "build_token_uuid", "build_command", "deploy_command",
    "root_directory", "branch_includes", "branch_excludes", "path_includes", "path_excludes", "build_caching_enabled"];
  if (fields.some(field => fenced[field] === undefined) || !uuid.test(fenced.repo_connection?.repo_connection_uuid))
    fail("production trigger lacks a complete editable predecessor");
  return { ...Object.fromEntries(fields.map(field => [field, structuredClone(fenced[field])])),
    repo_connection_uuid: fenced.repo_connection.repo_connection_uuid };
}
function preservation(plan, snapshot, now) {
  checkPlan(plan);
  snapshotCheck(snapshot, plan.coordinates, now);
  for (const [name, version] of Object.entries(plan.baselineVersions))
    if (snapshot.activeVersions[name] !== version) fail("active production version changed");
  const prod = normalizedTriggers(snapshot.productionTriggers);
  if (prod.length !== 2 || !same(selected(prod, plan.coordinates.reviewTriggerUuid), plan.review) ||
      !same(Object.fromEntries(prod.map((r) => [r.trigger_uuid,
        secretManifest(snapshot.environments?.[r.trigger_uuid])])), plan.productionEnvironments))
    fail("production peer or protected environment changed");
  const current = selected(prod, plan.coordinates.productionTriggerUuid);
  const fenced = fencedProduction(plan.predecessorProduction);
  if (!same(current, plan.predecessorProduction) && !same(current, fenced))
    fail("production predecessor drift");
  return { current, fenced };
}
function snapshotStateDigest(snapshot) {
  const { capturedAt: _capturedAt, ...state } = snapshot;
  return transitionDigest(state);
}
function operation(plan, snapshot, phase, method, suffix, body, extra = {}) {
  return { phase, method, path: `/accounts/${plan.coordinates.accountId}${suffix}`, body,
    planDigest: plan.planDigest, predecessorDigest: transitionDigest(snapshot),
    predecessorStateDigest: snapshotStateDigest(snapshot),
    capturedAt: snapshot.capturedAt, expiresAt: new Date(Date.parse(snapshot.capturedAt) + 30_000).toISOString(), ...extra };
}
export function nextTransitionOperation({ plan, snapshot, now = Date.now() }) {
  const { current, fenced } = preservation(plan, snapshot, now);
  const coordinates = plan.coordinates;
  if (!same(current, fenced)) return operation(plan, snapshot, "fence-production", "PATCH",
    `/builds/triggers/${coordinates.productionTriggerUuid}`, productionFencePatchBody(plan.predecessorProduction));
  const pending = activeBuilds(snapshot.productionBuilds,
    { ...coordinates, externalScriptId: current.external_script_id, reviewTrigger: plan.review });
  if (pending.length) {
    pending.sort((a, b) => a.build_uuid.localeCompare(b.build_uuid));
    return operation(plan, snapshot, "cancel-production-build", "PUT",
      `/builds/builds/${pending[0].build_uuid}/cancel`, null, { buildUuid: pending[0].build_uuid });
  }
  return { phase: "complete", mutation: false, planDigest: plan.planDigest,
    predecessorDigest: transitionDigest(snapshot) };
}

export function verifyTransitionJournal(records, plan) {
  let previous = plan.planDigest;
  let pending = null;
  for (const [index, record] of records.entries()) {
    const { digest, ...body } = record;
    if (record.sequence !== index || record.previous !== previous ||
        record.planDigest !== plan.planDigest || transitionDigest(body) !== digest)
      fail("journal integrity mismatch");
    if (record.event === "intent") {
      if (pending || record.operation?.planDigest !== plan.planDigest) fail("journal intent mismatch");
      pending = record.operation;
    } else if (record.event === "observed") {
      if (!pending || record.operationDigest !== transitionDigest(pending)) fail("journal observation mismatch");
      pending = null;
    } else fail("unknown journal event");
    previous = digest;
  }
  return pending;
}
function applied(op, plan, snapshot) {
  const prod = selected(snapshot.productionTriggers, plan.coordinates.productionTriggerUuid);
  if (op.phase === "fence-production") return same(normalizeTransitionTrigger(prod), fencedProduction(plan.predecessorProduction));
  if (op.phase === "cancel-production-build") return snapshot.productionBuilds.some((b) =>
    b.build_uuid === op.buildUuid && b.status === "stopped");
  return false;
}
// A transport MUST call this against a new provider capture immediately before its HTTP write.
// The CLI emits a request; it deliberately does not claim that file emission fences the provider.
export function authorizeTransitionOperation({ plan, operation: op, snapshot, now = Date.now() }) {
  preservation(plan, snapshot, now);
  if (op.planDigest !== plan.planDigest || now > Date.parse(op.expiresAt) ||
      Date.parse(snapshot.capturedAt) < Date.parse(op.capturedAt) ||
      op.predecessorStateDigest !== snapshotStateDigest(snapshot))
    fail("operation expired or predecessor changed before execution");
  const current = nextTransitionOperation({ plan, snapshot, now });
  if (!same([op.phase, op.method, op.path, op.body],
      [current.phase, current.method, current.path, current.body])) fail("operation authorization drift");
  return { outcome: "transition-operation-authorized", mutation: false };
}
export async function applyTransitionStep({ plan, snapshot, records, append, execute,
  now = Date.now(), clock = Date.now }) {
  const started = clock();
  preservation(plan, snapshot, now);
  const pending = verifyTransitionJournal(records, plan);
  const add = async (body) => {
    const record = { ...body, sequence: records.length, planDigest: plan.planDigest,
      previous: records.at(-1)?.digest ?? plan.planDigest };
    record.digest = transitionDigest(record);
    await append(record); // Must be fsynced before execute; no credential or value is journaled.
    records.push(record);
  };
  if (pending) {
    if (Date.parse(snapshot.capturedAt) <= Date.parse(pending.capturedAt) || !applied(pending, plan, snapshot))
      fail("unresolved prior intent; recapture provider state, never repeat an uncertain write");
    await add({ event: "observed", operationDigest: transitionDigest(pending),
      snapshotDigest: transitionDigest(snapshot), capturedAt: snapshot.capturedAt });
  }
  const op = nextTransitionOperation({ plan, snapshot, now });
  if (op.phase === "complete") return op;
  await add({ event: "intent", operation: op });
  // A slow fsync or intervening local change cannot extend the provider observation's lifetime.
  authorizeTransitionOperation({ plan, operation: op, snapshot, now: now + clock() - started });
  await execute(op);
  return { phase: "await-readback", operation: op.phase, mutation: true };
}

async function privateJson(path) {
  if (!path || resolve(path) !== path || await realpath(dirname(path)) !== dirname(path))
    fail("private path must be canonical and absolute");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > 1024 * 1024)
      fail("private input must be owner-only and bounded");
    return JSON.parse(await file.readFile("utf8"));
  } finally { await file.close(); }
}
async function writePrivate(path, value) {
  if (!path || resolve(path) !== path || await realpath(dirname(path)) !== dirname(path))
    fail("private output path must be canonical and absolute");
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
    constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(`${JSON.stringify(value)}\n`); await file.sync(); }
  finally { await file.close(); }
  const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
  try { await directory.sync(); } finally { await directory.close(); }
}
export async function runTransitionCli(args = process.argv.slice(2)) {
  const [mode, input, output] = args;
  if (args.length !== 3 || !["--plan", "--next"].includes(mode))
    fail("usage: --plan|--next /absolute/private-input.json /absolute/new-output.json");
  const request = await privateJson(input);
  if (mode === "--plan") {
    await writePrivate(output, createTransitionPlan(request));
    return { outcome: "transition-plan-created", mutation: false };
  }
  // The exclusive lock fences operator CLI writers. Existing locks fail closed; never steal one.
  const journalPath = request.journalPath;
  if (!journalPath || resolve(journalPath) !== journalPath ||
      await realpath(dirname(journalPath)) !== dirname(journalPath)) fail("invalid journal path");
  const lock = `${journalPath}.lock`;
  await mkdir(lock, { mode: 0o700 });
  try {
    let records;
    try { records = await privateJson(journalPath); }
    catch (error) { if (error.code !== "ENOENT") throw error; records = []; }
    let index = records.length;
    const append = async (record) => {
      // Immutable per-record receipts: no rewrite of past evidence, including interrupted writes.
      await writePrivate(`${journalPath}.${index++}.json`, record);
    };
    // CLI carries the current chain in an immutable input file. The caller supplies the receipts
    // on recovery; the exclusive numbered receipt prevents concurrent/replayed intent emission.
    if (request.records) {
      if (records.length) fail("ambiguous journal input");
      records = request.records;
      index = records.length;
      for (let i = 0; i < records.length; ++i)
        if (!same(await privateJson(`${journalPath}.${i}.json`), records[i])) fail("journal receipt drift");
    }
    const result = await applyTransitionStep({ plan: request.plan, snapshot: request.snapshot, records,
      append, execute: async (op) => writePrivate(output, op) });
    return result.phase === "complete" ? result :
      { phase: "operation-emitted-await-provider-readback", mutation: false };
  } finally { await rmdir(lock); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runTransitionCli().then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => { process.stderr.write(`${JSON.stringify({ outcome: "transition-stopped",
      reason: error.message.startsWith("deployment transition:") ? error.message : "private-input-or-output-failure" })}\n`);
    process.exitCode = 1; });
}
