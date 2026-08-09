# Metaserver Worker deployment

Deployment changes public discovery and authentication state. These steps are
an operator runbook, not authorization for an automated tool to deploy.

Run every production Wrangler command from one dedicated shell with the same
explicit, second-operator-reviewed target. Replace the example config path and
profile before continuing. The configuration may be ignored or managed outside
the repository, but all paths inside it must resolve to this reviewed checkout:

```sh
readonly ATRINIK_PROD_CONFIG=/secure/path/atrinik-metaserver.production.jsonc
readonly ATRINIK_PROD_WORKER=atrinik-metaserver
readonly ATRINIK_CF_PROFILE=atrinik-production
readonly ATRINIK_SOURCE_TAG_SECRETS=/secure/path/source-tags-initial.env

npx wrangler auth activate "$ATRINIK_CF_PROFILE" .
npx wrangler whoami --json
```

`wrangler whoami` does not accept `--profile` in the pinned CLI. Activating the
reviewed profile for this exact checkout makes the unprofiled identity check
use it; compare the returned account with the release target before continuing.
Run `npx wrangler auth deactivate .` when the dedicated deployment session is
finished. The mutation is a local Wrangler authentication binding only; it is
not a Cloudflare deployment.

## Prepare

1. Confirm the target Cloudflare account, zone, Worker name, D1 database, and
   custom domain with a second operator.
2. Back up the target D1 database and record a recovery bookmark.
3. Replace the placeholder D1 ID through deployment-specific configuration;
   do not commit production identifiers or credentials.
4. Confirm migration `0001_initial.sql` is already recorded for the production
   database. Never reapply or edit it. Review every later ordered migration
   against a populated copy of that exact schema.
5. Generate independent 32-byte base64url values for
   `SOURCE_TAG_KEY_CURRENT` and `SOURCE_TAG_KEY_PREVIOUS`. Put both values in one
   protected, ignored JSON or `.env` file outside the checkout for the atomic
   version upload described below. Confirm their non-secret IDs match the
   corresponding Wrangler variables. Every canary/environment gets independent
   keys and a distinct configured hostname namespace. Do not use sequential
   `wrangler secret put` commands, and do not put values in Wrangler variables,
   shell history, logs, or this repository. Confirm the planned current/previous
   pair shares one identical key with the preceding deployed pair and that this
   overlap remains active for strictly more than 24 hours after the last writer
   using the preceding pair stops; the per-room replay ledger depends on that
   overlap.
6. Run `npm ci` and `npm run check` from this directory.
7. Run the following dry run and review its output for unexpected bindings,
   routes, compatibility changes, or secrets:

   ```sh
   npx wrangler deploy --dry-run --outdir dist \
     --config "$ATRINIK_PROD_CONFIG" \
     --name "$ATRINIK_PROD_WORKER" \
     --profile "$ATRINIK_CF_PROFILE"
   ```

   Preserve the resolved binding summary in the reviewed release record. In
   particular, record that production `RENDEZVOUS_METRICS` resolves to
   `atrinik_metaserver_rendezvous` and `DIRECTORY_METRICS` resolves to
   `atrinik_metaserver_directory`; these are the comparison baselines for the
   canary dry run below.

8. Confirm the production artifact has `workers_dev: false` and
   `preview_urls: false`. Review and stage
   [docs/edge-policy.md](docs/edge-policy.md); no production custom domain may
   be attached before its raw-target gate and rate-policy decision pass review.
9. Confirm the artifact has the `RENDEZVOUS_METRICS` and `DIRECTORY_METRICS`
   Analytics Engine bindings targeting only their reviewed datasets, the
   SQLite `RENDEZVOUS` and `DIRECTORY_BUILDER` Durable Object bindings, and the
   three isolated R2 bucket bindings. Confirm all three rendezvous policy
   variables. The
   production values are
   `RENDEZVOUS_CLIENT_ROLLING_LIMIT=50`,
   `RENDEZVOUS_ACTIVE_CLIENT_LIMIT=16`, and
   `RENDEZVOUS_CLIENT_SESSION_SECONDS=15`. A canary or incident version may
   lower any of them to a positive integer, but configuration cannot raise a
   reviewed maximum. Missing or malformed values fail in the Worker before
   source tags, counters, D1, server lookup, or Durable Object work; the room
   independently validates them again as the final authority.
10. Confirm `no_web_socket_compression` remains in the compatibility flags.
    Rendezvous carries at most 512-byte signaling frames for at most 15 seconds;
    compression negotiation and per-message CPU/state are unnecessary for that
    deliberately tiny, attacker-controlled workload.

Migration `0002_request_control.sql` is additive. It adds dual-tagged
transitional OTP state and exact request budgets without changing existing
ownership or listing rows. Apply it before deploying code that writes
`source_tag`, `source_tag_previous`, or `request_budgets`. An older Worker can
continue issuing raw-source OTP rows
against the additive schema, but it cannot consume a new tagged OTP. Pause
updates during the Worker switch and prefer a forward fix over a mixed-version
rollback.

