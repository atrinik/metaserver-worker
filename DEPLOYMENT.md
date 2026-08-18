# Metaserver Worker deployment

This runbook deploys the canonical-only three-Worker architecture. Classic
v5.9.0 is the minimum supported consumer. The removed CGI/public `/v2` API has
no traffic-drain, fallback, redirect, application `410`, or rollback path.

Production state exists. Applied D1 migrations are immutable and new schema
work is append-only. The core owns D1, R2, schedules, Analytics Engine,
`RendezvousRoom`, and `DirectoryBuilder`. The publisher and rendezvous Workers
are stateless public edges with one named Service Binding each.

## Automatic protected-main delivery

Routine delivery uses one Cloudflare Workers Builds connection to
`atrinik/metaserver-worker`. Configure it exactly from
`deployment/workers-builds-production.json`: repository root, production
branch `main`, every push included with no watch-path exclusion, build command
`env -i PATH="$PATH" npm_config_cache=/tmp/atrinik-npm-cache npm install
--global --ignore-scripts npm@11.16.0 && env -i PATH="$PATH"
npm_config_cache=/tmp/atrinik-npm-cache npm ci --ignore-scripts`, deploy command
`npm run deploy:production`, `SKIP_DEPENDENCY_INSTALL=1`, and the pinned
Node/npm/Wrangler versions. An accepted pull-request merge into protected
`main` is the routine authorization. Do not add another production branch,
tag/release gate, GitHub environment approval, deploy hook, Actions deployment
workflow/secret, or local Wrangler step. Semantic Release independently
consumes the same accepted SHA and does not gate deployment.

Cloudflare-owned secret build variables contain three minified JSONC
configurations, each below the provider's 5 KiB variable limit:

```text
ATRINIK_PRODUCTION_CORE_CONFIG
ATRINIK_PRODUCTION_PUBLISHER_CONFIG
ATRINIK_PRODUCTION_RENDEZVOUS_CONFIG
ATRINIK_WORKERS_BUILDS_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
ATRINIK_PRODUCTION_CONTROL_PLANE_READY
```

The entrypoint materializes the configurations as owner-only temporary files
outside the checkout, resolves only repository-contained entrypoints, and
removes the files on every exit. The Builds API token is a separate
user-scoped secret with Workers CI Write only; it arbitrates this production
trigger by retaining the newest eligible current-main build, making every
older build relinquish, and cancelling only older competitors before any
Worker mutation. It also reconciles the live GitHub repository, root, core
project tag, branch/watch filters, build/deploy commands, and exact protected
environment inventory/classification with the checked-in contract. Every fence
fetches the current trigger rather than trusting the build-start snapshot. Use
`routine` only while the live
control-plane digest is unchanged. After separately authorized
migration/DNS/WAF/domain/route/trigger, secret-rotation, resource, or ownership
work, use `approved:<exact-current-main-SHA>` for that retry only, then restore
`routine`. Never print a protected file, identifier, secret value, recovery
coordinate, or raw provider response. Routine deploys inherit already
provisioned encrypted runtime secrets by name and never read, upload, rotate,
or delete their values.
The first provider connection also uses this exact-SHA gate because the live
versions do not yet carry the repository delivery annotations; restore
`routine` after all three annotated versions pass readback and canaries.

The entrypoint performs this fail-closed sequence:

1. Require Workers Builds on `main`, a build UUID, the expected connected core
   project/tag, a clean `HEAD` equal to `WORKERS_CI_COMMIT_SHA`, and the
   intended account. The provider install command starts with an empty
   environment and disables dependency lifecycle scripts. Before repository
   code runs, reconcile the live trigger and protected environment. Repository
   checks and public canaries receive a positive allowlist of non-secret process
   settings only; Wrangler additionally receives only deployment authentication
   and its private configuration path; the lease token remains in the parent
   process. This allowlist prevents inheritance and accidental tool exposure;
   trusted merged repository code remains in the same-UID build trust boundary.
   Materialize private configurations only after repository checks.
2. Run the complete repository check; then validate all three protected configs,
   bounded runtime policies, coherent circuit values, exact Custom Domains and
   their shared `atrinik.org` zone ID, bindings, variables, secret names, unique
   rate namespaces, disabled alternate URLs, observability, cron schedules, and
   the ordered D1 ledger against live readback.
3. Resolve the desired and disabled-circuit strict dry-run bundles before
   mutation and hash them with the configs, migrations, lockfile, commands,
   canaries, and contract.
4. Read back one active 100% version per Worker. If the complete deployable
   digest is already active, report `no-deployment-required`, run the bounded
   canaries, and upload nothing, avoiding a Durable Object restart.
5. Recheck current `main` before the first upload and before and after every
   stage; cancel and wait for every stale main build, repeat the inventory until
   the sole exact-SHA Builds lease converges, and make current `main` the final
   remote proof. Deploy and read back core, publisher, then rendezvous with every
   public circuit forced disabled.
6. Prove the staged three-role cohort is coherent. Restore the desired caller
   configs in publisher/rendezvous order while core remains disabled, restore
   core last, and validate every direct `wrangler deploy --strict` at 100%.
   Thus any pre-final failure leaves or restores the core breakers disabled.
7. Record exact source, deployable, migration digest/horizon, control-plane,
   role, and phase
   in each version. Re-read exports, bindings, routes, Custom Domains,
   subdomain, schedules, runtime, and observability after each stage; reread
   one coherent active topology, then run bounded Classic/Game static-origin
   canaries. The publisher and rendezvous canaries use credential-free probes
   inside the exact governed non-retirable Classic v2 `POST .../publish` and
   Classic `GET ...?role=server` envelopes: an enabled circuit must return the
   coordinator's fixed closed rejection across the Service Binding, while a
   disabled circuit must return its exact local closed response and retry
   policy. No health-route or WAF exception exists. A canary/final-readback
   failure also restores and proves the disabled core configuration.

The build token needs read access to current Worker configuration and the D1
migration ledger plus exact deployment authority for these three Workers. The
separate lease token needs Workers CI Write solely to inspect this trigger and
cancel competing builds.
It must not receive D1 migration, DNS, WAF, general account administration,
secret-read, or destructive-resource authority.

`npm run deploy:production:dry-run` validates the checked-in fixtures, resolves
all bundles, and prints only safe digests and names. It never reads GitHub or
Cloudflare and has no upload path.

### Workers Builds provisioning preflight

Issue #56 historically delivered the checked-in composition; replacement
execution authority #66 now composes the production and review contracts through
`scripts/workers-builds-provisioning.mjs`. The validator and dry run are
credential-free and have no provider mutation path:

```sh
npm run provision:workers-builds:validate
npm run provision:workers-builds:dry-run
npm run provision:workers-builds:plan-setup
```

`plan-setup` emits a value-free, non-executable mutation plan. It records the
exact GitHub repository connection, actor boundaries, private-file inputs,
request/result dependencies, separate control-plane/build/lease token authority,
separately gated activation, an owner-only mutation journal, ambiguous-response readback, and
ordered exact-resource rollback. Cloudflare exposes repository-connection
upsert and delete but no read/list operation, so rollback always retains the
shared exact GitHub connection; configured trigger readback proves the returned
connection identity. Existing production
Workers, versions, state, and runtime secrets are never rollback targets.
Because Cloudflare requires a trigger UUID before its environment can be
written, the operator generates one private random
`review-build-only-sentinel-<32-lowercase-hex>` selector for production staging
and uses `gh api` outside the sandbox to retain a fresh, exact empty matching-ref
proof for that governed repository coordinate. Setup rechecks the proof
immediately before the production trigger and environment mutations and binds
it into staged readback. Rollback likewise obtains a new production proof
immediately before its full production-trigger restore PATCH; an expired or
missing rollback proof stops before mutation. The restore request uses the
zero-resource review token. The staged production trigger uses the review token,
whose provider policy has no account or zone resource. The preview trigger is
absent during inert setup because the provider accepts it only in its documented
final wildcard/exclude-main shape; it is created with that exact shape and the
zero-resource token only after the separate review-activation gate. Production
activation is one trigger PATCH that atomically replaces the private production
selector and zero-resource token with `main` and the production token. Its
provider activation readback runs first; the fresh production-selector GitHub
absence proof is the final operation immediately before that PATCH. Thus a selector race
never receives deploy authority; the unguessable, repeatedly absent production
ref also protects the staged production secrets. The fixed
`review-build-only-sentinel` name is not used.

