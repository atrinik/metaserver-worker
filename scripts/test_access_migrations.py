"""Bounded private routing storage and populated pre-cutover migration proof."""
import sqlite3
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "migrations/0014_access_token_routing.sql"


class AccessMigrationTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.execute("PRAGMA foreign_keys = ON")
        for path in sorted((ROOT / "migrations").glob("*.sql")):
            if path.name < "0013":
                self.db.executescript(path.read_text())
        self.db.execute(
            "INSERT INTO publisher_replay VALUES (?, 'classic-v2', '19', ?, ?, 100)",
            ("1" * 64, "2" * 32, "3" * 64),
        )
        self.db.execute(
            "INSERT INTO server_presence(profile,server_id,last_seen,"
            "rendezvous_token_hash,rendezvous_generation) VALUES "
            "('classic-v2', ?, 100, ?, ?)",
            ("1" * 64, "4" * 64, "5" * 64),
        )
        self.before = self.snapshot()
        self.db.executescript(MIGRATION.read_text())

    def tearDown(self):
        self.db.close()

    def snapshot(self):
        tables = self.db.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
        ).fetchall()
        return {name: self.db.execute(f'SELECT * FROM "{name}"').fetchall()
                for (name,) in tables}

    def route(self, index=1, owner="1" * 64, profile="classic",
              state="reserved", token=None):
        self.db.execute(
            "INSERT INTO access_routes VALUES (?, ?, ?, ?, '1', ?, NULL, NULL, 160, 100, ?)",
            (f"{index:064x}", profile, owner, token or f"{index:032x}", state,
             100 if state == "revoked" else None),
        )

    def test_preserves_every_populated_old_table(self):
        current = self.snapshot()
        self.assertEqual(self.before, {key: current[key] for key in self.before})
        self.assertEqual([], self.db.execute("PRAGMA foreign_key_check").fetchall())

    def test_global_collision_cannot_reassign_profile_or_owner(self):
        self.route()
        for profile, owner in (("game", "1" * 64),
                               ("classic", "2" * 64)):
            with self.assertRaises(sqlite3.IntegrityError):
                self.route(profile=profile, owner=owner)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE access_routes SET server_id = ?", ("2" * 64,))

    def test_revocation_is_terminal_and_null_expiry_means_never(self):
        self.route()
        self.assertIsNone(self.db.execute("SELECT expires_at FROM access_routes").fetchone()[0])
        self.db.execute("UPDATE access_routes SET state='revoked', revoked_at=101")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE access_routes SET state='active', revoked_at=NULL")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE access_routes SET revoked_at=102")

    def test_live_capacity_and_revocation_reserve(self):
        for index in range(1, 1025):
            self.route(index)
        with self.assertRaises(sqlite3.IntegrityError):
            self.route(1025)
        self.db.execute("UPDATE access_routes SET state='revoked', revoked_at=101")
        for index in range(1025, 4097):
            self.route(index, state="revoked")
        with self.assertRaises(sqlite3.IntegrityError):
            self.route(4097)
        self.assertEqual(4096, self.db.execute("SELECT count(*) FROM access_routes").fetchone()[0])

    def test_strict_scalar_constraints(self):
        self.route()
        for column, value in (("route_index", "A" * 64), ("token_revision", "01"),
                              ("token_revision", "18446744073709551616"),
                              ("expires_at", 0), ("expires_at", 1.5)):
            with self.assertRaises(sqlite3.IntegrityError):
                self.db.execute(f"UPDATE access_routes SET {column}=?", (value,))


if __name__ == "__main__":
    unittest.main()
