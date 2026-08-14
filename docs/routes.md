# Metaserver route contract

Route versions describe HTTP deployment contracts. They are independent of
the version carried inside a directory representation or game protocol.

## Retired surface

Classic v5.9.0 is the minimum supported release. The former CGI and public
legacy generic `/v2` API has no Worker handler, redirect, fallback, or supported rollback.
Exact negative probes are blocked at the edge before invocation. The private
Service Binding URL `https://rendezvous.internal/v3` is a separate versioned
capability and is not public routing.

## Canonical services

The shared classifier freezes the following dynamic route envelope before
publisher and rendezvous handlers are exposed:

| Authority | Method | Path | Request contract |
| --- | --- | --- | --- |
| `publish.meta.atrinik.org` | `POST` | `/v1/servers/{server-id}/publish` | exact Game Protocol 1 signed publisher envelope, body required and at most 4,096 bytes; independently circuit-disabled by `GAME_PUBLISH_ENABLED` until rollout |
| `publish.meta.atrinik.org` | `POST` | `/v1/classic/servers/{server-id}/publish` | exact `application/json`, no query or content encoding, body required and at most 4,096 bytes |
| `publish.meta.atrinik.org` | `POST` | `/v2/classic/servers/{server-id}/publish` | exact Classic v2 schema/tag with mandatory `accessCodeRequired`; otherwise the same bounded transport envelope |
| `rendezvous.meta.atrinik.org` | `GET` WebSocket | `/v1/servers/{server-id}?role=client\|server` | no body or content headers; exactly one `role` query |
| `rendezvous.meta.atrinik.org` | `GET` WebSocket | `/v1/classic/servers/{server-id}?role=client\|server` | no body or content headers; exactly one `role` query |

The checked-in Wrangler files deliberately declare no routes or Custom Domains
and keep both dynamic circuits disabled; production attachment and enablement
are separately reviewed Cloudflare state. Each
edge rejects every other host/method/path/query/body shape, derives only the
route-specific pseudonymous admission aliases, strips raw request-source and
browser headers, and calls one named core Worker entrypoint. The core parses the
same canonical contract again before authentication, D1, or Durable Object
work. The Service Binding is private routing and is not an alias, redirect, or
additional public URL. Static directory authorities never pass through any
Worker, and the state-owning core has no default `fetch` handler.

`server-id` is exactly 64 lowercase hexadecimal characters. The publisher
payload and signature fields are owned by the signed-publishing contract; the
route classifier does not parse or authenticate them.

### Signed publishers

The endpoints implement `atrinik-classic-publish-v1`,
`atrinik-classic-publish-v2`, and `atrinik-game-publish-v1` from the protocol
repository. Classic v1/v2 have distinct route/schema/tag/signature domains but
share one replay lineage per identity; Game remains independent. Each profile has an
exact canonical JSON schema, signature tag, path, replay ledger, daily budget,
presence row, public row shape, and serialized publication-room identity. A
valid signature from one profile is unusable in another. All
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

An accepted uint64-maximum sequence succeeds normally. The lineage is then
exhausted: every later attempt returns exact 409
`publish_sequence_exhausted` with no `minimumNextSequence` and no mutation.
The first accepted v2 request must exceed the v1 high-water mark and atomically
retires the identity's v1 listing, presence, and generation before installing
the body-derived v2 state and irreversible v2-only marker. Later authenticated
v1 requests receive fixed 410 `profile_retired`. After the separately
authorized global gate, the v1 route returns that same 410 before inspecting
the body, signature, identity, sequence, or nonce.

Successful responses contain the new server-role rendezvous token and use
`Cache-Control: no-store`. Replay responses are also `no-store`. Clients
must not follow redirects for a signed publish because authority and path are
covered by the signature. There is no alternate publisher path.

The two directory authorities are static origins and are never accepted by a
dynamic Worker:

- `meta.atrinik.org`: `/`, `/index.html`, `/index.xml`, and `/index.json` for
  Game Protocol 1.
- `classic.meta.atrinik.org`: the same four paths for the classic generation.