Rollback first deletes and reads back the exact journal-owned wildcard preview
trigger, before any quiescence claim, so a new non-main push cannot enqueue work
behind that claim. The phase-aware exhaustive readback accepts zero triggers
when production creation never occurred, or exactly the journaled production
trigger otherwise; it never requires an absent review-gate result and rejects
every replacement or competing trigger. It then obtains the fresh production sentinel proof, restores
the production trigger to the zero-resource inert shape, and performs another
stable exhaustive readback proving that exact journaled trigger is inert (or
that the inventory is empty when production creation never occurred). Only
that proof and the preview-deletion proof authorize build cancellation and
quiescence; rollback then deletes the production trigger and journal-owned token
wrappers. The retained repository connection is never deleted.

The retained issue-66 history records two distinct Cloudflare `12002` failures.
The first accepted a production trigger and environment but rejected a second
trigger on a different Worker that reused the repository connection; that
one-connection/two-Worker request remains forbidden and is never retried or
varied. The later attempt targeted the shared core Worker but used a private
sentinel selector for the second preview trigger; that exact request is also
forbidden and is never retried or normalized. The replacement uses Cloudflare's
documented maximum-two-trigger model on the single production core Worker: one
production trigger and one final-shape preview trigger, with distinct
per-trigger tokens, commands, and environments. Equality,
proof/selector swaps, fixed names, a second connected Worker, and fallback to
an unreviewed request all fail before setup mutation.

The production activation initially retains the `routine` control-plane gate.
Its first automatic `main` build must therefore fail closed if the existing
versions still lack delivery annotations. Once that exact merge SHA is known,
the separately authorized operator may set `approved:<exact-current-main-SHA>`
and retry that same provider entrypoint; an older SHA cannot be substituted.
Restore `routine` only after coherent final readback and canaries.

Provider readback uses a dedicated user-scoped token with the provider's
Workers Builds Configuration Edit and Workers Scripts Read permissions (the
review contract calls the first capability `Workers CI Write`). Put the token
and account ID in separate absolute, owner-only regular files; do not export
either value directly. Point the command at a new absolute output directory,
which the command creates as mode `0700` and fills with mode-`0600` raw
provider responses:

Immediately before every credentialed provisioning command, capture the exact
current `main` ref through authenticated `gh api` outside the sandbox. Keep the
raw response embedded in a new owner-only proof and never substitute a browser,
anonymous HTTP request, or operator-authored SHA:

```sh
umask 077
proof_tmp="$(mktemp /secure/path/current-main-proof.XXXXXX)"
raw_tmp="$(mktemp /secure/path/current-main-ref.XXXXXX)"
gh api --hostname github.com \
  repos/atrinik/metaserver-worker/git/ref/heads/main >"${raw_tmp}"
jq --arg capturedAt "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" \
  '{source:"authenticated-gh-api-current-main-readback",
    repository:{owner:"atrinik",name:"metaserver-worker"},
    endpoint:"repos/atrinik/metaserver-worker/git/ref/heads/main",
    ref:.ref,sha:.object.sha,capturedAt:$capturedAt,raw:.}' \
  "${raw_tmp}" >"${proof_tmp}"
chmod 0600 "${proof_tmp}"
mv "${proof_tmp}" /secure/path/current-main-proof.json
```

Delete the temporary raw file after the owner-only proof is safely retained.
The proof is valid for at most five minutes and must be regenerated after any
`main` movement or retry outside that window.

```sh
ATRINIK_CLOUDFLARE_ACCOUNT_ID_FILE=/secure/path/account-id \
ATRINIK_WORKERS_BUILDS_API_TOKEN_FILE=/secure/path/builds-read-token \
ATRINIK_PRODUCTION_BUILD_TOKEN_SECRET_FILE=/secure/path/production-build-token \
ATRINIK_GITHUB_CURRENT_MAIN_PROOF_FILE=/secure/path/current-main-proof.json \
ATRINIK_REVIEWED_SOURCE_SHA_FILE=/secure/path/reviewed-source-sha \
ATRINIK_PROVIDER_SNAPSHOT_OUTPUT=/secure/new/provider-snapshot \
  npm run provision:workers-builds:readback
```

Every credentialed readback/verification command derives `HEAD` from the local
checkout, requires an empty tracked and untracked worktree, compares it to the
owner-only reviewed-SHA file, and validates the fresh authenticated `gh api`
proof before reading any provider input or making any provider request. The
local `HEAD`, reviewed SHA, top-level proof SHA, and embedded raw GitHub ref SHA
must all be the same lowercase 40-hex value. A missing, stale, future,
malformed, linked, over-permissive, wrong-repository, wrong-ref, mismatched, or
anonymous proof fails before provider work.

The readback covers the exact production and inert-review scripts, version and
active-deployment and active-version/export inventories, script settings,
schedules, alternate-URL state, Builds triggers across every account Worker,
active-build inventory and their environment classifications, Deploy Hooks,
Custom Domains, build-token inventory, account build
limits, and the ordered production D1 migration ledger. Every paginated
security inventory is read in two bounded complete passes and stored as a
canonical exhaustive snapshot; incomplete, changing, reordered, replaced, or
duplicated pages fail closed. Settings, URL state, schedules, routes, script
settings, deployments, active-version resources, trigger environments, build
limits, and the D1 ledger are likewise read twice; deployments are reread after
the active version so a mid-read activation fails closed. A fresh manifest binds the snapshot to the exact
account, reviewed source SHA, and checked-in production/review contract digests.
Cloudflare may omit `result_info` from a per-Worker trigger-list response even
when that response contains triggers. Only that endpoint accepts the exact
successful four-field provider envelope without pagination metadata, only on
the requested first page, and only for zero, one, or the documented maximum of
two trigger rows. It is normalized as one exhaustive page and still must match
across both complete passes and the final sweep. Nonempty metadata-free build,
build-token, Deploy Hook, domain, Worker Version, and account-wide inventories
remain invalid.
Before setup, prove the fresh no-trigger/no-Deploy-Hook/no-active-build boundary:

```sh
ATRINIK_PROVIDER_SNAPSHOT_DIRECTORY=/secure/provider-snapshot \
ATRINIK_CLOUDFLARE_ACCOUNT_ID_FILE=/secure/path/account-id \
ATRINIK_GITHUB_CURRENT_MAIN_PROOF_FILE=/secure/path/current-main-proof.json \
ATRINIK_REVIEWED_SOURCE_SHA_FILE=/secure/path/reviewed-source-sha \
ATRINIK_PRODUCTION_STAGING_SENTINEL_BRANCH_FILE=/secure/path/private-random-production-sentinel \
ATRINIK_PRODUCTION_STAGING_SENTINEL_REFS_FILE=/secure/path/fresh-production-sentinel-proof.json \
ATRINIK_REPOSITORY_CONNECTION_OWNER_PROOF_FILE=/secure/path/connection-owner-proof.json \
  npm run provision:workers-builds:verify-preflight
```

