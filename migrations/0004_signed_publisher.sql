-- Certificate-bound publishers replace first-claim shared-key ownership while
-- compatibility publishers remain valid during the documented cutover.
ALTER TABLE server_owners ADD COLUMN authentication_kind TEXT NOT NULL
DEFAULT 'compat-key-v1'
CHECK (authentication_kind IN (
    'compat-key-v1',
    'signed-certificate-v1'
));

ALTER TABLE servers ADD COLUMN directory_fingerprint TEXT NOT NULL
DEFAULT '0000000000000000000000000000000000000000000000000000000000000000'
CHECK (
    length(directory_fingerprint) = 64 AND
    directory_fingerprint NOT GLOB '*[^0-9a-f]*'
);

-- Sequence values are canonical decimal text because SQLite INTEGER is signed
-- and cannot represent the complete unsigned 64-bit publisher range. The
-- random, non-secret commit token lets later statements in one D1 batch prove
-- that this exact request advanced the replay row.
CREATE TABLE publisher_replay (
    server_id TEXT NOT NULL CHECK (
        length(server_id) = 64 AND server_id NOT GLOB '*[^0-9a-f]*'
    ),
    profile TEXT NOT NULL CHECK (profile IN ('classic-v1', 'game-v1')),
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

CREATE INDEX publisher_nonces_expires_idx
ON publisher_nonces(expires_at);

-- Static artifact generation consumes this durable, profile-separated outbox.
-- A heartbeat that changes only presence/authentication state does not advance
-- the visible revision or enqueue redundant rendering work.
CREATE TABLE directory_revisions (
    profile TEXT PRIMARY KEY CHECK (profile IN ('classic-v1', 'game-v1')),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    updated_at INTEGER NOT NULL
);

INSERT INTO directory_revisions (profile, revision, updated_at) VALUES
    ('classic-v1', 0, 0),
    ('game-v1', 0, 0);

CREATE TABLE directory_outbox (
    profile TEXT NOT NULL REFERENCES directory_revisions(profile),
    revision INTEGER NOT NULL CHECK (revision > 0),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (profile, revision)
);
