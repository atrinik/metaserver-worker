# Atrinik metaserver Worker

[![Check](https://github.com/atrinik/metaserver-worker/actions/workflows/check.yml/badge.svg)](https://github.com/atrinik/metaserver-worker/actions/workflows/check.yml)

This repository owns Atrinik's Cloudflare metaserver services for QUIC-only
game transport. The services publish discovery metadata and exchange bounded
connection candidates; they never proxy game traffic.

## Supported services

Classic v5.9.0 is the minimum supported metaserver consumer. The public API is
canonical-only:

- static Classic snapshots at `classic.meta.atrinik.org/index.{html,json,xml}`;
- signed Classic v1 publication at
  `publish.meta.atrinik.org/v1/classic/servers/{server-id}/publish` during the
  migration window, and fail-closed Classic v2 publication at
  `publish.meta.atrinik.org/v2/classic/servers/{server-id}/publish`;
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
own only their route-specific breakers, source-tag secrets, and native burst
bindings, then call one named core entrypoint through a Service Binding. The
edges derive pseudonymous aliases and reconstruct a fixed allowlisted request,
so the raw request address and browser state never cross into the state owner;
the core independently validates the complete route and protocol again. The
checked-in edge configurations have no public route and all dynamic circuits
disabled. The core exports scheduled handlers, Durable Objects, and named
Service Binding entrypoints only; it has no default `fetch` handler.

There is deliberately no TCP directory, DNS ownership proof, game-port probe,
or game relay. A server is owned by the SHA-256 identity derived from its
persistent QUIC certificate. Both publishers fold freshness and identity proof
into one replay-safe signed request. Rendezvous server peers authenticate
separately.

Rendezvous is one short, bounded signaling attempt, not a room-wide message
bus. A client is admitted only while one authenticated server-control socket is
live. An open client's first and only `client_candidate` supplies a fresh
client-generated ticket; an access-code-protected client supplies it in
`auth_init`.
The room binds the ticket to that socket and makes it single-use for the rolling
24-hour replay window. Only that socket receives matching server messages.
An access-code-protected attempt first relays exactly one `auth_init`, `auth_challenge`,
`auth_proof`, and `auth_result`; the authenticated current server control is
the only authority that may return `authorized: true`. No candidate is accepted
before that result. A session lasts at most 15 seconds and can forward at most
two client authorization frames, two server authorization frames, one client
candidate, 12 server candidates, and one completion. Every frame is at most 512
bytes and the complete accepted exchange is at most 9,216 bytes. Candidate endpoints are
never cached or persisted. A terminal transition immediately removes the raw
ticket and routing digest from the client attachment. If the transport close
itself fails, the already non-signaling socket normally receives at most four
explicit teardown retries over a fixed seven-second horizon. If persisting a
retry counter and closing both fail, the alarm fails into Cloudflare's bounded
platform retry policy instead of installing another alarm; neither path can
create a self-sustaining loop.

Retained v1 password-protected listings accept clients only when both peers negotiate the
exact `atrinik-classic-rendezvous-invite-v1` WebSocket subprotocol. The Worker
relays a challenge/response for a random, expiring invite capability but never
receives the invite secret and never interprets the proof. The classic server
verifies the proof in constant time and returns only a generic authorization
result. The independent v1 in-game join password remains mandatory after QUIC.
A v2 listing instead publishes only `accessCodeRequired`; the retained
invite-v1 wire exchange is internal access-code plumbing, and the Worker never
receives the launch code, rendezvous secret, or post-QUIC result.

## Development

Use the Node and npm versions pinned by `.nvmrc` and `packageManager`:

```sh
npm ci
npm run check
npm run deploy:production:dry-run
```

`npm run check` generates and verifies isolated core/publisher/rendezvous
Wrangler declarations, runs every TypeScript project, the local Workers runtime
tests, the Python administrative tests, and one distinct Wrangler dry run per
deployable. Generated declarations and `dist/` output are untracked and must
not be edited.

Every accepted push to protected `main` is the routine production
authorization. Cloudflare Workers Builds disables its implicit dependency
install, selects npm 11.16.0, installs with `npm ci`, and invokes the one
checked-in `npm run deploy:production` entrypoint; it does not wait for
a tag, release, second branch, GitHub environment, workflow dispatch, deploy
hook, or local operator command. The machine contract is
[`deployment/workers-builds-production.json`](deployment/workers-builds-production.json).
It validates protected production inputs, refuses migration/control-plane
drift, resolves all bundles before mutation, returns a verified no-op for
identical deployable input, rejects stale or competing builds, deploys directly
and strictly through a core/publisher/rendezvous disabled-circuit cohort,
restores callers before core, reads back each exact 100% phase and the final
coherent active topology, and runs bounded credential-free static and Service
Binding canaries. Newer eligible builds always supersede older ones, and child
processes receive only the credentials required for their role.

Production identifiers stay in bounded Cloudflare-owned secret configuration
documents, never in Git or logs. Runtime secret values remain provisioned in
Cloudflare and are not available to the routine build. Non-production branches use only the
zero-mutation dry run until the separately reviewed isolated-review contract
is enabled. See [DEPLOYMENT.md](DEPLOYMENT.md) for provider settings,
exceptional pauses, exact-SHA retry, partial failure, outage, revocation, and
manual escape procedures.

After an operator has separately provisioned an isolated R2 custom domain and
its reviewed edge rules, validate the public static contract with the
credential-free verifier:

```sh
python3 scripts/static_origin_canary.py \
  --profile game-v1 \
  --base-url https://game-directory-canary.example.org \
  --json
python3 scripts/static_origin_canary.py \
  --profile classic-v2 \
  --base-url https://classic-v5-directory-canary.example.org \
  --alias-prefix canary-v5 \
  --json
```

It performs only bounded public HTTPS requests. It verifies the three formats,
shared generation and complete normalized server-model parity, freshness,
native ETag and conditional retrieval, HEAD parity, security/cache/CORS
headers, canonical HTTPS root absence, path/query/method denial, and bounded
monotonic convergence. The separate ingress verifier proves plaintext
same-path redirects. Production hostnames require the additional
`--allow-production` acknowledgement. The verifier cannot
create, alter, or delete Cloudflare resources and accepts no API token.

The checked-in core Wrangler file has a placeholder D1 ID. All three checked-in
Wrangler files have no production route. Supply reviewed production bindings
during the provider-first deployment procedure. Never run remote migrations,
deployments, or identity resets merely to validate a change.

The Worker requires current and previous source-tag HMAC secrets. Their names
are declared in all three dynamic-service configurations; values belong only in
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

For public requests, newly observed raw addresses remain request-scoped.
Purpose-separated rotating HMAC tags protect coarse edge shields and the
canonical client pair cooldown; authenticated stages use the server identity.
Only a signed, canonical DNS hostname is eligible for persistence. Canonical `xn--`
labels are checked with strict, non-transitional UTS #46 processing, including
STD3, hyphen, joiner, bidirectional, and DNS-length checks. Migration
`0009_remove_legacy_storage.sql` physically removes retired ownership, OTP,
source-rate, shadow-directory, and wildcard-denial storage. No publish infers a
QUIC endpoint from the HTTPS source.
The request path emits only the closed, redacted diagnostic events described in
[docs/privacy.md](docs/privacy.md).

Native rate bindings cap local bursts. D1 enforces exact authenticated
publisher/server budgets and the canonical client's rolling source/server-pair
cooldown. Each per-server Durable Object preserves replay
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
heartbeats refresh presence without changing the revision. A private,
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
revision. This is required so empty and heartbeat-only directories do not
expire; the heartbeat itself still creates no build or R2 write. Each body is
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
`GAME_PUBLISH_ENABLED` breaker still ships disabled, and the publisher remains
domainless until the static-edge contract and live canary gates land. The Go
producer and Rust consumer foundations are released, including opaque origin
validator handling. Classic protocol 4 is specified in
[docs/classic-directory-v4.md](docs/classic-directory-v4.md); Classic v2
protocol 5 is specified in
[docs/classic-directory-v5.md](docs/classic-directory-v5.md). With
`CLASSIC_DIRECTORY_CUTOVER_MODE=v4-production`, v5 writes only below the
non-production `canary-v5/` prefix and cannot replace v4 aliases. The one-way
`v5-production` setting reverses the active and pre-cutover namespaces only
after explicit human canary acceptance. Static authority
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