The fresh preflight requires exactly the three existing production Workers,
proves the retired `atrinik-metaserver-review-check` Worker is absent, and
requires no Builds trigger; it never creates or adopts a review Worker. A journal-bound
partial setup uses exact recovery readback instead of the fresh verifier. The
readback never accepts an absent production Worker. The sentinel proof
contains the exact repository object, its private selector, an empty `refs`
array, and an RFC 3339 `capturedAt` no more than five minutes old. It is
produced from the exact
`gh api repos/atrinik/metaserver-worker/git/matching-refs/heads/<selector>`
result outside the sandbox. Readback performs
only bounded, timed provider
reads (including the read-only D1 ledger query) and emits
only a bounded summary; raw identifiers and provider responses remain in the
private directory. Private inputs and snapshot files are opened without
following symbolic links and must remain owner-only regular files.
Because the provider has no repository-connection read endpoint, preflight
also requires a no-more-than-five-minute owner-UI proof that the exact account and
repository connection pre-existed and that the website remains connected. The
proof uses source `cloudflare-owner-ui-readback`, the exact repository object,
`connectionPreexisting: true`, and `websitePreserved: true`. It also pins App
85455, installation 152311798, selected-repository mode, the exact website and
metaserver repository IDs, the governed
`atrinik/metaserver-worker#66-private-provider-evidence` coordinate, and fresh
read-only proof that the exact source SHA
is still protected PR-only `main` with deletion and force-push disabled. It
contains no credential or connection UUID. Rollback always retains that connection.

Materialize the three desired production documents from that same snapshot.
This substitutes only the read-back account, D1, cache-zone, R2, Analytics,
rate-namespace, and Service Binding coordinates into the reviewed sources;
the checked-in desired circuits and all authored policy remain authoritative.
For the one initial setup, the production contract also pins the exact
predecessor state: while every Builds trigger, reserved
build token, Deploy Hook, and active build are absent, the core may lack only
the reviewed `CLASSIC_DIRECTORY_CUTOVER_MODE` plain-text binding and the six
core/caller circuit bindings may retain only their exact live `enabled`
predecessor values. The materializer still writes the reviewed
`v4-production` and disabled-circuit values into the desired protected
documents. No other missing, extra, or changed binding is accepted,
and this predecessor path is not used by staged, configured, or routine
delivery validation. The settings readback may materialize Cloudflare's
documented top-level observability sampling default as exactly `1`; no other
top-level value or observability drift is accepted.
It requires exact secret names, compatibility settings, schedules,
observability destinations, Custom Domains, and disabled `workers.dev` and
preview URLs, then runs the production topology validator and enforces the
provider's 5 KiB limit:

```sh
ATRINIK_CLOUDFLARE_ACCOUNT_ID_FILE=/secure/path/account-id \
ATRINIK_GITHUB_CURRENT_MAIN_PROOF_FILE=/secure/path/current-main-proof.json \
ATRINIK_REVIEWED_SOURCE_SHA_FILE=/secure/path/reviewed-source-sha \
ATRINIK_PROVIDER_SNAPSHOT_DIRECTORY=/secure/provider-snapshot \
ATRINIK_PRODUCTION_CONFIG_OUTPUT=/secure/new/production-configs \
  npm run provision:workers-builds:materialize-production
```

The output files are `core.json`, `publisher.json`, and `rendezvous.json`.
Materialization also requires one unambiguous active version per production
Worker, exact reviewed exports/runtime, and a live migration ledger that is an
exact checked-in prefix with at most the separately gated `0010` pending.
Review their digests in the owner-only provider record, never their contents in
GitHub or logs. No provisioning command in this section creates a connection,
Worker, token, trigger, variable, build, or deployment. Those mutations remain
behind the explicit setup authorization; migration `0010` and the first
automatic production proof are later, separately authorized gates.

After creating the inert production trigger and its protected environment while
leaving the review trigger absent, take a new snapshot and prove the staged
boundary before authorizing review activation:

```sh
ATRINIK_PROVIDER_SNAPSHOT_DIRECTORY=/secure/staged-provider-snapshot \
ATRINIK_CLOUDFLARE_ACCOUNT_ID_FILE=/secure/path/account-id \
ATRINIK_GITHUB_CURRENT_MAIN_PROOF_FILE=/secure/path/current-main-proof.json \
ATRINIK_REVIEWED_SOURCE_SHA_FILE=/secure/path/reviewed-source-sha \
ATRINIK_PRODUCTION_STAGING_SENTINEL_BRANCH_FILE=/secure/path/private-random-production-sentinel \
ATRINIK_PRODUCTION_STAGING_SENTINEL_REFS_FILE=/secure/path/fresh-production-sentinel-proof.json \
ATRINIK_PRODUCTION_BUILD_TOKEN_PERMISSION_PROOF_FILE=/secure/path/production-token-policy.json \
ATRINIK_REVIEW_BUILD_TOKEN_PERMISSION_PROOF_FILE=/secure/path/review-token-policy.json \
ATRINIK_WORKERS_BUILDS_USAGE_PROOF_FILE=/secure/path/build-usage.json \
ATRINIK_STAGED_PROOF_OUTPUT_FILE=/secure/private/staged-proof.json \
  npm run provision:workers-builds:verify-staged
```

This requires exactly one production trigger selecting the fresh private
sentinel with the zero-resource review token, the exact protected production
environment, no review trigger or review environment, all builds stopped, and
current token/usage proofs.
The command writes a new owner-only proof containing a deterministic SHA-256 of
the fresh manifest, including its exact `startedAt` and `completedAt`, and exact
staged trigger/environment/token/
hook/build evidence. Immediately before each activation mutation, set
`ATRINIK_STAGED_PROOF_FILE` to that record and run
`npm run provision:workers-builds:verify-staged-proof` immediately before the
review activation, with the read token,
production D1-read token, and a new `ATRINIK_PROVIDER_SNAPSHOT_OUTPUT`
directory. It performs two new complete provider sweeps, requires the original
proof to be no more than five minutes old and the live sweep no more than 30
seconds old, and
rejects any coordinate or digest mismatch. The setup plan makes the original
command produce this private staged-proof digest.

Immediately after that successful revalidation and before any review-trigger
mutation, mint the bounded review-phase authority:

```sh
ATRINIK_PROVIDER_SNAPSHOT_DIRECTORY=/secure/fresh-staged-proof-snapshot \
ATRINIK_STAGED_PROOF_FILE=/secure/private/staged-proof.json \
ATRINIK_REPOSITORY_CONNECTION_OWNER_PROOF_FILE=/secure/path/fresh-owner-proof.json \
ATRINIK_PRODUCTION_STAGING_SENTINEL_BRANCH_FILE=/secure/path/private-random-production-sentinel \
ATRINIK_PRODUCTION_STAGING_SENTINEL_REFS_FILE=/secure/path/fresh-production-sentinel-proof.json \
ATRINIK_PRODUCTION_BUILD_TOKEN_PERMISSION_PROOF_FILE=/secure/path/production-token-policy.json \
ATRINIK_REVIEW_BUILD_TOKEN_PERMISSION_PROOF_FILE=/secure/path/review-token-policy.json \
ATRINIK_WORKERS_BUILDS_USAGE_PROOF_FILE=/secure/path/build-usage.json \
ATRINIK_REVIEW_ACTIVATION_AUTHORITY_PROOF_OUTPUT_FILE=/secure/private/review-activation-authority.json \
  npm run provision:workers-builds:verify-review-activation-authority
```

Also supply the account, exact-current-source, and freshly authenticated
current-main proof used by every credentialed provisioning command. The five
owner/provider observations must each still satisfy their five-minute source
validator when this command runs; changing only `capturedAt` is not evidence.
The resulting owner-only proof binds their complete digests, the freshly
revalidated staged proof's capture and snapshot start/completion times, App
85455 selected repository inventory and website preservation, sentinel, both
token IDs and `modifiedOn` values, usage thresholds, staged digest, source/contracts, setup
plan, phase, issue time, and exact expiry. It is valid only for the
`review-trigger-activation-and-proof` phase, expires exactly 30 minutes after
issue, and every following credentialed review transition must start with at
least five minutes remaining. Authenticated current-main evidence is not
extended by this phase proof: capture it anew immediately before every command.

