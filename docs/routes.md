# Metaserver route contract

Route versions identify HTTP deployment contracts independently of directory
representation and game-protocol versions. The protocol repository owns the
canonical signed-publisher and access-token bytes.

## Canonical services

| Authority | Method | Path | Request contract |
| --- | --- | --- | --- |
| `publish.meta.atrinik.org` | `POST` | `/v2/servers/{server-id}/publish` | Game publisher v2, `atrinik-game-publish-v2` schema/signature tag; signed canonical JSON at most 4,096 bytes; gated by `GAME_PUBLISH_ENABLED` |
| `publish.meta.atrinik.org` | `POST` | `/v3/classic/servers/{server-id}/publish` | Classic publisher v3, `atrinik-classic-publish-v3` schema/signature tag; signed canonical JSON at most 4,096 bytes |
| `publish.meta.atrinik.org` | `POST` | `/v1/access/servers/classic/{server-id}/routes` | authenticated, canonical Classic access-token reserve/activate/revoke/result operations; at most 4,096 bytes |
| `publish.meta.atrinik.org` | `POST` | `/v1/access/servers/game/{server-id}/routes` | recognized but unavailable; fixed `404 access_unavailable` before authentication or state access |
| `rendezvous.meta.atrinik.org` | `POST` | `/v1/access/resolve` | canonical token-resolution request, at most 512 bytes; only Classic is supported |
| `rendezvous.meta.atrinik.org` | `POST` | `/v1/rendezvous/challenge/classic/{server-id}` | blind stateless admission-v1 challenge, at most 256 bytes; fixed 24-bit work |
| `rendezvous.meta.atrinik.org` | `GET` WebSocket | `/v1/classic/servers/{server-id}?role=client\|server` | exact role query, no body/content headers; client admission proof and ticket or authenticated server control |
| `rendezvous.meta.atrinik.org` | `GET` WebSocket | `/v1/access/rendezvous/classic/{server-id}` | no query/body/content headers; exact `atrinik-access-rendezvous-v1`, proof, bearer grant and bound client nonce |
| `rendezvous.meta.atrinik.org` | `GET` WebSocket | `/v1/servers/{server-id}?role=client\|server` | Game route recognized but independently unavailable |
| `rendezvous.meta.atrinik.org` | `GET` WebSocket | `/v1/access/rendezvous/game/{server-id}` | Game access rendezvous remains unavailable |

Every server ID is exactly 64 lowercase hex characters. Publisher and access
POSTs require exact `application/json`, no query and no content encoding.
Challenge and access routes reject cookies; no capability or grant belongs in
a URL, log, directory artifact or WebSocket subprotocol. The old Game v1 and
Classic v1/v2 publisher routes are retired and have no runtime fallback. Their
replay lineage is retained as history rather than an active publication profile.

Classic publishing and rendezvous are enabled in the checked-in configuration;
Game publishing remains disabled. The configurations deliberately declare no
routes or Custom Domains. Production attachment and protected configuration
readback follow the automatic-main delivery contract. Routine delivery rejects
core domains, wrong caller domains, alternate routes and non-Custom-Domain
routes; it does not create DNS/WAF policy.

Public edges own only route/circuit checks, shared native ingress counters and
one named Service Binding. They hold no replay/admission signing keys and derive
no source aliases. They reconstruct a fixed allowlisted request without source
or browser metadata. Core independently checks the route and envelope before
authentication, D1 or room dispatch. The private Service Binding is not another
public URL. The core has no default `fetch` handler.

## Signed publishers

Current active profiles are `classic-v3` and `game-v2`. Each has its own exact
canonical JSON schema, signature tag, signed path, replay ledger, daily budget,
presence/public row shape and publication-room identity. Classic retains its
highest historical sequence/nonce lineage; Game remains independent. Cross-
profile signatures cannot authenticate another profile.

Publishers require an RFC 9530 `Content-Digest` and `ecdsa-p256-sha256` HTTP
message signature from the P-256 private key paired with the exact DER
certificate whose SHA-256 fingerprint is the server ID. Covered components,
their order, timestamp window, canonical property order, signature parameters
and raw P1363 encoding are exact bytes, not normalized input.

Each attempt carries a nonzero random 128-bit nonce and canonical unsigned-64
sequence. The room serializes replay admission, generation rotation and D1
publication. Only a sequence above the prior high-water mark with an unused
nonce commits. Rejection returns noncacheable 409 `publish_replay` with
`minimumNextSequence` and cannot mutate presence, rotate tokens or enqueue a
revision. The uint64 maximum may commit once; later attempts return exact
`publish_sequence_exhausted` without a minimum sequence or mutation.