Migration `0003_rendezvous_generation.sql` is also additive. It gives every
existing owner and listing row the same inert all-zero, non-secret generation
and constrains later values to 64 lowercase hexadecimal characters. Apply it
before deploying code that selects or writes `rendezvous_generation`. The new
Worker replaces both sentinels on the next accepted publish. The per-server
Durable Object serializes the complete update, invalidates the old control,
then writes the owner guard, listing, bearer-token hash, and generation in one
D1 batch. A stale concurrent update fails its generation precondition instead
of overwriting the winner. An older Worker can read the expanded tables but
would rotate a token without rotating either generation, so pause updates for
the migration and deploy this Worker contract at 100%; do not operate mixed
writers or roll back to the older publisher while updates are enabled.

Migration `0004_signed_publisher.sql` must be applied before enabling
`PUBLISH_ENABLED`. It adds the owner authentication discriminator, visible
directory fingerprint, unsigned-64 sequence/nonce replay ledger, and
profile-separated directory revision outbox. Apply the migration with
publishing paused, deploy with the canonical publisher disabled (the checked-in
configuration deliberately ships `PUBLISH_ENABLED=disabled`), verify the
new constraints and initial revision rows, then enable the classic publisher
only after the canonical route is attached to
`publish.meta.atrinik.org`. Keep compatibility updates available for the
rollback window, but never run an older Worker after an owner has upgraded to
certificate authentication: compatibility authentication intentionally fails
closed for that identity. Do not enable the reserved Game Protocol 1
publisher until its producer implements the same frozen contract.

Migration `0005_directory_state.sql` is the profile-aware directory-state
cutover. It creates minimal presence and public-only directory tables, imports
up to 512 classic presence credentials but only public directory rows, advances
the classic revision/outbox once for a non-empty public import, clears
historical raw owner/listing address columns, and deletes private legacy
listing rows. First deploy the prior release at 100% with both
`COMPAT_UPDATE_ENABLED=disabled` and `PUBLISH_ENABLED=disabled`, verify
accepted update traffic has
drained, and then verify the total legacy presence count does not exceed 512.
The retry-safe migration preflight fails before canonical schema/data changes
when this ceiling is exceeded or a legacy row is malformed/orphaned. Repair
only the exact reviewed legacy identity or metadata before retrying. Record only
aggregate public/private/import counts; do not select or export raw addresses.
Apply the migration, deploy the reviewed Worker
at 100% with both publication circuits still disabled, then verify canonical
presence matches the preflight set, public identities match its public subset,
and all imported `hostname`/`port` pairs are NULL. Re-enable only after the new
Worker reads and writes `server_presence`/`directory_entries`, the legacy
rollback shadow is confirmed addressless, and the addressless rendezvous
canaries below pass. A rollback to an older Worker must keep both publication
circuits disabled; an older Worker cannot write the canonical tables and must
never receive mixed update traffic.

Migration `0006_directory_artifacts.sql` adds the two profile publication
checkpoints, bounded commit markers, and the outbox coalescing trigger. Apply it
before deploying `DirectoryBuilder`. The migration preserves directory
revisions and retains only the greatest pre-existing outbox revision per
profile because the authoritative model is current-state, not an historical
event stream. Confirm both checkpoints begin at unpublished generation zero,
both outboxes contain at most one row, and no public artifact or metadata
contains the private D1 revision.

Before the first builder deployment, provision three environment-isolated R2
buckets: one private immutable-generation bucket and one public alias-only
bucket for each profile. Keep `r2.dev` disabled. Do not attach either custom
domain yet. Provision the `atrinik_metaserver_directory` Analytics Engine
dataset and a new SQLite `DirectoryBuilder` namespace; canary and production
must not share any of these resources. The checked-in names are illustrative,
not authorization to create or reuse live resources.

Configure one defense-in-depth lifecycle rule on the private generation bucket
for the exact `v1/` prefix with a 30-day object age. The application normally
retains the latest eight D1-acknowledged four-object cohorts and uses a durable
paginated sweep to delete at most 64 unacknowledged, older, or partial objects
per reconciliation; the longer lifecycle limit bounds storage after a
prolonged application outage without serving historical data.
No lifecycle rule may target either public alias bucket. Record and verify the
bucket, prefix, and 30-day value through the R2 lifecycle API before rollout.
Alert when a profile outbox remains non-empty for more than ten
minutes, a checkpoint approaches expiry without a later generation, aliases
diverge, or retention cleanup stops converging.

Static aliases use absolute expiry rather than a relative `max-age`, preventing
a late cache fill from remaining fresh after the timestamp embedded in its
body. R2 overwrite does not itself purge custom-domain cache entries, and
direct R2 cannot supply the application-selected SHA ETag, generated-time
`Last-Modified`, CSP, nosniff, or root redirect contract. Therefore this
foundation deployment MUST remain domainless. The service-split canary must
resolve the exact header/validator contract and the public-to-private/endpoint
removal cache bound before either static hostname is attached. A rollback may
rerender the current authoritative model with a reviewed renderer; it must not
blindly restore an older generation that could re-expose removed data.

The edge path allowlist must deny the builder's `/manifest.json` coordination
alias. R2 also has no multi-object transaction: fixed aliases are replaced
sequentially, so readers can observe mixed generations until the cohort
converges even though D1 never acknowledges it early. Do not attach a hostname
until the canary proves an accepted resolution of the Game Protocol 1
atomic-alias requirement (or a reviewed protocol amendment); final cohort
readback is recovery evidence, not public-read atomicity.

## Canary