Set `ATRINIK_REVIEW_ACTIVATION_AUTHORITY_PROOF_FILE` to that record and retain
the exact five source-proof files for every remaining review-phase verifier.
Immediately before each review provider mutation, run
`npm run provision:workers-builds:verify-review-activation-authority-proof`
with those inputs and a newly captured current-main proof. The digest-pinned
plan requires that executable check and a minimum 300-second remaining budget;
an expired or cross-phase proof stops before the request. Long-running
credentialed verification commands retain that entry checkpoint: completion
must still precede authority expiry, but does not reimpose the 300-second
start reserve after the bounded provider sweep has already begun.
Only then may the review gate first prove a fresh private random staging
root is absent from every current non-main ref, then POST the provider-classified
preview trigger (`branch_includes=["*"]`, `branch_excludes=["main"]`) with that
absent root, fixed `exit 1` commands, and the zero-resource review token. This
keeps a racing non-main push away from branch-controlled dependency handling.
After PATCHing the exact nonsecret environment, repeat the root-absence proof
immediately before atomically PATCHing the trigger to the reviewed
`/deployment/review-check` root and commands, and then run
`npm run provision:workers-builds:verify-review-activation` against a new private
snapshot. That verifier requires the final review trigger and environment, the
still-inert production trigger, both exact token wrappers, no active build or
Deploy Hook, and writes the owner-only review-activation proof. No private
review sentinel is created or accepted.

The staging root must match
`/review-build-only-staging-<32-lowercase-hex>`. For each of the two checks,
use `gh api` outside the sandbox to retain a complete current
`repos/atrinik/metaserver-worker/git/matching-refs/heads/` inventory and an
HTTP `404` contents lookup for that exact root at every non-`main` ref SHA. The
owner-only JSON proof has the exact fields `source`, `repository`,
`rootDirectory`, `currentMainSha`, `capturedAt`, `pagination`, `branches`, and
`absenceChecks`; each branch is `{ref,sha}` and each non-main absence check is
`{ref,sha,path,status:404}` in the same order. It must include current `main`,
carry terminal GraphQL-style pagination metadata with `hasNextPage:false` and
an exact total count, be no more than five minutes old, and contain no missing,
extra, duplicate, or reordered branch checks. Validate the separately captured create and activation
proofs with:

```sh
ATRINIK_GITHUB_CURRENT_MAIN_PROOF_FILE=/secure/path/current-main-proof.json \
ATRINIK_REVIEWED_SOURCE_SHA_FILE=/secure/path/reviewed-source-sha \
ATRINIK_REVIEW_STAGING_ROOT_DIRECTORY_FILE=/secure/path/private-review-root \
ATRINIK_REVIEW_STAGING_ROOT_CREATE_PROOF_FILE=/secure/path/create-root-proof.json \
ATRINIK_REVIEW_ACTIVATION_AUTHORITY_PROOF_FILE=/secure/private/review-activation-authority.json \
  npm run provision:workers-builds:verify-review-staging-root-create

ATRINIK_GITHUB_CURRENT_MAIN_PROOF_FILE=/secure/path/current-main-proof.json \
ATRINIK_REVIEWED_SOURCE_SHA_FILE=/secure/path/reviewed-source-sha \
ATRINIK_REVIEW_STAGING_ROOT_DIRECTORY_FILE=/secure/path/private-review-root \
ATRINIK_REVIEW_STAGING_ROOT_ACTIVATION_PROOF_FILE=/secure/path/activation-root-proof.json \
ATRINIK_REVIEW_ACTIVATION_AUTHORITY_PROOF_FILE=/secure/private/review-activation-authority.json \
  npm run provision:workers-builds:verify-review-staging-root-activation
```

After the environment PATCH, two complete identical trigger/environment reads
plus a final identical sweep must prove the created trigger still has the
private root and inert commands and that `SKIP_DEPENDENCY_INSTALL=1` is present
and nonsecret. The final trigger PATCH consumes both that readback digest and
the second fresh root-absence digest; either missing or ambiguous proof stops
before activation.

```sh
ATRINIK_PROVIDER_SNAPSHOT_OUTPUT=/secure/review-staged-provider-snapshot \
ATRINIK_PRODUCTION_STAGED_TRIGGER_UUID_FILE=/secure/private/production-trigger-uuid \
ATRINIK_REVIEW_STAGED_TRIGGER_UUID_FILE=/secure/private/review-trigger-uuid \
ATRINIK_REVIEW_STAGED_ENVIRONMENT_PROOF_OUTPUT_FILE=/secure/private/review-staged-environment-proof.json \
ATRINIK_REVIEW_ACTIVATION_AUTHORITY_PROOF_FILE=/secure/private/review-activation-authority.json \
  npm run provision:workers-builds:verify-review-staged-environment
```

Use the same account, exact-current-source, provider read token, production D1
read token, token-policy proofs, private staging-root inputs, and journaled
production/review trigger UUID files as the adjacent staged commands. The
verifier binds both journaled trigger identities, proves the production peer is
still exactly inert, and rejects any active build, Deploy Hook, caller trigger,
or competing repository trigger. It writes the full account-bound proof only
to the owner-only output file and prints a safe source/digest summary.

Run that review-phase readback with the same account, reviewed-source, provider
read token, token-policy proofs, and usage proof used by the staged verifier,
plus a new output directory and proof destination:

```sh
ATRINIK_PROVIDER_SNAPSHOT_OUTPUT=/secure/review-active-provider-snapshot \
ATRINIK_REVIEW_ACTIVATION_PROOF_OUTPUT_FILE=/secure/private/review-activation-proof.json \
ATRINIK_REVIEW_ACTIVATION_AUTHORITY_PROOF_FILE=/secure/private/review-activation-authority.json \
  npm run provision:workers-builds:verify-review-activation
```

This command is read-only. Creating the preview trigger and writing its
nonsecret environment remain separately authorized provider mutations; the
command neither creates them nor starts a build.

### Rotate the zero-resource review build token

The `review-token-rotation` gate is separate from review activation and from
the disposable build proof. Use it only after a checksum-valid terminal
`review-trigger-active` journal. The replacement underlying user token must be
new, user-owned, and zero-resource: `User Details:Read` only, with no account or
zone permission or resource. Capture its exact token ID, `modifiedOn`, owner
user ID, and a separate current `accepted` account-membership observation no
more than five minutes before authority issuance. The token modification time
must postdate the terminal review-activation journal.
Keep the predecessor review token proof as immutable provenance.

First take a new exhaustive review-active snapshot and issue the owner-only
30-minute rotation authority. Supply the same account, current-main,
repository-owner, production-sentinel, usage, inert-setup, activation-journal,
activation-proof, and predecessor token evidence required by the adjacent
review verifiers, plus these rotation inputs:

```sh
ATRINIK_PROVIDER_SNAPSHOT_DIRECTORY=/secure/fresh-pre-rotation-snapshot \
ATRINIK_REPLACEMENT_REVIEW_BUILD_TOKEN_ID_FILE=/secure/private/replacement-token-id \
ATRINIK_REPLACEMENT_REVIEW_BUILD_TOKEN_PERMISSION_PROOF_FILE=/secure/private/replacement-token-policy.json \
ATRINIK_REPLACEMENT_REVIEW_TOKEN_OWNER_MEMBERSHIP_PROOF_FILE=/secure/private/replacement-token-membership.json \
ATRINIK_REVIEW_TOKEN_ROTATION_PREDECESSOR_PROOF_OUTPUT_FILE=/secure/private/rotation-predecessor-proof.json \
ATRINIK_REVIEW_TOKEN_ROTATION_PRODUCTION_BASELINE_PROOF_OUTPUT_FILE=/secure/private/rotation-production-baseline-proof.json \
ATRINIK_REVIEW_TOKEN_ROTATION_AUTHORITY_PROOF_OUTPUT_FILE=/secure/private/rotation-authority.json \
  npm run provision:workers-builds:verify-review-token-rotation-authority
```

