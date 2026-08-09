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
   validated DNS hostname and UDP port. Numeric compatibility endpoints are
   accepted only to preserve the old request shape and are discarded.
5. Signed publication stores the public certificate-bound server ID, visible
   listing fields, the last accepted unsigned-64 sequence, bounded random nonce
   values until expiry, and non-secret commit/fingerprint/revision values. The
   certificate is authenticated from the request body but is not persisted.
   Signatures, signature inputs, request bodies, private key material, and
   returned rendezvous tokens are never written to logs or durable storage;
   only the token's SHA-256 verifier is stored in minimal profile presence,
   separately from renderable public directory metadata. Private publication
   retains that verifier and generation but no listing or endpoint, and neither
   rendezvous role is admitted without a fresh public directory row.
6. Static R2 artifacts contain only the bounded public directory model plus a
   profile, schema, generation, freshness timestamps, body sizes, and keyed-by-
   content SHA-256 values. The D1 revision and outbox are builder-private and
   never appear in a body, object key, HTTP metadata, or custom metadata.

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

Migration `0005_directory_state.sql` creates profile-keyed minimal
`server_presence` and public-only `directory_entries` tables. It imports every
classic presence credential but only public directory rows, intentionally
drops every historical direct endpoint during the import, clears every
`server_owners.current_ip` and `servers.source_ip`, and deletes private legacy
rows. New compatibility writes keep the public legacy rollback shadow
addressless; private writes delete it. A missing direct hostname remains NULL
in canonical state, and the HTTPS request address is never inferred.

The old raw-source OTP and rate-limit columns remain during the compatibility
window, as do request-address blacklist patterns. After rollback to the old
writer is impossible, the ordered compatibility-removal migration must remove
those tables, columns, and policies after their retention and WAF gates.
Physical removal—not merely empty sentinels—is required before declaring final
schema completion.

The signed replay ledger stores canonical decimal sequences as text because
SQLite cannot represent the complete unsigned 64-bit range. Nonces are scoped
by server ID and publisher profile, expire after the fixed replay window, and
are pruned by scheduled maintenance. Sequence rows deliberately remain for the
life of an identity so a stale state backup cannot lower replay protection.
The server can consume the authenticated `minimumNextSequence` response to
advance its protected local high-water mark; it never deletes or replaces its
identity as a recovery shortcut.

Stable server-ID blacklist entries remain the application policy. During the
transition, existing raw-address glob entries can still be evaluated against a
request-scoped address, but the address and matching pattern/reason are not
written or logged. Move operational address/CIDR rules to Cloudflare WAF before
removing that compatibility lookup and its raw patterns.

## Static artifact state

Migration `0006_directory_artifacts.sql` adds one fixed checkpoint and commit
marker per profile plus at most eight acknowledged generation/timestamp rows.
The checkpoint and rollback ledger store only revision/generation/timestamps,
representation sizes, and SHA-256 values; they store no listing field or actor
identifier. The D1 outbox coalesces transactionally to at most its newest row
per profile because old revisions cannot reconstruct historical models.

The profile-named builder Durable Object stores one version number, a
generation high-water mark, an opaque bounded cleanup cursor, and at most one
pending build containing a random local token, revision, generation, freshness
times, and model digest. It never
stores a server ID, listing field, hostname, source tag, credential, ticket, or
candidate. The private R2 bucket uses only
`v1/<profile>/<generation>/<fixed-name>` keys. The public buckets contain only
the fixed `index.html`, `index.xml`, `index.json`, and `manifest.json` aliases.
Custom metadata is an exact allowlist of schema, profile, format, generation,
freshness, model/body digest, and desired strong ETag.

The latest eight D1-acknowledged four-object immutable cohorts form the
application rollback window. A durable paginated sweep removes at most 64
unacknowledged, older, or partial system-shaped objects per reconciliation,
and a separate 30-day lifecycle rule on only the private bucket's exact `v1/`
prefix provides defense in depth. The application never selects unknown keys
or malformed generation paths for deletion; the prefix lifecycle may expire
them after 30 days.
No lifecycle rule applies to a public alias bucket. Direct custom domains and
public development URLs remain disabled until the cache/header/removal canary.

The public `expiresAt`/`expires-at` value is conservatively rounded down to a
15-minute boundary, and membership expires on the same boundary. It is not the
exact `last_seen + TTL` value and cannot be subtracted to recover an exact
heartbeat timestamp.

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
`atrinik_metaserver_rendezvous` with this fixed `rendezvous-session-v2`
layout:

| Field | Meaning |
| --- | --- |
| `index1` | `rendezvous-session-v2:<outcome>` |
| `blob1` | schema name `rendezvous-session-v2` |
| `blob2` | closed terminal outcome |
| `double1` | session count, always `1` |
| `double2` | accepted client frames, `0..3` |
| `double3` | matched server frames, `0..15` |
| `double4` | forwarded frames, `0..18` |
| `double5` | accepted signaling bytes, `0..9,216` |
| `double6` | bounded duration in milliseconds, `0..15,000` |

The closed outcomes are `completed`, `client_disconnected`,
`session_expired`, `protocol_error`, `server_unavailable`, `server_replaced`,
`authorization_failed`, and `internal_error`. There is no address, source tag,
server identity, connection identity, ticket, credential, candidate, exception text, or
free-form close reason in the schema. The at-most-one-point-per-accepted-session
rule also bounds this custom stream to at most 50 terminal-summary attempts per
server in a rolling day. Zone `101` counts remain the authority for
finding a missing best-effort terminal point.