1. Create an isolated three-Worker canary cohort: a core/state provider plus
   publisher and rendezvous ingress Workers. The two ingress `COORDINATOR`
   bindings must target the exact canary core service and matching named
   entrypoints; a copied production target is a stop condition. Create a
   dedicated publisher hostname and rendezvous hostname, and set
   `PUBLISH_HOSTNAME` / `RENDEZVOUS_HOSTNAME` to those exact values in both the
   matching ingress config and the canary core config. The canary values must
   differ from production and from each other; they are also the source-tag
   namespace and signed authority, so an edge/core mismatch fails closed.
   Create a
   separate canary D1 database and apply all ordered migrations to it.
   Provision separate Analytics Engine datasets named
   `atrinik_metaserver_rendezvous_canary` and
   `atrinik_metaserver_directory_canary`. The code-facing bindings remain
   `RENDEZVOUS_METRICS` and `DIRECTORY_METRICS`, but neither canary resource may
   target its production dataset. Give every one of the
   ten native Rate Limiting bindings across the cohort (seven core, one
   publisher, and two rendezvous) a canary-only `namespace_id` that is
   distinct from every production ID and from the other canary IDs. Cloudflare
   deliberately shares counters between Workers that reuse a namespace ID, so
   copied IDs would couple canary traffic to production. The separate canary
   core Worker must also own its declarative `RendezvousRoom` and
   `DirectoryBuilder` namespaces; neither ingress Worker may have a state
   binding. Do not bind any of the three Workers to a production service,
   script/class namespace, limiter, dataset, database, or bucket. Provision
   three empty canary-only R2 buckets and keep their public development URLs
   disabled.
2. Before any canary deployment, run local-only dry runs with the three exact
   canary targets and configurations:

   ```sh
   readonly ATRINIK_CANARY_CORE_CONFIG=/secure/path/atrinik-metaserver.canary.jsonc
   readonly ATRINIK_CANARY_PUBLISHER_CONFIG=/secure/path/atrinik-publisher.canary.jsonc
   readonly ATRINIK_CANARY_RENDEZVOUS_CONFIG=/secure/path/atrinik-rendezvous.canary.jsonc
   readonly ATRINIK_CANARY_CF_PROFILE=atrinik-canary
   readonly ATRINIK_CANARY_DRY_RUN_ROOT="$(mktemp -d)"

   npx wrangler deploy --dry-run --outdir "$ATRINIK_CANARY_DRY_RUN_ROOT/core" \
     --config "$ATRINIK_CANARY_CORE_CONFIG" \
     --name atrinik-metaserver-canary \
     --profile "$ATRINIK_CANARY_CF_PROFILE"
   npx wrangler deploy --dry-run --outdir "$ATRINIK_CANARY_DRY_RUN_ROOT/publisher" \
     --config "$ATRINIK_CANARY_PUBLISHER_CONFIG" \
     --name atrinik-metaserver-publisher-canary \
     --profile "$ATRINIK_CANARY_CF_PROFILE"
   npx wrangler deploy --dry-run --outdir "$ATRINIK_CANARY_DRY_RUN_ROOT/rendezvous" \
     --config "$ATRINIK_CANARY_RENDEZVOUS_CONFIG" \
     --name atrinik-metaserver-rendezvous-canary \
     --profile "$ATRINIK_CANARY_CF_PROFILE"
   ```

   Compare all resolved binding summaries with the production dry runs recorded
   in Prepare step 7. The core must show the canary Worker name, canary-owned
   `RendezvousRoom`, canary D1 database, all seven core Rate Limiting bindings, and
   `RENDEZVOUS_METRICS` targeting
   `atrinik_metaserver_rendezvous_canary`, not the exact production target
   `atrinik_metaserver_rendezvous`. Wrangler's dry-run summary shows each
   binding's rate but does not display its `namespace_id`. Each ingress summary
   must show only its canary `COORDINATOR` entrypoint and own limiter set.
   Separately inspect the exact canary configurations selected by `--config`
   and compare all ten IDs with each other and with production;
   record only the comparison result, not secret configuration. A matching
   binding name or clean dry run does not prove isolated counters. Stop on any
   ambiguity or shared state.
   Neither source-configuration review nor the dry run is sufficient alone:
   the former proves namespace-ID isolation and the latter proves the resolved
   artifact/binding contract. This command writes only the local temporary
   bundle and does not upload a version or mutate Cloudflare. After recording
   the reviewed results, remove that local bundle:

   ```sh
   rm -r -- "$ATRINIK_CANARY_DRY_RUN_ROOT"
   ```
3. Deploy the dry-run-reviewed canary provider first, verify both named
   entrypoints and both existing Durable Object namespaces, then deploy the two
   disabled canary ingress Workers. Install a default-deny canary WAF rule and
   allow only the controlled test sources before attaching the separately
   reviewed canary hostnames to their matching ingress Workers. Keep all three
   `workers.dev` and preview URLs off. Temporarily enable each matching edge
   and core breaker only behind that allowlist, prove real Service Binding
   preservation of the signed authority/body/headers, request-source isolation,
   and WebSocket 101/subprotocol handoff, then disable both breakers again
   before changing or widening the exposure. An open circuit cannot exercise a
   Service Binding and is not canary evidence.
4. Verify `/`, OTP issuance, authenticated registration/update,
   `/v2/servers`, and both rendezvous WebSocket roles.
5. Confirm malformed identities, expired/replayed OTPs, missing bearer tokens,
   oversized bodies, and blacklist entries fail closed.
