# Cloudflare edge request policy

In-Worker limits cannot reduce Worker invocation count because they run after
an invocation begins. Production therefore needs a zone-level request gate and,
where the plan supports the required fields, a WAF rate-limiting rule in front
of each canonical dynamic edge. This document is a reviewed operator
specification; it does not authorize an automated deployment.

The Workers Builds automatic-`main` entrypoint validates this boundary but does
not own zone rules, DNS, Custom Domain attachment, triggers, or secret
rotation. Drift fails before upload and requires a separately authorized
operator correction followed by an exact-current-main provider retry. The
protected production Wrangler documents name only the two canonical dynamic
Custom Domains; the core remains domainless, and all three retain
`workers_dev: false` and `preview_urls: false`.

Cloudflare documents the current [rate-limiting rule parameters][rate-params],
[plan availability][rate-rules], and immutable [raw URI field][raw-uri]. Check
those references and the target zone entitlement immediately before applying a
rule. Record the resulting ruleset and rule IDs in the private deployment
record, not in this repository.

## Public-host boundary

All three production Wrangler configurations set both `workers_dev` and
`preview_urls` to `false`. Do not enable either: a public `workers.dev` or
preview hostname bypasses zone rules attached to `atrinik.org`. The canonical
publisher/rendezvous configurations are deliberately domainless and disabled
until their own exact-host rules pass this gate. The core alone owns D1, R2,
schedules, Analytics Engine, and both Durable Objects; each edge has one named
Service Binding and distinct native rate namespace IDs. A canary must use
separately reviewed Workers, hostname, secrets, D1 database, Durable Object
namespaces, Analytics Engine datasets, canonical hostname values, and unique
account-wide `namespace_id` values for each native Rate Limiting binding. The
[Worker Rate Limiting binding
contract][worker-rate-binding] shares counters across Workers that reuse a
namespace, so a production ID invalidates both isolation and results.

## Static directory hostnames

`meta.atrinik.org` and `classic.meta.atrinik.org` are [direct R2 custom
domains][r2-public], not Worker routes. Keep each bucket's `r2.dev` URL
disabled. Before attaching a hostname, install one exact-host custom rule per
hostname whose action is `Block` outside that hostname's allowlist. Keep the
two rules separate so `classic.meta.atrinik.org` can be activated and proved
without changing traffic for `meta.atrinik.org`:

```text
http.host eq "classic.meta.atrinik.org" and not (
  http.request.method in {"GET" "HEAD"} and
  raw.http.request.uri.query eq "" and
  not (raw.http.request.uri.path contains "%") and
  not (raw.http.request.uri.path contains "\\") and
  raw.http.request.uri.path in {
    "/" "/index.html" "/index.json" "/index.xml"
  } and
  http.request.uri.path in {
    "/" "/index.html" "/index.json" "/index.xml"
  }
)

http.host eq "meta.atrinik.org" and not (
  http.request.method in {"GET" "HEAD"} and
  raw.http.request.uri.query eq "" and
  not (raw.http.request.uri.path contains "%") and
  not (raw.http.request.uri.path contains "\\") and
  raw.http.request.uri.path in {
    "/" "/index.html" "/index.json" "/index.xml"
  } and
  http.request.uri.path in {
    "/" "/index.html" "/index.json" "/index.xml"
  }
)
```

This denies `/manifest.json`, immutable generation keys, uploads, alternate
path spellings, queries, and every unreviewed object even if it exists in the
public alias bucket. Attach no Worker route to either hostname. Add exact
plaintext Redirect Rules for `GET` and `HEAD` with no query. `/`,
`/index.html`, `/index.json`, and `/index.xml` each redirect to the identical
host and path. Every redirect is permanent `308` and changes only the scheme.
Never redirect an unexpected query, path, or method. Those targets remain
blocked, and no redirect may invoke a Worker.

