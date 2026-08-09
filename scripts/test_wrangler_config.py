import json
import unittest
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
WRANGLER_CONFIG = REPOSITORY_ROOT / "wrangler.jsonc"


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
            self.configuration["triggers"]["crons"], ["17 * * * *"]
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
                }
            ],
        )
        self.assertEqual(
            self.configuration["durable_objects"]["bindings"],
            [{"name": "RENDEZVOUS", "class_name": "RendezvousRoom"}],
        )
        self.assertEqual(
            self.configuration["exports"]["RendezvousRoom"],
            {"type": "durable-object", "storage": "sqlite"},
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


if __name__ == "__main__":
    unittest.main()
