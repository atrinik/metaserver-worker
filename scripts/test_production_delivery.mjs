import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  activeVersionId,
  assertCoherentTopology,
  deliveryFailureRecord,
  deliveryDecision,
  executeOrderedStages,
  orchestrateDelivery,
  materializeProtectedInputs,
  parseVersionMessage,
  selectBuildLeaseOwner,
  sanitizedChildEnvironment,
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
      `atrinik-delivery-v1 source=${source} deploy=${deploy} migration=${migration} control=${control} role=core`,
    ),
    { source, deploy, migration, control, role: "core" },
  );
  assert.equal(
    parseVersionMessage(
      `atrinik-delivery-v1 source=${source} deploy=${deploy} migration=${migration} control=${control} role=unknown`,
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
  assert.deepEqual(
    sanitizedChildEnvironment({
      SAFE: "retained",
      WRANGLER_CI_OVERRIDE_NAME: "atrinik-metaserver",
      WRANGLER_CI_MATCH_TAG: "core-tag",
    }),
    { SAFE: "retained" },
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
    "earlier",
  );
});

test("no-op requires one coherent active topology and control drift needs exact approval", () => {
  const source = "a".repeat(40);
  const plan = {
    deploy: "d".repeat(64),
    migrationDigest: "e".repeat(64),
    controls: ["1".repeat(64), "2".repeat(64), "3".repeat(64)],
  };
  const annotations = ["core", "publisher", "rendezvous"].map(
    (role, index) => ({
      source,
      deploy: plan.deploy,
      migration: plan.migrationDigest,
      control: plan.controls[index],
      role,
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
    deploy: async (worker) => events.push(`deploy:${worker}`),
    readback: async (worker) => events.push(`readback:${worker}`),
    verifyFinal: async () => events.push("final"),
    canaries: async () => events.push("canaries"),
    completed: (worker) => events.push(`completed:${worker}`),
  });
  assert.equal(outcome, "deployed-and-read-back");
  assert.deepEqual(events, [
    "fence", "deploy:core", "fence", "readback:core", "completed:core",
    "fence", "deploy:publisher", "fence", "readback:publisher", "completed:publisher",
    "fence", "deploy:rendezvous", "fence", "readback:rendezvous", "completed:rendezvous",
    "fence", "final", "canaries", "fence",
  ]);

  const noOpEvents = [];
  assert.equal(
    await orchestrateDelivery({
      workers,
      decision: "no-op",
      fence: async () => noOpEvents.push("fence"),
      deploy: async () => noOpEvents.push("unexpected-deploy"),
      readback: async () => noOpEvents.push("unexpected-readback"),
      verifyFinal: async () => noOpEvents.push("final"),
      canaries: async () => noOpEvents.push("canaries"),
    }),
    "no-deployment-required",
  );
  assert.deepEqual(noOpEvents, ["fence", "final", "canaries", "fence"]);
});

test("orchestrator exposes the exact safe partial prefix after every stage failure", async () => {
  const workers = ["core", "publisher", "rendezvous"];
  for (const failedRole of workers) {
    const completed = [];
    await assert.rejects(
      orchestrateDelivery({
        workers,
        decision: "deploy",
        fence: async () => {},
        deploy: async (worker) => {
          if (worker === failedRole) throw new Error("closed failure");
        },
        readback: async () => {},
        verifyFinal: async () => {},
        canaries: async () => {},
        completed: (worker) => completed.push(worker),
      }),
      /closed failure/u,
    );
    assert.deepEqual(completed, workers.slice(0, workers.indexOf(failedRole)));
  }
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
    failedRole: "core",
    completedRoles: [],
  });
  assert.equal(record.reason, "unexpected-internal-error");
  assert.equal(JSON.stringify(record).includes(secret), false);
});
