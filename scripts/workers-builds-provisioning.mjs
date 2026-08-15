import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateBuildEnvironment,
  validateContract as validateProductionContract,
  validateTopology,
} from "./production-delivery.mjs";
import { validateCheckedInContract as validateReviewContract } from "./review-environment.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const productionPath = resolve(root, "deployment/workers-builds-production.json");
const reviewPath = resolve(root, "deployment/workers-builds-review.json");
const accountIdPattern = /^[0-9a-f]{32}$/u;
const scriptTagPattern = /^[0-9a-f]{32}$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export class WorkersBuildsProvisioningError extends Error {}

function fail(message) {
  throw new WorkersBuildsProvisioningError(message);
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function normalizedRoot(value) {
  return value === "/" ? "" : value;
}

function oneBinding(bindings, name, type) {
  const matches = bindings.filter((value) => value.name === name && value.type === type);
  if (matches.length !== 1) fail(`${type} binding ${name} is missing or ambiguous`);
  return matches[0];
}

function requireEnvelope(value, label) {
  if (!value || value.success !== true || !value.result)
    fail(`${label} provider readback failed`);
  return value.result;
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
    fail("review bootstrap environment drift");
  return { SKIP_DEPENDENCY_INSTALL: { is_secret: false, value: "1" } };
}

export function validateAutomaticReviewEnvironment(actual, review) {
  const expected = automaticReviewEnvironmentSpec(review);
  if (!same(sorted(Object.keys(actual ?? {})), sorted(Object.keys(expected))))
    fail("review environment inventory drift");
  if (!same(actual.SKIP_DEPENDENCY_INSTALL, expected.SKIP_DEPENDENCY_INSTALL))
    fail("review bootstrap environment drift");
}

export function materializeProductionConfiguration({
  base, worker, settingsEnvelope, subdomainEnvelope, accountId,
}) {
  if (!accountIdPattern.test(accountId ?? "")) fail("production account ID is malformed");
  const settings = requireEnvelope(settingsEnvelope, `${worker.role} settings`);
  const subdomain = requireEnvelope(subdomainEnvelope, `${worker.role} subdomain`);
  if (subdomain.enabled !== false || subdomain.previews_enabled !== false)
    fail(`${worker.role} enables an alternate production URL`);
  if (
    base.compatibility_date !== settings.compatibility_date ||
    !same(base.compatibility_flags ?? [], settings.compatibility_flags ?? [])
  ) fail(`${worker.role} compatibility settings drift`);

  const config = structuredClone(base);
  const bindings = settings.bindings ?? [];
  config.account_id = accountId;
  config.workers_dev = false;
  config.preview_urls = false;
  config.routes = worker.customDomains.map((pattern) => ({ pattern, custom_domain: true }));
  if (Object.hasOwn(config.vars ?? {}, "DIRECTORY_CACHE_ZONE_ID")) {
    const live = oneBinding(bindings, "DIRECTORY_CACHE_ZONE_ID", "plain_text");
    config.vars.DIRECTORY_CACHE_ZONE_ID = live.text;
  }
  if (config.d1_databases) config.d1_databases = config.d1_databases.map((item) => {
    const live = oneBinding(bindings, item.binding, "d1");
    return { ...item, database_id: live.id ?? live.database_id };
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
    return { ...item, service: live.service, entrypoint: live.entrypoint };
  });
  const actualSecrets = sorted(bindings.filter(({ type }) => type === "secret_text")
    .map(({ name }) => name));
  if (!same(actualSecrets, sorted(config.secrets?.required ?? [])))
    fail(`${worker.role} secret-name inventory drift`);
  return config;
}

export function materializeProductionConfigurations({
  contract, bases, snapshots, accountId,
}) {
  if (!Array.isArray(bases) || bases.length !== 3 || !Array.isArray(snapshots) || snapshots.length !== 3)
    fail("exactly three production configuration snapshots are required");
  const configurations = contract.workers.map((worker, index) =>
    materializeProductionConfiguration({
      base: bases[index], worker, settingsEnvelope: snapshots[index].settings,
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
  const actualDomains = (requireEnvelope(domains, "Custom Domain") ?? [])
    .filter(({ service }) => contract.workers.some((worker) => worker.name === service))
    .map(({ hostname, service }) => ({ hostname, service }));
  if (!same(actualDomains.sort((a, b) => a.hostname.localeCompare(b.hostname)),
    expectedDomains.sort((a, b) => a.hostname.localeCompare(b.hostname))))
    fail("production Custom Domain inventory drift");
  for (const [index, snapshot] of snapshots.entries()) {
    const expected = configurations[index].triggers?.crons ?? [];
    const schedules = requireEnvelope(snapshot.schedules, `${contract.workers[index].role} schedules`);
    const actual = (schedules.schedules ?? []).map(({ cron }) => cron);
    if (!same(sorted(actual), sorted(expected)))
      fail(`${contract.workers[index].role} schedule drift`);
    const scriptSettings = requireEnvelope(snapshot.scriptSettings,
      `${contract.workers[index].role} script settings`);
    if ((scriptSettings.tail_consumers ?? []).length !== 0 || scriptSettings.logpush === true)
      fail(`${contract.workers[index].role} gained an external log consumer`);
    const observability = requireEnvelope(snapshot.settings,
      `${contract.workers[index].role} settings`).observability;
    for (const channel of [observability?.logs, observability?.traces])
      if ((channel?.destinations ?? []).length !== 0)
        fail(`${contract.workers[index].role} gained an observability destination`);
  }
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

async function createPrivateDirectory(path) {
  if (!isAbsolute(path ?? "")) fail("private output directory must be absolute");
  try {
    await lstat(path);
    fail("private output directory already exists");
  } catch (error) {
    if (error instanceof WorkersBuildsProvisioningError) throw error;
    if (error?.code !== "ENOENT") fail("private output directory cannot be inspected");
  }
  await mkdir(path, { mode: 0o700 });
  await chmod(path, 0o700);
}

async function readPrivateValue(path, label, pattern = null) {
  if (!isAbsolute(path ?? "")) fail(`${label} file path must be absolute`);
  const metadata = await lstat(path).catch(() => null);
  if (!metadata?.isFile() || (metadata.mode & 0o077) !== 0)
    fail(`${label} file must be a private regular file`);
  const value = (await readFile(path, "utf8")).trim();
  if (!value || value.includes("\n") || (pattern && !pattern.test(value)))
    fail(`${label} file is malformed`);
  return value;
}

async function writePrivateJson(path, value) {
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
  await chmod(path, 0o600);
}

async function providerGet({ accountId, token, outputDirectory }, label, path) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`, {
    method: "GET", redirect: "error",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  let body;
  try { body = JSON.parse(await response.text()); }
  catch { fail(`${label} returned non-JSON provider data`); }
  await writePrivateJson(resolve(outputDirectory, `${label}.json`), body);
  if (!response.ok || body.success !== true) fail(`${label} provider readback failed`);
  return body;
}

async function readProviderSnapshot({ accountId, token, outputDirectory, production, review }) {
  await createPrivateDirectory(outputDirectory);
  const scripts = await providerGet({ accountId, token, outputDirectory }, "scripts", "/workers/scripts");
  const names = [...production.workers.map(({ name }) => name), review.automaticReview.project];
  for (const name of names) {
    const script = (scripts.result ?? []).find(({ id }) => id === name);
    if (!script) {
      if (name === review.automaticReview.project) {
        await writePrivateJson(resolve(outputDirectory, `${name}.absent.json`), {
          success: true, result: { absent: true },
        });
        continue;
      }
      fail(`required production Worker ${name} is absent`);
    }
    if (!scriptTagPattern.test(script.tag ?? "")) fail(`${name} script tag is malformed`);
    await providerGet({ accountId, token, outputDirectory }, `${name}.settings`,
      `/workers/scripts/${encodeURIComponent(name)}/settings`);
    await providerGet({ accountId, token, outputDirectory }, `${name}.subdomain`,
      `/workers/scripts/${encodeURIComponent(name)}/subdomain`);
    await providerGet({ accountId, token, outputDirectory }, `${name}.schedules`,
      `/workers/scripts/${encodeURIComponent(name)}/schedules`);
    await providerGet({ accountId, token, outputDirectory }, `${name}.script-settings`,
      `/workers/scripts/${encodeURIComponent(name)}/script-settings`);
    const triggers = await providerGet({ accountId, token, outputDirectory }, `${name}.triggers`,
      `/builds/workers/${encodeURIComponent(script.tag)}/triggers`);
    for (const trigger of triggers.result ?? []) {
      if (!uuidPattern.test(trigger.trigger_uuid ?? "")) fail(`${name} trigger UUID is malformed`);
      await providerGet({ accountId, token, outputDirectory },
        `${name}.trigger-${trigger.trigger_uuid}.environment`,
        `/builds/triggers/${encodeURIComponent(trigger.trigger_uuid)}/environment_variables`);
    }
  }
  await providerGet({ accountId, token, outputDirectory }, "domains", "/workers/domains");
  await providerGet({ accountId, token, outputDirectory }, "build-tokens", "/builds/tokens");
  await providerGet({ accountId, token, outputDirectory }, "build-limits", "/builds/account/limits");
  return { outcome: "workers-builds-private-readback-complete", mutation: false,
    productionWorkers: production.workers.length,
    reviewBootstrapPresent: (scripts.result ?? []).some(({ id }) => id === review.automaticReview.project) };
}

async function loadSnapshot(directory, name) {
  if (!isAbsolute(directory ?? "")) fail("private snapshot directory must be absolute");
  const metadata = await lstat(directory).catch(() => null);
  if (!metadata?.isDirectory() || (metadata.mode & 0o077) !== 0)
    fail("private snapshot directory must be private");
  try { return JSON.parse(await readFile(resolve(directory, name), "utf8")); }
  catch { fail(`private snapshot ${name} is missing or malformed`); }
}

async function materializeSnapshot({ snapshotDirectory, outputDirectory, accountId,
  production, bases }) {
  const snapshots = await Promise.all(production.workers.map(async ({ name }) => ({
    settings: await loadSnapshot(snapshotDirectory, `${name}.settings.json`),
    subdomain: await loadSnapshot(snapshotDirectory, `${name}.subdomain.json`),
    schedules: await loadSnapshot(snapshotDirectory, `${name}.schedules.json`),
    scriptSettings: await loadSnapshot(snapshotDirectory, `${name}.script-settings.json`),
  })));
  const domains = await loadSnapshot(snapshotDirectory, "domains.json");
  const configurations = materializeProductionConfigurations({
    contract: production, bases, snapshots, accountId,
  });
  validateProductionControlPlane({ contract: production, configurations, snapshots, domains });
  await createPrivateDirectory(outputDirectory);
  const results = [];
  for (const [index, worker] of production.workers.entries()) {
    const bytes = Buffer.byteLength(JSON.stringify(configurations[index]));
    await writePrivateJson(resolve(outputDirectory, `${worker.role}.json`), configurations[index]);
    results.push({ role: worker.role, bytes });
  }
  return { outcome: "production-protected-documents-materialized", mutation: false, results };
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
  return { production, review };
}

async function main() {
  const mode = process.argv[2] ?? "--validate-only";
  const { production, review } = await validateCheckedInProvisioning();
  if (mode === "--validate-only") {
    process.stdout.write(`${JSON.stringify({ outcome: "workers-builds-provisioning-valid" })}\n`);
    return;
  }
  if (mode === "--dry-run") {
    process.stdout.write(`${JSON.stringify({
      outcome: "workers-builds-provisioning-plan-valid", mutation: false,
      production: { project: production.workers[0].name, branch: production.productionBranch,
        triggerCount: 1, protectedInputCount: Object.keys(production.protectedInputs).length },
      automaticReview: { project: review.automaticReview.project, triggerCount: 1,
        protectedInputCount: review.automaticReview.protectedInputs.length },
      gates: ["provider-setup-approval", "migration-0010", "initial-production-proof"],
    })}\n`);
    return;
  }
  if (mode === "--readback") {
    const accountId = await readPrivateValue(process.env.ATRINIK_CLOUDFLARE_ACCOUNT_ID_FILE,
      "Cloudflare account ID", accountIdPattern);
    const token = await readPrivateValue(process.env.ATRINIK_WORKERS_BUILDS_API_TOKEN_FILE,
      "Workers Builds API token");
    const outputDirectory = process.env.ATRINIK_PROVIDER_SNAPSHOT_OUTPUT;
    process.stdout.write(`${JSON.stringify(await readProviderSnapshot({
      accountId, token, outputDirectory, production, review,
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
      accountId, production, bases,
    }))}\n`);
    return;
  }
  fail("unknown Workers Builds provisioning mode");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    const reason = error instanceof WorkersBuildsProvisioningError
      ? error.message : "unexpected-internal-error";
    process.stderr.write(`${JSON.stringify({ outcome: "workers-builds-provisioning-stopped", reason })}\n`);
    process.exitCode = 1;
  });
