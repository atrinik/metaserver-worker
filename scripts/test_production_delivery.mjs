import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  activeVersionId,
  arbitrateBuildLease,
  assertCoherentTopology,
  buildLeaseDecision,
  childEnvironment,
  controlPlaneView,
  currentMainGitUrl,
  disabledCircuitConfiguration,
  deliveryFailureRecord,
  currentDeliveryFailureRecord,
  publicDeliveryWorkers,
  retainPrivateDeliveryEvidence,
  verifyPredecessorHandoff,
  verifyStagedCallerRetirement,
  verifyBootstrapCallerPredecessor,
  describeSubprocessFailure,
  deliveryDecision,
  directoryReconciliationProxyConfiguration,
  validateDirectoryReconciliationProof,
  deployStagedWithRecoveryIntent,
  executeOrderedStages,
  executeTrustedWrangler,
  orchestrateDelivery,
  materializeProtectedInputs,
  parseLiveVersionMessage,
  parseVersionMessage,
  parseCurrentMainRef,
  recoverDisabledCore,
  resolveProductionCanaryCommand,
  selectBuildLeaseOwner,
  selectApiHandoffRoles,
  selectLiveTrigger,
  sanitizedChildEnvironment,
  validateBuildTrigger,
  validateBuildEnvironment,
  validateContract,
  validateDeliveryContract,
  runDelivery,
  validateLiveControlPlane,
  validateProtectedDocument,
  validateRemoteMigrations,
  validateRuntimeExports,
  validateSourceCoordinates,
  validateTopology,
  validateToolchain,
  wranglerDeployArguments,
} from "./production-delivery.mjs";

import { directoryFailureLine, markDirectoryFailure, parseDirectoryFailure } from "./directory-reconciliation-diagnostics.mjs";
import { directoryInterfacePath, incompatibleDirectoryInterface, readDirectoryInterface } from "./directory-reconciliation-interface.mjs";
import { developmentFixture, developmentWorkerNames } from "./delivery-targets.mjs";
import { invokeDirectoryProxy, validateDirectoryProxyInput } from "./production-directory-reconciliation.mjs";

const root = resolve(import.meta.dirname, "..");
const contract = JSON.parse(
  await readFile(
    resolve(root, "deployment/historical/workers-builds-production-v1.json"),
    "utf8",
  ),
);
const packageJson = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
);
const configs = await Promise.all(
  [
    "wrangler.jsonc",
    "wrangler.publisher.jsonc",
    "wrangler.rendezvous.jsonc",
  ].map(async (path) => JSON.parse(await readFile(resolve(root, path), "utf8"))),
);

function changedContract(change) {
  const value = structuredClone(contract);
  change(value);
  return value;
}

function changedConfigs(change) {
  const value = structuredClone(configs);
  change(value);
  return value;
}

function productionConfigs(change = () => {}) {
  return changedConfigs((value) => {
    for (const config of value) config.account_id = "a".repeat(32);
    value[0].d1_databases[0].database_id =
      "11111111-1111-1111-1111-111111111111";
    value[0].vars.DIRECTORY_CACHE_ZONE_ID = "b".repeat(32);
    value[1].routes = [{
      pattern: "publish.meta.atrinik.org",
      custom_domain: true,
    }];
    value[2].routes = [{
      pattern: "rendezvous.meta.atrinik.org",
      custom_domain: true,
    }];
    change(value);
  });
}

function liveControlPlane(index) {
  const config = configs[index];
  const worker = contract.workers[index];
  return {
    routes: (config.routes ?? []).filter(
      ({ custom_domain: customDomain }) => customDomain !== true,
    ),
    customDomains: worker.customDomains.map((hostname) => ({
      hostname,
      enabled: true,
      previews_enabled: false,
      zone_id: "b".repeat(32),
      zone_name: "atrinik.org",
    })),
    subdomainStatus: { enabled: false, previews_enabled: false },
    serviceEnvironment: {
      script: {
        compatibility_date: config.compatibility_date,
        compatibility_flags: config.compatibility_flags,
        observability: config.observability,
      },
    },
    cronTriggers: {
      schedules: (config.triggers?.crons ?? []).map((cron) => ({ cron })),
    },
  };
}

test("accepts the checked-in production trigger and topology", () => {
  assert.doesNotThrow(() => validateContract(contract));
  assert.doesNotThrow(() => validateTopology(contract, configs));
  assert.deepEqual(
    contract.productionCanaries.find(
      ({ name }) => name === "classic-static-directory",
    )?.command,
    [
      "python3",
      "scripts/static_origin_canary.py",
      "--profile",
      "classic-v3",
      "--base-url",
      "https://classic.meta.atrinik.org",
      "--alias-prefix",
      "$CLASSIC_DIRECTORY_ALIAS_PREFIX",
      "--allow-production",
      "--json",
    ],
  );
});

function toolchainFixture() {
  const declaration = "^4.124.0";
  const version = "4.125.1";
  const manifest = structuredClone(packageJson);
  manifest.devDependencies.wrangler = declaration;
  return {
    packageJson: manifest,
    packageLock: {
      packages: {
        "": { devDependencies: { wrangler: declaration } },
        "node_modules/wrangler": { version },
      },
    },
    wranglerPackage: { version },
    node: contract.toolchain.node,
    npm: contract.toolchain.npm,
    nodeVersionFile: contract.toolchain.node,
  };
}

test("accepts updated compatible Wrangler declarations resolved by the lockfile", () => {
  assert.doesNotThrow(() => validateToolchain(contract, toolchainFixture()));
});

test("rejects installed Wrangler drift from the resolved lockfile", () => {
  const fixture = toolchainFixture();
  fixture.wranglerPackage.version = "4.126.0";
  assert.throws(() => validateToolchain(contract, fixture), /toolchain drift: wrangler$/u);
});

test("rejects Wrangler declaration drift between manifest and lockfile", () => {
  const fixture = toolchainFixture();
  fixture.packageLock.packages[""].devDependencies.wrangler = "^4.123.0";
  assert.throws(() => validateToolchain(contract, fixture), /toolchain drift: wranglerLock$/u);
});

test("rejects missing or empty Wrangler versions and declarations", () => {
  for (const value of [undefined, "", " ", null, 4]) {
    const fixture = toolchainFixture();
    fixture.wranglerPackage.version = value;
    fixture.packageLock.packages["node_modules/wrangler"].version = value;
    assert.throws(() => validateToolchain(contract, fixture), /toolchain drift: wrangler$/u);
    const declarations = toolchainFixture();
    declarations.packageJson.devDependencies.wrangler = value;
    declarations.packageLock.packages[""].devDependencies.wrangler = value;
    assert.throws(() => validateToolchain(contract, declarations), /toolchain drift: wranglerLock$/u);
  }
});

test("bootstraps SQLite only when Workers Builds lacks sqlite3", () => {
  const command = packageJson.scripts["test:admin"];
  assert.match(command, /import sqlite3/u);
  assert.match(command, /sqlite3\.connect\(':memory:'\)/u);
  assert.match(command, /python3 -m pip install/u);
  assert.match(command, /deployment\/review-check\/requirements\.txt/u);
  assert.match(command, /PYTHONPATH=/u);
  assert.match(command, /python3 -m unittest discover/u);
});

test("uses a bounded git ref fallback for GitHub API rate limits", () => {
  assert.equal(
    currentMainGitUrl(
      "https://api.github.com/repos/atrinik/metaserver-worker/commits/main",
    ),
    "https://github.com/atrinik/metaserver-worker.git",
  );
  assert.equal(
    parseCurrentMainRef(
      "9b383ce872a8eae4d7b452883482e0cd0225badf\trefs/heads/main\n",
    ),
    "9b383ce872a8eae4d7b452883482e0cd0225badf",
  );
  assert.throws(
    () => parseCurrentMainRef("9b383ce872a8eae4d7b452883482e0cd0225badf refs/heads/dev"),
    /invalid ref/u,
  );
  assert.throws(
    () => currentMainGitUrl("https://example.invalid/commits/main"),
    /fallback URL is invalid/u,
  );
});

test("pins the one exact initial bootstrap predecessor", () => {
  for (const changed of [
    changedContract((value) => {
      value.initialBootstrapPredecessor.allowedBindingDelta[0].name = "PUBLISH_ENABLED";
    }),
    changedContract((value) => {
      value.initialBootstrapPredecessor.allowedBindingDelta[0].live = "changed";
    }),
    changedContract((value) => {
      value.initialBootstrapPredecessor.requiredPhase = "any";
    }),
  ]) assert.throws(() => validateContract(changed), /bootstrap predecessor drift/u);
});

test("requires every main push to use the one repository entrypoint", () => {
  for (const changed of [
    changedContract((value) => {
      value.productionBranch = "production";
    }),
    changedContract((value) => {
      value.pathIncludes = ["src/**"];
    }),
    changedContract((value) => {
      value.pathExcludes = ["docs/**"];
    }),
    changedContract((value) => {
      value.deployCommand = "wrangler deploy";
    }),
    changedContract((value) => {
      value.automaticPush = false;
    }),
  ])
    assert.throws(() => validateContract(changed), /trigger drift|command contract/u);
});

test("rejects gradual rollout and unordered topology drift", () => {
  for (const changed of [
    changedContract((value) => {
      value.invariants.deploymentMode = "gradual";
    }),
    changedContract((value) => {
      value.invariants.deploymentOrder.reverse();
    }),
    changedContract((value) => {
      value.workers[1].order = 1;
    }),
    changedContract((value) => {
      value.workers[0].role = "coordinator";
    }),
    changedContract((value) => {
      value.workers[1].configuration = "UNREVIEWED_CONFIG";
    }),
    changedContract((value) => {
      value.workers[0].state.pop();
    }),
    changedContract((value) => {
      value.workers[2].customDomains.push("alternate.example");
    }),
    changedContract((value) => {
      value.workers[0].unexpected = true;
    }),
  ])
    assert.throws(() => validateContract(changed), /invariant drift|topology drift/u);
});

test("rejects alternate production URLs and caller state authority", () => {
  for (const changed of [
    changedConfigs((value) => {
      value[0].workers_dev = true;
    }),
    changedConfigs((value) => {
      value[1].preview_urls = true;
    }),
    changedConfigs((value) => {
      value[2].d1_databases = value[0].d1_databases;
    }),
    changedConfigs((value) => {
      value[1].services[0].entrypoint = "RendezvousCoordinator";
    }),
  ])
    assert.throws(
      () => validateTopology(contract, changed),
      /alternate production URL|state or trigger authority|Service Binding drift|unsupported authority/u,
    );
});

test("requires exact live routes, domains, schedules, runtime, and observability", () => {
  for (const [index, worker] of contract.workers.entries())
    assert.doesNotThrow(() =>
      validateLiveControlPlane(worker, configs[index], liveControlPlane(index)),
    );
  const providerNormalized = structuredClone(liveControlPlane(0));
  providerNormalized.serviceEnvironment.script.observability.head_sampling_rate = 1;
  providerNormalized.serviceEnvironment.script.observability.redact_query_string = false;
  assert.doesNotThrow(() =>
    validateLiveControlPlane(contract.workers[0], configs[0], providerNormalized),
  );
  const nondefaultSampling = structuredClone(providerNormalized);
  nondefaultSampling.serviceEnvironment.script.observability.head_sampling_rate = 0.5;
  assert.throws(
    () => validateLiveControlPlane(contract.workers[0], configs[0], nondefaultSampling),
    /live .* drift/u,
  );
  const nondefaultRedaction = structuredClone(providerNormalized);
  nondefaultRedaction.serviceEnvironment.script.observability.redact_query_string = true;
  assert.throws(
    () => validateLiveControlPlane(contract.workers[0], configs[0], nondefaultRedaction),
    /live .* drift/u,
  );
  const mutations = [
    (value) => value.routes.push({ pattern: "unexpected.example/*" }),
    (value) => value.customDomains.push({ hostname: "unexpected.example" }),
    (value) => {
      value.subdomainStatus.enabled = true;
    },
    (value) => value.cronTriggers.schedules.push({ cron: "0 0 * * *" }),
    (value) => {
      value.serviceEnvironment.script.observability.enabled = false;
    },
  ];
  for (const mutate of mutations) {
    const live = structuredClone(liveControlPlane(1));
    mutate(live);
    assert.throws(
      () => validateLiveControlPlane(contract.workers[1], configs[1], live),
      /live .* drift/u,
    );
  }
});

