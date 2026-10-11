# DEV and PROD delivery policy

Reviewed `main` pushes deploy automatically to persistent DEV through
GitHub Actions in `deploy-development.yml`. PROD accepts only a separately
owner-approved immutable release tag/SHA through the manual `promote-production.yml` GitHub Actions workflow.
This document specifies source policy and acceptance gates; it does not assert
that provider settings, migrations, deployments or environment protections have
been applied.

## Environment ownership

| Surface | Persistent DEV | PROD |
| --- | --- | --- |
| Core Worker | `atrinik-metaserver-development` | `atrinik-metaserver` |
| Publisher Worker | `atrinik-metaserver-development-publisher` | `atrinik-metaserver-publisher` |
| Rendezvous Worker | `atrinik-metaserver-development-rendezvous` | `atrinik-metaserver-rendezvous` |
| Classic static origin | `https://classic.dev.meta.atrinik.org` | reviewed protected PROD origin |
| Game static origin | `https://game.dev.meta.atrinik.org` | reviewed protected PROD origin |
| Publisher origin | `https://publish.dev.meta.atrinik.org` | reviewed protected PROD origin |
| Rendezvous origin | `https://rendezvous.dev.meta.atrinik.org` | reviewed protected PROD origin |
| Routine authority | exact current-main GitHub Actions run | approved exact-tag workflow dispatch |
| State lifetime | persistent; never reset to validate code | persistent; forward-only migration history |

These DEV names identify the existing cohort, not permission to create a
replacement cohort. Fresh provider readback must prove its identity and
bindings. DEV retains the existing `DevelopmentMaintenance` Durable Object
alarm scheduler and its constant object name/state. The Free account already
uses all five cron slots: do not add DEV cron, change PROD cron, replace the
scheduler or upgrade the account plan as part of delivery. Keep DEV and PROD
D1 databases, R2 buckets, Durable Object namespaces,
Analytics Engine datasets, rate-limiting namespace IDs, secrets, circuits,
custom domains and service targets fully disjoint. A shared account or zone is
not permission to share state. The core owns state, schedules, purge and
replay/admission secrets. Each public caller owns only its one named Service
Binding and public circuit configuration; no state binding or signing material.
All three Workers disable `workers.dev` and preview URLs.

Non-main review stays build-only and credential-free, with no upload, binding,
protected configuration or URL. Its separate trigger may remain attached to
the PROD core project but must retain its zero-resource token and independent
nonsecret environment. DEV activation never turns the review trigger into a
live environment. Historical live-review fixture authority remains separate.

## Protect and verify all resource cohorts

Both DEV and PROD execution environments supply protected
`ATRINIK_DELIVERY_RESOURCE_POLICY` and
`ATRINIK_DELIVERY_RESOURCE_READ_TOKEN`. The policy is a canonical private
inventory bounded to 48 KiB. It pins PROD, DEV and any provisioned live-review
cohort with exact binding purposes/resource IDs, stable origins/routes,
configuration and secret **names**. A review cohort is included only when live
resources exist; the credential-free branch-review trigger creates no cohort.
Keep the policy outside public artifacts and logs. The inventory-policy digest
is included in the deployable digest approved for promotion; a changed policy
requires recalculation and owner review of the exact coordinates.

The separate read token needs effective GET-only permissions across the
inventoried cohorts' settings and routes, without deployment or cleanup
permission. Every engine phase and the private directory-reconciliation child
freshly read all cohorts and reject resource/configuration drift. A cached
inventory or target-only readback cannot establish isolation. Keep this token
out of secret-free validation jobs and public-canary processes.

Target publisher/rendezvous Workers must have an empty provider secret
inventory. Pin any unchanged non-target legacy secret names as observed; their
presence does not authorize cleanup in another environment. Required core
secret names must match the policy. Provider APIs cannot read their values, so
successful inventory comparison cannot prove secret-value uniqueness. Disjoint
key generation and assignment remain separate provisioning-receipt proof;
never expose values to compare them. This fence grants no migrations, resource
creation, secret rotation, deletion or extra promotion approval mechanism.

## Retire the previous production writer first

Before publication of the replacement policy, an authorized provider operator
must fence the previous automatic PROD-main trigger and drain its already
queued/running builds and uploads. Fresh exhaustive readback must prove that no
other trigger, Deploy Hook, workflow or credential can continue that automatic
writer. Preserve exact predecessor version IDs and private retirement evidence.
Do not infer quiescence from the trigger's disabled flag alone, a canceled
request, a cached inventory, or the new source contract. Keep the review trigger
and unrelated repository connections intact.

