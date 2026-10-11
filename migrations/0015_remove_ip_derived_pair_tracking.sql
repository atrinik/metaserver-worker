-- Forward-only removal of application state derived from request IP addresses.
-- Apply with the coordinated provider/caller rollout; no runtime fallback uses
-- these tables. Historical migrations remain unchanged. Authenticated identity
-- budgets and random-capability replay state are deliberately retained.
DROP TABLE rendezvous_pair_attempts;
DROP TABLE rendezvous_pair_cooldowns;