6. Confirm routine traffic, expected `404`, `429`, and open-circuit responses
   emit no custom log. Exercise one bounded rejection, one blacklist match, and
   one forced dependency failure; confirm the exact closed
   `request_rejected`, `blacklist_match`, and `unexpected_error` objects remain
   queryable without addresses/tags, server IDs, patterns/reasons, credentials,
   tokens, exception text, or rendezvous candidates.
7. Send a routine health request, a known-not-found request, and a scheduled
   invocation. Confirm that none persists a `cf-worker-event` record in Workers
   Logs. A forced scheduled failure may emit its bounded custom diagnostic and
   a fixed, cause-free `Scheduled maintenance failed` platform error; neither
   record may contain the underlying exception or request/state data.
8. Apply and exercise the canary edge policy. Confirm raw/unknown targets are
   stopped before Worker invocation and a controlled burst is visible in WAF
   analytics without a matching post-mitigation rise in Worker invocations.
9. Confirm Worker Metrics continues to report aggregate requests, errors, CPU
   time, wall time, and duration. Invocation metrics may increase even though
   automatic invocation-log volume remains flat.
10. Exercise the current and previous source-tag keys. Confirm an `A/Z` writer
   stores exactly `A,Z` and a `B/A` writer stores exactly `B,A`; consume each
   OTP through the other deployment. Alternate `A/Z` and `B/A` budget
   admissions, confirm the maximum count advances once per request, and confirm
   each touched pair converges. The shared `A` must use the identical ID,
   secret, hostname namespace, purpose, and derivation contract. In an isolated
   canary room, claim a fresh rendezvous ticket under `A/Z`, reconstruct the
   room under `B/A`, and confirm replay is rejected through shared `A` while a
   fresh ticket succeeds. Do not print either stored alias.
11. Use fresh controlled source actors whose relevant minute and 24-hour
    windows contain no earlier canary traffic. Verify the 9th directory request
    under a canary limit of 8/day and, independently, the 11th valid dynamic
    request in one minute return `429`, consistent `Retry-After` header/body
    values, and no further handler mutation.
12. Use separate fresh controlled source actors for each assertion. Verify the
    9th status request and 9th unauthenticated server-rendezvous request under
    canary limits of 8/day return their stable daily reasons. From another
    unconsumed source window, force a native/D1 request-control failure and
    confirm a non-cacheable `503 request_control_unavailable` rather than
    admission.
13. Lower all three `RENDEZVOUS_*` canary values to 8 and use a fresh controlled
    server identity whose room has no retained admissions. Open one
    authenticated server-control socket, accept and close eight client sessions,
    and confirm the ninth returns `429` with reason
    `rendezvous_server_sessions_rolling` and a header/body `Retry-After` derived
    from the oldest admission. Confirm a client without a live authenticated
    server receives a retryable `503` and creates no admission row.
14. Use another fresh controlled server identity/room. Exercise the structural
    rendezvous bounds: eight concurrent clients are admitted and the ninth is
    rejected as full; every admitted client closes no later than the
    eight-second canary lifetime; a duplicate/cross-socket ticket, second client
    candidate, thirteenth server candidate, second completion, frame over 512
    bytes, or exchange over 9,216 bytes closes the offending control path before
    unrelated candidate forwarding. Confirm completion and each candidate
    reaches only the ticket's originating client.
15. Use another fresh controlled server identity/room and a disposable,
    unlogged invite capability. Confirm a password-protected listing returns the
    retryable fixed `503` to a no-subprotocol client and to an invite client
    while only a no-subprotocol server control is live. Replace it with an
    authenticated control and client that both negotiate exactly
    `atrinik-classic-rendezvous-invite-v1`; verify the `101` responses echo that
    value. Exercise `auth_init`, `auth_challenge`, `auth_proof`, and both true
    and false `auth_result` paths. No candidate or UDP punch may occur before a
    true result. Wrong, expired, unknown, replayed, cross-ticket, duplicate, or
    out-of-order authorization input must receive only generic denial/closure,
    and server replacement must invalidate every pending attempt. Inspect only
    attachment field names/counters and confirm no invite ID, secret, expiry,
    challenge, proof, serialized authorization frame, ticket, or candidate was
    written to SQLite, KV, D1, logs, or metrics. Finally confirm the independent
    post-QUIC join-password check still succeeds and rejects normally.
16. Use another fresh controlled server identity/room. Let its idle
    server-control WebSocket hibernate, then complete a fresh client attempt.
    Confirm the socket remains usable after object reconstruction and the single
    alarm closes the client and removes its server-side routing metadata at the
    canary session deadline, then remains scheduled only for the earliest
    retained admission's 24-hour expiry. Inject a close failure and confirm the
    terminal socket cannot signal, has no raw ticket/digest, and normally
    receives at most four explicit teardown retries at the deadline and one,
    three, and seven seconds afterward; after that bound, only retained
    admission expiry may keep an application alarm. Also inject simultaneous
    retry-counter serialization and
    transport-close failures: the alarm must fail into Cloudflare's bounded
    failed-alarm retry policy without installing a replacement alarm. No
    interval/timer or fault loop may keep the room resident.
