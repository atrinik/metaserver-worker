# Metaserver Worker deployment

This runbook covers the canonical-only three-Worker architecture. The current
source requires coordinated access-token-capable Classic and Game consumers. The removed CGI/public `/v2` API has
no traffic-drain, fallback, redirect, application `410`, or rollback path.

Production state exists. Applied D1 migrations are immutable and new schema
work is append-only. The core owns D1, R2, schedules, Analytics Engine,
`RendezvousRoom`, and `DirectoryBuilder`. The publisher and rendezvous Workers
are stateless public edges with one named Service Binding each.

## DEV delivery and explicit PROD promotion

The current policy and operator checklist are in
[deployment environments](docs/deployment-environments.md). Reviewed `main`
pushes use the `deploy-development.yml` GitHub Actions workflow,
`deployment/workers-builds-development.json` and
`npm run deploy:development` against the existing persistent DEV cohort.
`deployment/workers-builds-production.json` describes explicit GitHub Actions
promotion of an approved immutable tag/SHA. No accepted `main` push, release
event or local invocation authorizes a production write.

Credential-free local inspection:

```sh
npm run deploy:development:validate
npm run deploy:development:dry-run
npm run deploy:production:validate
npm run deploy:production:dry-run
```

Both paths retain exact remote-ledger verification without automatic SQL,
digest-bound no-ops, strict direct 100% deployment, core/publisher/rendezvous
staging with public circuits disabled, publisher/rendezvous/core restoration,
phase readback, private directory reconciliation and bounded public canaries.
PROD replaces exact-current-main workflow authority with the exact promotion attempt,
approved tag/SHA, release provenance, digests and expected predecessor.
Both execution environments also require protected
`ATRINIK_DELIVERY_RESOURCE_POLICY` and
`ATRINIK_DELIVERY_RESOURCE_READ_TOKEN`. The exact all-cohort resource/config
inventory is re-read at each phase and private reconciliation, and its digest
is part of the approved deployable digest. Target callers require an empty
provider secret inventory. Secret-value separation needs provisioning proof;
provider reads cannot reveal values. See the environment checklist for scope.
Never print private configurations, IDs, credentials or raw provider responses.

## Pull request validation

GitHub Actions is the only pull request and source-validation path. Cloudflare
Workers Builds is retired: no Builds trigger deploys, validates or reports a
check for this repository, and no delivery step reads Builds state.

## Current pauses, retries and outages

