import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contractPath = resolve(root, "deployment/workers-builds-production.json");
const shaPattern = /^[0-9a-f]{40}$/u;
const placeholderPattern = /(?:^0{16,}$|\.example(?:\.|$)|placeholder)/iu;

const expectedWorkerNames = [
  "atrinik-metaserver",
  "atrinik-metaserver-publisher",
  "atrinik-metaserver-rendezvous",
];
const stateKeys = [
  "d1_databases",
  "r2_buckets",
  "durable_objects",
  "analytics_engine_datasets",
];

function fail(message) {
  throw new Error(message);
}

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function sameValues(actual, expected) {
  return JSON.stringify(sorted(actual)) === JSON.stringify(sorted(expected));
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function stripJsonc(text) {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
      continue;
    }
    if (character === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      output += "\n";
      continue;
    }
    if (character === "/" && next === "*") {
      index += 2;
      while (
        index < text.length &&
        !(text[index] === "*" && text[index + 1] === "/")
      ) {
        if (text[index] === "\n") output += "\n";
        index += 1;
      }
      index += 1;
      continue;
    }
    output += character;
  }
  return output.replace(/,(\s*[}\]])/gu, "$1");
}

async function readJsonc(path) {
  try {
    return JSON.parse(stripJsonc(await readFile(path, "utf8")));
  } catch {
    fail(`invalid JSONC configuration: ${path}`);
  }
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalJson(item)]),
    );
  return value;
}

function sameJson(actual, expected) {
  return JSON.stringify(canonicalJson(actual)) === JSON.stringify(canonicalJson(expected));
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${label} must be an object`);
  if (!sameValues(Object.keys(value), expected))
    fail(`${label} has unexpected or missing fields`);
}

export function validateContract(contract) {
  assertExactKeys(
    contract,
    [
      "schemaVersion",
      "provider",
      "repository",
      "rootDirectory",
      "productionBranch",
      "automaticPush",
      "pathIncludes",
      "pathExcludes",
      "installCommand",
      "validationCommand",
      "deployCommand",
      "reviewCommand",
      "productionCanaries",
      "toolchain",
      "source",
      "protectedInputs",
      "workers",
      "invariants",
    ],
    "production contract",
  );
  if (
    contract.schemaVersion !== 1 ||
    contract.provider !== "cloudflare-workers-builds" ||
    contract.repository !== "atrinik/metaserver-worker" ||
    contract.rootDirectory !== "" ||
    contract.productionBranch !== "main" ||
    contract.automaticPush !== true ||
    contract.pathIncludes.length !== 0 ||
    contract.pathExcludes.length !== 0
  )
    fail("Workers Builds production trigger drift");
  if (
    contract.installCommand !== "npm ci" ||
    contract.validationCommand !== "npm run check" ||
    contract.deployCommand !== "npm run deploy:production" ||
    contract.reviewCommand !== "npm run deploy:production:dry-run"
  )
    fail("production command contract drift");
  const expectedCanaries = [
    {
      name: "classic-static-directory",
      command: [
        "python3",
        "scripts/static_origin_canary.py",
        "--profile",
        "classic-v2",
        "--base-url",
        "https://classic.meta.atrinik.org",
        "--allow-production",
        "--json",
      ],
    },
    {
      name: "game-static-directory",
      command: [
        "python3",
        "scripts/static_origin_canary.py",
        "--profile",
        "game-v1",
        "--base-url",
        "https://meta.atrinik.org",
        "--allow-production",
        "--json",
      ],
    },
  ];
  if (
    JSON.stringify(contract.productionCanaries) !==
    JSON.stringify(expectedCanaries)
  )
    fail("bounded production canary contract drift");
  if (
    JSON.stringify(contract.toolchain) !==
    JSON.stringify({
      node: "24.18.1",
      npm: "11.16.0",
      wrangler: "4.119.0",
      lockfile: "package-lock.json",
    })
  )
    fail("production toolchain drift");
  if (
    contract.source.branchVariable !== "WORKERS_CI_BRANCH" ||
    contract.source.commitVariable !== "WORKERS_CI_COMMIT_SHA" ||
    contract.source.buildVariable !== "WORKERS_CI_BUILD_UUID" ||
    contract.source.currentMainUrl !==
      "https://api.github.com/repos/atrinik/metaserver-worker/commits/main"
  )
    fail("production source identity drift");
  if (
    JSON.stringify(contract.protectedInputs) !==
    JSON.stringify({
      accountVariable: "CLOUDFLARE_ACCOUNT_ID",
      coreConfigVariable: "ATRINIK_PRODUCTION_CORE_CONFIG",
      publisherConfigVariable: "ATRINIK_PRODUCTION_PUBLISHER_CONFIG",
      rendezvousConfigVariable: "ATRINIK_PRODUCTION_RENDEZVOUS_CONFIG",
      coreSecretsVariable: "ATRINIK_PRODUCTION_CORE_SECRETS",
      edgeSecretsVariable: "ATRINIK_PRODUCTION_EDGE_SECRETS",
      controlPlaneGateVariable: "ATRINIK_PRODUCTION_CONTROL_PLANE_READY",
    })
  )
    fail("protected production input contract drift");
  if (
    !Array.isArray(contract.workers) ||
    contract.workers.length !== 3 ||
    JSON.stringify(contract.workers.map(({ name }) => name)) !==
      JSON.stringify(expectedWorkerNames) ||
    JSON.stringify(contract.workers.map(({ order }) => order)) !==
      JSON.stringify([1, 2, 3]) ||
    contract.workers.some(({ directDeploy }) => directDeploy !== true)
  )
    fail("serialized Worker topology drift");
  const invariants = contract.invariants;
  if (
    invariants.productionWorkersDev !== false ||
    invariants.productionPreviewUrls !== false ||
    invariants.migrationPolicy !== "exact-ledger-no-automatic-apply" ||
    invariants.controlPlanePolicy !== "explicit-external-gate-before-upload" ||
    JSON.stringify(invariants.deploymentOrder) !==
      JSON.stringify(["core", "publisher", "rendezvous"]) ||
    invariants.deploymentMode !== "direct-100-percent-strict" ||
    invariants.buildSerialization !==
      "one-topology-entrypoint-with-current-main-checks" ||
    invariants.noOp !==
      "matching-bundles-config-migrations-and-command-contract" ||
    invariants.recovery !==
      "disabled-circuit-fix-forward-and-exact-current-main-retry"
  )
    fail("production safety invariant drift");
}

function names(config, key, field = "binding") {
  return (config[key] ?? []).map((value) => value[field]);
}

function requiredSecrets(config) {
  return config.secrets?.required ?? [];
}

function rateNamespaceIds(config) {
  return (config.ratelimits ?? []).map(({ namespace_id: id }) => String(id));
}

function serviceContracts(config) {
  return (config.services ?? []).map(
    ({ binding, service, entrypoint }) => `${binding}:${service}#${entrypoint}`,
  );
}

