# Contributing

Use a Conventional Commits pull-request title and run `npm ci` followed by
`npm run check`. External npm dependencies use compatible semver ranges;
`package-lock.json` records the exact installed tree, including Wrangler. Keep
the Node/npm toolchain pins and vulnerability overrides. Keep generated Worker configuration types untracked, never
commit credentials, and preserve the deployment/binding invariants documented
in `README.md`. Use `npm run deploy:production:dry-run` to inspect automatic
delivery; never substitute a local Wrangler deployment from an arbitrary
checkout. The source is MIT licensed under this repository's `LICENSE`.

Non-`main` branches and forks receive ordinary GitHub Actions validation only.
Run `npm run check` when changing deployment, binding, migration, privacy, edge,
or review contracts.
A live canary requires separately authorized provisioning and a maintainer's
operator-supervised exact-SHA run; never put Cloudflare credentials in a pull request, manufacture a
privileged Actions deployment/comment, or route a branch command to `main`.
