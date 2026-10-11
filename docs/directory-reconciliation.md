# Private directory reconciliation

`DirectoryReconciliation` is a named core Worker entrypoint used by the
separately authorized production delivery stage through a deployment-owned
remote Service Binding. It has no public route, default fetch path, public-edge
binding or bearer secret. Provider account/service-binding authority controls
invocation; a URL alone grants none.

The capability accepts only an empty `POST` to
`https://internal.atrinik.invalid/v1/directory-reconciliation`. Its exact bounded
header envelope permits only the matching Host and zero Content-Length. Caller
profiles, object keys, destinations, revisions, generations, query parameters
and request bodies are forbidden. Malformed calls cannot dispatch a builder.

The handler reconciles the fixed `classic-v3` and `game-v2` profiles using the
existing DirectoryBuilder. It verifies current D1 publication checkpoints and
the actual complete alias cohorts. Generation zero, stale publication, missing
aliases, pending purge, a failed builder or incomplete verification cannot
produce a success receipt. This is publication acceptance, not proof that
public DNS/CDN readers have converged.

A successful bounded JSON response uses schema `directory-reconciliation-v1`,
`completedAt` as integer UTC seconds, the exact configuration fields
`classicCutoverMode`, `gameCutoverMode`, `classicOrigin`, `gameOrigin`, and a
fixed two-element `profiles` array. Each profile receipt contains only `profile`,
`outcome` (`current` or `published`), positive `generation`, `generatedAt` and
`expiresAt`; it never exposes the private D1 revision.

The deployment stage checks receipt freshness against its invocation interval,
configuration against the verified core topology, both positive generations
and unexpired lifetimes. Current-main, lease and active-topology checks fence
both sides of the invocation. The public publisher/rendezvous edges gain no
new binding, secret or forwarding route. Source tests and isolated dry runs
never authorize a production invocation or deployment.
