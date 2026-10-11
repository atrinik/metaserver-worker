"""Populated forward upgrade removes pair tags and preserves non-IP authority."""
try:
    import sqlite3
except ImportError:
    import pysqlite3 as sqlite3
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "migrations/0015_remove_ip_derived_pair_tracking.sql"
RETIRED = {"rendezvous_pair_attempts", "rendezvous_pair_cooldowns"}


class IpTrackingRemovalTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.addCleanup(self.db.close)
        self.db.execute("PRAGMA foreign_keys=ON")
        for migration in sorted((ROOT / "migrations").glob("*.sql")):
            if migration.name >= MIGRATION.name:
                break
            self.db.executescript(migration.read_text())

    def seed(self):
        for index in range(2):
            tag = f"v1.pair-{index}." + "A" * 43
            self.db.execute("INSERT INTO rendezvous_pair_attempts VALUES (?,?,100,160)",
                            (tag, f"{index:032x}"))
            self.db.execute("INSERT INTO rendezvous_pair_cooldowns VALUES (?,200,1,100,1000)", (tag,))
        owner = "a" * 64
        for profile in ("classic-v3", "game-v2"):
            self.db.execute("INSERT INTO publisher_replay VALUES (?,?,'19',?,?,100)",
                            (owner, profile, "b" * 32, "c" * 64))
            self.db.execute("INSERT INTO publisher_nonces VALUES (?,?,?,1000,100)",
                            (owner, profile, "b" * 32))
            self.db.execute("INSERT INTO server_presence(profile,server_id,last_seen,rendezvous_token_hash,"
                            "rendezvous_generation,name,certificate,access_required) VALUES (?,?,100,?,?,'Private','AQ==',1)",
                            (profile, owner, "d" * 64, "e" * 64))
        for profile, index in (("classic", "1"), ("game", "2")):
            route = index * 64
            self.db.execute("INSERT INTO access_routes VALUES (?,?,?,?,'1','active',NULL,?,200,100,NULL)",
                            (route, profile, owner, "1" * 32, "2" * 32))
            self.db.execute("INSERT INTO access_route_receipts VALUES (?,?,?,?,?,'activate',?,'active',?,200,'1',?,100,1000)",
                            (profile, owner, "3" * 32, "4" * 64, "5" * 64, "1" * 32, "2" * 32, "6" * 64))
            self.db.execute("INSERT INTO access_grants VALUES (?,?,?,?,?,'1',?,?,200,NULL)",
                            (f"v1.grant{index}a." + "A" * 43, f"v1.grant{index}b." + "B" * 43,
                             route, profile, owner, "e" * 64, "f" * 64))
            self.db.execute("INSERT INTO access_request_budgets VALUES (?,?,'routes',100,200,1)",
                            (profile, owner))
        for scope in ("publish-server", "publish-game-server", "rendezvous-server"):
            self.db.execute("INSERT INTO request_budgets VALUES (?,?,100,1,200)", (owner, scope))

    def retained_rows(self):
        tables = [name for (name,) in self.db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        ) if name not in RETIRED]
        return {name: sorted(self.db.execute(f'SELECT * FROM "{name}"').fetchall(), key=repr) for name in tables}

    def retained_schema(self):
        return self.db.execute(
            "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE "
            "tbl_name NOT IN ('rendezvous_pair_attempts','rendezvous_pair_cooldowns') ORDER BY type,name"
        ).fetchall()

    def test_populated_removal_preserves_all_other_rows_and_schema(self):
        self.seed()
        rows, schema = self.retained_rows(), self.retained_schema()
        self.assertEqual(self.db.execute("SELECT count(*) FROM rendezvous_pair_attempts").fetchone(), (2,))
        self.assertEqual(self.db.execute("SELECT count(*) FROM rendezvous_pair_cooldowns").fetchone(), (2,))
        self.db.executescript(MIGRATION.read_text())
        self.assertEqual(self.retained_rows(), rows)
        self.assertEqual(self.retained_schema(), schema)
        self.assertEqual(self.db.execute("PRAGMA foreign_key_check").fetchall(), [])
        self.assertEqual(self.db.execute(
            "SELECT name FROM sqlite_master WHERE name LIKE 'rendezvous_pair_%' OR tbl_name LIKE 'rendezvous_pair_%'"
        ).fetchall(), [])
        for table in RETIRED:
            with self.assertRaises(sqlite3.OperationalError):
                self.db.execute(f"SELECT * FROM {table}")

    def test_fresh_chain_has_no_pair_tracking_or_legacy_raw_address_tables(self):
        self.db.executescript(MIGRATION.read_text())
        names = {name for (name,) in self.db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        self.assertTrue(RETIRED.isdisjoint(names))
        self.assertTrue({"server_owners", "servers", "one_time_tokens", "rate_limits"}.isdisjoint(names))
        self.assertTrue({"publisher_replay", "publisher_nonces", "server_presence", "access_routes",
                         "access_grants", "access_route_receipts", "request_budgets", "access_request_budgets"} <= names)


if __name__ == "__main__":
    unittest.main()