function customDomains(config) {
  return (config.routes ?? [])
    .filter(({ custom_domain: customDomain }) => customDomain === true)
    .map(({ pattern }) => pattern);
}

function containsPlaceholder(value) {
  if (typeof value === "string") return placeholderPattern.test(value);
  if (Array.isArray(value)) return value.some(containsPlaceholder);
  if (value && typeof value === "object")
    return Object.values(value).some(containsPlaceholder);
  return false;
}

function configBindingNames(config) {
  const bindings = [
    ...names(config, "d1_databases"),
    ...names(config, "r2_buckets"),
    ...names(config, "analytics_engine_datasets"),
    ...names(config, "ratelimits", "name"),
    ...names(config, "services"),
    ...Object.keys(config.vars ?? {}),
    ...requiredSecrets(config),
  ];
  bindings.push(
    ...(config.durable_objects?.bindings ?? []).map(({ name }) => name),
  );
  return sorted(bindings);
}

export function validateTopology(contract, configs, { production = false } = {}) {
  if (configs.length !== 3) fail("exactly three Worker configs are required");
  const allRateIds = configs.flatMap(rateNamespaceIds);
  if (new Set(allRateIds).size !== allRateIds.length)
    fail("rate-limit namespace IDs must be unique across the topology");

  for (const [index, config] of configs.entries()) {
    const worker = contract.workers[index];
    if (config.name !== worker.name) fail(`${worker.role} Worker name drift`);
    if (config.workers_dev !== false || config.preview_urls !== false)
      fail(`${worker.role} enables an alternate production URL`);
    if (!sameValues(requiredSecrets(config), worker.requiredSecrets))
      fail(`${worker.role} required secret names drift`);
    if (!sameValues(serviceContracts(config), worker.serviceBindings))
      fail(`${worker.role} Service Binding drift`);
    if (!sameValues(Object.keys(config.vars ?? {}), worker.requiredVariables))
      fail(`${worker.role} required variable names drift`);
    if (
      production &&
      !sameValues(customDomains(config), worker.customDomains)
    )
      fail(`${worker.role} Custom Domain drift`);
    if (
      production &&
      (config.routes ?? []).some(
        ({ custom_domain: customDomain }) => customDomain !== true,
      )
    )
      fail(`${worker.role} gained a non-Custom-Domain route`);
    if (production && containsPlaceholder(config))
      fail(`${worker.role} production config contains a placeholder`);
  }

  const [core, publisher, rendezvous] = configs;
  if (
    !sameValues(names(core, "d1_databases"), ["DB"]) ||
    !sameValues(names(core, "r2_buckets"), [
      "DIRECTORY_GENERATIONS",
      "CLASSIC_DIRECTORY_PUBLIC",
      "GAME_DIRECTORY_PUBLIC",
    ]) ||
    !sameValues(names(core, "analytics_engine_datasets"), [
      "RENDEZVOUS_METRICS",
      "DIRECTORY_METRICS",
    ]) ||
    !sameValues(
      (core.durable_objects?.bindings ?? []).map(({ name }) => name),
      ["RENDEZVOUS", "DIRECTORY_BUILDER"],
    ) ||
    !sameValues(names(core, "ratelimits", "name"), [
      "PUBLISH_IDENTITY_RATE_LIMITER",
      "RENDEZVOUS_SERVER_RATE_LIMITER",
    ]) ||
    !sameValues(core.triggers?.crons ?? [], ["*/5 * * * *", "17 * * * *"])
  )
    fail("core state/trigger authority drift");
  for (const [role, config] of [
    ["publisher", publisher],
    ["rendezvous", rendezvous],
  ]) {
    if (stateKeys.some((key) => key in config) || (config.triggers?.crons ?? []).length)
      fail(`${role} gained state or trigger authority`);
  }
  if (
    !sameValues(names(publisher, "ratelimits", "name"), ["GLOBAL_RATE_LIMITER"]) ||
    !sameValues(names(rendezvous, "ratelimits", "name"), [
      "GLOBAL_RATE_LIMITER",
      "RENDEZVOUS_CLIENT_RATE_LIMITER",
    ])
  )
    fail("caller rate-limit authority drift");
}

