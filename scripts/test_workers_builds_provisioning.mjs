import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  automaticReviewEnvironmentSpec,
  automaticReviewTriggerSpec,
  materializeProductionConfigurations,
  productionEnvironmentSpec,
  productionTriggerSpec,
  validateAutomaticReviewEnvironment,
  validateBuildTokenInventory,
  validateCheckedInProvisioning,
  validateConfiguredBuildsSnapshot,
  validateNoDeployHooks,
  validateProductionControlPlane,
  validateTriggerSnapshot,
} from "./workers-builds-provisioning.mjs";
import { validateBuildEnvironment } from "./production-delivery.mjs";

const root = resolve(import.meta.dirname, "..");
const production = JSON.parse(await readFile(resolve(root,
  "deployment/workers-builds-production.json"), "utf8"));
const review = JSON.parse(await readFile(resolve(root,
  "deployment/workers-builds-review.json"), "utf8"));
const bases = await Promise.all([
  "wrangler.jsonc", "wrangler.publisher.jsonc", "wrangler.rendezvous.jsonc",
].map(async (path) => JSON.parse(await readFile(resolve(root, path), "utf8"))));
const accountId = "a".repeat(32);
const scriptTag = "b".repeat(32);
const reviewScriptTag = "d".repeat(32);
const resourceUuid = "11111111-1111-4111-8111-111111111111";
const reviewTriggerUuid = "22222222-2222-4222-8222-222222222222";
const reviewTokenUuid = "33333333-3333-4333-8333-333333333333";

function envelope(result) {
  return { success: true, result };
}

function bindings(config) {
  return [
    ...Object.entries(config.vars ?? {}).map(([name, text]) => ({ name, type: "plain_text", text:
      name === "DIRECTORY_CACHE_ZONE_ID" ? "c".repeat(32) : text })),
    ...(config.secrets?.required ?? []).map((name) => ({ name, type: "secret_text" })),
    ...(config.d1_databases ?? []).map(({ binding: name }) => ({
      name, type: "d1", id: resourceUuid, database_id: resourceUuid,
    })),
    ...(config.r2_buckets ?? []).map(({ binding: name, bucket_name }) => ({
      name, type: "r2_bucket", bucket_name,
    })),
    ...(config.analytics_engine_datasets ?? []).map(({ binding: name, dataset }) => ({
      name, type: "analytics_engine", dataset,
    })),
    ...(config.ratelimits ?? []).map(({ name, namespace_id, simple }) => ({
      name, type: "ratelimit", namespace_id, simple,
    })),
    ...(config.durable_objects?.bindings ?? []).map(({ name, class_name }) => ({
      name, type: "durable_object_namespace", class_name, namespace_id: resourceUuid,
    })),
    ...(config.services ?? []).map(({ binding: name, service, entrypoint }) => ({
      name, type: "service", service, entrypoint, environment: "production",
    })),
  ];
}

function snapshot(config) {
  return {
    settings: envelope({ compatibility_date: config.compatibility_date,
      compatibility_flags: config.compatibility_flags ?? [], bindings: bindings(config),
      observability: config.observability }),
    subdomain: envelope({ enabled: false, previews_enabled: false }),
    schedules: envelope({ schedules: (config.triggers?.crons ?? []).map((cron) => ({ cron })) }),
    scriptSettings: envelope({ logpush: null, tail_consumers: [] }),
  };
}

function triggerCoordinates() {
  return { externalScriptId: scriptTag, repositoryConnectionUuid: resourceUuid,
    buildTokenUuid: resourceUuid };
}

function withConnection(spec) {
  return { ...structuredClone(spec), trigger_uuid: resourceUuid, deleted_on: null,
    repo_connection: {
    repo_connection_uuid: spec.repo_connection_uuid, provider_type: "github",
    provider_account_id: "6371603", provider_account_name: "atrinik",
    repo_id: "1324297032", repo_name: "metaserver-worker",
  } };
}

function buildTokenInventory() {
  return envelope([
    { build_token_name: "Atrinik production build", build_token_uuid: resourceUuid,
      cloudflare_token_id: "production-token-id", owner_type: "user" },
    { build_token_name: "Atrinik review build", build_token_uuid: reviewTokenUuid,
      cloudflare_token_id: "review-token-id", owner_type: "user" },
  ]);
}

test("accepts the checked-in provisioning composition", async () => {
  assert.equal((await validateCheckedInProvisioning()).production.productionBranch, "main");
});

