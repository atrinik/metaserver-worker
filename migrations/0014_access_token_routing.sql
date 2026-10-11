-- Private admission routing state. Never copy these rows into public artifacts.
-- This append-only migration follows the coordinated publisher profile cutover.
CREATE TABLE access_routes (
    route_index TEXT PRIMARY KEY CHECK (
        length(route_index) = 64 AND route_index NOT GLOB '*[^0-9a-f]*'
    ),
    profile TEXT NOT NULL CHECK (profile IN ('classic', 'game')),
    server_id TEXT NOT NULL CHECK (
        length(server_id) = 64 AND server_id NOT GLOB '*[^0-9a-f]*'
    ),
    token_id TEXT NOT NULL CHECK (
        length(token_id) = 32 AND token_id NOT GLOB '*[^0-9a-f]*'
    ),
    token_revision TEXT NOT NULL CHECK (
        length(token_revision) BETWEEN 1 AND 20 AND
        token_revision NOT GLOB '*[^0-9]*' AND
        substr(token_revision, 1, 1) <> '0' AND
        (length(token_revision) < 20 OR token_revision <= '18446744073709551615')
    ),
    state TEXT NOT NULL CHECK (state IN ('reserved', 'active', 'revoked', 'expired')),
    expires_at INTEGER CHECK (expires_at IS NULL OR (
        typeof(expires_at) = 'integer' AND expires_at BETWEEN 1 AND 253402300799
    )),
    reservation_id TEXT CHECK (reservation_id IS NULL OR (
        length(reservation_id) = 32 AND reservation_id NOT GLOB '*[^0-9a-f]*'
    )),
    reserved_until INTEGER NOT NULL CHECK (
        typeof(reserved_until) = 'integer' AND reserved_until BETWEEN 1 AND 9007199254740991
    ),
    created_at INTEGER NOT NULL CHECK (
        typeof(created_at) = 'integer' AND created_at BETWEEN 0 AND 9007199254740991
    ),
    revoked_at INTEGER CHECK (revoked_at IS NULL OR (
        typeof(revoked_at) = 'integer' AND revoked_at BETWEEN 0 AND 9007199254740991
    )),
    CHECK ((state IN ('revoked', 'expired')) = (revoked_at IS NOT NULL)),
    UNIQUE(profile, server_id, token_id)
) WITHOUT ROWID;
CREATE INDEX access_routes_owner ON access_routes(profile, server_id, state);
CREATE INDEX access_routes_retention ON access_routes(revoked_at)
    WHERE state = 'revoked';

-- The stricter combined ceiling reserves capacity for security revocation:
-- changing any live row into a tombstone can never exhaust retained storage.
CREATE TRIGGER access_routes_capacity BEFORE INSERT ON access_routes
WHEN NOT EXISTS (SELECT 1 FROM access_routes WHERE route_index=NEW.route_index) BEGIN
    SELECT RAISE(ABORT, 'access route capacity') WHERE
      (SELECT count(*) FROM access_routes) >= 65536 OR
      (SELECT count(*) FROM access_routes
        WHERE profile = NEW.profile AND server_id = NEW.server_id) >= 4096 OR
      (NEW.state IN ('reserved', 'active') AND
       (SELECT count(*) FROM access_routes WHERE profile = NEW.profile AND
        server_id = NEW.server_id AND state IN ('reserved', 'active')) >= 1024);
END;
CREATE TRIGGER access_routes_identity_immutable
BEFORE UPDATE OF route_index, profile, server_id, token_id ON access_routes
WHEN OLD.route_index <> NEW.route_index OR OLD.profile <> NEW.profile OR
     OLD.server_id <> NEW.server_id OR OLD.token_id <> NEW.token_id
BEGIN SELECT RAISE(ABORT, 'access route identity is immutable'); END;
CREATE TRIGGER access_routes_revocation_terminal
BEFORE UPDATE ON access_routes WHEN OLD.state IN ('revoked', 'expired') AND
    (NEW.state IN ('reserved', 'active') OR NEW.revoked_at <> OLD.revoked_at)
BEGIN SELECT RAISE(ABORT, 'access route revocation is terminal'); END;

