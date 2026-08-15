# Isolated review environment decision

Status: accepted design; provider provisioning remains unauthorized until
issue #56. The machine contract is
[`deployment/workers-builds-review.json`](../deployment/workers-builds-review.json),
and `npm run review:validate` is its fail-closed validator.

## Decision

Use option 3: run an automatic **build-only** Workers Builds check for every
eligible same-repository non-`main` branch, and reserve one reusable isolated
live canary cohort for an explicit maintainer request tied to an exact commit.
The automatic check compiles and tests the repository but has no Worker
binding, route, protected input, runtime secret, version upload, or review URL.
The live path is not automatic and is not provisioned by this change.

This is the smallest topology that reports branch regressions automatically
while exercising state, Service Bindings, custom edges, and WebSockets honestly
when live evidence is actually needed. A Cloudflare Worker version is not a
state clone: D1, R2, Durable Objects, Analytics Engine, rate-limit counters,
secrets, routes, and external control-plane objects remain independent
resources. Preview URLs are public `workers.dev` URLs unless Access protects
them, have no Worker logs, and are not generated for a Worker that implements
a Durable Object. The core also uses declarative `exports`, so an ordinary
version-preview path cannot represent this topology.

The production connection remains unchanged. It accepts only `main` and only
`npm run deploy:production`. Its nonproduction trigger stays disabled. Review
traffic uses separate projects and must never cause a second command on
`main`.

## Options considered

| Option | Useful evidence | Isolation and lifecycle | Cost and operation | Decision |
| --- | --- | --- | --- | --- |
| One reusable serialized cohort for every approved branch | Honest full topology and stable logs, but each routine change waits for a shared live lease | Isolation is possible, but stale/overlapping builds can replace the one mutable URL; migrations and Durable Object state need reset discipline | Fixed resource ceiling, high routine operator and queue cost | Rejected as the automatic default; retained only as the explicit live half of option 3 |
| Ephemeral full cohort per branch/PR | Concurrent immutable-looking URLs and strongest state separation | Requires collision-safe names, separate D1/R2/DO/rate/secrets/hostnames/Access/WAF, migrations, and partial teardown for every revision; fork and force-push cleanup races are substantial | Highest quota, hostname, certificate, cleanup, and operator cost | Rejected; the extra concurrency does not justify destructive lifecycle automation |
| Build-only checks plus explicit reusable live canary | Fast automatic compile/test feedback; full evidence only when requested | Branch code gets no live authority. One fixed cohort has exact resource ownership, a single lease, deterministic fixtures, and disabled circuits between runs | Three live Workers and one bounded resource cohort; no per-PR resource churn | Selected |

The tradeoff is explicit: most pull requests receive no URL and cannot prove
production WAF, production state, real traffic, cache behavior, certificates,
or provider quotas. The live cohort proves the same application topology and
review-host edge rules, not the production control plane. A production canary
and readback remain part of #54 delivery.

## Trigger and credential boundary

The build-only project is `atrinik-metaserver-review-check`. Its provider
production branch is the absent, reserved
`review-build-only-sentinel`; automatic production pushes are disabled and its
production command is `npm run review:reject-sentinel`, which always fails.
Its preview trigger includes every path on same-repository branches except
`main` and that sentinel. The build field uses `npm run review:branch`; that
command only validates source coordinates and runs `npm run check`. The deploy
field revalidates the contract with `npm run review:validate`. Neither uploads
a version. The trigger has exactly one
non-secret variable, `SKIP_DEPENDENCY_INSTALL=1`, and empty protected inputs,
bindings, and routes. Its build token belongs to a dedicated build-check
Cloudflare account that contains no production or live-canary resource. This
account separation is the hard boundary: account-scoped Worker permissions
cannot be treated as individual-script isolation. The provider token is an
unavoidable credential visible to same-repository branch code and may affect
the otherwise empty build-check account; it cannot cross into production or
the live canary. That account owns no zone, has its `workers.dev` subdomain
disabled, and contains only the named Builds project.

Never put a production or live-canary configuration, identifier, Cloudflare
credential, Access token, or runtime secret in this trigger beyond the
provider-managed token confined to the empty check account. Branch code runs
inside the build trust boundary before repository validation. Separating the
trigger—not sanitizing a later child process—is what prevents an unreviewed
branch from reading deployment authority.

