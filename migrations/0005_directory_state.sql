-- Rendezvous presence is profile-scoped for both public and private servers.
-- Only a directory_entries row makes a server publicly discoverable; private
-- presence retains no descriptive metadata or direct-connect endpoint.
-- This retry-safe guard runs before any canonical schema or data mutation so
-- an operator cannot silently truncate an over-capacity directory or partly
-- import malformed/orphaned legacy state. On failure the empty guard table may
-- remain; a corrected retry reuses and then drops it.
CREATE TABLE IF NOT EXISTS _directory_state_migration_preflight (
    invalid INTEGER NOT NULL CHECK (invalid = 0)
);

DELETE FROM _directory_state_migration_preflight;

INSERT INTO _directory_state_migration_preflight (invalid)
SELECT CASE WHEN
    (SELECT count(*) FROM servers) <= 512 AND
    NOT EXISTS (
        SELECT 1
        FROM servers
        WHERE
            typeof(name) <> 'text' OR
            length(CAST(name AS BLOB)) NOT BETWEEN 1 AND 80 OR
            typeof(players_count) <> 'integer' OR
            players_count NOT BETWEEN 0 AND 4294967295 OR
            typeof(version) <> 'text' OR
            length(CAST(version AS BLOB)) NOT BETWEEN 1 AND 32 OR
            typeof(text_comment) <> 'text' OR
            length(CAST(text_comment AS BLOB)) > 256 OR
            typeof(last_seen) <> 'integer' OR
            last_seen NOT BETWEEN 0 AND 9007199254740991 OR
            instr(name, char(0)) > 0 OR
            instr(version, char(0)) > 0 OR
            instr(text_comment, char(0)) > 0 OR
            instr(CAST(name AS BLOB), X'efbfbe') > 0 OR
            instr(CAST(name AS BLOB), X'efbfbf') > 0 OR
            instr(CAST(version AS BLOB), X'efbfbe') > 0 OR
            instr(CAST(version AS BLOB), X'efbfbf') > 0 OR
            instr(CAST(text_comment AS BLOB), X'efbfbe') > 0 OR
            instr(CAST(text_comment AS BLOB), X'efbfbf') > 0 OR
            NOT EXISTS (
                SELECT 1 FROM server_owners
                WHERE server_owners.server_id = servers.server_id
            ) OR
            EXISTS (
                WITH RECURSIVE
                combined(value) AS (
                    SELECT name || version || text_comment
                ),
                positions(offset) AS (
                    SELECT 1
                    UNION ALL
                    SELECT offset + 1
                    FROM positions, combined
                    WHERE offset < length(combined.value)
                )
                SELECT 1
                FROM positions, combined
                WHERE unicode(substr(combined.value, offset, 1))
                          BETWEEN 0 AND 31 OR
                      unicode(substr(combined.value, offset, 1))
                          IN (127, 65534, 65535)
            )
    )
THEN 0 ELSE 1 END;

DROP TABLE _directory_state_migration_preflight;

CREATE TABLE server_presence (
    profile TEXT NOT NULL CHECK (profile IN ('classic-v1', 'game-v1')),
    server_id TEXT NOT NULL CHECK (
        length(server_id) = 64 AND server_id NOT GLOB '*[^0-9a-f]*'
    ),
    last_seen INTEGER NOT NULL CHECK (
        typeof(last_seen) = 'integer' AND
        last_seen BETWEEN 0 AND 9007199254740991
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
    FOREIGN KEY (server_id) REFERENCES server_owners(server_id)
        ON DELETE CASCADE
) WITHOUT ROWID;

-- Runtime batches end by attempting to insert zero here when any required
-- postcondition is false. The CHECK failure occurs inside D1's transaction and
-- rolls back every earlier statement, including a statement skipped by a
-- trigger using RAISE(IGNORE). Successful batches never add a row.
CREATE TABLE directory_transaction_assertions (
    assertion INTEGER NOT NULL CHECK (assertion = 1)
);

-- One fixed, non-secret marker per profile lets expiry prove its complete
-- before/after invariant inside the same D1 transaction. It contains only
-- bounded counts, revisions, timestamps, and a random operation token.
CREATE TABLE directory_expiry_commits (
    profile TEXT PRIMARY KEY CHECK (profile IN ('classic-v1', 'game-v1')),
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

CREATE INDEX server_presence_last_seen_idx
ON server_presence(profile, last_seen, server_id);

-- Bounding all presence also bounds directory entries and expiry work. The key
-- is immutable; this makes the per-profile capacity trigger sufficient for
-- every way a row can enter a profile.
CREATE TRIGGER server_presence_profile_capacity_insert
BEFORE INSERT ON server_presence
WHEN
    NOT EXISTS (
        SELECT 1
        FROM server_presence
        WHERE profile = NEW.profile AND server_id = NEW.server_id
    ) AND
    (
        SELECT count(*)
        FROM server_presence
        WHERE profile = NEW.profile
    ) >= 512
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
        typeof(name) = 'text' AND
        length(CAST(name AS BLOB)) BETWEEN 1 AND 80
    ),
    players_count INTEGER NOT NULL CHECK (
        typeof(players_count) = 'integer' AND
        players_count BETWEEN 0 AND 4294967295
    ),
    version TEXT NOT NULL CHECK (
        typeof(version) = 'text' AND
        length(CAST(version AS BLOB)) BETWEEN 1 AND 32
    ),
    text_comment TEXT NOT NULL CHECK (
        typeof(text_comment) = 'text' AND
        length(CAST(text_comment AS BLOB)) <= 256
    ),
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
    )
) WITHOUT ROWID;

