# Request-source and endpoint privacy

The metaserver minimizes stored request metadata; it does not promise endpoint
anonymity. A client that establishes a direct QUIC connection necessarily
learns a selected peer endpoint.

## Data classes

1. For requests processed by the foundation Worker, a newly observed source
   address exists only while handling that request. It may be compared with a
   transitional blacklist rule or legacy challenge, but it is not written to a
   new row or application diagnostic.
2. Anonymous abuse correlation uses a purpose-separated, keyed HMAC tag with a
   bounded retention window.
3. QUIC candidates are transient, validated WebSocket message data. A candidate
   is forwarded only between the authenticated live server-control socket and
   the client socket bound to its single-use ticket. Candidate addresses are
   never serialized into a WebSocket attachment or written to Durable Object
   SQLite, D1, KV, R2, Analytics Engine, or an application log.
4. The final direct-directory fallback stores only an operator-published,
   validated DNS hostname and UDP port. The compatibility schema temporarily
   retains its existing explicit `quic_host` field while consumers migrate.

Neither an unkeyed IP digest nor a raw IP is an acceptable durable actor key.
IPv4 is enumerable, and a single cross-purpose pseudonym would unnecessarily
make unrelated activity linkable.

## Source tags

The Worker requires two 32-byte base64url secrets through encrypted bindings:

- `SOURCE_TAG_KEY_CURRENT`
- `SOURCE_TAG_KEY_PREVIOUS`

Their public rotation labels are `SOURCE_TAG_KEY_CURRENT_ID` and
`SOURCE_TAG_KEY_PREVIOUS_ID`. Tag input is UTF-8 and domain separated:

```text
atrinik-metaserver\0source-tag\0v1\0<deployment-hostname>\0<purpose>\0<canonical-address>
```

The source/server-pair purpose appends the canonical 64-hex server identity.
The configured compatibility hostname separates production, canary, and local
domains even if an operator accidentally reuses key material; operators must
still provision independent secrets for every environment. Current and previous
key IDs and secrets must be distinct; malformed or duplicated material fails
request admission closed.
The stored tag is versioned and contains only the key label plus base64url
HMAC-SHA-256 output; it never contains the address. Purposes are a closed set
covering global ingress, each compatibility route, canonical publishing, and
the distinct rendezvous actor dimensions.

Every request checks both current and previous tags while rotation overlap is
active. Fixed-window admission mirrors one logical counter into both alias rows
with one D1 statement; a missing current alias inherits the previous count
without charging twice. During a rolling `A/Z` to `B/A` deployment, either
version advances its overlapping pair from the maximum equal-expiry count.
This conservatively heals the lagging alias while charging each request once;
an expiry/window mismatch still fails closed.

Retain the previous key for at least the longest live budget window plus
deployment propagation, rotate at a UTC budget boundary, and remove expired
tag rows before retiring the key. The rendezvous replay ledger makes the
overlap requirement explicit: consecutive deployed pairs must share one exact
key for strictly more than 24 hours after every old-pair writer has stopped.
Install alias-aware code and the overlap key before changing which key is
current. Disjoint key sets cannot reconstruct one exact history. New
short-lived OTP rows persist both issuer aliases. An `A/Z` issuer therefore
stores `A` and `Z`, while a `B/A` issuer stores `B` and `A`; either deployment
can consume either token through the shared `A` alias. A rendezvous row claimed
under `A/Z` likewise collides with a replay checked under `B/A` through its
shared `A` alias. Shared means the exact same key ID, secret, hostname
namespace, purpose, and derivation contract. Initial provisioning supplies two
independent keys so the same tested overlap path is always exercised.

## Compatibility state

