CREATE TABLE review_runs (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  source_sha TEXT NOT NULL CHECK (length(source_sha) = 40 AND source_sha NOT GLOB '*[^0-9a-f]*'),
  run_uuid TEXT NOT NULL CHECK (length(run_uuid) = 36),
  lease_generation INTEGER NOT NULL CHECK (lease_generation > 0),
  lease_expires_at INTEGER NOT NULL CHECK (lease_expires_at > 0),
  fixture_namespace TEXT NOT NULL CHECK (fixture_namespace GLOB 'review-canary-fixture-*'),
  state TEXT NOT NULL CHECK (state IN ('acquired', 'disabled', 'enabled', 'draining'))
) STRICT;