The production `DIRECTORY_METRICS` target is
`atrinik_metaserver_directory`; a canary uses only
`atrinik_metaserver_directory_canary`. Each scheduled or alarm reconciliation
attempts one best-effort `directory-build-v1` point:

| Field | Meaning |
| --- | --- |
| `index1` | `directory-build-v1:<profile>:<outcome>:<cleanup>` |
| `blob1` | schema name `directory-build-v1` |
| `blob2` | `classic-v1` or `game-v1` |
| `blob3` | `current`, `published`, or `failed` |
| `blob4` | retention cleanup `current` or `deferred` |
| `double1` | invocation count, always `1` |
| `double2` | duration in milliseconds, `0..300,000` |
| `double3` | immutable objects deleted, `0..64` |

There is no revision, generation, server count, server identity, hostname,
object key, digest, exception, or R2/D1 value in this schema. A metrics write
failure cannot change builder state or publication outcome. Static client reads
bypass the Worker and create no custom metric point.

```sql
SELECT
  blob2 AS profile,
  blob3 AS outcome,
  blob4 AS cleanup,
  SUM(_sample_interval * double1) AS reconciliations,
  SUM(_sample_interval * double2) AS total_duration_ms,
  SUM(_sample_interval * double3) AS deleted_objects
FROM atrinik_metaserver_directory
WHERE blob1 = 'directory-build-v1'
  AND timestamp > NOW() - INTERVAL '1' DAY
GROUP BY blob2, blob3, blob4
ORDER BY profile, outcome, cleanup
```

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
WHERE blob1 = 'rendezvous-session-v2'
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

The first passwordless client candidate or protected `auth_init` carries a
fresh client-generated 64-hex ticket. The
room retains the raw ticket beyond the frame currently being validated or
forwarded only in that client's compact, versioned WebSocket attachment for the
at-most-15-second connection. The authenticated server socket's attachment
keeps its random control ID, non-secret token-generation ID, and opening time
plus, for each live attempt, the ticket's SHA-256 routing digest, a random
client connection ID, opening/expiry times, and bounded stage/frame/byte
counters. The client attachment carries the same generation ID so admission
and signaling cannot cross a publish-time credential rotation. A terminal
client attachment
retains only those non-routing counters, its random local IDs/timestamps, the
closed outcome enum, summary marker, and a bounded close-attempt counter: its
raw ticket and digest are cleared as part of the terminal transition. Live
routing state survives
hibernation, but it is not the 24-hour replay ledger and is removed at the
session deadline. Only non-routing terminal metadata can outlive that deadline
when the platform transport refuses to close. Every attachment is strictly
decoded and remains below Cloudflare's
[16,384-byte attachment ceiling](https://developers.cloudflare.com/durable-objects/best-practices/websockets/#websocketserializeattachment).

Invite IDs, invite secrets, expiry values, challenges, proofs, and serialized
authorization frames are processed only in the current bounded event and are
never stored in a hibernation attachment, Durable Object table or key-value
entry, D1, log, or metric. Attachments retain only the authorization stage and
bounded counters. The Worker never receives the invite secret and cannot
interpret the proof; only the authenticated current classic server control can
authorize the exact ticket.

Each successful publish creates a fresh random 64-hex, non-secret
rendezvous generation alongside the new bearer-token hash. D1 stores both in
profile-scoped minimal presence; the legacy owner generation remains only a
temporary compatibility transaction guard. A private publish deletes its
public directory row and retires the room while retaining the verifier promised
by the successful response contract. The per-server
Durable Object serializes the complete commit, checks the caller's prior D1
generation, persists the next generation under the fixed
`rendezvous:token-generation` key, retires all older controls and clients, and
then writes the D1 transaction in one batch. A concurrent request with a stale prior
generation cannot overwrite the winner. If a batch result is ambiguous, the
room verifies the exact owner/presence/directory state and otherwise reconciles
itself to the profile presence's authoritative generation before returning an
error.
The value is an unlinkable room-local epoch marker, not a credential, address,
ticket, or actor identifier. Message handling and reconstruction compare it
before trusting any attachment, so a transport that could not be closed cannot
continue signaling. The raw bearer token never enters Durable Object storage.

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
valid passwordless client candidate or protected `auth_init` derives and
atomically claims both aliases; the same
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

Every compatibility update is stored addressless: its numeric `quic_host` and
port are discarded, and the directory omits both `Address` and `Port` rather
than substituting the request source. Such a record is joinable only through
rendezvous. Signed publication may add an operator-configured, strictly
validated optional DNS hostname/UDP port pair. That endpoint is public routing
metadata even when `PasswordRequired` is true; it is not identity. Clients
still pin the QUIC certificate. Canonical `xn--` labels must round-trip through
the protocol's strict non-transitional UTS #46 profile; Unicode U-labels and
malformed or bidi-invalid A-labels fail before persistence. The Worker never
resolves the hostname or stores its A/AAAA answers.

The compatibility room routes server candidates only to the client socket that
originated their fresh ticket. Admission also requires a currently live server
control authenticated with the listing's rendezvous token. That server-control
proof is deliberately separate from a player's game password. A protected
listing requires both peers to negotiate the exact classic invite subprotocol,
then completes a single high-entropy invite challenge/response before the
current authenticated server control can authorize that ticket. Unknown,
expired, revoked, malformed, and incorrect capabilities receive the same
generic denial from the classic server. The Worker never receives the invite
secret, and the normal in-game join password remains required after QUIC.
Transient QUIC candidates are therefore not exposed merely because a client
knows a listed server identity.

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
