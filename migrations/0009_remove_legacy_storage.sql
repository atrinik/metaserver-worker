-- Forward-only canonical storage reduction. The v2.0.0 bridge must be active
-- with publishing and rendezvous disabled before this migration is applied.
PRAGMA defer_foreign_keys = ON;

-- The operator must explicitly retire every address/CIDR/wildcard policy or
-- transfer it to a reviewed Cloudflare WAF rule before this migration. Abort
-- before any schema mutation while one unresolved noncanonical row remains.
INSERT INTO directory_transaction_assertions (assertion)
SELECT 0
 WHERE EXISTS (
       SELECT 1 FROM server_blacklist
        WHERE typeof(pattern) <> 'text' OR
              length(pattern) <> 64 OR pattern GLOB '*[^0-9a-f]*'
 );

-- Record only profiles whose visible legacy-owned entries must disappear.
CREATE TABLE _legacy_storage_retired_profiles (
    profile TEXT PRIMARY KEY CHECK (profile IN ('classic-v1', 'game-v1'))
) WITHOUT ROWID;

INSERT INTO _legacy_storage_retired_profiles (profile)
SELECT DISTINCT entries.profile
  FROM directory_entries AS entries
 WHERE NOT EXISTS (
       SELECT 1
         FROM server_owners AS owners
         JOIN publisher_replay AS replay ON replay.server_id = owners.server_id
        WHERE owners.server_id = entries.server_id
          AND replay.profile = entries.profile
          AND owners.authentication_kind = 'signed-certificate-v1'
 );

UPDATE directory_revisions
   SET revision = revision + 1,
       updated_at = max(updated_at, unixepoch())
 WHERE profile IN (SELECT profile FROM _legacy_storage_retired_profiles);

INSERT INTO directory_outbox (profile, revision, created_at)
SELECT revisions.profile, revisions.revision, unixepoch()
  FROM directory_revisions AS revisions
 WHERE revisions.profile IN (SELECT profile FROM _legacy_storage_retired_profiles);

-- Remove imported compatibility presence before rebuilding its parent key.
DELETE FROM server_presence
 WHERE NOT EXISTS (
       SELECT 1
         FROM server_owners AS owners
         JOIN publisher_replay AS replay ON replay.server_id = owners.server_id
        WHERE owners.server_id = server_presence.server_id
          AND replay.profile = server_presence.profile
          AND owners.authentication_kind = 'signed-certificate-v1'
 );

DROP INDEX server_presence_last_seen_idx;
DROP TRIGGER server_presence_profile_capacity_insert;
DROP TRIGGER server_presence_key_immutable;
DROP TRIGGER directory_entries_text_insert;
DROP TRIGGER directory_entries_text_update;
DROP TRIGGER directory_entries_game_json_budget_insert;
DROP TRIGGER directory_entries_game_json_budget_update;
DROP TRIGGER directory_entries_hostname_insert;
DROP TRIGGER directory_entries_hostname_update;

ALTER TABLE directory_entries RENAME TO directory_entries_legacy_v1;
ALTER TABLE server_presence RENAME TO server_presence_legacy_v1;

CREATE TABLE server_presence (
    profile TEXT NOT NULL CHECK (profile IN ('classic-v1', 'game-v1')),
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
    PRIMARY KEY (profile, server_id),
    FOREIGN KEY (server_id, profile)
        REFERENCES publisher_replay(server_id, profile) ON DELETE CASCADE
) WITHOUT ROWID;

INSERT INTO server_presence (
    profile, server_id, last_seen, rendezvous_token_hash,
    rendezvous_generation, publication_commit_token,
    publication_base_revision, publication_visible_revision
)
SELECT profile, server_id, last_seen, rendezvous_token_hash,
       rendezvous_generation, publication_commit_token,
       publication_base_revision, publication_visible_revision
  FROM server_presence_legacy_v1;

CREATE INDEX server_presence_last_seen_idx
ON server_presence(profile, last_seen, server_id);

CREATE TRIGGER server_presence_profile_capacity_insert
BEFORE INSERT ON server_presence
WHEN NOT EXISTS (
    SELECT 1 FROM server_presence
     WHERE profile = NEW.profile AND server_id = NEW.server_id
) AND (SELECT count(*) FROM server_presence WHERE profile = NEW.profile) >= 512
BEGIN
    SELECT RAISE(ABORT, 'directory profile capacity exceeded');
END;

CREATE TRIGGER server_presence_key_immutable
BEFORE UPDATE OF profile, server_id ON server_presence
WHEN OLD.profile <> NEW.profile OR OLD.server_id <> NEW.server_id
BEGIN
    SELECT RAISE(ABORT, 'server presence identity is immutable');
END;

