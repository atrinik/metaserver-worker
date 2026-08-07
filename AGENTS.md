# Atrinik metaserver Worker repository guide

- This repository owns the Cloudflare Worker bootstrap, QUIC rendezvous
  protocol, admin policy, D1 schema, and Durable Object coordination. Keep game
  server/client implementation in their standalone repositories.
- Use Node.js 20 or newer and the lockfile. Run `npm ci` for a clean dependency
  tree and `npm run check` before submitting.
- Preserve strict request-size, identity, address, ticket, certificate-hash,
  rate-limit, and expiry validation. Keep rendezvous state deterministic and
  bounded; test malformed and replayed input at the boundary.
- `wrangler.jsonc` deliberately uses declarative `exports` for the SQLite
  Durable Object and a placeholder D1 ID. Do not add legacy Durable Object
  migration configuration alongside `exports`.
- `migrations/0001_initial.sql` is the clean bootstrap for a not-yet-deployed
  database. Once persistent production state exists, append migrations rather
  than rewriting applied history.
- Keep generated Wrangler types and `dist/` untracked. Update bindings, runtime
  types, tests, and dry-run configuration together.
- Never deploy, run remote D1 migrations, reset ownership, or mutate Cloudflare
  resources merely to validate a change. Those external actions require
  explicit authorization and reviewed production bindings.
- Commits and pull-request titles use Conventional Commits. Every squash merge
  is released by semantic-release.
- Preserve unrelated work and finish with `git diff --check`.
- Update this `AGENTS.md` in the same change when major rework alters platform
  ownership, bindings, state/migration policy, protocol, or validation.
