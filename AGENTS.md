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
  Stop before
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
- Production controller account-API GETs share one explicit fetch scheduler
  across resource/native-rate inventories, native control-plane
  reads and caller snapshots, regardless of token. Space actual starts by at
  least 334 ms; retain original request deadlines including queue time, the
  120-second double-snapshot limit and 10-second retirement handoff. A 429 stops
  pending/new governed reads without retries. Never cache a fence or retry a
  mutation. Wrangler and other processes/clients are outside this local budget;
  headroom is not proof of global quota safety. Private reconciliation uses its
  own shared scheduler and retains its existing command timeout.
  Retirement and caller-observation failures expose only branded closed
  phase/category/transport fields alongside the existing reason; observations
  also retain the first failing stage through completion wrappers. Never reflect provider text, error
  getters, private identities, URLs, headers or credentials. A received PATCH
  response is not proof of the final state; consumed intents remain non-replayable.
- The optional private `productionBootstrap` record authorizes only the reviewed
  old-production transition: selected immutable source and exact three-version
  predecessor, core `ACCESS_ROUTE_RATE_LIMITER` native namespace `1008` at 16/60,
  and retirement of the two exact legacy caller signing-secret bindings. Pin the
  observed graph, all ordinary Worker identities/native-rate tuples, and old
  caller key-ID variables; never describe future resources as already existing.
  Only explicit `productionBootstrap.nativeRateAlreadyProvisioned: true` permits
  a newly observed baseline whose core already owns the sole exact `1008` binding
  at 16/60. Each caller must retain the exact legacy secret pair or, only under this opt-in,
  have zero secrets. An empty caller must have no legacy key IDs. A caller
  may have no key-ID bindings only under this opt-in and with every role-specific
  circuit explicitly disabled; otherwise retain the valid distinct key-ID pair.
  The opt-in binds a new policy/plan and actual predecessor approval, never replays
  an old intent or skips new staging, core confirmation, or required pair retirement.
  Before upload prove the entire baseline, disabled core, sole active/latest
  versions for governed Workers and ordinary-Worker native-namespace isolation.
  An unrelated Worker may have a newer undeployed version only when independently
  read active/latest version bindings and settings have identical native-rate
  tuples, with stable deployment and version coordinates across the read.
  The bootstrap policy
  explicitly records this limited census and dispatch namespaces as unassessed;
  never claim account-wide uniqueness or interpret a forbidden read as absence.
  Stage the new disabled core first, then each new disabled stateless caller
  with its exact approved baseline secret inventory. Verify selected code and complete readback
  before a fresh, one-use `secrets-bulk` JSON Merge Patch removes that caller's
  two exact secret names through explicit null values. New v4 requests contain
  only those deletions in `secrets`; reject `version_tags`, every other field,
  accessors and secret substitution. The fixed controller-owned
  `deployment/caller-retirement-provider-qualification.json` must contain a
  reviewed source attestation of the actual isolated bare-operation probe, its clean
  terminal, exact account/contract and evidence/review hashes. Keep qualification
  null until that evidence is independently reviewed; a local hash or boolean is
  not proof. No environment/path override exists. Pair-role planning and live
  preflight stop before artifacts/uploads when unqualified; ordinary and all-empty
  paths need no retirement qualification. Only the bounded regular-file loader
  mints the capability independently required by retirement and transport.
  The document digest changes the approved plan and is bound as
  `providerQualificationDigest` in new v4 intents. V4 binds the full endpoint,
  request/body digests, timestamped predecessor and selected execution identity.
  Keep historical v2/v3 decoding immutable and read-only. An approved empty role instead requires a dedicated
  fresh staged observation, with no PATCH, intent, receipt or uncertain-retirement
  state. Freeze its Wrangler UUID/provenance proof and require the same final
  exact-version activation guard. Evidence counts are per-role: two encrypted
  artifacts for a pair retirement, zero for an empty observation. Never infer an
  empty disposition from a failed PATCH or brand observation failures response-accepted.
  Historical v1 settings intents are read-only evidence, never bulk-delete
  authority. Require the exact annotation object `{ "workers/triggered_by": "secret" }`
  in both settings and version data after the new v4 operation; retain staged
  source tag/message in the authenticated predecessor, never inject them into
  observed post-state. Provider success is not guaranteed. Only service-consistent
  `resources.script.last_deployed_from` Wrangler-to-API provenance may change;
  preserve all other resource metadata exactly.
  Require zero-secret readback before activation. Encrypt mutation intents and
  receipts using standard JWE (RSA-OAEP-256/A256GCM) to the approved owner public
  SPKI key; the private key stays outside Actions. Before dispatch, finalize and
  verify the ciphertext intent in an immutable Actions artifact, with the
  approved effective retention: legacy policies require 90 days; only an explicit
  `recovery.minimumEffectiveRetentionDays: 89` permits a full 89-day minimum,
  while `retentionDays: 90` still requests the public-repository maximum.
  The opt-in changes the policy/plan digest and requires fresh approval. Only ciphertext may leave the runner.
  Require an owner decryption rehearsal and export before expiry. Unknown or
  partial outcomes stop activation without retrying
  deletion. Recover only the new disabled core, never old caller code. There is
  no remote compare-and-swap: preserve the fixed promotion concurrency and fresh
  exclusive-writer/source fences at each intent. Retire this one-use policy to a
  newly observed ordinary inventory and approved plan before later promotions.
- Bootstrap caller retirement uses the reviewed v4 bare two-null secrets PATCH
  and controller-owned v2 qualification. Preserve the exact annotation-loss
  postcondition in both settings/version data, full timestamped before/after
  receipts, encrypted finalization before capability creation, selected identity
  and same-run proof. Cohort acceptance after durable receipt publication takes
  a distinct fresh full provider read, bound to the same live proof, exact own
  state and receipt-bound peers/namespaces before current-cohort comparison.
  Preserve the original snapshot/artifact timestamps and 10-second freshness;
  neither the new read nor its success renews authority or permits a retry.
  Later topology/activation reads require the exact retired
  UUID plus full own snapshot and phase-aware complete peer graph. Never invent
  missing annotations or turn historical v2/v3 evidence into a v4 receipt. Normal
  staging, secret-free observations and final active versions retain annotation
  gates. Qualification of an isolated empty-binding canary does not waive full
  production configuration/control/module preservation or authorize deployment.
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
- GitHub Actions is the only PR/source-validation path.
  Check runs for pull requests targeting any base branch, including dependent
  stacks; push validation remains limited to `main`. Cloudflare Workers Builds
  is retired: do not add Builds triggers, provisioning or Builds-state checks.
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
  is released by semantic-release, except Dependabot auto-merges (below), whose
  changes release with the next merge by a person.
- Dependabot patch and minor updates auto-merge once required CI passes, through
  `.github/workflows/dependabot-auto-merge.yml` and the shared
  atrinik/github-settings policy (owner-approved 2026-10-22). They skip the
  advisory dependency-review read below and merge with `GITHUB_TOKEN`, so the
  push starts no Check, Release or DEV deploy. A DEV deploy already in flight
  for an earlier merge then fails its newest-main fence; after main settles,
  re-run that deploy or let the next merge by a person redeploy.
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

Dependency review is advisory. Before a merge by a person, the implementer reads the
latest current-HEAD job summary even when a PR comment exists, fixes actionable
introduced dependency risk, or records explicit maintainer acceptance of existing
risk. Coverage requires the workflow to exist on the relevant PR/merge revision.
License metadata does not certify compatibility; existing repository license
policies still apply.