Successful responses return a fresh server-role rendezvous token with
`Cache-Control: no-store`. An unchanged heartbeat updates presence, rotates the
generation and records bounded activity without advancing the visible directory
revision. Visible changes advance revision/outbox exactly once. Clients must
not follow redirects because authority and path are signed.

## Access-token routes

Classic token CRUD requires an existing authenticated publisher identity;
reservation additionally requires fresh signed presence. Resolution returns a
single-use, fifteen-second grant bound to identity, generation, token revision
and client nonce. The directory contains no private token metadata.

Game access-token CRUD returns fixed 404
`{"error":{"code":"access_unavailable"}}` for reserve, activate, revoke and
result even when `GAME_PUBLISH_ENABLED=enabled`. Core rejects it before body or
signature authentication, D1 access/budget/replay allocation, or room dispatch.
Game capability resolve and access rendezvous remain unavailable; existing
stored Game routes remain inert. `GAME_PUBLISH_ENABLED` enables ordinary signed
Game publication only and cannot enable access tokens. Classic CRUD remains
supported.

## Rendezvous signaling

Admission-v1 is mandatory for every Classic client. A blind challenge binds the
binary-ticket hash, server and authority without querying presence or creating
state. Core checks the fixed 24-bit work and expiry before room lookup. The
private `/v5` envelope attests the verified proof, bound ticket and expiry;
protected clients additionally bind a grant nonce. Old envelopes fail closed.
See [rendezvous-admission.md](rendezvous-admission.md) for exact headers and bytes.

Only a live authenticated current server control can admit a client. Publishing
rotates the generation and retires old controls/clients. A protected client uses
the access route and exact access subprotocol; ordinary clients use the public
route. Protected grants are atomically redeemed in D1 before reservations or
socket allocation. The room atomically reserves and claims replay tags before
allocating a socket; failed allocation retains the claim. Expiry, grant liveness,
generation, capacity and local control are fenced across asynchronous work.

Protected `access_init` must confirm the already bound grant/nonce within two
seconds. `access_ready` permits candidate exchange only within the original
fifteen-second attempt/grant deadline. Confirmation never accepts an alternate
grant. Removed invitation challenge/proof and password protocols are rejected.
The candidate ticket must match its preauthorized binding, and protected grant
liveness is rechecked after hashing immediately before dispatch.

A client sends at most one candidate; the current server sends at most twelve
matching candidates and one completion only to that client. Frames are at most
512 bytes and total accepted signaling remains bounded at 9,216 bytes.
Completion or expiry closes the client. Terminal state scrubs raw tickets,
grants, nonces and hashes. The bounded live attachments survive hibernation;
only purpose-separated current/previous HMAC aliases preserve 24-hour single use
in SQLite across control replacement and reconstruction. Candidate endpoints are
transient forwarding data, never persisted. See [privacy.md](privacy.md).

## Static origins

`meta.atrinik.org` and `classic.meta.atrinik.org` serve `/`, `/index.html`,
`/index.xml` and `/index.json` directly from isolated R2 origins. Game's current
representation is directory v2; Classic's is directory v6. Public directory
builders consume only public entries. A signed canonical DNS hostname and UDP
port may expose an operator-selected endpoint; neither is inferred from the
HTTPS source. Current `accessRequired` indicates access-token policy. Historical
Classic v4/v5 representations are documented separately and are not runtime
publisher fallbacks.

Static attachment acceptance includes GET/HEAD/path/query behavior, opaque R2
strong ETags, alias-upload Last-Modified, security/CORS/cache headers, plaintext
redirects, direct HTTPS root 404, expiry and public/private removal bounds,
`r2.dev` disablement and zero Worker invocation. `/manifest.json` is private
builder coordination, never a public route. R2 aliases change individually:
public formats may briefly differ until the verified cohort converges. D1
checkpoints advance only after the complete cohort and required purge finish.

## Boundary behavior

Classification precedes body parsing and state access. Alternate authorities,
userinfo, explicit ports, malformed hosts, encoded path bytes, backslashes, dot
segments, repeated/trailing slashes, wrong methods, duplicate/unexpected query
fields, fragments, comma-joined critical headers and invalid body framing are
rejected. Upgrades reject any body/content header, including Content-Length: 0,
and unsupported subprotocols. Missing proof returns fixed 428; invalid proof or
replay returns fixed 403. Dynamic errors are noncacheable and never redirect.

Provider URL normalization precedes `Request.url`; unit fixtures cannot prove
what the raw network target contained. The separately reviewed
[edge-policy.md](edge-policy.md) enforces the raw-target boundary. Each deployable
configuration generates isolated types and passes a distinct dry run; route tests
alone do not prove binding isolation.
