# Directory activity ranking

The directory order is a private, versioned policy (`atrinik-directory-ranking-v1`)
applied independently to `classic-v1`, `classic-v2`, and `game-v1`. Public
artifacts expose the same eligible set and order, but never expose a score,
history row, administrator note, or ranking state.

## Activity signal

Each accepted authenticated public publication records one bounded population
observation for its profile and certificate identity. A private publication
removes that identity's activity state. The state contains the latest
observation, the latest positive observation timestamp, and at most eight daily
aggregate buckets (the current bucket plus the seven preceding buckets). A
bucket stores positive seconds, player-minutes, maximum clamped population, and
positive/zero observation counts. It does not store player IDs, login
identities, addresses, tickets, or per-player history.

The rolling window is seven days. An interval contributes only when the prior
observation had a positive population and the next heartbeat is no more than
15 minutes later; longer gaps contribute no duration. Populations above
100,000 are clamped for ranking, while the existing public protocol field keeps
its own validated value. The score is a bounded integer from 0 through
1,000,000:

- 45% positive-time coverage;
- 35% player-minutes normalized against the clamped population ceiling;
- 20% of the seven daily buckets with positive observations; and
- a linear freshness multiplier from the latest positive observation that
  reaches zero at the window boundary.

A fresh positive first observation receives score 1 while history warms. A
zero-player observation stops interval accrual and updates the zero count, but
does not refresh positive recency; repeated zero heartbeats therefore let old
activity decay. The current population and last accepted public heartbeat
remain deterministic tie-breakers, so a low-volume or new server is still
discoverable. The published order is, in sequence: active administrator
priority (lower number first), score descending, clamped current population
descending, last heartbeat descending, and lowercase certificate identity
ascending.

Activity writes are part of the authenticated publication transaction. A
repeated heartbeat refreshes presence and aggregate state without advancing a
directory revision, creating an outbox row, or nudging the builder. The
five-minute scheduled/profile alarm observes the aggregate state; only a
changed public order causes a new artifact generation at the existing D1
revision. This keeps publication cadence bounded while preserving coherent
HTML, JSON, and XML output.

## Administrator pins

Pins are profile-scoped by canonical server identity and carry a priority from
0 through 1,000, an optional expiry timestamp, and a bounded private operator
note. They are ordering hints only. The builder queries the already eligible
public set first, then applies active pins; a pin cannot resurrect a missing,
private, expired, malformed, or denied server. Publisher and reader routes have
no pin mutation capability.

Generate reviewable SQL locally and apply it only through the separately
authorized D1 operator procedure:

```sh
python3 scripts/admin_sql.py pin-add classic-v1 <server-id> 10 \
  --expires-at 1798761600 --note "launch partner"
python3 scripts/admin_sql.py pin-remove classic-v1 <server-id>
```

Review the generated SQL before the authorized operator executes it. The
profile and identity are fixed in the statement, the pin table is bounded to
512 rows per profile, and no public response or metric includes the note.
