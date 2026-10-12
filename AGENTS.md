# Atrinik metaserver Worker repository guide

- This repository owns the Cloudflare Worker bootstrap, QUIC rendezvous
  protocol, admin policy, D1 schema, and Durable Object coordination. Keep game
  server/client implementation in their standalone repositories.
- Use the `.nvmrc` Node 24.18.1 and `packageManager` npm 11.16.0 pins with the
  lockfile. Run `npm ci` for a clean dependency tree and `npm run check` before
  submitting.
- Preserve strict request-size, identity, candidate-address, ticket, certificate-hash,
  rate-limit, and expiry validation. Keep rendezvous state deterministic and
  bounded; test malformed and replayed input at the boundary.
- Keep the Worker-to-rendezvous-room upgrade contract explicitly versioned and
  fail closed across deployment skew. Use hibernation attachments only for
  bounded live-session routing and terminal-teardown state, D1 for authenticated
  identity budgets and private access state, the room's SQLite ledger only
  for bounded purpose-separated replay tags, and one alarm for expiry; never
  add candidate persistence or per-session timers.
- `wrangler.jsonc` is the sole state-owning core configuration. It deliberately
  uses declarative `exports` for both SQLite Durable Objects and the narrow
  publisher/rendezvous and private `RendezvousHealth` and
  `DirectoryReconciliation` Worker entrypoints, and
  contains a placeholder D1 ID. `DirectoryReconciliation.reconcile()` accepts
  zero arguments through a deployment-owned Service Binding and constructs the
  fixed empty POST `https://internal.atrinik.invalid/v1/directory-reconciliation`
  inside the Worker. Its fetch handler retains that exact envelope guard; it
  reconciles only the two fixed current
  profiles and verifies authoritative publication receipts without exposing
  private revisions. Never give it a public route or caller binding, a default
  fetch handler, or supplied profile/object/URL authority.
  `RendezvousHealth` is the only owner of the
  versioned, bounded rendezvous-health aggregate; its exact private URL,
  required token secret, canary envelope, and redacted response are documented
  in `docs/rendezvous-health.md`. It has no public route or default fetch path.
  `wrangler.publisher.jsonc` and `wrangler.rendezvous.jsonc` are stateless,
  domainless public-edge configurations with one named service binding each;
  never add D1, R2, Durable Object, cron, signing secrets/key IDs, or cross-service
  authority to them. All grant/ticket HMACs and admission signatures belong to core.
  Do not add legacy Durable Object migration configuration alongside
  `exports`. After reviewed backups and explicit migration authorization, apply
  every pending D1 migration before deploying this provider;
  then deploy the core before either caller. Lifecycle changes require a direct
  100% `wrangler deploy`; `versions upload`, gradual rollout, and rollback
  across that lifecycle boundary are unsupported.
- Production state exists. `migrations/0001_initial.sql` is applied history:
  never rewrite, reorder, or reuse it. Add every schema transition as a new,
  ordered migration and test the complete populated-schema upgrade path. The
  `rendezvous_health_observations` singleton is bounded rolling aggregate state;
  it must never gain server, room, connection, ticket, candidate, credential,
  or source-address columns.
- `deployment/workers-builds-development.json` owns automatic reviewed-`main`
  delivery to the existing persistent DEV cohort, activated only after owner-approved
  merge of the concrete source PR. Retain DEV `DevelopmentMaintenance` alarm
  scheduling and constant object identity/state; do not add cron or change PROD
  scheduling. Run `npm run deploy:development`
  only inside the exact automatic GitHub Actions main workflow. Keep pinned tools, all-path
  triggers, exact-current-main fencing, protected DEV inputs, no-op digests,
  exact migration ledgers, ordered disabled staging and caller-before-core
  restoration synchronized with the implementation and
  `docs/deployment-environments.md`. Automatic delivery never applies SQL.
- `deployment/workers-builds-production.json` owns explicit GitHub Actions
  production promotion. A main push or release event grants no production
  mutation. Require an owner-approved immutable exact tag/SHA, verified release
  provenance and artifact/configuration/migration digests, expected predecessor,
  fixed production concurrency, and a one-use attempt. Reject workflow reruns.
  Fence and drain the old automatic production writer before publication.
  Retain its v1 contract under `deployment/historical/` solely for historical
  incident verification; never reactivate it as routine policy. Stop before
  promotion until the owner reviews and approves the exact tag. Both environment
  dry runs must retain zero remote mutation paths.
  The selected Git tree must contain the supported canonical
  `deployment/directory-reconciliation-interface.json` regular blob before any
  provider access. Bind its digest into the deployable plan. Older compatible
  tags may lag main; historical fetch-only tags and uncommitted declarations
  are ineligible. Never fall back to Node HTTP transport or loosen its envelope.