The current implementation builds those fixed aliases in isolated R2 buckets.
Classic production is attached only through its reviewed static custom domain;
Game remains unattached until its independent rollout. Game JSON/XML
follow the protocol-owned `atrinik-directory-v1` version 2 fixtures, keep body
SHA-256 independent from the public origin validator, and accept non-empty
state only through the signed Game publisher. Classic v1 JSON/XML follow
[classic directory protocol 4](classic-directory-v4.md); Classic v2
JSON/XML/HTML follow [protocol 5](classic-directory-v5.md) and use only
`accessCodeRequired`, `AccessCodeRequired`, and open/protected wording. Every new or changed
static attachment must prove exact GET/HEAD/path/query handling, R2's opaque strong
ETag, alias-upload `Last-Modified`, CSP/nosniff/CORS, plaintext same-path
redirect rules, direct R2 HTTPS root `404`, cache expiry, public-to-private and
endpoint-removal bounds, `r2.dev` disablement,
and zero Worker invocations before attachment or rule changes are accepted.
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

The Worker never fills an address from the HTTPS request source. Signed
publication can opt into a canonical DNS hostname
and UDP port; only that explicit pair may produce `Address` and `Port`. A
present endpoint is public under either policy. Retained v1
`PasswordRequired` remains an in-game authentication step. V2
`AccessCodeRequired` selects open versus invite-proof authorization and never
imports a password field or raw access code into Worker state.

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
room or listing to an unusable token. An access-code-protected v2 listing fails
client rendezvous closed with a fixed retryable `503` unless both the client and
current server control negotiate exactly
`atrinik-classic-rendezvous-invite-v1`. The selected subprotocol is echoed in
the `101` response; missing, alternate, whitespace-, or comma-joined values are
not accepted for the access-code-protected flow.

| V2 listing policy | Client without invite subprotocol | Client with invite subprotocol |
| --- | --- | --- |
| private/absent, either access policy | fixed `404`; no room admission | fixed `404`; the access code is not a discovery grant |
| public, open | admitted only while a server control is live | fixed `400`; open and access-code-protected modes cannot be mixed |
| public, access-code-protected | fixed retryable `503` | admitted only while an invite-capable server control is live; access-code authorization is mandatory |

The server control must negotiate invite-v1 exactly when the current listing
requires authorization; both missing and extra negotiation fail before the
control can replace a working peer. Every policy publication rotates the
generation/token and retires the prior control. The v2 listing's current
`AccessCodeRequired` value, not a client-selected header, determines whether
authorization is required. Retained v1 rooms continue to interpret only their
frozen `PasswordRequired` policy and are never selected for a v2 identity.

### Classic access-code plumbing (invite-v1 wire)

The public wire name remains exactly
`atrinik-classic-rendezvous-invite-v1`; it is internal plumbing for the
`atrinik-access-v1` launch-code scope, not a standalone credential method. The
Classic peers extract the server ID, 128-bit access ID, 256-bit rendezvous
secret, and nonzero unsigned-64 expiry from the complete launch code. The
Worker sees only the existing bounded proof frames and never receives or
parses the launch code or its raw fields.

The proof is HMAC-SHA-256 with the 32-byte rendezvous secret over this exact binary
transcript, in order:

1. ASCII `atrinik-classic-rendezvous-invite-v1` followed by one NUL byte;
2. the decoded 32-byte server ID;
3. the decoded 32-byte ticket;
4. the decoded 16-byte access ID;
5. the 32-byte random server challenge; and
6. expiry encoded as an unsigned 64-bit big-endian integer.

One access code may authorize multiple fresh attempts until expiry; every proof
is nevertheless unique to its single-use ticket and fresh challenge. Launch
code creation, secure storage, expiry, revocation, and handoff belong to
Classic. No standalone raw invite file/share lifecycle is supported, and no
launch-code field may be placed in a URL, query string, command line, log,
directory representation, or Worker request.

An accepted open client sends one fresh client-generated ticket in its only
`client_candidate`. An access-code-protected client sends the ticket in a canonical
`auth_init`, receives one `auth_challenge`, returns one `auth_proof`, and waits
for one `auth_result`. The authenticated current server-control socket is the
only authority that can advance the exact ticket with `authorized: true`; a
false result is terminal and no candidate frame is accepted before a true
result. The rendezvous secret, proof interpretation, and post-QUIC access-code
capability remain entirely in Classic peers. The room binds
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
counter. On the first open candidate or access-code-protected `auth_init`, the room
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
