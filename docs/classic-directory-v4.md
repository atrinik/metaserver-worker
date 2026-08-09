# Classic directory protocol 4

Classic directory protocol 4 is the addressless-capable static projection for
the classic client. It replaces the compatibility protocol-3 response only
after the coordinated client release and static-host canary. Until then it is a
versioned producer contract, not a live compatibility-route change.

## Common generation

`index.json`, `index.xml`, and `index.html` are rendered from one canonical
snapshot. The public D1 revision is private builder coordination and MUST NOT
appear in an artifact. Every artifact carries the same positive decimal
`generation`, non-negative Unix `generatedAt`, and strictly later `expiresAt`.
The lifetime MUST NOT exceed 14,400 seconds. Consumers MUST reject an expired
artifact and MUST NOT replace a newer accepted generation with an older one.
The producer rounds expiry down to a conservative 15-minute boundary shared by
membership expiry; the artifact never exposes an exact publisher heartbeat
timestamp or outlives its backing presence.

The canonical server ordering is ascending raw 32-byte server identity,
represented as 64 lowercase hexadecimal characters. Duplicate identities are
invalid. At most 512 servers are permitted.

## Server fields

Each server contains exactly:

- `serverId`: 64 lowercase hexadecimal characters.
- `name`: 1–80 UTF-8 bytes.
- `playersCount`: an unsigned 32-bit integer.
- `version`: 1–32 UTF-8 bytes.
- `textComment`: 0–256 UTF-8 bytes.
- `certificateSha256`: identical to `serverId`.
- `passwordRequired`: a Boolean.
- optional `endpoint`: a canonical lowercase DNS hostname and UDP port
  1–65535. Hostnames follow the signed publisher hostname contract and never
  contain an IP literal. The hostname and port are present or absent together.

Text rejects C0 controls, DEL, unpaired UTF-16 surrogates, U+FFFE, and U+FFFF.
Renderers escape JSON, XML, and HTML metacharacters without changing the
semantic value. Directory artifacts contain no source address, transient QUIC
candidate, rendezvous ticket, publisher credential, player identity, private
server, or internal database revision.

## JSON

`index.json` is UTF-8 `application/json` with one trailing LF and exact
top-level key order:

`schema`, `protocol`, `generation`, `generatedAt`, `expiresAt`, `servers`.

`schema` is `atrinik-classic-directory-v4` and `protocol` is numeric `4`.
Each server uses the field order listed above, with `endpoint` last when
present. The complete body is limited to 4 MiB.

For each format, the canonical application strong validator is
`"atrinik-classic-directory-v4-FORMAT-sha256-DIGEST"`, where `FORMAT` is
`html`, `json`, or `xml`, and `DIGEST` is the 64-character lowercase SHA-256
of the complete UTF-8 body, including its trailing LF. A conditional response
may stand in for a previously accepted body only while that body's embedded
`expiresAt` remains in the future; it must never extend the body lifetime or
permit generation rollback. The generated timestamp is the semantic
`Last-Modified` time. Mapping these application values to the actual static
origin HTTP validators and modification time remains a deployment gate because
direct R2 supplies its own object ETag and upload time.

## XML

`index.xml` is UTF-8 `application/xml`, has no DTD, entity declaration,
processing instruction beyond the XML declaration, namespace, or comments,
and is limited to 4 MiB. The exact root is:

```xml
<Servers protocol="4" schema="atrinik-classic-directory-v4"
         generation="G" generated-at="T" expires-at="E">
```

Each `<Server>` contains `Id`, `Name`, `PlayersCount`, `Version`,
`TextComment`, optional paired `Address` and `Port`, `CertificateSha256`, and
`PasswordRequired` in that order. An absent endpoint omits both address
elements; no numeric address is synthesized.

## HTML and transport

`index.html` is a human-readable semantic projection with no scripts, forms,
external resources, or hidden private fields. The static origin must enforce
the reviewed CSP, `X-Content-Type-Options: nosniff`, CORS, method/path/query,
cache, and `r2.dev` policies before cutover. Direct R2 response-header and cache
behavior remains a deployment gate owned by the service-split/canary work.
Only `/`, `/index.html`, `/index.xml`, and `/index.json` are public; the
builder's `/manifest.json` coordination alias must be denied at the edge.

The exact committed positive vectors are
[`test/fixtures/classic-directory-v4/index.json`](../test/fixtures/classic-directory-v4/index.json)
and
[`test/fixtures/classic-directory-v4/index.xml`](../test/fixtures/classic-directory-v4/index.xml).
