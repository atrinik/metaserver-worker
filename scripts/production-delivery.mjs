import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contractPath = resolve(root, "deployment/workers-builds-production.json");
const shaPattern = /^[0-9a-f]{40}$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const placeholderPattern = /(?:^0{16,}$|\.example(?:\.|$)|placeholder)/iu;

const expectedWorkerNames = [
  "atrinik-metaserver",
  "atrinik-metaserver-publisher",
  "atrinik-metaserver-rendezvous",
];
const commonConfigurationKeys = [
  "$schema", "account_id", "name", "main", "compatibility_date",
  "compatibility_flags", "workers_dev", "preview_urls", "services",
  "ratelimits", "secrets", "vars", "routes", "logpush", "tail_consumers",
  "streaming_tail_consumers", "observability",
];
const coreConfigurationKeys = [
  ...commonConfigurationKeys, "d1_databases", "r2_buckets", "durable_objects",
  "analytics_engine_datasets", "exports", "triggers",
];
const publicChildEnvironmentNames = [
  "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LANGUAGE", "LC_ALL",
  "LC_CTYPE", "TERM", "CI", "NO_COLOR", "FORCE_COLOR", "USER", "LOGNAME",
  "SHELL", "SSL_CERT_FILE", "SSL_CERT_DIR",
];

class DeliveryError extends Error {}

const failureEvidence = {
  buildUuid: null,
  sourceSha: null,
  deployableDigest: null,
  failedRole: "preflight",
  completedRoles: [],
  recoveryOutcome: "not-needed",
};

export function deliveryFailureRecord(error, evidence) {
  return {
    outcome: "production-delivery-stopped",
    reason:
      error instanceof DeliveryError ? error.message : "unexpected-internal-error",
    ...evidence,
  };
}