17. Use a fresh controlled canary server identity for a replay/SQL inspection.
    Connect its authenticated server and one client, send a first candidate
    with a fresh ticket, and confirm that candidate reaches the server. Then
    disconnect the server, confirm the client closes, allow and verify Durable
    Object eviction, reconnect the authenticated server, and replay the same
    ticket from a new client. The replay must close before any candidate reaches
    the replacement server; a second fresh ticket must still succeed.

    Through the approved read-only canary Durable Object storage inspection
    path, run these statements without selecting or exporting alias values:

    ```sql
    PRAGMA table_info(rendezvous_admissions);

    SELECT
      COUNT(*) AS retained_rows,
      SUM(CASE
        WHEN ticket_replay_tag_current IS NOT NULL
         AND ticket_replay_tag_previous IS NOT NULL
        THEN 1 ELSE 0
      END) AS claimed_rows,
      SUM(CASE
        WHEN ticket_replay_tag_current IS NULL
         AND ticket_replay_tag_previous IS NULL
        THEN 1 ELSE 0
      END) AS unclaimed_rows,
      SUM(CASE
        WHEN (
          ticket_replay_tag_current IS NULL
          AND ticket_replay_tag_previous IS NULL
        ) OR (
          ticket_replay_tag_current IS NOT NULL
          AND ticket_replay_tag_previous IS NOT NULL
          AND ticket_replay_tag_current <> ticket_replay_tag_previous
          AND substr(
            ticket_replay_tag_current,
            4,
            instr(substr(ticket_replay_tag_current, 4), '.') - 1
          ) <> substr(
            ticket_replay_tag_previous,
            4,
            instr(substr(ticket_replay_tag_previous, 4), '.') - 1
          )
        ) THEN 0 ELSE 1
      END) AS invalid_alias_pairs,
      SUM(CASE
        WHEN ticket_replay_tag_current IS NULL THEN 0
        WHEN length(ticket_replay_tag_current) BETWEEN 48 AND 79
         AND substr(ticket_replay_tag_current, 1, 3) = 'v1.'
         AND instr(substr(ticket_replay_tag_current, 4), '.') BETWEEN 2 AND 33
         AND substr(
           ticket_replay_tag_current,
           4,
           instr(substr(ticket_replay_tag_current, 4), '.') - 1
         ) NOT GLOB '*[^A-Za-z0-9_-]*'
         AND length(substr(
           ticket_replay_tag_current,
           4 + instr(substr(ticket_replay_tag_current, 4), '.')
         )) = 43
         AND substr(
           ticket_replay_tag_current,
           4 + instr(substr(ticket_replay_tag_current, 4), '.')
         ) NOT GLOB '*[^A-Za-z0-9_-]*'
         AND substr(ticket_replay_tag_current, -1)
           GLOB '[AEIMQUYcgkosw048]'
         AND length(ticket_replay_tag_previous) BETWEEN 48 AND 79
         AND substr(ticket_replay_tag_previous, 1, 3) = 'v1.'
         AND instr(substr(ticket_replay_tag_previous, 4), '.') BETWEEN 2 AND 33
         AND substr(
           ticket_replay_tag_previous,
           4,
           instr(substr(ticket_replay_tag_previous, 4), '.') - 1
         ) NOT GLOB '*[^A-Za-z0-9_-]*'
         AND length(substr(
           ticket_replay_tag_previous,
           4 + instr(substr(ticket_replay_tag_previous, 4), '.')
         )) = 43
         AND substr(
           ticket_replay_tag_previous,
           4 + instr(substr(ticket_replay_tag_previous, 4), '.')
         ) NOT GLOB '*[^A-Za-z0-9_-]*'
         AND substr(ticket_replay_tag_previous, -1)
           GLOB '[AEIMQUYcgkosw048]'
        THEN 0 ELSE 1
      END) AS malformed_alias_rows
    FROM rendezvous_admissions;
    ```

    The only columns must be local `id`, `accepted_at_ms`,
    `ticket_replay_tag_current`, and `ticket_replay_tag_previous`;
    the isolated sequence above must produce three retained admissions, two
    claimed rows, and one unclaimed replay-attempt row. Every row must be either
    unclaimed or have both distinct aliases; `invalid_alias_pairs` and
    `malformed_alias_rows` must both be zero. No raw ticket, unkeyed SHA-256
    ticket digest, connection ID, counter, or candidate-address column may
    exist. `retained_rows` must never exceed the canary rolling limit. Do not
    copy the opaque alias values into the release record.
18. Query built-in zone, Worker, and Durable Object metrics for upgrade,
    rejection, connection, raw-frame, and failure counts. Run the
    sampling-weighted SQL in [docs/privacy.md](docs/privacy.md) against only
    `atrinik_metaserver_rendezvous_canary`; do not query or write the production
    dataset as part of canary validation. Confirm each accepted session
    attempted at most one best-effort anonymous terminal summary and no
    room-admission rejection or individual frame created a custom point/log or
    exposed an identifier, ticket, credential, candidate, exception, or
    free-form close reason.
19. With both R2 public development URLs and custom domains still disabled,
    invoke the canary five-minute schedule and inspect only the canary buckets.
    Confirm both profiles publish coherent empty generation 1 aliases, the D1
    checkpoint acknowledges the same generation, and no public artifact or
    custom metadata contains a D1 revision, source address, credential,
    candidate, ticket, or private row. Publish one controlled classic listing
    and confirm generation 2 changes all aliases; send an accepted unchanged
    heartbeat and confirm it extends presence without a revision, generation,
    or R2 write. Then withdraw an explicit endpoint and make the listing
    private; each visible transition must create one later coherent generation
    and the private server must be absent. Exercise exact-cutoff expiry,
    deletion of one alias, a failed D1 checkpoint, and a later retry. Confirm
    recovery never assigns different bytes to one generation and outbox depth
    remains at most one per profile.