test("rejects missing secrets, duplicate rate namespaces, and production placeholders", () => {
  assert.throws(
    () =>
      validateTopology(
        contract,
        changedConfigs((value) => {
          value[0].secrets.required.pop();
        }),
      ),
    /required secret names drift/u,
  );
  assert.throws(
    () =>
      validateTopology(
        contract,
        changedConfigs((value) => {
          value[2].ratelimits[0].namespace_id = "1101";
        }),
      ),
    /namespace IDs must be unique/u,
  );
  assert.throws(
    () => validateTopology(contract, configs, { production: true }),
    /production config contains a placeholder/u,
  );
  assert.throws(
    () =>
      validateTopology(
        contract,
        changedConfigs((value) => {
          value[1].vars.SOURCE_TAG_KEY_CURRENT_ID = "unreviewed-epoch";
        }),
      ),
    /required variable names drift/u,
  );
});

test("accepts only one direct 100 percent active version", () => {
  assert.equal(
    activeVersionId({ versions: [{ version_id: "version-1", percentage: 100 }] }),
    "version-1",
  );
  for (const deployment of [
    { versions: [] },
    { versions: [{ version_id: "a", percentage: 50 }, { version_id: "b", percentage: 50 }] },
    { versions: [{ version_id: "a", percentage: 99 }] },
  ])
    assert.throws(() => activeVersionId(deployment), /direct 100% version/u);
});

test("requires exact reconciled Durable Object and Worker exports", () => {
  const exportsWithCreatedState = Object.fromEntries(
    Object.entries(configs[0].exports).map(([name, value]) => [
      name,
      { ...value, state: "created" },
    ]),
  );
  assert.doesNotThrow(() =>
    validateRuntimeExports(contract.workers[0], configs[0], exportsWithCreatedState),
  );
  const changed = structuredClone(exportsWithCreatedState);
  delete changed.PublisherCoordinator;
  assert.throws(
    () => validateRuntimeExports(contract.workers[0], configs[0], changed),
    /exports reconciliation drift/u,
  );
});

test("version annotations bind source, deployable input, control plane, and role", () => {
  const source = "a".repeat(40);
  const deploy = "b".repeat(64);
  const migration = "d".repeat(64);
  const control = "c".repeat(64);
  assert.deepEqual(
    parseVersionMessage(
      `atrinik-delivery-v1 source=${source} deploy=${deploy} migration=${migration} horizon=10 control=${control} role=core phase=active`,
    ),
    { source, deploy, migration, migrationHorizon: 10, control, role: "core", phase: "active" },
  );
  assert.equal(
    parseVersionMessage(
      `atrinik-delivery-v1 source=${source} deploy=${deploy} migration=${migration} horizon=10 control=${control} role=unknown phase=active`,
    ),
    null,
  );
  assert.equal(parseLiveVersionMessage("legacy dashboard deployment", "core"), null);
  assert.throws(
    () => parseLiveVersionMessage("atrinik-delivery-v1 malformed", "core"),
    /annotation is malformed/u,
  );
  assert.throws(
    () => parseLiveVersionMessage("atrinik-delivery v1 malformed", "core"),
    /annotation is malformed/u,
  );
});

test("rejects non-main, dirty, mixed, stale, and unknown-account sources", () => {
  const source = "a".repeat(40);
  const valid = {
    workersCi: "1",
    branch: "main",
    sourceSha: source,
    head: source,
    dirty: false,
    buildUuid: "11111111-1111-1111-1111-111111111111",
    overrideName: "atrinik-metaserver",
    matchTag: "worker-tag",
    accountId: "b".repeat(32),
    currentMain: source,
  };
  assert.doesNotThrow(() => validateSourceCoordinates(valid));
  for (const changed of [
    { workersCi: "0" },
    { branch: "review" },
    { sourceSha: "invalid", head: "invalid", currentMain: "invalid" },
    { head: "c".repeat(40) },
    { dirty: true },
    { buildUuid: "" },
    { overrideName: "atrinik-metaserver-publisher" },
    { matchTag: "" },
    { accountId: "0" },
    { currentMain: "c".repeat(40) },
  ])
    assert.throws(
      () => validateSourceCoordinates({ ...valid, ...changed }),
      /restricted|invalid|does not match|dirty|missing|unexpected|superseded/u,
    );
});

test("scrubs Workers Builds name and tag overrides from every child", () => {
  const input = {
    SAFE: "retained",
    UNKNOWN_PROVIDER_SECRET: "must-not-cross",
    CLOUDFLARE_ACCOUNT_ID: "account",
    CLOUDFLARE_API_TOKEN: "deploy-token",
    ATRINIK_PRODUCTION_CORE_CONFIG: "private-config",
    ATRINIK_WORKERS_BUILDS_API_TOKEN: "lease-token",
    ATRINIK_PRODUCTION_CONTROL_PLANE_READY: "routine",
    WRANGLER_CI_OVERRIDE_NAME: "atrinik-metaserver",
    WRANGLER_CI_MATCH_TAG: "core-tag",
  };
  assert.deepEqual(childEnvironment(input), {});
  assert.deepEqual(sanitizedChildEnvironment(input), {
    CLOUDFLARE_ACCOUNT_ID: "account",
    CLOUDFLARE_API_TOKEN: "deploy-token",
  });
});

test("rejects every unmodeled Wrangler authority family", () => {
  for (const field of [
    "kv_namespaces", "queues", "vectorize", "hyperdrive", "workflows",
    "dispatch_namespaces", "mtls_certificates", "browser", "ai", "unsafe",
  ]) {
    const changed = changedConfigs((value) => {
      value[1][field] = [];
    });
    assert.throws(
      () => validateTopology(contract, changed),
      /unsupported authority fields/u,
    );
  }
  const changedNested = changedConfigs((value) => {
    value[0].d1_databases[0].preview_database_id = "unreviewed";
  });
  assert.throws(
    () => validateTopology(contract, changedNested),
    /unsupported authority fields/u,
  );
});

test("requires every modeled resource identifier and safe observability destination", () => {
  for (const mutate of [
    (value) => { delete value[0].d1_databases[0].database_id; },
    (value) => { delete value[0].r2_buckets[0].bucket_name; },
    (value) => { delete value[0].analytics_engine_datasets[0].dataset; },
    (value) => { delete value[0].durable_objects.bindings[0].class_name; },
    (value) => { delete value[1].services[0].entrypoint; },
    (value) => { delete value[2].ratelimits[0].namespace_id; },
  ]) {
    const changed = changedConfigs(mutate);
    assert.throws(
      () => validateTopology(contract, changed),
      /missing required identifier/u,
    );
  }
  for (const target of ["logs", "traces"]) {
    const changed = changedConfigs((value) => {
      value[0].observability[target].destinations = ["unreviewed-sink"];
    });
    assert.throws(
      () => validateTopology(contract, changed),
      /destination authority drift/u,
    );
  }
});

test("requires exact production zone, origin, and domain relationships", () => {
  assert.doesNotThrow(() =>
    validateTopology(contract, productionConfigs(), { production: true }),
  );
  for (const mutate of [
    (value) => { value[0].vars.DIRECTORY_CACHE_ZONE_ID = "not-a-zone-id"; },
    (value) => { value[0].vars.CLASSIC_DIRECTORY_PUBLIC_ORIGIN = "https://wrong.invalid"; },
    (value) => { value[1].vars.PUBLISH_HOSTNAME = "wrong.invalid"; },
    (value) => { value[2].vars.RENDEZVOUS_HOSTNAME = "wrong.invalid"; },
  ]) {
    assert.throws(
      () => validateTopology(contract, productionConfigs(mutate), {
        production: true,
      }),
      /production domain, origin, or zone authority drift/u,
    );
  }
});

test("requires runtime-valid and coherent protected policy values", () => {
  for (const mutate of [
    (value) => { value[0].vars.LISTING_TTL_SECONDS = "garbage"; },
    (value) => { value[1].vars.PUBLISH_ENABLED = "typo"; },
    (value) => { value[1].vars.PUBLISH_ENABLED = "disabled"; },
    (value) => { value[2].vars.ROUTE_DISABLED_RETRY_SECONDS = "301"; },
    (value) => {
      value[0].vars.SOURCE_TAG_KEY_PREVIOUS_ID =
        value[0].vars.SOURCE_TAG_KEY_CURRENT_ID;
    },
    (value) => {
      value[0].vars.SOURCE_TAG_KEY_CURRENT_ID = "a".repeat(33);
    },
  ]) {
    assert.throws(
      () => validateTopology(contract, changedConfigs(mutate)),
      /production policy is invalid|production circuit authority drift|retry policy drift|configuration epoch is invalid/u,
    );
  }
  const runtimeValidIds = changedConfigs((value) => {
    value[0].vars.SOURCE_TAG_KEY_CURRENT_ID = "Release_A-1";
    value[0].vars.SOURCE_TAG_KEY_PREVIOUS_ID = "Release_A-0";
  });
  assert.doesNotThrow(() => validateTopology(contract, runtimeValidIds));
});

test("binds the cache purge zone to every live canonical domain", () => {
  for (const index of [1, 2]) {
    assert.doesNotThrow(() => validateLiveControlPlane(
      contract.workers[index],
      configs[index],
      liveControlPlane(index),
      { expectedZoneId: "b".repeat(32) },
    ));
    const wrong = liveControlPlane(index);
    wrong.customDomains[0].zone_id = "c".repeat(32);
    assert.throws(
      () => validateLiveControlPlane(
        contract.workers[index],
        configs[index],
        wrong,
        { expectedZoneId: "b".repeat(32) },
      ),
      /Custom Domain zone authority drift/u,
    );
  }
});

test("creates an exact disabled-circuit staging topology", () => {
  const desired = structuredClone(configs);
  desired[0].vars.PUBLISH_ENABLED = "enabled";
  desired[0].vars.GAME_PUBLISH_ENABLED = "enabled";
  desired[0].vars.RENDEZVOUS_ENABLED = "enabled";
  desired[1].vars.PUBLISH_ENABLED = "enabled";
  desired[1].vars.GAME_PUBLISH_ENABLED = "enabled";
  desired[2].vars.RENDEZVOUS_ENABLED = "enabled";
  const staged = desired.map((config, index) =>
    disabledCircuitConfiguration(config, contract.workers[index].role));
  assert.doesNotThrow(() => validateTopology(contract, staged));
  assert.equal(staged[0].vars.PUBLISH_ENABLED, "disabled");
  assert.equal(staged[0].vars.GAME_PUBLISH_ENABLED, "disabled");
  assert.equal(staged[0].vars.RENDEZVOUS_ENABLED, "disabled");
  assert.equal(staged[1].vars.PUBLISH_ENABLED, "disabled");
  assert.equal(staged[2].vars.RENDEZVOUS_ENABLED, "disabled");
  assert.equal(desired[0].vars.PUBLISH_ENABLED, "enabled");
});