function fail(message) {
  throw new DeliveryError(message);
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
    fail("invalid JSONC configuration");
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

function assertAllowedKeys(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${label} must be an object`);
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length) fail(`${label} has unsupported authority fields`);
}

function assertArrayObjectKeys(values, allowed, label) {
  if (!Array.isArray(values)) fail(`${label} must be an array`);
  for (const value of values) assertAllowedKeys(value, allowed, label);
}

function requireNonemptyStrings(value, keys, label) {
  for (const key of keys) {
    if (typeof value[key] !== "string" || value[key].length === 0)
      fail(`${label} is missing required identifier ${key}`);
  }
}

function boundedIntegerVariable(variables, name, minimum, maximum) {
  const value = variables?.[name];
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value))
    fail(`${name} production policy is invalid`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum)
    fail(`${name} production policy is invalid`);
  return parsed;
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
      "buildEnvironment",
      "productionCanaries",
      "toolchain",
      "source",
      "protectedInputs",
      "initialBootstrapPredecessor",
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
    JSON.stringify(contract.pathIncludes) !== JSON.stringify(["*"]) ||
    contract.pathExcludes.length !== 0
  )
    fail("Workers Builds production trigger drift");
  if (
    contract.installCommand !==
      "env -i HOME=\"$HOME\" PATH=\"$PATH\" npm_config_cache=/tmp/atrinik-npm-cache npm install --global --ignore-scripts npm@11.16.0 && env -i HOME=\"$HOME\" PATH=\"$PATH\" npm_config_cache=/tmp/atrinik-npm-cache npm ci --ignore-scripts" ||
    contract.validationCommand !== "npm run check" ||
    contract.deployCommand !== "npm run deploy:production" ||
    contract.reviewCommand !== "npm run deploy:production:dry-run"
  )
    fail("production command contract drift");
  if (
    !sameJson(contract.buildEnvironment, { SKIP_DEPENDENCY_INSTALL: "1" })
  )
    fail("Workers Builds bootstrap environment drift");
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
    {
      name: "publisher-service-binding",
      command: [
        "python3",
        "scripts/dynamic_edge_canary.py",
        "--role",
        "publisher",
        "--base-url",
        "https://publish.meta.atrinik.org",
        "--expected-circuit",
        "$PUBLISH_ENABLED",
        "--disabled-retry-seconds",
        "$ROUTE_DISABLED_RETRY_SECONDS",
        "--json",
      ],
    },
    {
      name: "rendezvous-service-binding",
      command: [
        "python3",
        "scripts/dynamic_edge_canary.py",
        "--role",
        "rendezvous",
        "--base-url",
        "https://rendezvous.meta.atrinik.org",
        "--expected-circuit",
        "$RENDEZVOUS_ENABLED",
        "--disabled-retry-seconds",
        "$ROUTE_DISABLED_RETRY_SECONDS",
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
      buildsApiTokenVariable: "ATRINIK_WORKERS_BUILDS_API_TOKEN",
      controlPlaneGateVariable: "ATRINIK_PRODUCTION_CONTROL_PLANE_READY",
    })
  )
    fail("protected production input contract drift");
  if (
    JSON.stringify(contract.initialBootstrapPredecessor) !==
    JSON.stringify({
      requiredPhase: "all-builds-triggers-absent",
      allowedBindingDelta: [{
        role: "core",
        name: "CLASSIC_DIRECTORY_CUTOVER_MODE",
        type: "plain_text",
        live: "absent",
        desired: "v4-production",
      }, {
        role: "core", name: "GAME_PUBLISH_ENABLED", type: "plain_text",
        live: "enabled", desired: "disabled",
      }, {
        role: "core", name: "PUBLISH_ENABLED", type: "plain_text",
        live: "enabled", desired: "disabled",
      }, {
        role: "core", name: "RENDEZVOUS_ENABLED", type: "plain_text",
        live: "enabled", desired: "disabled",
      }, {
        role: "publisher", name: "GAME_PUBLISH_ENABLED", type: "plain_text",
        live: "enabled", desired: "disabled",
      }, {
        role: "publisher", name: "PUBLISH_ENABLED", type: "plain_text",
        live: "enabled", desired: "disabled",
      }, {
        role: "rendezvous", name: "RENDEZVOUS_ENABLED", type: "plain_text",
        live: "enabled", desired: "disabled",
      }],
    })
  )
    fail("initial production bootstrap predecessor drift");
  if (
    !Array.isArray(contract.workers) ||
    contract.workers.length !== 3 ||
    sha256Json(canonicalJson(contract.workers)) !==
      "c7d2e3c88beb26ebebcc0c043a15d7d4ac741dd0a134aee49729f772270d79fd" ||
    JSON.stringify(contract.workers.map(({ name }) => name)) !==
      JSON.stringify(expectedWorkerNames) ||
    JSON.stringify(contract.workers.map(({ order }) => order)) !==
      JSON.stringify([1, 2, 3]) ||
    contract.workers.some(({ directDeploy }) => directDeploy !== true)
  )
    fail("serialized Worker topology drift");
  const invariants = contract.invariants;
  assertExactKeys(
    invariants,
    [
      "productionWorkersDev",
      "productionPreviewUrls",
      "migrationPolicy",
      "controlPlanePolicy",
      "deploymentOrder",
      "deploymentMode",
      "buildSerialization",
      "noOp",
      "recovery",
    ],
    "production invariants",
  );
  if (
    invariants.productionWorkersDev !== false ||
    invariants.productionPreviewUrls !== false ||
    invariants.migrationPolicy !== "exact-ledger-no-automatic-apply" ||
    invariants.controlPlanePolicy !== "explicit-external-gate-before-upload" ||
    JSON.stringify(invariants.deploymentOrder) !==
      JSON.stringify(["core", "publisher", "rendezvous"]) ||
    invariants.deploymentMode !== "direct-100-percent-strict" ||
    invariants.buildSerialization !==
      "newest-current-main-build-owns-one-topology-entrypoint" ||
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

function validateConfigurationAuthority(worker, config) {
  assertAllowedKeys(
    config,
    worker.role === "core" ? coreConfigurationKeys : commonConfigurationKeys,
    `${worker.role} configuration`,
  );
  const expectedEntrypoints = {
    core: "src/index.ts",
    publisher: "src/publisher-worker.ts",
    rendezvous: "src/rendezvous-worker.ts",
  };
  if (relative(root, resolve(root, config.main)) !== expectedEntrypoints[worker.role])
    fail(`${worker.role} entrypoint drift`);
  assertArrayObjectKeys(config.d1_databases ?? [], [
    "binding", "database_name", "database_id", "migrations_dir",
  ], `${worker.role} D1 binding`);
  for (const value of config.d1_databases ?? [])
    requireNonemptyStrings(value, [
      "binding", "database_name", "database_id", "migrations_dir",
    ], `${worker.role} D1 binding`);
  assertArrayObjectKeys(config.r2_buckets ?? [], [
    "binding", "bucket_name",
  ], `${worker.role} R2 binding`);
  for (const value of config.r2_buckets ?? [])
    requireNonemptyStrings(value, ["binding", "bucket_name"],
      `${worker.role} R2 binding`);
  assertArrayObjectKeys(config.analytics_engine_datasets ?? [], [
    "binding", "dataset",
  ], `${worker.role} Analytics Engine binding`);
  for (const value of config.analytics_engine_datasets ?? [])
    requireNonemptyStrings(value, ["binding", "dataset"],
      `${worker.role} Analytics Engine binding`);
  assertAllowedKeys(config.durable_objects ?? { bindings: [] }, ["bindings"],
    `${worker.role} Durable Object configuration`);
  assertArrayObjectKeys(config.durable_objects?.bindings ?? [], [
    "name", "class_name",
  ], `${worker.role} Durable Object binding`);
  for (const value of config.durable_objects?.bindings ?? [])
    requireNonemptyStrings(value, ["name", "class_name"],
      `${worker.role} Durable Object binding`);
  assertArrayObjectKeys(config.services ?? [], [
    "binding", "service", "entrypoint",
  ], `${worker.role} Service Binding`);
  for (const value of config.services ?? [])
    requireNonemptyStrings(value, ["binding", "service", "entrypoint"],
      `${worker.role} Service Binding`);
  assertArrayObjectKeys(config.ratelimits ?? [], [
    "name", "namespace_id", "simple",
  ], `${worker.role} rate-limit binding`);
  for (const value of config.ratelimits ?? []) {
    requireNonemptyStrings(value, ["name", "namespace_id"],
      `${worker.role} rate-limit binding`);
    assertAllowedKeys(value.simple, ["limit", "period"],
      `${worker.role} rate-limit policy`);
    if (
      !Number.isInteger(value.simple.limit) || value.simple.limit <= 0 ||
      !Number.isInteger(value.simple.period) || value.simple.period <= 0
    ) fail(`${worker.role} rate-limit policy is invalid`);
  }
  assertArrayObjectKeys(config.routes ?? [], ["pattern", "custom_domain"],
    `${worker.role} route`);
  assertAllowedKeys(config.secrets, ["required"], `${worker.role} secret contract`);
  assertAllowedKeys(config.triggers ?? { crons: [] }, ["crons"],
    `${worker.role} trigger contract`);
  assertAllowedKeys(config.observability, ["enabled", "logs", "traces"],
    `${worker.role} observability`);
  assertAllowedKeys(config.observability?.logs, [
    "enabled", "head_sampling_rate", "invocation_logs", "persist", "destinations",
  ], `${worker.role} log observability`);
  assertAllowedKeys(config.observability?.traces, [
    "enabled", "head_sampling_rate", "persist", "destinations",
  ], `${worker.role} trace observability`);
  if (
    !sameJson(config.observability.logs.destinations, []) ||
    !sameJson(config.observability.traces.destinations, [])
  ) fail(`${worker.role} observability destination authority drift`);
  for (const value of [...requiredSecrets(config), ...Object.values(config.vars ?? {})]) {
    if (typeof value !== "string" || value.length === 0)
      fail(`${worker.role} has a missing secret, variable, or identifier`);
  }
  if (
    config.logpush !== false ||
    !sameJson(config.tail_consumers, []) ||
    !sameJson(config.streaming_tail_consumers, [])
  ) fail(`${worker.role} log or tail authority drift`);
  const expectedExports = worker.role === "core" ? {
    RendezvousRoom: { type: "durable-object", storage: "sqlite" },
    DirectoryBuilder: { type: "durable-object", storage: "sqlite" },
    PublisherCoordinator: { type: "worker", cache: { enabled: false } },
    RendezvousCoordinator: { type: "worker", cache: { enabled: false } },
  } : {};
  if (!sameJson(config.exports ?? {}, expectedExports))
    fail(`${worker.role} exports authority drift`);
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
    validateConfigurationAuthority(worker, config);
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
    if (
      production &&
      (!/^[0-9a-f]{32}$/u.test(config.account_id ?? "") ||
        (config.d1_databases ?? []).some(
          ({ database_id: id }) => !uuidPattern.test(id ?? ""),
        ) ||
        (config.ratelimits ?? []).some(
          ({ namespace_id: id }) => !/^[1-9][0-9]*$/u.test(String(id)),
        ))
    )
      fail(`${worker.role} production resource identifier is invalid`);
  }

  const [core, publisher, rendezvous] = configs;
  const circuits = [
    [core, publisher, "PUBLISH_ENABLED"],
    [core, publisher, "GAME_PUBLISH_ENABLED"],
    [core, rendezvous, "RENDEZVOUS_ENABLED"],
  ];
  for (const [owner, caller, name] of circuits) {
    if (
      !["enabled", "disabled"].includes(owner.vars?.[name]) ||
      owner.vars?.[name] !== caller.vars?.[name]
    ) fail(`${name} production circuit authority drift`);
  }
  const retrySeconds = boundedIntegerVariable(
    core.vars,
    "ROUTE_DISABLED_RETRY_SECONDS",
    1,
    86_400,
  );
  for (const caller of [publisher, rendezvous]) {
    if (
      boundedIntegerVariable(
        caller.vars,
        "ROUTE_DISABLED_RETRY_SECONDS",
        1,
        86_400,
      ) !== retrySeconds
    ) fail("route-disabled retry policy drift");
  }
  const listingTtl = boundedIntegerVariable(
    core.vars,
    "LISTING_TTL_SECONDS",
    960,
    86_400,
  );
  boundedIntegerVariable(core.vars, "PUBLISH_SERVER_DAILY_LIMIT", 1, 48);
  boundedIntegerVariable(core.vars, "RENDEZVOUS_SERVER_DAILY_LIMIT", 1, 50);
  boundedIntegerVariable(core.vars, "RENDEZVOUS_CLIENT_PAIR_BURST_LIMIT", 1, 20);
  boundedIntegerVariable(core.vars, "RENDEZVOUS_CLIENT_PAIR_WINDOW_SECONDS", 1, 60);
  const initialCooldown = boundedIntegerVariable(
    core.vars,
    "RENDEZVOUS_CLIENT_PAIR_INITIAL_COOLDOWN_SECONDS",
    1,
    30,
  );
  const maximumCooldown = boundedIntegerVariable(
    core.vars,
    "RENDEZVOUS_CLIENT_PAIR_MAXIMUM_COOLDOWN_SECONDS",
    initialCooldown,
    900,
  );
  boundedIntegerVariable(
    core.vars,
    "RENDEZVOUS_CLIENT_PAIR_RESET_SECONDS",
    maximumCooldown,
    1_800,
  );
  boundedIntegerVariable(core.vars, "RENDEZVOUS_ACTIVE_CLIENT_LIMIT", 1, 16);
  boundedIntegerVariable(core.vars, "RENDEZVOUS_CLIENT_SESSION_SECONDS", 1, 15);
  boundedIntegerVariable(
    core.vars,
    "DIRECTORY_REFRESH_LEAD_SECONDS",
    1,
    Math.min(7_200, 14_399, listingTtl - 900),
  );
  if (!["v4-production", "v5-production"].includes(
    core.vars?.CLASSIC_DIRECTORY_CUTOVER_MODE,
  )) fail("Classic directory cutover policy drift");
  if (
    production &&
    (!/^[0-9a-f]{32}$/u.test(core.vars?.DIRECTORY_CACHE_ZONE_ID ?? "") ||
      core.vars?.CLASSIC_DIRECTORY_PUBLIC_ORIGIN !==
        "https://classic.meta.atrinik.org" ||
      core.vars?.GAME_DIRECTORY_PUBLIC_ORIGIN !== "https://meta.atrinik.org" ||
      core.vars?.PUBLISH_HOSTNAME !== publisher.vars?.PUBLISH_HOSTNAME ||
      publisher.vars?.PUBLISH_HOSTNAME !==
        contract.workers[1].customDomains[0] ||
      core.vars?.RENDEZVOUS_HOSTNAME !== rendezvous.vars?.RENDEZVOUS_HOSTNAME ||
      rendezvous.vars?.RENDEZVOUS_HOSTNAME !==
        contract.workers[2].customDomains[0])
  ) fail("production domain, origin, or zone authority drift");
  for (const key of [
    "SOURCE_TAG_KEY_CURRENT_ID",
    "SOURCE_TAG_KEY_PREVIOUS_ID",
  ]) {
    if (
      core.vars?.[key] !== publisher.vars?.[key] ||
      core.vars?.[key] !== rendezvous.vars?.[key] ||
      typeof core.vars?.[key] !== "string" ||
      !core.vars[key]
    )
      fail("source-tag configuration epoch drift");
  }
  if (
    !/^[A-Za-z0-9_-]{1,32}$/u.test(core.vars.SOURCE_TAG_KEY_CURRENT_ID) ||
    !/^[A-Za-z0-9_-]{1,32}$/u.test(core.vars.SOURCE_TAG_KEY_PREVIOUS_ID) ||
    core.vars.SOURCE_TAG_KEY_CURRENT_ID === core.vars.SOURCE_TAG_KEY_PREVIOUS_ID
  ) fail("source-tag configuration epoch is invalid");
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
    if ((config.triggers?.crons ?? []).length)
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
  const match = /^atrinik-delivery-v1 source=([0-9a-f]{40}) deploy=([0-9a-f]{64}) migration=([0-9a-f]{64}) horizon=([1-9][0-9]*) control=([0-9a-f]{64}) role=(core|publisher|rendezvous) phase=(staged|active)$/u.exec(
    message ?? "",
  );
  return match
    ? {
        source: match[1],
        deploy: match[2],
        migration: match[3],
        migrationHorizon: Number(match[4]),
        control: match[5],
        role: match[6],
        phase: match[7],
      }
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
  if (!uuidPattern.test(coordinates.buildUuid))
    fail("WORKERS_CI_BUILD_UUID is missing or invalid");
  if (
    coordinates.overrideName !== expectedWorkerNames[0] ||
    typeof coordinates.matchTag !== "string" ||
    coordinates.matchTag.length === 0
  )
    fail("Workers Builds project identity is missing or unexpected");
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
  const approved = controlGate === `approved:${sourceSha}`;
  for (const value of annotations) {
    if (!value) continue;
    if (
      value.migration === plan.migrationDigest &&
      value.migrationHorizon === plan.migrations.length
    ) continue;
    const horizon = value.migrationHorizon;
    const appendOnly =
      Number.isInteger(horizon) &&
      horizon > 0 &&
      horizon < plan.migrations.length &&
      value.migration === sha256Json(plan.migrations.slice(0, horizon));
    if (!appendOnly || !approved)
      fail("production migration content is divergent or not authorized");
  }
  const coherentNoOp = annotations.every(
    (value, index) =>
      value?.deploy === plan.deploy &&
      value.migration === plan.migrationDigest &&
      value.migrationHorizon === plan.migrations.length &&
      value.control === plan.controls[index] &&
      value.role === ["core", "publisher", "rendezvous"][index] &&
      value.phase === "active",
  );
  const activeSources = new Set(annotations.map((value) => value?.source));
  if (coherentNoOp && activeSources.size === 1 && controlGate === "routine")
    return "no-op";
  const controlChanged = annotations.some((value, index) =>
    !value || ![
      plan.controls[index],
      plan.stagedControls?.[index],
    ].includes(value.control));
  if (controlChanged && !approved)
    fail("separately authorized control-plane prerequisite is not verified");
  if (!controlChanged && controlGate !== "routine" && !approved)
    fail("routine production gate is missing or ambiguous");
  return "deploy";
}

export function assertDeployableTopology(annotations, plan) {
  const sources = new Set(annotations.map((value) => value?.source));
  if (
    sources.size !== 1 ||
    !annotations.every(
      (value, index) =>
        value?.deploy === plan.deploy &&
        value.migration === plan.migrationDigest &&
        value.migrationHorizon === plan.migrations.length &&
        value.control === plan.controls[index] &&
        value.role === ["core", "publisher", "rendezvous"][index] &&
        value.phase === "active",
    )
  )
    fail("production topology is not one coherent deployable configuration");
}

export function assertCoherentTopology(
  annotations,
  plan,
  sourceSha,
  { phase = "active", controls = plan.controls } = {},
) {
  if (
    !annotations.every(
      (value, index) =>
        value?.source === sourceSha &&
        value.deploy === plan.deploy &&
        value.migration === plan.migrationDigest &&
        value.migrationHorizon === plan.migrations.length &&
        value.control === controls[index] &&
        value.role === ["core", "publisher", "rendezvous"][index] &&
        value.phase === phase,
    )
  )
    fail("final production topology is not one coherent source and configuration");
}

export async function executeOrderedStages(workers, action) {
  for (const [index, worker] of workers.entries()) await action(worker, index);
}

export async function recoverDisabledCore({
  coreStaged,
  fence,
  readActive,
  expectedMessage,
  deployStaged,
  validateStaged,
}) {
  if (!coreStaged) return "not-needed";
  await fence();
  let active = await readActive();
  let expected = expectedMessage();
  if (active.version.annotations?.["workers/message"] !== expected) {
    expected = await deployStaged();
    await fence();
    active = await readActive();
  }
  await validateStaged(active, expected);
  return "proven";
}

export async function deployStagedWithRecoveryIntent(
  worker,
  markCorePossiblyMutated,
  deploy,
) {
  if (worker.role === "core") markCorePossiblyMutated();
  return deploy();
}

export async function orchestrateDelivery({
  workers,
  decision,
  fence,
  deployStaged,
  readbackStaged,
  verifyStaged,
  deployActive,
  readbackActive,
  verifyFinal,
  canaries,
  recover,
  completed = () => {},
}) {
  try {
    if (decision === "deploy") {
      await executeOrderedStages(workers, async (worker, index) => {
        await fence();
        await deployStaged(worker, index);
        await fence();
        await readbackStaged(worker, index);
        completed(`staged:${worker.role ?? worker}`);
      });
      await fence();
      await verifyStaged();
      for (const index of [1, 2, 0]) {
        const worker = workers[index];
        await fence();
        await deployActive(worker, index);
        await fence();
        await readbackActive(worker, index);
        completed(`active:${worker.role ?? worker}`);
      }
    }
    await fence();
    await verifyFinal(decision);
    await canaries();
    await fence();
    return decision === "deploy"
      ? "deployed-and-read-back"
      : "no-deployment-required";
  } catch (error) {
    if (decision === "deploy") {
      try {
        await recover(error);
      } catch {
        fail("production delivery stopped and disabled-circuit recovery was not proven");
      }
    }
    throw error;
  }
}

export function controlPlaneView(config) {
  const normalized = structuredClone(config);
  if (typeof normalized.main === "string" && isAbsolute(normalized.main))
    normalized.main = relative(root, normalized.main);
  return canonicalJson(normalized);
}

function configurationDigest(config) {
  const normalized = structuredClone(config);
  if (typeof normalized.main === "string" && isAbsolute(normalized.main))
    normalized.main = relative(root, normalized.main);
  return sha256Json(canonicalJson(normalized));
}

export function childEnvironment(input, policy = "public") {
  const environment = Object.fromEntries(
    publicChildEnvironmentNames
      .filter((name) => typeof input[name] === "string")
      .map((name) => [name, input[name]]),
  );
  if (policy === "deployment") {
    if (input.CLOUDFLARE_ACCOUNT_ID)
      environment.CLOUDFLARE_ACCOUNT_ID = input.CLOUDFLARE_ACCOUNT_ID;
    if (input.CLOUDFLARE_API_TOKEN)
      environment.CLOUDFLARE_API_TOKEN = input.CLOUDFLARE_API_TOKEN;
  } else if (policy !== "public") {
    fail("unknown subprocess environment policy");
  }
  return environment;
}

export function sanitizedChildEnvironment(input) {
  return childEnvironment(input, "deployment");
}

async function command(program, args, options = {}) {
  const {
    failureCode = "subprocess-execution-failed",
    environmentPolicy = "public",
    ...execOptions
  } = options;
  const environment = childEnvironment(process.env, environmentPolicy);
  try {
    return await execFileAsync(program, args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      env: environment,
      ...execOptions,
    });
  } catch {
    fail(failureCode);
  }
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
    nodeVersionFile:
      (await readFile(resolve(root, ".nvmrc"), "utf8")).trim() ===
      contract.toolchain.node,
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

export function validateProtectedDocument(value, variable) {
  if (typeof value !== "string" || value.length === 0)
    fail(`${variable} is missing`);
  if (Buffer.byteLength(value, "utf8") > 5 * 1024)
    fail(`${variable} exceeds the Workers Builds variable limit`);
  if (value.includes("\0")) fail(`${variable} contains an invalid byte`);
  return value;
}

export async function materializeProtectedInputs(input) {
  const directory = await mkdtemp(
    resolve(tmpdir(), "atrinik-production-inputs-"),
  );
  await chmod(directory, 0o700);
  const specifications = [
    [input.coreConfigVariable, "core.jsonc"],
    [input.publisherConfigVariable, "publisher.jsonc"],
    [input.rendezvousConfigVariable, "rendezvous.jsonc"],
  ];
  try {
    const paths = [];
    for (const [variable, filename] of specifications) {
      const path = resolve(directory, filename);
      const document = validateProtectedDocument(process.env[variable], variable);
      let config;
      try {
        config = JSON.parse(stripJsonc(document));
      } catch {
        fail(`${variable} contains invalid JSONC`);
      }
      if (typeof config.main !== "string" || isAbsolute(config.main))
        fail(`${variable} must contain a repository-relative entrypoint`);
      const entrypoint = resolve(root, config.main);
      const entrypointFromRoot = relative(root, entrypoint);
      if (entrypointFromRoot.startsWith("..") || isAbsolute(entrypointFromRoot))
        fail(`${variable} entrypoint resolves outside the repository`);
      config.main = entrypoint;
      await writeFile(
        path,
        JSON.stringify(config),
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
      paths.push(path);
    }
    return {
      directory,
      configPaths: paths,
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export function disabledCircuitConfiguration(config, role) {
  const staged = structuredClone(config);
  const variables = {
    core: ["PUBLISH_ENABLED", "GAME_PUBLISH_ENABLED", "RENDEZVOUS_ENABLED"],
    publisher: ["PUBLISH_ENABLED", "GAME_PUBLISH_ENABLED"],
    rendezvous: ["RENDEZVOUS_ENABLED"],
  }[role];
  if (!variables) fail("unknown Worker role for disabled-circuit staging");
  for (const name of variables) {
    if (!(name in (staged.vars ?? {})))
      fail(`${role} disabled-circuit variable is missing`);
    staged.vars[name] = "disabled";
  }
  return staged;
}

async function materializeStagedConfigurations(directory, configs, workers) {
  const stagedConfigs = configs.map((config, index) =>
    disabledCircuitConfiguration(config, workers[index].role));
  const stagedPaths = [];
  for (const [index, config] of stagedConfigs.entries()) {
    const path = resolve(directory, `staged-${workers[index].role}.json`);
    await writeFile(path, JSON.stringify(config), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    stagedPaths.push(path);
  }
  return { stagedConfigs, stagedPaths };
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

async function buildPlan(
  contract,
  configPaths,
  configs,
  secretSets,
  stagedPaths = configPaths,
  stagedConfigs = configs,
) {
  const migrations = await migrationLedger();
  const bundles = await bundleWorkers(configPaths);
  const configurations = configs.map(configurationDigest);
  const controls = configs.map((config) => sha256Json(controlPlaneView(config)));
  const stagedConfigurations = stagedConfigs.map(configurationDigest);
  const stagedControls = stagedConfigs.map(
    (config) => sha256Json(controlPlaneView(config)));
  const stagedBundles = sameJson(stagedConfigs, configs)
    ? bundles
    : await bundleWorkers(stagedPaths);
  const migrationDigest = sha256Json(migrations);
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
    stagedConfigurations,
    stagedBundles,
    secretSets,
  });
  return {
    deploy,
    controls,
    stagedControls,
    configurations,
    bundles,
    stagedBundles,
    migrations,
    migrationDigest,
  };
}

async function currentMainSha(contract) {
  let response;
  try {
    response = await fetch(contract.source.currentMainUrl, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "atrinik-metaserver-workers-builds",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    fail("current-main readback request failed");
  }
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
  ], { environmentPolicy: "deployment" });
  return JSON.parse(stdout);
}

async function cloudflareResult(
  accountId,
  path,
  { method = "GET", token = process.env.CLOUDFLARE_API_TOKEN } = {},
) {
  if (!token) fail("Workers Builds Cloudflare API token is missing");
  let response;
  try {
    response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`,
      {
        method,
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      },
    );
  } catch {
    fail("Cloudflare control-plane request failed");
  }
  if (!response.ok)
    fail(`Cloudflare control-plane readback failed with HTTP ${response.status}`);
  const body = await response.json();
  if (body?.success !== true || !("result" in body))
    fail("Cloudflare control-plane readback returned an invalid result");
  return body.result;
}

