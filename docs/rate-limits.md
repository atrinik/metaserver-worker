# Request budgets and circuit breakers

Directory reads happen on launch or explicit refresh, publication happens on
startup, visible change, or a slow heartbeat, and each server normally keeps one
long-lived rendezvous control socket. The limits below are safety ceilings.

## Enforcement layers

1. Exact host/method/raw-target gates can reject malformed traffic before Worker
   invocation. [edge-policy.md](edge-policy.md) defines the separately authorized
   operator boundary. Historical provider-managed IP WAF rules and retention are
   unverified and unchanged by this source work; replacements require a separate
   non-IP policy review. The application does not extract requester or forwarded
   IP addresses, hash them, or store, audit, log, or metric them.
2. Anonymous edge bindings use fixed-purpose shared keys, with separate publisher,
   resolve, client-rendezvous, and server-rendezvous scopes. Counters are per
   Cloudflare location and eventually consistent. They are coarse load ceilings,
   not strict global limits or client fairness guarantees. They contain no
   requester metadata. Retired internal source/pair headers are rejected without
   a compatibility bridge.
3. After authentication, core native bindings and exact D1 fixed-window budgets
   use the server identity. Private route and eligible resolve budgets are also
   identity-scoped. Unknown route guesses create no persistent per-guess rows.
4. Per-server Durable Objects enforce atomic ticket replay rejection and bounded
   live work. Replay HMACs use random capabilities, never IP-derived identities.

The domainless publisher and rendezvous edges have only their route-specific
native bindings and one named Service Binding. Core authority owns D1 and room
state. Native namespace IDs must remain distinct across Workers and isolated
review environments. No Worker limiter can undo the invocation that reached it.

## Initial ceilings

| Actor and route | Native burst | Durable budget |
| --- | ---: | ---: |
| Shared publisher ingress, including route CRUD | 32,768/minute/location | none |
| Shared resolve ingress | 65,536/minute/location | none |
| Shared client rendezvous ingress | 65,536/minute/location | none |
| Shared server rendezvous ingress | 65,536/minute/location | none |
| Authenticated Classic/Game publisher identity | 2/minute | 48/UTC day |
| Authenticated server rendezvous identity | 3/minute | 50/UTC day |
| Authenticated private route operations | 16/minute | 64/hour/identity |
| Eligible private resolves | covered by shared resolve ceiling | 60/server/minute |
| Live access grants | n/a | 32/server; 32,768 global; 15-second expiry |
| Accepted client sessions per server | n/a | no ordinary daily quota; 24-hour replay horizon |

These shared ceilings cover the reviewed recovery cohort without adding a
source identifier:

- Publisher: `512 identities × 2 profiles × (16 route operations + 2 publishes)`
  = **18,432** requests per minute, below 32,768.
- Resolve: `512 × 60` = **30,720** requests per minute, below 65,536.
- Client rendezvous: `512 × 16 × 4 + 30,720` = **63,488** requests per minute,
  below 65,536.

This is capacity arithmetic, not a reservation or proof of globally exact
admission. Shared capacity can be exhausted by another caller. Authenticate
before charging identity budgets: a path parameter alone is not authority.
Counter scopes separate activities. Classic v3 preserves the highest historical
Classic v1/v2 sequence and nonce lineage; Game v2 remains independent. A rejected
publisher budget cannot consume replay state or mutate publication. A lineage
at the unsigned-64 maximum returns `publish_sequence_exhausted` without mutation.

Static directory reads execute no Worker after cutover and have no D1 read
budget. Fixed-purpose native limits run only after canonical route validation;
raw-target gates retain responsibility for pre-invocation rejection.

## Producer cadence and bounded rendezvous work

Native publication defaults to a 9,000-second heartbeat, bounded to 60..10,800
seconds with 10% jitter. Startup has a two-attempt cap with a 1,920-second refill;
visible changes debounce for 10 seconds. Producers must honor `Retry-After` and
use bounded backoff with jitter. Limiting is not a substitute for repairing a
retry loop.

| Dimension | Ceiling |
| --- | ---: |
| Active client attempts per server | 16 |
| Attached client sockets per server | 64 absolute implementation ceiling |
| Client session lifetime | 15 seconds |
| Client candidates | 1 |
| Server candidates | 12 |
| Completion frames | 1 |
| Signaling frame size | 512 bytes |
| Accepted signaling bytes for the complete attempt | 9,216 bytes |

