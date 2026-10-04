import argparse
try:
    import sqlite3
except ImportError:  # Cloudflare's build image omits the system SQLite runtime.
    import pysqlite3 as sqlite3
import unittest
from pathlib import Path

import admin_sql


SERVER_ID = "1" * 64
OTHER_SERVER_ID = "2" * 64
MIGRATIONS = tuple(sorted((Path(__file__).parents[1] / "migrations").glob("*.sql")))


class AdminSqlTest(unittest.TestCase):
    def database(self) -> sqlite3.Connection:
        connection = sqlite3.connect(":memory:")
        self.addCleanup(connection.close)
        for migration in MIGRATIONS:
            connection.executescript(migration.read_text(encoding="utf-8"))
        return connection

    def seed_server(self, connection: sqlite3.Connection, server_id: str) -> None:
        connection.execute(
            """INSERT INTO publisher_replay
                   (server_id, profile, last_sequence, last_nonce,
                    commit_token, updated_at)
               VALUES (?, 'classic-v1', '1', ?, ?, 1)""",
            (server_id, "1" * 32, server_id),
        )
        connection.execute(
            """INSERT INTO server_presence
                   (profile, server_id, last_seen, rendezvous_token_hash,
                    rendezvous_generation)
               VALUES ('classic-v1', ?, 1, ?, ?)""",
            (server_id, "f" * 64, "0" * 64),
        )
        connection.execute(
            """INSERT INTO directory_entries
                   (profile, server_id, name, players_count, version,
                    text_comment, hostname, port, quic_cert_sha256,
                    password_required, directory_fingerprint)
               VALUES ('classic-v1', ?, 'Test', 0, '4.0.0', 'Test server',
                       NULL, NULL, ?, 0, ?)""",
            (server_id, server_id, "0" * 64),
        )
        connection.execute(
            """INSERT INTO publisher_nonces
                   (server_id, profile, nonce, expires_at, created_at)
               VALUES (?, 'classic-v1', ?, 86400, 0)""",
            (server_id, "1" * 32),
        )

    def test_reset_identity_executes_and_is_scoped_to_one_identity(self) -> None:
        connection = self.database()
        self.seed_server(connection, SERVER_ID)
        self.seed_server(connection, OTHER_SERVER_ID)
        connection.execute(
            """INSERT INTO publisher_replay
                   (server_id, profile, last_sequence, last_nonce,
                    commit_token, updated_at)
               VALUES (?, 'game-v1', '1', ?, ?, 1)""",
            (SERVER_ID, "2" * 32, "2" * 64),
        )
        connection.execute(
            """INSERT INTO server_presence
                   (profile, server_id, last_seen, rendezvous_token_hash,
                    rendezvous_generation)
               VALUES ('game-v1', ?, 1, ?, ?)""",
            (SERVER_ID, "e" * 64, "d" * 64),
        )
        connection.execute(
            """INSERT INTO directory_entries
                   (profile, server_id, name, description, protocol_major,
                    protocol_minor, content_id, content_revision_sha256,
                    players_online, players_capacity, status, game_json_bytes,
                    hostname, port, quic_cert_sha256,
                    password_required, directory_fingerprint)
               VALUES ('game-v1', ?, 'Game', '', 1, 0, 'atrinik-main', ?,
                       0, 64, 'online', 1, NULL, NULL, ?, 0, ?)""",
            (SERVER_ID, "b" * 64, SERVER_ID, "c" * 64),
        )
        for server_id in (SERVER_ID, OTHER_SERVER_ID):
            connection.execute(
                """INSERT INTO directory_activity_state
                       (profile, server_id, last_observed_at,
                        last_positive_observed_at, last_population,
                        observation_count)
                   VALUES ('classic-v1', ?, 1, 1, 2, 1)""",
                (server_id,),
            )
            connection.execute(
                """INSERT INTO directory_activity_buckets
                       (profile, server_id, bucket_start, positive_seconds,
                        player_minutes, max_population, positive_observations,
                        zero_observations)
                   VALUES ('classic-v1', ?, 0, 1, 1, 2, 1, 0)""",
                (server_id,),
            )
            connection.execute(
                """INSERT INTO directory_admin_pins
                       (profile, server_id, priority, expires_at, note,
                        created_at, updated_at)
                   VALUES ('classic-v1', ?, 1, NULL, 'reset', 1, 1)""",
                (server_id,),
            )

        sql = admin_sql.command_reset_identity(
            argparse.Namespace(server_id=SERVER_ID.upper()),
        )
        connection.executescript(sql)

        self.assertEqual(
            connection.execute(
                "SELECT profile, revision FROM directory_revisions ORDER BY profile"
            ).fetchall(),
            [("classic-v1", 1), ("classic-v2", 0), ("classic-v3", 0),
             ("game-v1", 1), ("game-v2", 0)],
        )
        self.assertEqual(
            connection.execute(
                "SELECT profile, revision FROM directory_outbox ORDER BY profile"
            ).fetchall(),
            [("classic-v1", 1), ("game-v1", 1)],
        )

        for table in (
            "directory_entries",
            "server_presence",
            "publisher_replay",
            "publisher_nonces",
            "directory_activity_state",
            "directory_activity_buckets",
            "directory_admin_pins",
        ):
            identities = connection.execute(
                f"SELECT server_id FROM {table} ORDER BY server_id",
            ).fetchall()
            self.assertEqual(identities, [(OTHER_SERVER_ID,)])

    def test_reset_identity_keeps_private_only_presence_revision_neutral(self) -> None:
        connection = self.database()
        self.seed_server(connection, SERVER_ID)
        connection.execute(
            "DELETE FROM directory_entries WHERE server_id = ?", (SERVER_ID,)
        )

        connection.executescript(admin_sql.command_reset_identity(
            argparse.Namespace(server_id=SERVER_ID),
        ))

        self.assertEqual(
            connection.execute(
                "SELECT profile, revision FROM directory_revisions ORDER BY profile"
            ).fetchall(),
            [("classic-v1", 0), ("classic-v2", 0), ("classic-v3", 0),
             ("game-v1", 0), ("game-v2", 0)],
        )
        self.assertEqual(
            connection.execute("SELECT count(*) FROM directory_outbox").fetchone(),
            (0,),
        )

    def seed_private_access(self, connection, server_id, profile, route_index):
        connection.execute(
            "INSERT INTO access_routes VALUES (?, ?, ?, ?, '1', 'active', "
            "NULL, ?, 200, 100, NULL)",
            (route_index, profile, server_id, "1" * 32, "2" * 32),
        )
        connection.execute(
            "INSERT INTO access_route_receipts VALUES (?, ?, ?, ?, ?, "
            "'activate', ?, 'active', ?, 200, '1', ?, 100, 1000)",
            (profile, server_id, "3" * 32, "4" * 64, "5" * 64,
             "1" * 32, "2" * 32, "6" * 64),
        )
        connection.execute(
            "INSERT INTO access_grants VALUES (?, ?, ?, ?, ?, '1', ?, ?, 200, NULL)",
            (route_index + "a", route_index + "b", route_index, profile,
             server_id, "c" * 64, "d" * 64),
        )
        connection.execute(
            "INSERT INTO access_request_budgets VALUES (?, ?, 'routes', 100, 200, 1)",
            (profile, server_id),
        )

    def test_reset_revokes_both_private_profiles_and_preserves_other_identity(self):
        connection = self.database()
        for identity, route_prefix in ((SERVER_ID, "a"), (OTHER_SERVER_ID, "b")):
            for profile, route_suffix in (("classic", "1"), ("game", "2")):
                self.seed_private_access(
                    connection, identity, profile, route_prefix * 63 + route_suffix
                )
        connection.execute(
            "INSERT INTO access_routes VALUES (?, 'classic', ?, ?, '1', 'revoked', "
            "NULL, NULL, 200, 100, 123)",
            ("c" * 64, SERVER_ID, "7" * 32),
        )
        connection.execute(
            "UPDATE access_routes SET state='reserved' WHERE profile='game' "
            "AND server_id=?", (SERVER_ID,)
        )
        for profile in ("classic-v3", "game-v2"):
            connection.execute(
                "INSERT INTO publisher_replay VALUES (?, ?, '1', ?, ?, 100)",
                (SERVER_ID, profile, "a" * 32, "b" * 64),
            )
            connection.execute(
                "INSERT INTO server_presence(profile,server_id,last_seen,"
                "rendezvous_token_hash,rendezvous_generation,name,certificate,"
                "access_required) VALUES (?, ?, 100, ?, ?, 'Private', 'AQ==', 1)",
                (profile, SERVER_ID, "a" * 64, "b" * 64),
            )
        budgets = connection.execute(
            "SELECT * FROM access_request_budgets ORDER BY profile,server_id"
        ).fetchall()
        untouched = {
            table: connection.execute(
                f"SELECT * FROM {table} WHERE server_id=? ORDER BY 1", (OTHER_SERVER_ID,)
            ).fetchall()
            for table in ("access_routes", "access_route_receipts", "access_grants")
        }
        connection.executescript(admin_sql.command_reset_identity(
            argparse.Namespace(server_id=SERVER_ID)
        ))
        for table, rows in untouched.items():
            self.assertEqual(connection.execute(
                f"SELECT * FROM {table} WHERE server_id=? ORDER BY 1", (OTHER_SERVER_ID,)
            ).fetchall(), rows)
        self.assertEqual(connection.execute(
            "SELECT * FROM access_request_budgets ORDER BY profile,server_id"
        ).fetchall(), budgets)
        self.assertEqual(connection.execute(
            "SELECT count(*) FROM access_routes WHERE server_id=? "
            "AND (state<>'revoked' OR revoked_at IS NULL)", (SERVER_ID,)
        ).fetchone(), (0,))
        self.assertEqual(connection.execute(
            "SELECT revoked_at FROM access_routes WHERE route_index=?", ("c" * 64,)
        ).fetchone(), (123,))
        for table in ("server_presence", "access_route_receipts", "access_grants"):
            self.assertEqual(connection.execute(
                f"SELECT count(*) FROM {table} WHERE server_id=?", (SERVER_ID,)
            ).fetchone(), (0,))
        self.assertEqual(connection.execute(
            "SELECT count(*) FROM directory_outbox"
        ).fetchone(), (0,))
        with self.assertRaises(sqlite3.IntegrityError):
            connection.execute(
                "UPDATE access_routes SET state='active', revoked_at=NULL "
                "WHERE server_id=?", (SERVER_ID,)
            )

    def test_reset_invalidates_active_public_profiles(self):
        connection = self.database()
        for profile in ("classic-v3", "game-v2"):
            connection.execute(
                "INSERT INTO publisher_replay VALUES (?, ?, '1', ?, ?, 100)",
                (SERVER_ID, profile, "a" * 32, "b" * 64),
            )
            connection.execute(
                "INSERT INTO server_presence(profile,server_id,last_seen,"
                "rendezvous_token_hash,rendezvous_generation,name,certificate,"
                "access_required) VALUES (?, ?, 100, ?, ?, 'Public', 'AQ==', 0)",
                (profile, SERVER_ID, "a" * 64, "b" * 64),
            )
        connection.execute(
            "INSERT INTO directory_entries(profile,server_id,name,players_count,"
            "version,text_comment,quic_cert_sha256,access_required,directory_fingerprint) "
            "VALUES ('classic-v3',?,'Classic',1,'6.0','',?,0,?)",
            (SERVER_ID, SERVER_ID, "b" * 64),
        )
        connection.execute(
            "INSERT INTO directory_entries(profile,server_id,name,description,"
            "protocol_major,protocol_minor,content_id,content_revision_sha256,"
            "players_online,players_capacity,status,game_json_bytes,"
            "quic_cert_sha256,access_required,directory_fingerprint) "
            "VALUES ('game-v2',?,'Game','',1,1,'main',?,3,64,'online',300,?,0,?)",
            (SERVER_ID, "a" * 64, SERVER_ID, "b" * 64),
        )
        connection.executescript(admin_sql.command_reset_identity(
            argparse.Namespace(server_id=SERVER_ID)
        ))
        self.assertEqual(connection.execute(
            "SELECT profile,revision FROM directory_outbox ORDER BY profile"
        ).fetchall(), [("classic-v3", 1), ("game-v2", 1)])
        self.assertEqual(connection.execute(
            "SELECT count(*) FROM directory_entries"
        ).fetchone(), (0,))

    def test_reset_failure_rolls_back_revocation_and_grant_cleanup(self):
        connection = self.database()
        self.seed_server(connection, SERVER_ID)
        self.seed_private_access(connection, SERVER_ID, "classic", "a" * 64)
        connection.execute(
            "CREATE TRIGGER prevent_reset BEFORE DELETE ON publisher_replay "
            "BEGIN SELECT RAISE(ABORT, 'reset failure'); END"
        )
        connection.commit()
        with self.assertRaisesRegex(sqlite3.IntegrityError, "reset failure"):
            connection.executescript(admin_sql.command_reset_identity(
                argparse.Namespace(server_id=SERVER_ID)
            ))
        connection.rollback()
        self.assertEqual(connection.execute(
            "SELECT state,revoked_at FROM access_routes"
        ).fetchone(), ("active", None))
        self.assertEqual(connection.execute(
            "SELECT count(*) FROM access_grants"
        ).fetchone(), (1,))
        self.assertEqual(connection.execute(
            "SELECT count(*) FROM directory_outbox"
        ).fetchone(), (0,))

    def test_denial_commands_execute_and_normalize_identity(self) -> None:
        connection = self.database()
        add_sql = admin_sql.command_deny_add(
            argparse.Namespace(server_id=SERVER_ID.upper()),
        )
        connection.executescript(add_sql)
        self.assertEqual(
            connection.execute(
                "SELECT server_id FROM server_denials",
            ).fetchone(),
            (SERVER_ID,),
        )

        update_sql = admin_sql.command_deny_add(
            argparse.Namespace(server_id=SERVER_ID),
        )
        connection.executescript(update_sql)
        self.assertEqual(
            connection.execute(
                "SELECT server_id FROM server_denials WHERE server_id = ?",
                (SERVER_ID,),
            ).fetchone(),
            (SERVER_ID,),
        )

        remove_sql = admin_sql.command_deny_remove(
            argparse.Namespace(server_id=SERVER_ID),
        )
        connection.executescript(remove_sql)
        self.assertEqual(
            connection.execute("SELECT COUNT(*) FROM server_denials").fetchone(),
            (0,),
        )

    def test_pin_commands_are_profile_scoped_reviewable_and_reversible(self) -> None:
        connection = self.database()
        sql = admin_sql.command_pin_add(argparse.Namespace(
            profile="classic-v3",
            server_id=SERVER_ID.upper(),
            priority="7",
            expires_at="12345",
            note="operator's canary",
        ))
        self.assertIn("BEGIN TRANSACTION", sql)
        self.assertIn("operator''s canary", sql)
        connection.executescript(sql)
        self.assertEqual(
            connection.execute(
                "SELECT profile, server_id, priority, expires_at, note "
                "FROM directory_admin_pins"
            ).fetchone(),
            ("classic-v3", SERVER_ID, 7, 12345, "operator's canary"),
        )

        connection.executescript(admin_sql.command_pin_add(argparse.Namespace(
            profile="classic-v3",
            server_id=SERVER_ID,
            priority=0,
            expires_at=None,
            note="updated",
        )))
        self.assertEqual(
            connection.execute(
                "SELECT priority, expires_at, note FROM directory_admin_pins"
            ).fetchone(),
            (0, None, "updated"),
        )
        connection.executescript(admin_sql.command_pin_remove(argparse.Namespace(
            profile="classic-v3",
            server_id=SERVER_ID,
        )))
        self.assertEqual(
            connection.execute("SELECT count(*) FROM directory_admin_pins").fetchone(),
            (0,),
        )

    def test_global_classic_retirement_is_one_way_scoped_and_idempotent(self) -> None:
        connection = self.database()
        self.seed_server(connection, SERVER_ID)
        connection.execute(
            "INSERT INTO publisher_replay "
            "(server_id, profile, last_sequence, last_nonce, commit_token, updated_at) "
            "VALUES (?, 'classic-v2', '2', ?, ?, 2)",
            (OTHER_SERVER_ID, "2" * 32, OTHER_SERVER_ID),
        )
        connection.execute(
            "INSERT INTO server_presence "
            "(profile, server_id, last_seen, rendezvous_token_hash, "
            "rendezvous_generation) VALUES ('classic-v2', ?, 2, ?, ?)",
            (OTHER_SERVER_ID, "e" * 64, "d" * 64),
        )
        connection.execute(
            "INSERT INTO directory_entries "
            "(profile, server_id, name, players_count, version, text_comment, "
            "hostname, port, quic_cert_sha256, access_code_required, "
            "directory_fingerprint) VALUES "
            "('classic-v2', ?, 'V2', 1, '6.0', '', NULL, NULL, ?, 1, ?)",
            (OTHER_SERVER_ID, OTHER_SERVER_ID, "c" * 64),
        )
        v2_before = connection.execute(
            "SELECT * FROM publisher_replay WHERE profile = 'classic-v2'"
        ).fetchall(), connection.execute(
            "SELECT * FROM server_presence WHERE profile = 'classic-v2'"
        ).fetchall(), connection.execute(
            "SELECT * FROM directory_entries WHERE profile = 'classic-v2'"
        ).fetchall()
        sql = admin_sql.command_retire_classic_v1(argparse.Namespace(
            confirm=admin_sql.CLASSIC_V1_RETIREMENT_CONFIRMATION,
        ))
        connection.executescript(sql)
        connection.executescript(sql)

        self.assertEqual(connection.execute(
            "SELECT mode, activated_at IS NOT NULL FROM classic_receiver_mode"
        ).fetchone(), ("classic-v1-retired", 1))
        self.assertEqual(connection.execute(
            "SELECT count(*) FROM server_presence WHERE profile = 'classic-v1'"
        ).fetchone(), (0,))
        self.assertEqual(connection.execute(
            "SELECT count(*) FROM directory_entries WHERE profile = 'classic-v1'"
        ).fetchone(), (0,))
        self.assertEqual(connection.execute(
            "SELECT last_sequence FROM publisher_replay "
            "WHERE profile = 'classic-v1' AND server_id = ?", (SERVER_ID,)
        ).fetchone(), ("1",))
        self.assertEqual(connection.execute(
            "SELECT revision FROM directory_revisions WHERE profile = 'classic-v1'"
        ).fetchone(), (1,))
        self.assertEqual(v2_before, (
            connection.execute(
                "SELECT * FROM publisher_replay WHERE profile = 'classic-v2'"
            ).fetchall(),
            connection.execute(
                "SELECT * FROM server_presence WHERE profile = 'classic-v2'"
            ).fetchall(),
            connection.execute(
                "SELECT * FROM directory_entries WHERE profile = 'classic-v2'"
            ).fetchall(),
        ))

    def test_global_classic_retirement_requires_exact_human_gate(self) -> None:
        with self.assertRaisesRegex(ValueError, "human acceptance"):
            admin_sql.command_retire_classic_v1(argparse.Namespace(
                confirm="automatic",
            ))

    def test_rejects_invalid_operator_input(self) -> None:
        with self.assertRaisesRegex(ValueError, "server_id"):
            admin_sql.command_reset_identity(argparse.Namespace(server_id="bad"))
        with self.assertRaisesRegex(ValueError, "server_id"):
            admin_sql.command_deny_remove(argparse.Namespace(server_id=""))
        with self.assertRaisesRegex(ValueError, "NUL"):
            admin_sql.sql_string("bad\x00value")
        with self.assertRaisesRegex(ValueError, "profile"):
            admin_sql.command_pin_remove(argparse.Namespace(
                profile="unknown", server_id=SERVER_ID,
            ))
        with self.assertRaisesRegex(ValueError, "priority"):
            admin_sql.command_pin_add(argparse.Namespace(
                profile="classic-v3", server_id=SERVER_ID,
                priority="1001", expires_at=None, note="",
            ))
        with self.assertRaisesRegex(ValueError, "expires_at"):
            admin_sql.command_pin_add(argparse.Namespace(
                profile="classic-v3", server_id=SERVER_ID,
                priority="1", expires_at="not-a-time", note="",
            ))
        with self.assertRaisesRegex(ValueError, "control"):
            admin_sql.command_pin_add(argparse.Namespace(
                profile="classic-v3", server_id=SERVER_ID,
                priority="1", expires_at=None, note="bad\noperator",
            ))
        with self.assertRaisesRegex(ValueError, "surrogate"):
            admin_sql.command_pin_add(argparse.Namespace(
                profile="classic-v3", server_id=SERVER_ID,
                priority="1", expires_at=None, note="bad\ud800",
            ))


if __name__ == "__main__":
    unittest.main()