After the scheme upgrade, direct R2 HTTPS requests to `/` return `404`; R2 does
not list a bucket root and the edge must not synthesize an `/index.html`
redirect. The static-origin verifier proves that HTTPS GET and HEAD behavior,
while the ingress verifier separately proves the plaintext same-path `308`.

The static Redirect Rule expressions must include `not ssl`, the exact methods,
empty raw query, rejection of `%` and `\`, and identical explicit four-path
allowlists for both the raw and normalized path fields. Cloudflare expressions
do not support comparing those two fields directly. Use a dynamic target that
changes only the scheme and preserves the exact authority and raw path.

Keep `meta.atrinik.org` unattached while Game rollout is disabled. Its eventual
origin is the static Game R2 bucket, never a Worker. A canary substitutes its
exact non-production hostnames in the expression; copying either production
hostname is a stop condition.

Add a Cache Rule for only the three `index.*` paths whose method set is exactly
`GET`, `HEAD`, and `PURGE`:

```text
http.host eq "classic.meta.atrinik.org" and
http.request.method in {"GET" "HEAD" "PURGE"} and
raw.http.request.uri.query eq "" and
raw.http.request.uri.path in {"/index.html" "/index.json" "/index.xml"} and
http.request.uri.path in {"/index.html" "/index.json" "/index.xml"}
```

The corresponding `meta.atrinik.org` and isolated-canary rules substitute only
their exact reviewed hostname. `PURGE` is present because Cloudflare evaluates
[single-file invalidation][single-file-purge] against Cache Rules with that
method; omitting it can make an accepted purge ineffective. It belongs only in
this cache expression.
The public custom-WAF allowlist, Redirect Rules, and Response Header Transform
Rules remain `GET`/`HEAD`-only, so a public `PURGE` request is never authorized.

The Cache Rule makes HTML, JSON, and XML cache eligible while respecting the
origin's `Cache-Control` and absolute `Expires`. Do not configure an edge TTL override,
stale-if-error, cache-key query normalization, or serve-stale behavior. A cache
fill late in an alias lifetime must expire at the same absolute instant as the
body. The resulting hard stale-data bound is the embedded artifact expiry,
which is at most four hours; clients also reject an expired body. R2's
[custom-domain cache consistency][r2-consistency] is necessarily weaker than
direct bucket reads. After a verified alias cohort is checkpointed, the core
builder uses Cloudflare's global single-file purge API for exactly that
profile's three HTTPS `index.*` URLs. This event-driven purge is the normal
freshness path and preserves the long cache lifetime between updates. Absolute
artifact expiry remains the fail-safe correctness bound if the purge service
is unavailable; purge is never a rollback substitute.

Use Response Header Transform Rules on the three `index.*` paths to set:

- `X-Content-Type-Options: nosniff`;
- `Access-Control-Allow-Origin: *`; and
- `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline';
  base-uri 'none'; form-action 'none'; frame-ancestors 'none'`.

Do not replace or synthesize `ETag`, `Last-Modified`, `Content-Type`,
`Cache-Control`, or `Expires`. R2 owns the opaque strong ETag and alias-upload
Last-Modified. The builder owns the exact media type and absolute expiry. The
application SHA-256 in private coordination metadata is an independent body
integrity value, not an HTTP validator.

Apply and fetch these rules through their owning Cloudflare ruleset phases,
preserve unrelated rule ordering, and record only the rule IDs and reviewed
expressions in the private deployment record. The isolated custom-domain
canary in `DEPLOYMENT.md` is required before production attachment. Once an
operator has applied the rules, run the repository's read-only verifier against
each canary hostname:

```sh
python3 scripts/static_origin_canary.py \
  --profile classic-v1 \
  --base-url https://classic-directory-canary.example.org \
  --json
python3 scripts/static_origin_canary.py \
  --profile classic-v2 \
  --base-url https://classic-v5-directory-canary.example.org \
  --alias-prefix canary-v5 \
  --json