test("requires the live Workers Builds trigger to match the contract", () => {
  const build = {
    build_trigger_metadata: {
      build_command: contract.installCommand,
      deploy_command: contract.deployCommand,
      build_trigger_source: "push",
      provider_type: "github",
      provider_account_name: "atrinik",
      repo_name: "metaserver-worker",
      root_directory: "/",
      environment_variables: {
        SKIP_DEPENDENCY_INSTALL: { is_secret: false, value: "1" },
      },
    },
    trigger: {
      build_command: contract.installCommand,
      deploy_command: contract.deployCommand,
      root_directory: "/",
      branch_includes: ["main"],
      branch_excludes: [],
      path_includes: ["*"],
      path_excludes: [],
      external_script_id: "worker-tag",
      repo_connection: {
        provider_type: "github",
        provider_account_name: "atrinik",
        repo_name: "metaserver-worker",
      },
    },
  };
  for (const source of ["push_event", "push", "retry", "manual", "api"]) {
    const accepted = structuredClone(build);
    accepted.build_trigger_metadata.build_trigger_source = source;
    assert.doesNotThrow(() => validateBuildTrigger(contract, accepted, "worker-tag"));
  }
  const legacyMetadata = structuredClone(build);
  legacyMetadata.build_trigger_metadata.environment_variables = {
    SKIP_DEPENDENCY_INSTALL: "1",
  };
  assert.doesNotThrow(() =>
    validateBuildTrigger(contract, legacyMetadata, "worker-tag"),
  );
  for (const mutate of [
    (value) => { value.trigger.path_excludes = ["docs/**"]; },
    (value) => { value.trigger.branch_includes = ["production"]; },
    (value) => { value.trigger.root_directory = "packages/worker"; },
    (value) => { value.trigger.repo_connection.provider_type = "gitlab"; },
    (value) => { value.trigger.repo_connection.repo_name = "other"; },
    (value) => { value.build_trigger_metadata.build_trigger_source = "pull_request"; },
    (value) => {
      value.build_trigger_metadata.environment_variables.SKIP_DEPENDENCY_INSTALL.value =
        "0";
    },
  ]) {
    const changed = structuredClone(build);
    mutate(changed);
    assert.throws(
      () => validateBuildTrigger(contract, changed, "worker-tag"),
      /trigger drift/u,
    );
  }
});

test("requires the exact protected Workers Builds environment with an inert legacy gate", () => {
  const environment = Object.fromEntries([
    contract.protectedInputs.accountVariable,
    contract.protectedInputs.coreConfigVariable,
    contract.protectedInputs.publisherConfigVariable,
    contract.protectedInputs.rendezvousConfigVariable,
    contract.protectedInputs.buildsApiTokenVariable,
  ].map((name) => [name, { is_secret: true, value: null }]));
  environment.SKIP_DEPENDENCY_INSTALL = { is_secret: false, value: "1" };
  assert.doesNotThrow(() => validateBuildEnvironment(contract, environment));
  const legacy = {
    ...environment,
    ATRINIK_PRODUCTION_CONTROL_PLANE_READY: { is_secret: true, value: null },
  };
  assert.doesNotThrow(() => validateBuildEnvironment(contract, legacy));
  for (const mutate of [
    (value) => { value.SKIP_DEPENDENCY_INSTALL.value = "0"; },
    (value) => { value[contract.protectedInputs.coreConfigVariable].is_secret = false; },
    (value) => { value.UNREVIEWED = { is_secret: true, value: null }; },
    (value) => {
      value.ATRINIK_PRODUCTION_CONTROL_PLANE_READY = {
        is_secret: false,
        value: "approved:stale",
      };
    },
    (value) => {
      value.ATRINIK_PRODUCTION_CONTROL_PLANE_READY = {
        is_secret: true,
        value: "routine",
      };
    },
  ]) {
    const changed = structuredClone(environment);
    mutate(changed);
    assert.throws(
      () => validateBuildEnvironment(contract, changed),
      /environment|classification/u,
    );
  }
});

test("selects exactly one current live Workers Builds trigger", () => {
  const trigger = { trigger_uuid: "production" };
  assert.equal(selectLiveTrigger([trigger], "production"), trigger);
  for (const values of [[], [trigger, { ...trigger }], null])
    assert.throws(
      () => selectLiveTrigger(values, "production"),
      /invalid|missing or ambiguous/u,
    );
});

test("only an unannotated API-managed Worker enables the automatic handoff", () => {
  const workers = [{ role: "core" }, { role: "publisher" }, { role: "rendezvous" }];
  const live = workers.map((_, index) => ({
    serviceEnvironment: {
      script: { last_deployed_from: index < 2 ? "api" : "workersci" },
    },
  }));
  const source = "a".repeat(40);
  assert.deepEqual(
    [...selectApiHandoffRoles(workers, live, [null, null, null])],
    ["core", "publisher"],
  );
  assert.deepEqual(
    [...selectApiHandoffRoles(workers, live, [{ source }, null, null])],
    ["publisher"],
  );
  const dashboard = structuredClone(live);
  dashboard[0].serviceEnvironment.script.last_deployed_from = "dash";
  assert.deepEqual(
    [...selectApiHandoffRoles(workers, dashboard, [null, null, null])],
    ["publisher"],
  );
  assert.throws(
    () => selectApiHandoffRoles(workers.slice(0, 1), live, [null]),
    /inventory is invalid/u,
  );
});

test("keeps strict Wrangler arguments outside the explicit API handoff", () => {
  const input = {
    configPath: "/tmp/production.jsonc",
    sourceSha: "a".repeat(40),
    message: "delivery message",
  };
  assert.deepEqual(wranglerDeployArguments(input), [
    "deploy",
    "--strict",
    "--config",
    input.configPath,
    "--tag",
    input.sourceSha,
    "--message",
    input.message,
  ]);
  assert.deepEqual(wranglerDeployArguments({ ...input, strict: false }), [
    "deploy",
    "--config",
    input.configPath,
    "--tag",
    input.sourceSha,
    "--message",
    input.message,
  ]);
  assert.throws(
    () => wranglerDeployArguments({ ...input, sourceSha: "not-a-sha" }),
    /arguments are invalid/u,
  );
});

test("requires an exact ordered remote migration ledger", () => {
  const expected = ["0001_initial.sql", "0002_request_control.sql"];
  assert.doesNotThrow(() => validateRemoteMigrations(expected, expected));
  for (const actual of [
    ["0001_initial.sql"],
    [...expected, "0003_unreviewed.sql"],
    [...expected].reverse(),
  ])
    assert.throws(
      () => validateRemoteMigrations(actual, expected),
      /pending, missing, or divergent/u,
    );
});

test("selects one deterministic active exact-source build lease owner", () => {
  const source = "a".repeat(40);
  const build = (uuid, created, commit = source) => ({
    build_uuid: uuid,
    created_on: created,
    status: "running",
    trigger: { trigger_uuid: "production" },
    build_trigger_metadata: { branch: "main", commit_hash: commit },
  });
  const builds = [
    build("later", "2026-08-14T20:01:00Z"),
    build("earlier", "2026-08-14T20:00:00Z"),
    build("stale", "2026-08-14T19:59:00Z", "b".repeat(40)),
    { ...build("stopped", "2026-08-14T19:58:00Z"), status: "stopped" },
  ];
  assert.equal(
    selectBuildLeaseOwner(builds, source, "production"),
    "later",
  );
  const withLateStaleRetry = [
    ...builds,
    build("late-stale", "2026-08-14T20:02:00Z", "b".repeat(40)),
  ];
  assert.equal(
    selectBuildLeaseOwner(withLateStaleRetry, source, "production"),
    "later",
  );
  assert.deepEqual(
    buildLeaseDecision(builds, source, "production", "later")
      .map(({ build_uuid: uuid }) => uuid),
    ["earlier", "stale"],
  );
  assert.deepEqual(
    buildLeaseDecision(withLateStaleRetry, source, "production", "later")
      .map(({ build_uuid: uuid }) => uuid),
    ["earlier", "stale", "late-stale"],
  );
});

test("lease arbitration converges after cancellation and detects main advance", async () => {
  const source = "a".repeat(40);
  const other = "b".repeat(40);
  const build = (uuid, commit = source, status = "running") => ({
    build_uuid: uuid,
    created_on: uuid === "owner" ? "2026-08-14T20:01:00Z" :
      "2026-08-14T20:00:00Z",
    status,
    trigger: { trigger_uuid: "production" },
    build_trigger_metadata: { branch: "main", commit_hash: commit },
  });
  const states = new Map([
    ["owner", build("owner")],
    ["stale", build("stale", other)],
  ]);
  const cancelled = [];
  let lists = 0;
  let currentMainProofs = 0;
  await arbitrateBuildLease({
    sourceSha: source,
    buildUuid: "owner",
    triggerUuid: "production",
    currentMain: async () => {
      currentMainProofs += 1;
      return source;
    },
    listBuilds: async () => {
      lists += 1;
      if (lists === 2) states.set("retry", build("retry"));
      return [...states.values()];
    },
    cancelBuild: async (uuid) => {
      cancelled.push(uuid);
      states.set(uuid, { ...states.get(uuid), status: "stopped" });
    },
    readBuild: async (uuid) => states.get(uuid),
    pause: async () => {},
  });
  assert.deepEqual(cancelled, ["stale", "retry"]);
  assert.equal(lists, 3);
  assert.equal(currentMainProofs, 2);

  let uncontestedProofs = 0;
  await arbitrateBuildLease({
    sourceSha: source,
    buildUuid: "owner",
    triggerUuid: "production",
    currentMain: async () => {
      uncontestedProofs += 1;
      return source;
    },
    listBuilds: async () => [build("owner")],
    cancelBuild: async () => {},
    readBuild: async () => build("owner"),
    pause: async () => {},
  });
  assert.equal(uncontestedProofs, 1);

  let mainProofs = 0;
  const advanceStates = new Map([
    ["owner", build("owner")],
    ["stale", build("stale", other)],
  ]);
  await assert.rejects(arbitrateBuildLease({
    sourceSha: source,
    buildUuid: "owner",
    triggerUuid: "production",
    currentMain: async () => {
      mainProofs += 1;
      return mainProofs === 1 ? source : other;
    },
    listBuilds: async () => [...advanceStates.values()],
    cancelBuild: async (uuid) => {
      advanceStates.set(uuid, {
        ...advanceStates.get(uuid),
        status: "stopped",
      });
    },
    readBuild: async (uuid) => advanceStates.get(uuid),
    pause: async () => {},
  }), /superseded by current main/u);
  assert.equal(mainProofs, 2);

  let raceCancellations = 0;
  await assert.rejects(arbitrateBuildLease({
    sourceSha: source,
    buildUuid: "owner",
    triggerUuid: "production",
    currentMain: async () => other,
    listBuilds: async () => [build("owner"), build("new-main", other)],
    cancelBuild: async () => { raceCancellations += 1; },
    readBuild: async () => build("new-main", other),
    pause: async () => {},
  }), /superseded by current main/u);
  assert.equal(raceCancellations, 0);

  const changingStates = new Map([
    ["owner", build("owner")],
    ["old", build("old", other)],
  ]);
  let changingLists = 0;
  const changingCancelled = [];
  await assert.rejects(arbitrateBuildLease({
    sourceSha: source,
    buildUuid: "owner",
    triggerUuid: "production",
    currentMain: async () => source,
    listBuilds: async () => {
      changingLists += 1;
      if (changingLists === 2)
        changingStates.set("new", build("new", "c".repeat(40)));
      return [...changingStates.values()];
    },
    cancelBuild: async (uuid) => {
      changingCancelled.push(uuid);
      changingStates.set(uuid, {
        ...changingStates.get(uuid),
        status: "stopped",
      });
    },
    readBuild: async (uuid) => changingStates.get(uuid),
    pause: async () => {},
  }), /lease changed during arbitration/u);
  assert.deepEqual(changingCancelled, ["old"]);
});

test("accepted main automatically deploys protected configuration changes", () => {
  const source = "a".repeat(40);
  const digest = (value) => createHash("sha256")
    .update(JSON.stringify(value)).digest("hex");
  const baseControls = configs.map((config) => digest(controlPlaneView(config)));
  const changed = changedConfigs((value) => {
    value[0].vars.LISTING_TTL_SECONDS = "7200";
    value[0].compatibility_date = "2026-08-13";
  });
  const changedControls = changed.map(
    (config) => digest(controlPlaneView(config)),
  );
  const plan = {
    deploy: "d".repeat(64),
    migrationDigest: "e".repeat(64),
    migrations: [{ name: "0001_initial.sql", sha256: "f".repeat(64) }],
    controls: changedControls,
    stagedControls: changedControls,
  };
  const annotations = contract.workers.map((worker, index) => ({
    source,
    deploy: "c".repeat(64),
    migration: plan.migrationDigest,
    migrationHorizon: 1,
    control: baseControls[index],
    role: worker.role,
    phase: "active",
  }));
  assert.equal(deliveryDecision(annotations, plan), "deploy");
});

