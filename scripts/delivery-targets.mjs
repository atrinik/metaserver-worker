// Copyright (C) 2026 Atrinik contributors
// The historical contract is validation evidence only, never live authority.
export const developmentWorkerNames = Object.freeze([
  "atrinik-metaserver-development",
  "atrinik-metaserver-development-publisher",
  "atrinik-metaserver-development-rendezvous",
]);
export const promotionEnvironmentNames = Object.freeze([
  "GITHUB_ACTIONS", "GITHUB_EVENT_NAME", "GITHUB_EVENT_PATH", "GITHUB_REPOSITORY",
  "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_SHA", "GITHUB_REF",
  "GITHUB_WORKFLOW_REF", "GITHUB_WORKFLOW_SHA", "GITHUB_TOKEN",
  "ATRINIK_DELIVERY_RESOURCE_POLICY", "ATRINIK_DELIVERY_RESOURCE_READ_TOKEN",
  "ATRINIK_DELIVERY_SOURCE_ROOT", "ATRINIK_DEVELOPMENT_SHA", "ATRINIK_PROMOTION_TAG", "ATRINIK_PROMOTION_SHA",
  "ATRINIK_PROMOTION_ARTIFACT_DIGEST", "ATRINIK_PROMOTION_CONFIG_DIGEST",
  "ATRINIK_PROMOTION_MIGRATION_DIGEST", "ATRINIK_PROMOTION_PREDECESSOR",
  "ATRINIK_PRODUCTION_BUILDS_READ_TOKEN", "ATRINIK_PRODUCTION_WRITER_FENCE_POLICY",
]);
const origins = Object.freeze({
  "https://classic.meta.atrinik.org": "https://classic.dev.meta.atrinik.org",
  "https://meta.atrinik.org": "https://game.dev.meta.atrinik.org",
  "https://publish.meta.atrinik.org": "https://publish.dev.meta.atrinik.org",
  "https://rendezvous.meta.atrinik.org": "https://rendezvous.dev.meta.atrinik.org",
});
export function targetContract(historical, target) {
  if (!["development", "production"].includes(target))
    throw new Error("unknown delivery target");
  const value = structuredClone(historical);
  value.schemaVersion = 2;
  value.target = target;
  if (target === "production") {
    value.provider = "github-actions";
    value.automaticPush = false;
    value.source = { kind: "immutable-release-tag", repository: "atrinik/metaserver-worker",
      workflow: "promote-production.yml", controllerBranch: "main" };
    delete value.protectedInputs.buildsApiTokenVariable;
    Object.assign(value.invariants, {
      controlPlanePolicy: "explicit-immutable-tag-promotion",
      buildSerialization: "github-actions-production-concurrency",
      noOp: "selected-source-and-matching-bundles-config-migrations",
      recovery: "disabled-circuit-fix-forward-and-fresh-tag-promotion",
    });
  } else {
    value.provider = "github-actions";
    value.source = { kind: "successful-main-check", repository: "atrinik/metaserver-worker",
      workflow: "deploy-development.yml", validationWorkflow: "check.yml", controllerBranch: "main" };
    value.invariants.buildSerialization = "github-actions-development-concurrency";
    value.deployCommand = "npm run deploy:development";
    value.reviewCommand = "npm run deploy:development:dry-run";
    for (const key of ["coreConfigVariable", "publisherConfigVariable", "rendezvousConfigVariable"])
      value.protectedInputs[key] = value.protectedInputs[key].replace("PRODUCTION", "DEVELOPMENT");
    delete value.protectedInputs.buildsApiTokenVariable;
    for (const [index, worker] of value.workers.entries()) {
      worker.name = developmentWorkerNames[index];
      worker.configuration = worker.configuration.replace("PRODUCTION", "DEVELOPMENT");
      worker.serviceBindings = worker.serviceBindings.map((name) =>
        name.replace("atrinik-metaserver#", "atrinik-metaserver-development#"));
      worker.customDomains = worker.customDomains.map((name) =>
        new URL(origins[`https://${name}`]).hostname);
    }
    value.workers[0].requiredVariables.push("DEVELOPMENT_MAINTENANCE");
    value.workers[0].state = value.workers[0].state.filter((item) => !item.startsWith("Cron:"));
    value.workers[0].state.push("DurableObject:DEVELOPMENT_MAINTENANCE_DO");
    for (const canary of value.productionCanaries)
      canary.command = canary.command.filter((argument) => argument !== "--allow-production")
        .map((argument) => origins[argument] ?? argument);
  }
  return value;
}

// Checked-in build-only fixtures use unique names and inert placeholder IDs.
// Live configuration remains a protected, separately verified provider input.
export function developmentFixture(config, index) {
  const value = structuredClone(config);
  value.name = developmentWorkerNames[index];
  if (index === 0) {
    value.main = "development/core.ts";
    value.vars.DEVELOPMENT_MAINTENANCE = "classic-development-alarms-v1";
    value.triggers.crons = [];
    value.durable_objects.bindings.push({ name: "DEVELOPMENT_MAINTENANCE_DO", class_name: "DevelopmentMaintenance" });
    value.exports.DevelopmentMaintenance = { type: "durable-object", storage: "sqlite" };
  }
  for (const binding of value.services ?? []) binding.service = developmentWorkerNames[0];
  for (const binding of value.d1_databases ?? []) binding.database_name += "-development";
  for (const binding of value.r2_buckets ?? []) binding.bucket_name += "-development";
  for (const binding of value.analytics_engine_datasets ?? []) binding.dataset += "_development";
  for (const binding of value.ratelimits ?? []) binding.namespace_id = String(Number(binding.namespace_id) + 100);
  for (const [key, item] of Object.entries(value.vars ?? {})) {
    if (origins[item]) value.vars[key] = origins[item];
    else if (origins[`https://${item}`]) value.vars[key] = new URL(origins[`https://${item}`]).hostname;
  }
  return value;
}

export function deliveryTarget(environment) {
  const target = environment.ATRINIK_DELIVERY_ENVIRONMENT;
  if (!["production", "development"].includes(target))
    throw new Error("explicit delivery environment is required");
  return target;
}