python3 scripts/static_origin_canary.py \
  --profile game-v1 \
  --base-url https://game-directory-canary.example.org \
  --json
```

Substitute only the exact isolated hostnames from the reviewed deployment
record. The isolated v5 rule substitutes only `/canary-v5/` and the three
`/canary-v5/index.*` paths for the root allowlist above; never add that prefix
to the production hostname rule. The script has no mutation path or Cloudflare
credential input;
resource creation, ruleset changes, and teardown remain separately authorized.

## Retired-target gate

Remove the old `meta.atrinik.org` dynamic allowlist and its rate-limiting rule.
Keep that hostname unattached until static Game rollout. The static exact-host
rule above and the canonical publisher/rendezvous block-outside rules must deny
the explicit retired CGI and public `/v2` negative probes before any Worker
invocation. Read back rule IDs, enabled actions, expressions, and ordering after
the change. Worker Metrics and primary D1 snapshots must remain unchanged for
the bounded probe cohort. Never attach the core Worker merely to return a
retirement response.

## Dedicated rendezvous hostname

Install a separately named raw-target gate and rate rule on the canonical
rendezvous hostname before attaching its Custom Domain. The coarse
raw-target envelope is:

```text
http.host eq "rendezvous.meta.atrinik.org" and not (
  starts_with(lower(raw.http.request.full_uri),
              "https://rendezvous.meta.atrinik.org/") and
  http.request.method eq "GET" and (
    (starts_with(raw.http.request.uri.path, "/v1/servers/") and
     len(raw.http.request.uri.path) eq 76) or
    (starts_with(raw.http.request.uri.path, "/v1/classic/servers/") and
     len(raw.http.request.uri.path) eq 84)
  ) and
  not (raw.http.request.uri.path contains "%") and
  not (raw.http.request.uri.path contains "\\") and
  not (raw.http.request.uri.path contains "//") and
  not (raw.http.request.uri.path contains "/./") and
  not (raw.http.request.uri.path contains "/../") and
  raw.http.request.uri.query in {"role=client" "role=server"}
)
```

The HTTPS authority prefix makes plaintext part of the block-outside rule;
never redirect a WebSocket upgrade.

The Worker remains responsible for the exact route shape, 64-hex server ID,
WebSocket headers, role, and authentication. Do not add health, directory,
challenge, or update paths to this host.

The automatic delivery canary stays inside this envelope: it uses `GET` on the
84-byte Classic server path with `role=server` and canonical WebSocket headers,
but no credential. When the circuit is enabled, the fixed `404` proves the
named core Service Binding; when disabled, the exact `503` and retry value
prove the intended closed edge. It never requires a WAF exception.

Where the plan supports the required host/method/path fields, use a source-IP
characteristic and an initial 60 requests per 60 seconds with a 60-second
mitigation for this dedicated dynamic host. This WAF ceiling is a coarse
pre-invocation shield shared by clients behind one NAT, not the rendezvous
admission authority. The Worker applies one 60/minute client-native shield
without also charging the global bucket, then an exact eligible-pair rolling
burst/cooldown in D1. Server-role native/daily policy is unchanged. The
per-server Durable Object retains atomic current/previous-key replay-alias
claims and structural work limits but no ordinary daily session quota. Canary
and alert on all three layers independently.

Keep `workers.dev` and preview URLs disabled on every deployment so edge policy
has no bypass.

## Dedicated publisher hostname

Before enabling `publish.meta.atrinik.org`, install a custom WAF rule whose
action is `Block` outside this raw target envelope:

```text
http.host eq "publish.meta.atrinik.org" and not (
  starts_with(lower(raw.http.request.full_uri),
              "https://publish.meta.atrinik.org/") and
  http.request.method eq "POST" and
  raw.http.request.uri.query eq "" and
  not (raw.http.request.uri.path contains "%") and
  not (raw.http.request.uri.path contains "\\") and
  not (raw.http.request.uri.path contains "//") and
  not (raw.http.request.uri.path contains "/./") and
  not (raw.http.request.uri.path contains "/../") and
  not (raw.http.request.uri contains "?") and (
    (starts_with(raw.http.request.uri.path, "/v1/servers/") and
     len(raw.http.request.uri.path) eq 84) or
    (starts_with(raw.http.request.uri.path, "/v1/classic/servers/") and
     len(raw.http.request.uri.path) eq 92) or
    (starts_with(raw.http.request.uri.path, "/v2/classic/servers/") and
     len(raw.http.request.uri.path) eq 92)
  ) and
  ends_with(raw.http.request.uri.path, "/publish")
)
```

The HTTPS authority prefix is part of the allowlist, so plaintext is blocked
before Worker invocation and is never redirected. The Worker remains the exact
authority for the 64-hex server ID, path suffix, content headers, bounded body,
certificate identity, signature, sequence, and nonce. Do not add a directory,
rendezvous, or health route to this hostname.

The automatic delivery canary stays inside this envelope: it uses `POST` on
the non-retirable 92-byte Classic v2 publish path with a bounded JSON body and
a syntactically valid but cryptographically invalid signature. When the
circuit is enabled, the coordinator's fixed `401` proves the named core
Service Binding, including after global v1 retirement; when disabled, the
exact `503` and retry value prove the intended closed edge. It never requires
a WAF exception, private credential, or publication write.

## Per-host staged HSTS

Only after the exact HTTPS host has stable TLS, a rehearsed circuit/domain
rollback, passing HTTPS canaries, and the plaintext rules above, install a
response-header transform for that one hostname and `ssl`. Start with exactly:

```text
Strict-Transport-Security: max-age=300
```

Do not include `includeSubDomains` or `preload`; the wider `atrinik.org`
namespace has not passed that audit. Set rather than append the header so every
HTTPS response has one value, including Cloudflare error responses. Never emit
HSTS on plaintext responses. Observe at least the complete five-minute window
before raising the host's max age in a separately reviewed change.

Rollback keeps HTTPS available, sets `max-age=0` on the same exact hostname,
waits out the preceding max-age window, and only then removes the transform or
detaches that hostname. Closing a Worker circuit does not require removing
HTTPS or HSTS. Never disable TLS, pause Cloudflare, or move the hostname to
DNS-only while a positive max age may remain cached.

## Canary and release gate

Use a non-production hostname in every command below. Substitute only a
reviewed canary hostname and never send this loop to production:

```sh
curl --fail-with-body --path-as-is \
  https://CANARY_HOST/v2/servers
