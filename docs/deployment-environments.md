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

GitHub Actions is the sole active PR/source-validation path. Retain the
Cloudflare review connection and incident history inactive. Fresh provider
review readback includes an encrypted Builds secret and a shared user Builds
wrapper whose effective policy is unreadable. It cannot be described as
credential-free or zero-resource. Restoring credential-free review requires
separate authorization and fresh policy proof; DEV activation grants neither.
Historical live-review fixture authority remains separate.

## Protect and verify all resource cohorts

Both DEV and PROD execution environments supply protected
`ATRINIK_DELIVERY_RESOURCE_POLICY` and
`ATRINIK_DELIVERY_RESOURCE_READ_TOKEN`. The policy is a canonical private
inventory bounded to 48 KiB. It pins PROD, DEV and any provisioned live-review
cohort with exact binding purposes/resource IDs, stable origins/routes,
configuration and secret **names**. A review cohort is included only when live
resources exist; the retained inactive branch-review trigger creates no cohort.
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

After live control-plane, annotation, migration and expected-predecessor checks,
only Workers whose observed `last_deployed_from` is exactly `api` use the API
handoff without Wrangler `--strict`. API-created versions may retain valid
delivery annotations. The annotated predecessor exception is limited to callers
in the explicitly approved one-use bootstrap, after the exact predecessor and
configuration checks; annotations must match the caller role. Annotated core
and non-bootstrap predecessors retain strict deployment arguments. Existing
unannotated API handoffs remain unchanged. Other provenance, including Wrangler
and dashboard deployments, retains `--strict`. The handoff grants no retry or
bypass of the existing source, resource, writer and predecessor fences.
During the one-use bootstrap, successful caller secret retirement may create a
new API-provenance version. Admit that caller's subsequent activation to the same
handoff only after retirement completes, the resource transition is confirmed,
and the fresh fence and exact staged readback pass. Both service-environment and
version-resource provenance in the verified retirement snapshot must be exactly
`api`. The fresh staged readback must identify exactly the verified retirement
snapshot's active version UUID; a replacement with identical configuration or
annotations cannot inherit that provenance. Retain that immutable per-caller
proof and check the exact staged version again immediately before its activation,
after the orchestrator fence, then refresh source authority before upload. A
replacement while another caller stages or retires must stop activation. An
unchanged `wrangler` pair restores strict activation even when the
pre-staging predecessor qualified for handoff; missing or inconsistent provenance
stops activation. Failed or unknown retirement never grants this exception; core
and other callers gain no exception from it.

## Retire the previous production writer first

Before publication of the replacement policy, an authorized provider operator
must fence both retained Cloudflare production and review commands and drain
all queued/running Builds, including review. For `retained-inert-builds`, both
exact trigger build and deploy commands must be literal `exit 1`; no repository
code or dependency installation may run. Disable implicit installation through
`SKIP_DEPENDENCY_INSTALL=1` and pin the existing caching/environment settings.
Preserve the valid existing selectors: production includes `main` with no
exclusions; review includes `*` and excludes `main`. Seal exact private trigger,
selector, configuration and environment digests, including a bounded startup
allowlist. Do not broaden a rejected branch-filter patch or alter provider
identity to make it pass.

Apply only the documented two-field commands PATCH:
`{build_command: "exit 1", deploy_command: "exit 1"}` to each exact trigger,
with fresh per-operation readback and the helper's private receipts. Commands
are the fence for manual builds and retries as well as push-triggered builds.
Builds may still enqueue or automatically start and fail immediately; this
policy does not disable branch pushes or guarantee an empty queue. Require all
Builds stopped at every promotion fence, and no additional trigger or active
Build across the six PROD/DEV Workers. Set the protected
`ATRINIK_PRODUCTION_WRITER_FENCE_POLICY` disposition explicitly to
`retained-inert-builds`; never infer the exception from shared wrapper IDs.

The deployment authority may drain known running inert Builds using read-only
checks for at most 60 seconds. Eligibility requires each recorded launch to
match the sealed inert commands, identity and environment; a new or unknown
build, control drift or provider/authentication error stops immediately. This
wait never retries an upload, secret removal or other provider mutation. All
Builds must still be stopped before proceeding. After any wait, repeat the
resource, current source/run, writer and clean-checkout proofs; the final
handoff disables draining, so another build cannot introduce a second wait
between those fresh proofs and a mutation or recovery operation.

