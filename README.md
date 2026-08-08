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

`npm run check` runs TypeScript checks, the local Workers runtime tests, the
Python SQL-generator tests, and a Wrangler dry-run. Generated output belongs in
`dist/` and must not be edited.

The checked-in Wrangler file has a placeholder D1 ID and no production route.
Supply reviewed production bindings during the deployment procedure. Never run
remote migrations, deployments, or owner resets merely to validate a change.

The Worker requires current and previous source-tag HMAC secrets. Their names
are declared in `wrangler.jsonc`; values belong only in Cloudflare encrypted
secrets or ignored `.dev.vars` files. See [docs/privacy.md](docs/privacy.md) for
rotation and retention rules. Consecutive key pairs must overlap for strictly
more than the 24-hour rendezvous replay window. Do not substitute plaintext
Wrangler variables.

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
key-value storage, hibernation attachments, logs, or metrics. The D1 owner and
listing rows, the room's fixed key-value marker, and both attachment roles
retain only the same random, non-secret token-generation ID needed to
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
stages use the server identity. The additive migration does not erase dormant
historical owner/listing values: the next accepted publish clears those legacy
columns for that server, while a later ordered sanitization migration owns any
remaining dormant rows. No update infers a QUIC endpoint from the HTTPS source.
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
[docs/privacy.md](docs/privacy.md). Directory hosts that are later moved to
direct static storage should be monitored as storage/cache traffic rather than
Worker traffic.

## License

This project is licensed under the [MIT License](LICENSE).