curl --path-as-is \
  https://CANARY_HOST/%2e/v2/servers
curl --path-as-is \
  'https://CANARY_HOST/v2/servers?unexpected=1'
for request in $(seq 1 11); do
  curl --silent --output /dev/null --write-out '%{http_code}\n' \
    https://CANARY_HOST/index.wsgi/otp
done
```

After installing the isolated static, publisher, rendezvous, redirect, and
staged-HSTS rules, run the bounded credential-free ingress verifier once per
enabled static hostname. Pass the exact base URLs derived from service/account
metadata and publisher/rendezvous active-version URLs returned by the version
`urls` metadata. The core implements Durable Objects, for which Cloudflare does
not generate preview URLs; require its active-version metadata to prove that
absence rather than fabricating a URL:

```sh
python3 scripts/edge_ingress_canary.py \
  --static-host classic-directory-canary.example.org \
  --publisher-host publish-canary.example.org \
  --rendezvous-host rendezvous-canary.example.org \
  --hsts-max-age 300 \
  --core-base-url https://atrinik-metaserver.account-name.workers.dev/ \
  --publisher-base-url https://atrinik-metaserver-publisher.account-name.workers.dev/ \
  --publisher-version-url https://version-prefix-atrinik-metaserver-publisher.account-name.workers.dev/ \
  --rendezvous-base-url https://atrinik-metaserver-rendezvous.account-name.workers.dev/ \
  --rendezvous-version-url https://version-prefix-atrinik-metaserver-rendezvous.account-name.workers.dev/ \
  --json