function activeBuild(build) {
  return ["queued", "initializing", "running"].includes(build.status);
}

export function selectBuildLeaseOwner(builds, sourceSha, triggerUuid) {
  const eligible = builds
    .filter(
      (build) =>
        activeBuild(build) &&
        build.trigger?.trigger_uuid === triggerUuid &&
        build.build_trigger_metadata?.branch === "main" &&
        build.build_trigger_metadata?.commit_hash === sourceSha,
    )
    .sort((left, right) => {
      const created = String(left.created_on).localeCompare(String(right.created_on));
      return created || String(left.build_uuid).localeCompare(String(right.build_uuid));
    });
  if (eligible.length === 0) fail("no active eligible production build exists");
  const owner = eligible.at(-1);
  return owner.build_uuid;
}

export function buildLeaseDecision(builds, sourceSha, triggerUuid, buildUuid) {
  if (selectBuildLeaseOwner(builds, sourceSha, triggerUuid) !== buildUuid)
    fail("another main build owns the production topology lease");
  return builds.filter(
    (build) =>
      build.build_uuid !== buildUuid &&
      activeBuild(build) &&
      build.trigger?.trigger_uuid === triggerUuid &&
      build.build_trigger_metadata?.branch === "main",
  );
}

export async function arbitrateBuildLease({
  sourceSha,
  buildUuid,
  triggerUuid,
  currentMain,
  listBuilds,
  cancelBuild,
  readBuild,
  pause = () => wait(1_000),
  rounds = 3,
  polls = 30,
}) {
  const proveCurrent = async () => {
    if (await currentMain() !== sourceSha)
      fail("build SHA is superseded by current main");
  };
  let cancellationAuthorized = false;
  for (let round = 0; round < rounds; round += 1) {
    const builds = await listBuilds();
    if (!Array.isArray(builds)) fail("Workers Builds lease inventory is invalid");
    const competitors = buildLeaseDecision(
      builds,
      sourceSha,
      triggerUuid,
      buildUuid,
    );
    if (competitors.length === 0) {
      await proveCurrent();
      return;
    }
    if (
      round > 0 &&
      competitors.some(
        (build) => build.build_trigger_metadata?.commit_hash !== sourceSha,
      )
    ) fail("production build lease changed during arbitration");
    if (!cancellationAuthorized) {
      // Prove direction only after observing competitors, then retain one final
      // proof after convergence. The no-competitor path needs only the latter.
      await proveCurrent();
      cancellationAuthorized = true;
    }
    for (const build of competitors) {
      await cancelBuild(build.build_uuid);
    }
    for (const build of competitors) {
      let stopped = false;
      for (let attempt = 0; attempt < polls; attempt += 1) {
        if (!activeBuild(await readBuild(build.build_uuid))) {
          stopped = true;
          break;
        }
        await pause();
      }
      if (!stopped) fail("competing production build did not release the lease");
    }
  }
  const finalBuilds = await listBuilds();
  if (!Array.isArray(finalBuilds)) fail("Workers Builds lease inventory is invalid");
  if (buildLeaseDecision(
    finalBuilds,
    sourceSha,
    triggerUuid,
    buildUuid,
  ).length !== 0) fail("production build lease did not converge");
  await proveCurrent();
}

