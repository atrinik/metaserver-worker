# Cloudflare edge request policy

In-Worker limits cannot reduce Worker invocation count because they run after
an invocation begins. Production therefore needs a zone-level request gate and,
where the plan supports the required fields, a WAF rate-limiting rule in front
of the compatibility Worker. This document is a reviewed operator
specification; it does not authorize an automated deployment.

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
namespaces, Analytics Engine datasets, `COMPAT_HOSTNAME` value, and unique
account-wide `namespace_id` values for each native Rate Limiting binding. The
[Worker Rate Limiting binding
contract][worker-rate-binding] shares counters across Workers that reuse a
namespace, so a production ID invalidates both isolation and results.

## Static directory hostnames

`meta.atrinik.org` and `classic.meta.atrinik.org` are [direct R2 custom
domains][r2-public], not Worker routes. Keep each bucket's `r2.dev` URL
disabled. Before attaching a hostname, install one exact-host custom rule per
environment (or one reviewed equivalent expression) whose action is `Block`
outside this allowlist:

```text
http.host in {"meta.atrinik.org" "classic.meta.atrinik.org"} and not (
  http.request.method in {"GET" "HEAD"} and
  raw.http.request.uri.query eq "" and
  raw.http.request.uri.path eq http.request.uri.path and
  not (raw.http.request.uri.path contains "%") and
  not (raw.http.request.uri.path contains "\\") and
  raw.http.request.uri.path in {
    "/" "/index.html" "/index.json" "/index.xml"
  }
)
```

This denies `/manifest.json`, immutable generation keys, uploads, alternate
path spellings, queries, and every unreviewed object even if it exists in the
public alias bucket. Attach no Worker route to either hostname. Add an exact
root Redirect Rule from `/` with no query to the same host's `/index.html`
using permanent `308`; it must not redirect a machine alias, cross hosts, or
introduce a Worker invocation.

Do not enable the static rule for `meta.atrinik.org` while the temporary
compatibility Worker owns that hostname: it would block the compatibility
publisher and rendezvous routes. Canary with isolated hostnames, attach
`classic.meta.atrinik.org` first, complete the documented consumer window,
then detach the compatibility Worker before enabling the static `meta` rule and
R2 custom domain. A canary substitutes its exact non-production hostnames in
the expression; copying either production hostname is a stop condition.

Add a Cache Rule for only the three `index.*` paths and `GET`/`HEAD` that makes
HTML, JSON, and XML cache eligible while respecting the origin's
`Cache-Control` and absolute `Expires`. Do not configure an edge TTL override,
stale-if-error, cache-key query normalization, or serve-stale behavior. A cache
fill late in an alias lifetime must expire at the same absolute instant as the
body. The resulting hard stale-data bound is the embedded artifact expiry,
which is at most four hours; clients also reject an expired body. R2's
[custom-domain cache consistency][r2-consistency] is necessarily weaker than
direct bucket reads. Purge may reduce normal removal latency but is not a
correctness or rollback dependency.

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
canary in `DEPLOYMENT.md` is required before production attachment.

Before attaching `meta.atrinik.org` to the temporary compatibility Worker,
install a zone custom rule named
`Atrinik metaserver canonical compatibility targets`. Its action is `Block` and
its logical allowlist is:

```text
http.host eq "meta.atrinik.org" and not (
  starts_with(lower(raw.http.request.full_uri),
              "https://meta.atrinik.org/") and (
    (http.request.method eq "GET" and
     raw.http.request.uri in {"/" "/v2/servers" "/index.wsgi/otp"}) or
    (http.request.method eq "POST" and
     raw.http.request.uri eq "/index.wsgi/update") or
    (http.request.method eq "GET" and
     starts_with(raw.http.request.uri.path, "/v2/rendezvous/") and
     raw.http.request.uri.path eq http.request.uri.path and
     not (raw.http.request.uri.path contains "%") and
     not (raw.http.request.uri.path contains "\\") and
     raw.http.request.uri.query in {"role=client" "role=server"})
  )
)
```

