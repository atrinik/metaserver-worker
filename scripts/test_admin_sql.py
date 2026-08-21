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

        sql = admin_sql.command_reset_identity(
            argparse.Namespace(server_id=SERVER_ID.upper()),
        )
        connection.executescript(sql)

        self.assertEqual(
            connection.execute(
                "SELECT profile, revision FROM directory_revisions ORDER BY profile"
            ).fetchall(),
            [("classic-v1", 1), ("classic-v2", 0), ("game-v1", 1)],
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
            [("classic-v1", 0), ("classic-v2", 0), ("game-v1", 0)],
        )
        self.assertEqual(
            connection.execute("SELECT count(*) FROM directory_outbox").fetchone(),
            (0,),
        )

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


if __name__ == "__main__":
    unittest.main()