export function validateBuildTrigger(contract, build, matchTag) {
  const metadata = build.build_trigger_metadata ?? {};
  const trigger = build.trigger ?? {};
  const connection = trigger.repo_connection ?? {};
  const normalizedRoot = trigger.root_directory === "/" ? "" : trigger.root_directory;
  if (
    metadata.build_command !== contract.installCommand ||
    metadata.deploy_command !== contract.deployCommand ||
    !["push", "manual", "api"].includes(metadata.build_trigger_source) ||
    metadata.provider_type !== "github" ||
    metadata.provider_account_name !== "atrinik" ||
    metadata.repo_name !== "metaserver-worker" ||
    (metadata.root_directory === "/" ? "" : metadata.root_directory) !==
      contract.rootDirectory ||
    metadata.environment_variables?.SKIP_DEPENDENCY_INSTALL !== "1" ||
    trigger.build_command !== contract.installCommand ||
    trigger.deploy_command !== contract.deployCommand ||
    normalizedRoot !== contract.rootDirectory ||
    !sameValues(trigger.branch_includes ?? [], [contract.productionBranch]) ||
    !sameValues(trigger.branch_excludes ?? [], []) ||
    !sameValues(trigger.path_includes ?? [], contract.pathIncludes) ||
    !sameValues(trigger.path_excludes ?? [], contract.pathExcludes) ||
    trigger.external_script_id !== matchTag ||
    connection.provider_type !== "github" ||
    connection.provider_account_name !== "atrinik" ||
    connection.repo_name !== "metaserver-worker"
  ) fail("live Workers Builds trigger drift");
}

