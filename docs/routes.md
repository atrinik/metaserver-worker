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
