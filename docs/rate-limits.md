# Request budgets and circuit breakers

The intended workload is small: directory fetches happen on launch or explicit
refresh, servers publish on startup/visible change/slow heartbeat, and each
server normally keeps one long-lived rendezvous WebSocket. The limits below are
safety ceilings, not target traffic.

## Enforcement layers

1. A zone WAF rule is the only layer that can reject traffic before a Worker
   invocation. It uses a source-address characteristic and is an approximate
   invocation-cost shield. The exact reviewed policy, plan fallback,
   deployment gate, and canary are specified in
   [edge-policy.md](edge-policy.md).
2. Worker request control combines fast route-specific Rate Limiting bindings
   with D1 state. Native bindings are permissive, per Cloudflare location, and
   eventually consistent. D1 provides exact UTC fixed-window authenticated
   identity budgets plus the canonical client's rolling source/server-pair
   cooldown. One atomic batch mirrors rotating pair aliases without double
   charging or extending a live cooldown.
3. The SQLite-backed per-server Durable Object retains the exact 24-hour
   replay authority. It atomically prunes expired rows and reserves a replay
   row before returning `101`. On the first
   client candidate, that reserved row atomically claims current/previous-key
   HMAC replay aliases or rejects a collision. The same room enforces the
   active-socket and per-session work ceilings because every rendezvous for one
   server converges there.

All three layers are required. WAF stops mitigated traffic before it can become
a Worker charge, the native binding avoids D1 and Durable Object work during a
local burst, D1 applies exact pair backoff across locations, and the Durable
Object preserves ticket replay isolation and finite session work. Its replay
ledger is not an ordinary player admission quota.

The domainless canonical publisher and rendezvous edge Workers have independent
namespace IDs and only the native bindings needed by their own routes; the core
retains the exact authenticated and D1 budgets.
No namespace ID is reused across the three Workers because native counters are
shared by ID. Checked-in dynamic circuits remain disabled and domainless;
production routing is accepted only through the separately reviewed WAF,
attachment, configuration-readback, and canary procedure.

## Initial ceilings

| Actor and route | Native burst | Durable budget |
| --- | ---: | ---: |
| Publisher ingress source | 10/minute | none |
| Authenticated Classic/Game publisher identity | 2/minute | 48/UTC day |
| Canonical client rendezvous source | 60/minute; not also charged to global | none |
| Canonical client source/server pair after live-target lookup | covered by client burst | 20 eligible attempts/rolling 60 seconds, then 30..900-second cooldown |
| Server-role rendezvous source before authentication | 10/minute | none |
| Authenticated server rendezvous identity | 3/minute | 50/UTC day |
| Accepted client sessions per server | n/a | no ordinary daily quota; replay state remains bounded for 24 hours |

Static directory hosts execute no Worker after cutover and therefore have no
D1 directory budget. Cache/probe abuse is handled at the edge.

Anonymous dimensions use rotating source tags. Authenticated server limits are
applied only after authentication; a path parameter is not an authenticated
identity. Each route has its own counter scope so one activity cannot exhaust
another. The signed publisher authenticates every publish, including the first,
before charging the server-identity budget. Classic v1 and v2 share one
identity budget and one replay lineage: changing routes cannot reset sequence
or nonce history. Game remains independent. A rejected identity budget cannot
consume replay state or mutate a listing. Once a Classic lineage accepts the
unsigned-64 maximum, later v1 or v2 requests return
`publish_sequence_exhausted` without a minimum or mutation.

Each native limiter runs only after a request matches a valid canonical route.
The pre-Worker WAF/raw-URI policy remains mandatory for invocation-cost control
of retired and malformed targets.

## Canonical rendezvous cooldown and structural ceilings

Only a route-valid canonical client request whose server lookup finds a fresh,
public Classic target consumes a pair attempt. Unknown, retired, private, or
offline targets cannot build durable pair strikes. The first 20 eligible
attempts in a rolling 60-second window are admitted. The next request starts a
30-second cooldown; a complete later burst after expiry doubles the next
cooldown through 60, 120, 240, 480, and at most 900 seconds. Retries during a
cooldown return the remaining delay without mutation or escalation. Thirty
minutes without another threshold crossing resets the next penalty to 30
seconds. No ordinary client counter resets at UTC midnight.