export function parseVersionMessage(message) {
  const match = /^atrinik-delivery-v1 source=([0-9a-f]{40}) deploy=([0-9a-f]{64}) control=([0-9a-f]{64}) role=(core|publisher|rendezvous)$/u.exec(
    message ?? "",
  );
  return match
    ? { source: match[1], deploy: match[2], control: match[3], role: match[4] }
    : null;
}

export function activeVersionId(deployment) {
  if (!deployment || !Array.isArray(deployment.versions))
    fail("invalid active deployment readback");
  if (deployment.versions.length !== 1 || deployment.versions[0].percentage !== 100)
    fail("Worker is not deployed as one direct 100% version");
  const versionId = deployment.versions[0].version_id;
  if (typeof versionId !== "string" || !versionId)
    fail("active deployment lacks a version ID");
  return versionId;
}

export function validateSourceCoordinates(coordinates) {
  if (coordinates.workersCi !== "1" || coordinates.branch !== "main")
    fail("production delivery is restricted to Workers Builds on main");
  if (!shaPattern.test(coordinates.sourceSha))
    fail("WORKERS_CI_COMMIT_SHA is invalid");
  if (coordinates.head !== coordinates.sourceSha)
    fail("checkout HEAD does not match WORKERS_CI_COMMIT_SHA");
  if (coordinates.dirty) fail("production checkout is dirty");
  if (!coordinates.buildUuid) fail("WORKERS_CI_BUILD_UUID is missing");
  if (!/^[0-9a-f]{32}$/u.test(coordinates.accountId))
    fail("CLOUDFLARE_ACCOUNT_ID is missing or invalid");
  if (coordinates.currentMain !== coordinates.sourceSha)
    fail("build SHA is superseded by current main");
}

