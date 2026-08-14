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
DIRECTORY_ARTIFACTS_MIGRATION = (
    REPOSITORY_ROOT / "migrations" / "0006_directory_artifacts.sql"
)
GAME_PUBLISHER_MIGRATION = (
    REPOSITORY_ROOT / "migrations" / "0007_game_publisher.sql"
)
RENDEZVOUS_COOLDOWN_MIGRATION = (
    REPOSITORY_ROOT / "migrations" / "0008_rendezvous_client_cooldowns.sql"
)
LEGACY_STORAGE_REMOVAL_MIGRATION = (
    REPOSITORY_ROOT / "migrations" / "0009_remove_legacy_storage.sql"
)
CLASSIC_ACCESS_CODE_MIGRATION = (
    REPOSITORY_ROOT / "migrations" / "0010_classic_access_code.sql"
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
        self.assertEqual(
            self.database.execute("PRAGMA foreign_key_check").fetchall(),
            [],
        )

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


class DirectoryArtifactsMigrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.database = sqlite3.connect(":memory:")
        self.addCleanup(self.database.close)
        for migration in (
            INITIAL_MIGRATION,
            REQUEST_CONTROL_MIGRATION,
            RENDEZVOUS_GENERATION_MIGRATION,
            SIGNED_PUBLISHER_MIGRATION,
            DIRECTORY_STATE_MIGRATION,
        ):
            self.database.executescript(migration.read_text(encoding="utf-8"))

    def test_adds_exact_unpublished_profile_checkpoints(self) -> None:
        before_revisions = self.database.execute(
            "SELECT * FROM directory_revisions ORDER BY profile"
        ).fetchall()
        self.database.executescript(
            DIRECTORY_ARTIFACTS_MIGRATION.read_text(encoding="utf-8")
        )

        self.assertEqual(
            self.database.execute(
                "SELECT profile, published_revision, generation, "
                "generated_at, expires_at, html_bytes, xml_bytes, "
                "json_bytes, manifest_bytes, published_at "
                "FROM directory_artifact_publications ORDER BY profile"
            ).fetchall(),
            [
                ("classic-v1", 0, 0, 0, 0, 0, 0, 0, 0, 0),
                ("game-v1", 0, 0, 0, 0, 0, 0, 0, 0, 0),
            ],
        )
        self.assertEqual(
            self.database.execute(
                "SELECT * FROM directory_revisions ORDER BY profile"
            ).fetchall(),
            before_revisions,
        )
        self.assertEqual(
            self.database.execute(
                "SELECT count(*) FROM directory_artifact_commits"
            ).fetchone(),
            (0,),
        )
        self.assertEqual(
            self.database.execute(
                "SELECT count(*) FROM directory_artifact_history"
            ).fetchone(),
            (0,),
        )

    def test_coalesces_existing_and_future_outbox_rows_per_profile(self) -> None:
        self.database.executemany(
            "INSERT INTO directory_outbox (profile, revision, created_at) "
            "VALUES (?, ?, ?)",
            [
                ("classic-v1", 1, 10),
                ("classic-v1", 2, 20),
                ("game-v1", 1, 30),
            ],
        )
        self.database.executescript(
            DIRECTORY_ARTIFACTS_MIGRATION.read_text(encoding="utf-8")
        )
        self.assertEqual(
            self.database.execute(
                "SELECT profile, revision FROM directory_outbox "
                "ORDER BY profile"
            ).fetchall(),
            [("classic-v1", 2), ("game-v1", 1)],
        )

        self.database.execute(
            "INSERT INTO directory_outbox (profile, revision, created_at) "
            "VALUES ('classic-v1', 3, 40)"
        )
        self.assertEqual(
            self.database.execute(
                "SELECT profile, revision FROM directory_outbox "
                "ORDER BY profile"
            ).fetchall(),
            [("classic-v1", 3), ("game-v1", 1)],
        )

    def test_checkpoint_constraints_fail_closed(self) -> None:
        self.database.executescript(
            DIRECTORY_ARTIFACTS_MIGRATION.read_text(encoding="utf-8")
        )
        for mutation in (
            "generation = -1",
            "published_revision = 1",
            "model_sha256 = '" + "1" * 64 + "'",
            "generation = 1, generated_at = 10, expires_at = 10, "
            "published_at = 10, html_bytes = 1, xml_bytes = 1, "
            "json_bytes = 1, manifest_bytes = 1",
            "generation = 1, generated_at = 10, expires_at = 20, "
            "published_at = 20, html_bytes = 1, xml_bytes = 1, "
            "json_bytes = 1, manifest_bytes = 1",
            "model_sha256 = 'invalid'",
            "manifest_bytes = 262145",
        ):
            with self.subTest(mutation=mutation), self.assertRaises(
                sqlite3.IntegrityError
            ):
                self.database.execute(
                    f"UPDATE directory_artifact_publications SET {mutation} "
                    "WHERE profile = 'classic-v1'"
                )

        for generation in range(1, 9):
            self.database.execute(
                "INSERT INTO directory_artifact_history "
                "(profile, generation, committed_at) VALUES (?, ?, ?)",
                ("classic-v1", generation, generation),
            )
        with self.assertRaises(sqlite3.IntegrityError):
            self.database.execute(
                "INSERT INTO directory_artifact_history "
                "(profile, generation, committed_at) "
                "VALUES ('classic-v1', 9, 9)"
            )
        self.assertEqual(
            self.database.execute(
                "SELECT generation FROM directory_artifact_history "
                "WHERE profile = 'classic-v1' ORDER BY generation"
            ).fetchall(),
            [(generation,) for generation in range(1, 9)],
        )


class GamePublisherMigrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.database = sqlite3.connect(":memory:")
        self.addCleanup(self.database.close)
        for migration in (
            INITIAL_MIGRATION,
            REQUEST_CONTROL_MIGRATION,
            RENDEZVOUS_GENERATION_MIGRATION,
            SIGNED_PUBLISHER_MIGRATION,
            DIRECTORY_STATE_MIGRATION,
            DIRECTORY_ARTIFACTS_MIGRATION,
        ):
            self.database.executescript(migration.read_text(encoding="utf-8"))

    def test_preserves_classic_rows_and_adds_disjoint_game_shape(self) -> None:
        classic_id = "1" * 64
        game_id = "2" * 64
        for server_id in (classic_id, game_id):
            self.database.execute(
                "INSERT INTO server_owners "
                "(server_id, auth_key, current_ip, ip_changed_at, created_at, "
                "updated_at, rendezvous_generation, authentication_kind) "
                "VALUES (?, ?, '', 0, 1, 1, ?, 'signed-certificate-v1')",
                (server_id, "0" * 128, "0" * 64),
            )
        self.database.execute(
            "INSERT INTO server_presence "
            "(profile, server_id, last_seen, rendezvous_token_hash, "
            "rendezvous_generation) VALUES "
            "('classic-v1', ?, 1, ?, ?), ('game-v1', ?, 1, ?, ?)",
            (classic_id, "a" * 64, "b" * 64, game_id, "c" * 64, "d" * 64),
        )
        self.database.execute(
            "INSERT INTO directory_entries "
            "(profile, server_id, name, players_count, version, text_comment, "
            "hostname, port, quic_cert_sha256, password_required, "
            "directory_fingerprint) VALUES "
            "('classic-v1', ?, 'Classic', 7, '4.0', '', NULL, NULL, ?, 0, ?)",
            (classic_id, classic_id, "e" * 64),
        )
        self.database.execute(
            "INSERT INTO request_budgets "
            "(actor_key, scope, window_start, request_count, expires_at) "
            "VALUES (?, 'publish-server', 0, 1, 60)",
            (classic_id,),
        )

        self.database.executescript(
            GAME_PUBLISHER_MIGRATION.read_text(encoding="utf-8")
        )
        self.assertEqual(self.database.execute("PRAGMA foreign_key_check").fetchall(), [])

        self.assertEqual(
            self.database.execute(
                "SELECT profile, server_id, name, players_count, version, "
                "text_comment, description, region, protocol_major, "
                "protocol_minor, content_id, content_revision_sha256, "
                "players_online, players_capacity, status, game_json_bytes, "
                "hostname, port, quic_cert_sha256, password_required, "
                "directory_fingerprint FROM directory_entries"
            ).fetchall(),
            [(
                "classic-v1",
                classic_id,
                "Classic",
                7,
                "4.0",
                "",
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                classic_id,
                0,
                "e" * 64,
            )],
        )
        self.database.execute(
            "INSERT INTO directory_entries "
            "(profile, server_id, name, description, region, protocol_major, "
            "protocol_minor, content_id, content_revision_sha256, "
            "players_online, players_capacity, status, game_json_bytes, hostname, port, "
            "quic_cert_sha256, password_required, directory_fingerprint) "
            "VALUES ('game-v1', ?, 'Game', 'Description', 'eu-west', 1, 0, "
            "'atrinik-main', ?, 3, 64, 'online', 512, 'play.example.org', 13327, "
            "?, 0, ?)",
            (game_id, "f" * 64, game_id, "1" * 64),
        )
        self.database.execute(
            "INSERT INTO request_budgets "
            "(actor_key, scope, window_start, request_count, expires_at) "
            "VALUES (?, 'publish-game-server', 0, 1, 60)",
            (game_id,),
        )
        self.assertEqual(
            self.database.execute(
                "SELECT players_online, players_capacity, status, game_json_bytes "
                "FROM directory_entries WHERE profile = 'game-v1'"
            ).fetchone(),
            (3, 64, "online", 512),
        )
        self.assertEqual(
            self.database.execute(
                "SELECT scope FROM request_budgets ORDER BY scope"
            ).fetchall(),
            [("publish-game-server",), ("publish-server",)],
        )

        self.database.execute(
            "UPDATE directory_entries SET game_json_bytes = 262005 "
            "WHERE profile = 'game-v1' AND server_id = ?",
            (game_id,),
        )
        overflow_id = "4" * 64
        self.database.execute(
            "INSERT INTO server_owners "
            "(server_id, auth_key, current_ip, ip_changed_at, created_at, "
            "updated_at, rendezvous_generation, authentication_kind) "
            "VALUES (?, ?, '', 0, 1, 1, ?, 'signed-certificate-v1')",
            (overflow_id, "0" * 128, "0" * 64),
        )
        self.database.execute(
            "INSERT INTO server_presence "
            "(profile, server_id, last_seen, rendezvous_token_hash, "
            "rendezvous_generation) VALUES ('game-v1', ?, 1, ?, ?)",
            (overflow_id, "2" * 64, "3" * 64),
        )
        with self.assertRaisesRegex(
            sqlite3.IntegrityError,
            "game directory JSON budget exceeded",
        ):
            self.database.execute(
                "INSERT INTO directory_entries "
                "(profile, server_id, name, description, protocol_major, "
                "protocol_minor, content_id, content_revision_sha256, "
                "players_online, players_capacity, status, game_json_bytes, "
                "quic_cert_sha256, password_required, directory_fingerprint) "
                "VALUES ('game-v1', ?, 'Overflow', '', 1, 0, 'atrinik-main', "
                "?, 0, 64, 'online', 1, ?, 0, ?)",
                (overflow_id, "4" * 64, overflow_id, "5" * 64),
            )

    def test_profile_shapes_and_game_relationships_fail_closed(self) -> None:
        server_id = "3" * 64
        self.database.execute(
            "INSERT INTO server_owners "
            "(server_id, auth_key, current_ip, ip_changed_at, created_at, "
            "updated_at, rendezvous_generation, authentication_kind) "
            "VALUES (?, ?, '', 0, 1, 1, ?, 'signed-certificate-v1')",
            (server_id, "0" * 128, "0" * 64),
        )
        self.database.execute(
            "INSERT INTO server_presence "
            "(profile, server_id, last_seen, rendezvous_token_hash, "
            "rendezvous_generation) VALUES ('game-v1', ?, 1, ?, ?)",
            (server_id, "a" * 64, "b" * 64),
        )
        self.database.executescript(
            GAME_PUBLISHER_MIGRATION.read_text(encoding="utf-8")
        )
        statement = (
            "INSERT INTO directory_entries "
            "(profile, server_id, name, description, protocol_major, "
            "protocol_minor, content_id, content_revision_sha256, "
            "players_online, players_capacity, status, game_json_bytes, quic_cert_sha256, "
            "password_required, directory_fingerprint) VALUES "
            "('game-v1', ?, 'Game', '', 1, 0, 'atrinik-main', ?, ?, 64, ?, 512, "
            "?, 0, ?)"
        )
        for online, status in ((64, "online"), (63, "full"), (1, "maintenance")):
            with self.subTest(online=online, status=status), self.assertRaises(
                sqlite3.IntegrityError
            ):
                self.database.execute(
                    statement,
                    (server_id, "c" * 64, online, status, server_id, "d" * 64),
                )


class RendezvousCooldownMigrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.database = sqlite3.connect(":memory:")
        self.addCleanup(self.database.close)
        for migration in (
            INITIAL_MIGRATION,
            REQUEST_CONTROL_MIGRATION,
            RENDEZVOUS_GENERATION_MIGRATION,
            SIGNED_PUBLISHER_MIGRATION,
            DIRECTORY_STATE_MIGRATION,
            DIRECTORY_ARTIFACTS_MIGRATION,
            GAME_PUBLISHER_MIGRATION,
        ):
            self.database.executescript(migration.read_text(encoding="utf-8"))

    def test_adds_empty_pair_state_without_rewriting_prior_budgets(self) -> None:
        actor = f"v1.current.{'A' * 43}"
        self.database.execute(
            "INSERT INTO request_budgets "
            "(actor_key, scope, window_start, request_count, expires_at) "
            "VALUES (?, 'rendezvous-client-source-server', 0, 10, 86400)",
            (actor,),
        )
        before = self.database.execute(
            "SELECT * FROM request_budgets"
        ).fetchall()

        self.database.executescript(
            RENDEZVOUS_COOLDOWN_MIGRATION.read_text(encoding="utf-8")
        )

        self.assertEqual(
            self.database.execute("SELECT * FROM request_budgets").fetchall(),
            before,
        )
        self.assertEqual(
            self.database.execute(
                "SELECT COUNT(*) FROM rendezvous_pair_attempts"
            ).fetchone(),
            (0,),
        )
        self.assertEqual(
            self.database.execute(
                "SELECT COUNT(*) FROM rendezvous_pair_cooldowns"
            ).fetchone(),
            (0,),
        )

    def test_enforces_closed_opaque_actor_and_timing_shapes(self) -> None:
        self.database.executescript(
            RENDEZVOUS_COOLDOWN_MIGRATION.read_text(encoding="utf-8")
        )
        actor = f"v1.current.{'A' * 43}"
        self.database.execute(
            "INSERT INTO rendezvous_pair_attempts "
            "(actor_key, attempt_id, attempted_at, expires_at) "
            "VALUES (?, ?, 100, 160)",
            (actor, "1" * 32),
        )
        self.database.execute(
            "INSERT INTO rendezvous_pair_cooldowns "
            "(actor_key, blocked_until, penalty_level, last_burst_at, expires_at) "
            "VALUES (?, 130, 0, 100, 1900)",
            (actor,),
        )
        invalid = (
            (
                "INSERT INTO rendezvous_pair_attempts "
                "(actor_key, attempt_id, attempted_at, expires_at) "
                "VALUES (?, ?, 100, 161)",
                (actor, "2" * 32),
            ),
            (
                "INSERT INTO rendezvous_pair_attempts "
                "(actor_key, attempt_id, attempted_at, expires_at) "
                "VALUES (?, ?, 100, 160)",
                ("192.0.2.1", "3" * 32),
            ),
            (
                "INSERT INTO rendezvous_pair_cooldowns "
                "(actor_key, blocked_until, penalty_level, last_burst_at, expires_at) "
                "VALUES (?, 100, 0, 100, 1900)",
                (f"v1.other.{'E' * 43}",),
            ),
        )
        for statement, parameters in invalid:
            with self.subTest(statement=statement):
                with self.assertRaises(sqlite3.IntegrityError):
                    self.database.execute(statement, parameters)


class LegacyStorageRemovalMigrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.database = sqlite3.connect(":memory:")
        self.addCleanup(self.database.close)
        self.database.execute("PRAGMA foreign_keys = ON")
        for migration in (
            INITIAL_MIGRATION,
            REQUEST_CONTROL_MIGRATION,
            RENDEZVOUS_GENERATION_MIGRATION,
            SIGNED_PUBLISHER_MIGRATION,
            DIRECTORY_STATE_MIGRATION,
            DIRECTORY_ARTIFACTS_MIGRATION,
            GAME_PUBLISHER_MIGRATION,
            RENDEZVOUS_COOLDOWN_MIGRATION,
        ):
            self.database.executescript(migration.read_text(encoding="utf-8"))

    def apply(self) -> None:
        self.database.executescript(
            LEGACY_STORAGE_REMOVAL_MIGRATION.read_text(encoding="utf-8")
        )

    def seed_signed(
        self,
        server_id: str,
        profile: str,
        discriminator: str,
    ) -> None:
        self.database.execute(
            "INSERT INTO server_owners "
            "(server_id, auth_key, current_ip, ip_changed_at, created_at, "
            "updated_at, rendezvous_generation, authentication_kind) "
            "VALUES (?, ?, '', 0, 1, 1, ?, 'signed-certificate-v1')",
            (server_id, "0" * 128, discriminator * 64),
        )
        self.database.execute(
            "INSERT INTO publisher_replay "
            "(server_id, profile, last_sequence, last_nonce, commit_token, updated_at) "
            "VALUES (?, ?, '7', ?, ?, 1)",
            (server_id, profile, discriminator * 32, discriminator * 64),
        )
        self.database.execute(
            "INSERT INTO publisher_nonces "
            "(server_id, profile, nonce, expires_at, created_at) "
            "VALUES (?, ?, ?, 100, 1)",
            (server_id, profile, discriminator * 32),
        )
        self.database.execute(
            "INSERT INTO server_presence "
            "(profile, server_id, last_seen, rendezvous_token_hash, "
            "rendezvous_generation) VALUES (?, ?, 10, ?, ?)",
            (profile, server_id, discriminator * 64, discriminator * 64),
        )
        if profile == "classic-v1":
            self.database.execute(
                "INSERT INTO directory_entries "
                "(profile, server_id, name, players_count, version, text_comment, "
                "quic_cert_sha256, password_required, directory_fingerprint) "
                "VALUES (?, ?, 'Classic', 2, '4.0', '', ?, 0, ?)",
                (profile, server_id, server_id, discriminator * 64),
            )
        else:
            self.database.execute(
                "INSERT INTO directory_entries "
                "(profile, server_id, name, description, protocol_major, "
                "protocol_minor, content_id, content_revision_sha256, "
                "players_online, players_capacity, status, game_json_bytes, "
                "quic_cert_sha256, password_required, directory_fingerprint) "
                "VALUES (?, ?, 'Game', '', 1, 0, 'atrinik-main', ?, "
                "1, 64, 'online', 1, ?, 0, ?)",
                (profile, server_id, discriminator * 64, server_id, discriminator * 64),
            )

    def test_empty_upgrade_has_only_canonical_tables(self) -> None:
        self.apply()
        self.assertEqual(
            self.database.execute("PRAGMA foreign_key_check").fetchall(), []
        )
        tables = {
            row[0] for row in self.database.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
        self.assertTrue({"server_denials", "publisher_replay", "server_presence"} <= tables)
        self.assertTrue({
            "one_time_tokens", "rate_limits", "servers", "server_owners",
            "server_blacklist",
        }.isdisjoint(tables))
        self.assertEqual(
            [
                row[1] for row in self.database.execute(
                    "PRAGMA table_info(server_denials)"
                )
            ],
            ["server_id", "created_at"],
        )

    def test_rejects_unresolved_noncanonical_denials_before_schema_changes(self) -> None:
        self.database.execute(
            "INSERT INTO server_blacklist (pattern, reason, created_at) "
            "VALUES ('192.0.2.*', 'requires reviewed disposition', 1)"
        )
        self.database.execute(
            "INSERT INTO server_blacklist (pattern, reason, created_at) "
            "VALUES (?, 'non-text pattern', 1)",
            (sqlite3.Binary(b"a" * 64),),
        )
        tables_before = self.database.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
        ).fetchall()

        with self.assertRaises(sqlite3.IntegrityError):
            self.apply()

        self.assertEqual(
            self.database.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
            ).fetchall(),
            tables_before,
        )
        self.assertEqual(
            self.database.execute(
                "SELECT count(*) FROM server_blacklist"
            ).fetchone(),
            (2,),
        )

    def test_mixed_upgrade_preserves_only_exact_signed_state(self) -> None:
        classic_id, game_id, compat_id = "a" * 64, "b" * 64, "c" * 64
        self.seed_signed(classic_id, "classic-v1", "1")
        self.seed_signed(game_id, "game-v1", "2")
        self.database.execute(
            "INSERT INTO server_owners "
            "(server_id, auth_key, current_ip, ip_changed_at, created_at, updated_at) "
            "VALUES (?, ?, '192.0.2.1', 1, 1, 1)",
            (compat_id, "3" * 128),
        )
        self.database.execute(
            "INSERT INTO server_presence "
            "(profile, server_id, last_seen, rendezvous_token_hash, "
            "rendezvous_generation) VALUES ('classic-v1', ?, 10, ?, ?)",
            (compat_id, "3" * 64, "3" * 64),
        )
        self.database.execute(
            "INSERT INTO directory_entries "
            "(profile, server_id, name, players_count, version, text_comment, "
            "quic_cert_sha256, password_required, directory_fingerprint) "
            "VALUES ('classic-v1', ?, 'Compat', 0, '4.0', '', ?, 0, ?)",
            (compat_id, compat_id, "3" * 64),
        )
        for server_id in (classic_id, compat_id):
            self.database.execute(
                "INSERT INTO servers "
                "(server_id, source_ip, name, players_count, version, text_comment, "
                "last_seen, is_public, quic_host, quic_port, quic_cert_sha256, "
                "password_required, rendezvous_token_hash, rendezvous_generation, "
                "directory_fingerprint) "
                "VALUES (?, '192.0.2.1', 'Shadow', 0, '4.0', '', 1, 1, '', 1, "
                "?, 0, ?, ?, ?)",
                (server_id, server_id, "4" * 64, "4" * 64, "4" * 64),
            )
        self.database.execute(
            "INSERT INTO one_time_tokens "
            "(token_hash, source_ip, expires_at, created_at) "
            "VALUES ('legacy-token', '192.0.2.1', 60, 1)"
        )
        self.database.execute(
            "INSERT INTO rate_limits "
            "(source_ip, scope, window_start, request_count) "
            "VALUES ('192.0.2.1', 'update', 0, 1)"
        )
        self.database.execute(
            "INSERT INTO request_budgets "
            "(actor_key, scope, window_start, request_count, expires_at) "
            "VALUES (?, 'publish-server', 0, 2, 60)",
            (classic_id,),
        )
        self.database.execute(
            "INSERT INTO request_budgets "
            "(actor_key, scope, window_start, request_count, expires_at) "
            "VALUES (?, 'compat-directory', 0, 2, 60)",
            (f"v1.current.{'A' * 43}",),
        )
        self.database.executemany(
            "INSERT INTO server_blacklist (pattern, reason, created_at) VALUES (?, ?, 1)",
            ((classic_id, "exact"), ("192.0.2.*", "raw wildcard")),
        )
        self.database.execute(
            "DELETE FROM server_blacklist WHERE pattern = '192.0.2.*'"
        )
        self.database.execute(
            "INSERT INTO server_blacklist (pattern, reason, created_at) VALUES (?, ?, ?)",
            (game_id, "invalid\x00reason", -1),
        )
        self.database.execute(
            "UPDATE directory_artifact_publications SET "
            "published_revision = 4, generation = 5, generated_at = 10, "
            "expires_at = 20, model_sha256 = ?, html_sha256 = ?, xml_sha256 = ?, "
            "json_sha256 = ?, manifest_sha256 = ?, html_bytes = 1, xml_bytes = 1, "
            "json_bytes = 1, manifest_bytes = 1, published_at = 11 "
            "WHERE profile = 'game-v1'",
            tuple(character * 64 for character in "45678"),
        )
        self.database.execute(
            "INSERT INTO directory_artifact_history "
            "(profile, generation, committed_at) VALUES ('game-v1', 5, 11)"
        )
        self.database.execute(
            "INSERT INTO directory_artifact_commits "
            "(profile, commit_token, revision, generation, committed_at) "
            "VALUES ('game-v1', ?, 4, 5, 11)",
            ("9" * 64,),
        )
        artifact_before = {
            table: self.database.execute(
                f"SELECT * FROM {table} ORDER BY 1, 2"
            ).fetchall()
            for table in (
                "directory_artifact_publications",
                "directory_artifact_history",
                "directory_artifact_commits",
            )
        }

        self.apply()

        self.assertEqual(
            self.database.execute(
                "SELECT profile, server_id FROM server_presence ORDER BY profile"
            ).fetchall(),
            [("classic-v1", classic_id), ("game-v1", game_id)],
        )
        self.assertEqual(
            self.database.execute(
                "SELECT profile, server_id FROM directory_entries ORDER BY profile"
            ).fetchall(),
            [("classic-v1", classic_id), ("game-v1", game_id)],
        )
        self.assertEqual(
            self.database.execute(
                "SELECT server_id, profile, last_sequence FROM publisher_replay "
                "ORDER BY profile"
            ).fetchall(),
            [(classic_id, "classic-v1", "7"), (game_id, "game-v1", "7")],
        )
        self.assertEqual(
            self.database.execute(
                "SELECT actor_key, scope, request_count FROM request_budgets"
            ).fetchall(),
            [(classic_id, "publish-server", 2)],
        )
        self.assertEqual(
            self.database.execute(
                "SELECT server_id FROM server_denials ORDER BY server_id"
            ).fetchall(),
            [(classic_id,), (game_id,)],
        )
        self.assertEqual(
            self.database.execute(
                "SELECT revision FROM directory_revisions WHERE profile = 'classic-v1'"
            ).fetchone(),
            (1,),
        )
        self.assertEqual(
            self.database.execute(
                "SELECT profile, revision FROM directory_outbox"
            ).fetchall(),
            [("classic-v1", 1)],
        )
        self.assertEqual(
            self.database.execute("PRAGMA foreign_key_check").fetchall(), []
        )
        for table, rows in artifact_before.items():
            self.assertEqual(
                self.database.execute(
                    f"SELECT * FROM {table} ORDER BY 1, 2"
                ).fetchall(),
                rows,
            )
        self.assertEqual(
            {
                (row[2], row[3], row[4], row[6])
                for row in self.database.execute(
                    "PRAGMA foreign_key_list(server_presence)"
                )
            },
            {
                ("publisher_replay", "server_id", "server_id", "CASCADE"),
                ("publisher_replay", "profile", "profile", "CASCADE"),
            },
        )
        with self.assertRaises(sqlite3.IntegrityError):
            self.database.execute(
                "INSERT INTO request_budgets "
                "(actor_key, scope, window_start, request_count, expires_at) "
                "VALUES (?, 'compat-directory', 0, 1, 60)",
                (classic_id,),
            )
        self.database.execute(
            "DELETE FROM publisher_replay WHERE server_id = ? AND profile = 'classic-v1'",
            (classic_id,),
        )
        self.assertIsNone(self.database.execute(
            "SELECT 1 FROM server_presence WHERE server_id = ?", (classic_id,)
        ).fetchone())
        self.assertIsNone(self.database.execute(
            "SELECT 1 FROM directory_entries WHERE server_id = ?", (classic_id,)
        ).fetchone())
        self.assertIsNone(self.database.execute(
            "SELECT 1 FROM publisher_nonces WHERE server_id = ?", (classic_id,)
        ).fetchone())


class ClassicAccessCodeMigrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.database = sqlite3.connect(":memory:")
        self.addCleanup(self.database.close)
        self.previous_migrations = (
            INITIAL_MIGRATION,
            REQUEST_CONTROL_MIGRATION,
            RENDEZVOUS_GENERATION_MIGRATION,
            SIGNED_PUBLISHER_MIGRATION,
            DIRECTORY_STATE_MIGRATION,
            DIRECTORY_ARTIFACTS_MIGRATION,
            GAME_PUBLISHER_MIGRATION,
            RENDEZVOUS_COOLDOWN_MIGRATION,
            LEGACY_STORAGE_REMOVAL_MIGRATION,
        )
        for migration in self.previous_migrations:
            self.database.executescript(migration.read_text(encoding="utf-8"))

    def seed_profile(self, profile: str, server_id: str) -> None:
        self.database.execute(
            "INSERT INTO publisher_replay "
            "(server_id, profile, last_sequence, last_nonce, commit_token, updated_at) "
            "VALUES (?, ?, '7', ?, ?, 100)",
            (server_id, profile, server_id[:32], server_id),
        )
        self.database.execute(
            "INSERT INTO publisher_nonces "
            "(server_id, profile, nonce, expires_at, created_at) "
            "VALUES (?, ?, ?, 200, 100)",
            (server_id, profile, server_id[:32]),
        )
        self.database.execute(
            "INSERT INTO server_presence "
            "(profile, server_id, last_seen, rendezvous_token_hash, "
            "rendezvous_generation) VALUES (?, ?, 100, ?, ?)",
            (profile, server_id, "a" * 64, "b" * 64),
        )
        if profile == "classic-v1":
            self.database.execute(
                "INSERT INTO directory_entries "
                "(profile, server_id, name, players_count, version, text_comment, "
                "hostname, port, quic_cert_sha256, password_required, "
                "directory_fingerprint) VALUES "
                "(?, ?, 'Classic', 2, '5.7', '', NULL, NULL, ?, 1, ?)",
                (profile, server_id, server_id, "c" * 64),
            )
        else:
            self.database.execute(
                "INSERT INTO directory_entries "
                "(profile, server_id, name, description, protocol_major, "
                "protocol_minor, content_id, content_revision_sha256, "
                "players_online, players_capacity, status, game_json_bytes, "
                "hostname, port, quic_cert_sha256, password_required, "
                "directory_fingerprint) VALUES "
                "(?, ?, 'Game', '', 1, 0, 'atrinik-main', ?, 0, 64, "
                "'online', 200, NULL, NULL, ?, 0, ?)",
                (profile, server_id, "d" * 64, server_id, "e" * 64),
            )

    def test_preserves_v1_and_game_and_adds_disjoint_v2_state(self) -> None:
        classic_id = "1" * 64
        game_id = "2" * 64
        self.seed_profile("classic-v1", classic_id)
        self.seed_profile("game-v1", game_id)
        self.database.executescript(
            CLASSIC_ACCESS_CODE_MIGRATION.read_text(encoding="utf-8")
        )

        self.assertEqual(
            self.database.execute(
                "SELECT profile, server_id, last_seen FROM server_presence "
                "ORDER BY profile"
            ).fetchall(),
            [("classic-v1", classic_id, 100), ("game-v1", game_id, 100)],
        )
        self.assertEqual(
            self.database.execute(
                "SELECT profile, password_required, access_code_required "
                "FROM directory_entries ORDER BY profile"
            ).fetchall(),
            [("classic-v1", 1, None), ("game-v1", 0, None)],
        )
        self.assertEqual(
            self.database.execute(
                "SELECT profile, revision FROM directory_revisions ORDER BY profile"
            ).fetchall(),
            [("classic-v1", 0), ("classic-v2", 0), ("game-v1", 0)],
        )
        self.assertEqual(
            self.database.execute(
                "SELECT mode, activated_at FROM classic_receiver_mode"
            ).fetchone(),
            ("classic-v1-accepting", None),
        )

        v2_id = "3" * 64
        self.database.execute(
            "INSERT INTO publisher_replay "
            "(server_id, profile, last_sequence, last_nonce, commit_token, updated_at) "
            "VALUES (?, 'classic-v2', '8', ?, ?, 101)",
            (v2_id, v2_id[:32], v2_id),
        )
        self.database.execute(
            "INSERT INTO server_presence "
            "(profile, server_id, last_seen, rendezvous_token_hash, "
            "rendezvous_generation) VALUES ('classic-v2', ?, 101, ?, ?)",
            (v2_id, "a" * 64, "b" * 64),
        )
        self.database.execute(
            "INSERT INTO directory_entries "
            "(profile, server_id, name, players_count, version, text_comment, "
            "hostname, port, quic_cert_sha256, access_code_required, "
            "directory_fingerprint) VALUES "
            "('classic-v2', ?, 'V2', 2, '6.0', '', NULL, NULL, ?, 1, ?)",
            (v2_id, v2_id, "f" * 64),
        )
        with self.assertRaises(sqlite3.IntegrityError):
            self.database.execute(
                "UPDATE directory_entries SET password_required = 1 "
                "WHERE profile = 'classic-v2' AND server_id = ?",
                (v2_id,),
            )
        self.assertEqual(
            self.database.execute("SELECT * FROM pragma_foreign_key_check").fetchall(),
            [],
        )

    def test_rolls_back_a_failed_migration_transaction(self) -> None:
        classic_id = "4" * 64
        self.seed_profile("classic-v1", classic_id)
        before = self.database.execute(
            "SELECT * FROM publisher_replay"
        ).fetchall()
        script = CLASSIC_ACCESS_CODE_MIGRATION.read_text(encoding="utf-8")
        with self.assertRaises(sqlite3.DatabaseError):
            self.database.executescript(
                "BEGIN IMMEDIATE;\n" + script +
                "\nSELECT * FROM migration_failure_injection;\nCOMMIT;"
            )
        self.database.rollback()
        self.assertIsNone(self.database.execute(
            "SELECT name FROM sqlite_master WHERE name = 'classic_receiver_mode'"
        ).fetchone())
        self.assertEqual(
            self.database.execute("SELECT * FROM publisher_replay").fetchall(),
            before,
        )


if __name__ == "__main__":
    unittest.main()