CREATE TABLE directory_entries (
    profile TEXT NOT NULL CHECK (profile IN ('classic-v1', 'game-v1')),
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
    password_required INTEGER NOT NULL CHECK (
        typeof(password_required) = 'integer' AND password_required IN (0, 1)
    ),
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
        (profile = 'classic-v1' AND
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
        (profile = 'game-v1' AND
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
         game_json_bytes BETWEEN 1 AND 262005 AND
         players_online <= players_capacity AND
         status IN ('online', 'full', 'maintenance') AND
         ((status = 'online' AND players_online < players_capacity) OR
          (status = 'full' AND players_online = players_capacity) OR
          (status = 'maintenance' AND players_online = 0)))
    )
) WITHOUT ROWID;

INSERT INTO directory_entries
SELECT * FROM directory_entries_legacy_v1;

DROP TABLE directory_entries_legacy_v1;
DROP TABLE server_presence_legacy_v1;

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
          (NEW.profile = 'game-v1' AND (
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
          (NEW.profile = 'game-v1' AND (
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

CREATE TRIGGER directory_entries_game_json_budget_insert
BEFORE INSERT ON directory_entries WHEN NEW.profile = 'game-v1'
BEGIN
    SELECT RAISE(ABORT, 'game directory JSON budget exceeded')
    WHERE NEW.game_json_bytes + coalesce((
        SELECT sum(game_json_bytes) + count(*) FROM directory_entries
         WHERE profile = 'game-v1' AND server_id <> NEW.server_id
    ), 0) > 262005;
END;

CREATE TRIGGER directory_entries_game_json_budget_update
BEFORE UPDATE OF profile, server_id, game_json_bytes ON directory_entries
WHEN NEW.profile = 'game-v1'
BEGIN
    SELECT RAISE(ABORT, 'game directory JSON budget exceeded')
    WHERE NEW.game_json_bytes + coalesce((
        SELECT sum(game_json_bytes) + count(*) FROM directory_entries
         WHERE profile = 'game-v1' AND server_id <> NEW.server_id
    ), 0) > 262005;
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

DROP INDEX request_budgets_expires_idx;
ALTER TABLE request_budgets RENAME TO request_budgets_legacy_v1;

CREATE TABLE request_budgets (
    actor_key TEXT NOT NULL CHECK (
        length(actor_key) = 64 AND actor_key NOT GLOB '*[^0-9a-f]*'
    ),
    scope TEXT NOT NULL CHECK (scope IN (
        'publish-server', 'publish-game-server', 'rendezvous-server'
    )),
    window_start INTEGER NOT NULL CHECK (
        typeof(window_start) = 'integer' AND window_start >= 0
    ),
    request_count INTEGER NOT NULL CHECK (
        typeof(request_count) = 'integer' AND request_count BETWEEN 1 AND 1000000
    ),
    expires_at INTEGER NOT NULL CHECK (
        typeof(expires_at) = 'integer' AND
        expires_at - window_start BETWEEN 1 AND 86400
    ),
    PRIMARY KEY (actor_key, scope, window_start)
) WITHOUT ROWID;

INSERT INTO request_budgets
SELECT actor_key, scope, window_start, request_count, expires_at
  FROM request_budgets_legacy_v1
 WHERE scope IN ('publish-server', 'publish-game-server', 'rendezvous-server')
   AND length(actor_key) = 64 AND actor_key NOT GLOB '*[^0-9a-f]*';

DROP TABLE request_budgets_legacy_v1;
CREATE INDEX request_budgets_expires_idx ON request_budgets(expires_at);

CREATE TABLE server_denials (
    server_id TEXT PRIMARY KEY CHECK (
        length(server_id) = 64 AND server_id NOT GLOB '*[^0-9a-f]*'
    ),
    created_at INTEGER NOT NULL CHECK (
        typeof(created_at) = 'integer' AND created_at BETWEEN 0 AND 9007199254740991
    )
) WITHOUT ROWID;

INSERT INTO server_denials (server_id, created_at)
SELECT pattern,
       CASE
         WHEN typeof(created_at) = 'integer' AND
              created_at BETWEEN 0 AND 9007199254740991
         THEN created_at ELSE unixepoch()
       END
  FROM server_blacklist
 WHERE typeof(pattern) = 'text' AND
       length(pattern) = 64 AND pattern NOT GLOB '*[^0-9a-f]*';

DROP TABLE one_time_tokens;
DROP TABLE rate_limits;
DROP TABLE servers;
DROP TABLE server_blacklist;
DROP TABLE server_owners;
DROP TABLE _legacy_storage_retired_profiles;

-- Fail the migration if any rebuilt relationship is not exact.
INSERT INTO directory_transaction_assertions (assertion)
SELECT 0 WHERE EXISTS (SELECT 1 FROM pragma_foreign_key_check);
