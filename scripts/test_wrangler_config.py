import json
import re
import unittest
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
WRANGLER_CONFIG = REPOSITORY_ROOT / "wrangler.jsonc"
PUBLISHER_CONFIG = REPOSITORY_ROOT / "wrangler.publisher.jsonc"
RENDEZVOUS_CONFIG = REPOSITORY_ROOT / "wrangler.rendezvous.jsonc"
DEPLOYMENT_GUIDE = REPOSITORY_ROOT / "DEPLOYMENT.md"
EDGE_POLICY = REPOSITORY_ROOT / "docs" / "edge-policy.md"
PACKAGE_JSON = REPOSITORY_ROOT / "package.json"


class WranglerSecurityConfigurationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.configuration = json.loads(
            WRANGLER_CONFIG.read_text(encoding="utf-8")
        )

    def test_alternate_public_worker_urls_are_disabled(self) -> None:
        self.assertIs(self.configuration.get("workers_dev"), False)
        self.assertIs(self.configuration.get("preview_urls"), False)

    def test_canonical_core_bindings_pin_reviewed_limits(self) -> None:
        expected_bindings = {
            "PUBLISH_IDENTITY_RATE_LIMITER": ("1006", 2),
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
        self.assertEqual(
            self.configuration["vars"]["RENDEZVOUS_SERVER_DAILY_LIMIT"],
            "50",
        )
        for retired in (
            "GLOBAL_RATE_LIMITER",
            "DIRECTORY_RATE_LIMITER",
            "OTP_RATE_LIMITER",
            "UPDATE_RATE_LIMITER",
            "RENDEZVOUS_CLIENT_RATE_LIMITER",
        ):
            self.assertNotIn(retired, {binding["name"] for binding in bindings})

    def test_source_tag_secrets_and_logging_policy_are_pinned(self) -> None:
        self.assertEqual(
            set(self.configuration["secrets"]["required"]),
            {
                "DIRECTORY_CACHE_PURGE_TOKEN",
                "SOURCE_TAG_KEY_CURRENT",
                "SOURCE_TAG_KEY_PREVIOUS",
            },
        )
        self.assertEqual(
            self.configuration["vars"]["CLASSIC_DIRECTORY_PUBLIC_ORIGIN"],
            "https://classic.meta.atrinik.org",
        )
        self.assertEqual(
            self.configuration["vars"]["GAME_DIRECTORY_PUBLIC_ORIGIN"],
            "https://meta.atrinik.org",
        )
        self.assertEqual(
            self.configuration["vars"]["CLASSIC_DIRECTORY_CUTOVER_MODE"],
            "v4-production",
        )
        self.assertRegex(
            self.configuration["vars"]["DIRECTORY_CACHE_ZONE_ID"],
            r"^[0-9a-f]{32}$",
        )
        self.assertNotIn("ALLOW_TEST_SOURCE_IP", self.configuration["vars"])
        self.assertIs(self.configuration["observability"]["enabled"], True)
        logs = self.configuration["observability"]["logs"]
        self.assertIs(logs["enabled"], True)
        self.assertEqual(logs["head_sampling_rate"], 1)
        self.assertIs(logs["invocation_logs"], False)
        self.assertIs(logs["persist"], True)
        self.assertEqual(logs["destinations"], [])
        self.assertEqual(
            self.configuration["observability"]["traces"],
            {
                "enabled": False,
                "head_sampling_rate": 1,
                "persist": False,
                "destinations": [],
            },
        )
        self.assertIs(self.configuration["logpush"], False)
        self.assertEqual(self.configuration["tail_consumers"], [])
        self.assertEqual(self.configuration["streaming_tail_consumers"], [])
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
                    "RENDEZVOUS_CLIENT_PAIR_BURST_LIMIT",
                    "RENDEZVOUS_CLIENT_PAIR_WINDOW_SECONDS",
                    "RENDEZVOUS_CLIENT_PAIR_INITIAL_COOLDOWN_SECONDS",
                    "RENDEZVOUS_CLIENT_PAIR_MAXIMUM_COOLDOWN_SECONDS",
                    "RENDEZVOUS_CLIENT_PAIR_RESET_SECONDS",
                    "RENDEZVOUS_ACTIVE_CLIENT_LIMIT",
                    "RENDEZVOUS_CLIENT_SESSION_SECONDS",
                )
            },
            {
                "RENDEZVOUS_CLIENT_PAIR_BURST_LIMIT": "20",
                "RENDEZVOUS_CLIENT_PAIR_WINDOW_SECONDS": "60",
                "RENDEZVOUS_CLIENT_PAIR_INITIAL_COOLDOWN_SECONDS": "30",
                "RENDEZVOUS_CLIENT_PAIR_MAXIMUM_COOLDOWN_SECONDS": "900",
                "RENDEZVOUS_CLIENT_PAIR_RESET_SECONDS": "1800",
                "RENDEZVOUS_ACTIVE_CLIENT_LIMIT": "16",
                "RENDEZVOUS_CLIENT_SESSION_SECONDS": "15",
            },
        )

    def test_exports_rollout_uses_direct_deploy_only(self) -> None:
        guide = DEPLOYMENT_GUIDE.read_text(encoding="utf-8")
        self.assertNotIn(
            'npx wrangler versions upload --strict \\\n'
            '     --config "$ATRINIK_PROD_CORE_CONFIG"',
            guide,
        )
        self.assertNotIn(
            'npx wrangler versions deploy \\\n'
            '     --config "$ATRINIK_PROD_CORE_CONFIG"',
            guide,
        )
        self.assertIn(
            'npx wrangler versions upload --strict \\\n'
            '     --config "$ATRINIK_PROD_PUBLISHER_CONFIG"',
            guide,
        )
        self.assertIn(
            'npx wrangler versions upload --strict \\\n'
            '     --config "$ATRINIK_PROD_RENDEZVOUS_CONFIG"',
            guide,
        )
        self.assertIn("npx wrangler deploy --strict", guide)
        self.assertIn('--config "$ATRINIK_PROD_CORE_CONFIG"', guide)
        self.assertIn('--secrets-file "$ATRINIK_PROD_CORE_SECRETS"', guide)
        self.assertIn("Durable Object exports reconciliation", guide)
        self.assertIn("Rollback cannot cross the lifecycle change", guide)
        cutover = guide[guide.index("## Deploy provider first"):]
        self.assertLess(
            cutover.index("Apply only reviewed pending D1 migrations"),
            cutover.index("Directly deploy the state-owning core"),
        )

    def test_static_origin_policy_pins_zero_worker_delivery_contract(self) -> None:
        edge_policy = EDGE_POLICY.read_text(encoding="utf-8")
        deployment = DEPLOYMENT_GUIDE.read_text(encoding="utf-8")
        normalized_policy = " ".join(edge_policy.split())
        normalized_deployment = " ".join(deployment.split())
        for value in (
            'http.request.method in {"GET" "HEAD"}',
            'http.request.method in {"GET" "HEAD" "PURGE"}',
            '"/" "/index.html" "/index.json" "/index.xml"',
            "/manifest.json",
            "Keep each bucket's `r2.dev` URL disabled",
            "Attach no Worker route to either hostname",
            "opaque strong ETag",
            "alias-upload Last-Modified",
            "Do not configure an edge TTL override",
        ):
            with self.subTest(value=value):
                self.assertIn(value, normalized_policy)
        cache_expression = (
            'http.host eq "classic.meta.atrinik.org" and '
            'http.request.method in {"GET" "HEAD" "PURGE"} and '
            'raw.http.request.uri.query eq "" and '
            'raw.http.request.uri.path in {"/index.html" "/index.json" "/index.xml"} and '
            'http.request.uri.path in {"/index.html" "/index.json" "/index.xml"}'
        )
        self.assertIn(cache_expression, normalized_policy)
        self.assertIn(
            "It belongs only in this cache expression",
            normalized_policy,
        )
        self.assertIn(
            "A HIT of the warmed generation after API acceptance is a deployment blocker",
            normalized_deployment,
        )
        self.assertIn(
            "opaque quoted strong `ETag` of 3 through 128 bytes",
            normalized_deployment,
        )
        self.assertIn(
            "zero increase in dynamic Worker or D1 reads",
            normalized_deployment,
        )
        self.assertIn(
            "Do not enable a production hostname in this step",
            normalized_deployment,
        )
        raw_static_paths = re.compile(
            r"(?m)^\s+raw\.http\.request\.uri\.path in \{\s*"
            r'"/"\s+"/index\.html"\s+"/index\.json"\s+"/index\.xml"\s*\}',
        )
        normalized_static_paths = re.compile(
            r"(?m)^\s+http\.request\.uri\.path in \{\s*"
            r'"/"\s+"/index\.html"\s+"/index\.json"\s+"/index\.xml"\s*\}',
        )
        self.assertEqual(len(raw_static_paths.findall(edge_policy)), 2)
        self.assertEqual(len(normalized_static_paths.findall(edge_policy)), 2)
        self.assertNotIn(
            "raw.http.request.uri.path eq http.request.uri.path",
            normalized_policy,
        )
        self.assertIn(
            "python3 scripts/static_origin_canary.py",
            normalized_deployment,
        )
        self.assertIn(
            "python3 scripts/edge_ingress_canary.py",
            normalized_deployment,
        )
        self.assertIn("--profile classic-v1", normalized_deployment)
        self.assertIn("--profile game-v1", normalized_deployment)
        self.assertIn("--hsts-max-age 300", normalized_deployment)
        self.assertIn("Strict-Transport-Security: max-age=300", edge_policy)
        self.assertIn(
            "Do not include `includeSubDomains` or `preload`",
            edge_policy,
        )
        self.assertIn("A `403` alone does not prove", edge_policy)
        self.assertNotIn(
            'http.host in {"meta.atrinik.org" "classic.meta.atrinik.org"}',
            edge_policy,
        )
        self.assertIn('http.host eq "classic.meta.atrinik.org"', edge_policy)
        self.assertIn('http.host eq "meta.atrinik.org"', edge_policy)
        self.assertIn("correlate all eight fixed", edge_policy)
        self.assertIn("zero Worker/D1 work", normalized_deployment)
        self.assertIn("no default core `fetch` handler", normalized_deployment)
        for option in (
            "--core-base-url",
            "--publisher-base-url",
            "--publisher-version-url",
            "--rendezvous-base-url",
            "--rendezvous-version-url",
        ):
            self.assertGreaterEqual(normalized_deployment.count(option), 2)
        self.assertIn("does not generate its version-preview URL", deployment)
        self.assertIn(
            '"https://publish.meta.atrinik.org/"',
            edge_policy,
        )
        self.assertIn(
            '"https://rendezvous.meta.atrinik.org/"',
            edge_policy,
        )
        self.assertIn(
            "accept no Cloudflare token and have no mutation path",
            normalized_deployment,
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
            "logpush",
            "tail_consumers",
            "streaming_tail_consumers",
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
                self.assertIs(
                    configuration["observability"]["logs"]["persist"],
                    True,
                )
                self.assertEqual(
                    configuration["observability"]["logs"]["destinations"],
                    [],
                )
                self.assertEqual(
                    configuration["observability"]["traces"],
                    {
                        "enabled": False,
                        "head_sampling_rate": 1,
                        "persist": False,
                        "destinations": [],
                    },
                )
                self.assertIs(configuration["logpush"], False)
                self.assertEqual(configuration["tail_consumers"], [])
                self.assertEqual(configuration["streaming_tail_consumers"], [])
                self.assertEqual(
                    set(configuration["secrets"]["required"]),
                    {"SOURCE_TAG_KEY_CURRENT", "SOURCE_TAG_KEY_PREVIOUS"},
                )
                self.assertNotIn(
                    "DIRECTORY_CACHE_PURGE_TOKEN",
                    configuration["secrets"]["required"],
                )
                self.assertNotIn("DIRECTORY_CACHE_ZONE_ID", configuration["vars"])
                self.assertNotIn(
                    "CLASSIC_DIRECTORY_PUBLIC_ORIGIN", configuration["vars"]
                )
                self.assertNotIn(
                    "GAME_DIRECTORY_PUBLIC_ORIGIN", configuration["vars"]
                )

        self.assertEqual(
            {binding["name"] for binding in self.publisher["ratelimits"]},
            {"GLOBAL_RATE_LIMITER"},
        )
        self.assertEqual(
            {binding["name"] for binding in self.rendezvous["ratelimits"]},
            {"GLOBAL_RATE_LIMITER", "RENDEZVOUS_CLIENT_RATE_LIMITER"},
        )
        rendezvous_limits = {
            binding["name"]: binding["simple"]
            for binding in self.rendezvous["ratelimits"]
        }
        self.assertEqual(
            rendezvous_limits["RENDEZVOUS_CLIENT_RATE_LIMITER"],
            {"limit": 60, "period": 60},
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
        normalized = " ".join(guide.split())
        self.assertIn("Classic v5.9.0", guide)
        self.assertIn("complete 24-hour replay-row lifetime", normalized)
        self.assertIn("Deploy provider first", guide)
        rotation = guide[guide.index("## Rotate source-tag keys"):]
        self.assertIn("atrinik-metaserver-publisher", rotation)
        self.assertIn("atrinik-metaserver-rendezvous", rotation)
        self.assertIn("no cross-Worker atomic deploy", rotation)


if __name__ == "__main__":
    unittest.main()
