# Isolated review environment decision

Status: accepted design; provider provisioning remains unauthorized until
issue #56. The machine contract is
[`deployment/workers-builds-review.json`](../deployment/workers-builds-review.json),
and `npm run review:validate` is its fail-closed validator.

## Decision

Use one Cloudflare account, repository connection, and connected core Worker
with the provider-native two-trigger model. The core Worker has one production
trigger for `main` and one preview trigger for build-only non-production
branches. Each trigger has its own command, build token, and environment. An
explicit maintainer may run one reusable live
cohort from a clean checkout of an exact same-repository non-`main` commit. The
live account has no GitHub connection. This respects
Cloudflare's one-GitHub-account/one-Cloudflare-account guidance and preserves
the existing website installation.

The automatic path compiles and tests but has no binding, route, protected
input, version upload, or URL. Its separate user token has only `User
Details:Read`; it has no account or zone permission or resource selector. The
live path runs only after repository validation, explicit SHA approval, and a
read-only GitHub/checkout proof. Its credentials reach only the dedicated live
account and are never loaded into automatic branch builds.

This is the smallest topology that gives routine branch feedback and can still
exercise D1, R2, Durable Objects, Analytics Engine, native rate limits, Service
Bindings, Access, and WebSockets when needed. It does not pretend that a Worker
version clones state. It also does not claim to prove production DNS, Custom
Domains, zone WAF/cache rules, certificates, traffic, or quotas.

## Options considered

| Option | Evidence | Isolation and operation | Decision |
| --- | --- | --- | --- |
| Reusable live cohort on every branch | Full topology for routine changes | Every branch would receive mutation authority or queue behind one shared cohort | Rejected as automatic default |
| Ephemeral cohort per branch | Strong per-revision state separation | Highest resource, naming, certificate, migration, and teardown cost | Rejected |
| Build-only plus explicit reusable live cohort | Routine compile/test; live state only on request | Zero-resource branch token; one supervised isolated live account | Selected |

A second or third Cloudflare GitHub connection was rejected. Cloudflare warns
that one GitHub account should point to only one Cloudflare account, and the
organization installation is shared with the website. A delegated
`review.meta.atrinik.org` child zone was also rejected because Cloudflare
subdomain setup is Enterprise-only. The selected live account uses its stable
`workers.dev` namespace behind Access instead.

## Automatic trigger and GitHub feedback

The connected project is the production core, `atrinik-metaserver`. Cloudflare
documents at most two triggers for one Worker: a production trigger and an
optional preview trigger. The production trigger remains exactly #54: branch
`main`, all paths, `npm run deploy:production`, the production build token, and
the protected production environment. The preview trigger selects every branch
except `main`, uses the provider-canonical `/deployment/review-check` root, and
has only the distinct zero-resource review token plus the nonsecret
`SKIP_DEPENDENCY_INSTALL=1` environment. Its 13-byte build
command invokes the private package in the configured review root; that package
delegates to the checked-in repository-root `npm run review:build` entrypoint.
The root entrypoint retains the exact sanitized, lifecycle-disabled pinned
install and `npm run review:branch`; the trigger then
runs the local no-op `npm run review:validate`. Neither its commands nor its
settings are never copied from the production trigger. The local Wrangler file
under the review root is a dry-run validation asset only; setup creates no
review Worker or bootstrap version.