New compatibility challenge and request-budget writes use only keyed tags. A
new OTP row has an empty legacy `source_ip` sentinel and exactly two distinct
aliases in `source_tag` and `source_tag_previous`; consumption matches either
stored alias against either request alias. The additive migration leaves the
old column in place and accepts an already-issued legacy raw-source challenge
for at most its remaining TTL. The atomic `DELETE ... RETURNING` is the
one-time-consumption boundary, and a wrong source does not burn the token.
The pair intentionally links the two rotation pseudonyms only for the OTP's
short lifetime and cleanup retention; it is never reused across purposes.

Compatibility updates write empty sentinels into the unused
`server_owners.current_ip` and `servers.source_ip` columns. The next accepted
publish for a server therefore clears an older value in both of that server's
live rows. Migration `0002_request_control.sql` is additive, however: it does
not rewrite historical owner or listing rows. A dormant ownership row remains
unchanged indefinitely because scheduled maintenance does not delete ownership
state; a dormant listing keeps its value until the next accepted publish or
until bounded stale-listing cleanup deletes the row. Deployment of the
foundation Worker must consequently be described as preventing new raw-source
writes, not as erasing every raw value already present in D1.

A missing `quic_host` now remains empty; the HTTPS request address is never
inferred as the public QUIC endpoint. After rollback to the old writer is
impossible, an ordered sanitization migration must clear every remaining
non-empty owner/listing sentinel, remove expired legacy raw-source challenges
and counters, and verify the live tables contain no such values. Physical
removal of the legacy columns and OTP table remains gated on the single-request
signed publisher and consumer cutover.

Stable server-ID blacklist entries remain the application policy. During the
transition, existing raw-address glob entries can still be evaluated against a
request-scoped address, but the address and matching pattern/reason are not
written or logged. Move operational address/CIDR rules to Cloudflare WAF before
removing that compatibility lookup and its raw patterns.

## Logs and metrics

Automatic invocation logs are disabled. The deliberately retained custom
diagnostics have closed, low-cardinality schemas:

- `request_rejected`: closed route, public error code, and fixed status;
- `blacklist_match`: the fixed update route and only the closed match dimension
  (`server_identity` or `request_source`); and
- `unexpected_error`: closed handler/internal code and, when applicable, the
  closed request-control dependency name.

Routine success, expected `404`, rate-limit, and open-circuit traffic emits no
custom event. This avoids recreating an invocation-sized log stream for the
highest-volume outcomes. Every diagnostic keeps the following data out of
application logs:

- source addresses or source tags;
- rendezvous replay aliases or Durable Object room IDs;
- server authentication material, signatures, nonces, or rendezvous tokens;
- candidate endpoints;
- blacklist patterns; or
- operator-supplied/free-form reasons.

Aggregate request/status counts remain visible in Worker Metrics and WAF
analytics; lowering log volume does not lower invocation usage.

The production `RENDEZVOUS_METRICS` target is
`atrinik_metaserver_rendezvous`. A canary must instead bind it to the separate
`atrinik_metaserver_rendezvous_canary` dataset and run the query below against
that dataset, as required by
[the deployment runbook](../DEPLOYMENT.md).

Rendezvous attempts at most one best-effort custom metric write for each
accepted client session and no custom point for rejected room admissions or
individual frames. The
`RENDEZVOUS_METRICS` Analytics Engine binding writes to
`atrinik_metaserver_rendezvous` with this fixed `rendezvous-session-v1`
layout:

| Field | Meaning |
| --- | --- |
| `index1` | `rendezvous-session-v1:<outcome>` |
| `blob1` | schema name `rendezvous-session-v1` |
| `blob2` | closed terminal outcome |
| `double1` | session count, always `1` |
| `double2` | accepted client frames, `0..1` |
| `double3` | matched server frames, `0..13` |
| `double4` | forwarded frames, `0..14` |
| `double5` | accepted signaling bytes, `0..7,168` |
| `double6` | bounded duration in milliseconds, `0..15,000` |

