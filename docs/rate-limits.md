# Request budgets and circuit breakers

The intended workload is small: directory fetches happen on launch or explicit
refresh, servers publish on startup/visible change/slow heartbeat, and each
server normally keeps one long-lived rendezvous WebSocket. The limits below are
safety ceilings, not target traffic.

## Enforcement layers

1. A zone WAF rule is the only layer that can reject traffic before a Worker
   invocation. The exact reviewed policy, plan fallback, deployment gate, and
   canary are specified in [edge-policy.md](edge-policy.md).
2. Worker Rate Limiting bindings provide fast, route-specific burst control.
   They are per Cloudflare location, permissive, and eventually consistent.
3. D1 fixed-window counters provide exact bounded compatibility and identity
   budgets. One conditional multi-row UPSERT admits at most the configured
   count and mirrors rotating tag aliases without double charging.
4. The rendezvous-hardening phase adds exact rolling session and
   signaling-work limits to the per-server Durable Object, where all sessions
   for one server converge. Those limits are not supplied by the fixed-window
   foundation alone.

Native and durable controls are both required: the native binding avoids D1
work during a local burst, while D1/DO counters stop a loop that stays at the
minute ceiling or moves between locations.

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
| Accepted client sessions per server | n/a | 50/rolling 24 hours (planned rendezvous DO control) |

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
window duration clamped to 1..86,400 seconds. Once the rendezvous rolling limit
lands, it uses the earliest retained admission expiry. Rejected durable calls
do not keep incrementing the stored count.

Reason values are a closed route/dimension vocabulary: `global_burst`, the
`compat_status_daily`, `compat_directory_*`, `compat_otp_*`, and
`compat_update_*` burst/daily
variants, `publish_burst|daily`, and the rendezvous client/server burst/daily
variants. The `Retry-After` header and `retry_after_seconds` body member are
generated from one bounded value.

A request-control binding/D1 failure or malformed/over-policy configuration
fails closed with `503 request_control_unavailable`, `Cache-Control: no-store`,
and `Retry-After: 60`. It is never treated as admission. Configuration may
lower a canary ceiling but cannot raise the reviewed maxima; the Worker also
strictly bounds OTP/listing/retention lifetimes and uses the classifier's fixed
body-size contract rather than a second environment override.

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

Shared networks are why anonymous source budgets remain materially larger than
normal use and why the source/server-pair dimension is separate. A producer
must still use exponential backoff with jitter and honor `Retry-After`; rate
limiting is not a substitute for fixing a retry loop.

Native current/previous alias checks are sequential and conservative: if the
second rejects, the first may already have been charged locally. D1 remains the
exact daily authority. For rolling `A/Z` to `B/A` deployments, an admission
advances the requested pair from the maximum equal-expiry count; this heals a
lagging alias without resetting the budget. Expiry/window divergence and D1
errors fail closed.

Rotation temporarily doubles anonymous counter rows/writes. The hourly task
round-robins servers, OTPs, legacy counters, and request budgets through at most
eight indexed batches of 1,000 rows per state class (8,000/class/run and no more
than 36 D1 statements including backlog probes). If expired rows remain, the
scheduled invocation fails so the bounded `unexpected_error` diagnostic and
platform error alerts expose the backlog. Operators should inspect only
aggregate age/count queries—never actor keys—to diagnose it.
