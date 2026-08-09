import sqlite3
import unittest
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
INITIAL_MIGRATION = REPOSITORY_ROOT / "migrations" / "0001_initial.sql"
REQUEST_CONTROL_MIGRATION = (
    REPOSITORY_ROOT / "migrations" / "0002_request_control.sql"
)
RENDEZVOUS_GENERATION_MIGRATION = (
    REPOSITORY_ROOT / "migrations" / "0003_rendezvous_generation.sql"
)
SIGNED_PUBLISHER_MIGRATION = (
    REPOSITORY_ROOT / "migrations" / "0004_signed_publisher.sql"
)


class RequestControlMigrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.database = sqlite3.connect(":memory:")
        self.addCleanup(self.database.close)
        self.database.executescript(INITIAL_MIGRATION.read_text(encoding="utf-8"))

    def populate_initial_schema(self) -> dict[str, list[tuple[object, ...]]]:
        server_id = "1" * 64
        now = 1_786_147_200
        self.database.execute(
            """
            INSERT INTO server_owners
                (server_id, auth_key, current_ip, ip_changed_at,
                 created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (server_id, "a" * 128, "192.0.2.10", now, now, now),
        )
        self.database.execute(
            """
            INSERT INTO servers
                (server_id, source_ip, name, players_count, version,
                 text_comment, last_seen, is_public, quic_host, quic_port,
                 quic_cert_sha256, password_required, rendezvous_token_hash)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                server_id,
                "192.0.2.10",
                "Migration test",
                2,
                "4.0.0",
                "preserve me",
                now,
                1,
                "play.example.test",
                1730,
                server_id,
                0,
                "b" * 64,
            ),
        )
        self.database.execute(
            """
            INSERT INTO one_time_tokens
                (token_hash, source_ip, expires_at, created_at)
            VALUES (?, ?, ?, ?)
            """,
            ("c" * 64, "192.0.2.10", now + 60, now),
        )
        self.database.execute(
            """
            INSERT INTO rate_limits
                (source_ip, scope, window_start, request_count)
            VALUES (?, ?, ?, ?)
            """,
            ("192.0.2.10", "update", now, 2),
        )
        self.database.execute(
            """
            INSERT INTO server_blacklist (pattern, reason, created_at)
            VALUES (?, ?, ?)
            """,
            ("blocked-server", "migration test", now),
        )
        self.database.commit()

        tables = (
            "server_owners",
            "servers",
            "one_time_tokens",
            "rate_limits",
            "server_blacklist",
        )
        return {
            table: self.database.execute(
                f"SELECT * FROM {table} ORDER BY 1"  # noqa: S608 - fixed tuple above
            ).fetchall()
            for table in tables
        }

    def test_populated_initial_schema_is_preserved(self) -> None:
        before = self.populate_initial_schema()

        self.database.executescript(
            REQUEST_CONTROL_MIGRATION.read_text(encoding="utf-8")
        )

        for table, expected_rows in before.items():
            with self.subTest(table=table):
                if table == "one_time_tokens":
                    expected_rows = [row + (None, None) for row in expected_rows]
                self.assertEqual(
                    self.database.execute(
                        f"SELECT * FROM {table} ORDER BY 1"
                    ).fetchall(),
                    expected_rows,
                )
        self.assertEqual(
            self.database.execute("SELECT COUNT(*) FROM request_budgets").fetchone(),
            (0,),
        )

    def test_request_budget_schema_rejects_raw_addresses(self) -> None:
        self.database.executescript(
            REQUEST_CONTROL_MIGRATION.read_text(encoding="utf-8")
        )
        insert = """
            INSERT INTO request_budgets
                (actor_key, scope, window_start, request_count, expires_at)
            VALUES (?, 'compat-directory', 0, 1, 60)
        """
        for address in ("192.0.2.10", "2001:db8::10"):
            with self.subTest(address=address), self.assertRaises(
                sqlite3.IntegrityError
            ):
                self.database.execute(insert, (address,))

        self.database.execute(
            insert,
            ("v1.current." + "A" * 43,),
        )
        self.database.execute(insert, ("1" * 64,))
        self.assertEqual(
            self.database.execute("SELECT COUNT(*) FROM request_budgets").fetchone(),
            (2,),
        )

    def test_rendezvous_generation_preserves_populated_listings(self) -> None:
        populated = self.populate_initial_schema()
        owner_before = populated["server_owners"][0]
        server_before = populated["servers"][0]
        self.database.executescript(
            REQUEST_CONTROL_MIGRATION.read_text(encoding="utf-8")
        )
        self.database.executescript(
            RENDEZVOUS_GENERATION_MIGRATION.read_text(encoding="utf-8")
        )

        stored = self.database.execute(
            "SELECT * FROM servers WHERE server_id = ?", ("1" * 64,)
        ).fetchone()
        self.assertEqual(stored, server_before + ("0" * 64,))
        owner = self.database.execute(
            "SELECT * FROM server_owners WHERE server_id = ?", ("1" * 64,)
        ).fetchone()
        self.assertEqual(owner, owner_before + ("0" * 64,))
        for table in ("server_owners", "servers"):
            with self.subTest(table=table), self.assertRaises(
                sqlite3.IntegrityError
            ):
                self.database.execute(
                    f"UPDATE {table} SET rendezvous_generation = 'invalid'"
                )
            self.database.execute(
                f"UPDATE {table} SET rendezvous_generation = ?", ("d" * 64,)
            )
        self.assertEqual(
            self.database.execute(
                "SELECT owners.rendezvous_generation, servers.rendezvous_generation "
                "FROM server_owners AS owners "
                "JOIN servers USING (server_id)"
            ).fetchone(),
            ("d" * 64, "d" * 64),
        )

    def test_transitional_token_sources_are_mutually_exclusive(self) -> None:
        self.database.executescript(
            REQUEST_CONTROL_MIGRATION.read_text(encoding="utf-8")
        )
        tagged_source = "v1.current." + "A" * 43
        previous_source = "v1.previous." + "B" * 43
        insert = """
            INSERT INTO one_time_tokens
                (token_hash, source_ip, expires_at, created_at, source_tag,
                 source_tag_previous)
            VALUES (?, ?, 60, 0, ?, ?)
        """

        self.database.execute(insert, ("legacy", "192.0.2.10", None, None))
        self.database.execute(
            insert, ("tagged", "", tagged_source, previous_source)
        )
        for values in (
            ("both", "192.0.2.10", tagged_source, previous_source),
            ("neither", "", None, None),
            ("one-tag", "", tagged_source, None),
            ("same-tag", "", tagged_source, tagged_source),
            ("same-key-id", "", tagged_source, "v1.current." + "B" * 43),
            ("malformed-current", "", "v1.current.invalid", previous_source),
            ("malformed-previous", "", tagged_source, "v1.previous.invalid"),
        ):
            with self.subTest(token=values[0]), self.assertRaises(
                sqlite3.IntegrityError
            ):
                self.database.execute(insert, values)

        self.assertEqual(
            self.database.execute(
                "SELECT token_hash, source_ip, source_tag, source_tag_previous "
                "FROM one_time_tokens ORDER BY token_hash"
            ).fetchall(),
            [
                ("legacy", "192.0.2.10", None, None),
                ("tagged", "", tagged_source, previous_source),
            ],
        )

        self.database.execute(
            "UPDATE one_time_tokens SET expires_at = 120 "
            "WHERE token_hash = 'tagged'"
        )
        invalid_updates = (
            (
                "legacy-one-tag",
                "UPDATE one_time_tokens SET source_ip = '', source_tag = ? "
                "WHERE token_hash = 'legacy'",
                (tagged_source,),
            ),
            (
                "dual-identical-tags",
                "UPDATE one_time_tokens SET source_tag_previous = source_tag "
                "WHERE token_hash = 'tagged'",
                (),
            ),
            (
                "dual-with-raw-source",
                "UPDATE one_time_tokens SET source_ip = '192.0.2.10' "
                "WHERE token_hash = 'tagged'",
                (),
            ),
        )
        for label, sql, parameters in invalid_updates:
            with self.subTest(update=label), self.assertRaises(
                sqlite3.IntegrityError
            ):
                self.database.execute(sql, parameters)

        self.assertEqual(
            self.database.execute(
                "SELECT token_hash, source_ip, source_tag, "
                "source_tag_previous, expires_at "
                "FROM one_time_tokens ORDER BY token_hash"
            ).fetchall(),
            [
                ("legacy", "192.0.2.10", None, None, 60),
                ("tagged", "", tagged_source, previous_source, 120),
            ],
        )

    def test_source_tag_key_id_length_boundaries(self) -> None:
        self.database.executescript(
            REQUEST_CONTROL_MIGRATION.read_text(encoding="utf-8")
        )
        insert = """
            INSERT INTO one_time_tokens
                (token_hash, source_ip, expires_at, created_at, source_tag,
                 source_tag_previous)
            VALUES (?, '', 60, 0, ?, ?)
        """
        for label, current_id, previous_id in (
            ("minimum", "a", "b"),
            ("maximum", "a" * 32, "b" * 32),
        ):
            with self.subTest(boundary=label):
                self.database.execute(
                    insert,
                    (
                        label,
                        f"v1.{current_id}." + "A" * 43,
                        f"v1.{previous_id}." + "B" * 43,
                    ),
                )

        self.assertEqual(
            self.database.execute(
                "SELECT token_hash FROM one_time_tokens ORDER BY token_hash"
            ).fetchall(),
            [("maximum",), ("minimum",)],
        )

    def test_signed_publisher_schema_preserves_rows_and_bounds_replay(self) -> None:
        populated = self.populate_initial_schema()
        self.database.executescript(
            REQUEST_CONTROL_MIGRATION.read_text(encoding="utf-8")
        )
        self.database.executescript(
            RENDEZVOUS_GENERATION_MIGRATION.read_text(encoding="utf-8")
        )
        self.database.executescript(
            SIGNED_PUBLISHER_MIGRATION.read_text(encoding="utf-8")
        )

        owner = self.database.execute(
            "SELECT authentication_kind FROM server_owners WHERE server_id = ?",
            ("1" * 64,),
        ).fetchone()
        fingerprint = self.database.execute(
            "SELECT directory_fingerprint FROM servers WHERE server_id = ?",
            ("1" * 64,),
        ).fetchone()
        self.assertEqual(owner, ("compat-key-v1",))
        self.assertEqual(fingerprint, ("0" * 64,))
        self.assertEqual(
            self.database.execute(
                "SELECT profile, revision, updated_at "
                "FROM directory_revisions ORDER BY profile"
            ).fetchall(),
            [("classic-v1", 0, 0), ("game-v1", 0, 0)],
        )

        insert_replay = """
            INSERT INTO publisher_replay
                (server_id, profile, last_sequence, last_nonce,
                 commit_token, updated_at)
            VALUES (?, 'classic-v1', ?, ?, ?, 1)
        """
        nonce = "1" * 32
        self.database.execute(
            insert_replay,
            ("2" * 64, "18446744073709551615", nonce, "3" * 64),
        )
        self.database.execute(
            "INSERT INTO publisher_nonces "
            "(server_id, profile, nonce, expires_at, created_at) "
            "VALUES (?, 'classic-v1', ?, 86400, 0)",
            ("2" * 64, nonce),
        )
        for label, sequence in (
            ("zero", "0"),
            ("leading-zero", "01"),
            ("overflow", "18446744073709551616"),
            ("nondigit", "1x"),
        ):
            with self.subTest(sequence=label), self.assertRaises(
                sqlite3.IntegrityError
            ):
                self.database.execute(
                    insert_replay,
                    ("4" * 64, sequence, "2" * 32, "5" * 64),
                )

        self.assertEqual(populated["server_owners"][0][0], "1" * 64)
        with self.assertRaises(sqlite3.IntegrityError):
            self.database.execute(
                "UPDATE server_owners SET authentication_kind = 'unknown'"
            )
        with self.assertRaises(sqlite3.IntegrityError):
            self.database.execute(
                "UPDATE servers SET directory_fingerprint = 'invalid'"
            )


if __name__ == "__main__":
    unittest.main()