export function validateRemoteMigrations(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    fail("production D1 migration ledger is pending, missing, or divergent");
}

export function deliveryDecision(annotations, plan, sourceSha, controlGate) {
  const coherentNoOp = annotations.every(
    (value, index) =>
      value?.deploy === plan.deploy &&
      value.control === plan.controls[index] &&
      value.role === ["core", "publisher", "rendezvous"][index],
  );
  const activeSources = new Set(annotations.map((value) => value?.source));
  if (coherentNoOp && activeSources.size === 1) return "no-op";
  const controlChanged = annotations.some(
    (value, index) => !value || value.control !== plan.controls[index],
  );
  if (controlChanged && controlGate !== `approved:${sourceSha}`)
    fail("separately authorized control-plane prerequisite is not verified");
  if (!controlChanged && controlGate !== "routine")
    fail("routine production gate is missing or ambiguous");
  return "deploy";
}

export async function executeOrderedStages(workers, action) {
  for (const [index, worker] of workers.entries()) await action(worker, index);
}

export function validateSecretCohort(core, edge) {
  if (
    core.SOURCE_TAG_KEY_CURRENT !== edge.SOURCE_TAG_KEY_CURRENT ||
    core.SOURCE_TAG_KEY_PREVIOUS !== edge.SOURCE_TAG_KEY_PREVIOUS ||
    core.SOURCE_TAG_KEY_CURRENT === core.SOURCE_TAG_KEY_PREVIOUS
  )
    fail("protected source-tag secret cohort is mismatched");
}

function controlPlaneView(config) {
  return {
    name: config.name,
    compatibility_date: config.compatibility_date,
    compatibility_flags: config.compatibility_flags ?? [],
    workers_dev: config.workers_dev,
    preview_urls: config.preview_urls,
    d1_databases: config.d1_databases ?? [],
    r2_buckets: config.r2_buckets ?? [],
    durable_objects: config.durable_objects ?? {},
    exports: config.exports ?? {},
    analytics_engine_datasets: config.analytics_engine_datasets ?? [],
    ratelimits: config.ratelimits ?? [],
    services: config.services ?? [],
    routes: config.routes ?? [],
    triggers: config.triggers ?? {},
    requiredSecrets: requiredSecrets(config),
  };
}

async function command(program, args, options = {}) {
  return execFileAsync(program, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
}

async function git(...args) {
  return (await command("git", args)).stdout.trim();
}

async function assertToolchain(contract) {
  const packageJson = await readJson(resolve(root, "package.json"));
  const packageLock = await readJson(resolve(root, "package-lock.json"));
  const wranglerPackage = await readJson(
    resolve(root, "node_modules/wrangler/package.json"),
  );
  const node = process.versions.node;
  const npm =
    /^npm\/([^ ]+)/u.exec(process.env.npm_config_user_agent ?? "")?.[1] ??
    (await command("npm", ["--version"])).stdout.trim();
  const checks = {
    node: node === contract.toolchain.node,
    npm: npm === contract.toolchain.npm,
    wrangler: wranglerPackage.version === contract.toolchain.wrangler,
    packageManager:
      packageJson.packageManager === `npm@${contract.toolchain.npm}`,
    nodeEngine: packageJson.engines.node === contract.toolchain.node,
    npmEngine: packageJson.engines.npm === contract.toolchain.npm,
    wranglerDeclaration:
      packageJson.devDependencies.wrangler === contract.toolchain.wrangler,
    wranglerLock:
      packageLock.packages[""].devDependencies.wrangler ===
      contract.toolchain.wrangler,
  };
  const failed = Object.entries(checks)
    .filter(([, valid]) => !valid)
    .map(([name]) => name);
  if (failed.length)
    fail(`installed or declared production toolchain drift: ${failed.join(", ")}`);
}

async function protectedPath(variable) {
  const value = process.env[variable];
  if (!value || !isAbsolute(value)) fail(`${variable} must be an absolute path`);
  const path = await realpath(resolve(value));
  const insideRepository = relative(root, path);
  if (!insideRepository.startsWith("..") && !isAbsolute(insideRepository))
    fail(`${variable} must resolve outside the repository`);
  const metadata = await stat(path);
  if (!metadata.isFile()) fail(`${variable} must name a regular file`);
  if ((metadata.mode & 0o077) !== 0)
    fail(`${variable} must not be accessible to group or other users`);
  return path;
}

async function secretValues(path) {
  const content = await readFile(path, "utf8");
  if (path.endsWith(".json")) {
    const values = JSON.parse(content);
    if (
      !values ||
      typeof values !== "object" ||
      Array.isArray(values) ||
      Object.values(values).some(
        (value) =>
          typeof value !== "string" ||
          value.length === 0 ||
          placeholderPattern.test(value),
      )
    )
      fail("protected secrets file contains an invalid value");
    return values;
  }
  const values = {};
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) fail("invalid protected secrets file");
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1);
    if (!value || placeholderPattern.test(value) || name in values)
      fail("protected secrets file contains an invalid value");
    values[name] = value;
  }
  return values;
}

