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
| `publish.meta.atrinik.org` | `POST` | `/v1/servers/{server-id}/publish` | exact `application/json`, no query or content encoding, body required and at most 65,536 bytes |
| `publish.meta.atrinik.org` | `POST` | `/v1/classic/servers/{server-id}/publish` | exact `application/json`, no query or content encoding, body required and at most 65,536 bytes |
| `rendezvous.meta.atrinik.org` | `GET` WebSocket | `/v1/servers/{server-id}?role=client\|server` | no body or content headers; exactly one `role` query |
| `rendezvous.meta.atrinik.org` | `GET` WebSocket | `/v1/classic/servers/{server-id}?role=client\|server` | no body or content headers; exactly one `role` query |

`server-id` is exactly 64 lowercase hexadecimal characters. The publisher
payload and signature fields are owned by the signed-publishing contract; the
route classifier does not parse or authenticate them.

The two directory authorities are static origins and are never accepted by a
dynamic Worker:

- `meta.atrinik.org`: `/`, `/index.html`, `/index.xml`, and `/index.json` for
  Game Protocol 1.
- `classic.meta.atrinik.org`: the same four paths for the classic generation.

## Rendezvous signaling semantics

The public route selects a role; it does not grant that role. The server role
must authenticate the listing's rendezvous token before the Worker opens the
per-server room, and a client is admitted only while that authenticated control
socket remains live. A password-protected listing fails client rendezvous
closed with a fixed `503 Protected rendezvous authorization is unavailable`
response and `Retry-After: 300` until issue #20 provides the separate
game-password authorization stage.

An accepted client sends one fresh client-generated ticket in its only
`client_candidate`. The room binds that ticket to the originating socket,
rejects replay or cross-socket use, and routes at most 12 matching
`server_candidate` messages and one `complete` only to that socket. Completion
closes the client immediately; the room closes it unconditionally after 15
seconds. Each frame is at most 512 bytes and the accepted attempt is capped at
7,168 signaling bytes. Candidate and ticket payloads are never cacheable route
representations. Terminal state clears the client attachment's ticket and
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
counter. On
the first candidate, the room atomically claims two purpose-separated HMAC
replay aliases in the already reserved admission row. Those opaque aliases—not
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

Publisher and rendezvous deployments will each repeat the automatic
invocation-log opt-out and receive only their required bindings. A route test
does not by itself prove binding isolation; each deployable Wrangler
configuration must also generate types and pass a dry run.
