# Access-token profile retirement plan

`retire-legacy-profiles.sql` is a review artifact, not an automatic D1 migration.
The source change does **not** authorize running it, uploading it, reopening any
circuit, changing an alias, or deploying a Worker. The migration runner must
continue to discover only `migrations/*.sql`.

The active receiver accepts Classic publisher v3 and Game publisher v2 only.
Migration 0013 retains older signed policy rows as inert evidence and seeds the
active replay namespace with the highest Classic v1/v2 or Game v1 sequence and
the union of retained nonces. This plan removes that temporary storage once an
operator has separately authorized and proven the completed cutover. It never
translates a password or access-code policy into access-token policy.

## Required live proof before any execution

A future operator must authorize the exact account, D1 database, source commit,
artifact SHA-256 and maintenance window. A separately reviewed executor must
verify these facts immediately before opening one transactional D1 batch:

1. All publisher/access-mutation, resolve, rendezvous and relevant builder/cron
   writers are closed or fenced. Drain in-flight work and prove the actual core
   and caller configurations and control sessions. A source default or old
   deployment report is not proof of live closure.
2. New Classic v6 and Game v2 directory cohorts have coherent immutable objects,
   aliases, D1 checkpoints, complete global cache purges and fresh public
   readbacks. Retired v4/v5/Game-v1 root/canary aliases and cached responses must
   no longer expose the retired contracts. Keep R2 evidence and any explicitly
   authorized deletion separate: this SQL cannot inspect or change R2/CDN state.
   Every profile outbox must be empty. If a historical outbox remains, resolve
   it under a separately reviewed cutover plan; do not delete it to bypass the
   gate.
3. A complete, restorable stopped-writer D1 snapshot is retained privately and
   its digest and restore verification recorded. Preserve applied migration
   files and old immutable protocol/schema fixtures. Record the exact current
   database schema digest and row inventory, including private access route,
   outcome, grant and budget tables introduced after 0013. Never place their
   contents, certificates or credentials in this public plan or logs.
4. Every retained old replay high-water has a same-owner active-profile value
   at least as high. Every unexpired historical nonce has an active-profile
   nonce with at least the same expiry. Active presence, policy, public entries,
   revisions/checkpoints/history, activity and pins are inventoried for exact
   post-transaction equality. Access routes, outcomes, grants and private rate
   budgets must remain unchanged. Unknown inbound foreign-key consumers require
   a new reviewed plan; the SQL rejects them before renaming any table.
5. The executing artifact bytes match the approved SHA-256, the source matches
   the reviewed commit, and the inspected schema matches the reviewed retirement
   horizon. The current artifact supports 0013's profile tables and 0014's
   independent access tables. Any later relevant schema change invalidates this
   evidence. Verify the fences again at the point of mutation.

Only that future executor may create a one-use
`access_token_retirement_authority` singleton as part of its authorized operation.
The required column contract is below; **there is deliberately no checked-in
remote command or automatic authority initializer**:

| Columns | Required value |
| --- | --- |
| `singleton`, `consumed` | Integer `1`, integer `0` |
| `publication_closed`, `rendezvous_closed`, `legacy_aliases_retired`, `backup_verified`, `active_provider_ready` | Integer `1` after the corresponding external checks |
| `source_commit` | Approved 40-character lowercase Git SHA |
| `sql_sha256`, `snapshot_sha256`, `alias_evidence_sha256`, `circuit_evidence_sha256` | Verified 64-character lowercase SHA-256 evidence digests |
| `issued_at`, `expires_at` | UTC integer seconds; issued no more than 300 seconds ago and expires within 300 seconds of issuance |

The marker records completed external verification; writing true flags or a
well-formed digest does not itself perform that verification or grant permission.
D1 cannot authenticate operator approval, inspect live Worker/R2/CDN state, hash
its executing SQL, or prove restoration. The executor must verify those external
facts and bind the marker to the immutable approved artifact before submission.
Missing, consumed, expired or incomplete markers fail before destructive writes.

## Transaction and postconditions

Submit the entire retirement script as **one** D1 transaction/batch. It omits
`BEGIN`/`COMMIT` because the future executor owns the transaction. Never execute
its statements independently, disable foreign-key checking, or resume a partial
statement suffix. The first SQL assertions check authority freshness, inbound
foreign keys, replay coverage, all outboxes and active checkpoint freshness.
Any failed assertion must roll back the complete batch, including consumption of
the authority marker.

The script rebuilds the profile tables with only `classic-v3` and `game-v2`,
removes all old-profile rows, removes `password_required` and
`access_code_required`, and drops `classic_identity_modes` and
`classic_receiver_mode`. It preserves active replay values/nonces, authenticated
private certificate/name/endpoint/policy, public state, ranking and bounds.
Foreign keys, hostname/text validation, per-profile capacity, aggregate Game JSON
budget, outbox coalescing and bounded artifact retention remain enforced. The
consumed proof marker remains as minimal audit evidence; it grants no retry.

Before reopening any separately authorized circuit, require a clean foreign-key
check, equality of every retained active/private table against the fenced
snapshot, absence of all retired rows/columns/mode tables, no outstanding
outbox, and current new-profile parser/publication/resolve/rendezvous acceptance.
Verify that private certificate and access-route metadata never enter public
artifacts. A timeout or missing readback is not a successful retirement.

A lost transaction response requires exact readback under the same closed
fences. Never recreate the marker or replay the script to discover whether it
committed. A committed marker plus complete postconditions establishes success;
an intact pre-state establishes no commit. Any mixed or uncertain state requires
operator investigation and the verified snapshot, not automatic rollback or a
retired-protocol fallback.

## Source-only validation

Run `python3 -m unittest discover -s scripts -p test_directory_retirement.py`.
The in-memory SQLite tests cover populated preservation, removal of obsolete
schema, missing/expired/consumed authority, each required proof flag, replay and
nonce loss, unknown inbound foreign keys and uncheckpointed state. They do not
claim live D1, circuit, R2, purge, deployment or restore acceptance.
