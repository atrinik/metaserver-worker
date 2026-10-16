import { retirementFixture, retirementAfter, retirementSelectedIdentity } from "./fixtures/caller-retirement.mjs";
import { callerRetirementDigest, createCallerRetirementReader, createCallerRetirementPatch, retireCallerSecrets, observeSecretFreeCaller } from "./production-caller-retirement.mjs";
import { retirementBaseline } from "./fixtures/caller-retirement.mjs";
import { createRetirementCohortGuard } from "./production-retirement-cohort.mjs";
import { createProductionReadPacer } from "./production-read-pacing.mjs";
import { virtualClock } from "./production-test-clock.mjs";
import { callerObservationFailureDiagnostic, retirementFailureDiagnostic } from "./production-retirement-diagnostics.mjs";
import { fixtureQualification } from "./fixtures/retirement-qualification.mjs";
const retirementQualification = await fixtureQualification();
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  activeVersionId,
  fenceDeliveryMutation,
  assertCoherentTopology,
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
  verifyRetiredCallerReadback,
  verifyRetirementPeerUploadPreservation,
  verifyBootstrapCallerPredecessor,
  describeSubprocessFailure,
  deliveryDecision,
  directoryReconciliationProxyConfiguration,
  validateDirectoryReconciliationProof,
  DIRECTORY_RECONCILIATION_BUDGET_SECONDS,
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
  selectProductionCanaries,
  selectApiHandoffRoles,
  completeCallerRetirement,
  acceptCallerRetirement,
  verifyCallerActivationHandoff,
  sanitizedChildEnvironment,
  validateDeliveryContract,
  runDelivery,
  validateLiveControlPlane,
  validateProtectedDocument,
  validateRemoteMigrations,
  validateRuntimeExports,
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
    resolve(root, "deployment/workers-builds-production.json"),
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