test("no-op requires one coherent active topology", () => {
  const source = "a".repeat(40);
  const plan = {
    deploy: "d".repeat(64),
    migrationDigest: "e".repeat(64),
    migrations: [{ name: "0001_initial.sql", sha256: "a".repeat(64) }],
    controls: ["1".repeat(64), "2".repeat(64), "3".repeat(64)],
    stagedControls: ["4".repeat(64), "5".repeat(64), "6".repeat(64)],
  };
  const annotations = ["core", "publisher", "rendezvous"].map(
    (role, index) => ({
      source,
      deploy: plan.deploy,
      migration: plan.migrationDigest,
      migrationHorizon: plan.migrations.length,
      control: plan.controls[index],
      role,
      phase: "active",
    }),
  );
  assert.equal(deliveryDecision(annotations, plan), "no-op");
  assert.equal(
    deliveryDecision(
      annotations,
      { ...plan, deploy: "9".repeat(64) },
    ),
    "deploy",
  );
  assert.throws(
    () =>
      deliveryDecision(
        annotations.map((value, index) =>
          index === 0 ? { ...value, migration: "f".repeat(64) } : value,
        ),
        plan,
      ),
    /migration content is divergent/u,
  );
  assert.doesNotThrow(() => assertCoherentTopology(annotations, plan, source));
  assert.throws(
    () =>
      assertCoherentTopology(
        annotations.map((value, index) =>
          index === 1 ? { ...value, source: "f".repeat(40) } : value,
        ),
        plan,
        source,
      ),
    /not one coherent/u,
  );
  assert.equal(
    deliveryDecision(
      annotations.map((value, index) =>
        index === 2 ? { ...value, source: "b".repeat(40) } : value,
      ),
      plan,
    ),
    "deploy",
  );
  const changedControl = annotations.map((value, index) =>
    index === 0 ? { ...value, control: "f".repeat(64) } : value,
  );
  assert.equal(deliveryDecision(changedControl, plan), "deploy");
});

test("only a proven append-only migration horizon can advance", () => {
  const source = "a".repeat(40);
  const previous = [{ name: "0001_initial.sql", sha256: "1".repeat(64) }];
  const migrations = [
    ...previous,
    { name: "0002_next.sql", sha256: "2".repeat(64) },
  ];
  const digest = (value) => createHash("sha256")
    .update(JSON.stringify(value)).digest("hex");
  const plan = {
    deploy: "d".repeat(64),
    migrations,
    migrationDigest: digest(migrations),
    controls: ["1".repeat(64), "2".repeat(64), "3".repeat(64)],
    stagedControls: ["4".repeat(64), "5".repeat(64), "6".repeat(64)],
  };
  const prior = ["core", "publisher", "rendezvous"].map((role, index) => ({
    source: "b".repeat(40),
    deploy: "c".repeat(64),
    migration: digest(previous),
    migrationHorizon: 1,
    control: plan.controls[index],
    role,
    phase: "active",
  }));
  assert.equal(deliveryDecision(prior, plan), "deploy");
  const partial = prior.map((value, index) => index === 0 ? {
    ...value,
    source,
    deploy: plan.deploy,
    migration: plan.migrationDigest,
    migrationHorizon: 2,
    control: plan.stagedControls[index],
    phase: "staged",
  } : value);
  assert.equal(
    deliveryDecision(partial, plan),
    "deploy",
  );
  const rewritten = prior.map((value) => ({ ...value, migration: "f".repeat(64) }));
  assert.throws(
    () => deliveryDecision(rewritten, plan),
    /divergent/u,
  );
  const shrunk = prior.map((value) => ({
    ...value,
    migration: plan.migrationDigest,
    migrationHorizon: 0,
  }));
  assert.throws(() => deliveryDecision(shrunk, plan), /divergent/u);
});

test("internally staged controls resume automatically", () => {
  const source = "a".repeat(40);
  const migrations = [{ name: "0001_initial.sql", sha256: "1".repeat(64) }];
  const plan = {
    deploy: "d".repeat(64),
    migrations,
    migrationDigest: "e".repeat(64),
    controls: ["1".repeat(64), "2".repeat(64), "3".repeat(64)],
    stagedControls: ["4".repeat(64), "5".repeat(64), "6".repeat(64)],
  };
  const partial = ["core", "publisher", "rendezvous"].map((role, index) => ({
    source: index === 0 ? "b".repeat(40) : source,
    deploy: plan.deploy,
    migration: plan.migrationDigest,
    migrationHorizon: 1,
    control: index < 2 ? plan.stagedControls[index] : plan.controls[index],
    role,
    phase: index < 2 ? "staged" : "active",
  }));
  assert.equal(deliveryDecision(partial, plan), "deploy");
});

test("every failed deployment stage stops all later stages", async () => {
  const workers = ["core", "publisher", "rendezvous"];
  for (const failedIndex of [0, 1, 2]) {
    const visited = [];
    await assert.rejects(
      executeOrderedStages(workers, async (worker, index) => {
        visited.push(worker);
        if (index === failedIndex) throw new Error("stage failed");
      }),
      /stage failed/u,
    );
    assert.deepEqual(visited, workers.slice(0, failedIndex + 1));
  }
});

test("orchestrator fences every mutation, no-op, final readback, and canary boundary", async () => {
  const workers = ["core", "publisher", "rendezvous"];
  const events = [];
  const outcome = await orchestrateDelivery({
    workers,
    decision: "deploy",
    fence: async () => events.push("fence"),
    deployStaged: async (worker) => events.push(`deploy-staged:${worker}`),
    readbackStaged: async (worker) => events.push(`readback-staged:${worker}`),
    verifyStaged: async () => events.push("verify-staged"),
    deployActive: async (worker) => events.push(`deploy-active:${worker}`),
    readbackActive: async (worker) => events.push(`readback-active:${worker}`),
    verifyFinal: async () => events.push("final"),
    reconcileDirectories: async () => events.push("reconcile"),
    canaries: async () => events.push("canaries"),
    recover: async () => events.push("unexpected-recovery"),
    completed: (stage) => events.push(`completed:${stage}`),
  });
  assert.equal(outcome, "deployed-and-read-back");
  assert.deepEqual(events, [
    "fence", "deploy-staged:core", "fence", "readback-staged:core", "completed:staged:core",
    "fence", "deploy-staged:publisher", "fence", "readback-staged:publisher", "completed:staged:publisher",
    "fence", "deploy-staged:rendezvous", "fence", "readback-staged:rendezvous", "completed:staged:rendezvous",
    "fence", "verify-staged",
    "fence", "deploy-active:publisher", "fence", "readback-active:publisher", "completed:active:publisher",
    "fence", "deploy-active:rendezvous", "fence", "readback-active:rendezvous", "completed:active:rendezvous",
    "fence", "deploy-active:core", "fence", "readback-active:core", "completed:active:core",
    "fence", "final", "fence", "reconcile", "completed:directory-reconciliation",
    "fence", "final", "fence", "canaries", "fence",
  ]);

  const noOpEvents = [];
  assert.equal(
    await orchestrateDelivery({
      workers,
      decision: "no-op",
      fence: async () => noOpEvents.push("fence"),
      deployStaged: async () => noOpEvents.push("unexpected-deploy"),
      readbackStaged: async () => noOpEvents.push("unexpected-readback"),
      verifyStaged: async () => noOpEvents.push("unexpected-staged"),
      deployActive: async () => noOpEvents.push("unexpected-deploy"),
      readbackActive: async () => noOpEvents.push("unexpected-readback"),
      verifyFinal: async () => noOpEvents.push("final"),
      reconcileDirectories: async () => noOpEvents.push("reconcile"),
      canaries: async () => noOpEvents.push("canaries"),
      recover: async () => noOpEvents.push("unexpected-recovery"),
    }),
    "no-deployment-required",
  );
  assert.deepEqual(noOpEvents, ["fence", "final", "fence", "reconcile", "fence", "final", "fence", "canaries", "fence"]);
});

test("orchestrator recovers disabled circuits after every asynchronous boundary failure", async () => {
  const workers = ["core", "publisher", "rendezvous"];
  const targets = [
    ...Array.from({ length: 18 }, (_, index) => `fence:${index + 1}`),
    ...workers.flatMap((worker) => [
      `deploy-staged:${worker}`, `readback-staged:${worker}`,
    ]),
    "verify-staged",
    ...["publisher", "rendezvous", "core"].flatMap((worker) => [
      `deploy-active:${worker}`, `readback-active:${worker}`,
    ]),
    "final",
    "reconcile",
    "canaries",
  ];
  for (const target of targets) {
    const completed = [];
    const counts = new Map();
    const record = (name) => {
      const occurrence = (counts.get(name) ?? 0) + 1;
      counts.set(name, occurrence);
      const identity = name === "fence" ? `${name}:${occurrence}` : name;
      if (identity === target) throw new Error("closed failure");
    };
    let recovered = false;
    await assert.rejects(
      orchestrateDelivery({
        workers,
        decision: "deploy",
        fence: async () => record("fence"),
        deployStaged: async (worker) => record(`deploy-staged:${worker}`),
        readbackStaged: async (worker) => record(`readback-staged:${worker}`),
        verifyStaged: async () => record("verify-staged"),
        deployActive: async (worker) => record(`deploy-active:${worker}`),
        readbackActive: async (worker) => record(`readback-active:${worker}`),
        verifyFinal: async () => record("final"),
        reconcileDirectories: async () => record("reconcile"),
        canaries: async () => record("canaries"),
        recover: async () => { recovered = true; },
        completed: (stage) => completed.push(stage),
      }),
      /closed failure/u,
    );
    assert.equal(recovered, true, target);
    assert.equal(new Set(completed).size, completed.length, target);
  }
});

test("preserves a bounded original deployment diagnostic when recovery fails", async () => {
  await assert.rejects(
    orchestrateDelivery({
      workers: ["core"],
      decision: "deploy",
      fence: async () => {},
      deployStaged: async () => {
        throw new Error("wrangler deploy failed (exit=1 stage=wrangler provider-code=10090)");
      },
      readbackStaged: async () => {},
      verifyStaged: async () => {},
      deployActive: async () => {},
      readbackActive: async () => {},
      verifyFinal: async () => {},
      reconcileDirectories: async () => {},
      canaries: async () => {},
      recover: async () => {
        throw new Error("recovery failed");
      },
    }),
    /disabled-circuit recovery was not proven; initial failure: exit=1 stage=wrangler provider-code=10090/u,
  );
});

test("exact-source retry converges and a stale retry cannot mutate", async () => {
  const workers = ["core", "publisher", "rendezvous"];
  let first = true;
  const completed = [];
  const callbacks = {
    workers,
    decision: "deploy",
    fence: async () => {},
    deployStaged: async () => {},
    readbackStaged: async () => {},
    verifyStaged: async () => {},
    deployActive: async (worker) => {
      if (first && worker === "rendezvous") {
        first = false;
        throw new Error("partial failure");
      }
    },
    readbackActive: async () => {},
    verifyFinal: async () => {},
    reconcileDirectories: async () => {},
    canaries: async () => {},
    recover: async () => {},
    completed: (stage) => completed.push(stage),
  };
  await assert.rejects(orchestrateDelivery(callbacks), /partial failure/u);
  assert.equal(await orchestrateDelivery(callbacks), "deployed-and-read-back");

  let mutations = 0;
  await assert.rejects(orchestrateDelivery({
    ...callbacks,
    fence: async () => { throw new Error("superseded main"); },
    deployStaged: async () => { mutations += 1; },
  }), /superseded main/u);
  assert.equal(mutations, 0);
});