The old v1 production contract, accepted setup/rotation authorities, applied
migration history and incident journals remain historical evidence under their
original coordinates. The historical contract is retained at
`deployment/historical/workers-builds-production-v1.json`; neither those records
nor a former accepted-main authority may activate the new PROD path. Retirement
is a separately authorized provider change. This source patch does not perform
it or prove it has occurred.

Do not add or move a DEV Workers Builds trigger/repository connection. The
retained provider 12002 constraint prevents one connection targeting two
Workers, and the repository-connection API inventory cannot establish a
per-Worker identity. Keep the historical review connection and credential-free
branch trigger in place.

The operator transition interface emits a plan or the next exact API operation:

```sh
node scripts/deployment-environment-transition.mjs --plan /absolute/private-input.json /absolute/new-plan.json
node scripts/deployment-environment-transition.mjs --next /absolute/private-input.json /absolute/new-operation.json
```

Neither command sends a network write. The `--next` input supplies `plan`,
`snapshot`, `journalPath`, and `records`. Keep checksum-framed receipts at
`${journalPath}.N.json` immutable and load them during recovery. Each snapshot
must be no older than 30 seconds, complete and stable across the exhaustive
inventory. Apply only the exact emitted request through the separately approved
Cloudflare transport, then capture fresh readback before continuing. This
transition retires the automatic writer; it grants no legacy runtime/data
cleanup. The production promotion's read-only writer fence consumes
`CLOUDFLARE_ACCOUNT_ID`, `ATRINIK_PRODUCTION_BUILDS_READ_TOKEN`, and
`ATRINIK_PRODUCTION_WRITER_FENCE_POLICY` from protected environment input.

## Prepare persistent DEV

1. Capture fresh bounded private readback for the exact existing DEV cohort:
   bindings, domains, circuits, versions, database migration ledger, namespace
   IDs, schedules, observability and encrypted secret *names*. Compare the
   selected resources with PROD and stop on overlap or unknown identity.
2. Back up persistent DEV state before a separately reviewed migration. Preserve
   certificate identity and replay lineage. Review and apply every needed
   append-only migration explicitly, then prove the remote ordered ledger
   equals the complete selected source ledger. Automatic delivery never applies
   SQL, resets identity, deletes data or repairs ledger divergence.
3. Review legacy public-caller state during the upgrade. Remove obsolete
   `SOURCE_TAG_KEY_*` secrets/key IDs and state bindings from DEV publisher and
   rendezvous only through a separately authorized exact-target operation.
   Verify their absence after the change. Retain required replay/admission
   secrets on core and its strictly greater than 24-hour overlap rules. A
   deployment that stops declaring a secret does not prove its provider removal.
   PROD cleanup belongs only to the separately approved promotion scope.
4. Supply owner-only protected configs through
   `ATRINIK_DEVELOPMENT_CORE_CONFIG`,
   `ATRINIK_DEVELOPMENT_PUBLISHER_CONFIG`, and
   `ATRINIK_DEVELOPMENT_RENDEZVOUS_CONFIG`, plus `CLOUDFLARE_ACCOUNT_ID`
   in the DEV GitHub environment. Use a newly scoped DEV deployment token or
   an explicitly authorized token transfer; never copy PROD secrets into DEV
   or display token values. DEV credentials belong only in the DEV execution
   step, not the secret-free source-validation job.
   Never commit private IDs/configs or print credentials/provider responses.
5. Prepare the concrete source PR first. DEV automatic activation requires the
   owner-approved merge of the new source PR. The checked-in
   `deployment/workers-builds-development.json` retains its historical filename
   but now declares the GitHub Actions provider; it does not authorize a new
   Cloudflare trigger. `deploy-development.yml` runs on protected main pushes,
   validates selected source without credentials, and deploys through a distinct
   DEV execution job with fixed DEV concurrency and `cancel-in-progress: false`.
   Retain pinned Node/npm, lockfile-resolved Wrangler, isolated dependency
   installation and positive child-environment allowlists. Fresh authenticated
   exact-current-main and current-run validation fences protect each live use.

Local credential-free inspection uses `npm run deploy:development:validate`
and `npm run deploy:development:dry-run`. Live `npm run deploy:development`
requires the exact authenticated automatic GitHub Actions main run, clean source
matching its SHA and successful source validation. A stale run stops before
mutation. A local invocation grants no remote access.

## Review and dispatch a PROD promotion

The owner must review and approve the exact immutable stable `vN.N.N` release
tag and SHA before promotion. Stop at that boundary; preparing a tag, artifact,
workflow or pull request does not grant deployment approval. Never merge a PR
or dispatch merely because CI succeeded or a release event arrived.

The `promote-production.yml` workflow accepts only `workflow_dispatch` on the
trusted protected-main controller, with these explicit inputs:

