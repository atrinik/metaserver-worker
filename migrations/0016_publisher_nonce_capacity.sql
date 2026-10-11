-- Preserve all populated replay history, including still-live historical
-- profiles. Existing nonterminal routes retain a nonce slot for revocation.
-- Runtime admission uses the fixed 131072 combined nonce/route ceiling; only
-- zero-growth revocations may use grandfathered space while old rows drain.
CREATE TABLE publisher_nonce_capacity (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    maximum_rows INTEGER NOT NULL CHECK (maximum_rows >= 131072)
);
INSERT INTO publisher_nonce_capacity(singleton, maximum_rows)
SELECT 1, max(131072, (SELECT count(*) FROM publisher_nonces) +
    (SELECT count(*) FROM access_routes WHERE state IN ('reserved','active')));

CREATE TRIGGER publisher_nonces_capacity BEFORE INSERT ON publisher_nonces BEGIN
    SELECT RAISE(ABORT, 'publisher nonce capacity') WHERE
      (SELECT count(*) FROM publisher_nonces) >=
      coalesce((SELECT maximum_rows FROM publisher_nonce_capacity WHERE singleton = 1), 0);
END;