Every mutation must immediately follow
`npm run provision:workers-builds:verify-review-token-rotation-authority-proof`
with at least five minutes remaining and a fresh authenticated current-main
proof. Journal intent, response classification, returned UUID, stable readback,
and binding before continuing. Perform exactly this sequence:

1. POST one wrapper named `Atrinik metaserver review check rotation 96` using
   the replacement token secret and ID. Explicit failure is non-owned;
   ambiguous creation is reconciled only by the exact name, token ID, and full
   wrapper shape.
2. PATCH only the journaled inert production trigger's `build_token_uuid` to
   the replacement wrapper. Every other trigger field must remain byte-value
   equivalent. Prove this intermediate state with
   `npm run provision:workers-builds:verify-review-token-rotation-intermediate`.
3. PATCH only the journaled final review trigger's `build_token_uuid` to the
   same replacement wrapper. Prove both exact triggers reference it and the
   predecessor wrapper is unreferenced with
   `npm run provision:workers-builds:verify-review-token-rotation-unreferenced`.
4. DELETE only the exact predecessor wrapper UUID, then take a new exhaustive
   snapshot and run
   `npm run provision:workers-builds:verify-review-token-rotation-complete`.

The three readback commands require `ATRINIK_PROVIDER_SNAPSHOT_OUTPUT`, the
rotation authority, its independently written
`ATRINIK_REVIEW_TOKEN_ROTATION_PRODUCTION_BASELINE_PROOF_FILE`, all evidence
used to issue it, the exact production and review trigger UUIDs bound by that
authority, and
`ATRINIK_REPLACEMENT_REVIEW_BUILD_TOKEN_UUID_FILE`. Write each proof to its
corresponding `ATRINIK_REVIEW_TOKEN_ROTATION_*_PROOF_OUTPUT_FILE`. Every phase
must reproduce the authority-bound full non-token production-state digest,
including scripts, settings, bindings, routes, domains, schedules, versions,
deployments, active versions, Deploy Hooks, and migration state; only documented
D1 query timing metadata is excluded. The intermediate and unreferenced proofs,
terminal proof, and fully framed checksum-valid journal become
`ATRINIK_REVIEW_TOKEN_ROTATION_INTERMEDIATE_PROOF_FILE`,
`ATRINIK_REVIEW_TOKEN_ROTATION_UNREFERENCED_PROOF_FILE`,
`ATRINIK_REVIEW_TOKEN_ROTATION_COMPLETE_PROOF_FILE` and
`ATRINIK_REVIEW_TOKEN_ROTATION_JOURNAL_FILE` for the disposable authority.

Before predecessor deletion, rollback restores only the two journaled token
references to the predecessor wrapper, proves the exact predecessor
review-active state with
`provision:workers-builds:verify-review-token-rotation-rollback-restored`, then
deletes only the unreferenced journal-created replacement wrapper and proves
the terminal predecessor with
`provision:workers-builds:verify-review-token-rotation-rollback-complete`.

The retained #96 incident is a distinct
`production-repointed-review-augmented` phase, not ordinary
`production-repointed` or `review-repointed`. It is accepted only when the
exact 12-record forward prefix, historical authority, authority file,
exhaustive incident snapshot manifest, replacement UUID, production trigger,
wrappers, and unchanged production preservation digest match the pinned
coordinates. The only allowed peer delta is the provider-added production
sentinel in the predecessor-token review trigger's `branch_excludes` array.
Any other trigger, environment, token, build, hook, connection, or production
resource drift blocks recovery. Forward rotation must never resume from this
phase.

Incident rollback restores the inert production trigger first. Immediately
before each incident write, use the incident-only
`provision:workers-builds:verify-review-token-rotation-provider-normalized-authority-proof-historical`
precondition: it authenticates current `main` independently while validating the retained
authority against the immutable incident source, plan, and authority-file digest.
The generic historical-authority command is not an incident write precondition. After the
production restoration's stable exhaustive two-trigger readback, run
`provision:workers-builds:verify-review-token-rotation-provider-peer-normalization`.
That proof accepts exactly one of two results: Cloudflare automatically removed
the peer sentinel exclusion and both triggers are predecessor-exact, or the
review trigger still has only that one augmented exclusion. In the first case,
journal read-only reconciliation and do not PATCH review. In the second case,
PATCH only the exact journaled review trigger to its predecessor body. Then
take a new predecessor-restored proof, prove the journal-created replacement
wrapper globally unreferenced, delete only that wrapper, and bind the terminal
rollback proof. The rollback prefix classifier is nonmutating and covers every
durable boundary, explicit failure, and ambiguous response; blocked terminals
must bind the exact augmented or normalized residual phase and an exhaustive
post-prefix snapshot. Production activation, builds, migration `0010`, and all
Worker resource writes remain forbidden.

The retained incident rollback later completed both trigger restorations but
stopped before its wrapper DELETE because the pre-request guard called the
unsupported account-wide `GET /builds/triggers` route. Its exact 17-record
`rollback-blocked` journal is immutable: the DELETE has a current-main record,
historical-authority check, and intent, but no provider response,
classification, mutation bound, tombstone, or DELETE receipt. The bound
residual snapshot proves exact `predecessor-restored` state with both wrappers
present and the replacement globally unreferenced.

Retire that wrapper only through the separate #104
`blocked-review-token-delete-recovery` authority. Issuance pins the exact
executor, rollback journal and terminal, residual proof and exhaustive
snapshot, and failed guard response. It then captures a new full provider
snapshot using the supported stable scripts inventory plus every script's
paginated `/builds/workers/{script_tag}/triggers` inventory and a final scripts
stability check. The fresh proof must reproduce exact predecessor triggers,
both wrappers, global replacement unreference, unchanged production resources,
and no active build or Deploy Hook. The bounded authority binds both the state
digest and complete fresh proof document, plus one canonical owner-only empty
journal and exclusive authorization-receipt path; rewriting timestamps or
choosing another receipt cannot renew it. It permits only DELETE of the exact
journal-created replacement UUID. A separate journal binds fresh current-main,
the exclusive receipt, authority, and unreference proof before one DELETE attempt;
after intent, ambiguity is reconciled by exact absence and never retried.
Explicit failure or drift terminal-blocks with a fresh exhaustive residual whose
manifest starts after the last nonterminal journal event. Complete and blocked
terminals use exact schemas, explicitly attest that no forbidden write occurred,
and must be checked with the dedicated blocked-delete terminal verifier before
handoff or inert rerun.
No trigger POST/PATCH, production activation, migration, build, or Worker
resource mutation is part of this successor.

