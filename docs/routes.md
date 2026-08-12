# Metaserver route contract

Route versions describe HTTP deployment contracts. They are independent of
the version carried inside a directory representation or game protocol.

## Compatibility service

During the coordinated classic cutover, the compatibility Worker accepts only
the configured `COMPAT_HOSTNAME` authority (currently `meta.atrinik.org`) and
these exact requests:

| Method | Path | Query | Purpose |
| --- | --- | --- | --- |
| `GET` | `/` | none | temporary public health response |
| `GET` | `/index.wsgi/otp` | none | temporary classic publish challenge |
| `POST` | `/index.wsgi/update` | none | temporary classic publish update |
| `GET` | `/v2/servers` | none | temporary dynamic classic directory |
| `GET` | `/v2/rendezvous/{server-id}` | exactly `role=client` or `role=server` | temporary classic rendezvous |

Every compatibility route is independently circuit-breaker controlled and has
a daily budget. The temporary status route uses the global ingress burst; the
other routes also have narrower route-specific bursts. They are not aliases
for the canonical service hosts and never redirect authenticated requests or
WebSocket upgrades. After supported classic consumers move, these routes are
removed before `meta.atrinik.org` becomes a static Game Protocol 1 origin.

## Canonical services

The shared classifier freezes the following dynamic route envelope before
publisher and rendezvous handlers are exposed:

| Authority | Method | Path | Request contract |
| --- | --- | --- | --- |
| `publish.meta.atrinik.org` | `POST` | `/v1/servers/{server-id}/publish` | exact Game Protocol 1 signed publisher envelope, body required and at most 4,096 bytes; independently circuit-disabled by `GAME_PUBLISH_ENABLED` until rollout |
| `publish.meta.atrinik.org` | `POST` | `/v1/classic/servers/{server-id}/publish` | exact `application/json`, no query or content encoding, body required and at most 4,096 bytes |
| `rendezvous.meta.atrinik.org` | `GET` WebSocket | `/v1/servers/{server-id}?role=client\|server` | no body or content headers; exactly one `role` query |
| `rendezvous.meta.atrinik.org` | `GET` WebSocket | `/v1/classic/servers/{server-id}?role=client\|server` | no body or content headers; exactly one `role` query |

The checked-in service-boundary foundation does not attach those authorities.
The publisher and rendezvous edge Workers start domainless and disabled. Each
edge rejects every other host/method/path/query/body shape, derives only the
route-specific pseudonymous admission aliases, strips raw request-source and
browser headers, and calls one named core Worker entrypoint. The core parses the
same canonical contract again before authentication, D1, or Durable Object
work. The Service Binding is private routing and is not an alias, redirect, or
additional public URL. Compatibility routes remain on the core until the
coordinated consumer cutover; static directory authorities never pass through
any Worker.

`server-id` is exactly 64 lowercase hexadecimal characters. The publisher
payload and signature fields are owned by the signed-publishing contract; the
route classifier does not parse or authenticate them.

### Signed publishers

The classic and Game endpoints implement `atrinik-classic-publish-v1` and
`atrinik-game-publish-v1` from the protocol repository. Each profile has an
exact canonical JSON schema, signature tag, path, replay ledger, daily budget,
presence row, public row shape, and serialized publication-room identity. A
valid signature or sequence from one profile is unusable in the other. Both
require an RFC 9530 `Content-Digest` and an `ecdsa-p256-sha256` HTTP message signature
made by the private P-256 key paired with the exact DER certificate whose
SHA-256 fingerprint is `server-id`. The covered components, their order,
signature parameters, canonical JSON property order, timestamp window, and
raw P1363 signature encoding are exact protocol bytes rather than values the
Worker normalizes.

Every attempt carries a nonzero random 128-bit nonce and a canonical unsigned
64-bit sequence. The profile-qualified Durable Object serializes replay
admission, generation rotation, and the D1 publication. It commits only a sequence
strictly greater than the prior one and a nonce unused in the retention
window. A stale/equal sequence or reused nonce returns `409` with
`publish_replay` and a non-secret `minimumNextSequence`; the rejected
request does not rotate the rendezvous token, refresh presence, or enqueue a
directory revision. A successful unchanged heartbeat refreshes presence and
rotates the rendezvous generation but does not advance the visible directory
revision. A visible field change or public/private transition advances it
exactly once.

Successful responses contain the new server-role rendezvous token and use
`Cache-Control: no-store`. Replay responses are also `no-store`. Clients
must not follow redirects for a signed publish because authority and path are
covered by the signature. The compatibility OTP/update routes remain
independent during the rollback window and cannot authenticate an identity
after its first accepted signed publication upgrades that owner.

