-- Replace canonical client calendar-day quotas with exact rolling pair bursts.
-- Raw network addresses never enter either table: actor_key contains only a
-- purpose-separated, rotating source/server HMAC tag.
CREATE TABLE rendezvous_pair_attempts (
    actor_key TEXT NOT NULL CHECK (
        length(actor_key) BETWEEN 48 AND 79 AND
        substr(actor_key, 1, 3) = 'v1.' AND
        instr(substr(actor_key, 4), '.') BETWEEN 2 AND 33 AND
        substr(actor_key, 4, instr(substr(actor_key, 4), '.') - 1)
            NOT GLOB '*[^A-Za-z0-9_-]*' AND
        length(substr(actor_key, 4 + instr(substr(actor_key, 4), '.'))) = 43 AND
        substr(actor_key, 4 + instr(substr(actor_key, 4), '.'))
            NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
    attempt_id TEXT NOT NULL CHECK (
        length(attempt_id) = 32 AND attempt_id NOT GLOB '*[^0-9a-f]*'
    ),
    attempted_at INTEGER NOT NULL CHECK (
        typeof(attempted_at) = 'integer' AND attempted_at >= 0
    ),
    expires_at INTEGER NOT NULL CHECK (
        typeof(expires_at) = 'integer' AND
        expires_at - attempted_at BETWEEN 1 AND 60
    ),
    PRIMARY KEY (actor_key, attempt_id)
) WITHOUT ROWID;

CREATE INDEX rendezvous_pair_attempts_expiry_idx
    ON rendezvous_pair_attempts (expires_at, actor_key, attempt_id);

CREATE TABLE rendezvous_pair_cooldowns (
    actor_key TEXT PRIMARY KEY CHECK (
        length(actor_key) BETWEEN 48 AND 79 AND
        substr(actor_key, 1, 3) = 'v1.' AND
        instr(substr(actor_key, 4), '.') BETWEEN 2 AND 33 AND
        substr(actor_key, 4, instr(substr(actor_key, 4), '.') - 1)
            NOT GLOB '*[^A-Za-z0-9_-]*' AND
        length(substr(actor_key, 4 + instr(substr(actor_key, 4), '.'))) = 43 AND
        substr(actor_key, 4 + instr(substr(actor_key, 4), '.'))
            NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
    blocked_until INTEGER NOT NULL CHECK (
        typeof(blocked_until) = 'integer' AND blocked_until >= 1
    ),
    penalty_level INTEGER NOT NULL CHECK (
        typeof(penalty_level) = 'integer' AND penalty_level BETWEEN 0 AND 30
    ),
    last_burst_at INTEGER NOT NULL CHECK (
        typeof(last_burst_at) = 'integer' AND last_burst_at >= 0 AND
        blocked_until > last_burst_at
    ),
    expires_at INTEGER NOT NULL CHECK (
        typeof(expires_at) = 'integer' AND expires_at >= blocked_until AND
        expires_at - last_burst_at BETWEEN 1 AND 1800
    )
) WITHOUT ROWID;

CREATE INDEX rendezvous_pair_cooldowns_expiry_idx
    ON rendezvous_pair_cooldowns (expires_at, actor_key);