Once predecessor absence is durably reconciled, rollback
must roll forward: never recreate it; prove the terminal replacement state.
If the DELETE took effect but its ordinary tombstone or terminal proof was not
durable before the write authority expired, use the read-only
`provision:workers-builds:verify-review-token-rotation-complete-historical`
command. The recovery journal must retain the original pre-expiry authorized
DELETE intent, bind a fresh exhaustive complete-state proof, and record a
distinct historical-authority absence tombstone and recovered terminal. It must
never backdate the ordinary tombstone, retry DELETE, recreate either wrapper,
or mutate a trigger or any other provider resource. The ordinary and recovered
terminal proofs are the two explicit alternatives for the later disposable
authority; a rollback-blocked predecessor proof is never such an alternative.
If the first create operation has only a journaled authorization prefix and no
mutation intent when that prefix expires, derive the unresolved replacement
coordinate from the authority digest, take a fresh exhaustive predecessor
snapshot, and terminalize a separate rollback-blocked journal with both
journaled triggers on the predecessor wrapper, that wrapper present, the
replacement absent, and no active mutation. This terminal is read-only and
cannot be used as successful rotation or disposable-proof evidence.
Every intent digest is computed from the exact method, path, and authority-bound
request body. Explicit success binds its returned identity; only a journaled
ambiguous response may reconcile by exact stable readback, and deletions require
an exact-absence tombstone. Crashes resume from those classifications and
tombstones and never adopt or delete a foreign wrapper. Each forward or rollback
mutation is preceded by a journal-bound fresh authenticated current-main proof;
rollback revalidates the historical authority without reusing its expired write
budget. A checksum-valid rollback journal must end in either exact predecessor
restoration or an exact residual-state record naming both live token references,
wrapper-presence flags, and the exact pending authorized mutation. A blocked
terminal also binds a fresh exhaustive residual snapshot proof, its file digest,
the unchanged production-preservation digest, and the semantic history of every
rollback mutation already attempted. Successful rollback binds every exact
readback digest and requires its final predecessor proof to postdate the last
rollback mutation. The old wrapper must be unreferenced across the complete
account trigger inventory, not merely this repository. The replacement owner's
accepted-membership artifact remains part of terminal and disposable handoff
evidence and is revalidated at the original rotation-authority observation time.
Before disposable-proof authority is issued, capture a distinct membership
observation after the rotation terminal and no later than the new review-active
snapshot; replaying the issuance-time membership artifact fails closed.
Production activation, migration
`0010`, manual/API builds, the initial production build, and all Worker,
version, deployment, binding, route, domain, schedule, URL, state, secret, and
repository-connection mutations remain forbidden.

The 30-minute activation authority ends with that transition and must not be
replayed for the potentially 20-minute disposable build. Immediately before
the disposable push, capture a new complete review-active provider snapshot
and fresh owner, sentinel, token-policy, usage, and authenticated current-main
evidence. Mint the distinct 60-minute proof-phase authority:

```sh
ATRINIK_PROVIDER_SNAPSHOT_DIRECTORY=/secure/fresh-review-active-snapshot \
ATRINIK_REVIEW_ACTIVATION_PROOF_FILE=/secure/private/review-activation-proof.json \
ATRINIK_REVIEW_ACTIVATION_JOURNAL_FILE=/secure/private/review-activation-journal.jsonl \
ATRINIK_INERT_SETUP_JOURNAL_FILE=/secure/private/inert-setup-journal.jsonl \
ATRINIK_INERT_SETUP_RESULTS_FILE=/secure/private/inert-setup-results.json \
ATRINIK_REVIEW_TOKEN_ROTATION_COMPLETE_PROOF_FILE=/secure/private/rotation-complete-proof.json \
ATRINIK_REVIEW_TOKEN_ROTATION_JOURNAL_FILE=/secure/private/rotation-journal.jsonl \
ATRINIK_REVIEW_TOKEN_ROTATION_AUTHORITY_PROOF_FILE=/secure/private/rotation-authority.json \
ATRINIK_REPLACEMENT_REVIEW_TOKEN_OWNER_MEMBERSHIP_PROOF_FILE=/secure/private/rotation-membership-at-issuance.json \
ATRINIK_CURRENT_REPLACEMENT_REVIEW_TOKEN_OWNER_MEMBERSHIP_PROOF_FILE=/secure/private/current-replacement-membership.json \
ATRINIK_DISPOSABLE_REVIEW_COORDINATE_FILE=/secure/private/disposable-coordinate.json \
ATRINIK_CURRENT_REVIEW_ACTIVE_PROOF_OUTPUT_FILE=/secure/private/current-review-active-proof.json \
ATRINIK_DISPOSABLE_REVIEW_AUTHORITY_PROOF_OUTPUT_FILE=/secure/private/disposable-review-authority.json \
  npm run provision:workers-builds:verify-disposable-review-authority
```

Supply the same account/source and freshly observed owner, replacement-token
owner membership, sentinel, token,
usage, and current-main inputs required by the activation verifier. The command
revalidates the exact two-trigger state: production remains inert on the
replacement zero-resource token, review is final, both environments and wrappers are
exact, and no competing trigger, active build, or Deploy Hook exists. It binds
that current observation to both the terminal review-activation and terminal
review-token-rotation proofs and permits
only one exact `review/issue-66-*` push, exact-SHA deletion, and cancellation
of the journal-owned automatic review build during cleanup. Before either Git
write, the issuer directly inspects the owner-only detached repository and
cryptographically binds the commit parent/tree/blob, sole proof-file delta,
content, mode, author/subject, executor bytes, initially empty journal identity,
and canonical push/delete receipt paths. Before either Git
write, use `ATRINIK_DISPOSABLE_REVIEW_AUTHORITY_PROOF_FILE` and its exact source
evidence. Immediately before the push, run
`npm run provision:workers-builds:verify-disposable-review-authority-push`
with a new owner-only
`ATRINIK_DISPOSABLE_REVIEW_PUSH_AUTHORIZATION_RECEIPT_OUTPUT_FILE`; the
60-minute authority must still have at least 40 minutes remaining so the
bounded 20-minute automatic build, evidence, provider preservation proof, and
command overhead cannot consume the deletion reserve. The exclusive receipt
makes that exact authority/journal/branch/commit push authorization one-use.
Immediately before the exact-SHA deletion, run
`npm run provision:workers-builds:verify-disposable-review-authority-proof`;
write a distinct exclusive
`ATRINIK_DISPOSABLE_REVIEW_DELETE_AUTHORIZATION_RECEIPT_OUTPUT_FILE`; that
write requires five minutes remaining and is likewise one-use. The authority binds the exact
journal ID, branch, commit, historical inert-setup/activation journals, and a
fresh current-source two-trigger proof; historical activation source identity
is deliberately distinct from the post-merge verifier source. Production trigger changes,
manual/API build starts, migration `0010`, the initial production build, and
production resource mutations remain forbidden. Cleanup of the exact owned
build is phase-local and must never target a foreign or production build.

After the review trigger is active and its disposable branch proof succeeds,
retain a no-more-than-five-minute owner-only
`ATRINIK_REVIEW_RESULT_PROOF_FILE`. It binds the exact review trigger/token,
terminal successful Cloudflare build UUID, same-repository
`review/issue-66-*` branch and commit, provider-trusted build creation/stop
times and the live provider's automatic `push_event` source, complete embedded
trigger/command snapshot,
and the governed private-evidence coordinate. Capture the raw results of
`gh api repos/atrinik/metaserver-worker/commits/<review-sha>/check-runs`,
`gh api repos/atrinik/metaserver-worker/git/matching-refs/heads/<review-ref>`,
and `gh api repos/atrinik/metaserver-worker/compare/<review-sha>...main` outside
the sandbox after deleting the disposable branch. The proof requires exactly
one completed successful check from App 85455 whose exact SHA and dashboard URL
link the live build UUID, an empty matching-ref result, and a comparison proving
the review commit is neither equal to nor reachable from current `main`.
The verifier corroborates that exact build in the exhaustive live review-build
inventory and the build-only cleanup policy against the unchanged production
version/binding/route/URL/resource readback; empty, failed, cancelled, manual,
API-triggered, stale, wrong-trigger, wrong-branch, wrong-SHA, wrong-App,
duplicate-check, fabricated-link, live-ref, or main-reachable evidence fails
closed. Then run
`npm run provision:workers-builds:verify-production-activation` with a new
snapshot output and `ATRINIK_PRODUCTION_ACTIVATION_PROOF_OUTPUT_FILE`. This
phase-specific live verifier requires the review trigger to have its exact
final non-main configuration while the production trigger still has the private
sentinel and zero-resource token. Only that fresh digest authorizes the separate
production PATCH. Consequently neither activation is reachable when its own
phase proof is skipped, stale, replayed, or based on the other phase. Both
commands print only safe source/digest summaries; the account-bound proof stays
in its owner-only file. The complete setup/activation/rollback document,
including journal-bound trigger/token DELETE paths, stable exhaustive absence
readbacks, actors, result dependencies, and request bodies, is digest-pinned by
the validator, not merely its operation names.