The provider contract is pinned in the machine document and was reverified on
2026-08-16 against Cloudflare's
[Builds API reference](https://developers.cloudflare.com/workers/ci-cd/builds/api-reference/),
which defines up to two triggers per Worker and makes the build token, commands,
branch filters, root directory, and environment variables trigger-specific.

The retained #66 journal proves that reusing one repository connection across
two different Workers was rejected with provider error `12002`. That request
shape is a forbidden topology and is never retried or varied. The selected
replacement is the provider-documented production-plus-preview pair on the
single core Worker.

Cloudflare's `Workers CI Write` permission is account-scoped rather than
project-scoped and requires a user API token; account tokens are unsupported.
The review build identity has no such permission, but the dedicated
nonhuman `metaserver-review-environment-operator` inevitably can read/cancel
account builds, start builds, manage build tokens and environment variables,
change repository connections, and mutate triggers—including production
Builds state. Its token stays only in the operator secret store and is never
placed in a project environment, build, or repository. Its only accepted
mutations target the exact core preview-trigger ID; the procedure rejects the
production-trigger ID and reads the result back. This is an explicit
administrative tradeoff, not a review-run permission.

Cloudflare requires a build token even when the deploy command is a local
validator. The preview trigger uses a different user token from production
on a dedicated nonhuman identity with exactly `User Details:Read`, no personal
data, empty account/zone permissions, and empty
account/zone resource selectors. #66 must prove that the trigger has no
production protected input, that a branch build and its local deploy command
succeed with that token, and that representative
Cloudflare account/zone reads and writes fail. If Cloudflare will not accept
that zero-resource token, non-production Workers Builds stays disabled; never
substitute the production token or broaden permissions.

Only refs pushed to the connected `atrinik/metaserver-worker` repository enter
Workers Builds. Fork refs remain outside that repository and receive ordinary
GitHub validation only. The entrypoint relies solely on Cloudflare's documented
`WORKERS_CI_BRANCH`, `WORKERS_CI_COMMIT_SHA`, and `WORKERS_CI_BUILD_UUID`, then
checks that the checkout is the exact SHA. It does not assume undocumented
event or fork variables.

Cloudflare automatically emits a check and, when a commit belongs to a pull
request, a status comment whose history retains earlier builds. Because the
non-production deploy command never uploads a version, the result has no
preview URL. The comment may contain only provider-native safe build status,
commit, build/project links, and history—never credentials, configuration,
provider responses, live URLs, or resource identifiers. There is no privileged
GitHub Actions deployment or comment workflow.

The provider's hard build timeout is 20 minutes. The repository check child is
limited to 15 minutes, reserving five minutes for the lifecycle-disabled install,
contract validation, and provider finalization; a timeout fails the check and
never falls through to production. The branch runner executes a fixed sequence
of named type, test, dry-run, and contract stages. On failure its private log
reports only the allowlisted stage, exit/signal/timeout/output-limit class, and
stdout/stderr byte counts. It never emits captured child output or environment
values.

The review path adds no persistent Worker or reachable URL. #66 records the
account plan and current build usage.
Review automation has a 1,000-minute monthly budget, alerts at 800 minutes, and
is disabled/read back at the threshold. Newer same-branch results supersede old
results. An older build may finish its credential-free build-only work and
counts against the budget, but its SHA-bound result has no live authority.
Although the trusted operator token is technically cancellation-capable, this
workflow never uses cancellation.

## Live source and authority boundary

The live cohort is in a dedicated nonproduction Cloudflare account with no
GitHub connection, zone, parent-DNS authority, or production resource. An
operator starts it from a clean detached checkout using:

```sh
npm ci --ignore-scripts
npm run check
npm run deploy:review-canary -- --source-sha <40-lowercase-hex-sha>
```

The eventual #56 entrypoint must first use read-only `gh` access to prove the
commit is the head of a same-repository non-`main` branch, is not reachable
from live `main`, matches the explicit maintainer approval record, and equals the clean checkout. Only then may it
load live-account credentials. It generates a UUID for the run and acquires an
atomic expiring lease in the live D1 database. Every forward mutation—fixture
change, deploy, enable, or test—reproves the branch/SHA and lease. A force-push,
branch deletion, or lease loss forbids further forward work but still authorizes
idempotent fail-safe closure after exact live-account and resource readback.

The authority matrix is exact:

| Actor | Routine | Exact live-account permission template | Authority |
| --- | --- | --- | --- |
| Provisioner | No; #56 setup only | Workers Scripts Edit, D1 Edit, Workers R2 Storage Edit, Access Apps and Policies Edit, Account Settings Read | Create named resources, enable `workers.dev`, configure one `all_workers` Access application, and write runtime secrets |
| Migration operator | No; reviewed ledger advance only | D1 Edit | Apply pending migrations |
| Live runner | Yes, explicit exact-SHA run | Workers Scripts Edit, D1 Edit, Workers R2 Storage Read, Account Analytics Read | Deploy three Workers, execute allowlisted lease/fixture SQL, and read back live state |
| Access token operator | No; after lease and after closed readback | Access Service Tokens Write; Access Apps and Policies Edit | Create the exact 60-minute per-run token, bind the policy to only its ID, transfer it only to the supervisor, then delete it |
| Access canary | Yes, five-minute window | No Cloudflare API permission; one service token scoped to the review `all_workers` application | Reach only review endpoints |
| Cleanup operator | No; separate preview/apply | Workers Scripts Edit, D1 Edit, Workers R2 Storage Edit, Access Apps and Policies Edit, Access Service Tokens Write, Account Settings Edit | Delete only the exact live inventory |

The routine process never loads the cleanup credential and has no
production-account, parent-DNS, or runtime-secret-read authority. It never
applies migrations: a mismatch
stops and names the migration operator as the next gate. Provider permissions
cannot distinguish arbitrary D1 SQL from migration SQL, so #56 must place the
runner's lease/fixture statements behind an exact command allowlist and audit
their results; the account boundary is the hard production isolation.

## Isolation matrix

| Boundary | Review ownership and proof |
| --- | --- |
| Source/Workers | Exact approved SHA on three fixed review Workers; annotations and bundle digests agree; deploy core, publisher, rendezvous |
| D1/DO | One application D1 ledger, one separately provisioned coordination D1, and the review core's two namespaces; the application ledger must already equal checked-in migrations and coordination uses only the exact `review-coordination-v1` schema |
| Service Bindings | Publisher/rendezvous bind only to the named review core entrypoints |
| R2/static | Three private review buckets, `r2.dev` disabled; verify objects through provider readback, not a public static hostname |
| Analytics/rates | Two exact datasets and five unique numeric namespace IDs (`2006`, `2007`, `2101`, `2201`, `2202`) with exact owner/binding and `simple.limit`/`simple.period` policies and no production reuse |
| Secrets | Canary-only cache/source-tag values and review-only key IDs; values are write-only, never build-readable or copied |
| Host/TLS/Access | Three stable review `workers.dev` hosts, provider TLS, one account-scoped `all_workers` Access application; no Custom Domain, zone WAF, cache rule, route, or preview URL |
| Data | No production/live-request copies; fresh ephemeral nonproduction signing keys and certificates per run; no real identity or rendezvous state |
| Schedules/logs | No cron; private Worker logs with repository redaction and no external destination |
| Retention/cost | One cohort: 3 Workers, 2 D1 databases, 2 DO namespaces, 3 R2 buckets, 2 datasets, 5 rate namespaces, 0 custom hosts, 1 Access app; 20-minute supervised run, at most 15 mutation minutes and a five-minute live window, seven-day evidence; replay admission is invalid after 24 hours but its physical DO row is a recorded provider residual until alarm pruning or mandatory 90-day namespace teardown, Analytics Engine may retain synthetic rows for 90 days, and native rate counters expire on provider cadence |

The protocol identity is the fresh certificate hash; it is not forced into a
text prefix. The fixture record separately carries the
`review-canary-fixture-` namespace plus source SHA, run UUID, and vector name.
Keys are generated in memory after the lease, never persisted or logged, and
discarded after circuits close. Requests use current bounded timestamps, so
the fixed checked-in signed fixtures are reference vectors only and are never
reused as live valid publications.

The machine contract pins the raw SHA-256 of all three checked-in role
configurations and permits only its enumerated review overrides. Those exact
overrides name every Worker, D1/R2/Analytics/rate binding, Service Binding,
review hostname, source-tag epoch, every core and caller circuit, no-zone placeholder origin/cache
ID, schedule, `workers_dev`, preview, route, and observability setting. #56 may
substitute only provider-issued private resource IDs and the read-back account
`workers.dev` subdomain; every other parsed value remains equivalent to the
digest-pinned source.

## Executable live plan

Every remote operation requires readback before the next:

1. Validate both contracts and complete repository tests without credentials.
   Prove the approved GitHub branch/SHA and clean detached checkout.
2. Load only live-account credentials and acquire the atomic expiring lease in
   the separate coordination D1. Its singleton row contains source SHA, run
   UUID, monotonically increasing generation, expiry, fixture namespace, and
   state. Every forward mutation CAS-renews the exact UUID/generation and
   reproves source authority. The digest-pinned operations file supplies each
   parameterized, single-statement D1 CAS and exactly-one-row success predicate;
   SQLite provider UTC is the clock and every acquire, renewal, or reclaim uses
   exactly 1,800 seconds. A lease proof may be at most five seconds old before a
   forward mutation, each provider operation has a 120-second hard timeout, and
   at least 300 seconds remain reserved for ambiguous-result recovery. An
   expired lease may be reclaimed only after exact-cohort disabled-circuit
   readback, explicit close acknowledgement for every canary server/client
   socket, an offline read through the same DO, and a 60-second teardown drain.
   The coordination D1 also owns a singleton
   `active`/`quiescing`/`teardown` control row and provider timestamp. Acquire,
   renew, enable, reclaim, fixture, deploy, and every other forward operation
   require `active` in the same fenced plan.
3. Inventory exact resources and ceilings; reject missing, duplicate, unknown,
   production-matching, or unowned objects. Disable/read back all circuits.
4. Require the application migration ledger to be exact. A pending migration
   stops for the migration operator. Generate ephemeral signing
   keys/certificates and unique fresh fixture metadata, seed it directly in
   application D1, and reject any unexpired collision. The coordination schema
   is independently provisioned and is never appended to the application ledger.
5. Resolve all bundles, deploy core then publisher then rendezvous, and read
   back scripts, bindings, identifiers, routes/subdomains, schedules, secret
   names, observability, and entrypoint exports.
6. For at most five minutes, use intentionally invalid signed Classic v1/v2
   and Game requests to prove publisher routing, Service Binding traversal,
   authentication rejection, native admission, and redaction without an
   accepted publish. Use the directly seeded identities for positive WebSocket
   rendezvous and replay checks, and verify private R2 bindings through provider
   readback only. Cron stays disabled and no publisher success may nudge
   `DirectoryBuilder`; prove there is no directory outbox, pending build, or
   alarm. Before this window, the Access token operator creates one exact
   `60m` token and an exact-precedence Service Auth policy includes only its ID.
   The canary sends its ID/secret only in `CF-Access-Client-Id` and
   `CF-Access-Client-Secret` headers, including WebSocket upgrades. The
   credential is never placed in URLs, bodies, logs, or evidence.
7. At every enabled stage, inject force-push, branch-deletion, and lease-expiry
   failures. Prove they prohibit forward work while exact-cohort fail-safe
   circuit closure remains authorized.
8. Disable/read back all circuits, expire direct D1 fixtures, discard keys,
   explicitly close every rendezvous server/client socket, wait for close
   acknowledgements, prove a new same-room client observes offline, then wait
   60 seconds for active rendezvous sockets and teardown retries to drain,
   CAS-release the lease, and retain only closed outcomes/digests/counts/names
   for seven days. A successfully claimed replay admission becomes unusable at
   the 24-hour logical cutoff. Its alarm is best-effort physical pruning:
   provider delay or exhausted retries can retain the row longer, so the
   operator records and reads back that residual. The unique room cannot
   collide with a later run, and mandatory full cohort teardown force-deletes
   both namespaces no later than cohort age 90 days; new runs stop once that
   deadline is reached until absence is proved.

An ambiguous deploy/readback is possible mutation. Recovery always inspects and
proves the disabled core. Partial runs record their completed prefix and may be
resumed only after exact SHA and lease proof.

## Reviewer and failure behavior

- Same-repository pushes receive a Cloudflare check and the provider's native
  PR status comment/history, but no version or URL.
- Forks receive repository validation only. Never replay fork code through the
  connected project or live runner.
- A rebase/force-push supersedes the old SHA. Rename changes a label only.
  Merge/close leaves the singleton disabled; reopen does not revive approval.
- Live URLs are mutable cohort coordinates and not secrets or commit evidence.
  Reviewers must match the active annotation to the recorded SHA.
- Provider outage leaves repository validation usable and never falls through
  to production. Local build-only escape is `npm ci --ignore-scripts`, `npm run
  check`, and `npm run review:dry-run` without Cloudflare credentials.

## Cleanup

Normal completion disables circuits, expires fixtures, discards keys, and
retains the singleton. Full teardown is separately authorized and preview-first:
verify exact account/inventory/prefix, no production identifier, disabled
circuits, and no unowned resource. It first atomically changes `active` to
`quiescing`, which blocks new acquire, renew, enable, reclaim, fixture, deploy,
and test proofs but still permits the owning runner's fail-safe closure and
release. Cleanup never releases an unexpired row. It waits at least 425 seconds
for the five-second proof age, 120-second operation timeout, and 300-second
recovery reserve, then disables/read-backs circuits again. A cooperative owner
may release only after its provider operations and readbacks finish. For an
abandoned row, cleanup waits for lease expiry, proves exact disabled state and
a 60-second drain, then uses a cleanup-only exact UUID/generation CAS to mark
the expired `disabled`, `enabled`, or `draining` coordination row disabled and
uses the cleanup-only expired-row release. Only with no
run row and the quiesce horizon elapsed may one atomic statement enter terminal
`teardown`. The operator keeps the coordination D1 through the complete
cleanup; no runner can recreate authority after that point. It then
revokes/deletes the exact run service token, deletes the callers,
and inventories the exact core script tag and both Durable Object
namespace IDs, then calls the Worker delete API for that exact core with
`force=true`. The API contract deletes its associated namespaces; both IDs and
the core script must read absent before deleting the remaining application
state. The operator next disables the live account's `workers.dev` subdomain
and deletes the still-protective `all_workers` Access application only after all
public endpoints are absent. The terminal fence remains through those steps;
the coordination D1 is removed last. On failure, stop, preserve disabled
circuits, record the completed prefix, and retry from readback.

Analytics Engine datasets are provider-created on first write and may retain
the synthetic rows for 90 days; teardown stops writes and removes bindings but
does not claim dataset deletion. Rate-limit namespaces are binding IDs rather
than deletable resources; teardown removes the bindings and lets counters
expire. Both residuals are recorded separately from seven-day review evidence.
The rendezvous replay admission has a 24-hour logical security lifetime, while
its alarm is only best-effort physical cleanup. A retained row is recorded and
checked after expiry. The separately authorized irreversible full teardown
deletes the exact Worker and both inventoried namespaces by cohort age 90 days
after circuit closure, socket/offline proof, and a no-builder-work check.

## Provider references

- [GitHub integration](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/)
- [Build configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)
- [Build branches](https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/)
- [Build limits](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/)
- [Workers Builds API](https://developers.cloudflare.com/workers/ci-cd/builds/api-reference/)
- [Preview URLs](https://developers.cloudflare.com/workers/configuration/previews/)

These references describe behavior, not authorization. This issue mutates no
Cloudflare or GitHub setting; #56 owns reviewed provisioning and live proof.
