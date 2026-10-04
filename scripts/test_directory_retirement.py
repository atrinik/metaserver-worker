"""Isolated SQLite proof for the nonautomatic, operator-gated retirement artifact."""
import sqlite3
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RETIREMENT = ROOT / "deployment/retirement/retire-legacy-profiles.sql"


class DirectoryRetirementTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.addCleanup(self.db.close)
        self.db.execute("PRAGMA foreign_keys=ON")
        for migration in sorted((ROOT / "migrations").glob("*.sql")):
            if migration.name[:4] >= "0013":
                break
            self.db.executescript(migration.read_text())
        for profile, seq in (("classic-v1", "9"), ("classic-v2", "10"), ("game-v1", "20")):
            self.db.execute("INSERT INTO publisher_replay VALUES (?,?,?, ?,?,100)",
                            ("a"*64,profile,seq,"a"*32,"b"*64))
            self.db.execute("INSERT INTO publisher_nonces VALUES (?,?,?,?,100)",
                            ("a"*64,profile,"a"*32,int(time.time())+86400))
            self.db.execute("INSERT INTO server_presence(profile,server_id,last_seen,rendezvous_token_hash,rendezvous_generation) VALUES (?,?,100,?,?)",(profile,"a"*64,"b"*64,"c"*64))
        self.db.executescript((ROOT / "migrations/0013_access_token_profiles.sql").read_text())
        for profile in ("classic-v3", "game-v2"):
            self.db.execute("INSERT INTO server_presence(profile,server_id,last_seen,rendezvous_token_hash,rendezvous_generation,certificate,name,hostname,port,access_required) VALUES (?,?,100,?,?,'AQ==','Private','play.example.org',13327,1)",(profile,"a"*64,"b"*64,"c"*64))
            self.db.execute("INSERT INTO directory_activity_state VALUES (?,?,100,100,3,1)",(profile,"a"*64))
            self.db.execute("INSERT INTO directory_activity_buckets VALUES (?,?,0,300,15,3,1,0)",(profile,"a"*64))
            self.db.execute("UPDATE directory_artifact_publications SET generation=1,generated_at=1,expires_at=253402300799,published_at=2,html_bytes=1,xml_bytes=1,json_bytes=1,manifest_bytes=1 WHERE profile=?",(profile,))
        self.db.execute("INSERT INTO directory_entries(profile,server_id,name,players_count,version,text_comment,quic_cert_sha256,access_required,directory_fingerprint) VALUES ('classic-v3',?,'Classic',3,'7','',?,1,?)",("a"*64,"a"*64,"d"*64))
        self.db.execute("INSERT INTO directory_entries(profile,server_id,name,description,protocol_major,protocol_minor,content_id,content_revision_sha256,players_online,players_capacity,status,game_json_bytes,quic_cert_sha256,access_required,directory_fingerprint) VALUES ('game-v2',?,'Game','',1,1,'main',?,3,64,'online',300,?,1,?)",("a"*64,"b"*64,"a"*64,"d"*64))
        self.db.execute("CREATE TABLE access_token_retirement_authority(singleton INTEGER PRIMARY KEY,consumed INTEGER,publication_closed INTEGER,rendezvous_closed INTEGER,legacy_aliases_retired INTEGER,backup_verified INTEGER,active_provider_ready INTEGER,source_commit TEXT,sql_sha256 TEXT,snapshot_sha256 TEXT,alias_evidence_sha256 TEXT,circuit_evidence_sha256 TEXT,issued_at INTEGER,expires_at INTEGER)")
        now=int(time.time())
        self.db.execute("INSERT INTO access_token_retirement_authority VALUES (1,0,1,1,1,1,1,?,?,?,?,?,?,?)",("a"*40,"b"*64,"c"*64,"d"*64,"e"*64,now,now+300))
        self.db.commit()

    def execute(self):
        self.db.commit()
        try:
            self.db.executescript("BEGIN;\n"+RETIREMENT.read_text()+"\nCOMMIT;")
        except sqlite3.DatabaseError:
            self.db.rollback()
            raise

    def active_state(self):
        names=[row[0] for row in self.db.execute("SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE '%profile%' AND name NOT LIKE 'sqlite_%'")]
        columns={name:",".join(row[1] for row in self.db.execute(f"PRAGMA table_info({name})")
                 if row[1] not in ("password_required","access_code_required")) for name in names}
        return {name:self.db.execute(f"SELECT {columns[name]} FROM {name} WHERE profile IN ('classic-v3','game-v2') ORDER BY 1,2").fetchall() for name in names}

    def test_preserves_every_active_row_and_removes_obsolete_schema(self):
        before=self.active_state()
        self.execute()
        self.assertEqual(self.active_state(),before)
        self.assertEqual(self.db.execute("PRAGMA foreign_key_check").fetchall(),[])
        for name in before:
            self.assertEqual(self.db.execute(f"SELECT count(*) FROM {name} WHERE profile NOT IN ('classic-v3','game-v2')").fetchone(),(0,))
        columns={row[1] for row in self.db.execute("PRAGMA table_info(directory_entries)")}
        self.assertNotIn("password_required",columns)
        self.assertNotIn("access_code_required",columns)
        self.assertIn("access_required",columns)
        self.assertEqual(self.db.execute("SELECT consumed FROM access_token_retirement_authority").fetchone(),(1,))
        self.assertEqual(self.db.execute("SELECT name FROM sqlite_master WHERE name IN ('classic_identity_modes','classic_receiver_mode')").fetchall(),[])
        for profile in ("classic-v1","classic-v2","game-v1"):
            with self.assertRaises(sqlite3.IntegrityError):
                self.db.execute("INSERT INTO directory_revisions VALUES (?,0,0)",(profile,))

    def test_missing_or_expired_authority_fails_before_changes(self):
        before=self.active_state()
        self.db.execute("UPDATE access_token_retirement_authority SET expires_at=1")
        with self.assertRaises(sqlite3.IntegrityError): self.execute()
        self.assertEqual(self.active_state(),before)
        self.db.execute("DROP TABLE access_token_retirement_authority")
        with self.assertRaises(sqlite3.OperationalError): self.execute()
        self.assertEqual(self.active_state(),before)

    def test_every_external_proof_flag_and_single_use_is_required(self):
        for field in ("publication_closed","rendezvous_closed","legacy_aliases_retired","backup_verified","active_provider_ready","consumed"):
            with self.subTest(field=field):
                self.db.execute(f"UPDATE access_token_retirement_authority SET {field}=?",(1 if field=='consumed' else 0,))
                with self.assertRaises(sqlite3.IntegrityError): self.execute()
                self.db.execute(f"UPDATE access_token_retirement_authority SET {field}=?",(0 if field=='consumed' else 1,))

    def test_replay_or_live_nonce_loss_aborts_transaction(self):
        self.db.execute("UPDATE publisher_replay SET last_sequence='18446744073709551615' WHERE profile='classic-v2'")
        before=self.active_state()
        with self.assertRaises(sqlite3.IntegrityError): self.execute()
        self.assertEqual(self.active_state(),before)
        self.db.execute("UPDATE publisher_replay SET last_sequence='10' WHERE profile='classic-v2'")
        self.db.execute("DELETE FROM publisher_nonces WHERE profile='classic-v3'")
        with self.assertRaises(sqlite3.IntegrityError): self.execute()
        self.assertEqual(self.db.execute("SELECT consumed FROM access_token_retirement_authority").fetchone(),(0,))

    def test_unreviewed_inbound_foreign_key_aborts_before_rename(self):
        self.db.execute("CREATE TABLE future_consumer(profile TEXT,server_id TEXT,FOREIGN KEY(profile,server_id) REFERENCES server_presence(profile,server_id))")
        before=self.active_state()
        with self.assertRaises(sqlite3.IntegrityError): self.execute()
        self.assertEqual(self.active_state(),before)

    def test_uncheckpointed_state_or_outbox_aborts(self):
        self.db.execute("UPDATE directory_revisions SET revision=1 WHERE profile='classic-v3'")
        with self.assertRaises(sqlite3.IntegrityError): self.execute()
        self.db.execute("UPDATE directory_revisions SET revision=0")
        self.db.execute("INSERT INTO directory_outbox VALUES ('classic-v1',1,100)")
        with self.assertRaises(sqlite3.IntegrityError): self.execute()


if __name__ == "__main__":
    unittest.main()
