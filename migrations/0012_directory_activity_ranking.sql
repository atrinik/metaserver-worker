-- Bounded, profile-scoped activity evidence for deterministic directory
-- ranking.  These tables intentionally contain only aggregate population
-- observations and operator policy; they never contain a player, address,
-- ticket, credential, or request identifier.
CREATE TABLE directory_activity_state (
    profile TEXT NOT NULL CHECK (
        profile IN ('classic-v1', 'classic-v2', 'game-v1')
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
        profile IN ('classic-v1', 'classic-v2', 'game-v1')
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

CREATE TABLE directory_admin_pins (
    profile TEXT NOT NULL CHECK (
        profile IN ('classic-v1', 'classic-v2', 'game-v1')
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

CREATE INDEX directory_admin_pins_profile_priority_idx
ON directory_admin_pins(profile, priority, server_id);

-- Pin policy is bounded independently of the public directory.  A pin for a
-- missing, private, or denied identity is inert and cannot make that identity
-- discoverable; retaining it is useful for an operator's review workflow.
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