CREATE TRIGGER directory_entries_text_insert
BEFORE INSERT ON directory_entries
BEGIN
    SELECT RAISE(ABORT, 'invalid directory text')
    WHERE instr(NEW.name, char(0)) > 0 OR
          instr(NEW.version, char(0)) > 0 OR
          instr(NEW.text_comment, char(0)) > 0 OR
          instr(CAST(NEW.name AS BLOB), X'efbfbe') > 0 OR
          instr(CAST(NEW.name AS BLOB), X'efbfbf') > 0 OR
          instr(CAST(NEW.version AS BLOB), X'efbfbe') > 0 OR
          instr(CAST(NEW.version AS BLOB), X'efbfbf') > 0 OR
          instr(CAST(NEW.text_comment AS BLOB), X'efbfbe') > 0 OR
          instr(CAST(NEW.text_comment AS BLOB), X'efbfbf') > 0 OR
          EXISTS (
        WITH RECURSIVE
        combined(value) AS (
            SELECT NEW.name || NEW.version || NEW.text_comment
        ),
        positions(offset) AS (
            SELECT 1
            UNION ALL
            SELECT offset + 1
            FROM positions, combined
            WHERE offset < length(combined.value)
        )
        SELECT 1
        FROM positions, combined
        WHERE unicode(substr(combined.value, offset, 1)) BETWEEN 0 AND 31 OR
              unicode(substr(combined.value, offset, 1)) IN (127, 65534, 65535)
    );
END;

CREATE TRIGGER directory_entries_text_update
BEFORE UPDATE OF name, version, text_comment ON directory_entries
BEGIN
    SELECT RAISE(ABORT, 'invalid directory text')
    WHERE instr(NEW.name, char(0)) > 0 OR
          instr(NEW.version, char(0)) > 0 OR
          instr(NEW.text_comment, char(0)) > 0 OR
          instr(CAST(NEW.name AS BLOB), X'efbfbe') > 0 OR
          instr(CAST(NEW.name AS BLOB), X'efbfbf') > 0 OR
          instr(CAST(NEW.version AS BLOB), X'efbfbe') > 0 OR
          instr(CAST(NEW.version AS BLOB), X'efbfbf') > 0 OR
          instr(CAST(NEW.text_comment AS BLOB), X'efbfbe') > 0 OR
          instr(CAST(NEW.text_comment AS BLOB), X'efbfbf') > 0 OR
          EXISTS (
        WITH RECURSIVE
        combined(value) AS (
            SELECT NEW.name || NEW.version || NEW.text_comment
        ),
        positions(offset) AS (
            SELECT 1
            UNION ALL
            SELECT offset + 1
            FROM positions, combined
            WHERE offset < length(combined.value)
        )
        SELECT 1
        FROM positions, combined
        WHERE unicode(substr(combined.value, offset, 1)) BETWEEN 0 AND 31 OR
              unicode(substr(combined.value, offset, 1)) IN (127, 65534, 65535)
    );
END;