export function validateBuildEnvironment(contract, environment) {
  const protectedNames = [
    contract.protectedInputs.accountVariable,
    contract.protectedInputs.coreConfigVariable,
    contract.protectedInputs.publisherConfigVariable,
    contract.protectedInputs.rendezvousConfigVariable,
    contract.protectedInputs.buildsApiTokenVariable,
    contract.protectedInputs.controlPlaneGateVariable,
  ];
  if (!sameValues(Object.keys(environment), [
    ...Object.keys(contract.buildEnvironment),
    ...protectedNames,
  ])) fail("live Workers Builds environment inventory drift");
  if (
    environment.SKIP_DEPENDENCY_INSTALL?.is_secret !== false ||
    environment.SKIP_DEPENDENCY_INSTALL?.value !== "1"
  ) fail("live Workers Builds bootstrap environment drift");
  for (const name of protectedNames) {
    if (environment[name]?.is_secret !== true || environment[name]?.value != null)
      fail("protected Workers Builds environment classification drift");
  }
}

export function selectLiveTrigger(triggers, triggerUuid) {
  if (!Array.isArray(triggers))
    fail("live Workers Builds trigger inventory is invalid");
  const matching = triggers.filter(
    ({ trigger_uuid: value }) => value === triggerUuid,
  );
  if (matching.length !== 1)
    fail("live Workers Builds trigger is missing or ambiguous");
  return matching[0];
}