- Both GitHub execution environments require protected
  `ATRINIK_DELIVERY_RESOURCE_POLICY` and
  `ATRINIK_DELIVERY_RESOURCE_READ_TOKEN`. The bounded private policy pins exact
  resource ownership/configuration for PROD, DEV and any provisioned live-review
  cohort. Re-read every cohort at each engine phase and private reconciliation;
  reject binding/resource/configuration drift. Bind the resource-policy digest
  into the approved deployable digest. Target public callers must have zero
  provider secrets; pin unchanged non-target legacy secret names without cleanup
  authority. Provider readback exposes names, never secret values: disjoint key
  generation requires separate provisioning-receipt proof.
- Treat `server_presence` plus the profile-discriminated `directory_entries`
  as authoritative, profile-scoped publication state. Active profiles are Classic
  publisher v3/directory v6 and Game publisher v2/directory v2. Private presence
  retains the signed certificate, name, endpoint, access policy, rendezvous verifier,
  generation and last-seen time; `directory_entries` alone is public. Historic
  publisher profiles retain replay lineage only and have no runtime fallback.
  Never use sentinel fields to imitate another profile. Game rows additionally retain the exact derived
  canonical-JSON byte count so D1 can reject an over-limit aggregate before it
  becomes authoritative. Visible expiry must
  advance `directory_revisions` and `directory_outbox` atomically before
  removing expired entries; stale private presence is revision-neutral.
- Access tokens use authenticated POST route CRUD on the publisher authority and
  bounded POST resolve plus the access rendezvous subprotocol on the rendezvous
  authority. No secret belongs in a URL, log, public artifact or cache. Require
  an existing publisher identity before CRUD allocation; reserve additionally
  requires fresh signed presence. Share publisher sequence/nonce replay fences.
  Keep reserve/activate CAS, terminal revocation, global index collision checks,
  receipts and reserved revocation capacity in one D1 transaction. Retained
  receipts plus nonterminal routes cannot exceed 4096 per identity or 65536
  globally; existing-record revocation must work at capacity.
  Publisher nonce replay rows plus reserved nonterminal-route revocation slots
  have one atomic global ceiling of 131072. Both authenticated writers reclaim
  at most 32 expired nonces in their transaction; never erase a live 24-hour
  replay row early. Migration 0016 preserves populated overflow and existing
  revocation reservations; ordinary admissions fail closed while it drains.
  Grants are single-use, fifteen seconds, purpose-HMAC tagged in D1, and bound to
  identity, generation, token revision and client nonce. Require blind stateless
  admission-v1 HMAC challenges and fixed 24-bit work before any client room lookup;
  challenge issuance must never query presence/D1/rooms or persist challenge state.
  Admit clients only through the exact versioned v5 room attestation. Redeem
  protected grants in D1 and atomically reserve/claim ticket replay tags before
  socket allocation; retain claims on every later failure. Recheck expiry,
  generation, live control, capacity and grant liveness after awaits. Candidate
  tickets must match their prebound binary-ticket hash. Protected access_init
  confirms the preauthorized grant/nonce; it never redeems an alternate grant.
  Recheck denial after hashing and before candidate dispatch.
  Raw grants may exist only in bounded live attachments and must be scrubbed at
  terminal teardown. The retired invitation challenge/proof frames are rejected.
  Source migrations 0013/0014 preserve populated history; 0015 physically removes
  the obsolete IP-derived pair tables without changing replay or access state. The separately gated
  `deployment/retirement/retire-legacy-profiles.sql` is never auto-discovered or
  applied without the complete proof described alongside it.
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
- Never extract requester or forwarded IP addresses, derive hashes/HMACs from
  them, or store, audit, log, or metric them. Reject retired internal source/pair
  headers without an old-envelope bridge. Anonymous edge counters use fixed
  purpose keys per location, not requester metadata or a fairness identity.
  Historical `SOURCE_TAG_KEY_*` names and key-ring classes serve only random
  grant/ticket replay HMACs and separately domain-separated admission signatures; preserve their exact domain separation and strictly
  more than 24-hour overlapping-key retirement window. Preserve authenticated
  identity budgets. Candidate addresses are transient validated forwarding data,
  never attachment/SQL/log/history state; operator DNS endpoints are signed
  routing metadata. Provider-managed historical IP rules and retention remain
  separately audited operator concerns; source changes cannot prove their removal.
- Declare required secret names in Wrangler configuration, keep their values in
  Cloudflare secrets or ignored local development files, and fail closed when
  key material or a route circuit breaker is invalid.
- Keep production `workers.dev` and preview URLs disabled so zone WAF/custom
  domain policy cannot be bypassed. Use an isolated Worker/Durable Object,
  custom hostname, secrets, D1 database, Analytics Engine dataset, and native
  Rate Limiting namespace IDs for canaries; reused namespace IDs share
  counters across Workers. Admission work is a computational cost gate, not
  anonymous-attacker fairness; bounded native solvers may time out on slower devices.