20. Query only `atrinik_metaserver_directory_canary`. Confirm each scheduled or
    alarm builder invocation attempts one `directory-build-v1` point with only
    profile, closed build/retention outcomes, count, bounded duration, and a
    bounded cleanup count. Force one build
    failure and confirm no server ID, generation, revision, hostname, digest,
    object key, exception, or D1 value appears. Verify the private immutable
    bucket converges to the latest eight D1-acknowledged cohorts, removes
    abandoned complete and partial cohorts across multiple pages, and that
    no retention operation targets the public alias buckets. This is builder
    evidence only; do not attach a custom domain or claim cache/header
    acceptance until the later service-split canary resolves the explicit
    direct-R2 blockers above.

## Review the exports lifecycle deployment

The production configuration selected above must contain the approved D1,
Durable Object, R2, Analytics Engine, rate-limit, hostname, key-ID, route,
schedule, observability, `workers_dev: false`, and `preview_urls: false`
settings. Do not fall back to the checked-in placeholder configuration or an
implicit account.

This release adds `DirectoryBuilder` through Wrangler's declarative `exports`
lifecycle. Cloudflare applies that lifecycle only through `wrangler deploy`:
`wrangler versions upload` fails when `exports` is present, gradual deployment
is unsupported, and rollback cannot cross the lifecycle change. The local dry
run reviews the bundle and bindings but cannot stage or prove namespace
creation. Treat the cutover as an atomic 100% control-plane change. Both
publisher circuits must remain disabled and both static domains detached so
the new builder can be verified without public writes or reads.

Review the exact config, source revision, dry-run binding summary, protected
two-secret file, D1 bookmark/migration plan, and forward-fix package before
entering the cutover. Secret values must not be printed or copied into the
release record.

## Stage the domainless service boundary

The state-owning provider remains exactly `atrinik-metaserver` with
`wrangler.jsonc`. It owns D1, R2, both schedules, both Analytics Engine
datasets, and both Durable Object namespaces. Its declarative exports now also
include the cache-disabled `PublisherCoordinator` and `RendezvousCoordinator`
Worker entrypoints. Do not move either Durable Object, add `script_name`, or
copy any state binding into a caller.

The callers are `atrinik-metaserver-publisher` from
`wrangler.publisher.jsonc` and `atrinik-metaserver-rendezvous` from
`wrangler.rendezvous.jsonc`. Each has exactly one named `COORDINATOR` Service
Binding to the provider, distinct native rate namespace IDs, no state or cron
binding, no route, no Custom Domain, and a disabled circuit. Generate/check all
three type surfaces and review all three distinct dry-run directories before
any deployment.

`PUBLISH_HOSTNAME` and `RENDEZVOUS_HOSTNAME` are explicit, fail-closed
authorities. Production pins the canonical hostnames in both the corresponding
caller and provider. An isolated canary pins its own non-production values on
both sides; copying only one side is a stop condition.

Do not deploy this topology before the pending D1 migrations in Cut over step 2
have completed. The provider-first and caller deployments are one ordered part
of Cut over step 3, not a pre-migration staging operation. The callers cannot
bind to entrypoints that are not active, and the provider's existing `exports`
lifecycle forbids `versions upload` and gradual rollout. Deploying callers does
not authorize route attachment.

Re-read all three deployments. Both callers must still have no public route,
no alternate URL, and disabled breakers. Their source-tag IDs and encrypted
secret pair must match the core's reviewed rotation epoch, while every native
rate namespace ID remains unique. A later isolated canary must prove that the
HTTP signature bytes and WebSocket upgrade/subprotocol survive the Service
Binding, that source addresses/browser headers do not cross into the core, and
that either caller cannot dispatch the other's entrypoint. Only after the
host-specific WAF, observability, rollback, and consumer gates pass may a
separate reviewed change attach a canonical Custom Domain and enable both the
edge and core breaker for that service.

## Cut over

1. Pause server updates for the additive migration and Worker switch. Record a
   fresh D1 recovery bookmark.
2. Apply only pending ordered migrations to the approved production D1
   database and verify the migration ledger.