async function migrationLedger() {
  const paths = (await readdir(resolve(root, "migrations")))
    .filter((path) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(path))
    .sort();
  if (!paths.length) fail("migration ledger is empty");
  for (const [index, path] of paths.entries()) {
    if (Number(path.slice(0, 4)) !== index + 1)
      fail("migration ledger is missing, duplicated, or reordered");
  }
  return Promise.all(
    paths.map(async (path) => ({
      name: path,
      sha256: await sha256File(resolve(root, "migrations", path)),
    })),
  );
}

async function bundleWorkers(configPaths) {
  const outputRoot = await mkdtemp(resolve(tmpdir(), "atrinik-production-bundles-"));
  try {
    const bundles = [];
    for (const [index, configPath] of configPaths.entries()) {
      const output = resolve(outputRoot, String(index));
      await command(resolve(root, "node_modules/.bin/wrangler"), [
        "deploy",
        "--dry-run",
        "--strict",
        "--outdir",
        output,
        "--config",
        configPath,
      ]);
      const files = (await readdir(output)).filter((path) => path.endsWith(".js"));
      if (files.length !== 1) fail("Wrangler dry run produced an ambiguous bundle");
      bundles.push(await sha256File(resolve(output, files[0])));
    }
    return bundles;
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
}

async function buildPlan(contract, configPaths, configs, secretSets) {
  const migrations = await migrationLedger();
  const bundles = await bundleWorkers(configPaths);
  const configurations = await Promise.all(configPaths.map(sha256File));
  const controls = configs.map((config) => sha256Json(controlPlaneView(config)));
  const deploy = sha256Json({
    schemaVersion: contract.schemaVersion,
    provider: contract.provider,
    repository: contract.repository,
    productionBranch: contract.productionBranch,
    commands: {
      install: contract.installCommand,
      validation: contract.validationCommand,
      deploy: contract.deployCommand,
    },
    productionCanaries: contract.productionCanaries,
    toolchain: contract.toolchain,
    workers: contract.workers,
    invariants: contract.invariants,
    packageLock: await sha256File(resolve(root, contract.toolchain.lockfile)),
    contract: await sha256File(contractPath),
    migrations,
    configurations,
    bundles,
    secretSets,
  });
  return { deploy, controls, configurations, bundles, migrations };
}

async function currentMainSha(contract) {
  const response = await fetch(contract.source.currentMainUrl, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "atrinik-metaserver-workers-builds",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) fail(`current-main readback failed with HTTP ${response.status}`);
  const sha = (await response.json()).sha;
  if (!shaPattern.test(sha)) fail("current-main readback returned an invalid SHA");
  return sha;
}

async function assertCurrentMain(contract, sourceSha) {
  if ((await currentMainSha(contract)) !== sourceSha)
    fail("build SHA is superseded by current main");
}

async function wranglerJson(configPath, args) {
  const { stdout } = await command(resolve(root, "node_modules/.bin/wrangler"), [
    ...args,
    "--config",
    configPath,
    "--json",
  ]);
  return JSON.parse(stdout);
}

async function cloudflareResult(accountId, path) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) fail("Workers Builds Cloudflare API token is missing");
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok)
    fail(`Cloudflare control-plane readback failed with HTTP ${response.status}`);
  const body = await response.json();
  if (body?.success !== true || !("result" in body))
    fail("Cloudflare control-plane readback returned an invalid result");
  return body.result;
}

