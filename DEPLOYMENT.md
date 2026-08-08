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

npx wrangler whoami --profile "$ATRINIK_CF_PROFILE"
```

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
   shell history, logs, or this repository.
6. Run `npm ci` and `npm run check` from this directory.
7. Run the following dry run and review its output for unexpected bindings,
   routes, compatibility changes, or secrets:

   ```sh
   npx wrangler deploy --dry-run --outdir dist \
     --config "$ATRINIK_PROD_CONFIG" \
     --name "$ATRINIK_PROD_WORKER" \
     --profile "$ATRINIK_CF_PROFILE"
   ```

8. Confirm the production artifact has `workers_dev: false` and
   `preview_urls: false`. Review and stage
   [docs/edge-policy.md](docs/edge-policy.md); no production custom domain may
   be attached before its raw-target gate and rate-policy decision pass review.

Migration `0002_request_control.sql` is additive. It adds dual-tagged
transitional OTP state and exact request budgets without changing existing
ownership or listing rows. Apply it before deploying code that writes
`source_tag`, `source_tag_previous`, or `request_budgets`. An older Worker can
continue issuing raw-source OTP rows
against the additive schema, but it cannot consume a new tagged OTP. Pause
updates during the Worker switch and prefer a forward fix over a mixed-version
rollback.

## Canary

1. Create a separate canary D1 database and apply
   all ordered migrations to it.
2. Deploy a canary Worker on a separately reviewed canary custom hostname. Use
   a canary-only configuration and keep both `workers.dev` and preview URLs off.
3. Verify `/`, OTP issuance, authenticated registration/update,
   `/v2/servers`, and both rendezvous WebSocket roles.
4. Confirm malformed identities, expired/replayed OTPs, missing bearer tokens,
   oversized bodies, and blacklist entries fail closed.
5. Confirm routine traffic, expected `404`, `429`, and open-circuit responses
   emit no custom log. Exercise one bounded rejection, one blacklist match, and
   one forced dependency failure; confirm the exact closed
   `request_rejected`, `blacklist_match`, and `unexpected_error` objects remain
   queryable without addresses/tags, server IDs, patterns/reasons, credentials,
   tokens, exception text, or rendezvous candidates.
6. Send a routine health request, a known-not-found request, and a scheduled
   invocation. Confirm that none persists a `cf-worker-event` record in Workers
   Logs. A forced scheduled failure may emit its bounded custom diagnostic and
   a fixed, cause-free `Scheduled maintenance failed` platform error; neither
   record may contain the underlying exception or request/state data.
7. Apply and exercise the canary edge policy. Confirm raw/unknown targets are
   stopped before Worker invocation and a controlled burst is visible in WAF
   analytics without a matching post-mitigation rise in Worker invocations.
8. Confirm Worker Metrics continues to report aggregate requests, errors, CPU
   time, wall time, and duration. Invocation metrics may increase even though
   automatic invocation-log volume remains flat.
9. Exercise the current and previous source-tag keys. Confirm an `A/Z` writer
   stores exactly `A,Z` and a `B/A` writer stores exactly `B,A`; consume each
   OTP through the other deployment. Alternate `A/Z` and `B/A` budget
   admissions, confirm the maximum count advances once per request, and confirm
   each touched pair converges. The shared `A` must use the identical ID,
   secret, hostname namespace, purpose, and derivation contract.
10. Verify the 9th directory request under a canary limit of 8/day and the 11th
    valid dynamic request in one minute return `429`, consistent
    `Retry-After` header/body values, and no further handler mutation.
11. Verify the 9th status request and 9th unauthenticated server-rendezvous
    request under canary limits of 8/day return their stable daily reasons.
    Force a native/D1 request-control failure and confirm a non-cacheable
    `503 request_control_unavailable` rather than admission.

## Stage and inspect the production version

The production configuration selected above must contain the approved D1,
Durable Object, rate-limit, hostname, key-ID, route, observability,
`workers_dev: false`, and `preview_urls: false` settings. Do not fall back to
the checked-in placeholder configuration or an implicit account. Upload the
initial current and previous secrets together with that exact configuration:

```sh
npx wrangler versions upload --strict \
  --config "$ATRINIK_PROD_CONFIG" \
  --name "$ATRINIK_PROD_WORKER" \
  --profile "$ATRINIK_CF_PROFILE" \
  --tag request-control-foundation \
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

Confirm the version's Worker name, code/tag, compatibility settings, variables,
D1 and Durable Object bindings, rate-limit bindings, and both secret binding
names against the release record. Secret values must not be printed or copied
into the record. Stop if any binding or ID is absent, unexpected, or belongs to
another environment. Delete the protected secret file according to the
credential-handling policy only after the inspected version no longer needs to
be recreated.

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
split traffic only after the bidirectional canary in step 9 passes, then move
the reviewed version to 100%. Do not use sequential `wrangler secret put`
operations: each command can create an intermediate version whose IDs and
secrets do not form the reviewed pair. Never roll traffic between disjoint
pairs.

Keep `A` until all `A/Z` traffic has stopped and the longest UTC-day budget,
OTP lifetime, propagation interval, and cleanup run have elapsed. Rotate at the
next UTC budget boundary and verify no backlog before preparing `C/B`. Remove
the protected secrets file according to the operator's credential-handling
policy; never commit it or paste its contents into logs or review comments.

## Administrative SQL

`scripts/admin_sql.py` never connects to Cloudflare. It emits SQL for operator
review:

```sh
python3 scripts/admin_sql.py reset-owner SERVER_ID
python3 scripts/admin_sql.py blacklist-add '1111*' 'reason'
python3 scripts/admin_sql.py blacklist-remove '1111*'
```

An owner reset deletes both ownership and listing rows for exactly one
64-character server identity. The server must also reset its local metaserver
authentication key before re-registering. Treat this as destructive recovery.

## Roll back

Prefer a forward fix. Detaching the production Custom Domain is the safe first
rollback because it leaves the reviewed code and schema intact and does not
enable a `workers.dev` fallback.

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