CREATE TABLE access_route_receipts (
    profile TEXT NOT NULL CHECK (profile IN ('classic', 'game')),
    server_id TEXT NOT NULL CHECK (
        length(server_id) = 64 AND server_id NOT GLOB '*[^0-9a-f]*'
    ),
    request_id TEXT NOT NULL CHECK (
        length(request_id) = 32 AND request_id NOT GLOB '*[^0-9a-f]*'
    ),
    request_digest TEXT NOT NULL CHECK (
        length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'
    ),
    tuple_digest TEXT NOT NULL CHECK (
        length(tuple_digest) = 64 AND tuple_digest NOT GLOB '*[^0-9a-f]*'
    ),
    operation TEXT NOT NULL CHECK (operation IN ('reserve', 'activate', 'revoke')),
    token_id TEXT NOT NULL CHECK (length(token_id) = 32 AND token_id NOT GLOB '*[^0-9a-f]*'),
    outcome TEXT NOT NULL CHECK (outcome IN (
        'reserved', 'active', 'revoked', 'conflict', 'expired', 'not_found', 'unavailable'
    )),
    reservation_id TEXT CHECK (reservation_id IS NULL OR (
        length(reservation_id) = 32 AND reservation_id NOT GLOB '*[^0-9a-f]*'
    )),
    reservation_expires_at INTEGER,
    token_revision TEXT NOT NULL CHECK (
        length(token_revision) BETWEEN 1 AND 20 AND
        token_revision NOT GLOB '*[^0-9]*' AND substr(token_revision, 1, 1) <> '0' AND
        (length(token_revision) < 20 OR token_revision <= '18446744073709551615')
    ),
    commit_token TEXT NOT NULL CHECK (length(commit_token) = 64 AND commit_token NOT GLOB '*[^0-9a-f]*'),
    created_at INTEGER NOT NULL CHECK (
        typeof(created_at) = 'integer' AND created_at BETWEEN 0 AND 9007199254740991
    ),
    expires_at INTEGER NOT NULL CHECK (
        typeof(expires_at) = 'integer' AND expires_at > created_at AND
        expires_at <= 9007199254740991
    ),
    PRIMARY KEY(profile, server_id, request_id)
) WITHOUT ROWID;
CREATE INDEX access_route_receipts_expiry ON access_route_receipts(expires_at);
CREATE TRIGGER access_route_receipts_capacity
BEFORE INSERT ON access_route_receipts BEGIN
    SELECT RAISE(ABORT, 'access receipt capacity') WHERE
      (SELECT count(*) FROM access_route_receipts) >= 65536 OR
      (SELECT count(*) FROM access_route_receipts
        WHERE profile = NEW.profile AND server_id = NEW.server_id) >= 4096;
END;

-- Fifteen-second admission capabilities retain only rotating purpose-HMAC
-- aliases. Raw grants remain solely in the bounded live websocket attachments.
CREATE TABLE access_grants (
    tag_current TEXT PRIMARY KEY CHECK (length(tag_current) BETWEEN 48 AND 79),
    tag_previous TEXT NOT NULL UNIQUE CHECK (length(tag_previous) BETWEEN 48 AND 79),
    route_index TEXT NOT NULL REFERENCES access_routes(route_index) ON DELETE CASCADE,
    profile TEXT NOT NULL CHECK (profile IN ('classic', 'game')),
    server_id TEXT NOT NULL CHECK (length(server_id)=64 AND server_id NOT GLOB '*[^0-9a-f]*'),
    token_revision TEXT NOT NULL CHECK (
        length(token_revision) BETWEEN 1 AND 20 AND token_revision NOT GLOB '*[^0-9]*' AND
        substr(token_revision,1,1)<>'0' AND
        (length(token_revision)<20 OR token_revision<='18446744073709551615')
    ),
    generation TEXT NOT NULL CHECK (length(generation)=64 AND generation NOT GLOB '*[^0-9a-f]*'),
    client_nonce TEXT NOT NULL CHECK (length(client_nonce)=64 AND client_nonce NOT GLOB '*[^0-9a-f]*'),
    expires_at INTEGER NOT NULL CHECK (typeof(expires_at)='integer' AND expires_at>0),
    redemption_id TEXT UNIQUE CHECK (redemption_id IS NULL OR (
        length(redemption_id)=64 AND redemption_id NOT GLOB '*[^0-9a-f]*'
    )),
    CHECK (tag_current<>tag_previous)
) WITHOUT ROWID;
CREATE INDEX access_grants_owner ON access_grants(profile,server_id);
CREATE INDEX access_grants_expiry ON access_grants(expires_at);
CREATE TRIGGER access_grants_capacity BEFORE INSERT ON access_grants BEGIN
    SELECT RAISE(ABORT, 'access grant capacity') WHERE
      (SELECT count(*) FROM access_grants)>=32768 OR
      (SELECT count(*) FROM access_grants WHERE profile=NEW.profile AND server_id=NEW.server_id)>=32;
END;

CREATE TABLE access_request_budgets (
    profile TEXT NOT NULL CHECK (profile IN ('classic','game')),
    server_id TEXT NOT NULL CHECK (length(server_id)=64 AND server_id NOT GLOB '*[^0-9a-f]*'),
    scope TEXT NOT NULL CHECK (scope IN ('routes','resolve')),
    window_start INTEGER NOT NULL CHECK (typeof(window_start)='integer' AND window_start>=0),
    expires_at INTEGER NOT NULL CHECK (typeof(expires_at)='integer' AND expires_at>window_start),
    request_count INTEGER NOT NULL CHECK (typeof(request_count)='integer' AND request_count BETWEEN 1 AND 64),
    PRIMARY KEY(profile,server_id,scope)
) WITHOUT ROWID;
CREATE INDEX access_request_budgets_expiry ON access_request_budgets(expires_at);
CREATE TRIGGER access_request_budgets_capacity BEFORE INSERT ON access_request_budgets
WHEN NOT EXISTS(SELECT 1 FROM access_request_budgets WHERE profile=NEW.profile AND server_id=NEW.server_id AND scope=NEW.scope)
BEGIN
    SELECT RAISE(ABORT,'access budget capacity') WHERE (SELECT count(*) FROM access_request_budgets)>=2048;
END;