Fork pull requests do not enter connected-repository Workers Builds. Their
normal GitHub repository validation is the only result. Do not make secrets
available to a fork, manually replay fork code through the connected project,
or add a privileged GitHub Actions deploy/comment workflow.

The live project is in a second dedicated nonproduction Cloudflare account,
distinct from both production and the build-check account. The
`review.meta.atrinik.org` zone is delegated to that account by a separately
authorized parent-DNS change; its credentials have no parent-zone authority.
It is separately connected to the canary core and uses an absent
`review-live-canary-sentinel` production branch with automatic pushes disabled.
An operator explicitly requests a manual Workers Build by the reviewed
same-repository commit SHA. `WORKERS_CI_COMMIT_SHA` must exactly equal
`ATRINIK_REVIEW_APPROVED_SHA`, the checkout, and the recorded request before
any provider read. The build must recheck the same-repository non-`main` source,
acquire the singleton lease, cancel stale canary builds, and recheck the exact
SHA immediately before each mutation. Issue #56 must verify the provider's
manual exact-commit behavior before enabling this path; the checked-in
`npm run deploy:review-canary` deliberately stops as unprovisioned meanwhile.

## Isolation matrix

The contract names every live resource. Provisioning must substitute only
provider identifiers that are unique to these exact names; it may not broaden
the ownership set.

| Boundary | Review ownership | Required proof |
| --- | --- | --- |
| Source and Workers | One exact approved commit; `atrinik-metaserver-review-canary`, `atrinik-metaserver-publisher-review-canary`, and `atrinik-metaserver-rendezvous-review-canary` | All three version annotations equal the requested SHA and digest; deployment order is core, publisher, rendezvous |
| D1 and Durable Objects | One review D1 ledger; both DO classes are exported only by the review core | Fresh/known ledger equals checked-in migrations; no production database or Worker namespace ID appears |
| Service Bindings | Each caller binds to its named review core entrypoint | Live readback resolves `PublisherCoordinator` and `RendezvousCoordinator` on the same cohort only |
| R2 and static origins | Three private review buckets and two review-only custom hosts | `r2.dev` disabled; no production bucket, host, alias, purge token, or cache rule ID appears |
| Analytics | Two `_review_canary` datasets | No production dataset or tail destination; only redacted aggregate schemas |
| Native limits | Five unique review namespace IDs for core publish/server, publisher global, rendezvous global/client | IDs are distinct from each other and every production ID; configured simple policies equal reviewed values |
| Secrets | Canary-only cache token and overlapping source-tag pair with exact `review-canary-current` / `review-canary-previous` epochs | Values are created in Cloudflare, never readable by builds, never copied from production, and are absent from output |
| Dynamic edge | `publish.review.meta.atrinik.org` and `rendezvous.review.meta.atrinik.org` | Exact review-host WAF/rate envelopes, full-strict TLS, disabled circuits before and after tests, no production rule authority |
| Access | One review-canary Access application | URLs are not secrets. Browser use requires an Access session; automated and WebSocket clients require an authorized session or service-token headers |
| Schedules | No cron triggers | Maintenance and expiry are explicit bounded test steps, never background production-like activity |
| Data | Deterministic public nonproduction fixtures prefixed `review-canary-fixture-` | No copied production rows, request data, credentials, real server identities, or rendezvous state; fixture age at most 24 hours |
| Account and credentials | One empty build-check account and one live-canary account, both distinct from production | Branch token cannot reach canary or production; canary token cannot reach production or parent DNS; exact account IDs stay private |
| Retention and cost | Two nonproduction account boundaries; 15-minute build-only ceiling; one long-lived cohort, at most one 30-minute build and 30-minute live window, three Workers, one D1, two DO namespaces, three R2 buckets, two datasets, five rate namespaces, four hosts, one Access app | Closed evidence retained at most seven days; quarterly inventory/reprovision; resource counts and time windows may not exceed the contract |

The fifth rate namespace is the rendezvous client limiter. It shares the
contract's aggregate rendezvous rate-resource ceiling, not a counter or ID with
the rendezvous global limiter. No production resource name, ID, binding target,
hostname, route, cache-purge authority, rule destination, or secret value is an
allowed substitution.

## Executable live test plan

Issue #56 must implement this sequence as one fail-closed entrypoint. Each
remote operation needs a readback before the next one.

1. Validate the checked-in review and production contracts locally. Prove the
   branch is same-repository, non-`main`, clean, and exactly approved; perform
   no provider request before this proof.
