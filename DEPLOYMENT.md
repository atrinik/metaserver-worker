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
   `atrinik_metaserver_rendezvous`; this is the comparison baseline for the
   canary dry run below.

8. Confirm the production artifact has `workers_dev: false` and
   `preview_urls: false`. Review and stage
   [docs/edge-policy.md](docs/edge-policy.md); no production custom domain may
   be attached before its raw-target gate and rate-policy decision pass review.
9. Confirm the artifact has the `RENDEZVOUS_METRICS` Analytics Engine binding
   targeting only `atrinik_metaserver_rendezvous`, the SQLite `RENDEZVOUS`
   Durable Object binding, and all three rendezvous policy variables. The
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

## Canary

1. Create a separate canary D1 database and apply all ordered migrations to it.
   Provision a separate Analytics Engine dataset named
   `atrinik_metaserver_rendezvous_canary`. The code-facing binding remains
   `RENDEZVOUS_METRICS`, but its canary resource target must never be the
   production `atrinik_metaserver_rendezvous` dataset. Give every one of the
   seven native Rate Limiting bindings a canary-only `namespace_id` that is
   distinct from every production ID and from the other canary IDs. Cloudflare
   deliberately shares counters between Workers that reuse a namespace ID, so
   copied IDs would couple canary traffic to production. The separate canary
   Worker must also own its declarative `RendezvousRoom` namespace; do not bind
   it to the production script/class namespace.
2. Before any canary deployment, run a local-only dry run with the exact canary
   target and configuration:

   ```sh
   readonly ATRINIK_CANARY_CONFIG=/secure/path/atrinik-metaserver.canary.jsonc
   readonly ATRINIK_CANARY_WORKER=atrinik-metaserver-canary
   readonly ATRINIK_CANARY_CF_PROFILE=atrinik-canary
   readonly ATRINIK_CANARY_DRY_RUN_DIR="$(mktemp -d)"

   npx wrangler deploy --dry-run --outdir "$ATRINIK_CANARY_DRY_RUN_DIR" \
     --config "$ATRINIK_CANARY_CONFIG" \
     --name "$ATRINIK_CANARY_WORKER" \
     --profile "$ATRINIK_CANARY_CF_PROFILE"
   ```

   Compare the resolved binding summary with the production dry run recorded in
   Prepare step 7. It must show the canary Worker name, canary-owned
   `RendezvousRoom`, canary D1 database, all seven Rate Limiting bindings, and
   `RENDEZVOUS_METRICS` targeting
   `atrinik_metaserver_rendezvous_canary`, not the exact production target
   `atrinik_metaserver_rendezvous`. Wrangler's dry-run summary shows each
   binding's rate but does not display its `namespace_id`. Separately inspect
   the exact canary configuration selected by `--config` and compare all seven
   IDs with each other and with the production configuration/release record;
   record only the comparison result, not secret configuration. A matching
   binding name or clean dry run does not prove isolated counters. Stop on any
   ambiguity or shared state.
   Neither source-configuration review nor the dry run is sufficient alone:
   the former proves namespace-ID isolation and the latter proves the resolved
   artifact/binding contract. This command writes only the local temporary
   bundle and does not upload a version or mutate Cloudflare. After recording
   the reviewed results, remove that local bundle:

   ```sh
   rm -r -- "$ATRINIK_CANARY_DRY_RUN_DIR"
   ```
3. Deploy the dry-run-reviewed canary Worker on a separately reviewed canary
   custom hostname. Use only that canary configuration and keep both
   `workers.dev` and preview URLs off.
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

## Stage and inspect the production version

The production configuration selected above must contain the approved D1,
Durable Object, Analytics Engine, rate-limit, hostname, key-ID, route,
observability,
`workers_dev: false`, and `preview_urls: false` settings. Do not fall back to
the checked-in placeholder configuration or an implicit account. Upload the
initial current and previous secrets together with that exact configuration:

```sh
npx wrangler versions upload --strict \
  --config "$ATRINIK_PROD_CONFIG" \
  --name "$ATRINIK_PROD_WORKER" \
  --profile "$ATRINIK_CF_PROFILE" \
  --tag rendezvous-work-budgets \
  --secrets-file "$ATRINIK_SOURCE_TAG_SECRETS"
```

