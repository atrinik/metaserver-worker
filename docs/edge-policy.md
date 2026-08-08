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

The production Wrangler configuration sets both `workers_dev` and
`preview_urls` to `false`. Do not enable either on the production Worker: a
public `workers.dev` or preview hostname bypasses zone rules attached to
`atrinik.org`. A canary must use a separately reviewed canary Worker, hostname,
secrets, D1 database, and `COMPAT_HOSTNAME` value.

Before attaching `meta.atrinik.org`, install a zone custom rule named
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

Do not attach or move the production custom domain until all of these are true:

1. the production Worker exposes no `workers.dev` or preview hostname;
2. the enabled raw-target rule exactly matches the approved expression;
3. the rate rule is enabled, or the plan exception and fallback risk are
   explicitly approved;
4. aggregate Worker/WAF alerts and scheduled-cleanup failure alerts exist; and
5. rollback detaches the custom domain without re-enabling an alternate public
   Worker hostname.

[rate-params]: https://developers.cloudflare.com/waf/rate-limiting-rules/parameters/
[rate-rules]: https://developers.cloudflare.com/waf/rate-limiting-rules/
[raw-uri]: https://developers.cloudflare.com/ruleset-engine/rules-language/fields/reference/raw.http.request.full_uri/