After activation, take another new snapshot and prove the configured boundary:

```sh
ATRINIK_PROVIDER_SNAPSHOT_DIRECTORY=/secure/post-setup-provider-snapshot \
ATRINIK_CLOUDFLARE_ACCOUNT_ID_FILE=/secure/path/account-id \
ATRINIK_GITHUB_CURRENT_MAIN_PROOF_FILE=/secure/path/current-main-proof.json \
ATRINIK_REVIEWED_SOURCE_SHA_FILE=/secure/path/reviewed-source-sha \
ATRINIK_PRODUCTION_BUILD_TOKEN_PERMISSION_PROOF_FILE=/secure/path/production-token-policy.json \
ATRINIK_REVIEW_BUILD_TOKEN_PERMISSION_PROOF_FILE=/secure/path/review-token-policy.json \
ATRINIK_WORKERS_BUILDS_USAGE_PROOF_FILE=/secure/path/build-usage.json \
  npm run provision:workers-builds:verify-configured
```

This requires exactly one production trigger and one isolated preview trigger
on the core project, one shared script tag, distinct build-token/trigger
identities, each selected build token appearing exactly once as a
user-owned provider token, distinct underlying token IDs, exact private
owner-policy readbacks for the production and zero-resource review tokens, one
shared exact GitHub repository connection, exact
commands and branch/watch filters, exact environment names/classifications,
no publisher or rendezvous trigger, and no Deploy Hook on any of the three
production Workers. It also proves review execution created no Worker version,
binding, route, schedule, log consumer, public URL, or active build, and that the account has not
reached its build-minute limit and the private usage proof remains below the
800-minute alert boundary. Provider timestamps are accepted only as metadata; they never relax
the authored values or secret classifications.

Each token-policy proof is captured from the provider no more than five minutes
before ordinary verification, or before issuing the bounded review-phase
authority described above, and binds the exact underlying token ID, its current
`modified_on` value, and its complete user/account/zone policy and resource
arrays, account, and reviewed source SHA. An older proof, a future modification time, or any in-place policy
change fails closed.

## Non-main review delivery

The accepted review design is
[`deployment/workers-builds-review.json`](deployment/workers-builds-review.json)
and its rationale/runbook is
[`docs/review-environment.md`](docs/review-environment.md). The production
project has Cloudflare's provider-native production and preview triggers. The
production trigger selects only `main`; the preview trigger selects every
non-`main` branch and runs only `npm run review:branch` plus the local contract
validator. The preview trigger has its own zero-resource build token and an
exact one-variable nonsecret environment, with no production protected input,
binding, route, branch-created Worker version, or URL. The checked-in
`deployment/review-check/wrangler.jsonc` is a local dry-run validation input,
not a deployed bootstrap Worker. Its
1,000-minute monthly budget alerts at 800 and disables the trigger at the
threshold. Its separate dedicated-nonhuman
user token has `User Details:Read`, no personal
data, and no account/zone permission or resource selector. #66 must prove that zero-resource token works before
enabling the trigger; never substitute the production token. Fork refs do not
exist in the connected repository and receive ordinary GitHub validation only.
Cloudflare emits its native check and PR status comment/history without a
preview URL.

The Builds trigger request uses `/deployment/review-check` as its exact
provider-canonical repository root. The leading slash is part of the reviewed
API representation; the rejected relative form `deployment/review-check` must
never be submitted. Builds runs the conventional `npm run build` and `npm run
validate` commands from that
directory. The private checked-in `deployment/review-check/package.json`
delegates each command to the immutable repository-root scripts with `npm
--prefix ../..`; provider request fields never contain parent-directory shell
traversal. The root `review:build` entrypoint still owns the complete `env -i`,
npm `11.16.0`, `npm ci --ignore-scripts`, and `review:branch` sequence. Keep the
provider-facing build command at or below the contract's conservative 64-byte
ceiling. Retained setup evidence showed both the prior 233-byte inline command
and the later `cd ../..` request representation were rejected with provider
error `12002`; never retry either representation.

The review build identity cannot reach the production trigger's environment or
build token. Cloudflare documents environment variables and build tokens as
trigger fields in this two-trigger topology.
Cloudflare cannot project-scope `Workers CI Write` and supports it only on a
user API token, so the dedicated-nonhuman setup/budget/recovery operator has
explicit production-account Builds control-plane reach, including technical
authority over builds, tokens, environment variables, connections, triggers,
and manual builds. Its operator-secret-store-only credential may mutate only the
exact core preview-trigger ID, must reject the production-trigger ID, and must read the
result back. This administrative tradeoff is not a review-run permission.

Live evidence is a separate operator-supervised exact-commit run against one
serialized cohort in a dedicated account with no GitHub connection or zone. It
must prove an explicitly approved same-repository non-`main` SHA that is not
reachable from `main` and a clean
checkout before loading credentials, acquire the singleton lease, stage disabled circuits, verify the
pre-applied migration ledger, generate fresh ephemeral signing fixtures,
deploy core then callers, read back same-cohort Service Bindings, run bounded
Access-protected canaries, and leave
all circuits disabled. Every Worker, D1/DO namespace, R2 bucket, Analytics
dataset, rate namespace, secret value/epoch, `workers.dev` hostname, the
account-scoped `all_workers` Access application, log destination, and credential is review-only. There is no
review Custom Domain, zone WAF/cache rule, parent-DNS authority, or public
static origin; stable URLs name the mutable cohort, not the commit or a secret.
The exact Access application is `all_workers` with a `non_identity` policy that
includes only the run's 60-minute service-token ID. The separately authorized
token operator creates it after lease acquisition and revokes it after closed
readback; full teardown keeps Access attached until every Worker and the
account `workers.dev` subdomain are gone. All three materialized role configs
switch their own circuits together. Lease acquire/renew/reclaim uses exactly
1,800 seconds, with a five-second proof-age ceiling, 120-second provider
operation timeout, and 300-second recovery reserve. Replay validity ends at 24
hours, but alarm-based physical pruning is best effort; retained DO state is
recorded and both exact namespaces are force-deleted and read absent by the
mandatory 90-day cohort teardown.

Irreversible teardown first atomically enters `quiescing`, blocking new
acquire/renew/enable/reclaim and all external forward proofs while preserving
owner closure/release. Cleanup never releases an unexpired row: wait the
425-second proof/operation/recovery horizon, close/read back circuits, accept a
cooperative owner release, or wait for expiry plus the exact disabled-state and
60-second drain proofs before a cleanup-only exact UUID/generation CAS marks
the abandoned coordination row disabled and performs the expired release. Only
then may an empty run table transition to terminal `teardown`. Keep the coordination D1
fence through Worker/namespace absence, `workers.dev` disablement, and Access
deletion; delete the coordination D1 last.

This design does not authorize live-canary provisioning. Until a maintainer
separately authorizes and validates the exact live provider resources,
`npm run deploy:review-canary` fails
closed. Local manual escape is limited to `npm ci --ignore-scripts`,
`npm run check`, and `npm run review:dry-run` without Cloudflare credentials.
It does not prove live behavior. A provider outage or build failure never falls
through to the production command or blocks unrelated GitHub validation.