Retries use the configuration current when retried, so fresh command/config
readback is part of the fence, not a historical build-start snapshot. See
[Cloudflare build settings](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/#build-settings).
Require exhaustive proof that all Builds and uploads are stopped. A disabled
branch selector, requested cancellation, cached inventory or source contract
alone is insufficient. Preserve exact predecessor versions and private proof.

Seal the bounded protected-input allowlist by name and classification. Retained
PROD secret names are `CLOUDFLARE_ACCOUNT_ID`,
`ATRINIK_PRODUCTION_CORE_CONFIG`, `ATRINIK_PRODUCTION_PUBLISHER_CONFIG`,
`ATRINIK_PRODUCTION_RENDEZVOUS_CONFIG`, `ATRINIK_WORKERS_BUILDS_API_TOKEN`
and optionally
`ATRINIK_PRODUCTION_CONTROL_PLANE_READY`; review may retain only optional
`ATRINIK_WORKERS_BUILDS_API_TOKEN`. Each retained protected entry must read back
as secret-classified with no visible value. `SKIP_DEPENDENCY_INSTALL` is the
nonsecret literal `1` on both triggers. Unknown environment names, including
startup variables, fail closed. Use exact private trigger/environment hashes,
not the names alone, to bind the approved fence.

Unknown retained credentials remain unread and uncalled. This alternative does
not remove authentication, copy credentials, create a new production deploy
path or grant secret deletion. Keep unrelated connections intact. A rejected
PATCH is no transition proof: preserve its private receipt, read back exact
provider state, and stop unsupported retries. Publication requires successful
fresh acceptance of the full command, configuration and stopped-Build fence.

The distinct `credential-free-review` disposition is available only with proven
credential-free review policy and separately authorized restoration. Its former
production trigger still requires literal `exit 1` build/deploy commands and
skipped installation while preserving the valid main selector. Retaining the
main selector never restores automatic PROD deployment. Neither disposition
proves unreadable token scope or authorizes restoring Builds from history.

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
per-Worker identity. Keep the historical review connection and trigger in place, with the retained
inactive fence above.

The operator transition interface emits a plan or the next exact API operation;
use the final commands-only operation without changing the pinned selectors:

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

Release production uses semantic-release's draft mode followed by the trusted
`scripts/release/publish-complete-release.cjs` finalizer. Before publication it
verifies the exact tag/commit, archive plus `SHA256SUMS`, complete upload states,
byte lengths and GitHub asset digests. Missing, partial or mismatched assets
leave the release as a draft. The default inactive publication gate also retains
that verified draft: only repository variable
`ATRINIK_RELEASE_IMMUTABILITY_ACTIVE=enabled` permits final publication. Governance
must first qualify the merged producer/current-main Check, enable immutable
releases for the exact repository, and freshly verify that policy before the
owner activates this variable. The variable does not prove provider policy;
final readback additionally requires `immutable: true` and the locked tag's
exact selected source SHA. A tag race is detected after publication, not
prevented by a GitHub compare-and-swap API. A mismatched immutable release must
never be promoted.

A repository-authorized dispatcher can finalize an existing qualified draft through manual
`finalize-release-draft.yml` with exact `tag`, `source_sha`, `archive_sha256` and
`checksums_sha256` inputs. This trusted current-main controller verifies its own
and the selected source's successful protected-main checks, bounded authenticated
draft inventory (20 records per page, at most 50 pages, each response at most
256 KiB), downloaded asset hashes and checksum binding before using the
same finalizer. Both paths require a terminal short inventory page, reject
repeated identities or ambiguous tags, and never select an early match from an
incomplete inventory. After asset downloads and immediately before publication, it
re-reads current main and its protection, source/controller Check results, and
the original authenticated dispatch run. That run must still be in progress,
on its first attempt, with the exact controller SHA and dispatcher identity.
This uses normal GitHub release authority; it adds no production-owner allowlist
or administration-token requirement. It neither reruns semantic-release nor
executes the draft's code.
A missing/ambiguous draft, source mismatch or failed asset check stops before
publication. An ambiguous publication response requires fresh readback, not an
automatic retry. Existing mutable releases remain historical;
enabling repository immutability applies to future publication and does not
make an old release eligible automatically. Governance activates that policy
only after the reviewed producer is merged and qualified. Release publication
and production promotion remain separate operations.

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

The initial legacy PROD upgrade may use the reviewed one-use
`productionBootstrap` policy extension with schema
`production-core-and-callers-bootstrap-v1`. It binds selected source SHA,
expected predecessor digest, the three predecessor versions and the complete
ordinary-Worker/tag/native-rate inventory. The policy declares
`nativeInventoryScope: "ordinary-workers"` and `dispatchNamespaces: "unassessed"`;
it does not claim account-wide namespace uniqueness or dispatch absence. Keep
actual legacy caller secret names and key-ID variables in the baseline policy;
keep the core access-rate binding absent. The only permitted addition is core
`ACCESS_ROUTE_RATE_LIMITER`, native namespace `1008`, with limit 16 per 60 seconds.
The controller checks the ordinary-Worker inventory for competing use and proves
the disabled predecessor before the first upload. Governed DEV/PROD resource
isolation remains required, and any known namespace conflict blocks the upgrade.
Governed cohorts must retain one 100% active version equal to latest. An unrelated
Worker's latest version may differ from its sole active version only when both
version-specific binding reads and current settings prove identical native-rate
tuples. Recheck latest, active and deployment identities after those reads; any
change, mixed deployment or differing native resource graph stops the census.
This inspects existing versions without changing unrelated Workers.

An interrupted attempt may already have provisioned the exact core rate binding
and staged disabled callers, with either caller retaining the exact obsolete pair
or already having zero secrets.
A separately approved `productionBootstrap.nativeRateAlreadyProvisioned: true`
supports only that observed baseline: exactly one `ACCESS_ROUTE_RATE_LIMITER`
binding at namespace `1008`, limit 16 and period 60, on the production core.
Other Workers, aliases, duplicates, different tuples and missing bindings fail
validation. With the field absent, the original baseline still forbids `1008`;
explicit false or nonboolean values are invalid. The desired configuration retains
the existing single binding without normalizing duplicate input.

Each caller baseline must have either exactly the two legacy signing secrets or,
only under this opt-in, zero secrets. A zero-secret caller must have no key-ID
bindings and every role-specific circuit explicitly disabled. A pair-bearing
caller must have either the original valid distinct key-ID pair or, under this
opt-in, completely absent key IDs with every role-specific circuit disabled
(`PUBLISH_ENABLED` and `GAME_PUBLISH_ENABLED` for publisher, `RENDEZVOUS_ENABLED`
for rendezvous). Partial, malformed or duplicate key-ID bindings fail. The new
policy must record the actual variables, resources and three predecessor versions;
fresh provider observations and each caller's pre-upload version/variable checks
remain mandatory. The flag alone proves no selected-source identity.

This path starts at the baseline phase. It still uploads and verifies the disabled
core before either caller can enter retirement, then stages and proves each caller's
selected module bytes, runtime and controls before removing its secrets. An existing
rate cannot substitute for the core confirmation step or fresh caller staging.
The approved policy fixes each role's disposition before any mutation: a pair
requires one new retirement and two genuine encrypted artifacts (intent and receipt);
an empty baseline requires a dedicated read-only observation and zero retirement
artifacts. Mixed baselines therefore require two artifacts, and two empty callers
require none. The empty role never creates a retirement recorder, calls PATCH,
enters uncertain retirement state, or claims a completed retirement. Its new
Wrangler version must prove both secret projections empty, no key IDs, selected
module bytes, exact stage tag/message and disabled configuration, sole active/latest
version, full peer invariants and fresh fences. A distinct private observation
proof freezes that version and Wrangler provenance. Both paths recheck their exact
UUID immediately before activation. The empty path reports failures with
`callerObservation.mutationState=not-invoked`, never `response-accepted`. Failed
retirements retain their uncertain state and consumed intents; never replay an old
attempt. Obtain fresh topology evidence, a new policy/plan digest and owner approval
of the actual predecessor before a new dispatch. No automatic policy rewrite or
completed-bootstrap shortcut is introduced.

The approved `recovery` policy pins the owner's RSA public SPKI fingerprint and
requests 90-day artifact retention through `retentionDays: 90`. Without another
field it also requires 90 effective days from artifact creation, retaining only
the existing one-second timestamp rounding allowance. GitHub caps public-repository
artifact retention at [90 days](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository#configuring-the-retention-period-for-checks-workflow-runs-commit-statuses-artifacts-and-logs-in-your-repository).
Observed expiry can be anchored to workflow creation, shortening the interval
after artifact creation. An explicitly approved `minimumEffectiveRetentionDays: 89`
in `recovery` permits this case while requiring a full 89 days after artifact
creation, with no rounding shortfall. It still requests 90 days; lower caps fail
the metadata proof. No other explicit minimum is accepted. This opt-in changes
the resource-policy and deployable-plan digests and requires fresh approval;
the controller never changes the protected policy automatically.

Supply only the public recipient in the protected production
variable `ATRINIK_PRODUCTION_RECOVERY_PUBLIC_KEY`; retain the private key locally
and rehearse decryption before live use. After new code is staged disabled, each
pair-bearing caller's consumed intent must be encrypted and its immutable GitHub Actions
artifact finalized and verified before the single guarded operation removes the
two obsolete signing secrets. Verify and retain a separate encrypted receipt and
prove the exact empty secret inventory before activation. No raw private policy
is uploaded. Uncertain intent persistence stops before removal; uncertain removal
or receipt persistence blocks activation and uses new-code disabled-core recovery.
Preserve the artifact provenance and export recoverable records before retention
expires. No manual binding preprovisioning or legacy rollback is part of this
path. After successful transition, retire the bootstrap extension in favor of a
fresh strict observed policy and new approved plan before another promotion.

Owner recovery helpers validate both policy forms. For qualification, pass
`minimumRetentionDays: recovery.minimumEffectiveRetentionDays ?? recovery.retentionDays`
to `downloadRecoveryArtifact`; its default remains 90. For read-only inspection
of an existing, still-live artifact, the owner may explicitly pass
`minimumRetentionDays: 0`. Inspection still verifies the exact run/controller,
artifact identity, archive digest and ciphertext provenance before decryption;
it grants no mutation or intent-retry authority. The retirement writer derives
its minimum solely from the approved policy and cannot use inspection mode.
The closed failure reason `recovery-artifact-effective-retention-rejected`
identifies an insufficient authenticated retention interval without exposing
private artifact metadata. A failed upload/readback still consumes the intent;
never retry it. Observe the current topology and existing attempt evidence before
preparing any newly authorized attempt coordinate.

New caller retirement writes use the v4 contract and exactly one
`PATCH /accounts/{account_id}/workers/scripts/{script_name}/secrets-bulk`
with `Content-Type: application/merge-patch+json`. Its complete body is:

```json
{"secrets":{"SOURCE_TAG_KEY_CURRENT":null,"SOURCE_TAG_KEY_PREVIOUS":null}}
```

[Cloudflare documents null-valued deletion and creation of one new version](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/secrets/methods/bulk_update/).
The new contract supplies no `version_tags`. The independently reviewed isolated
canary observed the exact post-operation annotation object
`{"workers/triggered_by":"secret"}` in both settings and the active version.
The earlier namespaced-key and short-key annotation-preservation experiments
remain negative evidence. Their consumed intents cannot be retried, relabeled or
completed retrospectively under v4.

The fixed controller-owned
`deployment/caller-retirement-provider-qualification.json` uses the new
`atrinik-caller-retirement-provider-qualification-v2` schema. Its reviewed evidence
binds the account hash, bare PATCH contract, actual request/controller/snapshot/result
hashes, independent review and all nine operation measurements. The probe removed
two dummy secrets from an isolated Worker and verified its eventual absence. It
had an empty nonsecret binding inventory; it does not prove preservation of a real
production configuration. Production names are fixed separately in the source
contract. `productionAuthorized: false` and `productionContractSatisfied: false`
remain explicit. Every production operation still requires full module,
configuration, control, peer and source checks. No live authority comes from this
historical capability qualification.

The loader opens only that controller-owned regular file with no symlink
following, bounds it to 16 KiB, rejects duplicate/ambiguous JSON encoding, and
validates the exact contract and account. There is no environment or input-path
override. Only this loader creates the frozen in-process capability; standalone
parsing cannot. A missing, null, old-schema, wrong-account or invalid qualification
blocks plan generation, inventory, artifact setup and staging for any pair-bearing
bootstrap. Ordinary delivery and both-empty bootstraps do not require it. The
retirement operation and transport recheck the capability at the point of use.
The exact file-byte digest participates in the deployable plan and every v4 intent;
a qualification change requires a new approved plan.

V4 rejects any extra body fields, annotations, `version_tags`, accessors, undefined
injections or changed secret names/values. Its request digest includes the explicit
v4 operation identity; a historical v2 request cannot dispatch through the new
transport despite its identical JSON body. The timestamped predecessor and
`selectedIdentity` bind the uploaded UUID, source, deployable/configuration/bundle
digests, controller SHA, run ID and run attempt. The full predecessor must still
carry the approved staged tag/message. The durable encrypted intent is finalized
and independently read back before the single PATCH. No retry or rollback is
provided. Deadline, response bounds and redirect rejection remain unchanged.

Post-write success requires a new sole active/latest version and deployment,
zero secrets in both binding inventories, and the exact closed annotation object
above in both settings and retained `versionAnnotations`. All other settings,
nonsecret bindings, module bytes, runtime configuration, controls, peers and
namespaces must be preserved, subject only to the narrow service metadata
transitions described below. The receipt contains the complete timestamped
`after` snapshot, its time-excluded digest and the full intent. Its encrypted
artifact must also finalize and pass independent readback before the operation
creates a private in-process retirement proof.

Only this proof permits the temporary annotationless retired caller state. It is
bound to this delivery invocation and selected identity. A serialized receipt,
recovery observation, forged object, other role or another run cannot recreate it.
Every later staged-topology and activation read checks the exact retired UUID,
complete own snapshot, selected configuration/module/control and a fresh full
cohort. A separate cohort guard admits only a single recorded, verified upload by
this run, validates its selected source/configuration/module/new UUID, and compares
every unrelated peer and namespace exactly. It admits that full graph immediately
after the authorized readback, before another role can transition. This permits
publisher activation before rendezvous without accepting unrelated peer drift.
The topology identity is explicitly the authenticated predecessor identity;
remote annotations are never invented or inserted into provider data. Core,
ordinary staging, secret-free observation and final active topology keep normal
annotation validation. The final active upload restores the full selected-source
annotations. Changed receipt snapshots or outer handoff UUID/provenance fail
before activation, retaining consumed-operation diagnostics.

Target service modification timestamps may advance only within the observed
predecessor/post-read window. Deployment identifiers must follow the separately
read fresh version/deployment coordinates. Service provenance may change only
from `wrangler` to `api`; the active-version
`resources.script.last_deployed_from` may make that same transition only when
consistent with the service transition. All other settings, resource metadata,
control fields, peers and global namespaces remain exactly preserved, including
unknown fields. A later observation is not proof of an earlier failed exception.

Historical v1 intents retain their original settings endpoint and settings-body
digest only in the read-only observer. They never authorize the v4 bulk-secret
writer and cannot be relabeled as its request. V1 omitted the predecessor capture
time, so the observer validates its historical digest binding and then stops with
`historical intent lacks authenticated observation timestamp`. A caller-supplied
time cannot fill that gap. Owner artifact inspection remains read-only; it cannot
prove the original transition window. Do not invent or backdate that timestamp,
replay an old intent or create a retrospective original receipt. The v2 decoder retains its original exact pair-only body, full endpoint and
timestamped predecessor digest interpretation. It remains read-only; a v2 request
cannot dispatch through the v4 writer. A successful v2 or v3
read-only terminal is separately labeled observational recovery and creates no
original receipt. Both timestamped schemas reject missing or substituted timestamps. V3 observation
requires its original qualification digest but never mints a mutation capability
from that digest. V4 read-only observation validates its original bare request, selected identity and closed annotation-loss post-state, but likewise never creates a runtime proof or original receipt. The pure `verifyCallerRetirementReceiptV4` inspector authenticates retained document relationships against an independently supplied qualification digest; it has no mutation or capability path. The JWE outer
envelope remains v1; the inner document identifies the operation schema without
relabeling or rewriting historical artifacts.

The production controller shares a single GET scheduler across its account API
resource and native-rate inventories, writer fence, native control-plane reads
and six-Worker caller snapshots. Starts are at least 334 milliseconds apart,
without burst credits, regardless of credential. At most 128 outstanding governed
calls are admitted. Queue waits count against the original request signal; no
request deadline is renewed. Both captures and all PROD/DEV peers remain required.
A caller snapshot still expires after 120 seconds, and the final GitHub-only
authority check must leave the current snapshot within its 10-second handoff age.
The 54-request capture fanout leaves about 2.3 seconds for the last response under
its existing 20-second deadline. Slower tails stop before PATCH instead of widening
that deadline. A 3,400-read pacing model takes about 19 minutes before additional
network/build time; the 30-minute workflow and 60-minute authority caps remain.

[Cloudflare documents a cumulative 1,200-request five-minute API limit](https://developers.cloudflare.com/fundamentals/api/reference/limits/).
The controller's budget covers fewer than 900 GET starts in that interval.
Wrangler subprocess traffic, the separate private-reconciliation process and
other clients sharing an identity remain outside this controller's budget.
Private reconciliation shares one local scheduler between its own resource and
writer readers. Neither local budget nor spare capacity guarantees the global
quota when other clients are active. Read volume alone does not establish a 429
as the cause of an earlier failure.

An observed 429 closes the scheduler to pending and new account GETs. It does not
retry, drain, honor a response header as authority to continue, or reuse a cached
fence. Other failed reads also fail their operation. This can prevent proof of
disabled-core recovery; retain the uncertain state and obtain fresh operator
observations before any newly authorized attempt. Mutation methods and GitHub
requests retain their existing transport, and no write retries are introduced.

Retirement failure records retain their existing reason and add an optional
`retirement` object only for a privately branded failure. Its closed `phase`
identifies the initial proof, intent proof, post-intent fence, current read or
comparison, staged proof, final authority, freshness, PATCH, post-read,
post-verification, post-fence or receipt proof. Closed `category`, `mutationState`
and optional `readTransportState` distinguish a rejected proof from a queued,
attempted or rejected GET. Only allowlisted integer HTTP statuses may accompany
a GET transport failure. No arbitrary error property, provider body/header,
URL, token or private document digest is reflected. PATCH transport state
distinguishes no dispatch, an unknown attempted outcome, a received response and
an accepted response; even acceptance still requires strict post-read comparison
and durable receipt proof. None of these fields grants intent-replay authority.

The trusted controller owns the Wrangler executable, its working directory and
validated toolchain pins. The selected release supplies absolute application
entrypoints, migrations and application dependency inputs. An older release's
unused development-tool pins do not override the controller toolchain. The
resolved deployable digest binds both selected-source and controller lockfile
digests.

Selected-source eligibility also requires the canonical checked-in
`deployment/directory-reconciliation-interface.json` contract for the
zero-argument RPC and bounded `directory-reconciliation-v1` receipt. Before
provider access, the controller compares the regular file with the exact blob
in the selected Git commit and rejects a missing or unsupported interface.
Its digest is part of the deployable plan. A compatible older tag can still be
promoted while main is ahead; a historical fetch-only tag cannot be uploaded
by this controller. Uncommitted compatibility declarations grant no eligibility.

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
`DirectoryReconciliation.reconcile()` Service Binding RPC with zero arguments,
retaining bounded receipts and purge completion. The Worker constructs the fixed
empty internal POST, keeping Node Request types and proxy HTTP headers outside
the strict request envelope. Deadline expiry disposes the proxy and stops
acceptance; it cannot undo core work already accepted. Then prove
static-origin formats/freshness/conditional behavior and
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