| Input | Required proof |
| --- | --- |
| `tag` | immutable published stable release tag |
| `source_sha` | exact tag target with successful protected main-push check |
| `artifact_digest` | SHA-256 of the resolved selected-source deployable plan |
| `configuration_digest` | SHA-256 of the exact protected three-role configuration |
| `migration_digest` | SHA-256 of the complete selected-source migration ledger |
| `expected_predecessor` | SHA-256 of JSON serialization of `[coreVersionId,publisherVersionId,rendezvousVersionId]` |

Digest inputs are 64 lowercase hexadecimal characters. Record exact private
predecessor version IDs with the approval, without publishing them. Release
provenance must resolve to the exact SHA and successful protected-main source
validation; a mutable tag, prerelease, missing check or substituted artifact
fails closed. Both selected source and trusted controller must be ancestors of
fresh current main, allowing deliberate promotion of an older accepted release.
The selected-source check job receives no production credentials.

Scope credentials to the production GitHub environment and enforce its
protected-branch gate. The owner's explicit dispatch of the reviewed exact
inputs is promotion approval; this policy adds no second human or required
review count. Use one fixed production concurrency group with
`cancel-in-progress: false`. Only the initial run attempt is eligible, within
one hour of run creation; workflow reruns are rejected. Production credentials
enter only the execution step after exact coordinate validation. The successful
initial source-validation job is rechecked through the authenticated API at
each authority fence. Any changed tag, digest, configuration, migration or
predecessor requires new owner review and approval.

`node scripts/production-promotion.mjs --dry-run` performs credential-free
validation of the six input coordinates. It does **not** resolve bundles or
prove the artifact, release, environment controls or live predecessor.
`node scripts/production-promotion.mjs --plan` resolves the selected-source
production plan against the protected three-role configs and produces actual
deployable, configuration and migration digests without remote calls. Keep
those private configs outside the checkout; verify the selected SHA before
using the resulting coordinates. `npm run deploy:production:dry-run` provides
local bundle/configuration checks; it performs no remote mutation. The live `--execute` controller is reserved for
the authenticated, approved workflow, never a local deployment shortcut.

## Ordered deployment and acceptance

Both environments validate exact source/configuration/migration identity,
read back the remote ledger and resolve desired plus disabled bundles before
mutation. If the complete deployable digest is already active, retain the
verified no-upload result; maintenance/reconciliation and canaries still run.
A no-op is not proof that no directory alias or purge was updated.

Stage core, publisher, then rendezvous at 100% with every public circuit
forced disabled. Read back exact version, bindings, domains, schedules,
observability, role and phase after each upload. Prove the disabled cohort is
coherent, restore desired publisher then rendezvous while core stays disabled,
and restore core last. Use strict direct deployments; gradual versions upload
and rollback across exports or schema lifecycle boundaries are unsupported.
Authority and expected predecessor checks must occur at the point of use,
including after awaits; cached preflight evidence cannot authorize a write.

Reconcile the two fixed directory profiles through the private
`DirectoryReconciliation` Service Binding, retaining bounded receipts and purge
completion. Then prove static-origin formats/freshness/conditional behavior and
canonical credential-free publisher/rendezvous envelopes, followed by coherent
final topology and source/authority readback. Report the exact selected SHA,
digests, phase prefix, no-op/deployment result and recovery outcome without
publishing resource IDs or raw evidence. A green build or successful collection
alone is not application acceptance.

## Failure and recovery

A pending/divergent schema, drifted binding/secret/domain, wrong account, stale
source, unmatched predecessor or ambiguous write stops mutation. Preserve
owner-only phase and version evidence. A failed stage/canary must retain or
restore core breakers disabled and separately report whether recovery is
`not-needed`, `proven` or `failed`; inability to prove recovery is a blocker.
Never guess the active phase, repeat an ambiguous upload, reverse an applied
migration or reopen core before coherent readback.

DEV may fix forward from the exact current main after the separately
authorized prerequisite and exact ledger readback. PROD does not reuse an old
run: reconcile its one-use attempt and active phase, then obtain a newly
reviewed attempt bound to the exact release, digests and current predecessor.
Do not automatically substitute current main for the approved release.
During outages preserve the journal, leave the safest circuit state, and
continue unrelated repository validation. Emergency manual production action
requires separate incident authorization and the same exact-source, schema,
phase/readback and canary proofs.

The Lightsail Classic server is an external consumer, not a deployment target
of this repository. Preserve its certificate identity and confirmed human
login behavior while the publisher remains confined pending the directory-v6
compatibility decision. A paused bot or protocol observation is not authority
to restart bots, change live game state, publish compatibility listings or
modify certificates. Retain bounded runtime evidence privately and perform any
follow-up only under its separately granted scope.