The two directory authorities are static origins and are never accepted by a
dynamic Worker:

- `meta.atrinik.org`: `/`, `/index.html`, `/index.xml`, and `/index.json` for
  Game Protocol 1.
- `classic.meta.atrinik.org`: the same four paths for the classic generation.

The current implementation builds those fixed aliases in isolated R2 buckets,
but this foundation release does not attach either authority. Game JSON/XML
follow the protocol-owned `atrinik-directory-v1` version 2 fixtures, keep body
SHA-256 independent from the public origin validator, and accept non-empty
state only through the signed Game publisher. Classic JSON/XML follow
[classic directory protocol 4](classic-directory-v4.md). The later service
split canary must prove exact GET/HEAD/path/query handling, R2's opaque strong
ETag, alias-upload `Last-Modified`, CSP/nosniff/CORS, plaintext same-path
redirect rules, direct R2 HTTPS root `404`, cache expiry, public-to-private and
endpoint-removal bounds, `r2.dev` disablement,
and zero Worker invocations before DNS cutover.
The internal `/manifest.json` alias is builder coordination and is not a public
route; the static-host edge allowlist must deny it and every other path.

R2 has no multi-object transaction. Although the builder writes every
immutable object first, compare-and-swap replaces the fixed aliases one at a
time, so an external reader could observe bounded cross-format generation skew
during an update or after a partial R2 failure. The D1 checkpoint advances only
after the complete cohort converges, but that does not make public reads
atomic. Game Protocol 1 explicitly permits bounded monotonic cross-format
convergence; the service-split canary must measure that bound and prove
interrupted convergence repairs before either authority is attached.

Compatibility updates are always represented addresslessly: their numeric
endpoint input is discarded, and the Worker never fills an address from the
HTTPS request source. Signed publication can opt into a canonical DNS hostname
and UDP port; only that explicit pair may produce `Address` and `Port`. A
present endpoint is public even when `PasswordRequired` is true; the password
remains an in-game authentication step and does not conceal routing metadata.

## Rendezvous signaling semantics

The public route selects a role; it does not grant that role. The server role
must authenticate the listing's rendezvous token before the Worker opens the
per-server room, and a client is admitted only while that authenticated control
socket remains live. Every successful publish rotates a non-secret generation
with the bearer token and retires all controls, pending authorizations, and
authorized tickets from the previous generation before the new token becomes
usable. The per-server room serializes that complete generation/token/listing
commit. Concurrent updates carry the D1 generation they observed; only the
first matching precondition can commit, so a delayed writer cannot regress the
room or listing to an unusable token. A password-protected listing fails client
rendezvous closed with a fixed retryable `503` unless both the client and
current server control negotiate exactly
`atrinik-classic-rendezvous-invite-v1`. The selected subprotocol is echoed in
the `101` response; missing, alternate, whitespace-, or comma-joined values are
not accepted for the protected flow.

| Listing policy | Client without invite subprotocol | Client with invite subprotocol |
| --- | --- | --- |
| private/absent, either password mode | fixed `404`; no room admission | fixed `404`; the invite is not a discovery grant |
| public, passwordless | admitted only while a server control is live | fixed `400`; protected and passwordless modes cannot be mixed |
| public, password-protected | fixed retryable `503` | admitted only while an invite-capable server control is live; authorization is mandatory |

An authenticated classic server control may always advertise invite-v1 support
so one long-lived control can serve the listing after an operator policy
change. The listing's current `PasswordRequired` value, not a client-selected
header, determines whether authorization is required.

### Classic invite-v1 contract

An invite capability has the exact canonical form
`atrinik-invite-v1.<server-id>.<invite-id>.<secret>.<expiry>`. The server ID is
64 lowercase hexadecimal characters, the random invite ID is 32 lowercase
hexadecimal characters (128 bits), and the random secret is 64 lowercase
hexadecimal characters (256 bits). Expiry is a nonzero unsigned 64-bit Unix
timestamp in canonical decimal with no leading zero. A capability is valid
only for the exact embedded server identity, while `expiry > now`, and while
expiry is no more than seven days in the future. Peers apply no implicit clock
skew allowance.

The proof is HMAC-SHA-256 with the 32-byte invite secret over this exact binary
transcript, in order:

1. ASCII `atrinik-classic-rendezvous-invite-v1` followed by one NUL byte;
2. the decoded 32-byte server ID;
3. the decoded 32-byte ticket;
4. the decoded 16-byte invite ID;
5. the 32-byte random server challenge; and
6. expiry encoded as an unsigned 64-bit big-endian integer.

