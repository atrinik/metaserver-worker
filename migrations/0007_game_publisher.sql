-- Game Protocol 1 publication uses the same profile-scoped presence, revision,
-- and outbox authority as classic publication, but its public row has a
-- different exact schema. Rebuild the additive directory table while retaining
-- every classic column name so the previous Worker remains compatible during
-- the circuit-disabled rolling deployment window.
ALTER TABLE directory_entries RENAME TO directory_entries_classic_v1;

CREATE TABLE directory_entries (
    profile TEXT NOT NULL CHECK (profile IN ('classic-v1', 'game-v1')),
    server_id TEXT NOT NULL CHECK (
        length(server_id) = 64 AND server_id NOT GLOB '*[^0-9a-f]*'
    ),
    name TEXT NOT NULL CHECK (
        typeof(name) = 'text' AND
        length(CAST(name AS BLOB)) BETWEEN 1 AND 80
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
        typeof(password_required) = 'integer' AND
        password_required IN (0, 1)
    ),
    directory_fingerprint TEXT NOT NULL CHECK (
        length(directory_fingerprint) = 64 AND
        directory_fingerprint NOT GLOB '*[^0-9a-f]*'
    ),
    PRIMARY KEY (profile, server_id),
    FOREIGN KEY (profile, server_id)
        REFERENCES server_presence(profile, server_id)
        ON DELETE CASCADE,
    CHECK (
        (hostname IS NULL AND port IS NULL) OR (
            typeof(hostname) = 'text' AND
            length(hostname) BETWEEN 3 AND 253 AND
            hostname = lower(hostname) AND
            hostname GLOB '*.*' AND
            hostname GLOB '*[a-z]*' AND
            hostname NOT GLOB '*[^a-z0-9.-]*' AND
            hostname NOT GLOB '.*' AND
            hostname NOT GLOB '*.' AND
            hostname NOT GLOB '*..*' AND
            hostname NOT GLOB '-*' AND
            hostname NOT GLOB '*-' AND
            hostname NOT GLOB '*.-*' AND
            hostname NOT GLOB '*-.*' AND
            typeof(port) = 'integer' AND
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
         players_capacity IS NULL AND status IS NULL AND
         game_json_bytes IS NULL) OR
        (profile = 'game-v1' AND
         players_count IS NULL AND version IS NULL AND text_comment IS NULL AND
         typeof(description) = 'text' AND
         length(CAST(description AS BLOB)) <= 512 AND
         (region IS NULL OR (
            typeof(region) = 'text' AND length(region) BETWEEN 1 AND 32 AND
            region NOT GLOB '*[^a-z0-9-]*' AND
            substr(region, 1, 1) <> '-' AND substr(region, -1, 1) <> '-'
         )) AND
         protocol_major = 1 AND typeof(protocol_minor) = 'integer' AND
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

INSERT INTO directory_entries (
    profile, server_id, name, players_count, version, text_comment,
    description, region, protocol_major, protocol_minor, content_id,
    content_revision_sha256, players_online, players_capacity, status,
    hostname, port, quic_cert_sha256, password_required,
    directory_fingerprint
)
SELECT
    profile, server_id, name, players_count, version, text_comment,
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    hostname, port, quic_cert_sha256, password_required,
    directory_fingerprint
FROM directory_entries_classic_v1;

DROP TABLE directory_entries_classic_v1;

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
                   coalesce(NEW.text_comment, '') ||
                   coalesce(NEW.description, '')
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

-- The canonical Game v1 JSON envelope reserves 139 bytes. Each stored value
-- is the exact UTF-8 size of its canonical server object; COUNT(*) accounts
-- conservatively for the commas between objects. Enforcing the aggregate here
-- prevents concurrent per-server publication from committing a directory that
-- the renderer must reject at the protocol's 262144-byte limit.
CREATE TRIGGER directory_entries_game_json_budget_insert
BEFORE INSERT ON directory_entries
WHEN NEW.profile = 'game-v1'
BEGIN
    SELECT RAISE(ABORT, 'game directory JSON budget exceeded')
    WHERE NEW.game_json_bytes + coalesce((
        SELECT sum(game_json_bytes) + count(*)
          FROM directory_entries
         WHERE profile = 'game-v1' AND server_id <> NEW.server_id
    ), 0) > 262005;
END;

CREATE TRIGGER directory_entries_game_json_budget_update
BEFORE UPDATE OF profile, server_id, game_json_bytes ON directory_entries
WHEN NEW.profile = 'game-v1'
BEGIN
    SELECT RAISE(ABORT, 'game directory JSON budget exceeded')
    WHERE NEW.game_json_bytes + coalesce((
        SELECT sum(game_json_bytes) + count(*)
          FROM directory_entries
         WHERE profile = 'game-v1' AND server_id <> NEW.server_id
    ), 0) > 262005;
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
                   coalesce(NEW.text_comment, '') ||
                   coalesce(NEW.description, '')
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

CREATE TRIGGER directory_entries_hostname_insert
BEFORE INSERT ON directory_entries
WHEN NEW.hostname IS NOT NULL
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
BEFORE UPDATE OF hostname ON directory_entries
WHEN NEW.hostname IS NOT NULL
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

-- Give Game publication an independent authenticated daily ledger while
-- preserving all existing rows and every scope understood by the prior Worker.
ALTER TABLE request_budgets RENAME TO request_budgets_v1;

CREATE TABLE request_budgets (
    actor_key TEXT NOT NULL CHECK (
        length(actor_key) BETWEEN 8 AND 128 AND
        actor_key NOT GLOB '*[^A-Za-z0-9._-]*' AND
        ((length(actor_key) = 64 AND actor_key NOT GLOB '*[^0-9a-f]*') OR
         (substr(actor_key, 1, 3) = 'v1.' AND
          instr(substr(actor_key, 4), '.') BETWEEN 2 AND 33 AND
          substr(actor_key, 4, instr(substr(actor_key, 4), '.') - 1)
              NOT GLOB '*[^A-Za-z0-9_-]*' AND
          length(substr(actor_key, 4 + instr(substr(actor_key, 4), '.'))) = 43 AND
          substr(actor_key, 4 + instr(substr(actor_key, 4), '.'))
              NOT GLOB '*[^A-Za-z0-9_-]*'))
    ),
    scope TEXT NOT NULL CHECK (scope IN (
        'compat-status', 'compat-directory', 'compat-otp',
        'compat-update-source', 'compat-update-server', 'publish-server',
        'publish-game-server', 'rendezvous-client-source',
        'rendezvous-client-source-server', 'rendezvous-server-source',
        'rendezvous-server'
    )),
    window_start INTEGER NOT NULL CHECK (
        typeof(window_start) = 'integer' AND window_start >= 0
    ),
    request_count INTEGER NOT NULL CHECK (
        typeof(request_count) = 'integer' AND
        request_count BETWEEN 1 AND 1000000
    ),
    expires_at INTEGER NOT NULL CHECK (
        typeof(expires_at) = 'integer' AND
        expires_at - window_start BETWEEN 1 AND 86400
    ),
    PRIMARY KEY (actor_key, scope, window_start)
) WITHOUT ROWID;

INSERT INTO request_budgets
SELECT actor_key, scope, window_start, request_count, expires_at
FROM request_budgets_v1;

DROP TABLE request_budgets_v1;

CREATE INDEX request_budgets_expires_idx ON request_budgets(expires_at);