One accepted client attempt is also constrained as follows:

| Dimension | Ceiling |
| --- | ---: |
| Active client attempts per server | 16 |
| Attached client sockets per server | 64 absolute implementation ceiling |
| Client session lifetime | 15 seconds |
| Client authorization frames | 2 |
| Server authorization frames | 2 |
| Authorization proof attempts | 1 |
| Authorization signaling bytes | 2,048 bytes |
| Client candidates | 1 |
| Server candidates | 12 |
| Completion frames | 1 |
| Signaling frame size | 512 bytes |
| Accepted signaling bytes for the complete attempt | 9,216 bytes |

A client is admitted only when one authenticated server-control socket is live.
The single client candidate introduces a fresh client-generated 64-hex ticket
for an open attempt. An access-code-protected attempt introduces it in `auth_init`
and permits no candidate until the authenticated server completes the exact
four-frame invite authorization exchange. The room binds it to that client
socket and rejects duplicate, replayed, or
cross-socket use. Server candidates and completion are routed only to that
ticket. A completion closes the client immediately, and one hibernation-safe
alarm closes any attempt and removes its routing state at the at-most-15-second
deadline, then schedules the earliest retained admission's 24-hour expiry. No
valid session can turn into an unbounded frame, byte, fan-out, or timer
workload. Terminal state immediately clears the client attachment's raw ticket
and routing digest. If `WebSocket.close()` itself repeatedly fails, the room
makes four teardown-only attempts at the deadline and at one, three, and seven
seconds afterward, then stops scheduling that already non-signaling socket.
If an attempt cannot persist its counter and cannot close the socket, the alarm
throws and relies on Cloudflare's bounded failed-alarm retries instead of
creating another application alarm.

Outside transient frame processing, the raw ticket may remain only in its
client attachment for the at-most-15-second session. The server attachment
keeps random per-connection IDs, opening/expiry times, its SHA-256 routing
digest, and bounded counters only until that deadline.
Long-window replay rejection instead uses the admission row's two
purpose-separated HMAC-SHA-256 aliases, derived with the current and previous
source-tag keys and scoped to the canonical deployment hostname plus opaque
Durable Object room ID. The replay ledger has a high emergency storage ceiling
and is pruned over the 24-hour security horizon; reaching that ceiling returns
temporary unavailability rather than a multi-hour player `429`. No row contains
a raw ticket, unkeyed SHA-256 routing digest, connection ID, or candidate address.
The protocol requires an honest client to generate 32 random ticket bytes and
encode them as 64 lowercase hex characters. The Worker enforces that shape and
single use but cannot prove the entropy of a peer-supplied value.

The authenticated server-control socket is intentionally long-lived: it uses
the Durable Object Hibernation API and has no artificial lifetime frame quota.
Every valid server frame must instead match one live, bounded routing digest,
so an idle control connection can sleep without creating an unbounded signaling
path. A late frame for a known ticket before its 15-second expiry consumes that
ticket's remaining budget and is dropped when its client is gone; an unknown,
expired, or over-budget ticket closes the control path. This preserves the
safety bound without turning an ordinary client disconnect into the older
server's two-second reconnect loop.

## Response contract

A rejected request returns `429`, `Cache-Control: no-store`, a bounded integer
`Retry-After`, and a stable JSON body:

```json
{
  "error": {
    "code": "rate_limited",
    "message": "The request budget has been exhausted.",
    "reason": "publish_daily",
    "retry_after_seconds": 3600
  }
}
```

Native minute limits use a 60-second retry. Fixed-window retry is the remaining
window duration clamped to 1..86,400 seconds. The canonical pair cooldown uses
`rendezvous_client_pair_cooldown`; both header and body carry its exact
remaining 1..900-second delay. Rejected cooldown retries do not consume a
burst slot, extend `blocked_until`, or increase the penalty.

Reason values are a closed route/dimension vocabulary: `global_burst`,
`publish_burst|daily`, `rendezvous_client_burst`,
`rendezvous_client_pair_cooldown`, and
`rendezvous_server_burst|daily`. The `Retry-After` header and
`retry_after_seconds` body member are generated from one bounded value.

