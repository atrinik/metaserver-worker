import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  activeVersionId,
  deliveryDecision,
  executeOrderedStages,
  parseVersionMessage,
  validateContract,
  validateLiveControlPlane,
  validateRemoteMigrations,
  validateSecretCohort,
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
      /alternate production URL|state or trigger authority|Service Binding drift/u,
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

test("version annotations bind source, deployable input, control plane, and role", () => {
  const source = "a".repeat(40);
  const deploy = "b".repeat(64);
  const control = "c".repeat(64);
  assert.deepEqual(
    parseVersionMessage(
      `atrinik-delivery-v1 source=${source} deploy=${deploy} control=${control} role=core`,
    ),
    { source, deploy, control, role: "core" },
  );
  assert.equal(
    parseVersionMessage(
      `atrinik-delivery-v1 source=${source} deploy=${deploy} control=${control} role=unknown`,
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
    buildUuid: "build-1",
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
    { accountId: "0" },
    { currentMain: "c".repeat(40) },
  ])
    assert.throws(
      () => validateSourceCoordinates({ ...valid, ...changed }),
      /restricted|invalid|does not match|dirty|missing|superseded/u,
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

test("no-op requires one coherent active topology and control drift needs exact approval", () => {
  const source = "a".repeat(40);
  const plan = {
    deploy: "d".repeat(64),
    controls: ["1".repeat(64), "2".repeat(64), "3".repeat(64)],
  };
  const annotations = ["core", "publisher", "rendezvous"].map(
    (role, index) => ({
      source,
      deploy: plan.deploy,
      control: plan.controls[index],
      role,
    }),
  );
  assert.equal(deliveryDecision(annotations, plan, source, "routine"), "no-op");
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

test("requires distinct matching source-tag secrets across core and callers", () => {
  const core = {
    SOURCE_TAG_KEY_CURRENT: "current",
    SOURCE_TAG_KEY_PREVIOUS: "previous",
  };
  assert.doesNotThrow(() => validateSecretCohort(core, { ...core }));
  for (const edge of [
    { ...core, SOURCE_TAG_KEY_CURRENT: "other" },
    { ...core, SOURCE_TAG_KEY_PREVIOUS: "other" },
  ])
    assert.throws(
      () => validateSecretCohort(core, edge),
      /secret cohort is mismatched/u,
    );
  const duplicated = {
    SOURCE_TAG_KEY_CURRENT: "same",
    SOURCE_TAG_KEY_PREVIOUS: "same",
  };
  assert.throws(
    () => validateSecretCohort(duplicated, duplicated),
    /secret cohort is mismatched/u,
  );
});