The closed outcomes are `completed`, `client_disconnected`,
`session_expired`, `protocol_error`, `server_unavailable`, `server_replaced`,
and `internal_error`. There is no address, source tag, server identity,
connection identity, ticket, credential, candidate, exception text, or
free-form close reason in the schema. The at-most-one-point-per-accepted-session
rule also bounds this custom stream to at most 50 terminal-summary attempts per
server in a rolling day. Zone `101` counts remain the authority for
finding a missing best-effort terminal point.

[Analytics Engine can sample rows](https://developers.cloudflare.com/analytics/analytics-engine/sampling/).
This is the canonical sampling-weighted operational query; change only the time
window or add closed outcome filters:

```sql
SELECT
  blob2 AS outcome,
  SUM(_sample_interval * double1) AS sessions,
  SUM(_sample_interval * double2) AS client_frames_accepted,
  SUM(_sample_interval * double3) AS server_frames_matched,
  SUM(_sample_interval * double4) AS frames_forwarded,
  SUM(_sample_interval * double5) AS accepted_signal_bytes,
  SUM(_sample_interval * double6) AS total_duration_ms
FROM atrinik_metaserver_rendezvous
WHERE blob1 = 'rendezvous-session-v1'
  AND timestamp > NOW() - INTERVAL '1' DAY
GROUP BY blob2
ORDER BY sessions DESC
```

Zone security analytics and Worker metrics remain the authorities for requests,
status codes, WAF mitigations, and Worker failures.
[Built-in Durable Object metrics](https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/#websocket-metrics)
provide aggregate connections and raw WebSocket message counts. In this
document, “raw frame” means that aggregate count; no candidate frame body is
copied into a custom metric or log.

## Rendezvous transient state

The first client candidate carries a fresh client-generated 64-hex ticket. The
room retains the raw ticket beyond the frame currently being validated or
forwarded only in that client's compact, versioned WebSocket attachment for the
at-most-15-second connection. The authenticated server socket's attachment
keeps its random control ID and opening time plus, for each live attempt, the
ticket's SHA-256 routing digest, a random client connection ID, opening/expiry
times, and bounded stage/frame/byte counters. A terminal client attachment
retains only those non-routing counters, its random local IDs/timestamps, the
closed outcome enum, summary marker, and a bounded close-attempt counter: its
raw ticket and digest are cleared as part of the terminal transition. Live
routing state survives
hibernation, but it is not the 24-hour replay ledger and is removed at the
session deadline. Only non-routing terminal metadata can outlive that deadline
when the platform transport refuses to close. Every attachment is strictly
decoded and remains below Cloudflare's
[16,384-byte attachment ceiling](https://developers.cloudflare.com/durable-objects/best-practices/websockets/#websocketserializeattachment).

The exceptional case where both attachment persistence and transport close
fail writes one fixed boolean recovery-quarantine flag to Durable Object
key-value storage. The flag contains no ticket, digest, connection or control
ID, terminal outcome, address, timestamp, or counter. A surviving instance
first retries its bounded in-memory outcome; after reconstruction, the generic
flag instead retires every server attachment, scrubs every decodable client
attachment, closes all room sockets, and marks terminal summaries as suppressed
because the original outcome cannot be recovered safely. The flag is deleted
only after every socket is either durably non-routing or transport-closed.

Each accepted client reserves one row in the per-room Durable Object SQLite
admission ledger. Apart from its local numeric row ID, its application fields
are `accepted_at_ms` and exactly two nullable replay-alias columns. The first
valid client candidate derives and atomically claims both aliases; the same
transaction rejects a collision against either column before forwarding the
candidate. A room retains no more than 50 rows and deletes every row whose
acceptance time is at or before the rolling 24-hour cutoff.

The aliases are versioned HMAC-SHA-256 values derived with the current and
previous source-tag keys over this purpose-separated domain:

```text
atrinik-metaserver\0rendezvous-ticket-replay-tag\0v1\0<canonical-deployment-hostname>\0<opaque-durable-object-room-id>\0<client-ticket>
```

That scope prevents the same ticket from becoming a cross-environment or
cross-room pseudonym. Although it reuses the managed source-tag key ring, this
purpose contains no request source address and is not an abuse-correlation tag.
SQLite never receives the raw ticket, its unkeyed SHA-256 routing digest, a
connection ID, candidate address, frame counter, or credential. Testing a
guessed ticket against an alias requires the corresponding HMAC secret. The
client protocol requires 32 random bytes encoded as 64 lowercase hex
characters; the Worker enforces that shape and single use but cannot prove the
entropy of a peer-supplied ticket.

One Durable Object alarm represents the earliest unfinished client/ticket
deadline, which is never more than 15 seconds after admission, and the earliest
retained admission expiry. Hibernation attachments restore only the bounded
live routing state after eviction; the SQLite aliases preserve replay rejection
across server disconnect/reconnect and object reconstruction without a timer or
process-local replay cache. A terminal transition is the end of signaling even
if the physical close fails. Such a socket normally receives at most four
explicit teardown retries at the deadline and one, three, and seven seconds
afterward; exhaustion creates no further application alarm and raw ticket state
has already been removed. If both the compact retry-counter write and transport
close fail, the alarm throws. Cloudflare may then retry that failed alarm with
[bounded exponential backoff](https://developers.cloudflare.com/durable-objects/api/alarms/)
(currently up to six retries), but the room never installs a replacement alarm
for the unpersisted alarm attempt. A non-alarm teardown double failure first
persists the generic recovery quarantine and installs one immediate alarm. The
same instance can preserve its bounded outcome intent; a reconstructed instance
uses fail-closed room-wide cleanup and emits no guessed terminal summary.

Do not cache or replay rendezvous tickets or candidates in a client, Worker,
Durable Object table, D1, KV, R2, or intermediary. They describe one fresh UDP
socket, NAT mapping, and punch attempt. A directory representation may be
cached, and a client may debounce duplicate UI actions or back off after a
failed attempt, but every connection attempt must create a fresh socket and
ticket and perform new authorized signaling.

## Directory and rendezvous boundary

A public compatibility record without an explicit `quic_host` is already
rendered with an empty address rather than the request source. Supported client
work must make that record joinable through rendezvous before this behavior is
deployed broadly. The final schema replaces the compatibility field with a
strictly validated optional DNS hostname. That hostname is routing metadata,
not identity: clients still pin the QUIC certificate, and the Worker never
resolves it or stores its A/AAAA answers.

The compatibility room routes server candidates only to the client socket that
originated their fresh ticket. Admission also requires a currently live server
control authenticated with the listing's rendezvous token. That server-control
proof is deliberately separate from a player's game password: until issue #20
implements the bounded password authorization exchange, a password-protected
listing fails client rendezvous closed with a retryable `503` and
`Retry-After: 300`. Transient QUIC candidates are therefore not exposed merely
because a client knows a listed server identity.

Overwriting or deleting current rows does not immediately erase recoverable
history. D1
[Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) is
always enabled on the production storage backend and retains point-in-time
history for the account's plan-specific window (currently up to 7 days on
Workers Free and 30 days on Workers Paid). Retained Workers Logs and manual
exports have independent lifetimes. Record when the final live value was
sanitized, let every applicable retention window expire, and apply the same
deletion policy to exports before claiming historical raw values are gone.

[SQLite-backed Durable Objects have a separate 30-day point-in-time recovery
history](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api).
That history may retain an expired row's acceptance time and two opaque replay
aliases after the live ledger prunes it. It still contains no raw ticket,
unkeyed ticket digest, connection ID, candidate address, credential, or outcome.
The aliases require their corresponding HMAC secret for a guessed-ticket check.
The protocol requires random 256-bit inputs, although the Worker cannot verify
peer entropy, and the aliases remain recoverable keyed pseudonyms for the
platform retention window. Record pruning and key
rotation times and do not claim immediate historical erasure. PITR retention
does not extend the live replay window: enforcement stops using a row as soon
as it is pruned at the 24-hour cutoff.
