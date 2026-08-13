# Metaserver Worker deployment

This runbook deploys the canonical-only three-Worker architecture. Classic
v5.9.0 is the minimum supported consumer. The removed CGI/public `/v2` API has
no traffic-drain, fallback, redirect, application `410`, or rollback path.

Production state exists. Applied D1 migrations are immutable and new schema
work is append-only. The core owns D1, R2, schedules, Analytics Engine,
`RendezvousRoom`, and `DirectoryBuilder`. The publisher and rendezvous Workers
are stateless public edges with one named Service Binding each.

## Prepare

1. Work from an exact reviewed release commit with a clean tree. Record the
   commit, Wrangler version, account, zone, database, buckets, Durable Object
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

1. Stage and validate `atrinik-metaserver-publisher` and
   `atrinik-metaserver-rendezvous` plus their exact Service Binding/config
   readbacks without activating the new rendezvous caller.
2. Apply only reviewed pending D1 migrations. This bridge normally has none;
   stop if the remote migration list differs from the plan.
3. Directly deploy the state-owning core at 100%:

   ```sh
   npx wrangler deploy --strict -c wrangler.jsonc
   ```

   Record the exact no-change Durable Object exports reconciliation, active
   version, bindings, variables, schedules, and domainless state. The new core
   accepts and scrubs the old caller's exact source-alias envelope but does not
   use or persist it. It also accepts the new subset that omits those aliases.
4. Activate the already-validated publisher caller, then the rendezvous caller,
   at 100%. The new rendezvous caller omits the retired source aliases. Re-read
   all three active versions and service linkage after each activation.
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

## Canary and enable

1. Re-read the exact active core/publisher/rendezvous versions and configs
   immediately before and after the cohort.
2. Run one signed Classic publish, accepted heartbeat, exact replay rejection,
   visible directory-generation update and on-demand cache invalidation.
3. Enable rendezvous on the core and edge only after the replay drain and exact
   cohort readback. Run server-control authentication, token rotation, a
   passwordless friend join, and a protected invite join. Verify normal
   `normal -> firing -> normal` operational alert behavior only through its
   separately reviewed observability procedure.
4. Probe every retired target on `meta`, Classic static, publisher, and
   rendezvous authorities. Require edge denial, no redirect, no token/body
   compatibility response, and zero Worker/D1 delta.
5. With explicit canary-domain authorization, validate both static profiles and
   the complete ingress envelope without credentials:

   ```sh
   python3 scripts/static_origin_canary.py \
     --profile classic-v1 \
     --base-url https://classic-directory-canary.example.org \
     --json
   python3 scripts/static_origin_canary.py \
     --profile game-v1 \
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
   alternate Worker URL. Correlate the fixed block cohort with WAF Security
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

`atrinik-metaserver`, `atrinik-metaserver-publisher`, and
`atrinik-metaserver-rendezvous` use the same reviewed overlapping pair but derive in their
own canonical authority namespaces. Deploy `A/Z`, then `B/A`; keep shared `A`
for strictly more than the full 24-hour replay lifetime after every `A/Z`
writer has stopped. Update encrypted secrets and public key IDs provider first,
then both callers. There is no cross-Worker atomic deploy, so every intermediate
cohort must retain one exact overlap key. Disjoint pairs fail closed.

## Observability

Keep curated logs enabled/persisted with invocation logs disabled; traces,
Logpush, Tail consumers, streaming-tail consumers, and OTLP destinations remain
disabled unless separately reviewed. Use aggregate Worker, D1, Durable Object,
Analytics Engine, WAF, and cache signals. Application diagnostics are closed,
bounded, and redacted; they are not traffic accounting.

## Administrative SQL

Generate ownership reset or server-ID blacklist SQL with
`scripts/admin_sql.py`, review it, and apply it only with explicit authorization.
Do not use administrative SQL to restore retired routes or clear ordinary
rendezvous cooldowns. Physical removal of inert tables/columns belongs to #39
after this bridge is deployed and observed.

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