async function assertBuildLease(
  contract,
  sourceSha,
  buildUuid,
  { arbitrate = true } = {},
) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = validateProtectedDocument(
    process.env[contract.protectedInputs.buildsApiTokenVariable],
    contract.protectedInputs.buildsApiTokenVariable,
  );
  const self = await cloudflareResult(
    accountId,
    `/builds/builds/${encodeURIComponent(buildUuid)}`,
    { token },
  );
  const triggerUuid = self.trigger?.trigger_uuid;
  if (
    self.build_uuid !== buildUuid ||
    !activeBuild(self) ||
    self.build_trigger_metadata?.branch !== "main" ||
    self.build_trigger_metadata?.commit_hash !== sourceSha ||
    typeof triggerUuid !== "string" ||
    !triggerUuid
  )
    fail("Workers Builds execution identity or command drift");
  const liveTriggers = await cloudflareResult(
    accountId,
    `/builds/workers/${encodeURIComponent(process.env.WRANGLER_CI_MATCH_TAG)}/triggers`,
    { token },
  );
  const liveTrigger = selectLiveTrigger(liveTriggers, triggerUuid);
  validateBuildTrigger(
    contract,
    {
      build_trigger_metadata: self.build_trigger_metadata,
      trigger: liveTrigger,
    },
    process.env.WRANGLER_CI_MATCH_TAG,
  );
  validateBuildEnvironment(
    contract,
    await cloudflareResult(
      accountId,
      `/builds/triggers/${encodeURIComponent(triggerUuid)}/environment_variables`,
      { token },
    ),
  );
  if (!arbitrate) return;
  const buildsPath =
    `/builds/workers/${encodeURIComponent(process.env.WRANGLER_CI_MATCH_TAG)}/builds`;
  await arbitrateBuildLease({
    sourceSha,
    buildUuid,
    triggerUuid,
    currentMain: () => currentMainSha(contract),
    listBuilds: () => cloudflareResult(accountId, buildsPath, { token }),
    cancelBuild: (uuid) => cloudflareResult(
      accountId,
      `/builds/builds/${encodeURIComponent(uuid)}/cancel`,
      { method: "PUT", token },
    ),
    readBuild: (uuid) => cloudflareResult(
      accountId,
      `/builds/builds/${encodeURIComponent(uuid)}`,
      { token },
    ),
  });
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

