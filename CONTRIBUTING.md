# Contributing

Use a Conventional Commits pull-request title and run `npm ci` followed by
`npm run check`. Keep generated Worker configuration types untracked, never
commit credentials, and preserve the deployment/binding invariants documented
in `README.md`. Use `npm run deploy:production:dry-run` to inspect automatic
delivery; never substitute a local Wrangler deployment from an arbitrary
checkout. The source is MIT licensed under this repository's `LICENSE`.

Non-`main` same-repository branches are eligible only for the build-only review
path in `deployment/workers-builds-review.json`; it creates no Worker version
or URL and carries no production/live credential. Its distinct preview token
has no Cloudflare account/zone resource permission; #56 must prove that hard
boundary before enabling it. Forks keep ordinary repository validation only.
Run `npm run test:review` and `npm run review:dry-run` when
changing deployment, binding, migration, privacy, edge, or review contracts.
A live canary requires a maintainer's separate, operator-supervised exact-SHA
run and issue #56 provisioning; never put Cloudflare credentials in a pull request, manufacture a
privileged Actions deployment/comment, or route a branch command to `main`.
