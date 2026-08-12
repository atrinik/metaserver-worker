#!/usr/bin/env python3
"""Verify canonical HTTPS-only ingress without mutating Cloudflare.

The verifier sends a fixed, credential-free request set to one static directory
hostname and the canonical publisher and rendezvous hostnames. It accepts no
Cloudflare token and has no account API or mutation path. Production hostnames
require an explicit acknowledgement so isolated canaries remain the default.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import NoReturn

from static_origin_canary import canonical_hostname


PRODUCTION_HOSTS = frozenset(
    {
        "classic.meta.atrinik.org",
        "meta.atrinik.org",
        "publish.meta.atrinik.org",
        "rendezvous.meta.atrinik.org",
    }
)
STATIC_PATHS = ("/", "/index.html", "/index.json", "/index.xml")
STATIC_NEGATIVE_REQUESTS = (
    ("GET", "/manifest.json"),
    ("GET", "/index.json?unexpected=1"),
    ("GET", "/%69ndex.json"),
    ("GET", "/index.json/"),
    ("POST", "/index.json"),
    ("OPTIONS", "/index.json"),
)
SERVER_ID = "0" * 64
MAXIMUM_RESPONSE_BYTES = 64 * 1024
WORKER_NAMES = {
    "core": "atrinik-metaserver",
    "publisher": "atrinik-metaserver-publisher",
    "rendezvous": "atrinik-metaserver-rendezvous",
}


class CanaryError(RuntimeError):
    """A public hostname violated the reviewed ingress contract."""


@dataclass(frozen=True)
class HttpResponse:
    status: int
    headers: Mapping[str, tuple[str, ...]]
    body: bytes


@dataclass(frozen=True)
class Request:
    method: str
    url: str
    headers: Mapping[str, str]
    body: bytes | None = None


@dataclass(frozen=True)
class CanaryResult:
    static_host: str
    publisher_host: str
    rendezvous_host: str
    redirect_checks: int
    block_checks: int
    hsts_checks: int
    alternate_checks: int


Fetch = Callable[[Request, int], HttpResponse]


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        return None


def fail(message: str) -> NoReturn:
    raise CanaryError(message)


def validate_hosts(hosts: Sequence[str], allow_production: bool) -> None:
    if len(hosts) != 3 or len(set(hosts)) != 3:
        raise ValueError("static, publisher, and rendezvous hosts must be distinct")
    for host in hosts:
        if not canonical_hostname(host):
            raise ValueError("hosts must be canonical DNS names")
        if host in PRODUCTION_HOSTS and not allow_production:
            raise ValueError(
                "production hosts require --allow-production; use isolated "
                "canary hostnames by default"
            )


def canonical_workers_url(value: str) -> tuple[str, str]:
    try:
        parsed = urllib.parse.urlsplit(value)
        port = parsed.port
    except ValueError as error:
        raise ValueError(
            "alternate URLs must be canonical HTTPS workers.dev origins"
        ) from error
    if (
        parsed.scheme != "https"
        or parsed.username is not None
        or parsed.password is not None
        or port is not None
        or parsed.query
        or parsed.fragment
        or parsed.path not in ("", "/")
        or parsed.hostname is None
        or parsed.netloc != parsed.hostname
        or not canonical_hostname(parsed.hostname)
        or not parsed.hostname.endswith(".workers.dev")
    ):
        raise ValueError(
            "alternate URLs must be canonical HTTPS workers.dev origins"
        )
    return f"https://{parsed.hostname}/", parsed.hostname


def validate_alternate_urls(
    core_base: str,
    publisher_base: str,
    publisher_version: str,
    rendezvous_base: str,
    rendezvous_version: str,
) -> tuple[str, ...]:
    supplied = (
        ("core base", core_base, WORKER_NAMES["core"], False),
        ("publisher base", publisher_base, WORKER_NAMES["publisher"], False),
        (
            "publisher version",
            publisher_version,
            WORKER_NAMES["publisher"],
            True,
        ),
        ("rendezvous base", rendezvous_base, WORKER_NAMES["rendezvous"], False),
        (
            "rendezvous version",
            rendezvous_version,
            WORKER_NAMES["rendezvous"],
            True,
        ),
    )
    parsed = tuple(
        (label, *canonical_workers_url(value), worker_name, version)
        for label, value, worker_name, version in supplied
    )
    core_parts = parsed[0][2].split(".")
    if len(core_parts) != 4 or core_parts[0] != WORKER_NAMES["core"]:
        raise ValueError("core base URL does not match the reviewed Worker name")
    account_suffix = ".".join(core_parts[1:])
    normalized: list[str] = []
    for label, url, hostname, worker_name, version in parsed:
        expected_base = f"{worker_name}.{account_suffix}"
        if version:
            version_suffix = f"-{worker_name}.{account_suffix}"
            prefix = hostname.removesuffix(version_suffix)
            valid = hostname.endswith(version_suffix) and bool(prefix)
        else:
            valid = hostname == expected_base
        if not valid:
            raise ValueError(
                f"{label} URL does not match its reviewed Worker/account name"
            )
        normalized.append(url)
    if len(set(normalized)) != len(normalized):
        raise ValueError("alternate Worker URLs must be distinct")
    return tuple(normalized)


def _headers(message) -> Mapping[str, tuple[str, ...]]:  # noqa: ANN001
    values: dict[str, list[str]] = defaultdict(list)
    for name, value in message.items():
        values[name.lower()].append(value)
    return {name: tuple(items) for name, items in values.items()}


def network_fetch(timeout: float) -> Fetch:
    opener = urllib.request.build_opener(_NoRedirect())

    def fetch(request: Request, maximum_bytes: int) -> HttpResponse:
        outgoing = urllib.request.Request(
            request.url,
            method=request.method,
            data=request.body,
            headers={
                "Accept-Encoding": "identity",
                "User-Agent": "atrinik-edge-ingress-canary/1",
                **request.headers,
            },
        )
        response = None
        try:
            response = opener.open(outgoing, timeout=timeout)
        except urllib.error.HTTPError as error:
            response = error
        except (OSError, urllib.error.URLError) as error:
            fail(f"{request.method} request failed: {error}")
        try:
            body = response.read(maximum_bytes + 1)
            if len(body) > maximum_bytes:
                fail(f"{request.method} response exceeded {maximum_bytes} bytes")
            return HttpResponse(
                status=int(response.status),
                headers=_headers(response.headers),
                body=body,
            )
        finally:
            response.close()

    return fetch


def one_header(response: HttpResponse, name: str) -> str:
    values = response.headers.get(name.lower(), ())
    if len(values) != 1:
        fail(f"response requires exactly one {name} header")
    return values[0]


def no_header(response: HttpResponse, name: str) -> None:
    if response.headers.get(name.lower(), ()):
        fail(f"response must not include {name}")


def blocked(response: HttpResponse, label: str) -> None:
    if response.status != 403:
        fail(f"{label} returned {response.status}, expected WAF 403")
    no_header(response, "Location")
    no_header(response, "Strict-Transport-Security")
    no_header(response, "CF-Worker-Status")


def verify_static_plaintext(fetch: Fetch, host: str) -> tuple[int, int]:
    redirects = 0
    blocks = 0
    for method in ("GET", "HEAD"):
        for path in STATIC_PATHS:
            response = fetch(
                Request(method, f"http://{host}{path}", {}),
                MAXIMUM_RESPONSE_BYTES if method == "GET" else 0,
            )
            if response.status != 308:
                fail(f"plaintext {method} {path} did not return 308")
            expected = f"https://{host}{path}"
            if one_header(response, "Location") != expected:
                fail(f"plaintext {method} {path} changed host, path, or query")
            if method == "HEAD" and response.body:
                fail(f"plaintext HEAD {path} returned a body")
            no_header(response, "Strict-Transport-Security")
            no_header(response, "CF-Worker-Status")
            redirects += 1
    for method, path in STATIC_NEGATIVE_REQUESTS:
        response = fetch(
            Request(method, f"http://{host}{path}", {}),
            MAXIMUM_RESPONSE_BYTES if method != "HEAD" else 0,
        )
        blocked(response, f"plaintext static {method} {path}")
        blocks += 1
    return redirects, blocks


def dynamic_requests(
    publisher_host: str,
    rendezvous_host: str,
) -> tuple[Request, Request]:
    publisher = Request(
        "POST",
        f"http://{publisher_host}/v1/classic/servers/{SERVER_ID}/publish",
        {"Content-Type": "application/json"},
        b"{}",
    )
    rendezvous = Request(
        "GET",
        f"http://{rendezvous_host}/v1/classic/servers/{SERVER_ID}?role=client",
        {
            "Connection": "Upgrade",
            "Upgrade": "websocket",
            "Sec-WebSocket-Version": "13",
            "Sec-WebSocket-Key": "AAAAAAAAAAAAAAAAAAAAAA==",
        },
    )
    return publisher, rendezvous


def verify_dynamic_plaintext(
    fetch: Fetch,
    publisher_host: str,
    rendezvous_host: str,
) -> int:
    for label, request in zip(
        ("publisher", "rendezvous"),
        dynamic_requests(publisher_host, rendezvous_host),
        strict=True,
    ):
        blocked(fetch(request, MAXIMUM_RESPONSE_BYTES), f"plaintext {label}")
    return 2


def https_request(request: Request) -> Request:
    parsed = urllib.parse.urlsplit(request.url)
    return Request(
        request.method,
        urllib.parse.urlunsplit(
            ("https", parsed.netloc, parsed.path, parsed.query, "")
        ),
        request.headers,
        request.body,
    )


def verify_hsts(
    fetch: Fetch,
    static_host: str,
    publisher_host: str,
    rendezvous_host: str,
    max_age: int,
) -> int:
    requests = (
        Request("GET", f"https://{static_host}/index.json", {}),
        *(
            https_request(item)
            for item in dynamic_requests(publisher_host, rendezvous_host)
        ),
    )
    expected = f"max-age={max_age}"
    for request in requests:
        response = fetch(request, MAXIMUM_RESPONSE_BYTES)
        if response.status in (301, 302, 307, 308):
            fail("canonical HTTPS request redirected")
        no_header(response, "Location")
        if one_header(response, "Strict-Transport-Security") != expected:
            fail("HTTPS response has an invalid staged HSTS policy")
        no_header(response, "CF-Worker-Status")
    return len(requests)


def verify_alternate_urls(fetch: Fetch, alternate_urls: Sequence[str]) -> int:
    for url in alternate_urls:
        response = fetch(Request("GET", url, {}), MAXIMUM_RESPONSE_BYTES)
        if response.status != 404:
            fail("alternate Worker URL remains reachable")
        no_header(response, "Location")
        no_header(response, "CF-Worker-Status")
    return len(alternate_urls)


def verify_ingress(
    fetch: Fetch,
    static_host: str,
    publisher_host: str,
    rendezvous_host: str,
    hsts_max_age: int,
    alternate_urls: Sequence[str],
) -> CanaryResult:
    redirect_checks, static_blocks = verify_static_plaintext(fetch, static_host)
    dynamic_blocks = verify_dynamic_plaintext(fetch, publisher_host, rendezvous_host)
    hsts_checks = verify_hsts(
        fetch,
        static_host,
        publisher_host,
        rendezvous_host,
        hsts_max_age,
    )
    alternate_checks = verify_alternate_urls(fetch, alternate_urls)
    return CanaryResult(
        static_host=static_host,
        publisher_host=publisher_host,
        rendezvous_host=rendezvous_host,
        redirect_checks=redirect_checks,
        block_checks=static_blocks + dynamic_blocks,
        hsts_checks=hsts_checks,
        alternate_checks=alternate_checks,
    )


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    root.add_argument("--static-host", required=True)
    root.add_argument("--publisher-host", required=True)
    root.add_argument("--rendezvous-host", required=True)
    root.add_argument("--hsts-max-age", type=int, default=300)
    root.add_argument("--core-base-url", required=True)
    root.add_argument("--publisher-base-url", required=True)
    root.add_argument("--publisher-version-url", required=True)
    root.add_argument("--rendezvous-base-url", required=True)
    root.add_argument("--rendezvous-version-url", required=True)
    root.add_argument("--timeout", type=float, default=10.0)
    root.add_argument("--allow-production", action="store_true")
    root.add_argument("--json", action="store_true", dest="json_output")
    return root


def main(argv: Sequence[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        hosts = (args.static_host, args.publisher_host, args.rendezvous_host)
        validate_hosts(hosts, args.allow_production)
        alternate_urls = validate_alternate_urls(
            args.core_base_url,
            args.publisher_base_url,
            args.publisher_version_url,
            args.rendezvous_base_url,
            args.rendezvous_version_url,
        )
        if not 1 <= args.hsts_max_age <= 31_536_000:
            raise ValueError("HSTS max age must be between 1 and 31536000 seconds")
        if not 0.25 <= args.timeout <= 30:
            raise ValueError("timeout must be between 0.25 and 30 seconds")
        result = verify_ingress(
            network_fetch(args.timeout),
            *hosts,
            args.hsts_max_age,
            alternate_urls,
        )
    except (CanaryError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2

    payload = {
        "result": "accepted",
        "static_host": result.static_host,
        "publisher_host": result.publisher_host,
        "rendezvous_host": result.rendezvous_host,
        "redirect_checks": result.redirect_checks,
        "block_checks": result.block_checks,
        "hsts_checks": result.hsts_checks,
        "alternate_checks": result.alternate_checks,
        "hsts_max_age": args.hsts_max_age,
    }
    if args.json_output:
        print(json.dumps(payload, sort_keys=True, separators=(",", ":")))
    else:
        print(
            "canonical ingress valid: "
            f"{result.redirect_checks} redirects, {result.block_checks} blocks, "
            f"{result.hsts_checks} HSTS responses, "
            f"{result.alternate_checks} unavailable alternate URLs"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