python3 scripts/edge_ingress_canary.py \
  --static-host game-directory-canary.example.org \
  --publisher-host publish-canary.example.org \
  --rendezvous-host rendezvous-canary.example.org \
  --hsts-max-age 300 \
  --core-base-url https://atrinik-metaserver.account-name.workers.dev/ \
  --publisher-base-url https://atrinik-metaserver-publisher.account-name.workers.dev/ \
  --publisher-version-url https://version-prefix-atrinik-metaserver-publisher.account-name.workers.dev/ \
  --rendezvous-base-url https://atrinik-metaserver-rendezvous.account-name.workers.dev/ \
  --rendezvous-version-url https://version-prefix-atrinik-metaserver-rendezvous.account-name.workers.dev/ \
  --json
```

It requires same-host/path plaintext `308` responses only for the four exact
static aliases, requires an exact WAF `403` for every negative static target
and both dynamic plaintext requests without redirects, proves all five
account-derived alternate Worker URLs unavailable, requires one exact staged HSTS header on
all three HTTPS response classes, and rejects leaked internal Worker metadata.
It accepts no token and cannot mutate Cloudflare. A `403` alone does not prove
pre-Worker enforcement: correlate all eight fixed block probes with WAF
Security Events and Worker Metrics and require the expected Security Events
with zero Worker invocation delta.

The canonical request must reach the Worker, the two raw/extra-query requests
must be blocked before it, and the controlled loop must be edge-mitigated after
the configured threshold. Confirm in zone security analytics that mitigated
requests stop increasing Worker invocations. Then verify that in-Worker `429`
tests still stop D1/application mutation when the WAF rule is temporarily
skipped in the isolated canary.

For a rendezvous canary, repeat the controlled upgrade test on the isolated
rendezvous hostname while one authenticated server-control socket is live.
Confirm WAF mitigation stops Worker upgrades, Worker/D1 source limits stop room
work, and the Durable Object's exact rolling limit returns its own bounded
`429` after the configured number of accepted sessions. Repeat from a shared
NAT test path and record which approximate source ceilings are shared; do not
weaken the exact per-server limit to compensate.

With the WAF/native controls below their canary ceilings, claim one ticket,
disconnect the server, allow the room to evict, reconnect the authenticated
server, and replay that ticket from a new client. The room must reject it before
candidate forwarding while a fresh ticket still succeeds. This proves the
24-hour SQLite HMAC replay ledger, rather than a live attachment or an edge
counter, owns reconstruction-safe single use.

Do not attach or move the production custom domain until all of these are true:

1. the production Worker exposes no `workers.dev` or preview hostname;
2. the enabled raw-target rule exactly matches the approved expression;
3. the rate rule is enabled, or the plan exception and fallback risk are
   explicitly approved;
4. aggregate Worker/WAF alerts and scheduled-cleanup failure alerts exist;
5. the isolated canary passes replay-after-reconstruction and HMAC-only room
   storage inspection with its distinct bindings; and
6. rollback detaches the custom domain without re-enabling an alternate public
   Worker hostname.

[rate-params]: https://developers.cloudflare.com/waf/rate-limiting-rules/parameters/
[rate-rules]: https://developers.cloudflare.com/waf/rate-limiting-rules/
[raw-uri]: https://developers.cloudflare.com/ruleset-engine/rules-language/fields/reference/raw.http.request.full_uri/
[r2-consistency]: https://developers.cloudflare.com/r2/reference/consistency/
[r2-public]: https://developers.cloudflare.com/r2/buckets/public-buckets/
[single-file-purge]: https://developers.cloudflare.com/cache/how-to/purge-cache/purge-by-single-file/
[worker-rate-binding]: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
