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
DIRECTORY_STATE_MIGRATION = (
    REPOSITORY_ROOT / "migrations" / "0005_directory_state.sql"
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


class DirectoryStateMigrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.database = sqlite3.connect(":memory:")
        self.addCleanup(self.database.close)
        self.database.execute("PRAGMA foreign_keys = ON")
        for migration in (
            INITIAL_MIGRATION,
            REQUEST_CONTROL_MIGRATION,
            RENDEZVOUS_GENERATION_MIGRATION,
            SIGNED_PUBLISHER_MIGRATION,
        ):
            self.database.executescript(migration.read_text(encoding="utf-8"))

    def apply_directory_state_migration(self) -> None:
        self.database.commit()
        self.database.executescript(
            DIRECTORY_STATE_MIGRATION.read_text(encoding="utf-8")
        )

    def seed_owner(
        self,
        server_id: str,
        *,
        address: str = "192.0.2.10",
        authentication_kind: str = "signed-certificate-v1",
        generation: str = "a" * 64,
    ) -> None:
        self.database.execute(
            """
            INSERT INTO server_owners
                (server_id, auth_key, current_ip, ip_changed_at,
                 created_at, updated_at, rendezvous_generation,
                 authentication_kind)
            VALUES (?, ?, ?, 100, 10, 100, ?, ?)
            """,
            (
                server_id,
                "f" * 128,
                address,
                generation,
                authentication_kind,
            ),
        )

    def seed_legacy_server(
        self,
        server_id: str,
        *,
        is_public: int,
        last_seen: int = 100,
        source_address: str = "198.51.100.10",
        direct_host: str = "203.0.113.10",
        token_hash: str = "b" * 64,
        generation: str = "a" * 64,
        fingerprint: str = "d" * 64,
    ) -> None:
        self.database.execute(
            """
            INSERT INTO servers
                (server_id, source_ip, name, players_count, version,
                 text_comment, last_seen, is_public, quic_host, quic_port,
                 quic_cert_sha256, password_required,
                 rendezvous_token_hash, rendezvous_generation,
                 directory_fingerprint)
            VALUES (?, ?, ?, 2, '4.0.0', 'migration comment', ?, ?, ?, 1730,
                    ?, 1, ?, ?, ?)
            """,
            (
                server_id,
                source_address,
                f"Server {server_id[-4:]}",
                last_seen,
                is_public,
                direct_host,
                server_id,
                token_hash,
                generation,
                fingerprint,
            ),
        )

    def seed_replay(
        self,
        server_id: str,
        profile: str,
        sequence: str,
        nonce: str,
    ) -> None:
        self.database.execute(
            """
            INSERT INTO publisher_replay
                (server_id, profile, last_sequence, last_nonce,
                 commit_token, updated_at)
            VALUES (?, ?, ?, ?, ?, 100)
            """,
            (server_id, profile, sequence, nonce, "e" * 64),
        )
        self.database.execute(
            """
            INSERT INTO publisher_nonces
                (server_id, profile, nonce, expires_at, created_at)
            VALUES (?, ?, ?, 200, 100)
            """,
            (server_id, profile, nonce),
        )

    def seed_presence(
        self,
        server_id: str,
        profile: str = "classic-v1",
    ) -> None:
        self.database.execute(
            """
            INSERT INTO server_presence
                (profile, server_id, last_seen, rendezvous_token_hash,
                 rendezvous_generation)
            VALUES (?, ?, 100, ?, ?)
            """,
            (profile, server_id, "b" * 64, "a" * 64),
        )

    def seed_entry(
        self,
        server_id: str,
        profile: str = "classic-v1",
        hostname: str | None = None,
        port: int | None = None,
    ) -> None:
        self.database.execute(
            """
            INSERT INTO directory_entries
                (profile, server_id, name, players_count, version,
                 text_comment, hostname, port, quic_cert_sha256,
                 password_required, directory_fingerprint)
            VALUES (?, ?, 'Public server', 2, '4.0.0', 'Ready', ?, ?, ?, 0, ?)
            """,
            (profile, server_id, hostname, port, server_id, "d" * 64),
        )

    def test_populated_upgrade_separates_presence_from_public_entries(self) -> None:
        public_id = "1" * 64
        private_id = "2" * 64
        self.seed_owner(public_id, address="192.0.2.1")
        self.seed_owner(private_id, address="2001:db8::2")
        self.seed_legacy_server(public_id, is_public=1, last_seen=150)
        self.seed_legacy_server(private_id, is_public=0, last_seen=275)
        self.seed_replay(public_id, "classic-v1", "7", "1" * 32)
        self.seed_replay(public_id, "game-v1", "8", "2" * 32)
        self.seed_replay(private_id, "classic-v1", "9", "3" * 32)
        self.database.execute(
            "UPDATE directory_revisions SET revision = 7, updated_at = 200 "
            "WHERE profile = 'classic-v1'"
        )
        self.database.execute(
            "INSERT INTO directory_outbox (profile, revision, created_at) "
            "VALUES ('classic-v1', 7, 200)"
        )
        replay_before = self.database.execute(
            "SELECT * FROM publisher_replay ORDER BY server_id, profile"
        ).fetchall()
        nonces_before = self.database.execute(
            "SELECT * FROM publisher_nonces ORDER BY server_id, profile, nonce"
        ).fetchall()

        self.apply_directory_state_migration()

        self.assertEqual(
            self.database.execute(
                "SELECT server_id, auth_key, current_ip, ip_changed_at, "
                "created_at, updated_at, rendezvous_generation, "
                "authentication_kind FROM server_owners ORDER BY server_id"
            ).fetchall(),
            [
                (
                    public_id,
                    "f" * 128,
                    "",
                    0,
                    10,
                    100,
                    "a" * 64,
                    "signed-certificate-v1",
                ),
                (
                    private_id,
                    "f" * 128,
                    "",
                    0,
                    10,
                    100,
                    "a" * 64,
                    "signed-certificate-v1",
                ),
            ],
        )
        self.assertEqual(
            self.database.execute(
                "SELECT profile, server_id, last_seen, rendezvous_token_hash, "
                "rendezvous_generation FROM server_presence "
                "ORDER BY profile, server_id"
            ).fetchall(),
            [
                ("classic-v1", public_id, 150, "b" * 64, "a" * 64),
                ("classic-v1", private_id, 275, "b" * 64, "a" * 64),
            ],
        )
        self.assertEqual(
            self.database.execute(
                "SELECT profile, server_id, name, players_count, version, "
                "text_comment, hostname, port, quic_cert_sha256, "
                "password_required, directory_fingerprint "
                "FROM directory_entries"
            ).fetchall(),
            [
                (
                    "classic-v1",
                    public_id,
                    "Server 1111",
                    2,
                    "4.0.0",
                    "migration comment",
                    None,
                    None,
                    public_id,
                    1,
                    "0" * 64,
                )
            ],
        )
        self.assertEqual(
            self.database.execute(
                "SELECT server_id, source_ip, quic_host, quic_port "
                "FROM servers ORDER BY server_id"
            ).fetchall(),
            [(public_id, "", "", 1)],
        )
        self.assertEqual(
            self.database.execute(
                "SELECT profile, revision, updated_at "
                "FROM directory_revisions ORDER BY profile"
            ).fetchall(),
            [("classic-v1", 8, 200), ("game-v1", 0, 0)],
        )
        self.assertEqual(
            self.database.execute(
                "SELECT profile, revision, created_at "
                "FROM directory_outbox ORDER BY profile, revision"
            ).fetchall(),
            [("classic-v1", 7, 200), ("classic-v1", 8, 200)],
        )
        self.assertEqual(
            self.database.execute(
                "SELECT * FROM publisher_replay ORDER BY server_id, profile"
            ).fetchall(),
            replay_before,
        )
        self.assertEqual(
            self.database.execute(
                "SELECT * FROM publisher_nonces "
                "ORDER BY server_id, profile, nonce"
            ).fetchall(),
            nonces_before,
        )
        self.assertEqual(self.database.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_private_only_upgrade_retains_minimal_revision_neutral_presence(self) -> None:
        private_id = "2" * 64
        self.seed_owner(private_id)
        self.seed_legacy_server(private_id, is_public=0)

        self.apply_directory_state_migration()

        self.assertEqual(
            self.database.execute(
                "SELECT profile, server_id, last_seen, rendezvous_token_hash, "
                "rendezvous_generation FROM server_presence"
            ).fetchone(),
            ("classic-v1", private_id, 100, "b" * 64, "a" * 64),
        )
        self.assertEqual(
            self.database.execute("SELECT count(*) FROM directory_entries").fetchone(),
            (0,),
        )
        self.assertEqual(
            self.database.execute("SELECT count(*) FROM servers").fetchone(),
            (0,),
        )
        self.assertEqual(
            self.database.execute(
                "SELECT profile, revision, updated_at "
                "FROM directory_revisions ORDER BY profile"
            ).fetchall(),
            [("classic-v1", 0, 0), ("game-v1", 0, 0)],
        )
        self.assertEqual(
            self.database.execute("SELECT count(*) FROM directory_outbox").fetchone(),
            (0,),
        )

    def test_new_schema_is_exact_and_profile_scoped(self) -> None:
        self.apply_directory_state_migration()

        def columns(table: str) -> list[tuple[object, ...]]:
            return [
                (row[1], row[2], row[3], row[5])
                for row in self.database.execute(f"PRAGMA table_info({table})")
            ]

        self.assertEqual(
            columns("server_presence"),
            [
                ("profile", "TEXT", 1, 1),
                ("server_id", "TEXT", 1, 2),
                ("last_seen", "INTEGER", 1, 0),
                ("rendezvous_token_hash", "TEXT", 1, 0),
                ("rendezvous_generation", "TEXT", 1, 0),
                ("publication_commit_token", "TEXT", 1, 0),
                ("publication_base_revision", "INTEGER", 1, 0),
                ("publication_visible_revision", "INTEGER", 0, 0),
            ],
        )
        self.assertEqual(
            columns("directory_entries"),
            [
                ("profile", "TEXT", 1, 1),
                ("server_id", "TEXT", 1, 2),
                ("name", "TEXT", 1, 0),
                ("players_count", "INTEGER", 1, 0),
                ("version", "TEXT", 1, 0),
                ("text_comment", "TEXT", 1, 0),
                ("hostname", "TEXT", 0, 0),
                ("port", "INTEGER", 0, 0),
                ("quic_cert_sha256", "TEXT", 1, 0),
                ("password_required", "INTEGER", 1, 0),
                ("directory_fingerprint", "TEXT", 1, 0),
            ],
        )
        self.assertNotIn(
            "last_seen",
            [column[0] for column in columns("directory_entries")],
        )
        self.assertEqual(
            [
                row[2:8]
                for row in self.database.execute(
                    "PRAGMA foreign_key_list(directory_entries)"
                )
            ],
            [
                ("server_presence", "profile", "profile", "NO ACTION", "CASCADE", "NONE"),
                ("server_presence", "server_id", "server_id", "NO ACTION", "CASCADE", "NONE"),
            ],
        )
        self.assertEqual(
            [
                row[2:8]
                for row in self.database.execute(
                    "PRAGMA foreign_key_list(server_presence)"
                )
            ],
            [
                ("server_owners", "server_id", "server_id", "NO ACTION", "CASCADE", "NONE")
            ],
        )
        self.assertEqual(
            [
                row[2]
                for row in self.database.execute(
                    "PRAGMA index_info(server_presence_last_seen_idx)"
                )
            ],
            ["profile", "last_seen", "server_id"],
        )

        server_id = "1" * 64
        self.seed_owner(server_id)
        for profile in ("classic-v1", "game-v1"):
            self.seed_presence(server_id, profile)
            self.seed_entry(server_id, profile)
        self.database.execute(
            "DELETE FROM server_presence "
            "WHERE profile = 'classic-v1' AND server_id = ?",
            (server_id,),
        )
        self.assertEqual(
            self.database.execute(
                "SELECT profile, server_id FROM server_presence"
            ).fetchall(),
            [("game-v1", server_id)],
        )
        self.assertEqual(
            self.database.execute(
                "SELECT profile, server_id FROM directory_entries"
            ).fetchall(),
            [("game-v1", server_id)],
        )
        self.database.execute(
            "DELETE FROM server_owners WHERE server_id = ?", (server_id,)
        )
        self.assertEqual(
            self.database.execute("SELECT count(*) FROM server_presence").fetchone(),
            (0,),
        )
        self.assertEqual(
            self.database.execute("SELECT count(*) FROM directory_entries").fetchone(),
            (0,),
        )

    def test_constraints_reject_noncanonical_state(self) -> None:
        self.apply_directory_state_migration()
        server_id = "1" * 64
        self.seed_owner(server_id)
        self.seed_presence(server_id)
        self.seed_entry(server_id, hostname="play.example.test", port=1730)

        invalid_presence_updates = (
            "profile = 'unknown'",
            "server_id = 'invalid'",
            "last_seen = -1",
            "last_seen = 1.5",
            "last_seen = 9007199254740992",
            "rendezvous_token_hash = 'invalid'",
            "rendezvous_generation = 'A' || substr(rendezvous_generation, 2)",
        )
        for assignment in invalid_presence_updates:
            with self.subTest(presence=assignment), self.assertRaises(
                sqlite3.IntegrityError
            ):
                self.database.execute(
                    f"UPDATE server_presence SET {assignment} "
                    "WHERE profile = 'classic-v1' AND server_id = ?",
                    (server_id,),
                )

        invalid_entry_updates = (
            "name = ''",
            "name = '" + "n" * 81 + "'",
            "players_count = -1",
            "players_count = 4294967296",
            "players_count = 1.5",
            "version = ''",
            "version = '" + "v" * 33 + "'",
            "text_comment = '" + "c" * 257 + "'",
            "name = 'invalid\ufffecharacter'",
            "text_comment = 'invalid\uffffcharacter'",
            "quic_cert_sha256 = '" + "2" * 64 + "'",
            "password_required = 2",
            "password_required = 0.5",
            "directory_fingerprint = 'invalid'",
            "hostname = NULL",
            "port = NULL",
            "port = 0",
            "port = 65536",
            "port = 1.5",
        )
        for assignment in invalid_entry_updates:
            with self.subTest(entry=assignment), self.assertRaises(
                sqlite3.IntegrityError
            ):
                self.database.execute(
                    f"UPDATE directory_entries SET {assignment} "
                    "WHERE profile = 'classic-v1' AND server_id = ?",
                    (server_id,),
                )

        for column, value in (
            ("name", "é" * 41),
            ("version", "é" * 17),
            ("text_comment", "é" * 129),
            ("name", "bad\nname"),
            ("version", "bad\x7fversion"),
            ("text_comment", "bad\x00comment"),
        ):
            with self.subTest(text_column=column, text=value), self.assertRaises(
                sqlite3.IntegrityError
            ):
                self.database.execute(
                    f"UPDATE directory_entries SET {column} = ? "
                    "WHERE profile = 'classic-v1' AND server_id = ?",
                    (value, server_id),
                )

        invalid_hostnames = (
            "localhost",
            "PLAY.example.test",
            "play_example.test",
            "play..example",
            "-play.example",
            "play-.example",
            "play.example.",
            "192.0.2.1",
            "127.1",
            "0177.0.0.1",
            "0x7f.0x0.0x0.0x1",
            "2001:db8::1",
            "x" * 64 + ".example",
        )
        for hostname in invalid_hostnames:
            with self.subTest(hostname=hostname), self.assertRaises(
                sqlite3.IntegrityError
            ):
                self.database.execute(
                    "UPDATE directory_entries SET hostname = ? "
                    "WHERE profile = 'classic-v1' AND server_id = ?",
                    (hostname, server_id),
                )

        for hostname in (
            "play.example.test",
            "xn--bcher-kva.example.org",
            "123.example",
            "0x7f.example",
            "0x.test",
        ):
            with self.subTest(valid_hostname=hostname):
                self.database.execute(
                    "UPDATE directory_entries SET hostname = ?, port = 65535 "
                    "WHERE profile = 'classic-v1' AND server_id = ?",
                    (hostname, server_id),
                )

    def test_preflight_rejects_invalid_or_orphaned_legacy_rows_before_schema_changes(
        self,
    ) -> None:
        server_id = "1" * 64
        self.seed_owner(server_id)
        self.seed_legacy_server(server_id, is_public=1)
        self.database.execute(
            "UPDATE servers SET name = ? WHERE server_id = ?",
            ("invalid\x00suffix", server_id),
        )

        with self.assertRaises(sqlite3.IntegrityError):
            self.apply_directory_state_migration()

        self.assertEqual(
            self.database.execute(
                "SELECT name FROM sqlite_master "
                "WHERE type = 'table' AND name = 'server_presence'"
            ).fetchone(),
            None,
        )
        self.assertEqual(
            self.database.execute(
                "SELECT current_ip FROM server_owners WHERE server_id = ?",
                (server_id,),
            ).fetchone(),
            ("192.0.2.10",),
        )
        self.assertEqual(
            self.database.execute(
                "SELECT source_ip, quic_host FROM servers WHERE server_id = ?",
                (server_id,),
            ).fetchone(),
            ("198.51.100.10", "203.0.113.10"),
        )

        self.database.execute(
            "UPDATE servers SET name = ? WHERE server_id = ?",
            ("invalid\uffff", server_id),
        )
        with self.assertRaises(sqlite3.IntegrityError):
            self.apply_directory_state_migration()

        self.database.execute(
            "UPDATE servers SET name = 'Valid server' WHERE server_id = ?",
            (server_id,),
        )
        self.database.commit()
        self.database.execute("PRAGMA foreign_keys = OFF")
        self.database.execute(
            "DELETE FROM server_owners WHERE server_id = ?", (server_id,)
        )
        self.database.commit()
        self.database.execute("PRAGMA foreign_keys = ON")

        with self.assertRaises(sqlite3.IntegrityError):
            self.apply_directory_state_migration()

        self.assertEqual(
            self.database.execute(
                "SELECT name FROM sqlite_master "
                "WHERE type = 'table' AND name = 'server_presence'"
            ).fetchone(),
            None,
        )
        self.assertEqual(
            self.database.execute(
                "SELECT source_ip, quic_host FROM servers WHERE server_id = ?",
                (server_id,),
            ).fetchone(),
            ("198.51.100.10", "203.0.113.10"),
        )

        self.seed_owner(server_id)
        self.apply_directory_state_migration()
        self.assertEqual(
            self.database.execute(
                "SELECT profile, server_id FROM server_presence"
            ).fetchone(),
            ("classic-v1", server_id),
        )

    def test_backfill_fails_closed_above_capacity_and_runtime_remains_bounded(self) -> None:
        server_ids = [f"{number:064x}" for number in range(513)]
        for index, server_id in enumerate(server_ids):
            self.seed_owner(server_id)
            self.seed_legacy_server(
                server_id,
                is_public=0 if index == 512 else 1,
                last_seen=100,
            )

        with self.assertRaises(sqlite3.IntegrityError):
            self.apply_directory_state_migration()

        self.assertEqual(
            self.database.execute(
                "SELECT name FROM sqlite_master "
                "WHERE type = 'table' AND name = 'server_presence'"
            ).fetchone(),
            None,
        )
        self.assertEqual(
            self.database.execute(
                "SELECT count(*), sum(is_public) FROM servers"
            ).fetchone(),
            (513, 512),
        )
        self.assertEqual(
            self.database.execute(
                "SELECT owners.current_ip, owners.ip_changed_at, "
                "servers.source_ip, servers.quic_host, servers.quic_port "
                "FROM server_owners AS owners "
                "JOIN servers USING (server_id) "
                "WHERE owners.server_id = ?",
                (server_ids[0],),
            ).fetchone(),
            ("192.0.2.10", 100, "198.51.100.10", "203.0.113.10", 1730),
        )

        self.database.execute(
            "DELETE FROM servers WHERE server_id = ?", (server_ids[-1],)
        )
        self.database.execute(
            "DELETE FROM server_owners WHERE server_id = ?", (server_ids[-1],)
        )
        self.apply_directory_state_migration()

        migrated_ids = [
            row[0]
            for row in self.database.execute(
                "SELECT server_id FROM server_presence "
                "WHERE profile = 'classic-v1' ORDER BY server_id"
            )
        ]
        self.assertEqual(migrated_ids, server_ids[:512])
        self.assertEqual(
            self.database.execute(
                "SELECT count(*) FROM directory_entries "
                "WHERE profile = 'classic-v1'"
            ).fetchone(),
            (512,),
        )
        self.assertEqual(
            self.database.execute(
                "SELECT revision FROM directory_revisions "
                "WHERE profile = 'classic-v1'"
            ).fetchone(),
            (1,),
        )
        overflow_id = "f" * 64
        self.seed_owner(overflow_id)
        with self.assertRaises(sqlite3.IntegrityError):
            self.seed_presence(overflow_id)
        self.seed_presence(overflow_id, "game-v1")
        self.database.execute(
            "UPDATE server_presence SET last_seen = 101 "
            "WHERE profile = 'classic-v1' AND server_id = ?",
            (server_ids[0],),
        )
        self.assertEqual(
            self.database.execute(
                "SELECT count(*) FROM server_presence "
                "WHERE profile = 'game-v1'"
            ).fetchone(),
            (1,),
        )


if __name__ == "__main__":
    unittest.main()
