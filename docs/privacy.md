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
3. QUIC candidates are transient WebSocket message data and are not persisted
   by the Worker. The current compatibility room validates role and message
   shape, but broadcasts a server candidate to every connected client in that
   server's room; it does not yet enforce ticket-scoped delivery or gate
   disclosure on game-password authorization. Issues #19 and #20 own those
   target guarantees.
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
tag rows before retiring the key. Install alias-aware code and the overlap key
before changing which key is current. Consecutive deployments must share one
key; disjoint key sets cannot reconstruct one exact history. New short-lived
OTP rows persist both issuer aliases. An `A/Z` issuer therefore stores `A` and
`Z`, while a `B/A` issuer stores `B` and `A`; either deployment can consume
either token through the shared `A` alias. Shared means the exact same key ID,
secret, hostname namespace, purpose, and derivation contract. Initial
provisioning supplies two independent keys so the same tested overlap path is
always exercised.

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
- server authentication material, signatures, nonces, or rendezvous tokens;
- candidate endpoints;
- blacklist patterns; or
- operator-supplied/free-form reasons.

Aggregate request/status counts remain visible in Worker Metrics and WAF
analytics; lowering log volume does not lower invocation usage.

## Directory and rendezvous boundary

A public compatibility record without an explicit `quic_host` is already
rendered with an empty address rather than the request source. Supported client
work must make that record joinable through rendezvous before this behavior is
deployed broadly. The final schema replaces the compatibility field with a
strictly validated optional DNS hostname. That hostname is routing metadata,
not identity: clients still pin the QUIC certificate, and the Worker never
resolves it or stores its A/AAAA answers.

Candidate exchange is already transient, but the current compatibility room is
not a confidentiality boundary between clients connected to the same server
room. The rendezvous hardening work must route server candidates only to the
requesting ticket and complete password authorization before disclosure; those
are target-state requirements, not claims about the compatibility room.

Overwriting or deleting current rows does not immediately erase recoverable
history. D1
[Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) is
always enabled on the production storage backend and retains point-in-time
history for the account's plan-specific window (currently up to 7 days on
Workers Free and 30 days on Workers Paid). Retained Workers Logs and manual
exports have independent lifetimes. Record when the final live value was
sanitized, let every applicable retention window expire, and apply the same
deletion policy to exports before claiming historical raw values are gone.
