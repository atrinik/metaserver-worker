import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PATTERN = re.compile(
    r"COMPAT_[A-Z0-9_]+|compat-key-v1|"
    r"server_owners|server_blacklist|one_time_tokens|\brate_limits\b|"
    r"\b(?:source_ip|auth_key|current_ip|authentication_kind)\b|"
    r"publisherAuthentication|signedOwnerSchemaAnchor|legacyShadowMutation|"
    r"reset-owner|blacklist-(?:add|remove)|"
    r"\b(?:FROM|INTO|UPDATE|TABLE|JOIN)\s+servers\b|"
    r"compat-(?:status|directory|otp|update(?:-source|-server)?|"
    r"rendezvous(?:-[a-z-]+)?)|"
    r"/index\.wsgi/(?:otp|update)|/v2/(?:servers|rendezvous)"
)

RETIRED_DOCUMENTATION_PATTERN = re.compile(
    r"\bone[- ]time token\b|\binitial classic registration\b|"
    r"\bsource budget\b|\bfixed update route\b|`request_source`",
    re.IGNORECASE,
)

HISTORICAL_PREFIXES = (
    "migrations/",
    "scripts/test_migrations.py",
    "scripts/test_retired_surface_policy.py",
)

NEGATIVE_FIXTURES = {
    "scripts/static_origin_canary.py": {"source_ip"},
    "test/rendezvous-contract.test.ts": {
        "compat-key-v1",
        "publisherAuthentication",
    },
    "test/routes.test.ts": {
        "/v2/servers",
        "/index.wsgi/otp",
        "/index.wsgi/update",
        "/v2/rendezvous",
    },
    "docs/edge-policy.md": {
        "/v2/servers",
        "/index.wsgi/otp",
    },
}


class RetiredSurfaceSourcePolicyTests(unittest.TestCase):
    def test_storage_removal_requires_noncanonical_deny_disposition(self) -> None:
        deployment = (ROOT / "DEPLOYMENT.md").read_text(encoding="utf-8")
        migration = (
            ROOT / "migrations" / "0009_remove_legacy_storage.sql"
        ).read_text(encoding="utf-8")
        for required in (
            "Require the noncanonical count to be zero",
            "explicitly retires it",
            "exact enabled Cloudflare WAF rule",
            "never the raw legacy pattern",
        ):
            self.assertIn(required, deployment)
        self.assertIn("FROM server_blacklist", migration)
        self.assertIn("typeof(pattern) <> 'text'", migration)
        self.assertIn("length(pattern) <> 64", migration)
        self.assertIn("pattern GLOB '*[^0-9a-f]*'", migration)

    def test_supported_guidance_omits_retired_registration_terminology(
        self,
    ) -> None:
        files = [ROOT / "README.md", ROOT / "DEPLOYMENT.md"]
        files.extend(
            path for path in (ROOT / "docs").rglob("*.md") if path.is_file()
        )
        violations: list[str] = []
        for path in sorted(files):
            text = path.read_text(encoding="utf-8")
            for match in RETIRED_DOCUMENTATION_PATTERN.finditer(text):
                line = text.count("\n", 0, match.start()) + 1
                relative = path.relative_to(ROOT).as_posix()
                violations.append(f"{relative}:{line}:{match.group(0)}")

        self.assertEqual(violations, [])

    def test_legacy_identifiers_exist_only_in_history_or_negative_fixtures(
        self,
    ) -> None:
        violations: list[str] = []
        roots = [
            ROOT / "src",
            ROOT / "migrations",
            ROOT / "scripts",
            ROOT / "test",
            ROOT / "docs",
        ]
        files = [
            ROOT / "README.md",
            ROOT / "DEPLOYMENT.md",
            ROOT / "wrangler.jsonc",
            ROOT / "wrangler.publisher.jsonc",
            ROOT / "wrangler.rendezvous.jsonc",
            ROOT / "vitest.config.ts",
            ROOT / "vitest.service.config.ts",
        ]
        for directory in roots:
            files.extend(path for path in directory.rglob("*") if path.is_file())

        for path in sorted(set(files)):
            relative = path.relative_to(ROOT).as_posix()
            try:
                text = path.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                continue
            for match in PATTERN.finditer(text):
                if relative.startswith(HISTORICAL_PREFIXES):
                    continue
                if match.group(0) in NEGATIVE_FIXTURES.get(relative, set()):
                    continue
                line = text.count("\n", 0, match.start()) + 1
                violations.append(f"{relative}:{line}:{match.group(0)}")

        self.assertEqual(violations, [])

    def test_runtime_and_active_configuration_have_no_retired_dispatch(self) -> None:
        paths = [
            *(ROOT / "src").glob("*.ts"),
            ROOT / "wrangler.jsonc",
            ROOT / "wrangler.publisher.jsonc",
            ROOT / "wrangler.rendezvous.jsonc",
            ROOT / "vitest.config.ts",
        ]
        for path in paths:
            with self.subTest(path=path.name):
                self.assertIsNone(PATTERN.search(path.read_text(encoding="utf-8")))


if __name__ == "__main__":
    unittest.main()
