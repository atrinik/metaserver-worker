# Atrinik metaserver Worker repository guide

- This repository owns the Cloudflare Worker bootstrap, QUIC rendezvous
  protocol, admin policy, D1 schema, and Durable Object coordination. Keep game
  server/client implementation in their standalone repositories.
- Use the `.nvmrc` Node 24.18.1 and `packageManager` npm 11.16.0 pins with the
  lockfile. Run `npm ci` for a clean dependency tree and `npm run check` before
  submitting.
- Preserve strict request-size, identity, address, ticket, certificate-hash,
  rate-limit, and expiry validation. Keep rendezvous state deterministic and
  bounded; test malformed and replayed input at the boundary.
- Keep the Worker-to-rendezvous-room upgrade contract explicitly versioned and
  fail closed across deployment skew. Use hibernation attachments only for
  bounded live-session routing and terminal-teardown state, D1 for the exact
  eligible source/server rolling-burst cooldown, the room's SQLite ledger only
  for bounded purpose-separated replay tags, and one alarm for expiry; never
  add candidate persistence or per-session timers.
- `wrangler.jsonc` is the sole state-owning core configuration. It deliberately
  uses declarative `exports` for both SQLite Durable Objects and the narrow
  publisher/rendezvous Worker entrypoints, and contains a placeholder D1 ID.
  `wrangler.publisher.jsonc` and `wrangler.rendezvous.jsonc` are stateless,
  domainless public-edge configurations with one named service binding each;
  never add D1, R2, Durable Object, cron, or cross-service authority to them.
  Do not add legacy Durable Object migration configuration alongside
  `exports`. Apply every pending D1 migration before deploying this provider;
  then deploy the core before either caller. Lifecycle changes require a direct
  100% `wrangler deploy`; `versions upload`, gradual rollout, and rollback
  across that lifecycle boundary are unsupported.
- Production state exists. `migrations/0001_initial.sql` is applied history:
  never rewrite, reorder, or reuse it. Add every schema transition as a new,
  ordered migration and test the complete populated-schema upgrade path.
- `deployment/workers-builds-production.json` is the sole checked-in automatic
  production-delivery contract. Workers Builds skips implicit installation,
  selects the pinned npm, runs `npm ci`, and then `npm run deploy:production`
  for every accepted `main` push. Keep its exact
  Node/npm/Wrangler pins, all-path trigger, protected-input names, migration
  gate, no-op digest, newest-current-main lease, strict disabled-circuit
  core/publisher/rendezvous staging, caller-before-core restoration, coherent
  phase readback, prefix-proven migration horizons, positive-allowlist child
  environments, live-trigger reconciliation, and bounded static plus
  canonical-envelope Service Binding canaries synchronized with the
  implementation and runbook. `npm run deploy:production:dry-run` must retain zero remote
  mutation paths.
- Treat `server_presence` plus the profile-discriminated `directory_entries`
  as authoritative, profile-scoped publication state. Presence retains only
  the accepted rendezvous verifier, generation, and last-seen time for both public and
  private publishers; `directory_entries` alone is public. Classic v1 and v2
  share one replay lineage but have disjoint password/access-code policy rows;
  Game remains independent. Never use sentinel fields to imitate another
  profile. Game rows additionally retain the exact derived
  canonical-JSON byte count so D1 can reject an over-limit aggregate before it
  becomes authoritative. Visible expiry must
  advance `directory_revisions` and `directory_outbox` atomically before
  removing expired entries; stale private presence is revision-neutral.
- Treat D1 revision/outbox as the static-directory authority and the
  profile-named `DirectoryBuilder` only as a serialized, retryable publisher.
  Persist pending intent before R2 awaits, publish immutable objects before
  aliases, compare-and-swap every alias, verify the complete alias cohort
  before checkpointing, coalesce the outbox, and keep rollback retention
  bounded. Keep application SHA-256 as independent body-integrity metadata;
  R2's opaque native strong ETag and alias upload time are the public
  conditional validator and Last-Modified. Never publish an alias before its
  generated time or at/after its expiry. Never expose the private D1 revision
  or historical removed models in a public body, key, or metadata field.
- Keep long-lived static caching and event-driven invalidation coupled. After
  an exact alias cohort and D1 checkpoint, globally purge only that profile's
  three configured HTTPS `index.*` URLs. The pending build is the durable retry
  journal; purge failure must complete the event, preserve that state, and
  schedule retry rather than risk rolling it back. Keep the Cache Purge token
  encrypted, core-only, zone-scoped, and absent from logs and persistence.
- Use `scripts/static_origin_canary.py` for public static-origin evidence. It is
  deliberately credential-free and read-only, defaults to non-production DNS,
  bounds every response and convergence retry, and must never grow Cloudflare
  API mutation or token handling. Resource/rule changes remain separately
  authorized operator actions.
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
- `deployment/workers-builds-review.json` owns the non-`main` review design.
  Same-repository branch automation is build-only, has no bindings, protected
  inputs, account/zone resource permission, upload, or URL, and must reject
  `main`; fork refs remain outside the connected repository. The provider-native
  preview trigger shares the production core Worker and repository connection
  but has a distinct zero-resource token and a separate nonsecret environment;
  no production trigger setting or protected input is available to review builds. The trusted setup/budget
  operator's account-wide Builds control-plane reach (builds, tokens,
  environment variables, connections, triggers, and manual builds) is an
  explicit provider limitation; its user API token is never build-readable and
  exact review trigger ID guards must reject production-trigger mutations.
  Branch builds create no Worker version. Live review is an operator-supervised exact-SHA run in a dedicated
  account with no GitHub connection or zone. Its production-disjoint resources, disabled
  circuits, exact-duration lease, quiescing/terminal teardown fence, logical
  versus physical fixture retention, Access boundary, and force-delete/readback cleanup guards must
  remain synchronized with `docs/review-environment.md` and
  `scripts/review-environment.mjs`. `scripts/workers-builds-provisioning.mjs`
  composes both checked-in contracts, requires stable exhaustive private
  provider inventories plus fresh distinct production/review random-sentinel
  GitHub evidence,
  performs only readback and local protected-document materialization, and must never gain implicit
  provider mutation. Provider apply and live-canary execution remain gated by
  issue #56 authorization; `npm run deploy:review-canary` must fail closed
  until the dedicated account and exact runner are reviewed and provisioned.
- Preserve the curated `request_rejected`, `blacklist_match`, and
  `unexpected_error` diagnostics with their closed, redacted schemas. Do not
  log routine success, expected `404`, rate-limit, or open-circuit traffic; use
  aggregate platform metrics/WAF analytics for traffic measurements.
- Keep generated Wrangler types and `dist/` untracked. Generate and check each
  configuration's types independently, and keep caller declarations isolated
  from the core `Cloudflare.Env`. Update bindings, runtime types, tests, and all
  three dry-run configurations together.
- Never deploy, run remote D1 migrations, reset ownership, or mutate Cloudflare
  resources merely to validate a change. Those external actions require
  explicit authorization and reviewed production bindings. The automatic
  entrypoint is authorized only inside the configured Workers Builds `main`
  trigger; local execution without `--dry-run` must fail before remote access.
- Commits and pull-request titles use Conventional Commits. Every squash merge
  is released by semantic-release.
- Preserve unrelated work and finish with `git diff --check`.
- Update this `AGENTS.md` in the same change when major rework alters platform
  ownership, bindings, state/migration policy, protocol, or validation.