A request-control binding/D1 failure or malformed/over-policy configuration
fails closed with `503 request_control_unavailable`, `Cache-Control: no-store`,
and `Retry-After: 60`. It is never treated as admission. Configuration may
lower a canary ceiling but cannot raise the reviewed maxima; the Worker also
strictly bounds listing/retention lifetimes and uses the classifier's fixed
body-size contract rather than a second environment override.

The coordinator requires the five `RENDEZVOUS_CLIENT_PAIR_*` burst, window,
initial/maximum cooldown, and reset variables; the checked-in values are
20, 60, 30, 900, and 1800 seconds. The room independently requires
`RENDEZVOUS_ACTIVE_CLIENT_LIMIT=16` and
`RENDEZVOUS_CLIENT_SESSION_SECONDS=15`. Missing, malformed, incoherent, or
policy-raising values fail closed before the affected authority performs work.
The
64-client-socket, frame-count, frame-size, and total-byte ceilings are
structural constants rather than runtime overrides.

## Circuit breakers

The publisher and rendezvous edges and their core coordinators each require the
corresponding breaker to be exactly `enabled`; both checked-in edge breakers and
both core canonical breakers ship disabled. The public deployments have
independent flags, native bindings, WAF rules, and observability, while D1 and
Durable Object authority remains only in the core. Changing a limit requires
reviewing all three enforcement layers, shared-NAT recovery allowance, consumer
retry behavior, and the corresponding test boundary.

## Operations and measurement

Use aggregate Worker Metrics and WAF analytics; the request path deliberately
keeps `429` and open-circuit outcomes out of custom logs. Its small curated
diagnostic set is for bounded validation/security/dependency failures, not
traffic counting. Canary at more than one location when possible, because
native counters are not globally exact.
Confirm that a rejected loop stops reaching D1/application work, and that a
WAF mitigation also stops new Worker invocations.

Use Durable Object metrics for aggregate upgrades, attached WebSockets, raw
WebSocket message counts, and failures. For accepted-session outcomes and
bounded work, use the at-most-one best-effort anonymous Analytics Engine
terminal summary described in [privacy.md](privacy.md). No per-frame or
rejected-session custom point is emitted, so the custom dataset itself cannot
become a request-shaped cost amplifier.

Shared networks are why the canonical native source shield is deliberately
coarse and why exact backoff uses a source/server-pair dimension. Several
legitimate clients behind one NAT share the native source key but ordinarily
differ at the server-pair dimension. A source that retries intermittently all
day does not accumulate toward a calendar-day ban. An anonymous source tag is a coarse recovery/abuse boundary, not a
durable client identity or permission to disclose candidates. A producer must
still use exponential backoff with jitter and honor `Retry-After`; rate
limiting is not a substitute for fixing a retry loop.

Native current/previous alias checks are sequential and conservative: if the
second rejects, the first may already have been charged locally. For rolling
`A/Z` to `B/A` deployments, each eligible D1 attempt has one opaque request ID
mirrored to both aliases; the shared `A` carries the rolling cohort and active
cooldown forward without charging twice. D1 errors fail closed.

The per-room SQLite replay ledger uses the same `A/Z` then `B/A` overlap shape,
but claims both HMAC aliases atomically on the first candidate. A replay matches
through shared `A` even after server disconnect/reconnect and Durable Object
reconstruction. Keep one identical key in consecutive deployment pairs for
strictly more than the full 24-hour row lifetime after every old-pair writer has
stopped; a disjoint or prematurely retired pair loses that exact comparison and
must fail deployment closed.

Rotation temporarily doubles anonymous counter rows/writes. The hourly task
round-robins canonical request budgets, rendezvous pair attempts/cooldowns, and
publisher nonces through at most eight indexed batches of 1,000 rows per state
class (8,000/class/run and no more than 32 deletes plus four probes). If expired rows remain, the
scheduled invocation fails so the bounded `unexpected_error` diagnostic and
platform error alerts expose the backlog. Operators should inspect only
aggregate age/count queries—never actor keys—to diagnose it.