- Historical provisioning/rotation procedures below preserve immutable incident
  evidence; references to the old production automatic trigger describe that
  historical state and grant no current activation authority.
- GitHub Actions is the sole active PR/source-validation path. Retain Cloudflare
  review inactive: fresh readback includes an encrypted Builds secret and a
  shared wrapper with unreadable policy, so never call it credential-free.
  Both retained Cloudflare triggers require literal `exit 1` build/deploy,
  `SKIP_DEPENDENCY_INSTALL=1`, preserved valid selectors (production main/no
  exclusions; review wildcard/exclude-main), sealed bounded startup environment/
  configuration digests and every Build stopped at each fence, including review.
  Apply only the documented two-field commands PATCH. Builds may still enqueue
  or start and fail immediately; never claim that branch pushes are disabled.
  Branch pause alone cannot fence manual/retried Builds. Retain unknown
  credentials unread and uncalled; this policy authorizes no authentication
  removal, secret copying or new PROD deployment. A rejected partial PATCH is
  no transition proof. Restoring credential-free review needs separate current
  authorization and policy proof. The historical
  `deployment/workers-builds-review.json` design and incident procedures below
  remain evidence, never current credential-boundary or activation proof.
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
  owner-only secret and policy proof to a distinct successor rotation. That
  authority derives the live predecessor wrapper and token from the immutable
  prior rotation terminal, never from the absent original setup wrapper, and
  binds the exact membership-repair authority, journal, result, and snapshot
  manifest before reusing the existing proof-gated rotation state machine. Every
  forward, rollback, blocked, and terminal phase snapshot must select that
  authority-bound predecessor by UUID and underlying token ID; the predecessor
  and replacement may legitimately share the current wrapper name during the
  successor rotation, so names alone never distinguish their generations.
  API Tokens Write is a separate
  owner-bootstrap boundary and must not be inferred from any Workers Builds
  credential. A lost one-time secret from a completed membership repair is
  recoverable only through the distinct #131 program/attempt-bound authority:
  never replay or amend #122, never adopt the bootstrap as the replacement,
  and never retry a durable POST intent. Bind exact complete or post-prefix
  blocked evidence; cleanup is limited to the exact journal-created unwrapped
  token after exhaustive wrapper-unreference proof. A successful recovery must
  feed a new membership-successor coordinate into a wholly fresh wrapper
  rotation namespace.
  It performs only readback and local protected-document materialization, and must never gain implicit
  provider mutation. Provider apply and live-canary execution remain gated by
  separate maintainer authorization; `npm run deploy:review-canary` must fail
  closed until the dedicated account and exact runner are reviewed and provisioned.
- Preserve the curated `request_rejected`, `blacklist_match`, and
  `unexpected_error` diagnostics with their closed, redacted schemas. Do not
  log routine success, expected `404`, rate-limit, or open-circuit traffic; use
  aggregate platform metrics/WAF analytics for traffic measurements.
  Rendezvous control-loss diagnostics must suppress deliberate retirement and
  superseded controls using local/durable state, including after hibernation;
  never infer local intent from a peer's close code or reason. Keep raw error
  values and connection identities out of diagnostics, and preserve teardown
  behavior when logging fails.
- Keep generated Wrangler types and `dist/` untracked. Generate and check each
  configuration's types independently, and keep caller declarations isolated
  from the core `Cloudflare.Env`. Update bindings, runtime types, tests, and all
  three dry-run configurations together.
- Never deploy, run remote D1 migrations, reset ownership, or mutate Cloudflare
  resources merely to validate a change. Those external actions require
  explicit authorization and reviewed environment bindings. The automatic DEV
  entrypoint is authorized only inside its configured GitHub Actions `main`
  workflow; PROD requires the separately approved exact-tag workflow dispatch.
  Local live execution must fail before remote access.
- Commits and pull-request titles use Conventional Commits. Every squash merge
  is released by semantic-release.
- Preserve unrelated work and finish with `git diff --check`.
- Update this `AGENTS.md` in the same change when major rework alters platform
  ownership, bindings, state/migration policy, protocol, or validation.

- Release publication is draft-first: semantic-release selects the version and
  uploads the exact archive/checksum cohort with `draftRelease: true`, then
  `scripts/release/publish-complete-release.cjs` verifies source identity and
  complete uploaded asset digests before publishing. Publication also requires
  the governed immutable-release activation variable; verify the final immutable
  state and locked tag SHA. Manual existing-draft recovery uses repository-authorized
  dispatch and refreshes protected current-main/source-check and active first-attempt
  run authority after downloads, immediately before publication. Failed verification retains
  the draft; never repair it by publishing partial assets or rewriting historical
  releases. Immutable-release policy is managed by the governance repository;
  successful source publication does not authorize production promotion.