That single upload stages the current and previous encrypted secrets with the
exact code, variables, and bindings that consume them; it does not send the new
version traffic. Record the returned version ID as `REVIEWED_VERSION_ID`, then
inspect it before deployment:

```sh
readonly REVIEWED_VERSION_ID=replace-with-returned-version-id

npx wrangler versions view "$REVIEWED_VERSION_ID" --json \
  --config "$ATRINIK_PROD_CONFIG" \
  --name "$ATRINIK_PROD_WORKER" \
  --profile "$ATRINIK_CF_PROFILE"
```

Confirm the version's Worker name, code/tag, compatibility settings (including
`no_web_socket_compression`), variables, D1, Durable Object, Analytics Engine,
and rate-limit bindings, and both secret binding names against the release
record. Secret values must not be printed or copied into the record. Stop if
any binding or ID is absent, unexpected, or belongs to another environment.
Delete the protected secret file according to the credential-handling policy
only after the inspected version no longer needs to be recreated.

## Cut over

1. Pause server updates for the additive migration and Worker switch. Record a
   fresh D1 recovery bookmark.
2. Apply only pending ordered migrations to the approved production D1
   database and verify the migration ledger.
3. Deploy only `REVIEWED_VERSION_ID`, whose production bindings and two secret
   names were inspected above; do not use `wrangler deploy`, which would upload
   a different unreviewed version:

   ```sh
   npx wrangler versions deploy "$REVIEWED_VERSION_ID@100%" \
     --config "$ATRINIK_PROD_CONFIG" \
     --name "$ATRINIK_PROD_WORKER" \
     --profile "$ATRINIK_CF_PROFILE"
   npx wrangler deployments list --json \
     --config "$ATRINIK_PROD_CONFIG" \
     --name "$ATRINIK_PROD_WORKER" \
     --profile "$ATRINIK_CF_PROFILE"
   ```

   Verify the active deployment references that exact version and has no public
   alternate hostname. Version inspection does not replace separate review of
   the Custom Domain, route, and scheduled-trigger state.

   Assign this security-contract release directly to 100%. Do not gradually
   split public rendezvous traffic between the former unversioned broadcast
   room and the ticket-scoped room. The private Worker-to-Durable-Object upgrade
   uses a new versioned URL/header contract: a new Worker reaching an old room,
   or an old Worker reaching a reconstructed new room, rejects the upgrade
   instead of silently entering the former behavior. That fail-closed
   version-skew window can produce temporary `403`/`503` responses during
   propagation; it must never be bypassed with an unversioned fallback.
4. Install and re-read the reviewed zone edge rules. Confirm the reviewed
   production configuration contains only the intended Custom Domain/route and
   the exact hourly cron `17 * * * *`. A version upload does not apply either
   trigger class. `wrangler triggers deploy` changes both trigger classes
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
   active schedule is exactly `17 * * * *` before resuming publishing.
5. Register controlled servers and verify their certificate identity,
   endpoint, visibility, and rendezvous flow from a current client.
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
current `B` and previous `A` values. Upload them together as one version:

```sh
npx wrangler versions upload --strict --tag source-tag-b-a \
  --config "$ATRINIK_PROD_CONFIG" \
  --name "$ATRINIK_PROD_WORKER" \
  --profile "$ATRINIK_CF_PROFILE" \
  --secrets-file /secure/path/source-tags-b-a.env
```

Before assigning traffic, pass the returned rotation version ID to
`wrangler versions view` with the same explicit `--config`, `--name`, and
`--profile` arguments used above. Verify the `B/A` IDs, both secret binding
names, hostname namespace, and every non-secret binding against the release
record. Use `npx wrangler versions deploy` with those same target arguments to
split traffic only after the bidirectional canary in step 10 passes, then move
the reviewed version to 100%. Do not use sequential `wrangler secret put`
operations: each command can create an intermediate version whose IDs and
secrets do not form the reviewed pair. Never roll traffic between disjoint
pairs.

An `A/Z` rendezvous writer stores both aliases in the admission row; `B/A`
detects the same ticket through shared `A` even after server reconnect and room
reconstruction. Keep `A` until all `A/Z` traffic has stopped, strictly more than
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
