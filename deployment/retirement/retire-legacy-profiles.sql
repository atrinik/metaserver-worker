-- REVIEW ARTIFACT ONLY: excluded from automatic migrations.
-- See README.md. This script grants no authority and must not run without a
-- separately authorized closed-circuit cutover and fresh external state proof.
-- The one-use proof marker is created only by that future authorized executor;
-- its absence, expiry, or any unmet condition aborts before destructive writes.
-- Execute the complete script as ONE transaction/batch, never statement-by-
-- statement. No COMMIT is embedded because the executor owns the transaction.
PRAGMA defer_foreign_keys = ON;

INSERT INTO directory_transaction_assertions(assertion)
SELECT 0 WHERE NOT EXISTS (
    SELECT 1 FROM access_token_retirement_authority
    WHERE singleton = 1 AND consumed = 0
      AND publication_closed = 1 AND rendezvous_closed = 1
      AND legacy_aliases_retired = 1 AND backup_verified = 1
      AND active_provider_ready = 1
      AND length(source_commit) = 40 AND source_commit NOT GLOB '*[^0-9a-f]*'
      AND length(sql_sha256) = 64 AND sql_sha256 NOT GLOB '*[^0-9a-f]*'
      AND length(snapshot_sha256) = 64 AND snapshot_sha256 NOT GLOB '*[^0-9a-f]*'
      AND length(alias_evidence_sha256) = 64 AND alias_evidence_sha256 NOT GLOB '*[^0-9a-f]*'
      AND length(circuit_evidence_sha256) = 64 AND circuit_evidence_sha256 NOT GLOB '*[^0-9a-f]*'
      AND issued_at <= unixepoch() AND issued_at >= unixepoch() - 300
      AND expires_at > unixepoch() AND expires_at <= issued_at + 300
);

-- A future external FK consumer needs a new reviewed retirement plan. Renaming
-- a referenced table rewrites FK targets, so unknown inbound edges fail closed.
INSERT INTO directory_transaction_assertions(assertion)
SELECT 0 WHERE EXISTS (
    SELECT 1 FROM sqlite_master AS object
    JOIN pragma_foreign_key_list(object.name) AS edge
    WHERE object.type = 'table'
      AND edge."table" IN ('publisher_replay', 'publisher_nonces',
          'directory_revisions', 'directory_outbox', 'server_presence',
          'directory_entries', 'directory_artifact_publications',
          'directory_artifact_commits', 'directory_artifact_history',
          'directory_expiry_commits', 'directory_activity_state',
          'directory_activity_buckets', 'directory_admin_pins')
      AND object.name NOT IN ('publisher_replay', 'publisher_nonces',
          'directory_revisions', 'directory_outbox', 'server_presence',
          'directory_entries', 'directory_artifact_publications',
          'directory_artifact_commits', 'directory_artifact_history',
          'directory_expiry_commits', 'directory_activity_state',
          'directory_activity_buckets', 'directory_admin_pins')
);

-- Refuse removal when the active namespace would lose even one replay bound.
INSERT INTO directory_transaction_assertions(assertion)
SELECT 0 WHERE EXISTS (
    SELECT 1 FROM publisher_replay AS old
    LEFT JOIN publisher_replay AS active
      ON active.server_id = old.server_id AND active.profile =
         CASE old.profile WHEN 'game-v1' THEN 'game-v2' ELSE 'classic-v3' END
    WHERE old.profile IN ('classic-v1', 'classic-v2', 'game-v1') AND (
      active.server_id IS NULL OR
      length(active.last_sequence) < length(old.last_sequence) OR
      (length(active.last_sequence) = length(old.last_sequence) AND
       active.last_sequence < old.last_sequence)
    )
);
INSERT INTO directory_transaction_assertions(assertion)
SELECT 0 WHERE EXISTS (
    SELECT 1 FROM publisher_nonces AS old
    LEFT JOIN publisher_nonces AS active
      ON active.server_id = old.server_id AND active.nonce = old.nonce
     AND active.profile = CASE old.profile
         WHEN 'game-v1' THEN 'game-v2' ELSE 'classic-v3' END
    WHERE old.profile IN ('classic-v1', 'classic-v2', 'game-v1')
      AND old.expires_at > unixepoch()
      AND (active.nonce IS NULL OR active.expires_at < old.expires_at)
);

-- All visible state must be checkpointed and globally purged before retirement.
INSERT INTO directory_transaction_assertions(assertion)
SELECT 0 WHERE EXISTS (SELECT 1 FROM directory_outbox)
 OR EXISTS (
    SELECT 1 FROM directory_revisions AS revision
    LEFT JOIN directory_artifact_publications AS publication USING (profile)
    WHERE revision.profile IN ('classic-v3', 'game-v2') AND (
      publication.profile IS NULL OR publication.generation < 1 OR
      publication.expires_at <= unixepoch() OR
      publication.published_revision <> revision.revision
    )
 );

UPDATE access_token_retirement_authority SET consumed = 1 WHERE singleton = 1;

DROP INDEX publisher_nonces_expires_idx;

DROP INDEX server_presence_last_seen_idx;

DROP TRIGGER directory_artifact_history_capacity_insert;

DROP TRIGGER directory_entries_game_json_budget_insert;

DROP TRIGGER directory_entries_game_json_budget_update;

DROP TRIGGER directory_entries_hostname_insert;

DROP TRIGGER directory_entries_hostname_update;

DROP TRIGGER directory_entries_text_insert;

DROP TRIGGER directory_entries_text_update;

DROP TRIGGER directory_outbox_coalesce_after_insert;

DROP TRIGGER server_presence_key_immutable;

DROP TRIGGER server_presence_profile_capacity_insert;

DROP INDEX directory_activity_buckets_profile_idx;

DROP TRIGGER directory_activity_bucket_capacity_insert;

DROP INDEX directory_admin_pins_profile_priority_idx;

DROP TRIGGER directory_admin_pins_profile_capacity_insert;

DROP TRIGGER directory_admin_pins_identity_immutable;