Use the environment-specific recovery checklist in
[deployment environments](docs/deployment-environments.md#failure-and-recovery).
DEV may retry only the exact current-main workflow after its separately authorized
prerequisite is proven. PROD must use a newly approved attempt; workflow reruns
and silent automatic retries are rejected. A partial phase is evidence to
reconcile, never permission to replay an ambiguous write. Keep core circuits
disabled until the staged cohort, predecessor and schema are coherent. During
provider outages, preserve evidence and continue unrelated repository checks.
Any emergency manual production action needs separate incident authorization.

## Prepare

Use explicit protected targets for every Wrangler command; the checked-in
resource IDs and disabled values are review fixtures, not production inputs:

```sh
readonly ATRINIK_PROD_CORE_CONFIG=/secure/path/atrinik-metaserver.production.jsonc
readonly ATRINIK_PROD_PUBLISHER_CONFIG=/secure/path/atrinik-publisher.production.jsonc
readonly ATRINIK_PROD_RENDEZVOUS_CONFIG=/secure/path/atrinik-rendezvous.production.jsonc
readonly ATRINIK_PROD_CORE_SECRETS=/secure/path/atrinik-core-secrets.json
```

The core secret file must be owner-only, ignored, bounded, and reviewed by
binding name without printing values. It supplies every required encrypted
binding, including the replay/admission pair and cache-purge credential. Public
publisher/rendezvous callers receive no secret file, signing keys or key IDs.
Do not use sequential `secret put` operations or an incomplete file that would
create an unreviewed intermediate version.

1. Work from the exact clean reviewed current-main DEV SHA or, for production,
   the owner-approved immutable release tag/SHA and promotion attempt. Record the commit,
   Wrangler version, account, zone, database, buckets, Durable Object
   namespaces, service names, routes/domains, active version IDs, configuration
   digests, secret names, and enabled edge-rule IDs in an owner-only private
   deployment record. Never record a secret value or actor key.
2. Confirm #36 and the static/cache correction are deployed. Confirm the
   Classic v5.9.0 packaged server and client use only the signed publisher,
   canonical rendezvous, and static directory endpoints.
3. Validate locally:

   ```sh
   npm ci
   npm run check
   git diff --check
   ```

   `npm run check` regenerates and checks all Worker types, runs every
   TypeScript project and test suite, runs administrative tests, performs all
   three Wrangler dry runs, and validates the in-process Service Bindings.
4. Read back the zone's canonical/static WAF, cache, redirect, and transform
   rules. Stop on disabled, mixed, reordered, or unreviewed state. Read back the
   core Worker routes, Custom Domains, preview URL, `workers.dev`, schedules,
   bindings, variables, and secrets. The intended end state is no public core
   route/domain and no default core `fetch` handler.
5. Confirm `meta.atrinik.org` is unattached while Game rollout is disabled.
   Its eventual origin is the static Game R2 bucket, never the core Worker.

## Stage access-token publisher and directory contracts

This source change grants no deployment, migration, activation or alias-cutover
authority. Production state and existing open-server behavior remain unchanged
until an operator authorizes an exact coordinated rollout.

The current migration horizon is `0016_publisher_nonce_capacity.sql`. Apply every
pending migration only inside the separately authorized closed-circuit rollout.
Migration 0013 seeds Classic v3 replay from the maximum old v1/v2 lineage and
Game v2 replay from Game v1, including the nonce union. It preserves historical
policy rows without interpreting them as access-token policy. New directories
start empty, and fresh signed publication is required for new public/private
presence. Migration 0014 holds owner-private routes, receipts, grants and limits.
Migration 0015 removes the retired IP-derived cooldown tables while preserving
replay and access-token state. Migration 0016 installs finite publisher nonce
capacity while preserving populated replay records; authenticated writers use
bounded expiry cleanup before admitting new replay state.
The optional retirement SQL under [deployment/retirement](deployment/retirement/README.md)
is excluded from automatic migrations and has separate proof and approval gates.

Use staged aliases until the new consumers and complete artifact cohorts have
been accepted:

| Configuration | New profile output |
| --- | --- |
| Classic `v4-production` or `v5-production` | `classic-v3` under `canary-v6/` |
| Classic `v6-production` | `classic-v3` root aliases |
| Game `v1-production` | `game-v2` under `canary-v2/` |
| Game `v2-production` | `game-v2` root aliases |

The historical mode names are staging selectors only. This runtime has no
Classic v1/v2 publisher or Game v1 publisher fallback and does not rebuild old
directory formats. Retired immutable definitions and migration files remain
historical evidence. Old R2 aliases require their own explicit, proven retirement;
changing a mode is not evidence that cached historical objects have disappeared.

After separately authorized isolated provisioning, the credential-free static
canary accepts only the new profile/schema pairs and their matching alias prefix:

```sh
python3 scripts/static_origin_canary.py \
  --profile classic-v3 \
  --base-url https://classic-v6-directory-canary.example.org \
  --alias-prefix canary-v6 --json
python3 scripts/static_origin_canary.py \
  --profile game-v2 \
  --base-url https://game-v2-directory-canary.example.org \
  --alias-prefix canary-v2 --json
```

The environment delivery contract derives each canary prefix from the exact core
configuration; the same checked configuration drives builder and purge targets.
Edge policy admits only root aliases on the public directory hostnames, so
delivery runs a public static canary only for a profile published at the root.
A profile still staged under `canary-v6/` or `canary-v2/` is verified by the
private reconciliation proof's complete alias integrity check instead; its
isolated-hostname canary above remains a separate, explicitly authorized step.
Migration 0013 leaves `classic-v3` and `game-v2` publication checkpoints at
generation zero with no new aliases. The explicit pre-canary reconciliation
stage builds valid empty cohorts even before the first cron or signed publication;
it also verifies or refreshes the cohort for later deliveries. The private
interface is declared in `deployment/directory-reconciliation-interface.json`.
The controller requires its exact supported regular blob in the selected Git
commit before provider access and binds its digest into the deployable plan.
Compatible older tags may lag main; pre-interface fetch-only tags are rejected
before upload, with no transport fallback. The private
entrypoint exposes the zero-argument `reconcile()` Service Binding RPC, which
constructs an empty `POST` inside the Worker. Its fetch handler accepts only that
empty `POST` to
`https://internal.atrinik.invalid/v1/directory-reconciliation`, selects only the
two fixed profiles, and verifies checkpoints and complete alias integrity before
returning the redacted `directory-reconciliation-v1` receipt. Extra RPC arguments
are rejected before state access. Node's native Request and the proxy's injected
HTTP headers never cross the handler's strict envelope boundary. It has no public
route, request-selected profile, resource key, generation or origin. The
receipt binds completion time and actual cutover modes/origins; the parent
binds the account, source, active topology and sole Actions writer around the
stage. A receipt is not independent permission to invoke live maintenance.
Timeout or cleanup failure stops acceptance; aborting the proxy is not a
rollback of aliases already reconciled by the core, and provider work already
accepted may finish independently. The builder's durable publication journal
and later exact readback remain authoritative.
Cloudflare documents the supported [remote Service Binding pattern](https://developers.cloudflare.com/workers/local-development/#remote-bindings)
and [Wrangler proxy API](https://developers.cloudflare.com/workers/wrangler/api/).
This source change exercises only isolated fixtures; no live proxy, migration,
Worker deployment or alias publication is authorized by its tests.
Canaries verify canonical JSON/XML/HTML, `accessRequired` policy, fresh coherent
cohorts, native validators, public/private separation and bounded rejection paths.
Current publisher canaries use the protocol-owned Classic v3 signature envelope.
They cannot authorize deployment or cutover merely by passing.

The updated public callers have no signing-key secret or key-ID bindings.
Existing deployed caller secrets are not deleted by this source change, and
preflight rejects any retained signing bindings before a production rollout.
Removing those remote secrets requires separate operator authorization and
fresh readback; local validation cannot remove or waive them.

`ACCESS_ROUTE_RATE_LIMITER` is core-only, namespace `1008`, 16 requests/minute.
The isolated review cohort uses `2008` with the same ceiling and counts it in its
six-namespace cap; namespaces or counters are never reused across environments.
Provider-first deployment, disabled-circuit staging, pinned source and migration
prefix proof, current-main fencing, canary acceptance and explicit operator
cutover remain mandatory. Keep full state/configuration/identity backups and
prove native consumers before making protected/private access available.

## Drain the replay namespace

The runtime-retirement bridge changes rendezvous replay-tag namespace from the
removed core hostname setting to `RENDEZVOUS_HOSTNAME`. A namespace change must
not make an old ticket reusable.

1. Set `RENDEZVOUS_ENABLED=disabled` on both the rendezvous edge and core,
   deploy/read back the exact values, and verify canonical attempts fail closed
   before Durable Object admission.
2. Record the last time any old-namespace writer could admit a ticket. Keep
   rendezvous disabled for strictly more than the complete 24-hour replay-row
   lifetime after every old version has stopped. Include deployment propagation
   time; elapsed time before the final old writer stops does not count.
3. During the drain, verify aggregate room admissions remain zero and no old
   deployment becomes active. Do not delete replay state, rotate to disjoint
   HMAC keys, or shorten the wait.

## Deploy provider first

The core contains Durable Object `exports`, so its lifecycle reconciliation is
deploy-only. Do not use `wrangler versions upload` or `versions deploy` for the
core.

1. Upload, but do not activate, exact versions for
   `atrinik-metaserver-publisher` and `atrinik-metaserver-rendezvous` from the
   reviewed protected configs. Supply the complete edge secret file atomically,
   record the returned version IDs, and read back source/message/config/Service
   Binding authority before continuing:

   ```sh
   npx wrangler versions upload --strict \
     --config "$ATRINIK_PROD_PUBLISHER_CONFIG" \
     --tag runtime-retirement-bridge \
     --message "stage canonical-only publisher caller"
   npx wrangler versions upload --strict \
     --config "$ATRINIK_PROD_RENDEZVOUS_CONFIG" \
     --tag runtime-retirement-bridge \
     --message "stage canonical-only rendezvous caller"
   ```
2. Apply only reviewed pending D1 migrations. This bridge normally has none;
   stop if the remote migration list differs from the plan.
3. Directly deploy the state-owning core at 100%:

   ```sh
   npx wrangler deploy --strict \
     --config "$ATRINIK_PROD_CORE_CONFIG" \
     --secrets-file "$ATRINIK_PROD_CORE_SECRETS" \
     --tag runtime-retirement-bridge \
     --message "deploy canonical-only state provider"
   ```

   Record the exact no-change Durable Object exports reconciliation, active
   version, bindings, variables, schedules, and domainless state. The new core
   accepts and scrubs the old caller's exact source-alias envelope but does not
   use or persist it. It also accepts the new subset that omits those aliases.
4. Activate the exact already-validated publisher version ID, then the exact
   rendezvous version ID, each at 100% with `wrangler versions deploy` and its
   matching protected config. The new rendezvous caller omits the retired
   source aliases. Do not upload a replacement during this step. Re-read all
   three active versions and service linkage after each activation.
5. Keep rendezvous disabled until the entire provider/caller cohort is exact.
   A partial or drifted cohort is a fix-forward stop condition.

## Retire Cloudflare compatibility state

After the canonical-only core is active:

1. Preserve private before-state for the old `meta.atrinik.org` dynamic WAF
   allowlist and rate rule, then remove only those exact named rules. Preserve
   all canonical/static rule ordering and the HTTPS-only work from #37.
2. Remove retired core variables and native rate bindings from active settings,
   then read back the exact canonical configuration. The core retains only the
   publisher-identity and authenticated rendezvous-server native bindings.
3. Prove the core has no route, Custom Domain, preview URL, or `workers.dev`
   hostname. It remains reachable only through named Service Bindings and
   scheduled triggers.
4. Keep explicit retired-target negative probes in the canonical/static edge
   rules. Bound the probes, bracket Worker Metrics and primary D1 counts, and
   require zero Worker/D1 work. A Worker-generated retirement response fails
   this gate.

## Apply the forward-only storage migration

Apply `0009_remove_legacy_storage.sql` only after the retired-path audit is
accepted and before rendezvous or publishing is re-enabled:

1. Capture a private D1 Time Travel bookmark and exact pre-migration row counts
   only. Do not export row values. Confirm the core, publisher, and rendezvous
   circuits are disabled, schedules are suspended, and the active v2 bridge
   cohort and production database ID match the reviewed release evidence.
2. Count exact 64-lowercase-hex deny rows separately from every noncanonical
   legacy pattern. Require the noncanonical count to be zero. Before deleting a
   noncanonical row, bind its digest to a protected reviewed disposition that
   either explicitly retires it or maps it to exact enabled Cloudflare WAF rule
   IDs, actions, expressions, and order. Read those WAF rules back immediately
   before and after migration. Retain only counts, digests, rule identifiers,
   and expression digests—never the raw legacy pattern. Migration `0009`
   independently aborts before schema mutation if any such row remains.
3. Run the migration once through Wrangler's ordered D1 migration command. It
   removes compatibility-owned presence and entries, advances only affected
   visible revisions, and coalesces the corresponding outbox work before
   rebuilding the canonical tables.
4. Read back the applied-migration ledger, `PRAGMA foreign_key_check`, exact
   canonical table/trigger/index inventory, and aggregate pre/post row counts.
   Require the retired tables to be absent and the canonical replay, nonce,
   presence, directory, revision, outbox, and artifact-coordination counts to
   match the reviewed migration proof.
5. Deploy the schema-clean core provider first and then activate the exact
   prevalidated publisher and rendezvous callers. After each activation,
   require exact versions, bindings, secrets-by-name, routes, schedules, and
   circuit settings. A post-migration rollback is a disabled-circuit forward
   fix; never redeploy a schema-incompatible pre-migration Worker.
6. Re-enable scheduled cleanup/reconciliation, then canonical publishing and
   rendezvous in reviewed order. Run fresh Classic and Game signed publication,
   replay rejection, static generation/expiry, and rendezvous canaries. Purge
   only aliases whose reconciled revision changed.

Retain only the migration time, Time Travel bookmark metadata, schema/ledger
digests, aggregate row counts, and canary outcomes in protected evidence. The
bookmark does not authorize restoring retired APIs or active legacy state.

## Canary and enable

1. Re-read the exact active core/publisher/rendezvous versions and configs
   immediately before and after the cohort.
2. Run one signed Classic publish, accepted heartbeat, exact replay rejection,
   visible directory-generation update and on-demand cache invalidation.
3. Enable rendezvous on the core and edge only after the replay drain and exact
   cohort readback. Run server-control authentication, token rotation, a
   retained-v1 open/password-protected joins and v2 open/access-code-protected
   joins. Verify normal
   `normal -> firing -> normal` operational alert behavior only through its
   separately reviewed observability procedure.
4. Probe every retired target on `meta`, Classic static, publisher, and
   rendezvous authorities. Require edge denial, no redirect, no token/body
   compatibility response, and zero Worker/D1 delta.
5. With explicit canary-domain authorization, validate both static profiles and
   the complete ingress envelope without credentials:

   ```sh
   python3 scripts/static_origin_canary.py \
     --profile classic-v3 \
     --base-url https://classic-directory-canary.example.org \
     --json
   python3 scripts/static_origin_canary.py \
     --profile game-v2 \
     --base-url https://game-directory-canary.example.org \
     --json
   python3 scripts/edge_ingress_canary.py \
     --static-host classic-directory-canary.example.org \
     --publisher-host publish-canary.example.org \
     --rendezvous-host rendezvous-canary.example.org \
     --hsts-max-age 300 \
     --core-base-url https://atrinik-metaserver.ACCOUNT.workers.dev/ \
     --publisher-base-url https://atrinik-metaserver-publisher.ACCOUNT.workers.dev/ \
     --publisher-version-url https://VERSION-atrinik-metaserver-publisher.ACCOUNT.workers.dev/ \
     --rendezvous-base-url https://atrinik-metaserver-rendezvous.ACCOUNT.workers.dev/ \
     --rendezvous-version-url https://VERSION-atrinik-metaserver-rendezvous.ACCOUNT.workers.dev/ \
     --json
   python3 scripts/edge_ingress_canary.py \
     --static-host game-directory-canary.example.org \
     --publisher-host publish-canary.example.org \
     --rendezvous-host rendezvous-canary.example.org \
     --hsts-max-age 300 \
     --core-base-url https://atrinik-metaserver.ACCOUNT.workers.dev/ \
     --publisher-base-url https://atrinik-metaserver-publisher.ACCOUNT.workers.dev/ \
     --publisher-version-url https://VERSION-atrinik-metaserver-publisher.ACCOUNT.workers.dev/ \
     --rendezvous-base-url https://atrinik-metaserver-rendezvous.ACCOUNT.workers.dev/ \
     --rendezvous-version-url https://VERSION-atrinik-metaserver-rendezvous.ACCOUNT.workers.dev/ \
     --json
   ```

   Substitute only the reviewed canary authorities and account-derived
   alternate URLs. The core does not generate its version-preview URL because
   it contains Durable Object exports; retain that metadata-proven absence while
   proving its base alternate URL unavailable. These verifiers accept no
   Cloudflare token and have no mutation path. They require the complete static
   model, exact security/cache/CORS headers, an opaque quoted strong `ETag` of 3
   through 128 bytes, bounded adjacent-generation convergence, plaintext
   same-path `308`, exact WAF denial for negative dynamic targets, and no
   alternate Worker URL. The static verifier uses one convergence window for
   the full GET/HEAD/conditional proof and resnapshots the complete three-file
   cohort only after a same-path response fully proves a strictly newer valid
   publication. Persistent mismatches, validator reuse, generation regression,
   and same-generation body changes remain blockers. Correlate the fixed block
   cohort with WAF Security
   Events and require zero increase in dynamic Worker or D1 reads. Do not enable
   a production hostname in this step.
6. Warm all three `index.*` aliases to an exact old generation, publish a
   visible change, and require the purge API's accepted envelope followed by a
   non-HIT response carrying the new generation. A HIT of the warmed generation
   after API acceptance is a deployment blocker. Also prove an interrupted
   alias write repairs monotonically before accepting the cache result.
7. Retain only protected, bounded evidence: active version/config digests,
   rule IDs/expressions, aggregate metric deltas, generations, statuses, and
   checksums. Never retain tokens, signatures, tickets, candidates, raw source
   values, actor tags, or request bodies.

## Rotate source-tag keys

Key rotation is core-only. `atrinik-metaserver` owns the reviewed replay and
admission signing pair. `atrinik-metaserver-publisher` and
`atrinik-metaserver-rendezvous` receive no signing secrets or key IDs. Deploy
`A/Z`, then `B/A`; keep shared `A` for strictly more than the full 24-hour replay
lifetime after every `A/Z` writer has stopped. Update core encrypted secrets and
public key IDs together in one reviewed version. Admission challenges also verify
current/previous keys in a separate purpose domain. Disjoint pairs fail closed.

Removing old caller bindings requires reviewed deployment configuration and
provider readback proving their absence; editing source does not delete deployed
secret values or prove their historical erasure.

## Observability

Keep curated logs enabled/persisted with invocation logs disabled; traces,
Logpush, Tail consumers, streaming-tail consumers, and OTLP destinations remain
disabled unless separately reviewed. Use aggregate Worker, D1, Durable Object,
Analytics Engine, WAF, and cache signals. Application diagnostics are closed,
bounded, and redacted; they are not traffic accounting.

## Administrative SQL

Generate canonical identity reset or server-ID denial SQL with
`scripts/admin_sql.py`, review it, and apply it only with explicit authorization.
The identity-scoped commands are `reset-identity`, `deny-add`, and
`deny-remove`; each accepts one exact 64-lowercase-hex server identity
(uppercase operator input is normalized before SQL is emitted). The separate
`retire-classic-v1` command accepts only the fixed human-gate confirmation in
the staged rollout above and has no inverse. Wildcards, addresses, and CIDRs
are rejected.
Identity reset requires publisher exclusion and a rendezvous room drain. It
atomically removes presence, public entries, replay state, grants and receipts,
and revokes active or reserved access routes. Existing route tombstones and
request budgets remain to prevent reuse after republishing. Each affected public
profile receives a directory invalidation; private-only state does not. Use the
complete generated file with the pinned Wrangler D1 execute workflow: Wrangler
strips the single `BEGIN TRANSACTION`/`COMMIT` wrapper and submits the statements
as one D1 transaction. Do not submit individual statements or an explicit
`BEGIN IMMEDIATE` through the D1 binding.
Do not use administrative SQL to restore retired routes or address-derived
tracking. Migration `0015_remove_ip_derived_pair_tracking.sql` drops the retired
source/server-pair tables and their indexes while preserving publisher identity,
private access routing, grant replay state, and identity-scoped request budgets.

## Roll back

Rollback cannot cross the lifecycle change. Never deploy v1.9.0 or any release
that exposes or writes retired state. Before #39, rollback may use only this
runtime-retirement bridge (canonical routes absent, signed publications only,
old caller envelope accepted and scrubbed). Keep rendezvous disabled during a
rollback cohort change and repeat the full replay drain if namespace continuity
cannot be proven. After #39, storage rollback is forward-only through a new
reviewed migration and compatible code; never edit or reverse an applied
migration.

If canonical availability degrades, disable the affected canonical circuit,
retain the exact journal/evidence, and fix forward. Do not reattach the core,
restore the retired WAF allowlist, or expose a compatibility response.

## Mandatory rendezvous admission-v1 boundary

The v5 Worker-to-room envelope and v4 live attachment format reject older
versions; there is no v4-envelope compatibility bridge. Keep the existing
replay ledger and HMAC namespace intact. Drain old live sessions, deploy the
core before callers, and reconnect authenticated server controls. Their public
handshake and signaling frames are unchanged. Coordinate mandatory admission-v1
Classic clients and the exact challenge POST in the reviewed raw-target gate;
old clients receive 428 and new clients fail closed against providers without
the challenge route. Do not solve deployment skew by reducing difficulty or
restoring post-upgrade grant authentication.

Before activation, validate stateless challenge issuance, missing/invalid proof
zero-room dispatch, grant rejection before allocation, replay after room
reconstruction/key rotation, and proof/grant expiry during asynchronous admission.
Record representative native solver cost and bounded timeout behavior. The
fixed 24-bit cost does not reserve capacity or guarantee anonymous fairness.
Challenge requests share the existing client ingress ceiling and count separately
from upgrades. Existing credential-free deployment canaries use server-role
requests and remain unchanged; a successful canary does not prove client work
admission or gameplay. These requirements grant no deployment authority.
