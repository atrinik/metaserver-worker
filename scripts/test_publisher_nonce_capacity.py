"""Populated nonce-capacity upgrade preserves replay and revocation headroom."""
try:
    import sqlite3
except ImportError:
    import pysqlite3 as sqlite3
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "migrations/0016_publisher_nonce_capacity.sql"


class PublisherNonceCapacityTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.addCleanup(self.db.close)
        self.db.execute("PRAGMA foreign_keys=ON")
        for migration in sorted((ROOT / "migrations").glob("*.sql")):
            if migration.name >= MIGRATION.name:
                break
            self.db.executescript(migration.read_text())
        self.owner = "a" * 64
        self.db.execute("INSERT INTO publisher_replay VALUES (?,'game-v1','1',?,?,100)",
                        (self.owner, "b" * 32, "c" * 64))

    def test_preserves_overfull_history_and_reserves_existing_revocation(self):
        self.db.execute("""WITH RECURSIVE n(value) AS
          (SELECT 1 UNION ALL SELECT value+1 FROM n WHERE value<131073)
          INSERT INTO publisher_nonces SELECT ?,'game-v1',printf('%032x',value),86500,100 FROM n""",
                        (self.owner,))
        self.db.execute("INSERT INTO access_routes VALUES (?,'game',?,?,'1','active',NULL,NULL,200,100,NULL)",
                        ("d" * 64, self.owner, "e" * 32))
        self.db.executescript(MIGRATION.read_text())
        self.assertEqual(self.db.execute("SELECT maximum_rows FROM publisher_nonce_capacity").fetchone(), (131074,))
        self.assertEqual(self.db.execute("SELECT count(*),min(expires_at),max(expires_at) FROM publisher_nonces").fetchone(),
                         (131073, 86500, 86500))
        self.assertEqual(self.db.execute("SELECT state FROM access_routes").fetchone(), ("active",))
        self.db.execute("INSERT INTO publisher_nonces VALUES (?,'game-v1',?,86500,100)", (self.owner, "f" * 32))
        with self.assertRaisesRegex(sqlite3.IntegrityError, "publisher nonce capacity"):
            self.db.execute("INSERT INTO publisher_nonces VALUES (?,'game-v1',?,86500,100)", (self.owner, "e" * 32))
        self.assertEqual(self.db.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_empty_upgrade_uses_fixed_ceiling_and_missing_capacity_fails_closed(self):
        self.db.executescript(MIGRATION.read_text())
        self.assertEqual(self.db.execute("SELECT maximum_rows FROM publisher_nonce_capacity").fetchone(), (131072,))
        self.db.execute("DELETE FROM publisher_nonce_capacity")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "publisher nonce capacity"):
            self.db.execute("INSERT INTO publisher_nonces VALUES (?,'game-v1',?,86500,100)", (self.owner, "f" * 32))


if __name__ == "__main__":
    unittest.main()