DROP TRIGGER server_presence_hostname_insert;

DROP TRIGGER server_presence_hostname_update;

ALTER TABLE publisher_replay RENAME TO publisher_replay_retirement_legacy;

ALTER TABLE publisher_nonces RENAME TO publisher_nonces_retirement_legacy;

ALTER TABLE directory_revisions RENAME TO directory_revisions_retirement_legacy;

ALTER TABLE directory_outbox RENAME TO directory_outbox_retirement_legacy;

ALTER TABLE server_presence RENAME TO server_presence_retirement_legacy;

ALTER TABLE directory_entries RENAME TO directory_entries_retirement_legacy;

ALTER TABLE directory_artifact_publications RENAME TO directory_artifact_publications_retirement_legacy;

ALTER TABLE directory_artifact_commits RENAME TO directory_artifact_commits_retirement_legacy;

ALTER TABLE directory_artifact_history RENAME TO directory_artifact_history_retirement_legacy;

ALTER TABLE directory_expiry_commits RENAME TO directory_expiry_commits_retirement_legacy;

ALTER TABLE directory_activity_state RENAME TO directory_activity_state_retirement_legacy;

ALTER TABLE directory_activity_buckets RENAME TO directory_activity_buckets_retirement_legacy;

ALTER TABLE directory_admin_pins RENAME TO directory_admin_pins_retirement_legacy;

CREATE TABLE publisher_replay (
    server_id TEXT NOT NULL CHECK (
        length(server_id) = 64 AND server_id NOT GLOB '*[^0-9a-f]*'
    ),
    profile TEXT NOT NULL CHECK (profile IN ('classic-v3', 'game-v2')),
    last_sequence TEXT NOT NULL CHECK (
        length(last_sequence) BETWEEN 1 AND 20 AND
        last_sequence NOT GLOB '*[^0-9]*' AND
        substr(last_sequence, 1, 1) <> '0' AND
        (
            length(last_sequence) < 20 OR
            last_sequence <= '18446744073709551615'
        )
    ),
    last_nonce TEXT NOT NULL CHECK (
        length(last_nonce) = 32 AND
        last_nonce NOT GLOB '*[^0-9a-f]*' AND
        last_nonce <> '00000000000000000000000000000000'
    ),
    commit_token TEXT NOT NULL CHECK (
        length(commit_token) = 64 AND
        commit_token NOT GLOB '*[^0-9a-f]*'
    ),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (server_id, profile)
);

CREATE TABLE publisher_nonces (
    server_id TEXT NOT NULL,
    profile TEXT NOT NULL,
    nonce TEXT NOT NULL CHECK (
        length(nonce) = 32 AND
        nonce NOT GLOB '*[^0-9a-f]*' AND
        nonce <> '00000000000000000000000000000000'
    ),
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (server_id, profile, nonce),
    FOREIGN KEY (server_id, profile)
        REFERENCES publisher_replay(server_id, profile)
        ON DELETE CASCADE
);

CREATE TABLE directory_revisions (
    profile TEXT PRIMARY KEY CHECK (profile IN ('classic-v3', 'game-v2')),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    updated_at INTEGER NOT NULL
);

CREATE TABLE directory_outbox (
    profile TEXT NOT NULL REFERENCES directory_revisions(profile),
    revision INTEGER NOT NULL CHECK (revision > 0),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (profile, revision)
);

