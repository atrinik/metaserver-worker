// Copyright (C) 2026 Atrinik contributors
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
]);
const origins = Object.freeze({
  "https://classic.meta.atrinik.org": "https://classic.dev.meta.atrinik.org",
  "https://meta.atrinik.org": "https://game.dev.meta.atrinik.org",
  "https://publish.meta.atrinik.org": "https://publish.dev.meta.atrinik.org",
  "https://rendezvous.meta.atrinik.org": "https://rendezvous.dev.meta.atrinik.org",
});
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