3. Deploy the reviewed source and exact production configurations in provider-
   first order. The provider deploy applies its `exports` lifecycle directly to
   100%; the three deployments are not one cross-Worker atomic operation. Keep
   all breakers disabled and every new ingress domain detached throughout:

   ```sh
   npx wrangler deploy --strict \
     --config "$ATRINIK_PROD_CONFIG" \
     --name "$ATRINIK_PROD_WORKER" \
     --profile "$ATRINIK_CF_PROFILE" \
     --tag static-directory-foundation \
     --secrets-file "$ATRINIK_SOURCE_TAG_SECRETS"
   npx wrangler deployments list --json \
     --config "$ATRINIK_PROD_CONFIG" \
     --name "$ATRINIK_PROD_WORKER" \
     --profile "$ATRINIK_CF_PROFILE"
   npx wrangler deploy --strict \
     --config /secure/path/atrinik-publisher.production.jsonc \
     --name atrinik-metaserver-publisher \
     --profile "$ATRINIK_CF_PROFILE" \
     --secrets-file "$ATRINIK_SOURCE_TAG_SECRETS"
   npx wrangler deploy --strict \
     --config /secure/path/atrinik-rendezvous.production.jsonc \
     --name atrinik-metaserver-rendezvous \
     --profile "$ATRINIK_CF_PROFILE" \
     --secrets-file "$ATRINIK_SOURCE_TAG_SECRETS"
   ```

   Capture and review Wrangler's `Durable Object exports reconciliation`; it
   must preserve `RendezvousRoom` and create exactly `DirectoryBuilder`, with
   no deletion, rename, or transfer. Re-read both caller deployments and prove
   they remain domainless, disabled, state-free, and bound only to the matching
   named provider entrypoint. Record the active provider version ID, inspect it
   with `wrangler versions view`, and verify its source tag, compatibility
   settings, variables, D1, R2, Durable Object, Analytics Engine, rate-limit,
   schedule, and both secret binding names. Verify there is no public alternate
   hostname. Delete the protected secret file only after the forward-fix
   package no longer needs it.

   The lifecycle deployment is already assigned directly to 100%. Do not
   attempt a gradual deployment or rollback to a pre-`DirectoryBuilder`
   version; Cloudflare does not support either across an `exports` lifecycle
   change. A failed post-deploy canary must disable circuits and fix forward
   with the same live exports map. Do not gradually
   split public rendezvous traffic between the former unversioned broadcast
   room and the ticket-scoped room. The private Worker-to-Durable-Object upgrade
   uses a new versioned URL/header contract: a new Worker reaching an old room,
   or an old Worker reaching a reconstructed new room, rejects the upgrade
   instead of silently entering the former behavior. That fail-closed
   version-skew window can produce temporary `403`/`503` responses during
   propagation; it must never be bypassed with an unversioned fallback.
4. Install and re-read the reviewed zone edge rules. Confirm the reviewed
   production configuration contains only the intended Custom Domain/route and
   the exact crons `*/5 * * * *` and `17 * * * *`. Version inspection does not
   prove the external trigger state. `wrangler triggers deploy` changes both trigger classes
   immediately; before running it, compare the resolved production config with
   the current route/domain and Cron Trigger API state and stop on any
   unreviewed hostname or schedule. Only after both the canary and edge-policy
   release gate pass, reconcile from that same explicit target:

   ```sh
   npx wrangler triggers deploy \
     --config "$ATRINIK_PROD_CONFIG" \
     --name "$ATRINIK_PROD_WORKER" \
     --profile "$ATRINIK_CF_PROFILE"
   ```

   Re-read the Cloudflare route/Custom Domain and Cron Trigger state through the
   dashboard or API; verify only `meta.atrinik.org` reaches this Worker and the
   active schedules are exactly `*/5 * * * *` and `17 * * * *` before resuming
   publishing. The builder buckets remain domainless in this foundation
   release.
5. Use only a classic server/client/libatrinik release that supports
   addressless directory entries, ticket-scoped QUIC rendezvous, bounded
   publisher cadence, and `Retry-After`. Older publishers remain paused rather
   than advertising an entry their clients cannot join. Register controlled
   servers and complete supervised friend joins from a current client for an
   addressless passwordless server, an addressless invite-protected server
   with no pre-authorization candidate, and an explicit DNS fallback with
   certificate pinning. Verify a private update removes discovery and denies
   both rendezvous roles.
6. Monitor aggregate status counts, WAF mitigations, D1 errors/overload,
   Durable Object failures, response time, request-control `503`s, and
   stale-record cleanup through at least one scheduled run. Any scheduled
   failure is a cleanup-backlog alert. A D1 failure must fail closed; it must
   never be interpreted as request admission.
7. Repeat the observability canary after every entrypoint split. Publisher and
   rendezvous Workers must each set `observability.logs.invocation_logs` to
   `false`; static directory hostnames must resolve directly to the approved
   storage/cache path and execute no Worker.
