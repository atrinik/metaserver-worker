# Rendezvous health handoff

The state-owning `atrinik-metaserver` Worker exposes one private named Service
Binding entrypoint, `RendezvousHealth`, for the Observatory follow-up tracked in
[observatory#18](https://github.com/atrinik/observatory/issues/18). The core has
no default `fetch` handler and the publisher/rendezvous public Workers do not
route to this entrypoint. There is no public room-status endpoint and no direct
Analytics Engine query.

## Private transport

The caller sends an exact request URL of
`https://internal.atrinik.invalid/v1/rendezvous-health` through the named
`RendezvousHealth` Service Binding with:

```http
Authorization: Bearer <RENDEZVOUS_HEALTH_EXPORT_TOKEN>
```

`RENDEZVOUS_HEALTH_EXPORT_TOKEN` is a required Cloudflare secret on the core
Worker and must be provisioned independently for the authorized Observatory
caller. It is never committed, returned, logged, or included in a canary body.
The binding is the private transport boundary; the exact URL, method, header
allowlist, token, and JSON shape are authenticated again by the core.

`GET` returns `application/json` with `Cache-Control: no-store`:

```json
{
  "schema": "rendezvous-health-v1",
  "observation_generation": 12,
  "source_timestamp": 1777060800,
  "observation_window": {
    "started_at": 1777060800,
    "duration_seconds": 300,
    "ended_at": 1777061100
  },
  "freshness": {
    "state": "fresh",
    "age_seconds": 2,
    "maximum_age_seconds": 300
  },
  "status": "healthy",
  "recent_authenticated_admissions": 1,
  "recent_sessions": {
    "total": 2,
    "outcomes": {
      "completed": 1,
      "client_disconnected": 0,
      "session_expired": 0,
      "protocol_error": 0,
      "server_unavailable": 0,
      "server_replaced": 0,
      "authorization_failed": 0,
      "internal_error": 1
    }
  },
  "canary": {
    "type": "end_to_end",
    "route": "reachable",
    "authenticated_control": "passed",
    "recent_admission": "passed",
    "observed_at": 1777060801
  },
  "reason": "canary_passed"
}
```

All timestamps are Unix seconds. `observation_generation` changes for every
accepted aggregate or canary observation. The singleton D1 row is reset at the
five-minute observation-window boundary; every counter is capped at 1,000,000.
The source is stale once its newest observation is more than 300 seconds old.

The status values are deliberately conservative:

- `healthy` requires a fresh positive observation: an authenticated server
  admission, a completed session, or a passing end-to-end canary.
- `failed` is reserved for an explicitly failed route/control/admission canary.
- `stale` means the last source observation is outside the freshness window.
- `no_usable_observation` covers an empty aggregate, malformed persisted state,
  or route-only evidence without authenticated control or recent admission.

When no persisted row exists, the response uses `reason: "no_observation"`.
When a row exists but fails semantic normalization at read time, the response
uses the same bounded, all-zero shape with `reason: "malformed_observation"`.
Both cases are intentionally safe `no_usable_observation` results; neither
exports the rejected row or any private rendezvous data.

The canary `type` is either `route` or `end_to_end`. A route canary records only
reachability and can never by itself make the status healthy. An end-to-end
canary records three separate dimensions: route reachability,
authenticated-control success, and recent-admission success. A private `POST`
to the same entrypoint accepts only that bounded, credential-free canary
fixture; the core supplies `observed_at`.

## Evidence and privacy boundary

The aggregate is produced in the state-owning core from the existing bounded
terminal session outcome metric and successful authenticated server admission
path. D1 retains only the generation, timestamps, low-cardinality counters, and
the canary dimensions above. It does not retain or export server IDs, room or
connection identifiers, tickets, candidates, credentials, or source addresses.

The aggregate is not an active-room count. Observatory must not infer one from
`server_presence`, `directory_entries`, publication rows, or any of the
low-cardinality counters. This handoff is a source contract only; enumeration,
consumer storage, API presentation, and UI behavior remain the separate scope
of observatory#18.

Unauthorized, alternate-route, extra-header, malformed, and over-sized
requests fail closed. A storage failure returns a fixed private 503. The
public edges and public WebSocket routes remain unchanged. Provider-side
Service Binding wiring and the operator-owned canary schedule/configuration are
required follow-up deployment inputs and do not belong in this repository.
