# Rendezvous admission-v1 implementation

The normative wire contract is `protocol/spec/rendezvous-admission.md`. Every
Classic client requires admission-v1; old clients receive a fixed noncacheable
428 and clients never fall back when the challenge endpoint is unavailable.
Server-control authentication and signaling frames retain their existing format.

`POST /v1/rendezvous/challenge/classic/{serverId}` accepts only the canonical
JSON object `{"schema":"atrinik-rendezvous-admission-v1","ticketHash":"…"}`,
where the hash is SHA-256 of the 32 binary ticket bytes. The request is at most
256 bytes, the response at most 512, and both use the exact configured HTTPS
authority without a query, cookies, compression or redirects. The response
contains `schema`, `challenge`, `difficulty:24` and decimal UTC `expiresAt` in
that order. Issuance is blind for every valid server ID: no presence, D1, room,
or persisted challenge state is consulted. The shared client ingress counter
and circuit breaker apply before issuance.

The challenge is `v1.KEYID.IAT.TICKETHASH.NONCE.MAC`. `IAT` is a canonical
positive UTC-second decimal, the nonce is 16 random bytes in lowercase hex,
and expiry is exactly `IAT + 60`. HMAC-SHA256 uses the current key and the
purpose bytes `atrinik-rendezvous-admission-v1` followed by NUL, the authority,
NUL, `classic`, NUL, server ID, NUL and the token prefix before MAC. Current and
previous keys verify; the existing strictly more than 24-hour rotation overlap
is required to preserve ticket replay rejection.

The client computes SHA-256 of ASCII `atrinik-rendezvous-work-v1`, NUL, the
complete challenge, NUL and a 16-lowercase-hex solution. Exactly the first 24
bits must be zero. `X-Atrinik-Rendezvous-Admission` carries `TOKEN.SOLUTION`
in at most 256 bytes. An ordinary upgrade also supplies
`X-Atrinik-Rendezvous-Ticket`. A protected upgrade instead supplies the grant
as `Authorization: Bearer …` and its `X-Atrinik-Access-Client-Nonce`; its grant
is the ticket. Public callers cannot supply internal headers. Server-role
requests cannot carry any client-only header. Missing proof returns fixed 428;
invalid work, binding or expiry returns fixed 403 before presence/room lookup.

The exact internal `/v5` envelope adds `X-Atrinik-Rendezvous-V5-Admission:
work-v1-24`, `X-Atrinik-Rendezvous-V5-Ticket`,
`X-Atrinik-Rendezvous-V5-Admission-Expires`, and, only for protected clients,
`X-Atrinik-Rendezvous-V5-Client-Nonce`. It retains the role, protocol,
authorization and generation headers under the V5 prefix. Extra headers, old
versions and missing attestations fail closed.

The room serializes admission with publication and revocation. Protected grants
are redeemed once in D1 before reservations or sockets. After asynchronous work,
the room checks proof/grant expiry, live authorization, generation, control and
capacity again. One SQLite transaction reserves and claims the purpose-separated
current/previous ticket replay aliases before `WebSocketPair` or socket acceptance.
A replay leaves no new row; a successful claim remains for 24 hours even when
later allocation or delivery fails. There is no rollback of grant redemption.
The final post-alarm check repeats authorization, expiry and local control fences
before returning 101.

Version-4 live attachments retain the binary-ticket binding hash. Protected
attachments additionally retain the bounded grant, nonce, redemption ID and grant
expiry. `access_init` must confirm the exact preauthorized grant and nonce within
two seconds; successful confirmation extends only to the original attempt/grant
ceiling. It never supplies alternative authentication. Candidates must match the
prebound ticket, with a final authorization and local liveness check after
hashing. Terminal teardown clears all credentials, ticket hashes and routing data.
The unchanged SQLite HMAC aliases survive hibernation, control generations and
supported overlapping key rotation.

Fixed 24-bit work increases computational cost; it cannot guarantee fairness
against an anonymous attacker and introduces no IP/source correlation. The
native solver is bounded to 2^27 trials and ten seconds within the original
attempt deadline, checking cancellation/deadline at least every 4096 trials.
Representative native cost and slower-device timeout behavior must be measured;
there is no difficulty reduction or silent bypass. A challenge and its upgrade
both consume the unchanged shared client ingress ceiling. This implementation
changes no deployed provider rule or retention setting.