test("disabled-core recovery proves, redeploys, skips, and fails closed", async () => {
  const staged = "staged-message";
  const events = [];
  const outcome = await recoverDisabledCore({
    coreStaged: true,
    fence: async () => events.push("fence"),
    readActive: async () => ({
      version: {
        annotations: { "workers/message": events.includes("deploy") ? staged : "active" },
      },
    }),
    expectedMessage: () => staged,
    deployStaged: async () => {
      events.push("deploy");
      return staged;
    },
    validateStaged: async (_active, expected) => {
      assert.equal(expected, staged);
      events.push("validated");
    },
  });
  assert.equal(outcome, "proven");
  assert.deepEqual(events, ["fence", "deploy", "fence", "validated"]);

  const alreadyEvents = [];
  assert.equal(await recoverDisabledCore({
    coreStaged: true,
    fence: async () => alreadyEvents.push("fence"),
    readActive: async () => ({
      version: { annotations: { "workers/message": staged } },
    }),
    expectedMessage: () => staged,
    deployStaged: async () => { alreadyEvents.push("unexpected-deploy"); },
    validateStaged: async () => { alreadyEvents.push("validated"); },
  }), "proven");
  assert.deepEqual(alreadyEvents, ["fence", "validated"]);

  let mutations = 0;
  assert.equal(await recoverDisabledCore({
    coreStaged: false,
    fence: async () => {},
    readActive: async () => {},
    expectedMessage: () => staged,
    deployStaged: async () => { mutations += 1; },
    validateStaged: async () => {},
  }), "not-needed");
  assert.equal(mutations, 0);

  await assert.rejects(recoverDisabledCore({
    coreStaged: true,
    fence: async () => {},
    readActive: async () => ({
      version: { annotations: { "workers/message": "active" } },
    }),
    expectedMessage: () => staged,
    deployStaged: async () => { throw new Error("recovery failed"); },
    validateStaged: async () => {},
  }), /recovery failed/u);
});

test("ambiguous staged-core upload marks recovery intent before mutation", async () => {
  let corePossiblyMutated = false;
  await assert.rejects(
    deployStagedWithRecoveryIntent(
      { role: "core" },
      () => { corePossiblyMutated = true; },
      async () => {
        assert.equal(corePossiblyMutated, true);
        throw new Error("ambiguous upload result");
      },
    ),
    /ambiguous upload result/u,
  );

  const events = [];
  assert.equal(await recoverDisabledCore({
    coreStaged: corePossiblyMutated,
    fence: async () => events.push("fence"),
    readActive: async () => ({
      version: {
        annotations: {
          "workers/message": events.includes("recovered") ? "staged" : "active",
        },
      },
    }),
    expectedMessage: () => "staged",
    deployStaged: async () => {
      events.push("recovered");
      return "staged";
    },
    validateStaged: async (_active, expected) => {
      assert.equal(expected, "staged");
      events.push("validated");
    },
  }), "proven");
  assert.deepEqual(events, ["fence", "recovered", "fence", "validated"]);

  let publisherMarked = false;
  await deployStagedWithRecoveryIntent(
    { role: "publisher" },
    () => { publisherMarked = true; },
    async () => {},
  );
  assert.equal(publisherMarked, false);
});

test("accepts only bounded protected Workers Builds documents", () => {
  assert.equal(validateProtectedDocument("{}", "CONFIG"), "{}");
  for (const value of [undefined, "", "x".repeat(5 * 1024 + 1), "bad\0value"])
    assert.throws(
      () => validateProtectedDocument(value, "CONFIG"),
      /missing|limit|invalid byte/u,
    );
});

test("materializes provider-shaped config values as private ephemeral files", async () => {
  const variables = [
    contract.protectedInputs.coreConfigVariable,
    contract.protectedInputs.publisherConfigVariable,
    contract.protectedInputs.rendezvousConfigVariable,
  ];
  const previous = variables.map((name) => process.env[name]);
  variables.forEach((name, index) => {
    process.env[name] = JSON.stringify(configs[index]);
  });
  let materialized;
  try {
    materialized = await materializeProtectedInputs(contract.protectedInputs);
    for (const path of materialized.configPaths) {
      assert.equal((await stat(path)).mode & 0o077, 0);
      assert.equal(JSON.parse(await readFile(path, "utf8")).main.startsWith(root), true);
    }
  } finally {
    if (materialized)
      await rm(materialized.directory, { recursive: true, force: true });
    variables.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    });
  }
});

test("failure evidence never includes raw subprocess or protected input text", () => {
  const secret = "/private/config account-id secret-value";
  const record = deliveryFailureRecord(new Error(secret), {
    buildUuid: "build-1",
    sourceSha: "a".repeat(40),
    deployableDigest: null,
    failedRole: "active:publisher",
    completedRoles: ["staged:core"],
    recoveryOutcome: "proven",
  });
  assert.equal(record.reason, "unexpected-internal-error");
  assert.equal(record.failedRole, "active:publisher");
  assert.equal(record.recoveryOutcome, "proven");
  assert.equal(JSON.stringify(record).includes(secret), false);
});

test("subprocess diagnostics expose only bounded stage metadata", () => {
  const secret = "private-config-secret";
  const detail = describeSubprocessFailure({
    code: 1,
    stdout: `> atrinik-metaserver@1.0.0 check\n> npm run test\n> atrinik-metaserver@1.0.0 test\n> vitest run\n${secret}`,
    stderr: `failed: ${secret}`,
  });
  assert.equal(detail, "exit=1 stage=vitest");
  assert.equal(detail.includes(secret), false);
  assert.equal(
    describeSubprocessFailure({ code: "ENOENT", signal: "SIGTERM", stdout: secret }),
    "code=ENOENT signal=SIGTERM",
  );
  assert.equal(
    describeSubprocessFailure({
      code: 1,
      stderr: "Cloudflare API request failed [code: 10090]",
    }),
    "exit=1 provider-code=10090",
  );
  assert.equal(
    describeSubprocessFailure({
      code: 1,
      stderr: "HTTP status=403",
    }),
    "exit=1 provider-code=403",
  );
});

test("subprocess diagnostics retain one bounded redacted provider line through a cause", () => {
  const secret = "private-config-secret";
  const detail = describeSubprocessFailure({
    code: 1,
    cause: {
      stderr:
        `✘ [ERROR] deployment forbidden account_id=${"a".repeat(32)} token=${secret}`,
    },
  });
  assert.match(detail, /^exit=1 detail=✘ \[ERROR\] deployment forbidden/u);
  assert.equal(detail.includes(secret), false);
  assert.equal(detail.includes("a".repeat(32)), false);
  assert.ok(detail.length <= 260);
});


test("static canaries follow each profile's explicit alias cutover", () => {
  const scenarioConfigs = configs.map((value) => structuredClone(value));
  for (const [classic, game, expectedClassic, expectedGame] of [
    ["v4-production", "v1-production", "canary-v6", "canary-v2"],
    ["v5-production", "v1-production", "canary-v6", "canary-v2"],
    ["v6-production", "v2-production", "", ""],
  ]) {
    scenarioConfigs[0].vars.CLASSIC_DIRECTORY_CUTOVER_MODE = classic;
    scenarioConfigs[0].vars.GAME_DIRECTORY_CUTOVER_MODE = game;
    const classicCommand = resolveProductionCanaryCommand(contract.productionCanaries[0], scenarioConfigs);
    const gameCommand = resolveProductionCanaryCommand(contract.productionCanaries[1], scenarioConfigs);
    assert.equal(classicCommand[classicCommand.indexOf("--alias-prefix") + 1], expectedClassic);
    assert.equal(gameCommand[gameCommand.indexOf("--alias-prefix") + 1], expectedGame);
  }
  scenarioConfigs[0].vars.GAME_DIRECTORY_CUTOVER_MODE = "unknown";
  assert.throws(() => resolveProductionCanaryCommand(contract.productionCanaries[0], scenarioConfigs), /cutover policy drift/u);
});


test("public callers reject signing secrets and key identifiers", () => {
  for (const index of [1, 2]) {
    assert.deepEqual(contract.workers[index].requiredSecrets, []);
    for (const mutate of [
      (value) => { value[index].secrets = { required: ["SOURCE_TAG_KEY_CURRENT"] }; },
      (value) => { value[index].vars.SOURCE_TAG_KEY_CURRENT_ID = "unexpected"; },
    ]) assert.throws(() => validateTopology(contract, changedConfigs(mutate)));
  }
});
function directoryProof(core, now = 2_000_000_000) {
  return {
    schema: "directory-reconciliation-v1",
    completedAt: now,
    configuration: {
      classicCutoverMode: core.vars.CLASSIC_DIRECTORY_CUTOVER_MODE,
      gameCutoverMode: core.vars.GAME_DIRECTORY_CUTOVER_MODE,
      classicOrigin: core.vars.CLASSIC_DIRECTORY_PUBLIC_ORIGIN,
      gameOrigin: core.vars.GAME_DIRECTORY_PUBLIC_ORIGIN,
    },
    profiles: ["classic-v3", "game-v2"].map((profile) => ({
      profile, outcome: "published", generation: 1,
      generatedAt: now, expiresAt: now + 14_400,
    })),
  };
}

function proxyEnvironment() {
  return {
    ATRINIK_DELIVERY_ENVIRONMENT: "production", GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "workflow_dispatch", ATRINIK_PROMOTION_SHA: "a".repeat(40),
    WORKERS_CI: "1", WORKERS_CI_BRANCH: "main",
    WORKERS_CI_COMMIT_SHA: "a".repeat(40),
    WORKERS_CI_BUILD_UUID: "11111111-1111-1111-1111-111111111111",
    CLOUDFLARE_ACCOUNT_ID: "a".repeat(32), CLOUDFLARE_API_TOKEN: "test-only",
  };
}

test("directory proxy is account-bound and grants only the private remote entrypoint", () => {
  const core = productionConfigs()[0];
  const proxy = directoryReconciliationProxyConfiguration(core);
  assert.doesNotThrow(() => validateDirectoryProxyInput(proxy, proxyEnvironment()));
  for (const change of [
    (value) => { value.account_id = "b".repeat(32); },
    (value) => { value.services[0].service = "other-core"; },
    (value) => { value.services[0].entrypoint = "PublisherCoordinator"; },
    (value) => { value.services[0].remote = false; },
    (value) => { value.d1_databases = [{ binding: "DB" }]; },
    (value) => { value.workers_dev = true; },
  ]) {
    const value = structuredClone(proxy);
    change(value);
    assert.throws(() => validateDirectoryProxyInput(value, proxyEnvironment()), /authority rejected/u);
  }
  assert.throws(() => validateDirectoryProxyInput(proxy, {}), /authority rejected/u);
  assert.throws(() => directoryReconciliationProxyConfiguration({ ...core, name: "other-core" }),
    /target identity/u);
  const authorityEnvironment = { ...proxyEnvironment(),
    ATRINIK_WORKERS_BUILDS_API_TOKEN: "read-only-observer",
    WRANGLER_CI_MATCH_TAG: "test-core-tag", WRANGLER_CI_OVERRIDE_NAME: "atrinik-metaserver" };
  const child = childEnvironment({ ...authorityEnvironment,
    ATRINIK_PRODUCTION_CORE_CONFIG: "private",
    UNREVIEWED_SECRET: "parent-only" }, "directory-reconciliation");
  assert.deepEqual(child, authorityEnvironment);
});

