# Contributing

Use a Conventional Commits pull-request title and run `npm ci` followed by
`npm run check`. Keep generated Worker configuration types untracked, never
commit credentials, and preserve the deployment/binding invariants documented
in `README.md`. Use `npm run deploy:production:dry-run` to inspect automatic
delivery; never substitute a local Wrangler deployment from an arbitrary
checkout. The source is MIT licensed under this repository's `LICENSE`.
