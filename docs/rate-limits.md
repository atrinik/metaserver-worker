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
   with D1 counters. Native bindings are permissive, per Cloudflare location,
   and eventually consistent; D1 provides the exact UTC fixed-window source,
   source/server-pair, and authenticated-identity budgets. One conditional
   multi-row UPSERT admits at most the configured count and mirrors rotating
   tag aliases without double charging.
3. The SQLite-backed per-server Durable Object provides the exact rolling
   client-session authority. It atomically prunes rows at or before the 24-hour
   cutoff and records a new acceptance before returning `101`. On the first
   client candidate, that reserved row atomically claims current/previous-key
   HMAC replay aliases or rejects a collision. The same room enforces the
   active-socket and per-session work ceilings because every rendezvous for one
   server converges there.

All three layers are required. WAF stops mitigated traffic before it can become
a Worker charge, the native binding avoids D1 and Durable Object work during a
local burst, D1 stops a loop that stays below that burst or moves between
locations, and the Durable Object prevents distributed sources from exceeding
one server's exact rolling allowance. A WAF or native rejection is not proof
that the exact room quota is exhausted, and a Durable Object rejection still
costs the preceding Worker invocation.

The compatibility Worker checks the 10/minute global binding before the
10/minute directory, OTP, and update bindings, so an all-one-route burst may
surface the global reason first. The separate bindings are intentional
defense-in-depth and become independently effective when issue #18 moves those
routes to separate entrypoints; they also prevent a later global-ceiling change
from silently removing route policy.

## Initial ceilings

| Actor and route | Native burst | Durable budget |
| --- | ---: | ---: |
| Any dynamic ingress source tag | 10/minute | WAF/metrics only |
| Temporary public status source | covered by global burst | 100/UTC day |
| Temporary dynamic directory source | 10/minute | 100/UTC day |
| Temporary OTP source | 10/minute | 48/UTC day |
| Temporary update source | 10/minute | 48/UTC day |
| Authenticated classic/canonical publisher identity | 2/minute | 48/UTC day |
| Client rendezvous source | 5/minute | 50/UTC day |
| Client source/server pair | covered by client burst | 10/UTC day |
| Server-role rendezvous source before authentication | covered by global burst | 50/UTC day |
| Authenticated server rendezvous identity | 3/minute | 50/UTC day |
| Accepted client sessions per server | n/a | 50/rolling 24 hours (exact per-server DO control) |

Static directory hosts execute no Worker after cutover and therefore have no
D1 directory budget. Cache/probe abuse is handled at the edge.

Anonymous dimensions use rotating source tags. Authenticated server limits are
applied only after authentication; a path parameter is not an authenticated
identity. Each route has its own counter scope so one activity cannot exhaust
another. Initial classic registration is protected by the source budget; the
server-identity budget starts after an existing owner proves its key and
before it consumes the one-time token. A rejected identity budget therefore
cannot burn authentication state or mutate a listing. The signed publisher
will authenticate every publish, including the first.

The global in-Worker limiter runs only after a request matches a valid dynamic
route. Unknown-host/path probes still invoke the compatibility Worker before a
bounded rejection, so the pre-Worker WAF/raw-URI policy remains mandatory for
invocation-cost control.

## Rendezvous structural ceilings

The rolling admission is only the outer bound. One accepted client attempt is
also constrained as follows:

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
for a passwordless attempt. A protected attempt introduces it in `auth_init`
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
Durable Object room ID. At most 50 such rows exist in one room; none contains a
raw ticket, unkeyed SHA-256 routing digest, connection ID, or candidate address.
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
window duration clamped to 1..86,400 seconds. The exact rendezvous rolling
limit uses the earliest retained admission expiry; its stable reason is
`rendezvous_server_sessions_rolling`. Rejected durable calls do not keep
incrementing the stored count.

Reason values are a closed route/dimension vocabulary: `global_burst`, the
`compat_status_daily`, `compat_directory_*`, `compat_otp_*`, and
`compat_update_*` burst/daily
variants, `publish_burst|daily`, and the rendezvous client/server burst/daily
variants plus `rendezvous_server_sessions_rolling`. The `Retry-After` header
and `retry_after_seconds` body member are generated from one bounded value.

A request-control binding/D1 failure or malformed/over-policy configuration
fails closed with `503 request_control_unavailable`, `Cache-Control: no-store`,
and `Retry-After: 60`. It is never treated as admission. Configuration may
lower a canary ceiling but cannot raise the reviewed maxima; the Worker also
strictly bounds OTP/listing/retention lifetimes and uses the classifier's fixed
body-size contract rather than a second environment override.

The rendezvous-specific variables
`RENDEZVOUS_CLIENT_ROLLING_LIMIT`,
`RENDEZVOUS_ACTIVE_CLIENT_LIMIT`, and
`RENDEZVOUS_CLIENT_SESSION_SECONDS` are required. The checked-in configuration
sets the reviewed 50, 16, and 15 maxima. A reviewed canary or emergency version
may lower them to a positive integer, but missing, malformed, zero, or
policy-raising values fail closed in the Worker before source-tag derivation,
native counters, D1 budgets, server lookup, or Durable Object invocation. The
room independently validates the same environment as the final authority. The
64-client-socket, frame-count, frame-size, and total-byte ceilings are
structural constants rather than runtime overrides.

## Circuit breakers

Compatibility route flags can disable status, directory, OTP, update, or
rendezvous without a code change. Only the exact value `enabled` opens a route; `disabled`,
missing, differently cased, padded, or malformed values fail closed. A disabled
route returns a stable non-cacheable `503` and bounded `Retry-After`; it never
falls back to another authentication or routing path.

The final publisher and rendezvous deployments have independent flags,
bindings, WAF rules, and observability. Changing a limit requires reviewing all
three enforcement layers, shared-NAT recovery allowance, consumer retry
behavior, and the corresponding test boundary.

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

Shared networks are why anonymous source budgets remain materially larger than
normal use and why the source/server-pair dimension is separate. Several
legitimate clients behind one NAT share the WAF/native source key and global
daily source tag, but ordinarily differ at the server-pair dimension. The
per-server rolling quota remains exact regardless of NAT or Cloudflare
location. An anonymous source tag is a coarse recovery/abuse boundary, not a
durable client identity or permission to disclose candidates. A producer must
still use exponential backoff with jitter and honor `Retry-After`; rate
limiting is not a substitute for fixing a retry loop.

Native current/previous alias checks are sequential and conservative: if the
second rejects, the first may already have been charged locally. D1 remains the
exact daily authority. For rolling `A/Z` to `B/A` deployments, an admission
advances the requested pair from the maximum equal-expiry count; this heals a
lagging alias without resetting the budget. Expiry/window divergence and D1
errors fail closed.

The per-room SQLite replay ledger uses the same `A/Z` then `B/A` overlap shape,
but claims both HMAC aliases atomically on the first candidate. A replay matches
through shared `A` even after server disconnect/reconnect and Durable Object
reconstruction. Keep one identical key in consecutive deployment pairs for
strictly more than the full 24-hour row lifetime after every old-pair writer has
stopped; a disjoint or prematurely retired pair loses that exact comparison and
must fail deployment closed.

Rotation temporarily doubles anonymous counter rows/writes. The hourly task
round-robins servers, OTPs, legacy counters, and request budgets through at most
eight indexed batches of 1,000 rows per state class (8,000/class/run and no more
than 36 D1 statements including backlog probes). If expired rows remain, the
scheduled invocation fails so the bounded `unexpected_error` diagnostic and
platform error alerts expose the backlog. Operators should inspect only
aggregate age/count queries—never actor keys—to diagnose it.