### Pauses, retries, outages, and manual escape

A pending/divergent migration, changed control plane, placeholder/missing
input, wrong account, route/binding/secret drift, stale SHA, or failed
validation/upload/readback/canary stops the build. The command never applies a
migration or changes external control-plane state incidentally. Preserve the
safest circuit state and private recovery evidence, perform only the separately
authorized prerequisite from the same revision, verify it, and manually retry
that exact SHA through Workers Builds. The retry must still be current `main`;
never create an empty commit or deploy from a local checkout.

An authorized append-only migration retry is accepted only when the active
annotation's prior horizon hashes to an exact prefix of the new checked-in
ledger and the remote name ledger already equals the new ledger. Rewriting,
reordering, deleting, or inserting into the prior horizon remains divergent.
An interrupted staged cohort is internal recovery state, not external control
drift, so the newest routine build can safely finish it. Failure evidence keeps
the original phase/role and separately records disabled-core recovery as
`not-needed`, `proven`, or `failed`.

After a partial deployment, record the read-back phase/role prefix and the
disabled-core recovery result, then fix forward from exact current `main`;
never roll back across exports or schema. During a
provider outage, repository validation and Semantic Release remain independent
and the Workers Build is retried only after readback is reliable. An emergency
manual escape requires explicit incident authorization and the exact clean
current-main tree, contract, protected inputs, strict order, readback, and
canaries; record why Workers Builds was unavailable and restore it as the sole
routine path.

To disconnect, an organization owner disables the trigger, verifies no build
or upload remains active, revokes the build token and metaserver repository
selection without disturbing the website connection, and retains the last
source/version/digest evidence privately. A disconnected repository has no
automatic production path and fails closed.

## Prepare

Use explicit protected targets for every Wrangler command; the checked-in
resource IDs and disabled values are review fixtures, not production inputs:

```sh
readonly ATRINIK_PROD_CORE_CONFIG=/secure/path/atrinik-metaserver.production.jsonc
readonly ATRINIK_PROD_PUBLISHER_CONFIG=/secure/path/atrinik-publisher.production.jsonc
readonly ATRINIK_PROD_RENDEZVOUS_CONFIG=/secure/path/atrinik-rendezvous.production.jsonc
readonly ATRINIK_PROD_CORE_SECRETS=/secure/path/atrinik-core-secrets.json
readonly ATRINIK_PROD_EDGE_SECRETS=/secure/path/atrinik-edge-source-tags.json
```

Both secret files must be owner-only, ignored, bounded, and reviewed by binding
name without printing values. The core file must supply every currently
required encrypted binding, including the source-tag pair and cache-purge
credential; the edge file supplies only the shared reviewed source-tag pair.
Do not use sequential `secret put` operations or an incomplete file that would
create an unreviewed intermediate version.

1. For a separately authorized exceptional gate, work from the exact clean
   current `main` commit selected by Workers Builds. Record the commit,
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

## Stage Classic v2 and directory protocol 5

This rollout is forward-only. It keeps Classic v1 and directory protocol 4
available while protocol 5 is reviewed, then separates production alias
cutover from the later global v1 receiver retirement.

1. Disable both publisher circuits and schedules. Record a private D1 Time
   Travel bookmark, the applied-migration ledger, schema digest, and aggregate
   counts for both Classic profiles. Apply `0010_classic_access_code.sql` once.
   Require `PRAGMA foreign_key_check` to be empty, all v1 and Game rows to be
   unchanged, and the new Classic lineage/mode tables and v2 constraints to
   match the reviewed migration proof. Do not export row values.
2. Deploy the state-owning core at 100%, then activate only the exact
   prevalidated publisher and rendezvous callers. Read back versions, bindings,
   configuration, and circuits after every activation. Keep
   `CLASSIC_DIRECTORY_CUTOVER_MODE=v4-production`; this makes v1 protocol 4 the
   production root aliases and isolates v2 protocol 5 under `canary-v5/`.
3. Re-enable the v2 publisher path and use released protocol vectors to prove
   positive publication, replay rejection in both version directions, shared
   v1/v2 sequence and nonce history, public/private transition behavior, and
   open/protected rendezvous policy. A protected v2 publication carries only
   `accessCodeRequired`; no access code or v1 password field may reach D1, R2,
   rendezvous state, a response, or a log. Accepting the maximum sequence must
   succeed once; all later lineage requests must return the fixed
   `publish_sequence_exhausted` response without mutation.
4. Validate the isolated protocol-5 aliases with the read-only verifier:

   ```sh
   python3 scripts/static_origin_canary.py \
     --profile classic-v2 \
     --base-url https://classic-v5-directory-canary.example.org \
     --alias-prefix canary-v5 \
     --json
   ```

   Substitute only the exact isolated hostname from the reviewed deployment
   record. Require exact v5
   schema/protocol values, representation checksums, generation agreement,
   expiry, open/protected rendering, private absence, and no password or raw
   access-code material. Record bounded checksums and outcomes only.
5. Obtain explicit human acceptance of the v5 canaries. Then make a separately
   reviewed configuration change to `v5-production`, deploy provider first and
   callers second, and prove root `index.*` now carries v5 while any v4
   reconciliation is isolated under `precutover-v4/`. This gate is not driven
   by time, traffic, or a successful publish and must never be switched back.
6. Before global v1 retirement, exclude new v1 admission at the deployment
   barrier and allow already admitted commits and active v1 controls to finish
   normally. Wait strictly longer than the 15-second control/session bound plus
   deployment propagation, and require zero remaining v1 controls. A commit
   admitted before exclusion receives its normal committed response and
   consumes sequence/nonce; a new excluded request receives the fixed 410
   before its body is read and consumes nothing.
7. Generate the one-way retirement transaction with the exact command shown
   below, review the SQL, and apply it once. It atomically publishes the durable
   retired marker, removes v1 presence/listing, advances v1 directory
   revision/outbox when needed, and retains the shared replay/nonce lineage.
   Require all v2 state to remain byte-for-byte unchanged. Reapplying is an
   idempotent no-op; there is no command that reopens v1.

   ```sh
   python3 scripts/admin_sql.py retire-classic-v1 \
     --confirm human-accepted-v5-canaries-and-cutover
   ```

8. Reconcile and verify the v1 tombstone and production v5 aliases. Prove every
   later v1 request receives exact non-consuming `410 profile_retired` before
   body inspection, while v2 publication, listing, and rendezvous continue.
   Retain only the reviewed gate decision, versions, migration/bookmark
   metadata, aggregate counts, checksums, and fixed response outcomes.

Failure before the v5 alias or retirement commit rolls back to the last durable
pre-gate state. Failure after either commit rolls forward with the same mode;
never restore protocol 4 to production, clear lineage state, remove the retired
marker, or deploy schema-incompatible code.

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
     --secrets-file "$ATRINIK_PROD_EDGE_SECRETS" \
     --tag runtime-retirement-bridge \
     --message "stage canonical-only publisher caller"
   npx wrangler versions upload --strict \
     --config "$ATRINIK_PROD_RENDEZVOUS_CONFIG" \
     --secrets-file "$ATRINIK_PROD_EDGE_SECRETS" \
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

Generate canonical identity reset or server-ID denial SQL with
`scripts/admin_sql.py`, review it, and apply it only with explicit authorization.
The identity-scoped commands are `reset-identity`, `deny-add`, and
`deny-remove`; each accepts one exact 64-lowercase-hex server identity
(uppercase operator input is normalized before SQL is emitted). The separate
`retire-classic-v1` command accepts only the fixed human-gate confirmation in
the staged rollout above and has no inverse. Wildcards, addresses, and CIDRs
are rejected.
Do not use administrative SQL to restore retired routes or clear ordinary
rendezvous cooldowns.

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
