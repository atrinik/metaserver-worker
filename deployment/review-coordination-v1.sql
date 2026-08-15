CREATE TABLE review_environment_control (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  mode TEXT NOT NULL CHECK (mode IN ('active', 'quiescing', 'teardown')),
  quiesced_at INTEGER,
  CHECK ((mode = 'active' AND quiesced_at IS NULL) OR
         (mode IN ('quiescing', 'teardown') AND quiesced_at IS NOT NULL))
);

INSERT INTO review_environment_control (singleton, mode, quiesced_at) VALUES (1, 'active', NULL);

CREATE TABLE review_runs (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  source_sha TEXT NOT NULL CHECK (length(source_sha) = 40 AND source_sha NOT GLOB '*[^0-9a-f]*'),
  run_uuid TEXT NOT NULL CHECK (
    length(run_uuid) = 36 AND
    length(replace(run_uuid, '-', '')) = 32 AND
    substr(run_uuid, 9, 1) = '-' AND substr(run_uuid, 14, 1) = '-' AND
    substr(run_uuid, 19, 1) = '-' AND substr(run_uuid, 24, 1) = '-' AND
    replace(run_uuid, '-', '') NOT GLOB '*[^0-9a-f]*' AND
    substr(run_uuid, 15, 1) = '4' AND substr(run_uuid, 20, 1) GLOB '[89ab]'
  ),
  lease_generation INTEGER NOT NULL CHECK (lease_generation > 0),
  lease_expires_at INTEGER NOT NULL CHECK (lease_expires_at > 0),
  fixture_namespace TEXT NOT NULL CHECK (
    fixture_namespace = 'review-canary-fixture-' || source_sha || '-' || run_uuid
  ),
  state TEXT NOT NULL CHECK (state IN ('acquired', 'disabled', 'enabled', 'draining'))
) STRICT;
