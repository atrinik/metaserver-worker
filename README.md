# Atrinik metaserver Worker

[![Check](https://github.com/atrinik/metaserver-worker/actions/workflows/check.yml/badge.svg)](https://github.com/atrinik/metaserver-worker/actions/workflows/check.yml)

This repository owns Atrinik's Cloudflare metaserver services for QUIC-only
game transport. The services publish discovery metadata and exchange bounded
connection candidates; they never proxy game traffic.

## Supported services

The current contracts require coordinated access-token-capable consumers.
Historical publisher and directory versions are not accepted by this runtime.
The public API is canonical-only:

- static Classic snapshots at `classic.meta.atrinik.org/index.{html,json,xml}`;
- signed Classic v3 publication at
  `publish.meta.atrinik.org/v3/classic/servers/{server-id}/publish`;
- Classic rendezvous at
  `rendezvous.meta.atrinik.org/v1/classic/servers/{server-id}`; and
- the independently versioned Game Protocol 1 publisher, rendezvous, and
  static snapshot contracts.

The retired CGI and legacy generic `/v2` targets have no application dispatcher,
redirect, fallback, or rollback path. Edge policy blocks them before Worker
invocation. `meta.atrinik.org` remains unattached until it is enabled only as a
static Game R2 origin. The exact route contract is documented in
[docs/routes.md](docs/routes.md).

The dynamic split is implemented as three deployable Workers. The existing
`atrinik-metaserver` core remains the sole owner of D1, R2, schedules, and the
`RendezvousRoom` and `DirectoryBuilder` Durable Objects. Domainless
`atrinik-metaserver-publisher` and `atrinik-metaserver-rendezvous` edge Workers
own only their route-specific breakers and native burst
bindings, then call one named core entrypoint through a Service Binding. The
edges reconstruct a fixed allowlisted request,
so the raw request address and browser state never cross into the state owner;
the core independently validates the complete route and protocol again. The
checked-in edge configurations have no public route. Classic publishing and
Classic rendezvous are enabled; Game publishing remains disabled. The core
exports scheduled handlers, Durable Objects, and named
Service Binding entrypoints only; it has no default `fetch` handler.
The private `DirectoryReconciliation` entrypoint accepts one fixed empty POST
from the deployment-owned Service Binding to reconcile the two current directory
profiles and return verified publication receipts. It has no public route, caller
binding or client-selected profile/object authority; see [the capability contract](docs/directory-reconciliation.md).

The operator-safe rendezvous health source contract is the private
`RendezvousHealth` entrypoint documented in
[`docs/rendezvous-health.md`](docs/rendezvous-health.md). It exports only
bounded aggregate evidence and never enumerates rooms or publishes a public
health route.

There is deliberately no TCP directory, DNS ownership proof, game-port probe,
or game relay. A server is owned by the SHA-256 identity derived from its
persistent QUIC certificate. Both publishers fold freshness and identity proof
into one replay-safe signed request. Rendezvous server peers authenticate
separately.

Rendezvous is one short, bounded signaling attempt. Every client first obtains a
blind stateless challenge from
`POST /v1/rendezvous/challenge/classic/{server-id}` and solves fixed 24-bit
SHA-256 work. The core verifies the proof and binary-ticket hash before any
presence or room lookup. Open upgrades send the proof and fresh ticket headers;
protected upgrades send the proof, bearer grant and client nonce. Only a live
authenticated server control can admit the client. The room redeems protected
grants and claims ticket replay tags before allocating a socket. Protected
`access_init` confirms that same preauthorized grant and nonce; it never provides
another authentication path. No access code, route capability or grant appears
in a URL or WebSocket subprotocol. See [admission details](docs/rendezvous-admission.md).

The grant expires within 15 seconds and is redeemed once through the current
D1 route authority before room admission. Revocation and redemption serialize
there; revocation also closes pending room routing. Independent encrypted game
admission verifies the access code. Directory presence stores the authenticated
certificate, name, optional endpoint and configured `accessRequired` policy
privately for resolution. Public builders consume only current public entries,
never private presence or token metadata. Open/private policy is independent of
the number or validity of tokens.

Existing candidate, frame, byte, replay, expiry and terminal-teardown bounds
remain enforced. Candidate endpoints are not persisted. The authenticated
control channel uses `atrinik-access-rendezvous-v1`; retired invitation and
password protocols are not fallback paths. See the normative access-token
contract in the protocol repository and the separately gated deployment plan.

## Development

Use the Node and npm versions pinned by `.nvmrc` and `packageManager`:

```sh
npm ci
npm run check
npm run deploy:development:dry-run
npm run deploy:production:dry-run
```

`npm run check` generates and verifies isolated core/publisher/rendezvous
Wrangler declarations, runs every TypeScript project, the local Workers runtime
tests, the Python administrative tests, and one distinct Wrangler dry run per
deployable. Generated declarations and `dist/` output are untracked and must
not be edited.

Reviewed pushes to protected `main` automatically deploy to the persistent
DEV cohort through Cloudflare Workers Builds and `npm run deploy:development`.
The machine contract is
[`deployment/workers-builds-development.json`](deployment/workers-builds-development.json).
DEV uses the existing `atrinik-metaserver-development` core and its
`-publisher` and `-rendezvous` callers; production resources are disjoint.
Delivery checks the exact D1 ledger without applying migrations, fences stale
builds, stages all three Workers with circuits disabled, restores callers before
core, and reads back the coherent 100% cohort before bounded canaries.

Production changes require an explicit GitHub Actions workflow dispatch for an
owner-approved immutable tag and exact SHA. Main pushes and release events
cannot promote. Release provenance, artifact/configuration/migration digests,
expected predecessor, fixed concurrency, and one-use attempts fence the write;
workflow reruns are rejected. The old automatic-production writer must be
fenced and drained before publishing the replacement policy. See
[deployment environments](docs/deployment-environments.md) for prerequisites,
DEV schema preparation, promotion phases and recovery. This source change
proves no deployment or provider activation.

Private resource identifiers and credentials remain in owner-only protected
configuration and provider secrets. Routine builds inherit encrypted core
runtime secrets by name; public callers receive no signing keys or key IDs.
Historical provisioning and token-rotation records remain immutable evidence,
and their former production activation procedure is superseded by the current
environment policy in [DEPLOYMENT.md](DEPLOYMENT.md).

The accepted [review-environment design](docs/review-environment.md) gives
eligible same-repository non-`main` branches an automatic build-only check
with no bindings, protected inputs, upload, or URL. Forks receive ordinary
GitHub repository validation only. Changes that need live provider evidence
use a separately requested, operator-supervised exact-SHA run against one
serialized, Access-protected, production-disjoint canary cohort. The production
core project uses Cloudflare's documented production-plus-preview trigger pair;
the preview trigger has its own zero-resource token and a one-variable nonsecret
environment, so no production protected input or credential enters the build. Cloudflare's
account-scoped Builds control-plane permission remains an explicit trusted
operator user-token exception across builds, tokens, environment variables,
connections, and triggers, never a build credential; the procedure uses only
exact preview-trigger mutations and rejects the production-trigger ID. Review
builds create no version, binding, route, `workers.dev` URL, or preview URL. A
1,000-minute monthly review-build budget fails
closed at its operator threshold. The live
account has no GitHub connection and uses stable `workers.dev` hosts. Native
Cloudflare checks and PR status comments/history contain no preview URL. That
cohort is not
provisioned by this repository change; `npm run deploy:review-canary` remains a
fail-closed placeholder until a maintainer separately authorizes the live
cohort. Validate the machine boundary with
`npm run test:review`, `npm run review:validate`, and
`npm run review:dry-run`. See [DEPLOYMENT.md](DEPLOYMENT.md) for provider settings,
exceptional pauses, exact-SHA retry, partial failure, outage, revocation, and
manual escape procedures.

After an operator has separately provisioned an isolated R2 custom domain and
its reviewed edge rules, validate the public static contract with the
credential-free verifier:

```sh
python3 scripts/static_origin_canary.py \
  --profile game-v2 \
  --base-url https://game-directory-canary.example.org \
  --alias-prefix canary-v2 \
  --json
python3 scripts/static_origin_canary.py \
  --profile classic-v3 \
  --base-url https://classic-v6-directory-canary.example.org \
  --alias-prefix canary-v6 \
  --json
```

It performs only bounded public HTTPS requests. It verifies the three formats,
shared generation and complete normalized server-model parity, freshness,
native ETag and conditional retrieval, HEAD parity, security/cache/CORS
headers, canonical HTTPS root absence, path/query/method denial, and bounded
monotonic convergence. One convergence window covers the complete GET, HEAD,
and conditional proof. If a same-path HEAD or conditional GET proves a strictly
newer valid publication, the verifier resnapshots all three formats; persistent
mismatches, validator reuse, and same-generation body changes still fail. The
separate ingress verifier proves plaintext
same-path redirects. Production hostnames require the additional
`--allow-production` acknowledgement. The verifier cannot
create, alter, or delete Cloudflare resources and accepts no API token.

The checked-in core Wrangler file has a placeholder D1 ID. All three checked-in
Wrangler files have no production route. Supply reviewed production bindings
during the provider-first deployment procedure. Never run remote migrations,
deployments, or identity resets merely to validate a change.

Only the core requires current and previous replay/admission HMAC secrets. Their
names are declared in its configuration; public callers have no secret or key-ID
binding. Values belong only in
Cloudflare encrypted secrets or ignored `.dev.vars` files. See
[docs/privacy.md](docs/privacy.md) for rotation and retention rules.
Consecutive key pairs must overlap for strictly more than the 24-hour
rendezvous replay window. Do not substitute plaintext Wrangler variables.

## Storage

Production state exists. `migrations/0001_initial.sql` is immutable applied
history, and every transition is an appended ordered migration. Tests apply the
complete series and exercise upgrades from populated production-shaped state.
Never edit, reorder, or reuse an applied migration number.

The SQLite-backed `RendezvousRoom` Durable Object is declared through
Wrangler's `exports` configuration. Its application SQLite replay ledger has a
high emergency storage ceiling and a 24-hour security horizon, but it is not
an ordinary client quota. A row records its acceptance time and, when
the client's first candidate or protected `auth_init` atomically claims it,
exactly two
purpose-separated HMAC-SHA-256 replay aliases derived with the current and
previous source-tag keys. Raw tickets, SHA-256 routing digests, connection IDs,
and candidate addresses never enter SQLite. Invite IDs, secrets, challenges,
proofs, and serialized authorization frames do not enter SQLite, Durable Object
key-value storage, hibernation attachments, logs, or metrics. Profile-scoped D1
presence stores the bearer-token hash, last-seen time, and random non-secret
token generation; a separate public-only directory row stores only renderable
metadata and an optional operator-published DNS hostname/UDP port pair. A
private publication retains minimal authentication presence but deletes the
public directory row and cannot admit either rendezvous role. The room's fixed
key-value marker and both attachment roles retain only the generation needed to
invalidate a previous control.
Outside the transient signaling frame, retained raw-ticket state exists only
in its client WebSocket attachment
for at most 15 seconds; the server attachment keeps random connection IDs,
opening/expiry times, and bounded routing digest/counter state until that same
session expires. A terminal client attachment retains only bounded counters,
the closed outcome enum, and teardown bookkeeping after clearing the ticket and
digest. If attachment persistence and transport close fail together, Durable
Object key-value storage retains only a fixed boolean recovery-quarantine flag:
it contains no ticket, digest, connection/control ID, outcome, address, or
counter. Reconstruction uses that flag to scrub and close every room socket,
suppresses guessed terminal telemetry, and deletes the flag once cleanup is
durable or the transports are closed. The client protocol requires 32 random
ticket bytes encoded as 64 lowercase hex characters; the Worker enforces shape
and single use but cannot prove client entropy.
Classic v1 and v2 share one sequence/nonce lineage per certificate identity.
The first accepted v2 publish atomically removes that identity's v1 presence,
listing, and rendezvous generation, then durably marks it v2-only. A private
v2 publish retains authenticated presence and server control while exposing no
directory, endpoint, display, or policy field and admitting no client
rendezvous. Sequence `18446744073709551615` may succeed once; every later
publish returns fixed `publish_sequence_exhausted` without a minimum or state
mutation.

Canonical identity resets and server-ID denial changes should be generated with
`scripts/admin_sql.py`, reviewed, and only then applied by an authorized
operator.

See [DEPLOYMENT.md](DEPLOYMENT.md) for the release checklist.

## Request controls and privacy

The application does not track request IP addresses or derive identifiers from
them. Authenticated request budgets use the server identity; private access-grant
and ticket replay tags derive only from the corresponding random capabilities.
Only a signed, canonical DNS hostname is eligible for persistence. Canonical `xn--`
labels are checked with strict, non-transitional UTS #46 processing, including
STD3, hyphen, joiner, bidirectional, and DNS-length checks. Migration
`0009_remove_legacy_storage.sql` physically removes retired ownership, OTP,
source-rate, shadow-directory, and wildcard-denial storage. Migration
`0015_remove_ip_derived_pair_tracking.sql` removes the populated
source/server-pair attempt and cooldown tables, including their indexes. No
publish infers a QUIC endpoint from the HTTPS source.
The request path emits only the closed, redacted diagnostic events described in
[docs/privacy.md](docs/privacy.md).

Identity rate bindings cap authenticated bursts. D1 retains authenticated
publisher/server budgets and private access-request budgets. Each per-server
Durable Object preserves replay
rejection for 24 hours without imposing a daily player quota. Rooms admit at most 16 active client
attempts and retain 64 client sockets only as an absolute implementation
ceiling. A
pre-Worker WAF rule is still required to prevent a blocked loop from consuming
Worker invocations. The ceilings, `429` contract, shared-NAT policy, and circuit
breakers are in [docs/rate-limits.md](docs/rate-limits.md); the reviewed
edge-policy specification and deployment gate are in
[docs/edge-policy.md](docs/edge-policy.md).

## Static directory publication

Visible directory mutations and expiry advance one profile-scoped D1 revision
and coalesce its durable outbox to the newest unpublished revision. Accepted
heartbeats refresh presence and bounded private activity aggregates without
changing the revision. The profile-scoped sustained-activity ranking and
operator pin procedure are documented in
[docs/directory-ranking.md](docs/directory-ranking.md). A private,
profile-named `DirectoryBuilder` Durable Object receives an O(1), alarm-only
nudge after a visible commit and reconciles durable truth every five minutes
and by alarm; a Queue is deliberately unnecessary. It
serializes R2 work, persists bounded retry intent, coalesces revisions, and
publishes all immutable generation objects before compare-and-swap replacement
of the four public aliases (`index.html`, `index.xml`, `index.json`, and
`manifest.json`). D1 acknowledges an outbox revision only after all aliases are
read back with the exact generation, checksum, size, content type, cache
metadata, opaque native R2 strong ETag, and privacy-safe custom metadata. The
application SHA-256 remains independent body-integrity metadata; it is not the
public HTTP validator.

After that checkpoint, the builder globally purges exactly the profile's three
public `index.*` URLs through Cloudflare's single-file purge API. The long
absolute cache lifetime remains unchanged: readers retain efficient CDN hits
between updates, while a visible publish or expiry invalidates the old cohort.
The pending build is also the durable purge journal. A timeout, rejection, or
restart leaves it intact and schedules a one-minute retry; a duplicate purge is
safe, and a later visible revision remains in the outbox for reconciliation.
Unchanged heartbeats and already-current generations issue no purge. The core
alone receives the dedicated Cache Purge token and exact zone/origin settings;
the public edge Workers receive none of that authority. A bounded
`purge-pending` directory-build metric exposes retry backlog without recording
a generation, URL, token, zone, or account identifier.

`manifest.json` is private coordination metadata even though it lives in the
alias bucket; the later static-host allowlist must deny public access to it.
R2 cannot replace the four objects atomically. Readers can therefore observe
cross-format skew while aliases converge, even though D1 never acknowledges a
partial cohort. The static-host rollout must resolve that mismatch with the
Game Protocol 1 atomic-alias contract before DNS attachment.

Freshness rollover may create a newer artifact generation for an unchanged D1
revision. A five-minute reconciliation may also publish a newer generation at
that revision when aggregate activity changes the deterministic order; the
heartbeat itself still creates no build or R2 write. This is required so empty
and heartbeat-only directories do not expire. Each body is
valid for at most four hours and no later than the earliest backing listing
expiry. The latest eight D1-acknowledged immutable four-object cohorts are
retained as a bounded rollback window; a durable paginated sweep deletes at
most 64 unacknowledged, older, or partial private objects per reconciliation,
so a pre-existing backlog converges without an unbounded scan. The outbox holds
at most one row per profile during an R2 outage.

Public expiry is rounded down to a conservative 15-minute boundary, and
backing presence expires on the same boundary. An artifact therefore never
reveals the exact server heartbeat timestamp and never outlives its backing
row.

The Game Protocol 1 publisher and renderer consume the frozen protocol schema
and fixtures. Signed Game requests use a profile-specific replay/budget ledger,
a profile-qualified publication room, and a public row whose constrained shape
cannot be confused with classic metadata. Private Game requests retain only
minimal presence and delete that row. D1 also accounts for the exact canonical
JSON bytes of every public Game row and rejects an aggregate that cannot fit
the 262,144-byte protocol artifact. The independent
`GAME_PUBLISH_ENABLED` breaker still ships disabled, while Classic publishing
and rendezvous are enabled for supported Classic clients. The publisher remains
domainless in checked-in Wrangler configuration until the protected production
custom-domain attachment is read back. The Go
producer and Rust consumer foundations are released, including opaque origin
validator handling. Current Classic directories use schema
`atrinik-classic-directory-v6` / protocol 6; Game uses
`atrinik-game-directory-v2`. Both publish only `accessRequired` policy.
Historical [Classic v4](docs/classic-directory-v4.md) and
[v5](docs/classic-directory-v5.md) documents remain migration evidence.
`CLASSIC_DIRECTORY_CUTOVER_MODE=v4-production` or `v5-production` stages the new
Classic output under `canary-v6/`; only `v6-production` selects root aliases.
`GAME_DIRECTORY_CUTOVER_MODE=v1-production` stages Game under `canary-v2/`;
only `v2-production` selects root aliases. These staging defaults do not serve
historical formats. Any actual production cutover requires a separately reviewed
operator action. Static authority
attachment, cache rules, headers, CORS, CSP, custom-domain isolation, and
consumer cutover remain explicit service-split gates. R2's opaque strong ETag and alias upload
time satisfy the released validator/`Last-Modified` model only after the live
custom-domain canary confirms the public response.

## Observability

Automatic invocation logs are explicitly disabled. Deliberate custom logs are
limited to redacted `request_rejected`, `blacklist_match`, and
`unexpected_error` objects with closed, low-cardinality fields. Routine
success, expected `404`, rate-limit, and open-circuit traffic remains silent, so
a throttled loop does not replace automatic invocation noise with one custom
event per request.

For the `rendezvous` handler, `rendezvous_control_disconnected` identifies an
unclean close of the active server control, `rendezvous_control_error` a
transport error callback, and `rendezvous_handler_failure` a caught close/error
handler failure. Deliberate retirement, superseded controls, and clean closes
remain silent. These fixed codes omit peer close codes, reasons, exception text,
and identities; they cannot establish which network participant caused a reset.
The real Service Binding regression exercises edge-to-coordinator-to-room
signaling after an idle interval and control replacement. Room eviction tests
separately verify hibernation behavior; neither test reproduces a production
network interruption.

All three deployable configurations also explicitly disable tracing, Workers
Logpush, Tail/streaming-tail consumers, and OTLP destinations. Custom logs
remain persisted at full sampling for the bounded diagnostics above. Audit
account and zone Logpush jobs plus notification policies independently because
those account resources are not implied by a Worker script setting.

This setting changes stored log-event volume, not Worker invocation usage.
Cloudflare Worker Metrics and zone security analytics remain the sources for
aggregate request/status counts, errors, CPU time, wall time, duration, and WAF
mitigations. Durable Object metrics supply aggregate WebSocket connection and
message activity. Each accepted client session attempts at most one best-effort
write of an anonymous, bounded terminal summary to the
`atrinik_metaserver_rendezvous` Analytics Engine dataset; no room-admission
rejection or individual frame creates a custom point or room log. The schema
and sampling-correct query are documented in
[docs/privacy.md](docs/privacy.md). Each private builder reconciliation or
alarm also emits one best-effort fixed-schema point to
`atrinik_metaserver_directory`; the O(1) nudge emits no point. The schema
contains only profile, closed build/retention outcomes, count, bounded duration,
and a bounded cleanup count. Static client reads
are direct R2/cache traffic and create neither a Worker invocation nor a custom
builder point.

## License

This project is licensed under the [MIT License](LICENSE).