8. Watch authenticated server-control upgrade and close counts closely. Older
   classic servers reconnect on a two-second fixed loop after a control socket
   is rejected or closed; their producer backoff is tracked in
   [atrinik/classic#5](https://github.com/atrinik/classic/issues/5). If that
   behavior causes an invocation spike, disable the rendezvous route and fix
   forward rather than relaxing authentication, admission, or frame limits.

## Rotate source-tag keys

Treat key IDs, secret values, code, and hostname namespace as one versioned
contract. For an `A/Z` to `B/A` rotation, update the reviewed Wrangler IDs to
`B/A` and prepare a protected, ignored secrets file containing the corresponding
current `B` and previous `A` values. Run the bidirectional test against the
isolated canary cohort first, then deploy the reviewed pair to all three
services in provider-first order with the unchanged live `exports` map. There
is no cross-Worker atomic deploy; shared `A` preserves overlap while the cohort
converges:

The provider deploy restarts every live Durable Object and disconnects its
WebSockets. Announce a controlled reconnect window, confirm the classic server
cohort is on the bounded-backoff release, watch server-control reconnect and
rate-limit counts, and keep the rendezvous edge breaker ready to close. Prove
this restart/reconnect behavior in the isolated canary before rotating
production. If reconnect pressure is unsafe, disable the public breaker and
fix forward; do not raise budgets or bypass authentication.

```sh
npx wrangler deploy --strict --tag source-tag-b-a \
  --config "$ATRINIK_PROD_CONFIG" \
  --name "$ATRINIK_PROD_WORKER" \
  --profile "$ATRINIK_CF_PROFILE" \
  --secrets-file /secure/path/source-tags-b-a.env
npx wrangler deploy --strict --tag source-tag-b-a \
  --config /secure/path/atrinik-publisher.production.jsonc \
  --name atrinik-metaserver-publisher \
  --profile "$ATRINIK_CF_PROFILE" \
  --secrets-file /secure/path/source-tags-b-a.env
npx wrangler deploy --strict --tag source-tag-b-a \
  --config /secure/path/atrinik-rendezvous.production.jsonc \
  --name atrinik-metaserver-rendezvous \
  --profile "$ATRINIK_CF_PROFILE" \
  --secrets-file /secure/path/source-tags-b-a.env
```

Inspect all three active rotation versions with their explicit `--config`,
`--name`, and `--profile` arguments. Verify the `B/A` IDs, both secret binding names,
hostname namespace, unchanged exports reconciliation, and every non-secret
binding against the release record. Do not use sequential `wrangler secret
put` operations: each command can create an intermediate version whose IDs and
secrets do not form the reviewed pair. Keep at least one shared key valid at
every step; do not attempt a gradual split or roll traffic between disjoint
pairs.

An `A/Z` rendezvous writer stores both aliases in the admission row; `B/A`
detects the same ticket through shared `A` even after server reconnect and room
reconstruction. Keep `A` until the last old writer among all three services has
stopped, strictly more than
24 hours has elapsed since the last possible old-pair replay claim, and the
longest UTC-day budget, OTP lifetime, propagation interval, and cleanup run
have also elapsed. Rotate at the next UTC budget boundary and verify no backlog
before preparing `C/B`.

Durable Object point-in-time recovery may retain the deleted `A/Z` opaque
aliases for its platform retention window; retiring `A` does not erase that
history. Treat a replay-ledger restore as a key/schema recovery operation and
fail closed unless its reviewed artifact has the matching key pair. Remove the
protected secrets file according to the operator's credential-handling policy;
never commit it or paste its contents into logs or review comments.

## Administrative SQL

`scripts/admin_sql.py` never connects to Cloudflare. It emits SQL for operator
review:

```sh
python3 scripts/admin_sql.py reset-owner SERVER_ID
python3 scripts/admin_sql.py blacklist-add '1111*' 'reason'
python3 scripts/admin_sql.py blacklist-remove '1111*'
```

An owner reset deletes both ownership and listing rows for exactly one
64-character server identity. Verify certificate-holder authorization first,
then preserve the matching local publisher identity and sequence state or
deliberately rotate both before re-registering. Never reset only the sequence:
doing so can replay values retained by another deployment or backup. Treat this
as destructive recovery.

## Roll back

Prefer a forward fix. For a rendezvous-only incident, close the rendezvous
circuit breaker or detach its dedicated Custom Domain first; for the combined
compatibility deployment, detach the production Custom Domain if isolation is
not possible. These actions leave reviewed code/state intact and do not enable
a `workers.dev` fallback. Never restore a pre-hardening rendezvous version that
broadcasts candidates or accepts unbounded signaling work. Re-enable only a
reviewed fix-forward artifact with the versioned internal contract.

Never run `wrangler deploy`, `wrangler versions upload`, or secret commands
from an older checkout or with an older/implicit Wrangler configuration. That
can publish obsolete bindings, re-enable `workers.dev` or preview URLs, and
create a version whose key IDs and secrets do not match. If old code must be
considered during incident recovery, forward-port it onto the current hardened
configuration and submit the resulting version to the same explicit-target,
binding-inspection, and privacy review gates. Do not treat a source checkout as
a rollback artifact.

Deploying the pre-foundation Worker is a privacy regression: it resumes raw
request-address writes in OTP/rate/owner/listing state, can again infer and
publish the HTTPS source as a QUIC endpoint, and cannot consume tagged OTPs.
Publishing must remain paused for the entire lifetime of such an artifact—not
merely until tagged OTPs expire—and an explicit privacy/security review is
required before using it. Restoring an older D1 backup can also reintroduce raw
values and starts a new D1 Time Travel/export retention period.

Restore a backup only when the reviewed recovery plan requires it, and only
with a validated artifact/schema pair. After a privacy-regressing restore, the
forward path must include a new append-only, ordered sanitization migration,
run only after every old raw-address writer is permanently unable to receive
traffic. That migration must:

1. overwrite every non-empty `server_owners.current_ip` and
   `servers.source_ip` value with the empty compatibility sentinel, including
   dormant rows that never republish;
2. delete all remaining legacy raw-source OTP rows after the maximum OTP
   lifetime has elapsed, and delete obsolete legacy `rate_limits` rows once no
   supported code reads them;
3. remove request-address blacklist patterns only after each retained policy
   has been reviewed and, where still required, moved to the approved WAF
   policy; and
4. verify counts of non-empty live raw-source values are zero without selecting
   or exporting the values themselves.

Record the completion time of that migration. Overwritten or deleted data
remains recoverable through D1 Time Travel for the plan-specific retention
window, and Workers Logs or manual exports may retain independent copies. Allow
all of those windows to age out and apply the deletion policy to exports before
claiming historical deletion. Preserve only redacted diagnostics and the failed
artifact for diagnosis.
