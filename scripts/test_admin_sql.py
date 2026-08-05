import argparse
import sqlite3
import unittest
from pathlib import Path

import admin_sql


SERVER_ID = "1" * 64
OTHER_SERVER_ID = "2" * 64
SCHEMA = Path(__file__).parents[1] / "migrations" / "0001_initial.sql"


class AdminSqlTest(unittest.TestCase):
    def database(self) -> sqlite3.Connection:
        connection = sqlite3.connect(":memory:")
        self.addCleanup(connection.close)
        connection.executescript(SCHEMA.read_text(encoding="utf-8"))
        return connection

    def seed_server(self, connection: sqlite3.Connection, server_id: str) -> None:
        connection.execute(
            """INSERT INTO server_owners
                   (server_id, auth_key, current_ip, ip_changed_at,
                    created_at, updated_at)
               VALUES (?, ?, '192.0.2.1', 1, 1, 1)""",
            (server_id, "a" * 128),
        )
        connection.execute(
            """INSERT INTO servers
                   (server_id, source_ip, name, players_count, version,
                    text_comment, last_seen, is_public, quic_host, quic_port,
                    quic_cert_sha256, password_required,
                    rendezvous_token_hash)
               VALUES (?, '192.0.2.1', 'Test', 0, '4.0.0', 'Test server',
                       1, 1, '192.0.2.1', 1730, ?, 0, ?)""",
            (server_id, server_id, "f" * 64),
        )

    def test_reset_owner_executes_and_is_scoped_to_one_identity(self) -> None:
        connection = self.database()
        self.seed_server(connection, SERVER_ID)
        self.seed_server(connection, OTHER_SERVER_ID)

        sql = admin_sql.command_reset_owner(
            argparse.Namespace(server_id=SERVER_ID.upper()),
        )
        connection.executescript(sql)

        for table in ("servers", "server_owners"):
            identities = connection.execute(
                f"SELECT server_id FROM {table} ORDER BY server_id",
            ).fetchall()
            self.assertEqual(identities, [(OTHER_SERVER_ID,)])

    def test_blacklist_commands_execute_and_escape_operator_input(self) -> None:
        connection = self.database()
        add_sql = admin_sql.command_blacklist_add(
            argparse.Namespace(pattern="1111*", reason="operator's test"),
        )
        connection.executescript(add_sql)
        self.assertEqual(
            connection.execute(
                "SELECT pattern, reason FROM server_blacklist",
            ).fetchone(),
            ("1111*", "operator's test"),
        )

        update_sql = admin_sql.command_blacklist_add(
            argparse.Namespace(pattern="1111*", reason="updated"),
        )
        connection.executescript(update_sql)
        self.assertEqual(
            connection.execute(
                "SELECT reason FROM server_blacklist WHERE pattern = '1111*'",
            ).fetchone(),
            ("updated",),
        )

        remove_sql = admin_sql.command_blacklist_remove(
            argparse.Namespace(pattern="1111*"),
        )
        connection.executescript(remove_sql)
        self.assertEqual(
            connection.execute("SELECT COUNT(*) FROM server_blacklist").fetchone(),
            (0,),
        )

    def test_rejects_invalid_operator_input(self) -> None:
        with self.assertRaisesRegex(ValueError, "server_id"):
            admin_sql.command_reset_owner(argparse.Namespace(server_id="bad"))
        with self.assertRaisesRegex(ValueError, "1-253"):
            admin_sql.command_blacklist_remove(argparse.Namespace(pattern=""))
        with self.assertRaisesRegex(ValueError, "NUL"):
            admin_sql.sql_string("bad\x00value")
        with self.assertRaisesRegex(ValueError, "at most 256"):
            admin_sql.command_blacklist_add(
                argparse.Namespace(pattern="1*", reason="x" * 257),
            )


if __name__ == "__main__":
    unittest.main()