One capability may authorize multiple fresh attempts until expiry; every proof
is nevertheless unique to its single-use ticket and fresh challenge. The
classic server owns capability creation, storage, expiry, and revocation. It
keeps one mode-`0600` capability file, creates a replacement valid for at most
seven days when none exists, and revokes/rotates it when the operator removes
that file and restarts. Clients receive the capability out of band, hold it
only for the attempted connection, and cleanse it afterward. It must never be
placed in a URL, query string, command line, log, directory representation, or
Worker request.

An accepted passwordless client sends one fresh client-generated ticket in its
only `client_candidate`. A protected client sends the ticket in a canonical
`auth_init`, receives one `auth_challenge`, returns one `auth_proof`, and waits
for one `auth_result`. The authenticated current server-control socket is the
only authority that can advance the exact ticket with `authorized: true`; a
false result is terminal and no candidate frame is accepted before a true
result. The invite secret and proof interpretation remain entirely in classic
peers, and the post-QUIC game join password remains independent. The room binds
the ticket to the originating socket, rejects replay or cross-socket use, and
routes at most 12 matching
`server_candidate` messages and one `complete` only to that socket. Completion
closes the client immediately; the room closes it unconditionally after 15
seconds. Each frame is at most 512 bytes. Authorization is capped at four
frames/2,048 bytes and the complete accepted attempt is capped at 9,216
signaling bytes. Candidate, ticket, invite, challenge, and proof payloads are
never cacheable route representations. Terminal state clears the client attachment's ticket and
digest immediately. A persistently failing transport close has four
explicit teardown-only retries ending seven seconds after the session deadline.
If both the retry-counter attachment write and close fail, the alarm throws so
Cloudflare's bounded failed-alarm retry replaces application rescheduling. The
socket cannot resume signaling or self-schedule indefinitely. See
[privacy.md](privacy.md) for transient state and metrics.

Outside the transient signaling frame, the raw ticket may live only in the
client attachment until that 15-second deadline. The server attachment keeps
random per-connection IDs, opening/expiry times, its SHA-256 routing digest,
and bounded counters for the live attempt. After becoming terminal, the client
attachment also keeps the closed outcome enum and a bounded teardown-attempt
counter. On the first passwordless candidate or protected `auth_init`, the room
atomically claims two purpose-separated HMAC replay aliases in the already
reserved admission row. Those opaque aliases—not
a raw ticket, unkeyed SHA-256 routing digest, connection ID, or candidate
address—preserve single use for the rolling 24-hour window across server
reconnect and Durable Object reconstruction.

The Worker proxies an accepted public upgrade to the Durable Object using a
fixed, private versioned URL/header contract that is deliberately incompatible
with the former unversioned broadcast room. During code propagation, old/new
Worker and room combinations fail closed rather than falling back to broadcast.
Production therefore deploys this security contract at 100%, not as a gradual
traffic split.

## Boundary behavior

Classification happens before source-tag derivation, D1, Durable Objects, or
body parsing. For the request representation exposed to the Worker, dynamic
services reject:

- an alternate authority, userinfo, explicit port, or malformed host;
- percent-encoded path bytes, backslashes, dot segments, repeated slashes, or
  a trailing slash;
- a wrong method, unexpected or duplicate query field, URL fragment, or
  unexpected request body;
- comma-joined critical headers, content encoding, a wrong content type, or an
  invalid content length; and
- a rendezvous request without an exact WebSocket upgrade, with any body/content
  header (including `Content-Length: 0`), or with an unsupported WebSocket
  subprotocol request.

An unexpected authority returns `421`; a known route under the wrong method
returns `405` with `Allow`; a valid rendezvous route without an upgrade returns
`426`; unsupported media returns `415`; oversized bodies return `413`; and
other non-canonical requests return a bounded `400` or `404`. Authentication
and rate failures are never redirected and every dynamic error response is
non-cacheable.

Cloudflare can normalize a default port, encoded/literal dot segments, and
other URL spellings before `Request.url` reaches Worker code. The pure route
fixtures reject those raw spellings, but the Worker alone cannot prove what a
pre-normalized request contained. The production WAF/raw-URI policy in
[edge-policy.md](edge-policy.md) rejects unsupported targets before invocation;
HTTP fragments are never transmitted to the server. Canary this with real edge
requests and do not treat a unit fixture as evidence of pre-normalization
enforcement.

Publisher and rendezvous deployments each repeat the automatic invocation-log
opt-out and receive only their required bindings. A route test does not by
itself prove binding isolation; each deployable Wrangler configuration also
generates isolated types and passes a distinct dry run.