-- The CHECK above rejects malformed canonical syntax cheaply. These triggers
-- enforce the DNS-name representation contract available in SQLite: labels
-- are at most 63 bytes, and at least one label is neither decimal nor a
-- 0x-prefixed hexadecimal number. The Worker additionally validates every
-- xn-- label with the protocol's strict UTS #46 profile before this boundary;
-- SQLite deliberately has no independent Unicode/IDNA mapping tables.
CREATE TRIGGER directory_entries_hostname_insert
BEFORE INSERT ON directory_entries
WHEN NEW.hostname IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'invalid directory hostname')
    WHERE EXISTS (
        WITH RECURSIVE labels(label, remainder) AS (
            SELECT
                substr(NEW.hostname, 1, instr(NEW.hostname || '.', '.') - 1),
                substr(NEW.hostname || '.', instr(NEW.hostname || '.', '.') + 1)
            UNION ALL
            SELECT
                substr(remainder, 1, instr(remainder, '.') - 1),
                substr(remainder, instr(remainder, '.') + 1)
            FROM labels
            WHERE remainder <> ''
        )
        SELECT 1 FROM labels WHERE length(label) NOT BETWEEN 1 AND 63
    ) OR NOT EXISTS (
        WITH RECURSIVE labels(label, remainder) AS (
            SELECT
                substr(NEW.hostname, 1, instr(NEW.hostname || '.', '.') - 1),
                substr(NEW.hostname || '.', instr(NEW.hostname || '.', '.') + 1)
            UNION ALL
            SELECT
                substr(remainder, 1, instr(remainder, '.') - 1),
                substr(remainder, instr(remainder, '.') + 1)
            FROM labels
            WHERE remainder <> ''
        )
        SELECT 1
        FROM labels
        WHERE NOT (
            label NOT GLOB '*[^0-9]*' OR (
                length(label) > 2 AND
                substr(label, 1, 2) = '0x' AND
                substr(label, 3) NOT GLOB '*[^0-9a-f]*'
            )
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
            SELECT
                substr(NEW.hostname, 1, instr(NEW.hostname || '.', '.') - 1),
                substr(NEW.hostname || '.', instr(NEW.hostname || '.', '.') + 1)
            UNION ALL
            SELECT
                substr(remainder, 1, instr(remainder, '.') - 1),
                substr(remainder, instr(remainder, '.') + 1)
            FROM labels
            WHERE remainder <> ''
        )
        SELECT 1 FROM labels WHERE length(label) NOT BETWEEN 1 AND 63
    ) OR NOT EXISTS (
        WITH RECURSIVE labels(label, remainder) AS (
            SELECT
                substr(NEW.hostname, 1, instr(NEW.hostname || '.', '.') - 1),
                substr(NEW.hostname || '.', instr(NEW.hostname || '.', '.') + 1)
            UNION ALL
            SELECT
                substr(remainder, 1, instr(remainder, '.') - 1),
                substr(remainder, instr(remainder, '.') + 1)
            FROM labels
            WHERE remainder <> ''
        )
        SELECT 1
        FROM labels
        WHERE NOT (
            label NOT GLOB '*[^0-9]*' OR (
                length(label) > 2 AND
                substr(label, 1, 2) = '0x' AND
                substr(label, 3) NOT GLOB '*[^0-9a-f]*'
            )
        )
    );
END;

-- Migrate every legacy rendezvous credential into minimal presence. The
-- preflight above has already rejected a profile that would exceed capacity.
INSERT INTO server_presence (
    profile,
    server_id,
    last_seen,
    rendezvous_token_hash,
    rendezvous_generation,
    publication_commit_token,
    publication_base_revision,
    publication_visible_revision
)
SELECT
    'classic-v1',
    server_id,
    last_seen,
    rendezvous_token_hash,
    rendezvous_generation,
    '0000000000000000000000000000000000000000000000000000000000000000',
    0,
    NULL
FROM servers
ORDER BY server_id;

-- Public metadata alone receives a directory entry. No legacy direct host or
-- port is carried into the opt-in hostname fields. The zero fingerprint forces
-- the next publisher heartbeat to canonicalize the new representation.
INSERT INTO directory_entries (
    profile,
    server_id,
    name,
    players_count,
    version,
    text_comment,
    hostname,
    port,
    quic_cert_sha256,
    password_required,
    directory_fingerprint
)
SELECT
    'classic-v1',
    servers.server_id,
    servers.name,
    servers.players_count,
    servers.version,
    servers.text_comment,
    NULL,
    NULL,
    servers.quic_cert_sha256,
    servers.password_required,
    '0000000000000000000000000000000000000000000000000000000000000000'
FROM servers
INNER JOIN server_presence
    ON server_presence.profile = 'classic-v1' AND
       server_presence.server_id = servers.server_id
WHERE servers.is_public = 1
ORDER BY servers.server_id;

-- Bootstrapping visible entries is one directory change regardless of row
-- count. Use their newest heartbeat as the deterministic event timestamp.
UPDATE directory_revisions
SET
    revision = revision + 1,
    updated_at = max(
        updated_at,
        (
            SELECT max(presence.last_seen)
            FROM directory_entries AS entries
            INNER JOIN server_presence AS presence
                ON presence.profile = entries.profile AND
                   presence.server_id = entries.server_id
            WHERE entries.profile = 'classic-v1'
        )
    )
WHERE
    profile = 'classic-v1' AND
    EXISTS (
        SELECT 1 FROM directory_entries WHERE profile = 'classic-v1'
    );

INSERT INTO directory_outbox (profile, revision, created_at)
SELECT profile, revision, updated_at
FROM directory_revisions
WHERE
    profile = 'classic-v1' AND
    EXISTS (
        SELECT 1 FROM directory_entries WHERE profile = 'classic-v1'
    );

-- Retain public compatibility shadows for rolling deployment, but remove all
-- raw network locations. Private rendezvous state now lives only in minimal
-- presence, so its metadata-bearing legacy shadow is removed.
UPDATE server_owners
SET current_ip = '', ip_changed_at = 0;

DELETE FROM servers WHERE is_public = 0;

UPDATE servers
SET source_ip = '', quic_host = '', quic_port = 1;
