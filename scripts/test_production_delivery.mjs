import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  activeVersionId,
  arbitrateBuildLease,
  assertCoherentTopology,
  buildLeaseDecision,
  childEnvironment,
  controlPlaneView,
  disabledCircuitConfiguration,
  deliveryFailureRecord,
  deliveryDecision,
  deployStagedWithRecoveryIntent,
  executeOrderedStages,
  orchestrateDelivery,
  materializeProtectedInputs,
  parseVersionMessage,
  recoverDisabledCore,
  selectBuildLeaseOwner,
  selectLiveTrigger,
  sanitizedChildEnvironment,
  validateBuildTrigger,
  validateBuildEnvironment,
  validateContract,
  validateLiveControlPlane,
  validateProtectedDocument,
  validateRemoteMigrations,
  validateRuntimeExports,
  validateSourceCoordinates,
  validateTopology,
} from "./production-delivery.mjs";

const root = resolve(import.meta.dirname, "..");
const contract = JSON.parse(
  await readFile(
    resolve(root, "deployment/workers-builds-production.json"),
    "utf8",
  ),
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

test("rejects second approval, rollout, and unordered topology drift", () => {
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
    /configuration epoch drift/u,
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
    (value) => { value[1].vars.PUBLISH_ENABLED = "enabled"; },
    (value) => { value[2].vars.ROUTE_DISABLED_RETRY_SECONDS = "301"; },
    (value) => {
      value[0].vars.SOURCE_TAG_KEY_PREVIOUS_ID =
        value[0].vars.SOURCE_TAG_KEY_CURRENT_ID;
      value[1].vars.SOURCE_TAG_KEY_PREVIOUS_ID =
        value[1].vars.SOURCE_TAG_KEY_CURRENT_ID;
      value[2].vars.SOURCE_TAG_KEY_PREVIOUS_ID =
        value[2].vars.SOURCE_TAG_KEY_CURRENT_ID;
    },
    (value) => {
      for (const config of value)
        config.vars.SOURCE_TAG_KEY_CURRENT_ID = "a".repeat(33);
    },
  ]) {
    assert.throws(
      () => validateTopology(contract, changedConfigs(mutate)),
      /production policy is invalid|production circuit authority drift|retry policy drift|configuration epoch is invalid/u,
    );
  }
  const runtimeValidIds = changedConfigs((value) => {
    for (const config of value) {
      config.vars.SOURCE_TAG_KEY_CURRENT_ID = "Release_A-1";
      config.vars.SOURCE_TAG_KEY_PREVIOUS_ID = "Release_A-0";
    }
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
  for (const source of ["push_event", "push", "manual", "api"]) {
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

test("requires the exact protected Workers Builds environment", () => {
  const environment = Object.fromEntries([
    contract.protectedInputs.accountVariable,
    contract.protectedInputs.coreConfigVariable,
    contract.protectedInputs.publisherConfigVariable,
    contract.protectedInputs.rendezvousConfigVariable,
    contract.protectedInputs.buildsApiTokenVariable,
    contract.protectedInputs.controlPlaneGateVariable,
  ].map((name) => [name, { is_secret: true, value: null }]));
  environment.SKIP_DEPENDENCY_INSTALL = { is_secret: false, value: "1" };
  assert.doesNotThrow(() => validateBuildEnvironment(contract, environment));
  for (const mutate of [
    (value) => { value.SKIP_DEPENDENCY_INSTALL.value = "0"; },
    (value) => { value[contract.protectedInputs.coreConfigVariable].is_secret = false; },
    (value) => { value.UNREVIEWED = { is_secret: true, value: null }; },
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

test("every protected configuration field is exact-SHA gated", () => {
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
  assert.throws(
    () => deliveryDecision(annotations, plan, source, "routine"),
    /control-plane prerequisite is not verified/u,
  );
  assert.equal(
    deliveryDecision(annotations, plan, source, `approved:${source}`),
    "deploy",
  );
});

test("no-op requires one coherent active topology and control drift needs exact approval", () => {
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
  assert.equal(deliveryDecision(annotations, plan, source, "routine"), "no-op");
  assert.equal(
    deliveryDecision(
      annotations,
      { ...plan, deploy: "9".repeat(64) },
      source,
      "routine",
    ),
    "deploy",
  );
  assert.equal(
    deliveryDecision(annotations, plan, source, `approved:${source}`),
    "deploy",
  );
  assert.throws(
    () =>
      deliveryDecision(
        annotations.map((value, index) =>
          index === 0 ? { ...value, migration: "f".repeat(64) } : value,
        ),
        plan,
        source,
        `approved:${source}`,
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
      source,
      "routine",
    ),
    "deploy",
  );
  const changedControl = annotations.map((value, index) =>
    index === 0 ? { ...value, control: "f".repeat(64) } : value,
  );
  assert.throws(
    () => deliveryDecision(changedControl, plan, source, "routine"),
    /control-plane prerequisite/u,
  );
  assert.equal(
    deliveryDecision(changedControl, plan, source, `approved:${source}`),
    "deploy",
  );
});

test("only an approved append-only migration horizon can advance", () => {
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
  assert.throws(
    () => deliveryDecision(prior, plan, source, "routine"),
    /not authorized/u,
  );
  assert.equal(
    deliveryDecision(prior, plan, source, `approved:${source}`),
    "deploy",
  );
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
    deliveryDecision(partial, plan, source, `approved:${source}`),
    "deploy",
  );
  const rewritten = prior.map((value) => ({ ...value, migration: "f".repeat(64) }));
  assert.throws(
    () => deliveryDecision(rewritten, plan, source, `approved:${source}`),
    /divergent/u,
  );
});

test("internally staged controls resume under the routine gate", () => {
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
  assert.equal(deliveryDecision(partial, plan, source, "routine"), "deploy");
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
    "fence", "final", "canaries", "fence",
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
      canaries: async () => noOpEvents.push("canaries"),
      recover: async () => noOpEvents.push("unexpected-recovery"),
    }),
    "no-deployment-required",
  );
  assert.deepEqual(noOpEvents, ["fence", "final", "canaries", "fence"]);
});

test("orchestrator recovers disabled circuits after every asynchronous boundary failure", async () => {
  const workers = ["core", "publisher", "rendezvous"];
  const targets = [
    ...Array.from({ length: 15 }, (_, index) => `fence:${index + 1}`),
    ...workers.flatMap((worker) => [
      `deploy-staged:${worker}`, `readback-staged:${worker}`,
    ]),
    "verify-staged",
    ...["publisher", "rendezvous", "core"].flatMap((worker) => [
      `deploy-active:${worker}`, `readback-active:${worker}`,
    ]),
    "final",
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