function remoteSecretNames(version) {
  return sorted(
    (version.resources?.bindings ?? [])
      .filter(({ type }) => type === "secret_text")
      .map(({ name }) => name)
      .filter(Boolean),
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

export function validateRemoteBindings(worker, config, version) {
  const expected = expectedRemoteBindings(config);
  const rows = version.resources?.bindings ?? [];
  const actual = new Map(
    rows.map((binding) => [binding.name, binding]),
  );
  if (actual.size !== rows.length || !sameValues(actual.keys(), expected.keys()))
    fail(`${worker.role} remote binding inventory drift`);
  for (const [name, fields] of expected) {
    const binding = actual.get(name);
    for (const [field, value] of Object.entries(fields)) {
      if (JSON.stringify(binding?.[field]) !== JSON.stringify(value))
        fail(`${worker.role} remote binding configuration drift`);
    }
  }
}

export function validateRuntimeExports(worker, config, actual) {
  const expected = config.exports ?? {};
  const normalized = Object.fromEntries(
    Object.entries(actual).map(([name, value]) => {
      const entry = { ...value };
      if (entry.state === "created") delete entry.state;
      return [name, entry];
    }),
  );
  if (!sameJson(normalized, expected))
    fail(`${worker.role} live exports reconciliation drift`);
}

function validateReadback(
  worker,
  config,
  active,
  expectedMessage = null,
  { exact = true } = {},
) {
  const message = active.version.annotations?.["workers/message"];
  const parsed = parseVersionMessage(message);
  if (expectedMessage && message !== expectedMessage)
    fail(`${worker.role} version annotation does not match this deployment`);
  if (
    exact &&
    !sameValues(remoteBindingNames(active.version), configBindingNames(config))
  ) fail(`${worker.role} remote binding inventory drift`);
  if (
    !exact &&
    !sameValues(remoteSecretNames(active.version), requiredSecrets(config))
  ) fail(`${worker.role} remote secret inventory drift`);
  if (exact) validateRemoteBindings(worker, config, active.version);
  const runtime = active.version.resources?.script_runtime ?? {};
  if (
    exact &&
    (runtime.compatibility_date !== config.compatibility_date ||
      !sameValues(runtime.compatibility_flags ?? [], config.compatibility_flags ?? []))
  )
    fail(`${worker.role} remote runtime configuration drift`);
  if (exact) validateRuntimeExports(worker, config, runtime.exports ?? {});
  return parsed;
}

export function validateLiveControlPlane(
  worker,
  config,
  live,
  { exactRuntime = true, expectedZoneId = null } = {},
) {
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
    expectedZoneId !== null &&
    (live.customDomains ?? []).some(
      ({ zone_id: zoneId, zone_name: zoneName }) =>
        zoneId !== expectedZoneId || zoneName !== "atrinik.org",
    )
  ) fail(`${worker.role} live Custom Domain zone authority drift`);
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
    exactRuntime &&
    (!script ||
      script.compatibility_date !== config.compatibility_date ||
      !sameValues(script.compatibility_flags ?? [], config.compatibility_flags ?? []) ||
      !sameJson(script.observability, config.observability))
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

async function deployWorker(
  worker,
  configPath,
  sourceSha,
  plan,
  { phase = "active", controls = plan.controls } = {},
) {
  const message = `atrinik-delivery-v1 source=${sourceSha} deploy=${plan.deploy} migration=${plan.migrationDigest} horizon=${plan.migrations.length} control=${controls[worker.order - 1]} role=${worker.role} phase=${phase}`;
  await command(resolve(root, "node_modules/.bin/wrangler"), [
    "deploy",
    "--strict",
    "--config",
    configPath,
    "--tag",
    sourceSha,
    "--message",
    message,
  ], { environmentPolicy: "deployment" });
  return message;
}

async function runProductionCanaries(contract, configs) {
  for (const canary of contract.productionCanaries) {
    const roleIndex = {
      "publisher-service-binding": 1,
      "rendezvous-service-binding": 2,
    }[canary.name];
    const variables = roleIndex === undefined ? {} : configs[roleIndex].vars;
    const resolved = canary.command.map((value) => ({
      "$PUBLISH_ENABLED": variables.PUBLISH_ENABLED,
      "$RENDEZVOUS_ENABLED": variables.RENDEZVOUS_ENABLED,
      "$ROUTE_DISABLED_RETRY_SECONDS": variables.ROUTE_DISABLED_RETRY_SECONDS,
    })[value] ?? value);
    if (resolved.some((value) => value.startsWith("$")))
      fail(`${canary.name} has an unresolved canary input`);
    const [program, ...args] = resolved;
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
        migrationDigest: plan.migrationDigest,
        bundles: plan.bundles,
        migrations: plan.migrations.map(({ name, sha256 }) => ({ name, sha256 })),
      }),
    );
    return;
  }

  const sourceSha = process.env.WORKERS_CI_COMMIT_SHA ?? "";
  const buildUuid = process.env.WORKERS_CI_BUILD_UUID ?? "";
  const checkoutHead = await git("rev-parse", "HEAD");
  failureEvidence.sourceSha = shaPattern.test(sourceSha) ? sourceSha : null;
  failureEvidence.buildUuid = uuidPattern.test(buildUuid) ? buildUuid : null;
  validateSourceCoordinates({
    workersCi: process.env.WORKERS_CI,
    branch: process.env.WORKERS_CI_BRANCH,
    sourceSha,
    head: checkoutHead,
    dirty: (await git("status", "--porcelain")) !== "",
    buildUuid,
    overrideName: process.env.WRANGLER_CI_OVERRIDE_NAME,
    matchTag: process.env.WRANGLER_CI_MATCH_TAG,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
    currentMain: await currentMainSha(contract),
  });

  const input = contract.protectedInputs;
  await assertBuildLease(contract, sourceSha, buildUuid, { arbitrate: false });
  await command("npm", ["run", "check"]);
  if ((await git("status", "--porcelain")) !== "")
    fail("repository validation changed tracked or untracked input");

  const protectedInputs = await materializeProtectedInputs(input);
  try {
  const { configPaths } = protectedInputs;
  const configs = await Promise.all(configPaths.map(readJsonc));
  validateTopology(contract, configs, { production: true });
  const { stagedConfigs, stagedPaths } = await materializeStagedConfigurations(
    protectedInputs.directory,
    configs,
    contract.workers,
  );
  validateTopology(contract, stagedConfigs, { production: true });
  for (const [index, config] of configs.entries()) {
    if (config.account_id !== process.env.CLOUDFLARE_ACCOUNT_ID)
      fail(`${contract.workers[index].role} account identity drift`);
  }
  const secretSets = contract.workers.map(({ requiredSecrets }) =>
    sorted(requiredSecrets),
  );
  const plan = await buildPlan(
    contract,
    configPaths,
    configs,
    secretSets,
    stagedPaths,
    stagedConfigs,
  );
  failureEvidence.deployableDigest = plan.deploy;
  await assertBuildLease(contract, sourceSha, buildUuid);
  const remoteMigrations = await readRemoteMigrations(configPaths[0]);
  validateRemoteMigrations(
    remoteMigrations,
    plan.migrations.map(({ name }) => name),
  );
  const annotations = [];
  for (const [index, worker] of contract.workers.entries()) {
    const live = await readLiveControlPlane(
      worker,
      process.env.CLOUDFLARE_ACCOUNT_ID,
    );
    validateLiveControlPlane(worker, configs[index], live, {
      exactRuntime: false,
      expectedZoneId: configs[0].vars.DIRECTORY_CACHE_ZONE_ID,
    });
    const value = await readActive(configPaths[index]);
    annotations.push(
      validateReadback(worker, configs[index], value, null, { exact: false }),
    );
  }
  const decision = deliveryDecision(
    annotations,
    plan,
    sourceSha,
    process.env[input.controlPlaneGateVariable] ?? "",
  );
  const expectedStagedMessages = new Map();
  const expectedActiveMessages = new Map();
  let coreStaged = false;
  const fence = async () => {
    await assertBuildLease(contract, sourceSha, buildUuid);
  };
  const outcome = await orchestrateDelivery({
    workers: contract.workers,
    decision,
    fence,
    deployStaged: async (worker, index) => {
      failureEvidence.failedRole = `staged:${worker.role}`;
      expectedStagedMessages.set(
        worker.role,
        await deployStagedWithRecoveryIntent(
          worker,
          () => { coreStaged = true; },
          () => deployWorker(worker, stagedPaths[index], sourceSha, plan, {
            phase: "staged",
            controls: plan.stagedControls,
          }),
        ),
      );
    },
    readbackStaged: async (worker, index) => {
      validateReadback(
        worker,
        stagedConfigs[index],
        await readActive(stagedPaths[index]),
        expectedStagedMessages.get(worker.role),
      );
      validateLiveControlPlane(
        worker,
        stagedConfigs[index],
        await readLiveControlPlane(worker, process.env.CLOUDFLARE_ACCOUNT_ID),
        { expectedZoneId: configs[0].vars.DIRECTORY_CACHE_ZONE_ID },
      );
    },
    verifyStaged: async () => {
      const annotations = [];
      for (const [index, worker] of contract.workers.entries()) {
        annotations.push(validateReadback(
          worker,
          stagedConfigs[index],
          await readActive(stagedPaths[index]),
        ));
        validateLiveControlPlane(
          worker,
          stagedConfigs[index],
          await readLiveControlPlane(worker, process.env.CLOUDFLARE_ACCOUNT_ID),
          { expectedZoneId: configs[0].vars.DIRECTORY_CACHE_ZONE_ID },
        );
      }
      assertCoherentTopology(annotations, plan, sourceSha, {
        phase: "staged",
        controls: plan.stagedControls,
      });
    },
    deployActive: async (worker, index) => {
      failureEvidence.failedRole = `active:${worker.role}`;
      expectedActiveMessages.set(
        worker.role,
        await deployWorker(worker, configPaths[index], sourceSha, plan),
      );
    },
    readbackActive: async (worker, index) => {
      validateReadback(
        worker,
        configs[index],
        await readActive(configPaths[index]),
        expectedActiveMessages.get(worker.role),
      );
      validateLiveControlPlane(
        worker,
        configs[index],
        await readLiveControlPlane(worker, process.env.CLOUDFLARE_ACCOUNT_ID),
        { expectedZoneId: configs[0].vars.DIRECTORY_CACHE_ZONE_ID },
      );
    },
    verifyFinal: async (finalDecision) => {
      const finalAnnotations = [];
      for (const [index, worker] of contract.workers.entries()) {
        finalAnnotations.push(
          validateReadback(
            worker,
            configs[index],
            await readActive(configPaths[index]),
          ),
        );
        validateLiveControlPlane(
          worker,
          configs[index],
          await readLiveControlPlane(worker, process.env.CLOUDFLARE_ACCOUNT_ID),
          { expectedZoneId: configs[0].vars.DIRECTORY_CACHE_ZONE_ID },
        );
      }
      if (finalDecision === "deploy")
        assertCoherentTopology(finalAnnotations, plan, sourceSha);
      else assertDeployableTopology(finalAnnotations, plan);
    },
    canaries: async () => {
      failureEvidence.failedRole = "canaries";
      await runProductionCanaries(contract, configs);
    },
    recover: async () => {
      const failedRole = failureEvidence.failedRole;
      try {
        failureEvidence.recoveryOutcome = await recoverDisabledCore({
          coreStaged,
          fence,
          readActive: () => readActive(stagedPaths[0]),
          expectedMessage: () => expectedStagedMessages.get("core"),
          deployStaged: async () => {
            const message = await deployWorker(
              contract.workers[0],
              stagedPaths[0],
              sourceSha,
              plan,
              { phase: "staged", controls: plan.stagedControls },
            );
            expectedStagedMessages.set("core", message);
            return message;
          },
          validateStaged: async (active, expected) => {
            validateReadback(
              contract.workers[0],
              stagedConfigs[0],
              active,
              expected,
            );
            validateLiveControlPlane(
              contract.workers[0],
              stagedConfigs[0],
              await readLiveControlPlane(
                contract.workers[0],
                process.env.CLOUDFLARE_ACCOUNT_ID,
              ),
              { expectedZoneId: configs[0].vars.DIRECTORY_CACHE_ZONE_ID },
            );
          },
        });
      } catch (error) {
        failureEvidence.recoveryOutcome = "failed";
        throw error;
      } finally {
        failureEvidence.failedRole = failedRole;
      }
    },
    completed: (stage) => failureEvidence.completedRoles.push(stage),
  });
  console.log(
    JSON.stringify({
      outcome,
      buildUuid: failureEvidence.buildUuid,
      sourceSha: checkoutHead,
      deployableDigest: plan.deploy,
      ...(decision === "deploy"
        ? { order: contract.invariants.deploymentOrder }
        : {}),
      canaries: contract.productionCanaries.map(({ name }) => name),
    }),
  );
  } finally {
    await rm(protectedInputs.directory, { recursive: true, force: true });
  }
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main().catch((error) => {
    console.error(
      JSON.stringify(deliveryFailureRecord(error, failureEvidence)),
    );
    process.exitCode = 1;
  });
}