Admission requires a live authenticated server control and fresh profile
presence. Open clients introduce a fresh 64-hex ticket in their candidate.
Protected clients use the exact access subprotocol and `access_init`, binding a
single-use grant, client nonce, and ticket before candidates. Grant redemption
checks current route revision, publication generation, expiry, and denial;
dispatch rechecks authorization. Old invitation challenge/proof frames are
rejected. Candidate addresses are validated and forwarded only in the live
event, never retained in attachments, SQL, logs, metrics, or application history.

A ticket routes only to its bound client socket. Completion closes the client;
one hibernation-safe alarm enforces the at-most-15-second deadline and the earliest
replay expiry. Terminal teardown clears raw tickets, grants, and routing digests.
If transport close fails, at most four teardown-only attempts occur at the
deadline and one, three, and seven seconds later. If both attachment persistence
and close fail, bounded platform alarm retries handle failure; no per-session
timer or unbounded signaling remains.

The room reserves an admission row before `101` and atomically claims both
current/previous-key replay aliases when the ticket is introduced. Its high
emergency storage ceiling returns temporary unavailability when exhausted,
not a daily player quota. A row contains acceptance time and HMAC aliases, never
raw ticket, unkeyed routing digest, connection ID, or candidate. Honest clients
must generate 32 random ticket bytes; shape validation cannot prove entropy.

Server controls use hibernation and have no artificial lifetime frame quota.
Every server frame must match live bounded routing state. Unknown, expired, or
over-budget tickets close the control path; a known late frame consumes its
remaining budget and is dropped if its client is gone.

## Response contract

Budget rejection returns `429`, `Cache-Control: no-store`, a bounded integer
`Retry-After`, and the canonical `rate_limited` JSON envelope. Header and body
retry values come from one bounded value. Native minute limits retry after
60 seconds; exact fixed-window budgets use the remaining window. Public reasons
remain the closed `burst_limit_exceeded` or `request_budget_exceeded` vocabulary;
there is no source/pair cooldown reason or retry state.

A missing or failed request-control dependency or invalid configuration fails
closed with `503 request_control_unavailable`, `Cache-Control: no-store`, and
`Retry-After: 60`. Canary settings may lower reviewed ceilings, not raise them.
The room requires `RENDEZVOUS_ACTIVE_CLIENT_LIMIT=16` and
`RENDEZVOUS_CLIENT_SESSION_SECONDS=15`; socket/frame/byte ceilings remain
structural constants. Retired `RENDEZVOUS_CLIENT_PAIR_*` settings have no authority.

## Circuits, measurement, and retention

Publisher/rendezvous edges and core coordinators each require the corresponding
circuit to be exactly `enabled`. Checked-in Classic circuits are enabled and
Game publishing remains disabled; public deployments remain domainless until
separate operator gates pass. Review limit changes across ingress, authenticated
budgets, finite room work, producer cadence, and recovery cohort arithmetic.

Use aggregate Worker Metrics, reviewed provider analytics, and bounded terminal
summaries described in [privacy.md](privacy.md). Routine `429` and open-circuit
traffic emits no custom event; no source dimension, per-frame stream, or
per-guess ledger is permitted. Canary at multiple locations when possible and
prove rejected work stops before D1/room mutation. A shared counter is not a
client identity or permission to disclose candidates.

Historical `SOURCE_TAG_KEY_*` names and key-ring classes serve only grant/ticket
replay HMACs. Consecutive `A/Z` then `B/A` key pairs must share the exact `A`
material, namespace, and purpose for strictly more than 24 hours after all
old-pair writers stop. Both aliases are checked atomically; disjoint or premature
rotation loses replay comparison and must fail deployment closed.

Migration `0015_remove_ip_derived_pair_tracking.sql` removes pair-attempt and
cooldown storage. Hourly maintenance round-robins canonical identity request
budgets and publisher nonces through at most eight indexed batches of 1,000 rows
per class: 8,000/class/run, at most 16 deletes and two probes. Remaining expired
rows fail the scheduled invocation so bounded diagnostics and platform alerts
expose backlog. Diagnose with aggregate age/count queries, never actor keys.
Provider recovery history and old IP-based rules/logs remain separate retention
and operator-review concerns; live removal is not historical erasure.