async function readLiveControlPlane(worker, accountId) {
  const workerName = encodeURIComponent(worker.name);
  const environment = "production";
  const service = `/workers/services/${workerName}/environments/${environment}`;
  const script = `/workers/scripts/${workerName}`;
  const [routes, customDomains, subdomainStatus, serviceEnvironment, cronTriggers] =
    await Promise.all([
      cloudflareResult(accountId, `${service}/routes?show_zonename=true`),
      cloudflareResult(
        accountId,
        `/workers/domains/records?page=0&per_page=100&service=${workerName}&environment=${environment}`,
      ),
      cloudflareResult(accountId, `${service}/subdomain`),
      cloudflareResult(accountId, service),
      cloudflareResult(accountId, `${script}/schedules`),
    ]);
  return { routes, customDomains, subdomainStatus, serviceEnvironment, cronTriggers };
}

async function readActive(configPath) {
  const deployment = await wranglerJson(configPath, ["deployments", "status"]);
  const versionId = activeVersionId(deployment);
  const version = await wranglerJson(configPath, ["versions", "view", versionId]);
  return { deployment, version, versionId };
}

function remoteBindingNames(version) {
  return sorted(
    (version.resources?.bindings ?? []).map(({ name }) => name).filter(Boolean),
  );
}

function expectedRemoteBindings(config) {
  const bindings = new Map();
  for (const [name, text] of Object.entries(config.vars ?? {}))
    bindings.set(name, { type: "plain_text", text: String(text) });
  for (const name of requiredSecrets(config))
    bindings.set(name, { type: "secret_text" });
  for (const value of config.d1_databases ?? [])
    bindings.set(value.binding, { type: "d1", id: value.database_id });
  for (const value of config.r2_buckets ?? [])
    bindings.set(value.binding, {
      type: "r2_bucket",
      bucket_name: value.bucket_name,
    });
  for (const value of config.analytics_engine_datasets ?? [])
    bindings.set(value.binding, {
      type: "analytics_engine",
      dataset: value.dataset,
    });
  for (const value of config.durable_objects?.bindings ?? [])
    bindings.set(value.name, {
      type: "durable_object_namespace",
      class_name: value.class_name,
    });
  for (const value of config.services ?? [])
    bindings.set(value.binding, {
      type: "service",
      service: value.service,
      entrypoint: value.entrypoint,
    });
  for (const value of config.ratelimits ?? [])
    bindings.set(value.name, {
      type: "ratelimit",
      namespace_id: value.namespace_id,
      simple: value.simple,
    });
  return bindings;
}

function validateRemoteBindings(worker, config, version) {
  const expected = expectedRemoteBindings(config);
  const actual = new Map(
    (version.resources?.bindings ?? []).map((binding) => [binding.name, binding]),
  );
  if (!sameValues(actual.keys(), expected.keys()))
    fail(`${worker.role} remote binding inventory drift`);
  for (const [name, fields] of expected) {
    const binding = actual.get(name);
    for (const [field, value] of Object.entries(fields)) {
      if (JSON.stringify(binding?.[field]) !== JSON.stringify(value))
        fail(`${worker.role} remote binding configuration drift`);
    }
  }
}

function validateReadback(worker, config, active, expectedMessage = null) {
  const message = active.version.annotations?.["workers/message"];
  const parsed = parseVersionMessage(message);
  if (expectedMessage && message !== expectedMessage)
    fail(`${worker.role} version annotation does not match this deployment`);
  if (!sameValues(remoteBindingNames(active.version), configBindingNames(config)))
    fail(`${worker.role} remote binding inventory drift`);
  validateRemoteBindings(worker, config, active.version);
  const runtime = active.version.resources?.script_runtime ?? {};
  if (
    runtime.compatibility_date !== config.compatibility_date ||
    !sameValues(runtime.compatibility_flags ?? [], config.compatibility_flags ?? [])
  )
    fail(`${worker.role} remote runtime configuration drift`);
  return parsed;
}

