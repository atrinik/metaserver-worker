-- Preserve compatibility with already-issued raw-address challenges while new
-- Worker versions write two rotating, purpose-separated source-tag aliases. The
-- old source_ip column remains until the signed publisher removes this table.
ALTER TABLE one_time_tokens ADD COLUMN source_tag TEXT CHECK (
    source_tag IS NULL OR (
        length(source_tag) BETWEEN 48 AND 79 AND
        substr(source_tag, 1, 3) = 'v1.' AND
        instr(substr(source_tag, 4), '.') BETWEEN 2 AND 33 AND
        substr(
            source_tag,
            4,
            instr(substr(source_tag, 4), '.') - 1
        ) NOT GLOB '*[^A-Za-z0-9_-]*' AND
        length(substr(
            source_tag,
            4 + instr(substr(source_tag, 4), '.')
        )) = 43 AND
        substr(
            source_tag,
            4 + instr(substr(source_tag, 4), '.')
        ) NOT GLOB '*[^A-Za-z0-9_-]*'
    )
);

ALTER TABLE one_time_tokens ADD COLUMN source_tag_previous TEXT CHECK (
    source_tag_previous IS NULL OR (
        length(source_tag_previous) BETWEEN 48 AND 79 AND
        substr(source_tag_previous, 1, 3) = 'v1.' AND
        instr(substr(source_tag_previous, 4), '.') BETWEEN 2 AND 33 AND
        substr(
            source_tag_previous,
            4,
            instr(substr(source_tag_previous, 4), '.') - 1
        ) NOT GLOB '*[^A-Za-z0-9_-]*' AND
        length(substr(
            source_tag_previous,
            4 + instr(substr(source_tag_previous, 4), '.')
        )) = 43 AND
        substr(
            source_tag_previous,
            4 + instr(substr(source_tag_previous, 4), '.')
        ) NOT GLOB '*[^A-Za-z0-9_-]*'
    )
);

CREATE TRIGGER one_time_tokens_source_insert
BEFORE INSERT ON one_time_tokens
WHEN NOT (
    (
        NEW.source_tag IS NULL AND
        NEW.source_tag_previous IS NULL AND
        length(NEW.source_ip) > 0
    ) OR (
        NEW.source_tag IS NOT NULL AND
        NEW.source_tag_previous IS NOT NULL AND
        NEW.source_tag <> NEW.source_tag_previous AND
        substr(
            NEW.source_tag,
            4,
            instr(substr(NEW.source_tag, 4), '.') - 1
        ) <> substr(
            NEW.source_tag_previous,
            4,
            instr(substr(NEW.source_tag_previous, 4), '.') - 1
        ) AND
        NEW.source_ip = ''
    )
)
BEGIN
    SELECT RAISE(ABORT, 'invalid one-time token source representation');
END;

CREATE TRIGGER one_time_tokens_source_update
BEFORE UPDATE ON one_time_tokens
WHEN NOT (
    (
        NEW.source_tag IS NULL AND
        NEW.source_tag_previous IS NULL AND
        length(NEW.source_ip) > 0
    ) OR (
        NEW.source_tag IS NOT NULL AND
        NEW.source_tag_previous IS NOT NULL AND
        NEW.source_tag <> NEW.source_tag_previous AND
        substr(
            NEW.source_tag,
            4,
            instr(substr(NEW.source_tag, 4), '.') - 1
        ) <> substr(
            NEW.source_tag_previous,
            4,
            instr(substr(NEW.source_tag_previous, 4), '.') - 1
        ) AND
        NEW.source_ip = ''
    )
)
BEGIN
    SELECT RAISE(ABORT, 'invalid one-time token source representation');
END;

-- Exact fixed-window request budgets. Actor keys are either an authenticated
-- 64-character server identity or a versioned, purpose-separated opaque tag.
-- Raw IPv6 addresses cannot satisfy the restricted alphabet; raw IPv4
-- addresses are rejected explicitly.
CREATE TABLE request_budgets (
    actor_key TEXT NOT NULL CHECK (
        length(actor_key) BETWEEN 8 AND 128 AND
        actor_key NOT GLOB '*[^A-Za-z0-9._-]*' AND
        (
            (
                length(actor_key) = 64 AND
                actor_key NOT GLOB '*[^0-9a-f]*'
            ) OR (
                substr(actor_key, 1, 3) = 'v1.' AND
                instr(substr(actor_key, 4), '.') BETWEEN 2 AND 33 AND
                substr(
                    actor_key,
                    4,
                    instr(substr(actor_key, 4), '.') - 1
                ) NOT GLOB '*[^A-Za-z0-9_-]*' AND
                length(substr(
                    actor_key,
                    4 + instr(substr(actor_key, 4), '.')
                )) = 43 AND
                substr(
                    actor_key,
                    4 + instr(substr(actor_key, 4), '.')
                ) NOT GLOB '*[^A-Za-z0-9_-]*'
            )
        )
    ),
    scope TEXT NOT NULL CHECK (scope IN (
        'compat-status',
        'compat-directory',
        'compat-otp',
        'compat-update-source',
        'compat-update-server',
        'publish-server',
        'rendezvous-client-source',
        'rendezvous-client-source-server',
        'rendezvous-server-source',
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

CREATE INDEX request_budgets_expires_idx
    ON request_budgets(expires_at);

CREATE INDEX rate_limits_window_start_idx
    ON rate_limits(window_start);