test("directory proof binds fresh complete aliases to the selected environment", () => {
  const core = productionConfigs()[0];
  const now = 2_000_000_000;
  const proof = directoryProof(core, now);
  assert.equal(validateDirectoryReconciliationProof(proof, core, now, now), proof);
  for (const change of [
    (value) => { value.completedAt = now - 1; },
    (value) => { value.completedAt = now + 1; },
    (value) => { value.configuration.classicCutoverMode = "v6-production"; },
    (value) => { value.configuration.gameOrigin = "https://other.example.org"; },
    (value) => { value.profiles.reverse(); },
    (value) => { value.profiles.pop(); },
    (value) => { value.profiles[0].generation = 0; },
    (value) => { value.profiles[0].outcome = "purge-pending"; },
    (value) => { value.profiles[0].generatedAt = now + 1; },
    (value) => { value.profiles[0].expiresAt = now; },
    (value) => { value.profiles[0].revision = 0; },
  ]) {
    const value = structuredClone(proof); change(value);
    assert.throws(() => validateDirectoryReconciliationProof(value, core, now, now), /directory reconciliation/u);
  }
  assert.throws(() => validateDirectoryReconciliationProof(proof, core, now - 121, now), /freshness/u);
});

test("first rollout builds generation-zero profiles before static canaries without cron", async () => {
  for (const decision of ["deploy", "no-op"]) {
    const now = 2_000_000_000;
    const core = productionConfigs()[0];
    const aliases = new Map();
    const stages = [];
    const callbacks = {
      workers: ["core", "publisher", "rendezvous"], decision,
      fence: async () => {}, deployStaged: async () => {}, readbackStaged: async () => {},
      verifyStaged: async () => {}, deployActive: async () => {}, readbackActive: async () => {},
      verifyFinal: async () => {}, recover: async () => {},
      reconcileDirectories: async () => {
        stages.push("reconcile");
        for (const profile of ["classic-v3", "game-v2"]) {
          // Simulate migration 0013: no checkpoint generation or aliases exist.
          assert.equal(aliases.has(profile), false);
          aliases.set(profile, 1);
        }
        validateDirectoryReconciliationProof(directoryProof(core, now), core, now, now);
      },
      canaries: async () => {
        stages.push("canaries");
        assert.deepEqual([...aliases.values()], [1, 1]);
      },
    };
    await orchestrateDelivery(callbacks);
    assert.deepEqual(stages, ["reconcile", "canaries"]);
    // A later build still verifies the current cohort before probing it.
    callbacks.reconcileDirectories = async () => {
      const current = directoryProof(core, now + 1);
      for (const record of current.profiles) record.outcome = "current";
      validateDirectoryReconciliationProof(current, core, now + 1, now + 1);
    };
    await orchestrateDelivery(callbacks);
  }
});

test("failed or stale reconciliation cannot reach static canaries", async () => {
  const now = 2_000_000_000;
  const core = productionConfigs()[0];
  for (const decision of ["deploy", "no-op"]) {
    for (const reconcileDirectories of [
      async () => { throw new Error("builder unavailable"); },
      async () => validateDirectoryReconciliationProof(directoryProof(core, now - 1), core, now, now),
      async () => {
        const proof = directoryProof(core, now); proof.profiles[0].generation = 0;
        validateDirectoryReconciliationProof(proof, core, now, now);
      },
    ]) {
      let probes = 0;
      let recovered = 0;
      await assert.rejects(orchestrateDelivery({
        workers: ["core", "publisher", "rendezvous"], decision,
        fence: async () => {}, deployStaged: async () => {}, readbackStaged: async () => {},
        verifyStaged: async () => {}, deployActive: async () => {}, readbackActive: async () => {},
        verifyFinal: async () => {}, reconcileDirectories,
        canaries: async () => { probes += 1; }, recover: async () => { recovered += 1; },
      }));
      assert.equal(probes, 0);
      assert.equal(recovered, decision === "deploy" ? 1 : 0);
    }
  }
});

test("directory proxy bounds initialization, failure, receipts and always disposes", async () => {
  const config = directoryReconciliationProxyConfiguration(productionConfigs()[0]);
  const options = { configPath: "/test/proxy.json", config, environment: proxyEnvironment(),
    authorize: async () => {} };
  let disposed = 0;
  const makeProxy = (response) => async (supplied) => {
    assert.deepEqual(supplied, { configPath: options.configPath, persist: false, remoteBindings: true });
    return { dispose: async () => { disposed += 1; }, env: {
      DIRECTORY_RECONCILIATION: { reconcile: async (...args) => {
        assert.deepEqual(args, []);
        return response;
      } },
    } };
  };
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
  assert.deepEqual(await invokeDirectoryProxy({ ...options,
    createProxy: makeProxy(new Response('{"ok":true}', { headers })) }), { ok: true });
  await assert.rejects(invokeDirectoryProxy({ ...options,
    createProxy: makeProxy(new Response("failure", { status: 503, headers })) }), /response rejected/u);
  await assert.rejects(invokeDirectoryProxy({ ...options,
    createProxy: makeProxy(new Response("x".repeat(4_097), { headers })) }), /too large/u);
  assert.equal(disposed, 3);
  let initialize = 0;
  await assert.rejects(invokeDirectoryProxy({ ...options, environment: {},
    createProxy: async () => { initialize += 1; } }), /authority rejected/u);
  assert.equal(initialize, 0);
  await assert.rejects(invokeDirectoryProxy({ ...options, timeoutMs: 5,
    createProxy: async () => new Promise(() => {}) }), /deadline/u);
});

test("real SDK named binding RPC preserves the exact envelope and bounded acceptance", async () => {
  const interfaceBytes = await readFile(resolve(root, directoryInterfacePath));
  const selectedInterface = JSON.parse(interfaceBytes);
  assert.equal((await readDirectoryInterface(root, { committed: false })).digest,
    createHash("sha256").update(interfaceBytes).digest("hex"));
  const { build } = await import("esbuild");
  const { Miniflare, convertV4MiniflareOptions } = await import("miniflare");
  const bundled = await build({ stdin: { resolveDir: root, sourcefile: "directory-rpc-fixture.ts",
    contents: `
      import { DirectoryReconciliation as Core } from './src/directory-reconciliation';
      let calls = 0;
      export class DirectoryReconciliation extends Core {
        invocationCount() { return calls; }
        async fetch(request) {
          calls++;
          const response = await super.fetch(request);
          // Missing state bindings make the real handler return 503 only after
          // accepting its exact envelope. Malformed envelopes still return 400.
          if (response.status !== 503) return response;
          return Response.json({url:request.url,method:request.method,
            headers:[...request.headers],bodyIsNull:request.body===null},
            {headers:{'Cache-Control':'no-store'}});
        }
      }
      export class Oversized extends DirectoryReconciliation {
        async fetch() { return new Response('x'.repeat(4097),
          {headers:{'Content-Type':'application/json','Cache-Control':'no-store'}}); }
      }
      export class Pending extends DirectoryReconciliation {
        async fetch(request) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          return super.fetch(request);
        }
      }
    ` }, bundle: true, write: false, format: "esm", platform: "browser",
    target: "es2022", external: ["cloudflare:workers"], logLevel: "silent" });
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [
    { name: "directory-proxy-fixture", modules: true, compatibilityDate: "2026-08-05",
      script: "export default {fetch(){return new Response('unused')}}",
      serviceBindings: Object.fromEntries(["DirectoryReconciliation", "Oversized", "Pending"].map(
        entrypoint => [entrypoint, { name: "directory-core-fixture", entrypoint }])) },
    { name: "directory-core-fixture", modules: true, compatibilityDate: "2026-08-05",
      script: bundled.outputFiles[0].text },
  ] }));
  let disposal;
  const dispose = () => disposal ??= mf.dispose();
  try {
    const bindings = await mf.getBindings("directory-proxy-fixture");
    const binding = bindings.DirectoryReconciliation;
    const url = selectedInterface.request.url;
    // Pin the original defect at the actual SDK boundary, not a fetch mock:
    // native Node Request is stringified by the SDK's separate undici realm.
    await assert.rejects(async () => binding.fetch(new globalThis.Request(url, { method: "POST" })),
      /Failed to parse URL from \[object Request\]/u);
    assert.equal(await binding.invocationCount(), 0);
    // URL+init reaches workerd but the SDK's transport headers violate the
    // unchanged handler guard; accepting them is not the production fix.
    const http = await binding.fetch(url, { method: "POST", redirect: "error" });
    assert.equal(http.status, 400);
    await http.body.cancel();
    const before = await binding.invocationCount();
    for (const args of [[undefined], ["classic-v3"], [{ url }]]) {
      const rejected = await binding[selectedInterface.method](...args);
      assert.equal(rejected.status, 400);
      await rejected.body.cancel();
    }
    assert.equal(await binding.invocationCount(), before);
    const options = { configPath: "/fixture/proxy.json",
      config: directoryReconciliationProxyConfiguration(productionConfigs()[0]),
      environment: proxyEnvironment(), authorize: async () => {} };
    const proxy = (service) => async () => ({
      env: { DIRECTORY_RECONCILIATION: service }, dispose: async () => {},
    });
    assert.deepEqual(await invokeDirectoryProxy({ ...options, createProxy: proxy(binding) }),
      { url, method: selectedInterface.request.method, headers: [], bodyIsNull: true });
    await assert.rejects(invokeDirectoryProxy({ ...options,
      createProxy: proxy(bindings.Oversized) }), /receipt too large/u);
    let authorizations = 0;
    let disposed = false;
    await assert.rejects(invokeDirectoryProxy({ ...options, timeoutMs: 20,
      authorize: async () => { authorizations++; }, createProxy: async () => ({
        env: { DIRECTORY_RECONCILIATION: bindings.Pending },
        dispose: async () => { disposed = true; await dispose(); },
      }) }), /deadline exceeded/u);
    assert.equal(disposed, true);
    assert.equal(authorizations, 2, "expired RPC cannot reach receipt acceptance");
  } finally { await dispose(); }
});

test("directory proxy requires live authority before import, request and receipt acceptance", async () => {
  const config = directoryReconciliationProxyConfiguration(productionConfigs()[0]);
  const events = [];
  let authorizations = 0;
  const options = {
    configPath: "/test/proxy.json", config, environment: proxyEnvironment(),
    authorize: async () => { authorizations += 1; events.push(`authority:${authorizations}`); },
    createProxy: async () => {
      events.push("import-and-init");
      return {
        dispose: async () => events.push("dispose"),
        env: { DIRECTORY_RECONCILIATION: { reconcile: async () => {
          events.push("remote-request");
          return Response.json({ receipt: true }, { headers: { "Cache-Control": "no-store" } });
        } } },
      };
    },
  };
  assert.deepEqual(await invokeDirectoryProxy(options), { receipt: true });
  assert.deepEqual(events, ["authority:1", "import-and-init", "authority:2",
    "remote-request", "authority:3", "dispose"]);
  for (const failedAuthority of [1, 2, 3]) {
    authorizations = 0; events.length = 0;
    await assert.rejects(invokeDirectoryProxy({ ...options, authorize: async () => {
      authorizations += 1;
      if (authorizations === failedAuthority) throw new Error("actual build authority rejected");
    } }), /actual build authority rejected/u);
    assert.equal(events.includes("import-and-init"), failedAuthority > 1);
    assert.equal(events.includes("remote-request"), failedAuthority > 2);
    assert.equal(events.includes("dispose"), failedAuthority > 1);
  }
  events.length = 0;
  await assert.rejects(invokeDirectoryProxy({ ...options, authorize: undefined }), /live authority missing/u);
  assert.deepEqual(events, []);
});

