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
  provider inventories plus fresh production random-sentinel GitHub evidence,
  and stages review activation behind a bounded digest-bound phase authority,
  fresh per-command current-main evidence, a fresh private absent-root proof,
  inert commands, the exact nonsecret environment, and an atomic final trigger PATCH.
  A separately authorized review-token rotation may replace the review wrapper only through
  the digest-pinned `review-token-rotation` gate: create one exact zero-resource successor,
  repoint the journaled inert production trigger and final review trigger without changing any
  other field, bind the replacement owner to a fresh accepted account-membership observation,
  preserve the complete non-token production control plane, prove the predecessor wrapper
  unreferenced across the exhaustive account inventory, then delete only that wrapper. Bind
  current-main and authority before each exhaustive forward sweep, but measure the 30-second
  mutation handoff from the fresh provider proof capture to intent, not from the earlier
  authority check; the sweep may exceed 30 seconds while the authority retains its full reserve.
  Bind
  the terminal rotation proof and checksum-valid journal into every later disposable authority;
  the original setup wrapper remains predecessor provenance and is never treated as live.
  If predecessor deletion succeeds before terminal evidence is durable, recover only through the
  historical-authority exact-state readback terminal; never backdate the deletion tombstone,
  retry the deletion, or recreate the predecessor wrapper.
  The fresh intermediate readback must also bind Cloudflare's peer disposition: accept either
  the unchanged predecessor-token review trigger or only the provider-added production sentinel
  exclusion. If rollback begins from that augmented phase, bind the current attempt's exact
  completed 17-record forward prefix or only the contract-enumerated partial-production and
  final-review-no-effect suffixes, the attempt namespace, and all applicable pre-mutation
  proofs. Exceptional prefixes require a fresh exhaustive augmented-state handoff captured
  after the last forward record; never backdate or synthesize a missing mutation bound. An
  expired no-owned prefix may end at the fifth pre-create proof binding. Immediate and rerun
  no-owned terminal validation must load that exact pre-create proof document; never substitute
  the residual rollback proof. Fresh rotation authority binds the exact #114 program/#118 leaf
  ledger and the completed #115 successor terminal. The failed #110 five-record forward and
  two-record rollback journals are immutable inputs to that separately checksum-framed,
  read-only successor terminal:
  bind their exact raw/document coordinates and failed executor, capture a fresh exhaustive
  predecessor snapshot under its own authenticated current-main proof, and use only the dedicated
  no-owned successor verifier. Preserve its deterministic readable/compact equivalence test and
  execute both forms against the same terminal evidence. Never append or relabel either historical
  journal. Then restore
  a fresh exhaustive augmented-state rollback precondition after current-main and authority
  and no more than 30 seconds before the production intent, restore production first, prove
  the resulting peer state, and patch
  review only when that one
  exclusion remains. Never substitute the pinned
  historical incident coordinate for a fresh attempt.
  The #96 provider-normalized incident is a separate rollback-only phase: bind its exact
  12-record prefix and exhaustive peer-augmented snapshot, restore production first, then prove
  whether Cloudflare normalized the peer review trigger. Patch review only when the one sentinel
  exclusion remains, prove predecessor restoration and global replacement-wrapper absence, and
  delete only the journal-created replacement. Every incident write uses the incident-only
  historical-authority verifier, which authenticates current `main` while retaining the exact
  pinned historical source, plan, and authority file. Never alias this state to an ordinary
  rotation phase or continue the forward rotation.
  The #102 rollback-blocked terminal is immutable. Its final delete intent stopped before any
  provider DELETE because the account-wide `/builds/triggers` guard is unsupported. Retire that
  still-present wrapper only through the separate #104 one-write successor: pin the exact blocked
  journal, proof, snapshot, executor, and failed guard. Only that exact pinned 96,731-byte
  historical executor may use the narrow 128 KiB incident-evidence limit; the successor executor
  and every other private document retain the 64 KiB limit. Recapture the account trigger inventory by
  stable Worker-script enumeration plus per-script trigger reads; issue a fresh current-main-bound
  authority bound to the full proof document and one canonical receipt; and delete only the
  freshly proven globally unreferenced replacement UUID. Bind the terminal provider observation to
  its own authenticated current-main proof; keep that observation source distinct from both the
  historical write-authority source and any later verifier's current main. A blocked residual sweep
  must start after the failed prefix, and exact complete/blocked terminals require the dedicated
  successor-journal verifier before handoff or rerun. Never
  resume the old intent, repeat either trigger PATCH, or use the unsupported account-wide route.
  The disposable automatic-build proof uses a separate renewable 60-minute
  authority issued only from the exact review-active state; it permits only the
  journaled disposable push/delete and exact owned-build cleanup, never production activation.
  Bind the exact branch, commit, journal identity, predecessor journals, and current
  trigger/wrapper UUIDs; require exclusive one-use receipts, 40 minutes remaining
  before push, and five before deletion.
  A membership-readable review-token repair must create a fresh user token,
  never edit the failed token in place or use an account-owned token. Bind the
  exact #120 failure and current review-active state, permit only User Details
  Read plus Memberships Read on only that owner's self-user resource with no
  account/zone scope, then hand the new
  owner-only secret and policy proof to the existing journaled wrapper rotation
  and disposable automatic-build proof. API Tokens Write is a separate
  owner-bootstrap boundary and must not be inferred from any Workers Builds
  credential.
  It performs only readback and local protected-document materialization, and must never gain implicit
  provider mutation. Provider apply and live-canary execution remain gated by
  separate maintainer authorization; `npm run deploy:review-canary` must fail
  closed until the dedicated account and exact runner are reviewed and provisioned.
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