CREATE TABLE server_presence (
    profile TEXT NOT NULL CHECK (profile IN ('classic-v3', 'game-v2')),
    server_id TEXT NOT NULL CHECK (
        length(server_id) = 64 AND server_id NOT GLOB '*[^0-9a-f]*'
    ),
    last_seen INTEGER NOT NULL CHECK (
        typeof(last_seen) = 'integer' AND last_seen BETWEEN 0 AND 9007199254740991
    ),
    rendezvous_token_hash TEXT NOT NULL CHECK (
        length(rendezvous_token_hash) = 64 AND
        rendezvous_token_hash NOT GLOB '*[^0-9a-f]*'
    ),
    rendezvous_generation TEXT NOT NULL CHECK (
        length(rendezvous_generation) = 64 AND
        rendezvous_generation NOT GLOB '*[^0-9a-f]*'
    ),
    publication_commit_token TEXT NOT NULL DEFAULT
        '0000000000000000000000000000000000000000000000000000000000000000' CHECK (
        length(publication_commit_token) = 64 AND
        publication_commit_token NOT GLOB '*[^0-9a-f]*'
    ),
    publication_base_revision INTEGER NOT NULL DEFAULT 0 CHECK (
        typeof(publication_base_revision) = 'integer' AND
        publication_base_revision BETWEEN 0 AND 9007199254740991
    ),
    publication_visible_revision INTEGER CHECK (
        publication_visible_revision IS NULL OR (
            typeof(publication_visible_revision) = 'integer' AND
            publication_visible_revision = publication_base_revision + 1 AND
            publication_visible_revision BETWEEN 1 AND 9007199254740991
        )
    ),
    certificate TEXT CHECK (certificate IS NULL OR (
        typeof(certificate) = 'text' AND length(certificate) BETWEEN 4 AND 2732 AND
        length(certificate) % 4 = 0 AND certificate NOT GLOB '*[^A-Za-z0-9+/=]*'
    )),
    name TEXT CHECK (name IS NULL OR (
        typeof(name) = 'text' AND length(CAST(name AS BLOB)) BETWEEN 1 AND 80
    )),
    hostname TEXT,
    port INTEGER,
    access_required INTEGER CHECK (access_required IS NULL OR (
        typeof(access_required) = 'integer' AND access_required IN (0, 1)
    )),
    CHECK (certificate IS NOT NULL AND name IS NOT NULL AND access_required IS NOT NULL),
    CHECK ((hostname IS NULL AND port IS NULL) OR (
        typeof(hostname) = 'text' AND length(hostname) BETWEEN 3 AND 253 AND
        hostname = lower(hostname) AND hostname GLOB '*.*' AND
        hostname GLOB '*[a-z]*' AND hostname NOT GLOB '*[^a-z0-9.-]*' AND
        hostname NOT GLOB '.*' AND hostname NOT GLOB '*.' AND
        hostname NOT GLOB '*..*' AND hostname NOT GLOB '-*' AND
        hostname NOT GLOB '*-' AND hostname NOT GLOB '*.-*' AND
        hostname NOT GLOB '*-.*' AND typeof(port) = 'integer' AND
        port BETWEEN 1 AND 65535
    )),
    PRIMARY KEY (profile, server_id),
    FOREIGN KEY (server_id, profile)
        REFERENCES publisher_replay(server_id, profile) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE TABLE directory_entries (
    profile TEXT NOT NULL CHECK (profile IN ('classic-v3', 'game-v2')),
    server_id TEXT NOT NULL CHECK (
        length(server_id) = 64 AND server_id NOT GLOB '*[^0-9a-f]*'
    ),
    name TEXT NOT NULL CHECK (
        typeof(name) = 'text' AND length(CAST(name AS BLOB)) BETWEEN 1 AND 80
    ),
    players_count INTEGER,
    version TEXT,
    text_comment TEXT,
    description TEXT,
    region TEXT,
    protocol_major INTEGER,
    protocol_minor INTEGER,
    content_id TEXT,
    content_revision_sha256 TEXT,
    players_online INTEGER,
    players_capacity INTEGER,
    status TEXT,
    game_json_bytes INTEGER,
    hostname TEXT,
    port INTEGER,
    quic_cert_sha256 TEXT NOT NULL CHECK (
        length(quic_cert_sha256) = 64 AND
        quic_cert_sha256 NOT GLOB '*[^0-9a-f]*' AND
        quic_cert_sha256 = server_id
    ),
    access_required INTEGER CHECK (access_required IS NULL OR (
        typeof(access_required) = 'integer' AND access_required IN (0, 1)
    )),
    directory_fingerprint TEXT NOT NULL CHECK (
        length(directory_fingerprint) = 64 AND
        directory_fingerprint NOT GLOB '*[^0-9a-f]*'
    ),
    PRIMARY KEY (profile, server_id),
    FOREIGN KEY (profile, server_id)
        REFERENCES server_presence(profile, server_id) ON DELETE CASCADE,
    CHECK (
        (hostname IS NULL AND port IS NULL) OR (
            typeof(hostname) = 'text' AND length(hostname) BETWEEN 3 AND 253 AND
            hostname = lower(hostname) AND hostname GLOB '*.*' AND
            hostname GLOB '*[a-z]*' AND hostname NOT GLOB '*[^a-z0-9.-]*' AND
            hostname NOT GLOB '.*' AND hostname NOT GLOB '*.' AND
            hostname NOT GLOB '*..*' AND hostname NOT GLOB '-*' AND
            hostname NOT GLOB '*-' AND hostname NOT GLOB '*.-*' AND
            hostname NOT GLOB '*-.*' AND typeof(port) = 'integer' AND
            port BETWEEN 1 AND 65535
        )
    ),
    CHECK (
        (profile = 'classic-v3' AND typeof(access_required) = 'integer' AND
         access_required IN (0, 1) AND
         typeof(players_count) = 'integer' AND
         players_count BETWEEN 0 AND 4294967295 AND
         typeof(version) = 'text' AND
         length(CAST(version AS BLOB)) BETWEEN 1 AND 32 AND
         typeof(text_comment) = 'text' AND
         length(CAST(text_comment AS BLOB)) <= 256 AND
         description IS NULL AND region IS NULL AND protocol_major IS NULL AND
         protocol_minor IS NULL AND content_id IS NULL AND
         content_revision_sha256 IS NULL AND players_online IS NULL AND
         players_capacity IS NULL AND status IS NULL AND game_json_bytes IS NULL) OR
        (profile = 'game-v2' AND typeof(access_required) = 'integer' AND
         access_required IN (0, 1) AND
         players_count IS NULL AND version IS NULL AND text_comment IS NULL AND
         typeof(description) = 'text' AND
         length(CAST(description AS BLOB)) <= 512 AND
         (region IS NULL OR (
            typeof(region) = 'text' AND length(region) BETWEEN 1 AND 32 AND
            region NOT GLOB '*[^a-z0-9-]*' AND
            substr(region, 1, 1) <> '-' AND substr(region, -1, 1) <> '-'
         )) AND protocol_major = 1 AND typeof(protocol_minor) = 'integer' AND
         protocol_minor BETWEEN 0 AND 65535 AND
         typeof(content_id) = 'text' AND length(content_id) BETWEEN 1 AND 64 AND
         content_id NOT GLOB '*[^a-z0-9._-]*' AND
         substr(content_id, 1, 1) GLOB '[a-z0-9]' AND
         substr(content_id, -1, 1) GLOB '[a-z0-9]' AND
         typeof(content_revision_sha256) = 'text' AND
         length(content_revision_sha256) = 64 AND
         content_revision_sha256 NOT GLOB '*[^0-9a-f]*' AND
         typeof(players_online) = 'integer' AND
         players_online BETWEEN 0 AND 100000 AND
         typeof(players_capacity) = 'integer' AND
         players_capacity BETWEEN 1 AND 100000 AND
         typeof(game_json_bytes) = 'integer' AND
         game_json_bytes BETWEEN 1 AND 262000 AND
         players_online <= players_capacity AND
         status IN ('online', 'full', 'maintenance') AND
         ((status = 'online' AND players_online < players_capacity) OR
          (status = 'full' AND players_online = players_capacity) OR
          (status = 'maintenance' AND players_online = 0)))
    )
) WITHOUT ROWID;

CREATE TABLE directory_artifact_publications (
    profile TEXT PRIMARY KEY CHECK (profile IN ('classic-v3', 'game-v2')),
    published_revision INTEGER NOT NULL DEFAULT 0 CHECK (
        typeof(published_revision) = 'integer' AND
        published_revision BETWEEN 0 AND 9007199254740991
    ),
    generation INTEGER NOT NULL DEFAULT 0 CHECK (
        typeof(generation) = 'integer' AND
        generation BETWEEN 0 AND 9007199254740991
    ),
    generated_at INTEGER NOT NULL DEFAULT 0 CHECK (
        typeof(generated_at) = 'integer' AND
        generated_at BETWEEN 0 AND 253402300799
    ),
    expires_at INTEGER NOT NULL DEFAULT 0 CHECK (
        typeof(expires_at) = 'integer' AND
        expires_at BETWEEN 0 AND 253402300799
    ),
    model_sha256 TEXT NOT NULL DEFAULT
        '0000000000000000000000000000000000000000000000000000000000000000'
        CHECK (
            length(model_sha256) = 64 AND
            model_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
    html_sha256 TEXT NOT NULL DEFAULT
        '0000000000000000000000000000000000000000000000000000000000000000'
        CHECK (
            length(html_sha256) = 64 AND
            html_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
    xml_sha256 TEXT NOT NULL DEFAULT
        '0000000000000000000000000000000000000000000000000000000000000000'
        CHECK (
            length(xml_sha256) = 64 AND
            xml_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
    json_sha256 TEXT NOT NULL DEFAULT
        '0000000000000000000000000000000000000000000000000000000000000000'
        CHECK (
            length(json_sha256) = 64 AND
            json_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
    manifest_sha256 TEXT NOT NULL DEFAULT
        '0000000000000000000000000000000000000000000000000000000000000000'
        CHECK (
            length(manifest_sha256) = 64 AND
            manifest_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
    html_bytes INTEGER NOT NULL DEFAULT 0 CHECK (
        typeof(html_bytes) = 'integer' AND html_bytes BETWEEN 0 AND 4194304
    ),
    xml_bytes INTEGER NOT NULL DEFAULT 0 CHECK (
        typeof(xml_bytes) = 'integer' AND xml_bytes BETWEEN 0 AND 4194304
    ),
    json_bytes INTEGER NOT NULL DEFAULT 0 CHECK (
        typeof(json_bytes) = 'integer' AND json_bytes BETWEEN 0 AND 4194304
    ),
    manifest_bytes INTEGER NOT NULL DEFAULT 0 CHECK (
        typeof(manifest_bytes) = 'integer' AND
        manifest_bytes BETWEEN 0 AND 262144
    ),
    published_at INTEGER NOT NULL DEFAULT 0 CHECK (
        typeof(published_at) = 'integer' AND
        published_at BETWEEN 0 AND 253402300799
    ),
    CHECK (
        (generation = 0 AND published_revision = 0 AND generated_at = 0 AND
         expires_at = 0 AND published_at = 0 AND html_bytes = 0 AND
         xml_bytes = 0 AND json_bytes = 0 AND manifest_bytes = 0 AND
         model_sha256 =
           '0000000000000000000000000000000000000000000000000000000000000000' AND
         html_sha256 =
           '0000000000000000000000000000000000000000000000000000000000000000' AND
         xml_sha256 =
           '0000000000000000000000000000000000000000000000000000000000000000' AND
         json_sha256 =
           '0000000000000000000000000000000000000000000000000000000000000000' AND
         manifest_sha256 =
           '0000000000000000000000000000000000000000000000000000000000000000') OR
        (generation > 0 AND generated_at <= published_at AND
         published_at < expires_at AND html_bytes > 0 AND xml_bytes > 0 AND
         json_bytes > 0 AND manifest_bytes > 0)
    )
) WITHOUT ROWID;

CREATE TABLE directory_artifact_commits (
    profile TEXT PRIMARY KEY CHECK (profile IN ('classic-v3', 'game-v2')),
    commit_token TEXT NOT NULL CHECK (
        length(commit_token) = 64 AND
        commit_token NOT GLOB '*[^0-9a-f]*'
    ),
    revision INTEGER NOT NULL CHECK (
        typeof(revision) = 'integer' AND
        revision BETWEEN 0 AND 9007199254740991
    ),
    generation INTEGER NOT NULL CHECK (
        typeof(generation) = 'integer' AND
        generation BETWEEN 1 AND 9007199254740991
    ),
    committed_at INTEGER NOT NULL CHECK (
        typeof(committed_at) = 'integer' AND
        committed_at BETWEEN 0 AND 253402300799
    )
) WITHOUT ROWID;

CREATE TABLE directory_artifact_history (
    profile TEXT NOT NULL CHECK (profile IN ('classic-v3', 'game-v2')),
    generation INTEGER NOT NULL CHECK (
        typeof(generation) = 'integer' AND
        generation BETWEEN 1 AND 9007199254740991
    ),
    committed_at INTEGER NOT NULL CHECK (
        typeof(committed_at) = 'integer' AND
        committed_at BETWEEN 0 AND 253402300799
    ),
    PRIMARY KEY (profile, generation)
) WITHOUT ROWID;

CREATE TABLE directory_expiry_commits (
    profile TEXT PRIMARY KEY CHECK (profile IN ('classic-v3', 'game-v2')),
    commit_token TEXT NOT NULL CHECK (
        length(commit_token) = 64 AND
        commit_token NOT GLOB '*[^0-9a-f]*'
    ),
    cutoff INTEGER NOT NULL CHECK (
        typeof(cutoff) = 'integer' AND cutoff BETWEEN 0 AND 9007199254740991
    ),
    committed_at INTEGER NOT NULL CHECK (
        typeof(committed_at) = 'integer' AND
        committed_at BETWEEN 0 AND 9007199254740991
    ),
    base_revision INTEGER NOT NULL CHECK (
        typeof(base_revision) = 'integer' AND
        base_revision BETWEEN 0 AND 9007199254740991
    ),
    visible_revision INTEGER CHECK (
        visible_revision IS NULL OR (
            typeof(visible_revision) = 'integer' AND
            visible_revision = base_revision + 1 AND
            visible_revision BETWEEN 1 AND 9007199254740991
        )
    ),
    expired_entries INTEGER NOT NULL CHECK (
        typeof(expired_entries) = 'integer' AND expired_entries BETWEEN 0 AND 512
    ),
    expired_presence INTEGER NOT NULL CHECK (
        typeof(expired_presence) = 'integer' AND
        expired_presence BETWEEN expired_entries AND 512
    ),
    CHECK ((visible_revision IS NULL) = (expired_entries = 0))
) WITHOUT ROWID;

CREATE TABLE directory_activity_state (
    profile TEXT NOT NULL CHECK (
        profile IN ('classic-v3', 'game-v2')
    ),
    server_id TEXT NOT NULL CHECK (
        length(server_id) = 64 AND server_id NOT GLOB '*[^0-9a-f]*'
    ),
    last_observed_at INTEGER NOT NULL CHECK (
        typeof(last_observed_at) = 'integer' AND
        last_observed_at BETWEEN 0 AND 9007199254740991
    ),
    last_positive_observed_at INTEGER CHECK (
        last_positive_observed_at IS NULL OR (
            typeof(last_positive_observed_at) = 'integer' AND
            last_positive_observed_at BETWEEN 0 AND 9007199254740991
        )
    ),
    last_population INTEGER NOT NULL CHECK (
        typeof(last_population) = 'integer' AND
        last_population BETWEEN 0 AND 100000
    ),
    observation_count INTEGER NOT NULL CHECK (
        typeof(observation_count) = 'integer' AND
        observation_count BETWEEN 1 AND 1000000
    ),
    PRIMARY KEY (profile, server_id),
    FOREIGN KEY (profile, server_id)
        REFERENCES server_presence(profile, server_id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE TABLE directory_activity_buckets (
    profile TEXT NOT NULL CHECK (
        profile IN ('classic-v3', 'game-v2')
    ),
    server_id TEXT NOT NULL CHECK (
        length(server_id) = 64 AND server_id NOT GLOB '*[^0-9a-f]*'
    ),
    bucket_start INTEGER NOT NULL CHECK (
        typeof(bucket_start) = 'integer' AND
        bucket_start BETWEEN 0 AND 9007199254740991 AND
        bucket_start % 86400 = 0
    ),
    positive_seconds INTEGER NOT NULL CHECK (
        typeof(positive_seconds) = 'integer' AND
        positive_seconds BETWEEN 0 AND 604800
    ),
    player_minutes INTEGER NOT NULL CHECK (
        typeof(player_minutes) = 'integer' AND
        player_minutes BETWEEN 0 AND 1008000000
    ),
    max_population INTEGER NOT NULL CHECK (
        typeof(max_population) = 'integer' AND
        max_population BETWEEN 0 AND 100000
    ),
    positive_observations INTEGER NOT NULL CHECK (
        typeof(positive_observations) = 'integer' AND
        positive_observations BETWEEN 0 AND 1000000
    ),
    zero_observations INTEGER NOT NULL CHECK (
        typeof(zero_observations) = 'integer' AND
        zero_observations BETWEEN 0 AND 1000000
    ),
    PRIMARY KEY (profile, server_id, bucket_start),
    FOREIGN KEY (profile, server_id)
        REFERENCES server_presence(profile, server_id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE TABLE directory_admin_pins (
    profile TEXT NOT NULL CHECK (
        profile IN ('classic-v3', 'game-v2')
    ),
    server_id TEXT NOT NULL CHECK (
        length(server_id) = 64 AND server_id NOT GLOB '*[^0-9a-f]*'
    ),
    priority INTEGER NOT NULL CHECK (
        typeof(priority) = 'integer' AND priority BETWEEN 0 AND 1000
    ),
    expires_at INTEGER CHECK (
        expires_at IS NULL OR (
            typeof(expires_at) = 'integer' AND
            expires_at BETWEEN 0 AND 9007199254740991
        )
    ),
    note TEXT NOT NULL CHECK (
        typeof(note) = 'text' AND length(CAST(note AS BLOB)) <= 512
    ),
    created_at INTEGER NOT NULL CHECK (
        typeof(created_at) = 'integer' AND
        created_at BETWEEN 0 AND 9007199254740991
    ),
    updated_at INTEGER NOT NULL CHECK (
        typeof(updated_at) = 'integer' AND
        updated_at BETWEEN 0 AND 9007199254740991
    ),
    PRIMARY KEY (profile, server_id)
) WITHOUT ROWID;

INSERT INTO publisher_replay (server_id, profile, last_sequence, last_nonce, commit_token, updated_at)
SELECT server_id, profile, last_sequence, last_nonce, commit_token, updated_at FROM publisher_replay_retirement_legacy
WHERE profile IN ('classic-v3', 'game-v2');

INSERT INTO publisher_nonces (server_id, profile, nonce, expires_at, created_at)
SELECT server_id, profile, nonce, expires_at, created_at FROM publisher_nonces_retirement_legacy
WHERE profile IN ('classic-v3', 'game-v2');

INSERT INTO directory_revisions (profile, revision, updated_at)
SELECT profile, revision, updated_at FROM directory_revisions_retirement_legacy
WHERE profile IN ('classic-v3', 'game-v2');

INSERT INTO directory_outbox (profile, revision, created_at)
SELECT profile, revision, created_at FROM directory_outbox_retirement_legacy
WHERE profile IN ('classic-v3', 'game-v2');

INSERT INTO server_presence (profile, server_id, last_seen, rendezvous_token_hash, rendezvous_generation, publication_commit_token, publication_base_revision, publication_visible_revision, certificate, name, hostname, port, access_required)
SELECT profile, server_id, last_seen, rendezvous_token_hash, rendezvous_generation, publication_commit_token, publication_base_revision, publication_visible_revision, certificate, name, hostname, port, access_required FROM server_presence_retirement_legacy
WHERE profile IN ('classic-v3', 'game-v2');

INSERT INTO directory_entries (profile, server_id, name, players_count, version, text_comment, description, region, protocol_major, protocol_minor, content_id, content_revision_sha256, players_online, players_capacity, status, game_json_bytes, hostname, port, quic_cert_sha256, access_required, directory_fingerprint)
SELECT profile, server_id, name, players_count, version, text_comment, description, region, protocol_major, protocol_minor, content_id, content_revision_sha256, players_online, players_capacity, status, game_json_bytes, hostname, port, quic_cert_sha256, access_required, directory_fingerprint FROM directory_entries_retirement_legacy
WHERE profile IN ('classic-v3', 'game-v2');

INSERT INTO directory_artifact_publications (profile, published_revision, generation, generated_at, expires_at, model_sha256, html_sha256, xml_sha256, json_sha256, manifest_sha256, html_bytes, xml_bytes, json_bytes, manifest_bytes, published_at)
SELECT profile, published_revision, generation, generated_at, expires_at, model_sha256, html_sha256, xml_sha256, json_sha256, manifest_sha256, html_bytes, xml_bytes, json_bytes, manifest_bytes, published_at FROM directory_artifact_publications_retirement_legacy
WHERE profile IN ('classic-v3', 'game-v2');

INSERT INTO directory_artifact_commits (profile, commit_token, revision, generation, committed_at)
SELECT profile, commit_token, revision, generation, committed_at FROM directory_artifact_commits_retirement_legacy
WHERE profile IN ('classic-v3', 'game-v2');

INSERT INTO directory_artifact_history (profile, generation, committed_at)
SELECT profile, generation, committed_at FROM directory_artifact_history_retirement_legacy
WHERE profile IN ('classic-v3', 'game-v2');

INSERT INTO directory_expiry_commits (profile, commit_token, cutoff, committed_at, base_revision, visible_revision, expired_entries, expired_presence)
SELECT profile, commit_token, cutoff, committed_at, base_revision, visible_revision, expired_entries, expired_presence FROM directory_expiry_commits_retirement_legacy
WHERE profile IN ('classic-v3', 'game-v2');

INSERT INTO directory_activity_state (profile, server_id, last_observed_at, last_positive_observed_at, last_population, observation_count)
SELECT profile, server_id, last_observed_at, last_positive_observed_at, last_population, observation_count FROM directory_activity_state_retirement_legacy
WHERE profile IN ('classic-v3', 'game-v2');

INSERT INTO directory_activity_buckets (profile, server_id, bucket_start, positive_seconds, player_minutes, max_population, positive_observations, zero_observations)
SELECT profile, server_id, bucket_start, positive_seconds, player_minutes, max_population, positive_observations, zero_observations FROM directory_activity_buckets_retirement_legacy
WHERE profile IN ('classic-v3', 'game-v2');

INSERT INTO directory_admin_pins (profile, server_id, priority, expires_at, note, created_at, updated_at)
SELECT profile, server_id, priority, expires_at, note, created_at, updated_at FROM directory_admin_pins_retirement_legacy
WHERE profile IN ('classic-v3', 'game-v2');

DROP TABLE directory_admin_pins_retirement_legacy;

DROP TABLE directory_activity_buckets_retirement_legacy;

DROP TABLE directory_activity_state_retirement_legacy;

DROP TABLE directory_expiry_commits_retirement_legacy;

DROP TABLE directory_artifact_history_retirement_legacy;

DROP TABLE directory_artifact_commits_retirement_legacy;

DROP TABLE directory_artifact_publications_retirement_legacy;

DROP TABLE directory_entries_retirement_legacy;

DROP TABLE server_presence_retirement_legacy;

DROP TABLE directory_outbox_retirement_legacy;

DROP TABLE directory_revisions_retirement_legacy;

DROP TABLE publisher_nonces_retirement_legacy;

DROP TABLE publisher_replay_retirement_legacy;

DROP TABLE classic_identity_modes;

DROP TABLE classic_receiver_mode;

CREATE INDEX publisher_nonces_expires_idx
ON publisher_nonces(expires_at);

CREATE INDEX server_presence_last_seen_idx
ON server_presence(profile, last_seen, server_id);

CREATE TRIGGER directory_artifact_history_capacity_insert
BEFORE INSERT ON directory_artifact_history
WHEN NOT EXISTS (
    SELECT 1 FROM directory_artifact_history
    WHERE profile = NEW.profile AND generation = NEW.generation
) AND (
    SELECT count(*) FROM directory_artifact_history
    WHERE profile = NEW.profile
) >= 8
BEGIN
    SELECT RAISE(ABORT, 'directory artifact history capacity exceeded');
END;

CREATE TRIGGER directory_entries_game_json_budget_insert
BEFORE INSERT ON directory_entries WHEN NEW.profile = 'game-v2'
BEGIN
    SELECT RAISE(ABORT, 'game directory JSON budget exceeded')
    WHERE NEW.game_json_bytes + coalesce((
        SELECT sum(game_json_bytes) + count(*) FROM directory_entries
         WHERE profile = NEW.profile AND server_id <> NEW.server_id
    ), 0) > 262000;
END;

CREATE TRIGGER directory_entries_game_json_budget_update
BEFORE UPDATE OF profile, server_id, game_json_bytes ON directory_entries
WHEN NEW.profile = 'game-v2'
BEGIN
    SELECT RAISE(ABORT, 'game directory JSON budget exceeded')
    WHERE NEW.game_json_bytes + coalesce((
        SELECT sum(game_json_bytes) + count(*) FROM directory_entries
         WHERE profile = NEW.profile AND server_id <> NEW.server_id
    ), 0) > 262000;
END;

CREATE TRIGGER directory_entries_hostname_insert
BEFORE INSERT ON directory_entries WHEN NEW.hostname IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'invalid directory hostname')
    WHERE EXISTS (
        WITH RECURSIVE labels(label, remainder) AS (
            SELECT substr(NEW.hostname, 1, instr(NEW.hostname || '.', '.') - 1),
                   substr(NEW.hostname || '.', instr(NEW.hostname || '.', '.') + 1)
            UNION ALL
            SELECT substr(remainder, 1, instr(remainder, '.') - 1),
                   substr(remainder, instr(remainder, '.') + 1)
            FROM labels WHERE remainder <> ''
        ) SELECT 1 FROM labels WHERE length(label) NOT BETWEEN 1 AND 63
    ) OR NOT EXISTS (
        WITH RECURSIVE labels(label, remainder) AS (
            SELECT substr(NEW.hostname, 1, instr(NEW.hostname || '.', '.') - 1),
                   substr(NEW.hostname || '.', instr(NEW.hostname || '.', '.') + 1)
            UNION ALL
            SELECT substr(remainder, 1, instr(remainder, '.') - 1),
                   substr(remainder, instr(remainder, '.') + 1)
            FROM labels WHERE remainder <> ''
        ) SELECT 1 FROM labels WHERE NOT (
            label NOT GLOB '*[^0-9]*' OR
            (length(label) > 2 AND substr(label, 1, 2) = '0x' AND
             substr(label, 3) NOT GLOB '*[^0-9a-f]*')
        )
    );
END;

CREATE TRIGGER directory_entries_hostname_update
BEFORE UPDATE OF hostname ON directory_entries WHEN NEW.hostname IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'invalid directory hostname')
    WHERE EXISTS (
        WITH RECURSIVE labels(label, remainder) AS (
            SELECT substr(NEW.hostname, 1, instr(NEW.hostname || '.', '.') - 1),
                   substr(NEW.hostname || '.', instr(NEW.hostname || '.', '.') + 1)
            UNION ALL
            SELECT substr(remainder, 1, instr(remainder, '.') - 1),
                   substr(remainder, instr(remainder, '.') + 1)
            FROM labels WHERE remainder <> ''
        ) SELECT 1 FROM labels WHERE length(label) NOT BETWEEN 1 AND 63
    ) OR NOT EXISTS (
        WITH RECURSIVE labels(label, remainder) AS (
            SELECT substr(NEW.hostname, 1, instr(NEW.hostname || '.', '.') - 1),
                   substr(NEW.hostname || '.', instr(NEW.hostname || '.', '.') + 1)
            UNION ALL
            SELECT substr(remainder, 1, instr(remainder, '.') - 1),
                   substr(remainder, instr(remainder, '.') + 1)
            FROM labels WHERE remainder <> ''
        ) SELECT 1 FROM labels WHERE NOT (
            label NOT GLOB '*[^0-9]*' OR
            (length(label) > 2 AND substr(label, 1, 2) = '0x' AND
             substr(label, 3) NOT GLOB '*[^0-9a-f]*')
        )
    );
END;

CREATE TRIGGER directory_entries_text_insert
BEFORE INSERT ON directory_entries
BEGIN
    SELECT RAISE(ABORT, 'invalid directory text')
    WHERE instr(NEW.name, char(0)) > 0 OR
          instr(coalesce(NEW.version, ''), char(0)) > 0 OR
          instr(coalesce(NEW.text_comment, ''), char(0)) > 0 OR
          instr(coalesce(NEW.description, ''), char(0)) > 0 OR
          instr(CAST(NEW.name || coalesce(NEW.version, '') ||
                     coalesce(NEW.text_comment, '') ||
                     coalesce(NEW.description, '') AS BLOB), X'efbfbe') > 0 OR
          instr(CAST(NEW.name || coalesce(NEW.version, '') ||
                     coalesce(NEW.text_comment, '') ||
                     coalesce(NEW.description, '') AS BLOB), X'efbfbf') > 0 OR
          (NEW.profile = 'game-v2' AND (
             instr(CAST(NEW.name || NEW.description AS BLOB), X'e280a8') > 0 OR
             instr(CAST(NEW.name || NEW.description AS BLOB), X'e280a9') > 0
          )) OR EXISTS (
        WITH RECURSIVE
        combined(value) AS (
            SELECT NEW.name || coalesce(NEW.version, '') ||
                   coalesce(NEW.text_comment, '') || coalesce(NEW.description, '')
        ),
        positions(offset) AS (
            SELECT 1 UNION ALL SELECT offset + 1 FROM positions, combined
            WHERE offset < length(combined.value)
        )
        SELECT 1 FROM positions, combined
        WHERE unicode(substr(combined.value, offset, 1)) BETWEEN 0 AND 31 OR
              unicode(substr(combined.value, offset, 1)) IN (127, 65534, 65535)
    );
END;

CREATE TRIGGER directory_entries_text_update
BEFORE UPDATE OF name, version, text_comment, description ON directory_entries
BEGIN
    SELECT RAISE(ABORT, 'invalid directory text')
    WHERE instr(NEW.name, char(0)) > 0 OR
          instr(coalesce(NEW.version, ''), char(0)) > 0 OR
          instr(coalesce(NEW.text_comment, ''), char(0)) > 0 OR
          instr(coalesce(NEW.description, ''), char(0)) > 0 OR
          instr(CAST(NEW.name || coalesce(NEW.version, '') ||
                     coalesce(NEW.text_comment, '') ||
                     coalesce(NEW.description, '') AS BLOB), X'efbfbe') > 0 OR
          instr(CAST(NEW.name || coalesce(NEW.version, '') ||
                     coalesce(NEW.text_comment, '') ||
                     coalesce(NEW.description, '') AS BLOB), X'efbfbf') > 0 OR
          (NEW.profile = 'game-v2' AND (
             instr(CAST(NEW.name || NEW.description AS BLOB), X'e280a8') > 0 OR
             instr(CAST(NEW.name || NEW.description AS BLOB), X'e280a9') > 0
          )) OR EXISTS (
        WITH RECURSIVE
        combined(value) AS (
            SELECT NEW.name || coalesce(NEW.version, '') ||
                   coalesce(NEW.text_comment, '') || coalesce(NEW.description, '')
        ),
        positions(offset) AS (
            SELECT 1 UNION ALL SELECT offset + 1 FROM positions, combined
            WHERE offset < length(combined.value)
        )
        SELECT 1 FROM positions, combined
        WHERE unicode(substr(combined.value, offset, 1)) BETWEEN 0 AND 31 OR
              unicode(substr(combined.value, offset, 1)) IN (127, 65534, 65535)
    );
END;

CREATE TRIGGER directory_outbox_coalesce_after_insert
AFTER INSERT ON directory_outbox
BEGIN
    DELETE FROM directory_outbox
    WHERE profile = NEW.profile AND revision < NEW.revision;
END;

CREATE TRIGGER server_presence_key_immutable
BEFORE UPDATE OF profile, server_id ON server_presence
WHEN OLD.profile <> NEW.profile OR OLD.server_id <> NEW.server_id
BEGIN
    SELECT RAISE(ABORT, 'server presence identity is immutable');
END;

CREATE TRIGGER server_presence_profile_capacity_insert
BEFORE INSERT ON server_presence
WHEN NOT EXISTS (
    SELECT 1 FROM server_presence
     WHERE profile = NEW.profile AND server_id = NEW.server_id
) AND (SELECT count(*) FROM server_presence WHERE profile = NEW.profile) >= 512
BEGIN
    SELECT RAISE(ABORT, 'directory profile capacity exceeded');
END;

CREATE INDEX directory_activity_buckets_profile_idx
ON directory_activity_buckets(profile, bucket_start, server_id);

CREATE TRIGGER directory_activity_bucket_capacity_insert
BEFORE INSERT ON directory_activity_buckets
WHEN NOT EXISTS (
    SELECT 1 FROM directory_activity_buckets
     WHERE profile = NEW.profile AND server_id = NEW.server_id
       AND bucket_start = NEW.bucket_start
) AND (
    SELECT count(*) FROM directory_activity_buckets
     WHERE profile = NEW.profile AND server_id = NEW.server_id
) >= 8
BEGIN
    SELECT RAISE(ABORT, 'directory activity bucket capacity exceeded');
END;

CREATE INDEX directory_admin_pins_profile_priority_idx
ON directory_admin_pins(profile, priority, server_id);

CREATE TRIGGER directory_admin_pins_profile_capacity_insert
BEFORE INSERT ON directory_admin_pins
WHEN NOT EXISTS (
    SELECT 1 FROM directory_admin_pins
     WHERE profile = NEW.profile AND server_id = NEW.server_id
) AND (
    SELECT count(*) FROM directory_admin_pins
     WHERE profile = NEW.profile
) >= 512
BEGIN
    SELECT RAISE(ABORT, 'directory pin capacity exceeded');
END;

CREATE TRIGGER directory_admin_pins_identity_immutable
BEFORE UPDATE OF profile, server_id ON directory_admin_pins
WHEN OLD.profile <> NEW.profile OR OLD.server_id <> NEW.server_id
BEGIN
    SELECT RAISE(ABORT, 'directory pin identity is immutable');
END;

CREATE TRIGGER server_presence_hostname_insert
BEFORE INSERT ON server_presence WHEN NEW.hostname IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'invalid directory hostname')
    WHERE EXISTS (
        WITH RECURSIVE labels(label, remainder) AS (
            SELECT substr(NEW.hostname, 1, instr(NEW.hostname || '.', '.') - 1),
                   substr(NEW.hostname || '.', instr(NEW.hostname || '.', '.') + 1)
            UNION ALL
            SELECT substr(remainder, 1, instr(remainder, '.') - 1),
                   substr(remainder, instr(remainder, '.') + 1)
            FROM labels WHERE remainder <> ''
        ) SELECT 1 FROM labels WHERE length(label) NOT BETWEEN 1 AND 63
    ) OR NOT EXISTS (
        WITH RECURSIVE labels(label, remainder) AS (
            SELECT substr(NEW.hostname, 1, instr(NEW.hostname || '.', '.') - 1),
                   substr(NEW.hostname || '.', instr(NEW.hostname || '.', '.') + 1)
            UNION ALL
            SELECT substr(remainder, 1, instr(remainder, '.') - 1),
                   substr(remainder, instr(remainder, '.') + 1)
            FROM labels WHERE remainder <> ''
        ) SELECT 1 FROM labels WHERE NOT (
            label NOT GLOB '*[^0-9]*' OR
            (length(label) > 2 AND substr(label, 1, 2) = '0x' AND
             substr(label, 3) NOT GLOB '*[^0-9a-f]*')
        )
    );
END;

CREATE TRIGGER server_presence_hostname_update
BEFORE UPDATE OF hostname ON server_presence WHEN NEW.hostname IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'invalid directory hostname')
    WHERE EXISTS (
        WITH RECURSIVE labels(label, remainder) AS (
            SELECT substr(NEW.hostname, 1, instr(NEW.hostname || '.', '.') - 1),
                   substr(NEW.hostname || '.', instr(NEW.hostname || '.', '.') + 1)
            UNION ALL
            SELECT substr(remainder, 1, instr(remainder, '.') - 1),
                   substr(remainder, instr(remainder, '.') + 1)
            FROM labels WHERE remainder <> ''
        ) SELECT 1 FROM labels WHERE length(label) NOT BETWEEN 1 AND 63
    ) OR NOT EXISTS (
        WITH RECURSIVE labels(label, remainder) AS (
            SELECT substr(NEW.hostname, 1, instr(NEW.hostname || '.', '.') - 1),
                   substr(NEW.hostname || '.', instr(NEW.hostname || '.', '.') + 1)
            UNION ALL
            SELECT substr(remainder, 1, instr(remainder, '.') - 1),
                   substr(remainder, instr(remainder, '.') + 1)
            FROM labels WHERE remainder <> ''
        ) SELECT 1 FROM labels WHERE NOT (
            label NOT GLOB '*[^0-9]*' OR
            (length(label) > 2 AND substr(label, 1, 2) = '0x' AND
             substr(label, 3) NOT GLOB '*[^0-9a-f]*')
        )
    );
END;

INSERT INTO directory_transaction_assertions(assertion)
SELECT 0 WHERE EXISTS (SELECT 1 FROM pragma_foreign_key_check);