test("directory proxy bounds hanging fetch, read, cancellation and disposal", async () => {
  const config = directoryReconciliationProxyConfiguration(productionConfigs()[0]);
  const options = { configPath: "/test/proxy.json", config, environment: proxyEnvironment(),
    authorize: async () => {}, timeoutMs: 10, cleanupTimeoutMs: 10 };
  const never = () => new Promise(() => {});
  let invoked = false;
  let disposed = false;
  await assert.rejects(invokeDirectoryProxy({ ...options, createProxy: async () => ({
    dispose: async () => { disposed = true; },
    env: { DIRECTORY_RECONCILIATION: { reconcile: async (...args) => {
      assert.deepEqual(args, []); invoked = true; return never();
    } } },
  }) }), /deadline exceeded/u);
  assert.equal(invoked, true);
  assert.equal(disposed, true);

  let cancelled = false;
  disposed = false;
  await assert.rejects(invokeDirectoryProxy({ ...options, createProxy: async () => ({
    dispose: async () => { disposed = true; },
    env: { DIRECTORY_RECONCILIATION: { reconcile: async () => new Response(new ReadableStream({
      pull: never, cancel: () => { cancelled = true; },
    }), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }) } },
  }) }), /deadline exceeded/u);
  assert.equal(cancelled, true);
  assert.equal(disposed, true);

  await assert.rejects(invokeDirectoryProxy({ ...options, createProxy: async () => ({
    dispose: never,
    env: { DIRECTORY_RECONCILIATION: { reconcile: async () =>
      Response.json({ receipt: true }, { headers: { "Cache-Control": "no-store" } }) } },
  }) }), /cleanup deadline exceeded/u);

  disposed = false;
  let completeInitialization;
  const delayed = invokeDirectoryProxy({ ...options, createProxy: () => new Promise((resolveProxy) => {
    completeInitialization = () => resolveProxy({
      dispose: async () => { disposed = true; },
      env: { DIRECTORY_RECONCILIATION: { reconcile: async () => {
        assert.fail("expired initialization must not invoke the core");
      } } },
    });
  }) });
  await assert.rejects(delayed, /deadline exceeded/u);
  completeInitialization();
  await new Promise((resolveNext) => setImmediate(resolveNext));
  assert.equal(disposed, true);
});


test("live contracts authorize only automatic DEV and explicit production promotion", async () => {
  for (const target of ["production", "development"]) {
    const live = JSON.parse(await readFile(resolve(root, `deployment/workers-builds-${target}.json`), "utf8"));
    await assert.doesNotReject(validateDeliveryContract(live));
    const changed = structuredClone(live);
    changed.automaticPush = !changed.automaticPush;
    await assert.rejects(validateDeliveryContract(changed), /contract drift/u);
    assert.equal(live.invariants.migrationPolicy, "exact-ledger-no-automatic-apply");
  }
  await assert.rejects(validateDeliveryContract(contract), /unknown delivery target/u);
});

test("DEV requires existing names, private maintenance DO, exact origins and no cron", async () => {
  const live = JSON.parse(await readFile(resolve(root, "deployment/workers-builds-development.json"), "utf8"));
  const development = configs.map(developmentFixture);
  assert.doesNotThrow(() => validateTopology(live, development));
  assert.equal(development[0].main, "development/core.ts");
  assert.deepEqual(development.map(({ name }) => name), developmentWorkerNames);
  for (const change of [
    (value) => { value[0].vars.DEVELOPMENT_MAINTENANCE = "other"; },
    (value) => { value[0].triggers.crons = ["*/5 * * * *"]; },
    (value) => { value[0].durable_objects.bindings.pop(); },
    (value) => { value[0].main = "src/index.ts"; },
    (value) => { value[1].services[0].service = "atrinik-metaserver"; },
  ]) {
    const changed = structuredClone(development);
    change(changed);
    assert.throws(() => validateTopology(live, changed));
  }
  assert.throws(() => validateTopology(live, configs), /name drift|entrypoint drift/u);
  const proxy = directoryReconciliationProxyConfiguration({ ...development[0], account_id: "a".repeat(32) });
  const environment = { ...proxyEnvironment(), ATRINIK_DELIVERY_ENVIRONMENT: "development",
    GITHUB_EVENT_NAME: "workflow_run", ATRINIK_DEVELOPMENT_SHA: "a".repeat(40) };
  assert.doesNotThrow(() => validateDirectoryProxyInput(proxy, environment));
  assert.throws(() => validateDirectoryProxyInput(proxy, proxyEnvironment()), /authority rejected/u);
});

test("production exact-tag no-op refuses an equivalent different source", () => {
  const plan = { deploy: "d", migrationDigest: "m", migrations: ["one"], controls: ["a", "b", "c"] };
  const annotations = ["core", "publisher", "rendezvous"].map((role, index) => ({
    role, source: "a".repeat(40), deploy: "d", migration: "m", migrationHorizon: 1,
    control: plan.controls[index], phase: "active",
  }));
  assert.equal(deliveryDecision(annotations, plan), "no-op");
  assert.equal(deliveryDecision(annotations, plan, { sourceSha: "a".repeat(40) }), "no-op");
  assert.equal(deliveryDecision(annotations, plan, { sourceSha: "b".repeat(40) }), "deploy");
});

test("promotion credentials reach only the independently authorized reconciliation child", () => {
  const environment = { GITHUB_TOKEN: "github-secret", ATRINIK_PRODUCTION_BUILDS_READ_TOKEN: "provider-secret",
    ATRINIK_PRODUCTION_WRITER_FENCE_POLICY: "policy", ATRINIK_DELIVERY_ENVIRONMENT: "production",
    ATRINIK_DELIVERY_SOURCE_ROOT: "/selected", ATRINIK_PRODUCTION_CORE_CONFIG: "private-config" };
  for (const policy of ["public", "deployment"]) assert.deepEqual(childEnvironment(environment, policy), {});
  assert.deepEqual(childEnvironment(environment, "directory-reconciliation"), {
    GITHUB_TOKEN: "github-secret", ATRINIK_PRODUCTION_BUILDS_READ_TOKEN: "provider-secret",
    ATRINIK_PRODUCTION_WRITER_FENCE_POLICY: "policy", ATRINIK_DELIVERY_ENVIRONMENT: "production",
    ATRINIK_DELIVERY_SOURCE_ROOT: "/selected",
  });
});

test("selected Git source must declare the supported interface before any DEV or PROD provider access", async () => {
  const selected = await mkdtemp(resolve(tmpdir(), "atrinik-directory-interface-test-"));
  const path = resolve(selected, directoryInterfacePath);
  const canonical = await readFile(resolve(root, directoryInterfacePath), "utf8");
  const runGit = (...args) => {
    const result = spawnSync("git", ["-C", selected, "-c", "user.name=Interface Fixture",
      "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args],
      { encoding: "utf8", env: { PATH: process.env.PATH, HOME: selected } });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const commit = () => { runGit("add", "-A"); runGit("commit", "--allow-empty", "-qm", "fixture"); };
  const originalFetch = globalThis.fetch;
  const originalEnvironment = process.env.ATRINIK_DELIVERY_ENVIRONMENT;
  const originalSourceRoot = process.env.ATRINIK_DELIVERY_SOURCE_ROOT;
  let providerCalls = 0;
  globalThis.fetch = async () => { providerCalls++; throw new Error("provider must remain untouched"); };
  try {
    runGit("init", "-q");
    await mkdir(resolve(selected, "deployment"));
    commit();
    const rejectBoth = async () => {
      for (const target of ["development", "production"]) {
        await assert.rejects(runDelivery({ target, sourceRoot: selected }),
          { message: incompatibleDirectoryInterface });
      }
      assert.equal(providerCalls, 0);
    };
    await rejectBoth(); // Historical fetch-only tag: no declaration.
    const incompatible = [
      { schemaVersion: 2 }, { transport: "service-binding-http" }, { method: "fetch" },
      { argumentCount: 1 }, { receipt: { schema: "future-receipt" } }, { extra: "unsupported" },
    ];
    for (const delta of incompatible) {
      await writeFile(path, JSON.stringify({ ...JSON.parse(canonical), ...delta }, null, 2) + "\n");
      commit();
      await rejectBoth();
    }
    await writeFile(path, canonical);
    await rejectBoth(); // Uncommitted local data cannot make an old tag eligible.
    commit();
    const evidence = await readDirectoryInterface(selected);
    assert.equal(evidence.sourceSha, runGit("rev-parse", "HEAD"));
    assert.equal(evidence.digest, createHash("sha256").update(canonical).digest("hex"));
    // Compatible selected tags may lag main; the exact selected Git coordinate
    // controls this source check, not a latest-tag policy.
    await writeFile(resolve(selected, "unrelated.txt"), "later commit\n"); commit();
    runGit("checkout", "--detach", "-q", evidence.sourceSha);
    assert.deepEqual(await readDirectoryInterface(selected), evidence);
    await writeFile(path, canonical + " ");
    await rejectBoth();
    await rm(path);
    await writeFile(resolve(selected, "contract-target.json"), canonical);
    await symlink("../contract-target.json", path);
    commit();
    await rejectBoth();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalEnvironment === undefined) delete process.env.ATRINIK_DELIVERY_ENVIRONMENT;
    else process.env.ATRINIK_DELIVERY_ENVIRONMENT = originalEnvironment;
    if (originalSourceRoot === undefined) delete process.env.ATRINIK_DELIVERY_SOURCE_ROOT;
    else process.env.ATRINIK_DELIVERY_SOURCE_ROOT = originalSourceRoot;
    await rm(selected, { recursive: true, force: true });
  }
});

test("an RPC response arriving after timeout is cancelled without accepting its receipt", async () => {
  let finish;
  let authorizations = 0;
  let disposed = false;
  let cancelled = false;
  await assert.rejects(invokeDirectoryProxy({ configPath: "/fixture/proxy.json",
    config: directoryReconciliationProxyConfiguration(productionConfigs()[0]),
    environment: proxyEnvironment(), timeoutMs: 5,
    authorize: async () => { authorizations++; },
    createProxy: async () => ({ dispose: async () => { disposed = true; },
      env: { DIRECTORY_RECONCILIATION: { reconcile: () => new Promise(resolveResponse => {
        finish = resolveResponse;
      }) } } }),
  }), /deadline exceeded/u);
  assert.equal(disposed, true);
  finish(new Response(new ReadableStream({ cancel() { cancelled = true; } }),
    { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }));
  await new Promise(resolveNext => setImmediate(resolveNext));
  assert.equal(cancelled, true);
  assert.equal(authorizations, 2);
});

test("ordinary local production invocation fails before selected source or provider access", async () => {
  await assert.rejects(runDelivery(), /explicit selected source checkout/u);
  await assert.rejects(runDelivery({ target: "review" }), /invalid delivery invocation/u);
});


test("authenticated Wrangler and bundle tooling stay anchored to the trusted controller", async () => {
  const observed = [];
  const selected = "/untrusted-selected-release";
  const execute = async (program, args, options) => {
    assert.notEqual(program, `${selected}/node_modules/.bin/wrangler`);
    observed.push({ program, args, options });
    return { stdout: "{}" };
  };
  await executeTrustedWrangler(["deploy", "--dry-run"], { cwd: selected }, execute);
  await executeTrustedWrangler(["versions", "view", "existing"],
    { cwd: selected, environmentPolicy: "deployment" }, execute);
  await executeTrustedWrangler(["deploy", "--strict"],
    { cwd: selected, environmentPolicy: "deployment" }, execute);
  assert.equal(observed.length, 3);
  assert.ok(observed.every((call) => call.program === resolve(root, "node_modules/.bin/wrangler")));
  assert.ok(observed.every((call) => call.options.cwd === root),
    "selected cwd must not load a release-owned .env with CLOUDFLARE_API_BASE_URL");
});


test("first mutation rechecks every approved predecessor after slow authority fences", async () => {
  for (let changedRole = 0; changedRole < 3; changedRole++) {
    const approved = ["private-core-version", "private-publisher-version", "private-rendezvous-version"];
    let active = [...approved];
    const events = [];
    await assert.rejects(orchestrateDelivery({
      workers: ["core", "publisher", "rendezvous"], decision: "deploy",
      fence: async () => { events.push("fence"); active[changedRole] = "unapproved-version"; },
      verifyPredecessor: () => verifyPredecessorHandoff(approved,
        async () => { events.push("read-all-predecessors"); return { versions: active, annotations: [] }; },
        async () => events.push("approved")),
      deployStaged: async () => events.push("MUTATION"),
      recover: async () => events.push("no-core-mutation-to-recover"),
    }), /active predecessor changed/u);
    assert.deepEqual(events, ["fence", "read-all-predecessors", "no-core-mutation-to-recover"]);
  }
});

test("unchanged predecessor is reauthorized once before core staging, not against intermediate cohort", async () => {
  const versions = ["core-before", "publisher-before", "rendezvous-before"];
  let validations = 0;
  const events = [];
  await orchestrateDelivery({
    workers: ["core", "publisher", "rendezvous"], decision: "deploy",
    fence: async () => events.push("fence"),
    verifyPredecessor: () => verifyPredecessorHandoff(versions,
      async () => { events.push("predecessor"); return { versions: [...versions], annotations: ["approved"] }; },
      async (annotations, observed) => {
        validations++; assert.deepEqual(annotations, ["approved"]); assert.deepEqual(observed.versions, versions);
      }),
    deployStaged: async (role) => events.push(`deploy:${role}`),
    readbackStaged: async () => {}, verifyStaged: async () => {}, deployActive: async () => {},
    readbackActive: async () => {}, verifyFinal: async () => {}, reconcileDirectories: async () => {},
    canaries: async () => {}, recover: async () => assert.fail("unexpected recovery"),
  });
  assert.equal(validations, 1);
  assert.deepEqual(events.slice(0, 3), ["fence", "predecessor", "deploy:core"]);
});

test("success reports omit provider IDs while owner-only receipt retains exact versions", async () => {
  const workers = ["core", "publisher", "rendezvous"].map(role => ({
    role, sourceSha: "a".repeat(40), versionId: `private-${role}-version`, unexpected: "private-config",
  }));
  const publicWorkers = publicDeliveryWorkers(workers);
  assert.deepEqual(publicWorkers, workers.map(({ role, sourceSha }) => ({ role, sourceSha })));
  assert.equal(JSON.stringify(publicWorkers).includes("private"), false);
  const path = await retainPrivateDeliveryEvidence({ workers });
  try {
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { workers });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(resolve(path, ".."))).mode & 0o777, 0o700);
  } finally { await rm(resolve(path, ".."), { recursive: true, force: true }); }
});