export function validateLiveControlPlane(worker, config, live) {
  const expectedRoutes = (config.routes ?? [])
    .filter(({ custom_domain: customDomain }) => customDomain !== true)
    .map(({ pattern }) => pattern);
  const actualRoutes = (live.routes ?? []).map(({ pattern }) => pattern);
  const actualDomains = (live.customDomains ?? []).map(({ hostname }) => hostname);
  const schedules = live.cronTriggers?.schedules ?? [];
  if (!sameValues(actualRoutes, expectedRoutes))
    fail(`${worker.role} live route drift`);
  if (!sameValues(actualDomains, worker.customDomains))
    fail(`${worker.role} live Custom Domain drift`);
  if (
    (live.customDomains ?? []).some(
      ({ enabled, previews_enabled: previewsEnabled }) =>
        enabled !== true || previewsEnabled !== false,
    )
  )
    fail(`${worker.role} live Custom Domain URL policy drift`);
  if (
    live.subdomainStatus?.enabled !== false ||
    live.subdomainStatus?.previews_enabled !== false
  )
    fail(`${worker.role} live alternate URL drift`);
  if (!sameValues(schedules.map(({ cron }) => cron), config.triggers?.crons ?? []))
    fail(`${worker.role} live cron-trigger drift`);
  const script = live.serviceEnvironment?.script;
  if (
    !script ||
    script.compatibility_date !== config.compatibility_date ||
    !sameValues(script.compatibility_flags ?? [], config.compatibility_flags ?? []) ||
    !sameJson(script.observability, config.observability)
  )
    fail(`${worker.role} live runtime or observability drift`);
}

function collectMigrationNames(value, found = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectMigrationNames(item, found);
  } else if (value && typeof value === "object") {
    if (typeof value.name === "string" && /^\d{4}_[a-z0-9_]+\.sql$/u.test(value.name))
      found.push(value.name);
    for (const item of Object.values(value)) collectMigrationNames(item, found);
  }
  return found;
}

async function readRemoteMigrations(coreConfig) {
  const result = await wranglerJson(coreConfig, [
    "d1",
    "execute",
    "DB",
    "--remote",
    "--command",
    "SELECT name FROM d1_migrations ORDER BY id",
  ]);
  return collectMigrationNames(result);
}

async function deployWorker(worker, configPath, secretsPath, sourceSha, plan) {
  const message = `atrinik-delivery-v1 source=${sourceSha} deploy=${plan.deploy} control=${plan.controls[worker.order - 1]} role=${worker.role}`;
  await command(resolve(root, "node_modules/.bin/wrangler"), [
    "deploy",
    "--strict",
    "--config",
    configPath,
    "--secrets-file",
    secretsPath,
    "--tag",
    sourceSha,
    "--message",
    message,
  ]);
  return message;
}

async function runProductionCanaries(contract) {
  for (const canary of contract.productionCanaries) {
    const [program, ...args] = canary.command;
    await command(program, args, { timeout: 120_000 });
  }
}

async function validateCheckedIn(contract) {
  await assertToolchain(contract);
  const paths = [
    resolve(root, "wrangler.jsonc"),
    resolve(root, "wrangler.publisher.jsonc"),
    resolve(root, "wrangler.rendezvous.jsonc"),
  ];
  const configs = await Promise.all(paths.map(readJsonc));
  validateTopology(contract, configs);
  await migrationLedger();
  return { paths, configs };
}

