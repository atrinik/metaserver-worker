-- Publication checkpoints are private builder coordination state. They never
-- become part of a public artifact or cache key. Generation zero means that
-- no alias generation has been published yet.
CREATE TABLE directory_artifact_publications (
    profile TEXT PRIMARY KEY CHECK (profile IN ('classic-v1', 'game-v1')),
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

INSERT INTO directory_artifact_publications (profile)
VALUES ('classic-v1'), ('game-v1');

-- The directory model is not versioned, so only the newest unpublished
-- revision per profile is actionable. Coalescing in the same transaction as
-- every insert bounds durable outage growth without weakening recovery.
DELETE FROM directory_outbox
WHERE EXISTS (
    SELECT 1 FROM directory_outbox AS newer
    WHERE newer.profile = directory_outbox.profile AND
          newer.revision > directory_outbox.revision
);

CREATE TRIGGER directory_outbox_coalesce_after_insert
AFTER INSERT ON directory_outbox
BEGIN
    DELETE FROM directory_outbox
    WHERE profile = NEW.profile AND revision < NEW.revision;
END;

-- One bounded marker per profile lets the final D1 checkpoint/outbox batch
-- prove its postconditions inside the transaction. A skipped required write
-- therefore rolls back instead of producing a successful-but-divergent build.
CREATE TABLE directory_artifact_commits (
    profile TEXT PRIMARY KEY CHECK (profile IN ('classic-v1', 'game-v1')),
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

-- The bounded rollback ledger is authoritative outside the builder Durable
-- Object so a DO reset or point-in-time restore cannot make acknowledged
-- immutable generations look abandoned. The checkpoint transaction retains
-- the current generation and its seven newest predecessors.
CREATE TABLE directory_artifact_history (
    profile TEXT NOT NULL CHECK (profile IN ('classic-v1', 'game-v1')),
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