test("failure accessor and formatter do not publish private provider identity fields", () => {
  const evidence = { sourceSha: "a".repeat(40), deployableDigest: null, failedRole: "staged:core",
    completedRoles: ["staged:core"], recoveryOutcome: "failed", buildUuid: "private-build-id",
    workers: [{ versionId: "private-worker-version" }], privateEvidencePath: "/private/receipt" };
  const record = deliveryFailureRecord(new Error("private provider response"), evidence);
  assert.equal(JSON.stringify(record).includes("private"), false);
  assert.deepEqual(record.completedRoles, ["staged:core"]);
  assert.notEqual(record.completedRoles, evidence.completedRoles);
  assert.equal(currentDeliveryFailureRecord(new Error("private")).reason, "unexpected-internal-error");
});


test("DEV reconciliation failures retain only closed phase/reason diagnostics through the parent", async () => {
  const secret = "private account-id/token https://private.example/receipt";
  const config = directoryReconciliationProxyConfiguration({ ...developmentFixture(configs[0], 0), account_id: "a".repeat(32) });
  const environment = { ...proxyEnvironment(), ATRINIK_DELIVERY_ENVIRONMENT: "development",
    GITHUB_EVENT_NAME: "workflow_run", ATRINIK_DEVELOPMENT_SHA: "a".repeat(40) };
  const cases = [
    { phase: "authority-before-proxy", authority: 1 },
    { phase: "proxy-initialization", init: true },
    { phase: "authority-before-request", authority: 2 },
    { phase: "request", fetch: true },
    { phase: "response", response: () => new Response(secret, { status: 503 }), reason: "http-503" },
    { phase: "receipt", response: () => new Response(secret, { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }), reason: "receipt-invalid" },
    { phase: "authority-after-receipt", authority: 3 },
    { phase: "cleanup", cleanup: true, reason: "cleanup-failed" },
  ];
  for (const scenario of cases) {
    let calls = 0;
    let failed;
    try {
      await invokeDirectoryProxy({ configPath: "/private/proxy.json", config, environment,
        authorize: async () => { if (++calls === scenario.authority) throw new Error(secret); },
        createProxy: async () => {
          if (scenario.init) throw new Error(secret);
          return { dispose: async () => { if (scenario.cleanup) throw new Error(secret); },
            env: { DIRECTORY_RECONCILIATION: { reconcile: async () => {
              if (scenario.fetch) throw new Error(secret);
              return scenario.response?.() ?? Response.json({ receipt: true }, { headers: { "Cache-Control": "no-store" } });
            } } } };
        },
      });
    } catch (error) { failed = error; }
    assert.ok(failed, scenario.phase);
    const line = directoryFailureLine(failed);
    assert.deepEqual(parseDirectoryFailure(line), { schema: "directory-failure-v1", phase: scenario.phase,
      reason: scenario.reason ?? "operation-failed" });
    const detail = describeSubprocessFailure({ code: 1, stderr: `${secret}\n${line}\n` });
    assert.equal(detail, `exit=1 directory-phase=${scenario.phase} directory-reason=${scenario.reason ?? "operation-failed"}`);
    assert.equal(detail.includes(secret), false);
    assert.equal(line.includes(secret), false);
  }
});

test("reconciliation timeout diagnostics identify the pending stage and cleanup deadline", async () => {
  const config = directoryReconciliationProxyConfiguration(productionConfigs()[0]);
  const options = { configPath: "/private/proxy.json", config, environment: proxyEnvironment(),
    timeoutMs: 5, cleanupTimeoutMs: 5 };
  const never = () => new Promise(() => {});
  for (const [phase, overrides] of [
    ["authority-before-proxy", { authorize: never, createProxy: async () => assert.fail("must not initialize") }],
    ["proxy-initialization", { authorize: async () => {}, createProxy: never }],
    ["cleanup", { authorize: async () => {}, createProxy: async () => ({ dispose: never,
      env: { DIRECTORY_RECONCILIATION: { reconcile: async () => Response.json({}, { headers: { "Cache-Control": "no-store" } }) } } }) }],
  ]) {
    await assert.rejects(invokeDirectoryProxy({ ...options, ...overrides }), error => {
      assert.deepEqual(parseDirectoryFailure(directoryFailureLine(error)), { schema: "directory-failure-v1", phase,
        reason: phase === "cleanup" ? "cleanup-deadline-exceeded" : "deadline-exceeded" });
      return true;
    });
  }
});

test("child diagnostics reject arbitrary fields, duplicate records and unrecognized codes", () => {
  const line = directoryFailureLine(markDirectoryFailure(new Error("private-secret"), "proxy-initialization"));
  for (const text of [line + "\n" + line, line.replace("proxy-initialization", "private-secret"),
    line.replace('"operation-failed"', '"private-secret"'), line.replace('"phase":', '"private":"secret","phase":'),
    "ATRINIK_DIRECTORY_FAILURE not-json", "x".repeat(8193) + line]) assert.equal(parseDirectoryFailure(text), null);
  assert.deepEqual(parseDirectoryFailure(directoryFailureLine(new Error("private-secret"))),
    { schema: "directory-failure-v1", phase: "configuration", reason: "operation-failed" });
});


test("real reconciliation child catch emits a redacted record consumed by the parent", () => {
  const result = spawnSync(process.execPath,
    [resolve(root, "scripts/production-directory-reconciliation.mjs"), "/private/secret-account-config-missing.json"],
    { encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(parseDirectoryFailure(result.stderr),
    { schema: "directory-failure-v1", phase: "configuration", reason: "operation-failed" });
  assert.equal(result.stderr.includes("secret-account"), false);
  assert.equal(describeSubprocessFailure({ code: result.status, stderr: result.stderr }),
    "exit=1 directory-phase=configuration directory-reason=operation-failed");
});

test("caller retirement requires exact selected disabled bundle, annotation and binding graph", () => {
  const index = 1, worker = contract.workers[index];
  const config = disabledCircuitConfiguration(productionConfigs()[index], worker.role);
  const sourceSha = "1".repeat(40), bundleDigest = "2".repeat(64);
  const expectedMessage = `atrinik-delivery-v1 source=${sourceSha} deploy=${"3".repeat(64)} migration=${"4".repeat(64)} horizon=16 control=${"5".repeat(64)} role=publisher phase=staged`;
  const plane = liveControlPlane(index);
  const bindings = [
    ...Object.entries(config.vars).map(([name, text]) => ({ name, type: "plain_text", text })),
    ...config.services.map(({ binding, ...value }) => ({ ...value, name: binding, type: "service" })),
    ...config.ratelimits.map(value => ({ ...value, type: "ratelimit" })),
    ...["SOURCE_TAG_KEY_CURRENT", "SOURCE_TAG_KEY_PREVIOUS"].map(name => ({ name, type: "secret_text" })),
  ];
  const snapshot = { accountId: config.account_id, name: config.name, activeVersion: "same", latestVersion: "same",
    settings: { annotations: { "workers/tag": sourceSha, "workers/message": expectedMessage } },
    resources: { bindings, script_runtime: { compatibility_date: config.compatibility_date,
      compatibility_flags: config.compatibility_flags, exports: config.exports ?? {} } },
    code: { modules: [{ name: "worker.js", sha256: bundleDigest }] },
    control: { routes: plane.routes, domains: plane.customDomains, subdomain: plane.subdomainStatus,
      environment: plane.serviceEnvironment, schedules: plane.cronTriggers } };
  const input = { worker, config, sourceSha, bundleDigest, expectedMessage, snapshot,
    expectedZoneId: "b".repeat(32), retired: false };
  assert.equal(verifyStagedCallerRetirement(input), true);
  for (const change of [
    x => { x.snapshot.code.modules[0].sha256 = "9".repeat(64); },
    x => { x.snapshot.code.modules.push({ name: "unapproved.js", sha256: bundleDigest }); },
    x => { x.snapshot.settings.annotations["workers/tag"] = "8".repeat(40); },
    x => { x.snapshot.settings.annotations["workers/message"] += "changed"; },
    x => { x.snapshot.latestVersion = "other"; },
    x => { x.snapshot.resources.bindings.find(v => v.name === "PUBLISH_ENABLED").text = "enabled"; },
    x => { x.config.vars.PUBLISH_ENABLED = "enabled"; },
    x => { x.snapshot.resources.bindings.push({ name: "UNKNOWN_SECRET", type: "secret_text" }); },
    x => { x.snapshot.control.domains[0].zone_id = "c".repeat(32); },
  ]) { const candidate = structuredClone(input); change(candidate); assert.throws(() => verifyStagedCallerRetirement(candidate)); }
  const retired = structuredClone(input); retired.retired = true;
  assert.throws(() => verifyStagedCallerRetirement(retired));
  retired.snapshot.resources.bindings = retired.snapshot.resources.bindings.filter(v => v.type !== "secret_text");
  assert.equal(verifyStagedCallerRetirement(retired), true);
});

test("old caller code and key-ID authority remain pinned until that role's staging handoff", async () => {
  const worker = { role: "publisher", variables: [{ binding: "SOURCE_TAG_KEY_CURRENT_ID", value: "old-a" },
    { binding: "SOURCE_TAG_KEY_PREVIOUS_ID", value: "old-b" }] };
  const active = { versionId: "approved-immutable-version", version: { resources: { bindings: [
    ...worker.variables.map(({ binding, value }) => ({ name: binding, type: "plain_text", text: value })),
    ...["SOURCE_TAG_KEY_CURRENT", "SOURCE_TAG_KEY_PREVIOUS"].map(name => ({ name, type: "secret_text" })),
  ] } } };
  verifyBootstrapCallerPredecessor(active.versionId, worker, active);
  for (const change of [
    a => { a.versionId = "other-version-with-same-settings"; },
    a => { a.version.resources.bindings[0].text = "changed-epoch"; },
    a => { a.version.resources.bindings.push({ name: "EXTRA", type: "secret_text" }); },
    a => { a.version.resources.bindings.pop(); },
  ]) {
    const current = structuredClone(active); change(current); let uploads = 0;
    assert.throws(() => { verifyBootstrapCallerPredecessor(active.versionId, worker, current); uploads++; });
    assert.equal(uploads, 0);
  }
});
