// Copyright (C) 2026 Atrinik contributors
// Source-only machinery: no provider access occurs on import. The caller supplies
// selected-source/config/module verification and the complete authority/global fence.
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
function assertSnapshot(role, value, retired = false) {
  if (!value || value.name !== workerName(role) || !/^[a-f0-9]{32}$/u.test(value.accountId ?? "") ||
      !uuid.test(value.activeVersion ?? "") || value.latestVersion !== value.activeVersion ||
      !uuid.test(value.deploymentId ?? "") || !value.peers || !value.code ||
      !Array.isArray(value.code.modules) || value.code.modules.length < 1 ||
      value.code.modules.some((m) => !sha.test(m.sha256 ?? "") || typeof m.name !== "string" || !m.name || !Number.isSafeInteger(m.bytes) || m.bytes < 1) ||
      new Set(value.code.modules.map((m) => m.name)).size !== value.code.modules.length ||
      value.code.etag !== value.resources?.script?.etag)
    fail("active identity or module proof incomplete");
  const rows = bindings(value.settings?.bindings);
  bindings(value.resources?.bindings);
  if (!same(rows, value.resources.bindings)) fail("settings/version binding mismatch");
  const secrets = rows.filter((b) => b.type === "secret_text").map((b) => b.name).sort();
  if (!same(secrets, retired ? [] : [...callerRetirementSecrets].sort())) fail("exact secret pair required");
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
  if (!/^[a-f0-9]{40}$/u.test(annotations?.["workers/tag"] ?? "") ||
      !new RegExp(`^atrinik-delivery-v1 source=${annotations["workers/tag"]} deploy=[a-f0-9]{64} migration=[a-f0-9]{64} horizon=[1-9][0-9]* control=[a-f0-9]{64} role=${role} phase=staged$`, "u")
        .test(annotations["workers/message"] ?? "")) fail("selected staged annotation missing");
  if (annotations["workers/triggered_by"] !== (retired ? "secret" : "version_upload"))
    fail("unsupported exact provider operation annotation");
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
export function callerRetirementSettings(role, snapshot) {
  assertSnapshot(role, snapshot);
  // Settings PATCH changes only bindings; annotations must be supplied explicitly
  // because the API does not inherit them. Never submit the read-only operation field.
  const annotations = structuredClone(snapshot.settings.annotations);
  delete annotations["workers/triggered_by"];
  return { bindings: snapshot.settings.bindings.filter((b) => !callerRetirementSecrets.includes(b.name)), annotations };
}
export function verifyCallerRetirementPost(role, before, after) {
  assertSnapshot(role, before);
  assertSnapshot(role, after, true);
  if (after.activeVersion === before.activeVersion || after.deploymentId === before.deploymentId)
    fail("no new active version observed");
  const expected = withoutTime(before);
  for (const key of ["activeVersion", "latestVersion", "deploymentId"]) expected[key] = after[key];
  for (const field of ["settings", "resources"])
    expected[field].bindings = expected[field].bindings.filter((b) => !callerRetirementSecrets.includes(b.name));
  expected.settings.annotations["workers/triggered_by"] = "secret";
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
  recordIntent, recordReceipt, authorize, now = Date.now }) {
  workerName(role);
  if ([read, fence, verifyStaged, patch, recordIntent, recordReceipt, authorize].some((f) => typeof f !== "function"))
    fail("required authority or durable recorder missing");
  await fence();
  const before = await read();
  fresh(before, now);
  assertSnapshot(role, before);
  if (await verifyStaged(before, { retired: false }) !== true) fail("selected staged proof rejected");
  const settings = callerRetirementSettings(role, before);
  const intent = { schema: "atrinik-production-caller-retirement-v1", role, accountId: before.accountId,
    name: workerName(role), method: "PATCH", path: `/workers/scripts/${workerName(role)}/settings`,
    before: withoutTime(before), beforeDigest: callerRetirementDigest(withoutTime(before)), settingsDigest: callerRetirementDigest(settings) };
  await recordIntent(intent);
  // Intent is consumed first. Re-read module, latest, bindings and peers, then do
  // the final authority/global fence. Neither check is permission to retry.
  await fence();
  const current = await read();
  fresh(current, now);
  assertSnapshot(role, current);
  if (!same(withoutTime(before), withoutTime(current))) fail("predecessor changed after intent");
  if (await verifyStaged(current, { retired: false }) !== true) fail("staged proof changed after intent");
  await authorize();
  fresh(current, now);
  await patch({ role, accountId: before.accountId, name: workerName(role), settings });
  const after = await read();
  fresh(after, now);
  verifyCallerRetirementPost(role, before, after);
  if (await verifyStaged(after, { retired: true }) !== true) fail("retired staged proof rejected");
  await fence();
  const receipt = { ...intent, status: "observed-disabled-caller-secrets-retired",
    afterDigest: callerRetirementDigest(withoutTime(after)), capturedAt: after.capturedAt };
  await recordReceipt(receipt);
  return { snapshot: after, receipt };
}

