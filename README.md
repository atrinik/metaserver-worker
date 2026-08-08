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
rotation and retention rules. Do not substitute plaintext Wrangler variables.

## Storage

Production state exists. `migrations/0001_initial.sql` is immutable applied
history, and every transition is an appended ordered migration. Tests apply the
complete series and exercise upgrades from populated production-shaped state.
Never edit, reorder, or reuse an applied migration number.

The SQLite-backed `RendezvousRoom` Durable Object is declared through
Wrangler's `exports` configuration. Ownership resets and blacklist changes
should be generated with `scripts/admin_sql.py`, reviewed, and only then
applied by an authorized operator.

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
and the rendezvous hardening phase will add per-room rolling session/work
budgets. A pre-Worker WAF rule is still required to prevent a blocked loop from
consuming Worker invocations. The ceilings, `429` contract, shared-NAT policy,
and circuit breakers are in [docs/rate-limits.md](docs/rate-limits.md); the
reviewed edge-policy specification and deployment gate are in
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
mitigations. Directory hosts that are later moved to direct static storage
should be monitored as storage/cache traffic rather than Worker traffic.

## License

This project is licensed under the [MIT License](LICENSE).
