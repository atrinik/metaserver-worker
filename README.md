# Atrinik metaserver Worker

[![Check](https://github.com/atrinik/metaserver-worker/actions/workflows/check.yml/badge.svg)](https://github.com/atrinik/metaserver-worker/actions/workflows/check.yml)

This Cloudflare Worker is the directory and rendezvous service for Atrinik's
QUIC-only game transport. It does not proxy game traffic.

## Endpoints

- `GET /` returns service health.
- `GET /index.wsgi/otp` issues a source-bound, single-use update token.
- `POST /index.wsgi/update` authenticates a server identity and updates its
  QUIC directory record.
- `GET /v2/servers` returns protocol 3 XML with public QUIC endpoints and
  pinned SHA-256 certificate fingerprints.
- `GET /v2/rendezvous/:server-id` upgrades to a signaling-only WebSocket.

There is deliberately no TCP directory, compatibility listing, DNS ownership,
or game-port reachability probe. A server is owned by the SHA-256 identity
derived from its persistent QUIC certificate, and the directory rejects a
record whose identity and certificate fingerprint differ. Update authentication
retains the native server's OTP/proof protocol. Rendezvous server peers additionally
authenticate with the bearer token returned by a successful update.

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

## Storage

`migrations/0001_initial.sql` is the clean QUIC-only bootstrap schema. This
repository predates its first deployment, so it deliberately has no historical
schema transition or data import path. Once this migration has been applied to
a persistent database, append new migrations instead of rewriting it.

The SQLite-backed `RendezvousRoom` Durable Object is declared through
Wrangler's `exports` configuration. Ownership resets and blacklist changes
should be generated with `scripts/admin_sql.py`, reviewed, and only then
applied by an authorized operator.

See [DEPLOYMENT.md](DEPLOYMENT.md) for the release checklist.

## Observability

Workers Logs remains enabled for deliberately emitted application diagnostics.
The rejection and blacklist paths emit structured events, while unexpected
failures remain logged for diagnosis. Automatic invocation logs are explicitly
disabled, so routine requests, WebSocket events, and scheduled invocations do
not each persist a `cf-worker-event` record. Custom-log sampling remains at
100% while the curated event set is small, so those diagnostics remain
available to operators.

This setting changes stored log-event volume, not Worker invocation usage.
Cloudflare Worker Metrics remains the source for aggregate request counts,
errors, CPU time, wall time, and duration. Directory hosts that are later moved
to direct static storage should be monitored as storage/cache traffic rather
than Worker traffic.

## License

This project is licensed under the [MIT License](LICENSE).
