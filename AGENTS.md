# Atrinik metaserver Worker repository guide

- This repository owns the Cloudflare Worker bootstrap, QUIC rendezvous
  protocol, admin policy, D1 schema, and Durable Object coordination. Keep game
  server/client implementation in their standalone repositories.
- Use Node.js 20 or newer and the lockfile. Run `npm ci` for a clean dependency
  tree and `npm run check` before submitting.
- Preserve strict request-size, identity, address, ticket, certificate-hash,
  rate-limit, and expiry validation. Keep rendezvous state deterministic and
  bounded; test malformed and replayed input at the boundary.
- Keep the Worker-to-rendezvous-room upgrade contract explicitly versioned and
  fail closed across deployment skew. Use hibernation attachments only for
  bounded live-session routing and terminal-teardown state, the room's SQLite
  ledger for exact rolling admissions and purpose-separated replay tags, and
  one alarm for expiry; never add candidate persistence or per-session timers.
- `wrangler.jsonc` deliberately uses declarative `exports` for the SQLite
  Durable Object and a placeholder D1 ID. Do not add legacy Durable Object
  migration configuration alongside `exports`. Lifecycle changes require a
  direct 100% `wrangler deploy`; `versions upload`, gradual rollout, and
  rollback across that lifecycle boundary are unsupported.
- Production state exists. `migrations/0001_initial.sql` is applied history:
  never rewrite, reorder, or reuse it. Add every schema transition as a new,
  ordered migration and test the complete populated-schema upgrade path.
- Treat `server_presence` plus `directory_entries` as authoritative,
  profile-scoped publication state. Presence retains only the accepted
  rendezvous verifier, generation, and last-seen time for both public and
  private publishers; `directory_entries` alone is public. Visible expiry must
  advance `directory_revisions` and `directory_outbox` atomically before
  removing expired entries; stale private presence is revision-neutral.
- Treat D1 revision/outbox as the static-directory authority and the
  profile-named `DirectoryBuilder` only as a serialized, retryable publisher.
  Persist pending intent before R2 awaits, publish immutable objects before
  aliases, compare-and-swap every alias, verify the complete alias cohort
  before checkpointing, coalesce the outbox, and keep rollback retention
  bounded. Never expose the private D1 revision or historical removed models in
  a public body, key, or metadata field.
- Route every direct-hostname write through `isCanonicalHostname()` before D1.
  SQLite independently enforces the bounded ASCII representation but has no
  Unicode/IDNA tables; direct administrative hostname writes are unsupported.
- Treat request addresses as request-scoped data. Persist only authenticated
  identities or purpose-separated, rotating HMAC tags with bounded retention;
  never log raw addresses, tags, credentials, tokens, or rendezvous candidates.
- Declare required secret names in Wrangler configuration, keep their values in
  Cloudflare secrets or ignored local development files, and fail closed when
  key material or a route circuit breaker is invalid.
- Keep production `workers.dev` and preview URLs disabled so zone WAF/custom
  domain policy cannot be bypassed. Use an isolated Worker/Durable Object,
  custom hostname, secrets, D1 database, Analytics Engine dataset, and native
  Rate Limiting namespace IDs for canaries; reused namespace IDs share
  counters across Workers.
- Preserve the curated `request_rejected`, `blacklist_match`, and
  `unexpected_error` diagnostics with their closed, redacted schemas. Do not
  log routine success, expected `404`, rate-limit, or open-circuit traffic; use
  aggregate platform metrics/WAF analytics for traffic measurements.
- Keep generated Wrangler types and `dist/` untracked. Update bindings, runtime
  types, tests, and dry-run configuration together.
- Never deploy, run remote D1 migrations, reset ownership, or mutate Cloudflare
  resources merely to validate a change. Those external actions require
  explicit authorization and reviewed production bindings.
- Commits and pull-request titles use Conventional Commits. Every squash merge
  is released by semantic-release.
- Preserve unrelated work and finish with `git diff --check`.
- Update this `AGENTS.md` in the same change when major rework alters platform
  ownership, bindings, state/migration policy, protocol, or validation.