test("materializes bounded production documents only from live private coordinates", () => {
  const snapshots = bases.map(snapshot);
  const configurations = materializeProductionConfigurations({
    contract: production, bases, snapshots, accountId,
  });
  assert.equal(configurations[0].account_id, accountId);
  assert.equal(configurations[0].d1_databases[0].database_id, resourceUuid);
  assert.equal(configurations[0].vars.DIRECTORY_CACHE_ZONE_ID, "c".repeat(32));
  assert.deepEqual(configurations[1].routes,
    [{ pattern: "publish.meta.atrinik.org", custom_domain: true }]);
  assert.deepEqual(configurations[2].routes,
    [{ pattern: "rendezvous.meta.atrinik.org", custom_domain: true }]);
  assert.equal(configurations[0].vars.PUBLISH_ENABLED, "disabled");

  for (const mutate of [
    (values) => values[0].subdomain.result.enabled = true,
    (values) => values[0].settings.result.bindings = values[0].settings.result.bindings
      .filter(({ name }) => name !== "SOURCE_TAG_KEY_CURRENT"),
    (values) => one(values[0].settings.result.bindings, "DB").id = "not-a-uuid",
    (values) => one(values[1].settings.result.bindings, "COORDINATOR").service = "atrinik-metaserver-wrong",
    (values) => values[0].settings.result.compatibility_date = "2026-08-04",
  ]) {
    const changed = structuredClone(snapshots);
    mutate(changed);
    assert.throws(() => materializeProductionConfigurations({
      contract: production, bases, snapshots: changed, accountId,
    }));
  }
});

function one(values, name) {
  return values.find((value) => value.name === name);
}

test("validates production domains, schedules, and observability boundaries", () => {
  const snapshots = bases.map(snapshot);
  const configurations = materializeProductionConfigurations({
    contract: production, bases, snapshots, accountId,
  });
  const domains = envelope([
    { hostname: "publish.meta.atrinik.org", service: "atrinik-metaserver-publisher" },
    { hostname: "rendezvous.meta.atrinik.org", service: "atrinik-metaserver-rendezvous" },
    { hostname: "unrelated.example", service: "unrelated" },
  ]);
  assert.doesNotThrow(() => validateProductionControlPlane({
    contract: production, configurations, snapshots, domains,
  }));
  const changed = structuredClone(snapshots);
  changed[0].settings.result.observability.logs.destinations = ["external"];
  assert.throws(() => validateProductionControlPlane({
    contract: production, configurations, snapshots: changed, domains,
  }), /observability destination/u);
});

test("pins production and build-only review trigger shapes", () => {
  const productionSpec = productionTriggerSpec(production, triggerCoordinates());
  const reviewSpec = automaticReviewTriggerSpec(review, triggerCoordinates());
  assert.deepEqual(productionSpec.branch_includes, ["main"]);
  assert.deepEqual(productionSpec.path_includes, ["*"]);
  assert.deepEqual(reviewSpec.branch_includes, ["*"]);
  assert.deepEqual(reviewSpec.branch_excludes, ["main", "review-build-only-sentinel"]);
  assert.doesNotThrow(() => validateTriggerSnapshot(withConnection(productionSpec),
    productionSpec, "production"));
  assert.doesNotThrow(() => validateTriggerSnapshot(withConnection(reviewSpec),
    reviewSpec, "review"));
  const changed = withConnection(reviewSpec);
  changed.branch_excludes = [];
  assert.throws(() => validateTriggerSnapshot(changed, reviewSpec, "review"), /branch_excludes/u);
  assert.throws(() => productionTriggerSpec(production, {
    ...triggerCoordinates(), externalScriptId: resourceUuid,
  }), /script tag/u);
});

test("pins exact secret classifications and bounded values", () => {
  const values = Object.fromEntries(Object.values(production.protectedInputs)
    .map((name) => [name, `${name}-value`]));
  const desired = productionEnvironmentSpec(production, values);
  assert.equal(desired.SKIP_DEPENDENCY_INSTALL.is_secret, false);
  for (const name of Object.values(production.protectedInputs))
    assert.equal(desired[name].is_secret, true);
  const readback = structuredClone(desired);
  for (const name of Object.values(production.protectedInputs)) readback[name].value = null;
  assert.doesNotThrow(() => validateBuildEnvironment(production, readback));
  delete values[production.protectedInputs.coreConfigVariable];
  assert.throws(() => productionEnvironmentSpec(production, values), /missing/u);
});