async function main() {
  const flags = new Set(process.argv.slice(2));
  if ([...flags].some((flag) => !["--dry-run", "--validate-only"].includes(flag)))
    fail("usage: production-delivery.mjs [--dry-run|--validate-only]");
  if (flags.has("--dry-run") && flags.has("--validate-only"))
    fail("choose only one production-delivery mode");

  const contract = await readJson(contractPath);
  validateContract(contract);
  const checkedIn = await validateCheckedIn(contract);
  if (flags.has("--validate-only")) {
    console.log("production delivery contract valid");
    return;
  }

  if (flags.has("--dry-run")) {
    const plan = await buildPlan(
      contract,
      checkedIn.paths,
      checkedIn.configs,
      contract.workers.map(({ requiredSecrets }) => sorted(requiredSecrets)),
    );
    console.log(
      JSON.stringify({
        outcome: "dry-run",
        mutation: false,
        deploymentOrder: contract.invariants.deploymentOrder,
        productionCanaries: contract.productionCanaries.map(({ name }) => name),
        deployableDigest: plan.deploy,
        bundles: plan.bundles,
        migrations: plan.migrations.map(({ name, sha256 }) => ({ name, sha256 })),
      }),
    );
    return;
  }

  const sourceSha = process.env.WORKERS_CI_COMMIT_SHA ?? "";
  const buildUuid = process.env.WORKERS_CI_BUILD_UUID ?? "";
  validateSourceCoordinates({
    workersCi: process.env.WORKERS_CI,
    branch: process.env.WORKERS_CI_BRANCH,
    sourceSha,
    head: await git("rev-parse", "HEAD"),
    dirty: (await git("status", "--porcelain")) !== "",
    buildUuid,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
    currentMain: await currentMainSha(contract),
  });

  const input = contract.protectedInputs;
  const configPaths = await Promise.all([
    protectedPath(input.coreConfigVariable),
    protectedPath(input.publisherConfigVariable),
    protectedPath(input.rendezvousConfigVariable),
  ]);
  const coreSecrets = await protectedPath(input.coreSecretsVariable);
  const edgeSecrets = await protectedPath(input.edgeSecretsVariable);
  const configs = await Promise.all(configPaths.map(readJsonc));
  validateTopology(contract, configs, { production: true });
  for (const [index, config] of configs.entries()) {
    if (config.account_id !== process.env.CLOUDFLARE_ACCOUNT_ID)
      fail(`${contract.workers[index].role} account identity drift`);
  }
  const coreSecretValues = await secretValues(coreSecrets);
  const edgeSecretValues = await secretValues(edgeSecrets);
  validateSecretCohort(coreSecretValues, edgeSecretValues);
  const secretSets = [
    sorted(Object.keys(coreSecretValues)),
    sorted(Object.keys(edgeSecretValues)),
    sorted(Object.keys(edgeSecretValues)),
  ];
  for (const [index, namesFound] of secretSets.entries()) {
    if (!sameValues(namesFound, contract.workers[index].requiredSecrets))
      fail(`${contract.workers[index].role} protected secret-name inventory drift`);
  }

  await command("npm", ["run", "check"]);
  if ((await git("status", "--porcelain")) !== "")
    fail("repository validation changed tracked or untracked input");
  const plan = await buildPlan(contract, configPaths, configs, secretSets);
  const remoteMigrations = await readRemoteMigrations(configPaths[0]);
  validateRemoteMigrations(
    remoteMigrations,
    plan.migrations.map(({ name }) => name),
  );
  await assertCurrentMain(contract, sourceSha);

  const active = [];
  const annotations = [];
  for (const [index, worker] of contract.workers.entries()) {
    const live = await readLiveControlPlane(
      worker,
      process.env.CLOUDFLARE_ACCOUNT_ID,
    );
    validateLiveControlPlane(worker, configs[index], live);
    const value = await readActive(configPaths[index]);
    active.push(value);
    annotations.push(validateReadback(worker, configs[index], value));
  }
  const decision = deliveryDecision(
    annotations,
    plan,
    sourceSha,
    process.env[input.controlPlaneGateVariable] ?? "",
  );
  if (decision === "no-op") {
    await runProductionCanaries(contract);
    console.log(
      JSON.stringify({
        outcome: "no-deployment-required",
        buildUuid,
        sourceSha,
        deployableDigest: plan.deploy,
        canaries: contract.productionCanaries.map(({ name }) => name),
      }),
    );
    return;
  }

  const secretsPaths = [coreSecrets, edgeSecrets, edgeSecrets];
  await executeOrderedStages(contract.workers, async (worker, index) => {
    await assertCurrentMain(contract, sourceSha);
    const message = await deployWorker(
      worker,
      configPaths[index],
      secretsPaths[index],
      sourceSha,
      plan,
    );
    await assertCurrentMain(contract, sourceSha);
    const readback = await readActive(configPaths[index]);
    validateReadback(worker, configs[index], readback, message);
    const live = await readLiveControlPlane(
      worker,
      process.env.CLOUDFLARE_ACCOUNT_ID,
    );
    validateLiveControlPlane(worker, configs[index], live);
  });
  await runProductionCanaries(contract);
  console.log(
    JSON.stringify({
      outcome: "deployed-and-read-back",
      buildUuid,
      sourceSha,
      deployableDigest: plan.deploy,
      order: contract.invariants.deploymentOrder,
      canaries: contract.productionCanaries.map(({ name }) => name),
    }),
  );
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main().catch((error) => {
    console.error(`production delivery stopped: ${error.message}`);
    process.exitCode = 1;
  });
}