2. Acquire the one-cohort lease. Re-list builds after every cancellation and
   make the exact-SHA proof the last fence before mutation. A rebase,
   force-push, or newer request makes the old build stale.
3. Read the exact resource inventory and ceilings. Refuse an unknown,
   production-matching, missing, duplicate, or unowned object. Stage all three
   circuits disabled and prove their coherent readback.
4. Prove the D1 database contains only the independent ordered migration
   ledger and expired/nonproduction fixture namespace. Apply only a separately
   authorized pending review migration, then seed deterministic fixtures from
   checked-in public test material. Never import a production export.
5. Resolve all bundles before upload. Deploy the review core, publisher, and
   rendezvous in that order. Read back bindings, configs, routes, subdomains,
   schedules, secrets by name, observability, and exact same-cohort exports.
6. Open only the bounded test window. Exercise static generation/expiry,
   signed Classic v1/v2 and Game publication, Service Binding rejection paths,
   native admission, WebSocket rendezvous, replay after reconstruction,
   migration compatibility, and log redaction. Access credentials remain
   outside bodies, URLs, logs, comments, and evidence.
7. Close all circuits, prove the exact disabled responses, expire fixtures,
   and emit only source/build/deployable digests, counts, durations, resource
   names, and closed outcomes. Evidence expires after seven days.

An ambiguous upload or readback failure is treated as possible mutation. The
recovery path always inspects and proves the disabled core instead of assuming
the upload did not land. A partial deployment records its completed prefix and
is resumed only by the newest exact approved SHA.

## Reviewer experience

- A same-repository branch push gets one Cloudflare build-only check for the
  exact SHA. There is no URL or bot comment. A maintainer may request live
  review when the change needs provider evidence; the private record carries
  immutable SHA/build/digest identifiers and the four stable, mutable cohort
  URLs.
- A fork gets only ordinary GitHub repository validation. Moving the commit to
  a same-repository branch requires normal review before it becomes eligible;
  never replay an untrusted head with canary authority.
- Rebase or force-push supersedes the older SHA. Branch rename changes only a
  label; SHA is authoritative. Overlapping branch checks are harmless because
  they have no mutation authority. Live requests serialize and stale builds
  stop before mutation.
- Merge or close does not delete the singleton; circuits remain disabled and
  fixtures expire. Reopen starts a new build-only check and never restores an
  old live approval. A full teardown is a distinct authorized operator action.
- A provider outage leaves the GitHub validation result usable. Review checks
  report unavailable/failed and never fall through to production. The manual
  escape is local `npm ci --ignore-scripts`, `npm run check`, and
  `npm run review:dry-run` without Cloudflare credentials; it is not live
  evidence.
- Stable canary URLs identify the cohort, not a commit, and therefore are not
  immutable evidence or a secret boundary. Reviewers match the active version
  annotation to the recorded exact SHA before use.

Native preview URLs would have no Worker logs, but this selected live cohort is
a normal isolated deployment. Private Worker logs, platform metrics, and WAF
analytics therefore exist. Troubleshooting uses only the redacted schemas in
[`privacy.md`](privacy.md), bounded closed evidence, and exact build/version
identifiers. Do not paste response bodies, addresses, tags, tokens, provider
responses, or resource IDs into a pull request.

## Cleanup and failed cleanup

Normal completion disables all circuits and expires fixtures but retains the
singleton. The cleanup owner is the metaserver review-environment operator.
A full teardown is preview-first and checks the exact account, resource
inventory, review prefix, disabled circuits, and absence of every production
identifier. It then detaches only review hostnames/Access, deletes caller
Workers before core, deletes the named review state resources, and finally
deletes the two review build projects.

On failure, stop immediately, preserve disabled circuits, record only the
completed prefix, read back the remaining inventory, and retry from that
readback. Never infer ownership from a prefix alone, delete an unowned object,
or continue into a production match. Branch close, merge, rename, or force-push
does not authorize cleanup.

## Provider references

- [Preview URLs](https://developers.cloudflare.com/workers/configuration/previews/)
- [Versions and deployments](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/)
- [Wrangler environments](https://developers.cloudflare.com/workers/wrangler/environments/)
- [Workers Builds branch configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/branch-build-controls/)
- [Workers Builds API](https://developers.cloudflare.com/api/resources/workers/subresources/builds/)

These references describe provider behavior, not authorization to provision.
This decision changes repository validation only. Cloudflare and GitHub
settings remain untouched until #56 is separately reviewed and authorized.