The Worker remains the final validator for the 64-hex server ID, headers,
WebSocket upgrade, content type, and body stream. The edge rule removes other
host/path/method/query probes and ambiguous raw path spellings before they
invoke it. HTTP fragments are not transmitted to a server and therefore cannot
be an edge rule input.

Treat this expression as structured policy, not a string to append blindly.
Fetch the zone `http_request_firewall_custom` entrypoint ruleset, preserve every
unrelated rule and ordering constraint, add or update only the named rule, then
fetch it again and compare its enabled expression/action with this document.

## Pre-Worker rate rule

When the plan can match both host and method/path, create a rate-limiting rule
named `Atrinik metaserver compatibility global burst` with:

```text
http.host eq "meta.atrinik.org" and (
  (http.request.method eq "GET" and
   http.request.uri.path in {"/" "/v2/servers" "/index.wsgi/otp"}) or
  (http.request.method eq "POST" and
   http.request.uri.path eq "/index.wsgi/update") or
  (http.request.method eq "GET" and
   starts_with(http.request.uri.path, "/v2/rendezvous/"))
)
```

- match: the five allowed route families above on
  `http.host eq "meta.atrinik.org"`;
- counting characteristic: source IP;
- threshold: 10 requests in 60 seconds;
- mitigation: block for 60 seconds; and
- origin-only counting: enabled (every matched route is dynamic).

This is an invocation-cost guard, not the privacy-preserving application
identity. Cloudflare owns the edge counter; the Worker never copies its raw key
to D1 or logs. Route-specific native bindings and exact pseudonymous D1 budgets
remain mandatory because an IP edge counter is plan/local-policy dependent and
shared networks need higher daily recovery allowances.

Some plans cannot include the host/method fields needed to scope a rate rule
safely within the whole `atrinik.org` zone. Do not install a path-only rule that
could throttle unrelated hosts. Record the unsupported entitlement as a
release risk, keep the in-Worker fallback, alert on aggregate invocation growth,
and prioritize the static-directory and producer cutovers. The raw-target
custom rule and disabled alternative Worker hostnames remain deployment gates.

## Dedicated rendezvous hostname

While rendezvous remains a compatibility path on `meta.atrinik.org`, both edge
rules above must include it. When the canonical rendezvous entrypoint moves to
`rendezvous.meta.atrinik.org`, install a separately named raw-target gate and
rate rule on that hostname before attaching its Custom Domain. The coarse
raw-target envelope is:

```text
http.host eq "rendezvous.meta.atrinik.org" and
http.request.method eq "GET" and (
  starts_with(raw.http.request.uri.path, "/v1/servers/") or
  starts_with(raw.http.request.uri.path, "/v1/classic/servers/")
) and
raw.http.request.uri.path eq http.request.uri.path and
not (raw.http.request.uri.path contains "%") and
not (raw.http.request.uri.path contains "\\") and
raw.http.request.uri.query in {"role=client" "role=server"}
```

The Worker remains responsible for the exact route shape, 64-hex server ID,
WebSocket headers, role, and authentication. Do not copy the compatibility
health, directory, OTP, or update paths onto this host.

Where the plan supports the required host/method/path fields, use a source-IP
characteristic and an initial 10 requests per 60 seconds with a 60-second
mitigation for this dedicated dynamic host. This WAF ceiling is a coarse
pre-invocation shield shared by clients behind one NAT, not the rendezvous
admission authority. The Worker still applies the 5/minute client and 3/minute
server-role native bindings and pseudonymous daily budgets; the per-server
Durable Object still applies the exact 50-session rolling window, atomic
current/previous-key replay-alias claim, and structural work limits. Canary and
alert on all three layers independently.

After the dedicated rule passes its release gate, remove rendezvous from the
compatibility rule in the same coordinated consumer cutover. Keep
`workers.dev` and preview URLs disabled on both deployments so neither edge
policy has a bypass.

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
[worker-rate-binding]: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