test("keeps the automatic review build environment value-only and exact", () => {
  const expected = automaticReviewEnvironmentSpec(review);
  assert.deepEqual(expected, { SKIP_DEPENDENCY_INSTALL: { is_secret: false, value: "1" } });
  assert.doesNotThrow(() => validateAutomaticReviewEnvironment({
    SKIP_DEPENDENCY_INSTALL: { ...expected.SKIP_DEPENDENCY_INSTALL,
      created_on: "2026-08-15T08:00:00Z" },
  }, review));
  assert.throws(() => validateAutomaticReviewEnvironment({ ...expected,
    UNREVIEWED: { is_secret: true, value: null } }, review), /inventory/u);
  assert.throws(() => validateAutomaticReviewEnvironment({
    SKIP_DEPENDENCY_INSTALL: { ...expected.SKIP_DEPENDENCY_INSTALL,
      created_on: "not-a-timestamp" },
  }, review), /bootstrap/u);
});

test("proves one serialized production trigger and one isolated review trigger", () => {
  const productionSpec = withConnection(productionTriggerSpec(production, triggerCoordinates()));
  const reviewSpec = withConnection(automaticReviewTriggerSpec(review, {
    externalScriptId: reviewScriptTag,
    repositoryConnectionUuid: resourceUuid,
    buildTokenUuid: reviewTokenUuid,
  }));
  reviewSpec.trigger_uuid = reviewTriggerUuid;
  const values = Object.fromEntries(Object.values(production.protectedInputs)
    .map((name) => [name, `${name}-value`]));
  const productionEnvironment = productionEnvironmentSpec(production, values);
  for (const name of Object.values(production.protectedInputs))
    productionEnvironment[name].value = null;
  const automaticEnvironment = automaticReviewEnvironmentSpec(review);
  const result = validateConfiguredBuildsSnapshot({
    production,
    review,
    scripts: envelope([
      { id: production.workers[0].name, tag: scriptTag },
      { id: review.automaticReview.project, tag: reviewScriptTag },
    ]),
    productionTriggers: envelope([productionSpec]),
    productionEnvironment: envelope(productionEnvironment),
    reviewTriggers: envelope([reviewSpec]),
    reviewEnvironment: envelope(automaticEnvironment),
    buildTokens: buildTokenInventory(),
    nonEntrypointTriggers: production.workers.slice(1)
      .map(({ role }) => [role, envelope([])]),
    deployHooks: [...production.workers.map(({ role }) => role), "review"]
      .map((label) => [label, envelope([])]),
  });
  assert.equal(result.mutation, false);

  assert.throws(() => validateConfiguredBuildsSnapshot({
    production,
    review,
    scripts: envelope([
      { id: production.workers[0].name, tag: scriptTag },
      { id: review.automaticReview.project, tag: reviewScriptTag },
    ]),
    productionTriggers: envelope([productionSpec]),
    productionEnvironment: envelope(productionEnvironment),
    reviewTriggers: envelope([reviewSpec]),
    reviewEnvironment: envelope(automaticEnvironment),
    buildTokens: buildTokenInventory(),
    nonEntrypointTriggers: [["publisher", envelope([productionSpec])],
      ["rendezvous", envelope([])]],
    deployHooks: [...production.workers.map(({ role }) => role), "review"]
      .map((label) => [label, envelope([])]),
  }), /independent Builds trigger/u);
  assert.throws(() => validateConfiguredBuildsSnapshot({
    production, review, scripts: envelope([
      { id: production.workers[0].name, tag: scriptTag },
      { id: review.automaticReview.project, tag: reviewScriptTag },
    ]),
    productionTriggers: envelope([productionSpec]),
    productionEnvironment: envelope(productionEnvironment),
    reviewTriggers: envelope([reviewSpec]),
    reviewEnvironment: envelope(automaticEnvironment),
    buildTokens: buildTokenInventory(),
    nonEntrypointTriggers: [], deployHooks: [],
  }), /inventory is incomplete/u);
  assert.throws(() => validateBuildTokenInventory(envelope([
    { ...buildTokenInventory().result[0], build_token_uuid: reviewTokenUuid },
  ]), [resourceUuid, reviewTokenUuid]), /missing or ambiguous/u);
  assert.throws(() => validateNoDeployHooks(envelope([{ deploy_hook_uuid: resourceUuid }]),
    "production"), /Deploy Hook/u);
});
