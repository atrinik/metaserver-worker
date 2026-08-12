# Atrinik metaserver Worker

[![Check](https://github.com/atrinik/metaserver-worker/actions/workflows/check.yml/badge.svg)](https://github.com/atrinik/metaserver-worker/actions/workflows/check.yml)

This repository owns Atrinik's Cloudflare metaserver services for QUIC-only
game transport. The services publish discovery metadata and exchange bounded
connection candidates; they never proxy game traffic.

## Compatibility endpoints

The temporary compatibility Worker accepts only its configured authority and
exact legacy paths:

- `GET /` returns temporary service health.
- `GET /index.wsgi/otp` issues a tagged, single-use update token.
- `POST /index.wsgi/update` authenticates a server identity and updates its
  temporary classic directory record.
- `GET /v2/servers` returns protocol 3 XML.
- `GET /v2/rendezvous/:server-id?role=client|server` upgrades to a
  signaling-only WebSocket.

Every route has an independent emergency circuit breaker and bounded daily
budget. Directory, OTP, update, and rendezvous also have route-specific burst
limits; the temporary status route uses the global 10/minute ingress ceiling.
Non-canonical hosts, methods, paths, queries, and content fail before
application dispatch.
These routes remain only for the coordinated consumer cutover; they are not
aliases on the canonical publisher or rendezvous hosts.

The final hostname and route contract is documented in
[docs/routes.md](docs/routes.md). `meta.atrinik.org` and
`classic.meta.atrinik.org` become direct static directory origins;
`publish.meta.atrinik.org` and `rendezvous.meta.atrinik.org` are isolated
dynamic services.

The dynamic split is implemented as three deployable Workers. The existing
`atrinik-metaserver` core remains the sole owner of D1, R2, schedules, and the
`RendezvousRoom` and `DirectoryBuilder` Durable Objects. Domainless
`atrinik-metaserver-publisher` and `atrinik-metaserver-rendezvous` edge Workers
own only their route-specific breakers, source-tag secrets, and native burst
bindings, then call one named core entrypoint through a Service Binding. The
edges derive pseudonymous aliases and reconstruct a fixed allowlisted request,
so the raw request address and browser state never cross into the state owner;
the core independently validates the complete route and protocol again. The
checked-in edge configurations have no public route and both circuits disabled.

There is deliberately no TCP directory, DNS ownership proof, game-port probe,
or game relay. A server is owned by the SHA-256 identity derived from its
persistent QUIC certificate. The temporary publisher retains the classic
OTP/proof protocol; the final publisher folds freshness and identity proof into
one replay-safe signed request. Rendezvous server peers authenticate separately.

Rendezvous is one short, bounded signaling attempt, not a room-wide message
bus. A client is admitted only while one authenticated server-control socket is
live. A passwordless client's first and only `client_candidate` supplies a
fresh client-generated ticket; a protected client supplies it in `auth_init`.
The room binds the ticket to that socket and makes it single-use for the rolling
24-hour replay window. Only that socket receives matching server messages.
A protected attempt first relays exactly one `auth_init`, `auth_challenge`,
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

Password-protected listings accept clients only when both peers negotiate the
exact `atrinik-classic-rendezvous-invite-v1` WebSocket subprotocol. The Worker
relays a challenge/response for a random, expiring invite capability but never
receives the invite secret and never interprets the proof. The classic server
verifies the proof in constant time and returns only a generic authorization
result. The independent in-game join password remains mandatory after QUIC.

## Development

Use Node.js 20 or newer:

```sh
npm ci
npm run check
```

`npm run check` generates and verifies isolated core/publisher/rendezvous
Wrangler declarations, runs every TypeScript project, the local Workers runtime
tests, the Python administrative tests, and one distinct Wrangler dry run per
deployable. Generated declarations and `dist/` output are untracked and must
not be edited.

After an operator has separately provisioned an isolated R2 custom domain and
its reviewed edge rules, validate the public static contract with the
credential-free verifier:

```sh
python3 scripts/static_origin_canary.py \
  --profile game-v1 \
  --base-url https://game-directory-canary.example.org \
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
deployments, or owner resets merely to validate a change.

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
Wrangler's `exports` configuration. Its application SQLite admission ledger
retains at most 50 rows per room. A row records its acceptance time and, when
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
Ownership resets and blacklist changes should be generated with
`scripts/admin_sql.py`, reviewed, and only then applied by an authorized
operator.

See [DEPLOYMENT.md](DEPLOYMENT.md) for the release checklist.

## Request controls and privacy

For requests handled by the foundation Worker, newly observed raw addresses
remain request-scoped. New challenge and request-control writes use
purpose-separated, rotating HMAC tags with bounded retention; authenticated
stages use the server identity. Migration `0005_directory_state.sql` clears
historical owner/listing address columns, deletes private legacy listing rows,
and imports public rows without their former endpoint. Compatibility address
inputs remain accepted at the sunset wire boundary but are discarded; only a
signed, canonical DNS hostname is eligible for persistence. Canonical `xn--`
labels are checked with strict, non-transitional UTS #46 processing, including
STD3, hyphen, joiner, bidirectional, and DNS-length checks. Raw legacy
OTP/rate-limit columns and address blacklist policy remain governed by the
later signed-publisher compatibility-removal migration. No update infers a
QUIC endpoint from the HTTPS source.
The request path emits only the closed, redacted diagnostic events described in
[docs/privacy.md](docs/privacy.md).

Native rate bindings cap local bursts, D1 enforces exact fixed-window budgets,
and each per-server Durable Object enforces the exact 50-session rolling
24-hour ceiling before accepting a client. Rooms admit at most 16 active client
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
[docs/classic-directory-v4.md](docs/classic-directory-v4.md). Neither static
authority is attached by this code: direct-R2 cache, headers, CORS, CSP,
purge/removal behavior, custom-domain isolation, and consumer cutover remain
explicit service-split canary gates. R2's opaque strong ETag and alias upload
time satisfy the released validator/`Last-Modified` model only after the live
custom-domain canary confirms the public response.

## Observability

Automatic invocation logs are explicitly disabled. Deliberate custom logs are
limited to redacted `request_rejected`, `blacklist_match`, and
`unexpected_error` objects with closed, low-cardinality fields. Routine
success, expected `404`, rate-limit, and open-circuit traffic remains silent, so
a throttled loop does not replace automatic invocation noise with one custom
event per request.

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
