import json
import unittest
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
WRANGLER_CONFIG = REPOSITORY_ROOT / "wrangler.jsonc"
PUBLISHER_CONFIG = REPOSITORY_ROOT / "wrangler.publisher.jsonc"
RENDEZVOUS_CONFIG = REPOSITORY_ROOT / "wrangler.rendezvous.jsonc"
DEPLOYMENT_GUIDE = REPOSITORY_ROOT / "DEPLOYMENT.md"
PACKAGE_JSON = REPOSITORY_ROOT / "package.json"


class WranglerSecurityConfigurationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.configuration = json.loads(
            WRANGLER_CONFIG.read_text(encoding="utf-8")
        )

    def test_alternate_public_worker_urls_are_disabled(self) -> None:
        self.assertIs(self.configuration.get("workers_dev"), False)
        self.assertIs(self.configuration.get("preview_urls"), False)

    def test_request_control_bindings_pin_reviewed_limits(self) -> None:
        expected_bindings = {
            "GLOBAL_RATE_LIMITER": ("1003", 10),
            "DIRECTORY_RATE_LIMITER": ("1005", 10),
            "OTP_RATE_LIMITER": ("1001", 10),
            "UPDATE_RATE_LIMITER": ("1002", 10),
            "PUBLISH_IDENTITY_RATE_LIMITER": ("1006", 2),
            "RENDEZVOUS_CLIENT_RATE_LIMITER": ("1004", 5),
            "RENDEZVOUS_SERVER_RATE_LIMITER": ("1007", 3),
        }
        bindings = self.configuration.get("ratelimits", [])
        self.assertEqual(
            {binding["name"] for binding in bindings},
            set(expected_bindings),
        )
        for binding in bindings:
            with self.subTest(binding=binding["name"]):
                namespace_id, limit = expected_bindings[binding["name"]]
                self.assertEqual(binding["namespace_id"], namespace_id)
                self.assertEqual(binding["simple"]["period"], 60)
                self.assertEqual(binding["simple"]["limit"], limit)

        self.assertEqual(
            self.configuration["vars"]["PUBLISH_ENABLED"], "disabled"
        )
        self.assertEqual(
            self.configuration["vars"]["GAME_PUBLISH_ENABLED"], "disabled"
        )
        self.assertEqual(
            self.configuration["vars"]["PUBLISH_SERVER_DAILY_LIMIT"], "48"
        )

    def test_source_tag_secrets_and_logging_policy_are_pinned(self) -> None:
        self.assertEqual(
            set(self.configuration["secrets"]["required"]),
            {"SOURCE_TAG_KEY_CURRENT", "SOURCE_TAG_KEY_PREVIOUS"},
        )
        self.assertNotIn("ALLOW_TEST_SOURCE_IP", self.configuration["vars"])
        self.assertIs(self.configuration["observability"]["enabled"], True)
        logs = self.configuration["observability"]["logs"]
        self.assertIs(logs["enabled"], True)
        self.assertEqual(logs["head_sampling_rate"], 1)
        self.assertIs(logs["invocation_logs"], False)
        self.assertEqual(
            self.configuration["triggers"]["crons"],
            ["*/5 * * * *", "17 * * * *"],
        )

    def test_rendezvous_runtime_and_metrics_bindings_are_pinned(self) -> None:
        self.assertEqual(
            self.configuration["compatibility_flags"],
            ["nodejs_compat", "no_web_socket_compression"],
        )
        self.assertEqual(
            self.configuration["analytics_engine_datasets"],
            [
                {
                    "binding": "RENDEZVOUS_METRICS",
                    "dataset": "atrinik_metaserver_rendezvous",
                },
                {
                    "binding": "DIRECTORY_METRICS",
                    "dataset": "atrinik_metaserver_directory",
                },
            ],
        )
        self.assertEqual(
            self.configuration["durable_objects"]["bindings"],
            [
                {"name": "RENDEZVOUS", "class_name": "RendezvousRoom"},
                {
                    "name": "DIRECTORY_BUILDER",
                    "class_name": "DirectoryBuilder",
                },
            ],
        )
        self.assertEqual(
            self.configuration["exports"]["RendezvousRoom"],
            {"type": "durable-object", "storage": "sqlite"},
        )
        self.assertEqual(
            self.configuration["exports"]["DirectoryBuilder"],
            {"type": "durable-object", "storage": "sqlite"},
        )
        self.assertEqual(
            self.configuration["exports"]["PublisherCoordinator"],
            {"type": "worker", "cache": {"enabled": False}},
        )
        self.assertEqual(
            self.configuration["exports"]["RendezvousCoordinator"],
            {"type": "worker", "cache": {"enabled": False}},
        )
        self.assertEqual(
            self.configuration["vars"]["DIRECTORY_REFRESH_LEAD_SECONDS"],
            "3600",
        )
        self.assertEqual(
            self.configuration["r2_buckets"],
            [
                {
                    "binding": "DIRECTORY_GENERATIONS",
                    "bucket_name": "atrinik-metaserver-directory-generations",
                },
                {
                    "binding": "CLASSIC_DIRECTORY_PUBLIC",
                    "bucket_name": "atrinik-metaserver-directory-classic",
                },
                {
                    "binding": "GAME_DIRECTORY_PUBLIC",
                    "bucket_name": "atrinik-metaserver-directory-game",
                },
            ],
        )
        self.assertEqual(
            {
                name: self.configuration["vars"][name]
                for name in (
                    "RENDEZVOUS_CLIENT_ROLLING_LIMIT",
                    "RENDEZVOUS_ACTIVE_CLIENT_LIMIT",
                    "RENDEZVOUS_CLIENT_SESSION_SECONDS",
                )
            },
            {
                "RENDEZVOUS_CLIENT_ROLLING_LIMIT": "50",
                "RENDEZVOUS_ACTIVE_CLIENT_LIMIT": "16",
                "RENDEZVOUS_CLIENT_SESSION_SECONDS": "15",
            },
        )

    def test_exports_rollout_uses_direct_deploy_only(self) -> None:
        guide = DEPLOYMENT_GUIDE.read_text(encoding="utf-8")
        self.assertNotIn("npx wrangler versions upload", guide)
        self.assertNotIn("npx wrangler versions deploy", guide)
        self.assertIn("npx wrangler deploy --strict", guide)
        self.assertIn("Durable Object exports reconciliation", guide)
        self.assertIn("rollback cannot cross the lifecycle change", guide)
        cutover = guide[guide.index("## Cut over"):]
        self.assertLess(
            cutover.index("Apply only pending ordered migrations"),
            cutover.index("atrinik-metaserver-publisher"),
        )


class DynamicServiceBoundaryConfigurationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.core = json.loads(WRANGLER_CONFIG.read_text(encoding="utf-8"))
        self.publisher = json.loads(
            PUBLISHER_CONFIG.read_text(encoding="utf-8")
        )
        self.rendezvous = json.loads(
            RENDEZVOUS_CONFIG.read_text(encoding="utf-8")
        )

    def test_service_names_mains_and_private_bindings_are_exact(self) -> None:
        self.assertEqual(self.core["name"], "atrinik-metaserver")
        self.assertEqual(self.core["main"], "src/index.ts")
        self.assertEqual(
            (self.publisher["name"], self.publisher["main"]),
            ("atrinik-metaserver-publisher", "src/publisher-worker.ts"),
        )
        self.assertEqual(
            (self.rendezvous["name"], self.rendezvous["main"]),
            ("atrinik-metaserver-rendezvous", "src/rendezvous-worker.ts"),
        )
        self.assertEqual(
            self.publisher["services"],
            [{
                "binding": "COORDINATOR",
                "service": "atrinik-metaserver",
                "entrypoint": "PublisherCoordinator",
            }],
        )
        self.assertEqual(
            self.rendezvous["services"],
            [{
                "binding": "COORDINATOR",
                "service": "atrinik-metaserver",
                "entrypoint": "RendezvousCoordinator",
            }],
        )
        self.assertEqual(
            set(self.core["exports"]),
            {
                "RendezvousRoom",
                "DirectoryBuilder",
                "PublisherCoordinator",
                "RendezvousCoordinator",
            },
        )
        self.assertNotIn("services", self.core)

    def test_compatibility_dates_and_flags_are_exact(self) -> None:
        self.assertEqual(
            {
                configuration["compatibility_date"]
                for configuration in (
                    self.core,
                    self.publisher,
                    self.rendezvous,
                )
            },
            {"2026-08-05"},
        )
        self.assertEqual(
            self.publisher["compatibility_flags"],
            ["nodejs_compat"],
        )
        self.assertEqual(
            self.rendezvous["compatibility_flags"],
            ["nodejs_compat", "no_web_socket_compression"],
        )

    def test_public_edges_have_no_state_or_cross_service_capability(self) -> None:
        allowed_top_level = {
            "$schema",
            "name",
            "main",
            "compatibility_date",
            "compatibility_flags",
            "workers_dev",
            "preview_urls",
            "services",
            "ratelimits",
            "secrets",
            "vars",
            "observability",
        }
        for name, configuration in (
            ("publisher", self.publisher),
            ("rendezvous", self.rendezvous),
        ):
            with self.subTest(service=name):
                self.assertEqual(set(configuration), allowed_top_level)
                self.assertIs(configuration["workers_dev"], False)
                self.assertIs(configuration["preview_urls"], False)
                self.assertIs(
                    configuration["observability"]["logs"][
                        "invocation_logs"
                    ],
                    False,
                )
                self.assertEqual(
                    set(configuration["secrets"]["required"]),
                    {"SOURCE_TAG_KEY_CURRENT", "SOURCE_TAG_KEY_PREVIOUS"},
                )

        self.assertEqual(
            {binding["name"] for binding in self.publisher["ratelimits"]},
            {"GLOBAL_RATE_LIMITER"},
        )
        self.assertEqual(
            {binding["name"] for binding in self.rendezvous["ratelimits"]},
            {"GLOBAL_RATE_LIMITER", "RENDEZVOUS_CLIENT_RATE_LIMITER"},
        )

    def test_rate_limit_namespaces_are_unique_across_worker_services(self) -> None:
        namespace_ids = [
            binding["namespace_id"]
            for configuration in (self.core, self.publisher, self.rendezvous)
            for binding in configuration.get("ratelimits", [])
        ]
        self.assertEqual(len(namespace_ids), len(set(namespace_ids)))
        self.assertEqual(
            {
                binding["namespace_id"]
                for binding in self.publisher["ratelimits"]
            },
            {"1101"},
        )
        self.assertEqual(
            {
                binding["namespace_id"]
                for binding in self.rendezvous["ratelimits"]
            },
            {"1201", "1202"},
        )

    def test_each_dynamic_edge_starts_disabled(self) -> None:
        self.assertEqual(self.publisher["vars"]["PUBLISH_ENABLED"], "disabled")
        self.assertEqual(
            self.publisher["vars"]["GAME_PUBLISH_ENABLED"], "disabled"
        )
        self.assertEqual(
            self.rendezvous["vars"]["RENDEZVOUS_ENABLED"],
            "disabled",
        )
        self.assertEqual(self.core["vars"]["PUBLISH_ENABLED"], "disabled")
        self.assertEqual(
            self.core["vars"]["GAME_PUBLISH_ENABLED"], "disabled"
        )
        self.assertEqual(self.core["vars"]["RENDEZVOUS_ENABLED"], "disabled")

    def test_dynamic_authorities_match_only_their_provider_boundary(self) -> None:
        self.assertEqual(
            self.publisher["vars"]["PUBLISH_HOSTNAME"],
            "publish.meta.atrinik.org",
        )
        self.assertEqual(
            self.core["vars"]["PUBLISH_HOSTNAME"],
            self.publisher["vars"]["PUBLISH_HOSTNAME"],
        )
        self.assertEqual(
            self.rendezvous["vars"]["RENDEZVOUS_HOSTNAME"],
            "rendezvous.meta.atrinik.org",
        )
        self.assertEqual(
            self.core["vars"]["RENDEZVOUS_HOSTNAME"],
            self.rendezvous["vars"]["RENDEZVOUS_HOSTNAME"],
        )
        self.assertNotIn("RENDEZVOUS_HOSTNAME", self.publisher["vars"])
        self.assertNotIn("PUBLISH_HOSTNAME", self.rendezvous["vars"])

    def test_scripts_generate_check_and_dry_run_each_config_explicitly(self) -> None:
        scripts = json.loads(PACKAGE_JSON.read_text(encoding="utf-8"))["scripts"]
        self.assertIn("--check", scripts["types:check"])
        for config, outdir in (
            ("wrangler.jsonc", "dist/core"),
            ("wrangler.publisher.jsonc", "dist/publisher"),
            ("wrangler.rendezvous.jsonc", "dist/rendezvous"),
        ):
            with self.subTest(config=config):
                self.assertIn(config, scripts["types:generate"])
                self.assertIn(config, scripts["types:check"])
                dry_run = next(
                    value
                    for key, value in scripts.items()
                    if key.startswith("deploy:dry-run:") and outdir in value
                )
                self.assertIn("--dry-run", dry_run)
                self.assertIn(f"-c {config}", dry_run)

    def test_runbook_pins_isolated_canary_and_three_service_rotation(self) -> None:
        guide = DEPLOYMENT_GUIDE.read_text(encoding="utf-8")
        self.assertIn("ten native Rate Limiting bindings", guide)
        self.assertIn("atrinik-metaserver-publisher-canary", guide)
        self.assertIn("atrinik-metaserver-rendezvous-canary", guide)
        rotation = guide[guide.index("## Rotate source-tag keys"):]
        self.assertIn("atrinik-metaserver-publisher", rotation)
        self.assertIn("atrinik-metaserver-rendezvous", rotation)
        self.assertIn("no cross-Worker atomic deploy", rotation)


if __name__ == "__main__":
    unittest.main()