// An ambiguous prior dispatch may only be OBSERVED, never replayed. A successful
// recovery terminal is a new document and is not a fabricated original receipt.
export async function observeCallerRetirement({ role, before, intent, read, fence, verifyStaged, now = Date.now }) {
  assertSnapshot(role, before);
  if (intent?.schema !== "atrinik-production-caller-retirement-v1" || intent.role !== role ||
      intent.accountId !== before.accountId || intent.name !== workerName(role) ||
      intent.method !== "PATCH" || intent.path !== `/workers/scripts/${workerName(role)}/settings` ||
      !same(intent.before, withoutTime(before)) || intent.beforeDigest !== callerRetirementDigest(withoutTime(before)) ||
      intent.settingsDigest !== callerRetirementDigest(callerRetirementSettings(role, before)))
    fail("recovery intent does not bind predecessor");
  await fence();
  const after = await read();
  fresh(after, now);
  verifyCallerRetirementPost(role, before, after);
  if (await verifyStaged(after, { retired: true }) !== true) fail("recovery staged proof rejected");
  await fence();
  return { status: "observed-retirement-recovery-only", originalReceiptCreated: false,
    intentDigest: callerRetirementDigest(intent), snapshot: after };
}

export function createCallerRetirementPatch({ accountId, token, role, fetcher = fetch }) {
  const name = workerName(role);
  if (!/^[a-f0-9]{32}$/u.test(accountId ?? "") || typeof token !== "string" || !token || /\s/u.test(token))
    fail("mutation transport authority invalid");
  let consumed = false;
  return async (request) => {
    if (consumed) fail("mutation transport already consumed");
    if (request?.role !== role || request.accountId !== accountId || request.name !== name ||
        !request.settings || !same(Object.keys(request.settings).sort(), ["annotations", "bindings"]) ||
        request.settings.bindings.some((b) => b.type === "secret_text" || callerRetirementSecrets.includes(b.name)) ||
        Object.hasOwn(request.settings.annotations, "workers/triggered_by")) fail("mutation request authority drift");
    const data = JSON.stringify(request.settings);
    if (Buffer.byteLength(data) > 65536) fail("settings request exceeds bound");
    const form = new FormData();
    form.set("settings", new Blob([data], { type: "application/json" }));
    consumed = true;
    // Exactly one request, bounded response, no redirect or automatic retry.
    const response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${name}/settings`, {
      method: "PATCH", headers: { Authorization: `Bearer ${token}` }, body: form,
      redirect: "error", signal: AbortSignal.timeout(20000),
    });
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
      const code = await parseCallerRetirementModules(raw.bytes, raw.type, raw.etag);
      if (code.etag !== detail.resources?.script?.etag) fail("active module changed during read");
      return { name: worker, tag: identity.tag, activeVersion: latest.id, latestVersion: latest.id, deploymentId: active.id,
        settings: { ...settings.result, bindings: safeBindings(settings.result?.bindings) },
        resources: { ...detail.resources, bindings: safeBindings(detail.resources?.bindings) }, code,
        control: { routes: completeRows(routes), domains: completeRows(domains), subdomain: subdomain.result,
          environment: environment.result, schedules: schedules.result } };
    }));
    const target = workers.find((w) => w.name === name);
    // serviceEnvironment contains a mutable deployment's detailed script metadata.
    // It is retained for selected-caller verification; the post comparator must
    // reject unknown changes rather than erase this evidence wholesale.
    return { accountId, ...target, peers: { workers: uniqueRows(workers.filter((w) => w.name !== name), "name"), namespaces: globalNamespaces } };
  };
  return async () => {
    const started = now(), first = await capture(), second = await capture();
    if (now() - started > 120000 || !same(first, second)) fail("cohort unstable or read expired");
    return { ...second, capturedAt: now() };
  };
}