test("accepts the checked-in production contract and topology", async () => {
  await assert.doesNotReject(validateDeliveryContract(contract));
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

test("bootstraps SQLite only when the host lacks sqlite3", () => {
  const command = packageJson.scripts["test:admin"];
  assert.match(command, /import sqlite3/u);
  assert.match(command, /sqlite3\.connect\(':memory:'\)/u);
  assert.match(command, /python3 -m pip install/u);
  assert.match(command, /scripts\/requirements\/sqlite\.txt/u);
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

test("scrubs provider overrides and credentials from every child", () => {
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

test("artifact runtime authority never reaches application or provider subprocesses", () => {
  const privateRuntime = { ACTIONS_RUNTIME_TOKEN: "artifact-only-token",
    ACTIONS_RESULTS_URL: "https://artifact-runtime.invalid/", ACTIONS_RUNTIME_URL: "https://runtime.invalid/",
    ATRINIK_PRODUCTION_RECOVERY_PUBLIC_KEY: "public-recipient-but-parent-only" };
  for (const policy of ["public", "deployment", "directory-reconciliation"])
    assert.deepEqual(childEnvironment(privateRuntime, policy), {});
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

test("verified API predecessors enable handoff with or without retained annotations", () => {
  const workers = [{ role: "core" }, { role: "publisher" }, { role: "rendezvous" }];
  const live = workers.map(() => ({
    serviceEnvironment: { script: { last_deployed_from: "api" } },
  }));
  const sourceSha = "a".repeat(40);
  const message = role => `atrinik-delivery-v1 source=${sourceSha} deploy=${"b".repeat(64)} migration=${"c".repeat(64)} horizon=16 control=${"d".repeat(64)} role=${role} phase=staged`;
  const annotations = workers.map(({ role }) => parseLiveVersionMessage(message(role), role));
  for (const retained of [annotations, [null, null, null], [null, annotations[1], null],
    annotations.map(value => ({ ...value, phase: "active" }))]) {
    assert.deepEqual([...selectApiHandoffRoles(workers, live, retained, { bootstrap: true })],
      retained[0] === null ? ["core", "publisher", "rendezvous"] : ["publisher", "rendezvous"]);
  }
  // The retained API-created caller is eligible; ordinary Wrangler and dashboard
  // predecessors must retain strict deployment arguments even with annotations.
  for (const provenance of ["wrangler", "dash", "workersci", "unknown", undefined]) {
    const changed = structuredClone(live);
    changed[0].serviceEnvironment.script.last_deployed_from = provenance;
    changed[2].serviceEnvironment.script.last_deployed_from = provenance;
    for (const retained of [annotations, [null, null, null]]) {
      const roles = selectApiHandoffRoles(workers, changed, retained, { bootstrap: true });
      assert.deepEqual([...roles], ["publisher"]);
      for (const worker of workers) {
        const args = wranglerDeployArguments({ configPath: `/tmp/${worker.role}.jsonc`,
          sourceSha, message: message(worker.role), strict: !roles.has(worker.role) });
        assert.equal(args.includes("--strict"), worker.role !== "publisher");
      }
    }
  }
  assert.deepEqual([...selectApiHandoffRoles(workers, live, annotations)], []);
  assert.deepEqual([...selectApiHandoffRoles(workers, live, [null, null, null])],
    ["core", "publisher", "rendezvous"]);
  assert.throws(
    () => selectApiHandoffRoles(workers.slice(0, 1), live, [null]),
    /inventory is invalid/u,
  );
  for (const invalid of [{}, undefined, { ...annotations[1], role: "core" }]) {
    assert.throws(
      () => selectApiHandoffRoles(workers, live, [annotations[0], invalid, annotations[2]], { bootstrap: true }),
      /annotation role mismatch/u,
    );
  }
  assert.throws(
    () => selectApiHandoffRoles(workers, live, workers.map(({ role }) =>
      parseLiveVersionMessage(role === "publisher" ? "atrinik-delivery-v1 malformed" : message(role), role))),
    /annotation is malformed/u,
  );
});

const retiredCallerVersion = "11111111-1111-4111-8111-111111111111";

test("only fully verified caller retirement admits a new API handoff", async () => {
  for (const role of ["publisher", "rendezvous"]) {
    for (const failure of [null, "retire", "confirm", "verify"]) {
      const fixture = await retirementFixture({ role, versionId: retiredCallerVersion });
      const apiHandoffRoles = new Set();
      const events = [];
      const step = name => {
        assert.equal(apiHandoffRoles.has(role), false);
        events.push(name);
        if (failure === name) throw new Error(`failed ${name}`);
      };
      const complete = () => completeCallerRetirement({ role, apiHandoffRoles,
        scope: fixture.scope, selectedIdentity: fixture.selectedIdentity,
        retire: async () => { step("retire"); return fixture.retire(); },
        confirm: () => { step("confirm"); },
        verify: async () => { step("verify"); return { versionId: retiredCallerVersion }; },
      });
      if (failure) await assert.rejects(complete, new RegExp(`failed ${failure}`));
      else await complete();
      assert.deepEqual(events, ["retire", "confirm", "verify"].slice(0,
        failure ? ["retire", "confirm", "verify"].indexOf(failure) + 1 : 3));
      assert.equal(apiHandoffRoles.has(role), failure === null);
      for (const candidate of ["core", "publisher", "rendezvous"]) {
        const args = wranglerDeployArguments({ configPath: "/tmp/worker.jsonc",
          sourceSha: "a".repeat(40), message: "staged delivery",
          strict: !apiHandoffRoles.has(candidate) });
        assert.equal(args.includes("--strict"), failure !== null || candidate !== role);
      }
    }
  }
  let called = false;
  const unexpected = () => { called = true; };
  await assert.rejects(() => completeCallerRetirement({ role: "core",
    retire: unexpected, confirm: unexpected, verify: unexpected, apiHandoffRoles: new Set() }),
  /retirement role is invalid/u);
  assert.equal(called, false);
});

test("retirement activation strictness follows both verified provenance fields", async () => {
  for (const role of ["publisher", "rendezvous"]) {
    for (const selectedBeforeStaging of [false, true]) {
      for (const [service, resource, valid] of [
        ["api", "api", true], ["wrangler", "wrangler", true],
        ["api", "wrangler", false], ["wrangler", "api", false],
        [undefined, undefined, false], ["dash", "dash", false],
      ]) {
        const fixture = await retirementFixture({ role, provenance: valid ? service : "api", versionId: retiredCallerVersion });
        const apiHandoffRoles = new Set(selectedBeforeStaging ? [role] : []);
        const events = [];
        const complete = () => completeCallerRetirement({ role, apiHandoffRoles,
          scope: fixture.scope, selectedIdentity: fixture.selectedIdentity,
          retire: async () => {
            events.push("retire");
            const result = await fixture.retire();
            result.snapshot.control.environment.script.last_deployed_from = service;
            result.snapshot.resources.script.last_deployed_from = resource;
            return result;
          },
          confirm: () => { events.push("confirm"); },
          verify: async () => { events.push("verify"); return { versionId: retiredCallerVersion }; },
        });
        if (!valid) {
          await assert.rejects(complete, /retirement snapshot changed after receipt/u);
          assert.equal(apiHandoffRoles.has(role), selectedBeforeStaging);
        } else {
          await complete();
          const args = wranglerDeployArguments({ configPath: "/tmp/worker.jsonc",
            sourceSha: "a".repeat(40), message: "active delivery",
            strict: !apiHandoffRoles.has(role) });
          assert.equal(args.includes("--strict"), service !== "api");
        }
        assert.deepEqual(events, valid ? ["retire", "confirm", "verify"] : ["retire"]);
      }
    }
  }
});

test("post-retirement provenance rejection preserves consumed mutation diagnostics", async () => {
  const secret = "private provider account/token/path";
  for (const role of ["publisher", "rendezvous"]) {
    for (const resourceSource of [undefined, "wrangler", secret]) {
      const fixture = await retirementFixture({ role, versionId: retiredCallerVersion });
      const apiHandoffRoles = new Set();
      const events = [];
      let failure;
      try {
        await completeCallerRetirement({ role, apiHandoffRoles,
          scope: fixture.scope, selectedIdentity: fixture.selectedIdentity,
          retire: async () => {
            const result = await fixture.retire();
            events.push("retirement-receipt-verified");
            result.snapshot.resources.script.last_deployed_from = resourceSource;
            return result;
          },
          confirm: () => { events.push("confirm"); },
          verify: async () => { events.push("fence-and-readback"); return { versionId: retiredCallerVersion }; },
        });
        events.push("activate");
      } catch (error) { failure = error; }
      assert(failure);
      assert.deepEqual(events, ["retirement-receipt-verified"]);
      assert.deepEqual([...apiHandoffRoles], []);
      const evidence = { sourceSha: "a".repeat(40), deployableDigest: "b".repeat(64),
        failedRole: `retirement:${role}`, completedRoles: ["staged:core"], recoveryOutcome: "proven" };
      const record = deliveryFailureRecord(failure, evidence);
      assert.deepEqual(record, { ...evidence, outcome: "production-delivery-stopped",
        reason: "API handoff retirement snapshot changed after receipt",
        retirement: { phase: "postverify", category: "verification-failed", mutationState: "response-accepted" } });
      assert.equal(JSON.stringify(record).includes(secret), false);
    }
  }
});

test("retirement handoff rejects replacement versions despite identical staged configuration", async () => {
  const replacementVersion = "22222222-2222-4222-8222-222222222222";
  for (const role of ["publisher", "rendezvous"]) {
    for (const source of ["api", "wrangler"]) {
      for (const [retiredVersion, freshVersion] of [
        [retiredCallerVersion, retiredCallerVersion], [retiredCallerVersion, replacementVersion],
        [retiredCallerVersion, undefined], [retiredCallerVersion, "malformed"],
      ]) {
        const fixture = await retirementFixture({ role, provenance: source, versionId: retiredVersion });
        const apiHandoffRoles = new Set();
        let activated = false;
        const annotations = { "workers/tag": "a".repeat(40), "workers/message": "same staged message" };
        const resources = { script: { last_deployed_from: source }, bindings: [] };
        const evidence = { sourceSha: "a".repeat(40), deployableDigest: null,
          failedRole: `retirement:${role}`, completedRoles: ["staged:core"], recoveryOutcome: "proven" };
        let failure;
        try {
          await completeCallerRetirement({ role, apiHandoffRoles,
            scope: fixture.scope, selectedIdentity: fixture.selectedIdentity,
            retire: fixture.retire,
            confirm: () => {},
            verify: async () => freshVersion === undefined ? undefined :
              { versionId: freshVersion, version: { annotations, resources } },
          });
          activated = true;
        } catch (error) { failure = error; }
        const valid = retiredVersion === retiredCallerVersion && freshVersion === retiredCallerVersion;
        assert.equal(activated, valid);
        assert.equal(apiHandoffRoles.has(role), valid && source === "api");
        if (!valid) {
          assert(failure);
          assert.deepEqual(deliveryFailureRecord(failure, evidence), {
            ...evidence, outcome: "production-delivery-stopped",
            reason: "API handoff retirement version changed or is missing",
            retirement: { phase: "postverify", category: "verification-failed", mutationState: "response-accepted" },
          });
        }
      }
    }
  }
});

test("orchestrator rechecks the retired caller version immediately before activation", async () => {
  const workers = ["core", "publisher", "rendezvous"].map(role => ({ role }));
  const noop = async () => {};
  for (const provenance of ["api", "wrangler"]) {
    for (const replaced of [false, true]) {
      const fixture = await retirementFixture({ provenance, versionId: retiredCallerVersion });
      const proofs = new Map(), apiHandoffRoles = new Set(), uploads = [], events = [];
      let retirements = 0;
      const active = { versionId: retiredCallerVersion, message: "same staged message", bindings: [] };
      const run = () => orchestrateDelivery({ workers, decision: "deploy", fence: noop,
        deployStaged: async worker => {
          if (replaced && worker.role === "rendezvous")
            active.versionId = "22222222-2222-4222-8222-222222222222";
        },
        readbackStaged: async worker => {
          if (worker.role !== "publisher") return;
          const proof = await completeCallerRetirement({ role: worker.role, apiHandoffRoles,
            scope: fixture.scope, selectedIdentity: fixture.selectedIdentity,
            retire: async () => { retirements++; return fixture.retire(); },
            confirm: () => {}, verify: async () => ({ ...active }),
          });
          assert(Object.isFrozen(proof));
          proofs.set(worker.role, proof);
        },
        verifyStaged: async () => { assert.equal(active.message, "same staged message"); },
        deployActive: async worker => {
          if (worker.role !== "publisher") return;
          const apiHandoff = await verifyCallerActivationHandoff({ role: worker.role,
            proof: proofs.get(worker.role), scope: fixture.scope, selectedIdentity: fixture.selectedIdentity,
            verify: async () => { events.push("fresh-version"); return { ...active }; },
            authorize: async () => { events.push("authorize"); },
          });
          uploads.push(wranglerDeployArguments({ configPath: "/tmp/publisher.jsonc",
            sourceSha: "a".repeat(40), message: "active", strict: !apiHandoff }));
          events.push("upload");
        },
        readbackActive: noop, verifyFinal: noop, reconcileDirectories: noop, canaries: noop, recover: noop,
      });
      if (replaced) {
        await assert.rejects(run, /activation version changed or is missing/u);
        assert.deepEqual(uploads, []);
        assert.deepEqual(events, ["fresh-version"]);
      } else {
        await run();
        assert.equal(uploads[0].includes("--strict"), provenance !== "api");
        assert.deepEqual(events, ["fresh-version", "authorize", "upload"]);
      }
      assert.equal(retirements, 1);
    }
  }
});

test("orchestrator preserves consumed retirement diagnostics after completion barriers fail", async () => {
  const workers = ["core", "publisher", "rendezvous"].map(role => ({ role }));
  const noop = async () => {};
  for (const boundary of ["confirm", "fence", "readback"]) {
    const fixture = await retirementFixture({ versionId: retiredCallerVersion });
    const apiHandoffRoles = new Set();
    let uploads = 0, failure;
    const secret = "private provider payload";
    const stop = name => { if (boundary === name) throw new Error(secret); };
    try {
      await orchestrateDelivery({ workers, decision: "deploy", fence: noop, deployStaged: noop,
        readbackStaged: async worker => {
          if (worker.role !== "publisher") return;
          await completeCallerRetirement({ role: worker.role, apiHandoffRoles,
            scope: fixture.scope, selectedIdentity: fixture.selectedIdentity, retire: fixture.retire,
            confirm: () => stop("confirm"),
            verify: async () => { stop("fence"); stop("readback"); },
          });
        },
        verifyStaged: noop, deployActive: async () => { uploads++; }, readbackActive: noop,
        verifyFinal: noop, reconcileDirectories: noop, canaries: noop, recover: noop,
      });
    } catch (error) { failure = error; }
    assert(failure);
    assert.equal(uploads, 0);
    assert.deepEqual([...apiHandoffRoles], []);
    const record = deliveryFailureRecord(failure, { completedRoles: [] });
    assert.deepEqual(record.retirement, { phase: "postverify", category: "verification-failed", mutationState: "response-accepted" });
    assert.equal(record.reason, "unexpected-internal-error");
    assert.equal(JSON.stringify(record).includes(secret), false);
  }
});

test("completion does not rebrand a failed retirement or run later barriers", async () => {
  const { markRetirementFailure } = await import("./production-retirement-diagnostics.mjs");
  const error = markRetirementFailure(new Error("private transport error"), "patch", "dispatched-outcome-unknown");
  const unexpected = () => assert.fail("retirement rejection must stop completion");
  await assert.rejects(() => completeCallerRetirement({ role: "publisher", apiHandoffRoles: new Set(),
    retire: async () => { throw error; }, confirm: unexpected, verify: unexpected,
  }), failure => failure === error);
  assert.deepEqual(deliveryFailureRecord(error, { completedRoles: [] }).retirement,
    { phase: "patch", category: "verification-failed", mutationState: "dispatched-outcome-unknown" });
});

test("retirement completion and activation reject forged, cross-role and cross-run capability", async () => {
  const fixture = await retirementFixture({ versionId: retiredCallerVersion });
  const result = await fixture.retire();
  const handoff = await completeCallerRetirement({ role: "publisher", scope: fixture.scope,
    selectedIdentity: fixture.selectedIdentity, apiHandoffRoles: new Set(), retire: async () => result,
    confirm: () => {}, verify: async proof => { assert.equal(proof, result.proof); return { versionId: retiredCallerVersion }; } });
  for (const change of [
    x => { x.proof = structuredClone(handoff); },
    x => { x.proof = { ...handoff, retirementProof: structuredClone(result.proof) }; },
    x => { x.role = "rendezvous"; x.proof = { ...handoff, role: "rendezvous" }; },
    x => { x.scope = Object.freeze({}); },
    x => { x.selectedIdentity = { ...fixture.selectedIdentity, runId: "2" }; },
    x => { x.selectedIdentity = { ...fixture.selectedIdentity, runAttempt: "2" }; },
  ]) {
    const input = { role: "publisher", proof: handoff, scope: fixture.scope,
      selectedIdentity: fixture.selectedIdentity,
      verify: () => assert.fail("invalid proof must stop before readback"),
      authorize: () => assert.fail("invalid proof must stop before authorization") };
    change(input);
    await assert.rejects(() => verifyCallerActivationHandoff(input), /capability invalid/u);
  }
  for (const change of [
    value => { value.versionId = "22222222-2222-4222-8222-222222222222"; },
    value => { value.provenance = "wrangler"; },
  ]) {
    const altered = { ...handoff };
    change(altered);
    let reads = 0, authorizations = 0;
    const input = { role: "publisher", proof: altered, scope: fixture.scope,
      selectedIdentity: fixture.selectedIdentity,
      verify: async () => { reads++; return { versionId: altered.versionId }; },
      authorize: async () => { authorizations++; } };
    await assert.rejects(() => verifyCallerActivationHandoff(input), /activation receipt identity changed/u);
    assert.equal(reads, 0);
    assert.equal(authorizations, 0);
  }
  for (const proof of [undefined, structuredClone(result.proof)]) {
    await assert.rejects(() => completeCallerRetirement({ role: "publisher", scope: fixture.scope,
      selectedIdentity: fixture.selectedIdentity, apiHandoffRoles: new Set(),
      retire: async () => ({ ...result, proof }),
      confirm: () => assert.fail("invalid proof must stop completion"), verify: () => assert.fail("invalid proof must stop readback") }),
    /capability invalid/u);
  }
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
  // The temporary retired-caller exception never applies to final active state.
  for (const index of [1, 2]) {
    for (const field of ["source", "deploy", "migration", "migrationHorizon", "control", "role", "phase"]) {
      const incomplete = structuredClone(annotations);
      delete incomplete[index][field];
      assert.throws(() => assertCoherentTopology(incomplete, plan, source), /not one coherent/u);
    }
    const annotationless = structuredClone(annotations);
    annotationless[index] = null;
    assert.throws(() => assertCoherentTopology(annotationless, plan, source), /not one coherent/u);
  }
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

test("accepts only bounded protected documents", () => {
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

test("retirement failure evidence emits only branded closed diagnostics alongside the existing reason", async () => {
  const { retireCallerSecrets } = await import("./production-caller-retirement.mjs");
  const { createProductionReadPacer } = await import("./production-read-pacing.mjs");
  const paced = createProductionReadPacer({ fetcher: async () => new Response("private provider text", { status: 429 }) });
  let cause;
  const noop = async () => {};
  try { await retireCallerSecrets({ qualification: retirementQualification, role: "publisher", fence: () => paced(`https://api.cloudflare.com/client/v4/accounts/${"a".repeat(32)}/workers/scripts`),
    read: noop, verifyStaged: noop, patch: noop, recordIntent: noop, recordReceipt: noop, authorize: noop }); }
  catch (error) { cause = error; }
  const evidence = { sourceSha: null, deployableDigest: null, failedRole: "retirement:publisher", completedRoles: [], recoveryOutcome: "failed" };
  const record = deliveryFailureRecord(new Error("private wrapper", { cause }), evidence);
  assert.equal(record.reason, "unexpected-internal-error");
  assert.deepEqual(record.retirement, { phase: "initial-fence", category: "rate-limited", mutationState: "not-invoked", readTransportState: "response-received", httpStatus: 429 });
  assert.equal(JSON.stringify(record).includes("private"), false);
  assert.equal(deliveryFailureRecord({ retirement: record.retirement }, evidence).retirement, undefined);
});

test("branded preflight failures expose only their fixed reason, never a reflected message", async () => {
  const { brandDeliveryFailure } = await import("./delivery-failure-reasons.mjs");
  const secret = "private account/token/path";
  const evidence = { sourceSha: null, deployableDigest: null, failedRole: "preflight", completedRoles: [], recoveryOutcome: "not-needed" };
  const branded = brandDeliveryFailure(new Error(secret), "delivery-resource-policy-rejected");
  assert.equal(deliveryFailureRecord(branded, evidence).reason, "delivery-resource-policy-rejected");
  assert.equal(deliveryFailureRecord(new Error(secret, { cause: branded }), evidence).reason, "delivery-resource-policy-rejected");
  assert.equal(deliveryFailureRecord(new Error(branded.message), evidence).reason, "unexpected-internal-error");
  assert.equal(JSON.stringify(deliveryFailureRecord(branded, evidence)).includes(secret), false);
  assert.throws(() => brandDeliveryFailure(new Error(secret), secret), TypeError);
});

test("nested artifact retention failure exposes only its branded fixed reason", async () => {
  const { verifyRecoveryArtifactProof } = await import("./production-recovery-artifacts.mjs");
  const secret = "private account/token/path";
  const context = { repository: "atrinik/metaserver-worker", runId: "1", runAttempt: "1",
    controllerSha: "a".repeat(40), sourceSha: "b".repeat(40), deployableDigest: "c".repeat(64) };
  let branded;
  try { verifyRecoveryArtifactProof({ artifactId: 1, artifactName: secret, archiveDigest: "d".repeat(64),
    context, now: () => 1000, metadata: { id: 1, name: secret, expired: false, digest: `sha256:${"d".repeat(64)}`,
      workflow_run: { id: 1, head_sha: context.controllerSha }, created_at: new Date(1000).toISOString(),
      expires_at: new Date(1000 + 89 * 86400000).toISOString() } }); } catch (error) { branded = error; }
  assert(branded);
  const evidence = { sourceSha: context.sourceSha, deployableDigest: context.deployableDigest,
    failedRole: "retirement:publisher", completedRoles: ["staged:core"], recoveryOutcome: "disabled-core-proven" };
  const error = new Error(secret, { cause: new Error(secret, { cause: branded }) });
  assert.deepEqual(deliveryFailureRecord(error, evidence), { outcome: "production-delivery-stopped",
    reason: "recovery-artifact-effective-retention-rejected", ...evidence });
  assert.equal(deliveryFailureRecord(new Error(branded.message), evidence).reason, "unexpected-internal-error");
  assert.equal(JSON.stringify(deliveryFailureRecord(error, evidence)).includes(secret), false);
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


test("public canaries skip profiles still staged under a canary alias prefix", () => {
  const scenarioConfigs = configs.map((value) => structuredClone(value));
  for (const [classic, game, expected] of [
    ["v4-production", "v1-production", ["publisher-service-binding", "rendezvous-service-binding"]],
    ["v6-production", "v1-production", ["classic-static-directory", "publisher-service-binding", "rendezvous-service-binding"]],
    ["v6-production", "v2-production", contract.productionCanaries.map(({ name }) => name)],
  ]) {
    scenarioConfigs[0].vars.CLASSIC_DIRECTORY_CUTOVER_MODE = classic;
    scenarioConfigs[0].vars.GAME_DIRECTORY_CUTOVER_MODE = game;
    const selected = selectProductionCanaries(contract, scenarioConfigs);
    assert.deepEqual(selected.map(({ name }) => name), expected);
    for (const { command } of selected) {
      const prefix = command.indexOf("--alias-prefix");
      assert.ok(prefix === -1 || command[prefix + 1] === "");
    }
  }
  scenarioConfigs[0].vars.GAME_DIRECTORY_CUTOVER_MODE = "unknown";
  assert.throws(() => selectProductionCanaries(contract, scenarioConfigs), /cutover policy drift/u);
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
  const authorityEnvironment = proxyEnvironment();
  const child = childEnvironment({ ...authorityEnvironment,
    ATRINIK_PRODUCTION_CORE_CONFIG: "private",
    WRANGLER_CI_MATCH_TAG: "test-core-tag", WRANGLER_CI_OVERRIDE_NAME: "atrinik-metaserver",
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
  assert.equal(validateDirectoryReconciliationProof(directoryProof(core, now), core,
    now - DIRECTORY_RECONCILIATION_BUDGET_SECONDS, now).schema, "directory-reconciliation-v1");
  assert.throws(() => validateDirectoryReconciliationProof(proof, core,
    now - DIRECTORY_RECONCILIATION_BUDGET_SECONDS - 1, now), /freshness/u);
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
    changed.provider = "cloudflare-workers-builds";
    await assert.rejects(validateDeliveryContract(changed), /contract drift/u);
    assert.equal(live.invariants.migrationPolicy, "exact-ledger-no-automatic-apply");
  }
  await assert.rejects(validateDeliveryContract({ ...contract, target: "review" }), /contract drift/u);
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
  const environment = { GITHUB_TOKEN: "github-secret", ATRINIK_DELIVERY_ENVIRONMENT: "production",
    ATRINIK_DELIVERY_SOURCE_ROOT: "/selected", ATRINIK_PRODUCTION_CORE_CONFIG: "private-config" };
  for (const policy of ["public", "deployment"]) assert.deepEqual(childEnvironment(environment, policy), {});
  assert.deepEqual(childEnvironment(environment, "directory-reconciliation"), {
    GITHUB_TOKEN: "github-secret", ATRINIK_DELIVERY_ENVIRONMENT: "production",
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

// Exercise the actual transport projection and staged callback together. Earlier
// reader tests supplied publisher settings for every peer and mocked this proof.
function secretFreeObservationFixture(role) {
  const production = productionConfigs().map((config, index) =>
    disabledCircuitConfiguration(config, contract.workers[index].role));
  const configurations = [...production, ...production.map(developmentFixture)];
  const sourceSha = "c".repeat(40), module = "export default{}";
  const bundleDigest = createHash("sha256").update(module).digest("hex");
  const rows = configurations.map((config, index) => {
    const worker = contract.workers[index % 3], value = retirementBaseline(worker.role === "core" ? "publisher" : worker.role);
    const uuid = `00000000-0000-0000-0000-${String(index + 1).padStart(12, "0")}`;
    value.name = config.name;
    value.tag = String(index + 1).repeat(32);
    value.activeVersion = value.latestVersion = value.deploymentId = uuid;
    value.settings.annotations["workers/message"] = `atrinik-delivery-v1 source=${sourceSha} deploy=${"b".repeat(64)} migration=${"b".repeat(64)} horizon=16 control=${"b".repeat(64)} role=${worker.role} phase=staged`;
    value.versionAnnotations = structuredClone(value.settings.annotations);
    const bindings = [
      ...Object.entries(config.vars).map(([name, text]) => ({ name, type: "plain_text", text })),
      ...(config.secrets?.required ?? []).map(name => ({ name, type: "secret_text" })),
      ...(config.services ?? []).map(({ binding: name, ...rest }) => ({ name, type: "service", ...rest })),
      ...(config.ratelimits ?? []).map(rest => ({ type: "ratelimit", ...rest })),
      ...(config.d1_databases ?? []).map(({ binding: name, database_id: id }) => ({ name, type: "d1", id })),
      ...(config.r2_buckets ?? []).map(({ binding: name, bucket_name }) => ({ name, type: "r2_bucket", bucket_name })),
      ...(config.analytics_engine_datasets ?? []).map(({ binding: name, dataset }) => ({ name, type: "analytics_engine", dataset })),
      ...(config.durable_objects?.bindings ?? []).map(({ name, class_name }) => ({ name, type: "durable_object_namespace", class_name })),
    ];
    value.settings.bindings = bindings;
    value.settings.compatibility_date = config.compatibility_date;
    value.resources.bindings = structuredClone(bindings);
    value.resources.script_runtime = { compatibility_date: config.compatibility_date,
      compatibility_flags: config.compatibility_flags, exports: config.exports ?? {} };
    const environment = value.control.environment;
    environment.script_tag = environment.script.tag = value.tag;
    environment.script.id = config.name;
    environment.script.compatibility_date = config.compatibility_date;
    environment.script.compatibility_flags = config.compatibility_flags;
    environment.script.observability = config.observability;
    value.control.subdomain = { enabled: false, previews_enabled: false };
    value.control.schedules = { schedules: (config.triggers?.crons ?? []).map(cron => ({ cron })) };
    value.control.domains = (config.routes ?? []).filter(row => row.custom_domain).map(({ pattern: hostname }, i) =>
      ({ id: `${index}-${i}`, hostname, enabled: true, previews_enabled: false, zone_id: "b".repeat(32), zone_name: "atrinik.org" }));
    delete value.peers; delete value.capturedAt; delete value.accountId;
    return value;
  });
  const namespaces = [], modules = new Map(rows.map(row => [row.name, module]));
  const target = rows.find(row => row.name === `atrinik-metaserver-${role}`);
  const index = role === "publisher" ? 1 : 2;
  const fetcher = async (url, options) => {
    assert.equal(options.method, "GET");
    assert.equal(options.headers.Authorization, "Bearer fixture-resource-read");
    const parsed = new URL(url), suffix = parsed.pathname.split(`/accounts/${production[0].account_id}`)[1];
    let result;
    if (suffix === "/workers/scripts") result = rows.map(({ name: id, tag }) => ({ id, tag }));
    else if (suffix.endsWith("/namespaces")) return Response.json({ success: true, result: namespaces,
      result_info: { page: 1, per_page: 1000, total_count: namespaces.length, count: namespaces.length } });
    else {
      const name = suffix === "/workers/domains" ? parsed.searchParams.get("service") : suffix.split("/")[3];
      const row = rows.find(row => row.name === name);
      assert.ok(row, suffix);
      if (suffix.endsWith("/content/v2")) {
        const form = new FormData();
        form.append("index.js", new Blob([modules.get(row.name)], { type: "application/javascript+module" }), "index.js");
        return new Response(form, { headers: { etag: `"${row.code.etag}"` } });
      }
      if (suffix.endsWith("/settings")) result = row.settings;
      else if (suffix.endsWith("/deployments")) result = { deployments: [{ id: row.deploymentId,
        versions: [{ version_id: row.activeVersion, percentage: 100 }] }] };
      else if (suffix.endsWith("/versions")) result = { items: [{ id: row.activeVersion }] };
      else if (suffix.endsWith(`/versions/${row.activeVersion}`)) result = { id: row.activeVersion,
        annotations: row.versionAnnotations, resources: row.resources };
      else if (suffix.endsWith("/routes")) result = row.control.routes;
      else if (suffix.endsWith("/domains")) result = row.control.domains;
      else if (suffix.endsWith("/schedules")) result = row.control.schedules;
      else if (suffix.endsWith("/subdomain")) result = row.control.subdomain;
      else if (suffix.endsWith("/environments/production")) result = row.control.environment;
      else assert.fail(suffix);
    }
    return Response.json({ success: true, result });
  };
  return { rows, target, namespaces, modules, fetcher, accountId: production[0].account_id,
    worker: contract.workers[index], config: production[index], sourceSha, bundleDigest,
    expectedMessage: target.settings.annotations["workers/message"] };
}

// Keep the real paced double-snapshot reader, staged proof and one-use PATCH
// transport in this composition. Only provider responses and durable storage
// are synthetic; the post-write fence alone exceeds the old handoff lifetime.
async function retirementAcceptanceFixture(t, role) {
  const fixture = secretFreeObservationFixture(role), clock = virtualClock();
  t.mock.method(AbortSignal, "timeout", ms => clock.timeout(ms));
  const now = () => 1000 + clock.now(), events = [], artifacts = [], starts = [];
  const scope = Object.freeze({});
  const cohort = createRetirementCohortGuard({ accountId: fixture.accountId, scope });
  const selectedIdentity = { ...retirementSelectedIdentity(fixture.target),
    bundleDigest: fixture.bundleDigest, configurationDigest: callerRetirementDigest(fixture.config) };
  for (const field of ["settings", "resources"]) fixture.target[field].bindings.push(
    ...["SOURCE_TAG_KEY_CURRENT", "SOURCE_TAG_KEY_PREVIOUS"].map(name => ({ name, type: "secret_text" })));
  let reads = 0, writes = 0, fences = 0, durable = false, request;
  const fetcher = createProductionReadPacer({ ...clock, fetcher: async (...args) => {
    starts.push(clock.now()); return fixture.fetcher(...args);
  } });
  const providerRead = createCallerRetirementReader({ accountId: fixture.accountId,
    token: "fixture-resource-read", role, fetcher, now });
  const read = async () => { events.push(`read:${++reads}`); return providerRead(); };
  const qualification = await fixtureQualification({ accountId: fixture.accountId });
  const patch = createCallerRetirementPatch({ accountId: fixture.accountId, token: "fixture-write", role,
    qualification, fetcher: async (_url, options) => {
      assert.equal(options.method, "PATCH");
      assert.deepEqual(JSON.parse(options.body), { secrets: { SOURCE_TAG_KEY_CURRENT: null, SOURCE_TAG_KEY_PREVIOUS: null } });
      events.push("patch"); writes++;
      Object.assign(fixture.target, retirementAfter(fixture.target));
      fixture.target.activeVersion = fixture.target.latestVersion = fixture.target.deploymentId =
        "00000000-0000-0000-0000-000000000099";
      return Response.json({ success: true, result: {} });
    } });
  const options = { role, scope, selectedIdentity, now, qualification, read,
    patch: async value => { request = structuredClone(value); return patch(value); },
    fence: async () => { events.push(`fence:${++fences}`); await clock.wait(18370); },
    authorize: async () => { events.push("authorize"); },
    verifyStaged: (snapshot, { retired, predecessor }) => {
      if (!retired) cohort.check(snapshot);
      return verifyStagedCallerRetirement({ ...fixture, snapshot, retired, predecessor, expectedZoneId: "b".repeat(32) });
    },
    recordIntent: async value => { assert.equal(artifacts.length, 0); artifacts.push(structuredClone(value)); events.push("intent"); },
    recordReceipt: async value => {
      assert.equal(artifacts.length, 1); artifacts.push(structuredClone(value));
      events.push("receipt-start"); await clock.wait(5000); durable = true; events.push("receipt-durable");
    },
  };
  const result = await clock.run(() => retireCallerSecrets(options));
  return { ...fixture, clock, now, scope, selectedIdentity, cohort, result, events, artifacts, starts,
    get reads() { return reads; }, get writes() { return writes; }, get fences() { return fences; },
    accept: (overrides = {}) => clock.run(() => acceptCallerRetirement({ result, cohort, role, scope, selectedIdentity, now,
      read: async () => { assert.equal(durable, true); return read(); }, ...overrides })),
    replay: () => patch(request),
  };
}

for (const role of ["publisher", "rendezvous"]) test(`actual paced ${role} retirement accepts a distinct post-receipt read without renewing evidence`, async t => {
  const f = await retirementAcceptanceFixture(t, role);
  const original = JSON.stringify({ snapshot: f.result.snapshot, receipt: f.result.receipt, artifacts: f.artifacts });
  const proof = f.result.proof, capturedAt = f.result.snapshot.capturedAt;
  assert.ok(f.now() - capturedAt >= 23370);
  assert.throws(() => f.cohort.acceptRetirement({ snapshot: f.result.snapshot, proof, role,
    selectedIdentity: f.selectedIdentity, now: f.now }), /observation expired/u);
  const accepted = await f.accept();
  assert.equal(accepted, f.result);
  assert.equal(accepted.proof, proof);
  assert.equal(JSON.stringify({ snapshot: accepted.snapshot, receipt: accepted.receipt, artifacts: f.artifacts }), original);
  assert.equal(f.reads, 4); assert.equal(f.fences, 3); assert.equal(f.writes, 1);
  assert.deepEqual(f.events, ["fence:1", "read:1", "intent", "fence:2", "read:2", "authorize",
    "patch", "read:3", "fence:3", "receipt-start", "receipt-durable", "read:4"]);
  assert.ok(f.starts.length > 400);
  assert.ok(f.starts.slice(1).every((at, index) => at - f.starts[index] >= 334));
  await assert.rejects(f.replay, /consumed/u);
  assert.equal(f.writes, 1); assert.equal(f.artifacts.length, 2);
});

test("post-receipt provider drift rejects before teaching an initially empty cohort", async t => {
  for (const [name, change] of [
    ["own metadata", f => { f.target.resources.script.unexpected = true; }],
    ["own module bytes", f => { f.modules.set(f.target.name, "export default{changed:true}"); }],
    ["own UUID", f => { f.target.activeVersion = f.target.latestVersion = f.target.deploymentId = "00000000-0000-0000-0000-000000000098"; }],
    ["own controls", f => { f.target.control.environment.script.observability.enabled = false; }],
    ["peer metadata", f => { f.rows[0].resources.script.unexpected = true; }],
    ["peer code", f => { f.rows[0].code.etag = f.rows[0].resources.script.etag = "d".repeat(64); }],
    ["peer graph", f => { f.rows.pop(); }],
    ["namespaces", f => { f.namespaces.push({ id: "d".repeat(32), name: "unexpected", class: "Unexpected", script: "atrinik-metaserver" }); }],
  ]) await t.test(name, async st => {
    const f = await retirementAcceptanceFixture(st, "rendezvous");
    const original = JSON.stringify({ snapshot: f.result.snapshot, receipt: f.result.receipt, artifacts: f.artifacts });
    change(f);
    await assert.rejects(f.accept, error => {
      assert.deepEqual(retirementFailureDiagnostic(error), {
        phase: "postverify", category: "verification-failed", mutationState: "response-accepted",
      });
      return true;
    });
    assert.equal(JSON.stringify({ snapshot: f.result.snapshot, receipt: f.result.receipt, artifacts: f.artifacts }), original);
    assert.equal(f.writes, 1); assert.equal(f.artifacts.length, 2);
    // Rejection cannot establish a baseline: a deliberately changed graph is
    // still unchecked until a separate successful retirement is admitted.
    const probe = structuredClone(f.result.snapshot); probe.peers.namespaces.push({ id: "probe" });
    assert.equal(f.cohort.check(probe), true);
  });
});

test("post-receipt acceptance still compares the current cohort after binding the receipt graph", async t => {
  const f = await retirementAcceptanceFixture(t, "publisher");
  const read = createCallerRetirementReader({ accountId: f.accountId, token: "fixture-resource-read",
    role: "publisher", fetcher: f.fetcher, now: f.now });
  const current = await f.clock.run(read);
  f.cohort.acceptRetirement({ snapshot: current, proof: f.result.proof, role: "publisher",
    selectedIdentity: f.selectedIdentity, now: f.now });
  const next = structuredClone(current), peer = next.peers.workers[0];
  peer.activeVersion = peer.latestVersion = "00000000-0000-0000-0000-000000000098";
  f.cohort.recordUpload({ name: peer.name, versionId: peer.activeVersion,
    validate: value => callerRetirementDigest(value) === callerRetirementDigest(peer) });
  f.cohort.check(next);
  // The unchanged receipt graph has become an old cohort; a fresh capture alone
  // must not re-adopt it or consume any new mutation.
  await assert.rejects(f.accept, /retirement cohort identity changed/u);
  assert.equal(f.writes, 1); assert.equal(f.artifacts.length, 2);
});

test("post-receipt handoff preserves freshness and capability rejection without another PATCH", async t => {
  const f = await retirementAcceptanceFixture(t, "publisher");
  const providerRead = createCallerRetirementReader({ accountId: f.accountId, token: "fixture-resource-read",
    role: "publisher", fetcher: f.fetcher, now: f.now });
  const original = JSON.stringify({ snapshot: f.result.snapshot, receipt: f.result.receipt, artifacts: f.artifacts });
  let reads = 0;
  for (const overrides of [
    { scope: Object.freeze({}) },
    { role: "rendezvous" },
    { selectedIdentity: { ...f.selectedIdentity, sourceSha: "d".repeat(40) } },
    { result: { ...f.result, proof: structuredClone(f.result.proof) } },
    { result: { ...f.result, snapshot: { ...f.result.snapshot, capturedAt: f.now() } } },
  ]) await assert.rejects(() => f.accept({ read: async () => { reads++; return providerRead(); }, ...overrides }));
  assert.equal(reads, 0);
  await assert.rejects(() => f.accept({ read: async () => {
    const current = await providerRead(); await f.clock.wait(10001); return current;
  } }), /observation expired/u);
  assert.equal(JSON.stringify({ snapshot: f.result.snapshot, receipt: f.result.receipt, artifacts: f.artifacts }), original);
  assert.equal(f.writes, 1); assert.equal(f.artifacts.length, 2);
});

for (const role of ["publisher", "rendezvous"]) test(`actual paced ${role} observation composes full reader and staged proof`, async t => {
  const fixture = secretFreeObservationFixture(role), clock = virtualClock();
  t.mock.method(AbortSignal, "timeout", ms => clock.timeout(ms));
  const now = () => 1000 + clock.now(), events = [];
  const fetcher = createProductionReadPacer({ ...clock, fetcher: fixture.fetcher });
  const read = createCallerRetirementReader({ accountId: fixture.accountId, token: "fixture-resource-read", role, fetcher, now });
  const cohort = createRetirementCohortGuard({ accountId: fixture.accountId, scope: Object.freeze({}) });
  const result = await clock.run(() => observeSecretFreeCaller({ role, read, now,
    fence: async () => { events.push("fence"); await clock.wait(15000); },
    verifyStaged: (snapshot, { retired, predecessor }) => {
      events.push("staged-proof");
      cohort.check(snapshot);
      assert.equal(snapshot.activeVersion, fixture.target.activeVersion);
      return verifyStagedCallerRetirement({ ...fixture, snapshot, retired, predecessor, expectedZoneId: "b".repeat(32) });
    } }));
  assert.equal(result.observation.status, "observed-new-disabled-secret-free-caller");
  assert.equal(result.snapshot.peers.workers.length, 5);
  assert.equal(result.observation.retirementArtifacts, 0);
  assert.deepEqual(events, ["fence", "staged-proof", "fence"]);
});

for (const role of ["publisher", "rendezvous"])
  test(`actual ${role} observation rejects reader, snapshot and selected-proof drift`, async t => {
    const cases = [
      ["source", fixture => { fixture.target.settings.annotations["workers/tag"] = "d".repeat(40);
        fixture.target.versionAnnotations = structuredClone(fixture.target.settings.annotations); }],
      ["setting/version mismatch", fixture => { fixture.target.versionAnnotations["workers/message"] += " changed"; }],
      ["service timestamp", fixture => { fixture.target.control.environment.script.modified_on = "2999-01-01T00:00:00.000Z"; }],
      ["configuration", fixture => { for (const field of ["settings", "resources"])
        fixture.target[field].bindings.find(row => row.name === "ROUTE_DISABLED_RETRY_SECONDS").text = "999"; }],
      ["control", fixture => { fixture.target.control.subdomain.enabled = true; }],
      ["bundle", fixture => { fixture.bundleDigest = "f".repeat(64); }],
      ["uploaded version", fixture => { fixture.target.activeVersion = fixture.target.latestVersion = "99999999-9999-9999-9999-999999999999"; }],
      ["partial graph", fixture => { fixture.rows.pop(); }],
    ];
    for (const [name, change] of cases) {
      const fixture = secretFreeObservationFixture(role), uploadedVersion = fixture.target.activeVersion;
      change(fixture);
      const clock = virtualClock();
      t.mock.method(AbortSignal, "timeout", ms => clock.timeout(ms));
      const now = () => 1000 + clock.now(), events = [];
      const fetcher = createProductionReadPacer({ ...clock, fetcher: fixture.fetcher });
      const read = createCallerRetirementReader({ accountId: fixture.accountId, token: "fixture-resource-read", role, fetcher, now });
      const cohort = createRetirementCohortGuard({ accountId: fixture.accountId, scope: Object.freeze({}) });
      await assert.rejects(clock.run(() => observeSecretFreeCaller({ role, read, now,
        fence: async () => events.push("fence"),
        verifyStaged: (snapshot, { retired, predecessor }) => {
          cohort.check(snapshot);
          assert.equal(snapshot.activeVersion, uploadedVersion);
          return verifyStagedCallerRetirement({ ...fixture, snapshot, retired, predecessor, expectedZoneId: "b".repeat(32) });
        } })), error => {
        const stage = ["setting/version mismatch", "partial graph"].includes(name) ? "read" :
          ["source", "service timestamp"].includes(name) ? "snapshot-proof" : "staged-proof";
        assert.deepEqual(callerObservationFailureDiagnostic(error), { phase: "staged-observation", stage,
          category: "verification-failed", mutationState: "not-invoked" }, name);
        assert.equal(retirementFailureDiagnostic(error), null, name);
        return true;
      });
      assert.deepEqual(events, ["fence"], name);
      t.mock.restoreAll();
    }
  });

test("retirement peer upload permits only the closed selected caller delta", async () => {
  for (const index of [1, 2]) {
    const role = contract.workers[index].role;
    const config = disabledCircuitConfiguration(productionConfigs()[index], role);
    assert(Object.keys(config.vars).length > 0);
    assert(config.services.length > 0);
    assert(config.ratelimits.length > 0);
    const fixture = await retirementFixture({ role });
    const previous = fixture.before;
    previous.deploymentId = "00000000-0000-0000-0000-000000000003";
    previous.settings.compatibility_flags = ["nodejs_compat"];
    previous.settings.observability = structuredClone(previous.control.environment.script.observability);
    previous.settings.tail_consumers = [];
    previous.settings.logpush = false;
    previous.settings.assets = { enabled: false };
    previous.resources.script_runtime = { compatibility_date: "2026-10-01", compatibility_flags: ["nodejs_compat"], exports: {} };
    previous.control.routes = [{ id: "existing-route", pattern: "existing.example.invalid/*", script: config.name }];
    const current = structuredClone(previous);
    const versionId = "33333333-3333-4333-8333-333333333333";
    const sourceSha = "4".repeat(40), bundleDigest = "5".repeat(64);
    const expectedMessage = `selected staged ${role} upload`;
    current.activeVersion = current.latestVersion = current.deploymentId = versionId;
    current.code = { etag: "6".repeat(64), modules: [{ name: "worker.js", type: "application/javascript+module", sha256: bundleDigest, bytes: 256 }] };
    current.settings.annotations = { "workers/tag": sourceSha, "workers/message": expectedMessage, "workers/triggered_by": "version_upload" };
    current.versionAnnotations = structuredClone(current.settings.annotations);
    current.settings.bindings = [
      ...Object.entries(config.vars).map(([name, text]) => ({ name, type: "plain_text", text })),
      ...config.services.map(({ binding, ...value }) => ({ name: binding, ...value, type: "service", environment: "production" })),
      ...config.ratelimits.map(value => ({ ...value, type: "ratelimit" })),
    ];
    current.resources.bindings = structuredClone(current.settings.bindings);
    current.settings.compatibility_date = config.compatibility_date;
    current.settings.compatibility_flags = structuredClone(config.compatibility_flags);
    current.settings.observability = structuredClone(config.observability);
    Object.assign(current.resources.script_runtime, { compatibility_date: config.compatibility_date,
      compatibility_flags: config.compatibility_flags, exports: config.exports ?? {} });
    Object.assign(current.resources.script, { etag: current.code.etag, last_deployed_from: "wrangler" });
    current.control.environment.modified_on = "1970-01-01T00:00:01.500Z";
    Object.assign(current.control.environment.script, { modified_on: "1970-01-01T00:00:01.500Z",
      etag: current.code.etag, last_deployed_from: "wrangler", compatibility_date: config.compatibility_date,
      compatibility_flags: config.compatibility_flags, observability: structuredClone(config.observability) });
    const input = { previous, current, config, versionId, sourceSha, bundleDigest, expectedMessage, startedAt: 1000, capturedAt: 2000 };
    assert.equal(verifyRetirementPeerUploadPreservation(input), true);
    const unchangedTimes = structuredClone(input);
    unchangedTimes.current.control.environment.modified_on = previous.control.environment.modified_on;
    unchangedTimes.current.control.environment.script.modified_on = previous.control.environment.script.modified_on;
    assert.equal(verifyRetirementPeerUploadPreservation(unchangedTimes), true);
    // Test the two documented nonempty deployment metadata representations too.
    for (const field of ["activeVersion", "deploymentId"]) {
      const candidate = { ...input, previous: structuredClone(previous), current: structuredClone(current) };
      candidate.previous.control.environment.script.deployment_id = previous[field];
      candidate.current.control.environment.script.deployment_id = field === "activeVersion" ? versionId : current.deploymentId;
      assert.equal(verifyRetirementPeerUploadPreservation(candidate), true);
    }
    for (const change of [
      x => { x.current.settings.tail_consumers = [{ service: "unexpected" }]; },
      x => { x.current.settings.logpush = true; },
      x => { x.current.settings.assets.enabled = true; },
      x => { x.current.settings.unknown = true; },
      x => { x.current.resources.unknown = true; },
      x => { x.current.resources.script.unknown = true; },
      x => { x.current.resources.script_runtime.unknown = true; },
      x => { x.current.control.routes[0].id = "replaced-route"; },
      x => { x.current.control.routes[0].unknown = true; },
      x => { x.current.control.environment.unknown = true; },
      x => { x.current.control.environment.script.unknown = true; },
      x => { x.current.control.environment.script.created_on = "1970-01-01T00:00:01.500Z"; },
      x => { x.current.control.environment.script.deployment_id = "unbound"; },
      x => { x.current.settings.bindings[0].text += "changed"; },
      x => { x.current.resources.bindings.find(row => row.type === "service").environment = "preview"; },
      x => { x.current.resources.bindings.find(row => row.type === "ratelimit").simple.limit++; },
      x => { x.current.settings.annotations["workers/message"] += "changed"; },
      x => { x.current.versionAnnotations["workers/tag"] = "7".repeat(40); },
      x => { x.current.latestVersion = previous.activeVersion; },
      x => { x.current.activeVersion = previous.activeVersion; },
      x => { x.current.deploymentId = previous.deploymentId; },
      x => { x.current.code.modules[0].sha256 = "7".repeat(64); },
      x => { x.current.code.modules[0].unknown = true; },
      x => { x.current.code.unknown = true; },
      x => { x.current.resources.script.etag = "7".repeat(64); },
      x => { x.current.control.environment.modified_on = "1970-01-01T00:00:00.999Z"; },
      x => { x.current.control.environment.script.modified_on = "1970-01-01T00:00:02.001Z"; },
      x => { x.current.control.environment.modified_on = "invalid"; },
      x => { x.capturedAt = 999; },
      x => { x.startedAt = NaN; },
    ]) {
      const candidate = structuredClone(input);
      change(candidate);
      assert.throws(() => verifyRetirementPeerUploadPreservation(candidate));
    }
  }
});

test("retired caller readback requires receipt-bound exact configuration, modules and control", async () => {
  for (const index of [1, 2]) {
    const worker = contract.workers[index];
    const config = disabledCircuitConfiguration(productionConfigs()[index], worker.role);
    const fixture = await retirementFixture({ role: worker.role });
    const before = fixture.before;
    before.code.modules[0].name = "worker.js";
    before.settings.bindings = [
      ...Object.entries(config.vars).map(([name, text]) => ({ name, type: "plain_text", text })),
      ...config.services.map(({ binding, ...value }) => ({ ...value, name: binding, type: "service" })),
      ...config.ratelimits.map(value => ({ ...value, type: "ratelimit" })),
      ...["SOURCE_TAG_KEY_CURRENT", "SOURCE_TAG_KEY_PREVIOUS"].map(name => ({ name, type: "secret_text" })),
    ];
    before.resources.bindings = structuredClone(before.settings.bindings);
    before.resources.script_runtime = { compatibility_date: config.compatibility_date,
      compatibility_flags: config.compatibility_flags, exports: config.exports ?? {} };
    const plane = liveControlPlane(index);
    Object.assign(before.control, { routes: plane.routes, domains: plane.customDomains,
      subdomain: plane.subdomainStatus, schedules: plane.cronTriggers });
    Object.assign(before.control.environment.script, plane.serviceEnvironment.script);
    const after = retirementAfter(before);
    after.resources.script.last_deployed_from = after.control.environment.script.last_deployed_from = "api";
    fixture.selectedIdentity.configurationDigest = callerRetirementDigest(config);
    let reads = 0;
    fixture.options.read = async () => structuredClone(++reads < 3 ? before : after);
    const result = await fixture.retire();
    const input = { worker, config, snapshot: result.snapshot, proof: result.proof,
      scope: fixture.scope, selectedIdentity: fixture.selectedIdentity, now: () => 1000,
      expectedMessage: before.settings.annotations["workers/message"], expectedZoneId: "b".repeat(32) };
    const identity = verifyRetiredCallerReadback(input);
    assert.equal(identity.versionId, after.activeVersion);
    assert.equal(identity.predecessorIdentity.role, worker.role);
    assert.deepEqual(result.snapshot.settings.annotations, { "workers/triggered_by": "secret" });
    for (const change of [
      x => { x.config.vars.ROUTE_DISABLED_RETRY_SECONDS = "299"; },
      x => { x.snapshot.code.modules[0].sha256 = "9".repeat(64); },
      x => { x.snapshot.code.modules.push({ name: "other.js", sha256: "9".repeat(64), bytes: 1 }); },
      x => { x.snapshot.resources.bindings.push({ name: "UNKNOWN", type: "secret_text" }); },
      x => { x.snapshot.control.domains[0].zone_id = "c".repeat(32); },
      x => { x.snapshot.settings.annotations["workers/tag"] = before.settings.annotations["workers/tag"]; },
      x => { x.snapshot.versionAnnotations["workers/message"] = input.expectedMessage; },
      x => { x.snapshot.activeVersion = "22222222-2222-4222-8222-222222222222"; },
      x => { x.expectedMessage += "changed"; },
      x => { x.now = () => 11001; },
    ]) {
      const candidate = { ...input, config: structuredClone(config), snapshot: structuredClone(result.snapshot) };
      change(candidate);
      assert.throws(() => verifyRetiredCallerReadback(candidate));
    }
    // The ordinary staged gate still requires the original source annotations.
    assert.throws(() => verifyStagedCallerRetirement({ worker, config, snapshot: result.snapshot,
      sourceSha: fixture.selectedIdentity.sourceSha, bundleDigest: fixture.selectedIdentity.bundleDigest,
      expectedMessage: input.expectedMessage, expectedZoneId: input.expectedZoneId, retired: true }), /module identity drift|annotation drift/u);
  }
});

test("old caller code and key-ID authority remain pinned until that role's staging handoff", async () => {
  const worker = { role: "publisher", secrets: ["SOURCE_TAG_KEY_CURRENT", "SOURCE_TAG_KEY_PREVIOUS"],
    variables: [{ binding: "SOURCE_TAG_KEY_CURRENT_ID", value: "old-a" },
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

test("mutation fence proves resource, authority and source before mutation", async () => {
  const events = [], sourceSha = "a".repeat(40);
  const authority = { sourceSha, fence: async () => { events.push("authority"); } };
  await fenceDeliveryMutation(authority, async () => events.push("resource"), async () => {
    events.push("source"); return { head: sourceSha, dirty: false };
  });
  events.push("mutation");
  assert.deepEqual(events, ["resource", "authority", "source", "mutation"]);
});
for (const drift of ["resource", "authority", "source", "dirty"])
  test(`${drift} drift stops mutation and disabled recovery`, async () => {
    for (const recovery of [false, true]) {
      let mutations = 0;
      const sourceSha = "a".repeat(40);
      const authority = { sourceSha, fence: async () => {
        if (drift === "authority") throw new Error("authority drift");
      } };
      const fence = () => fenceDeliveryMutation(authority, async () => {
        if (drift === "resource") throw new Error("resource drift");
      }, async () => ({ head: drift === "source" ? "b".repeat(40) : sourceSha, dirty: drift === "dirty" }));
      if (recovery) {
        await assert.rejects(recoverDisabledCore({ coreStaged: true, fence,
          deployStaged: async () => { mutations++; }, readActive: async () => {}, validateStaged: async () => {} }));
      } else await assert.rejects(async () => { await fence(); mutations++; });
      assert.equal(mutations, 0);
    }
  });
test("a no-op still refreshes authority before private reconciliation", async () => {
  let calls = 0, reconciliations = 0;
  const sourceSha = "a".repeat(40);
  const authority = { sourceSha, fence: async () => { calls++; throw new Error("authority drift"); } };
  await assert.rejects(orchestrateDelivery({ decision: "no-op", workers: [],
    fence: () => fenceDeliveryMutation(authority, async () => {}, async () => ({ head: sourceSha, dirty: false })),
    verifyFinal: async () => {}, reconcileDirectories: async () => { reconciliations++; },
    canaries: async () => {}, recover: async () => assert.fail("no-op recovery") }));
  assert.equal(calls, 1);
  assert.equal(reconciliations, 0);
});

for (const drift of ["head", "dirty"]) test(`default Git source reader rejects ${drift} changes before mutation`, async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "atrinik-fence-source-"));
  const git = (...args) => {
    const result = spawnSync("/usr/bin/git", ["-C", directory, "-c", "core.hooksPath=/dev/null",
      "-c", "commit.gpgsign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args],
    { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  try {
    git("init", "--quiet");
    await writeFile(resolve(directory, "tracked"), "first"); git("add", "tracked"); git("commit", "--quiet", "-m", "first");
    const first = git("rev-parse", "HEAD");
    await writeFile(resolve(directory, "tracked"), "second"); git("commit", "--quiet", "-am", "second");
    const second = git("rev-parse", "HEAD"); git("checkout", "--quiet", first);
    const bin = resolve(directory, "bin"); await mkdir(bin);
    // Exercise the default reader against an isolated real Git repository.
    await writeFile(resolve(bin, "git"), `#!${process.execPath}
const { spawnSync } = require("node:child_process");
process.exit(spawnSync("/usr/bin/git", ["-C", ${JSON.stringify(directory)}, ...process.argv.slice(2)], { stdio: "inherit" }).status);
`, { mode: 0o700 });
    git("add", "bin/git"); git("commit", "--quiet", "-m", "fixture wrapper");
    const selected = git("rev-parse", "HEAD");
    const script = `
      import assert from "node:assert/strict";
      import { writeFileSync } from "node:fs";
      import { execFileSync } from "node:child_process";
      import { fenceDeliveryMutation } from ${JSON.stringify(new URL("./production-delivery.mjs", import.meta.url).href)};
      let mutated = false;
      const authority = { sourceSha: ${JSON.stringify(selected)}, fence: async options => {
        if (options?.allowDrain === false) return { waited: false };
        ${drift === "head" ? `execFileSync("/usr/bin/git", ["-C", ${JSON.stringify(directory)}, "update-ref", "HEAD", ${JSON.stringify(second)}]);`
          : `writeFileSync(${JSON.stringify(resolve(directory, "tracked"))}, "changed during drain");`}
        return { waited: true };
      } };
      await assert.rejects(async () => { await fenceDeliveryMutation(authority, async () => {}); mutated = true; }, /source checkout drift/);
      assert.equal(mutated, false);
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      env: { PATH: bin }, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("empty caller predecessor binds exact disabled configuration and approved version", () => {
  for (const index of [1, 2]) {
    const role = contract.workers[index].role;
    const config = disabledCircuitConfiguration(productionConfigs()[index], role);
    const worker = { role, secrets: [], variables: Object.entries(config.vars).map(([binding, value]) => ({ binding, value })) };
    const active = { versionId: "00000000-0000-0000-0000-000000000001", version: { resources: {
      bindings: [...Object.entries(config.vars).map(([name, text]) => ({ name, type: "plain_text", text })),
        ...config.services.map(({ binding, ...value }) => ({ ...value, name: binding, type: "service" })),
        ...config.ratelimits.map(value => ({ ...value, type: "ratelimit" }))],
      script_runtime: { compatibility_date: config.compatibility_date, compatibility_flags: config.compatibility_flags,
        exports: config.exports ?? {} },
    } } };
    verifyBootstrapCallerPredecessor(active.versionId, worker, active, { config });
    for (const change of [
      a => { a.versionId = "different"; },
      a => { a.version.resources.script_runtime.compatibility_date = "2020-01-01"; },
      a => { a.version.resources.script_runtime.compatibility_flags.push("unapproved"); },
      a => { a.version.resources.bindings.push({ name: "SOURCE_TAG_KEY_CURRENT", type: "secret_text" }); },
      a => { a.version.resources.bindings.push({ name: "OTHER", type: "secret_text" }); },
      a => { a.version.resources.bindings.push({ name: "SOURCE_TAG_KEY_CURRENT_ID", type: "plain_text", text: "old" }); },
      a => { a.version.resources.bindings.find(b => b.name === (role === "publisher" ? "PUBLISH_ENABLED" : "RENDEZVOUS_ENABLED")).text = "enabled"; },
      a => { a.version.resources.bindings.find(b => b.type === "service").entrypoint = "Other"; },
    ]) {
      const changed = structuredClone(active); change(changed);
      assert.throws(() => verifyBootstrapCallerPredecessor(active.versionId, worker, changed, { config }));
    }
    assert.throws(() => verifyBootstrapCallerPredecessor(active.versionId, worker, active));
  }
});
