#!/usr/bin/env python3
"""Probe one public edge through its named core Service Binding."""

from __future__ import annotations

import argparse
import http.client
import json
from urllib.parse import urlsplit


HEALTH_PATH = "/.well-known/atrinik-deployment-health"


def probe(role: str, base_url: str) -> dict[str, object]:
    parsed = urlsplit(base_url)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.port is not None
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("canary base URL must be one canonical HTTPS authority")
    connection = http.client.HTTPSConnection(parsed.hostname, timeout=10)
    try:
        connection.request(
            "GET",
            HEALTH_PATH,
            headers={"Accept": "application/octet-stream", "User-Agent": "atrinik-deployment-canary/1"},
        )
        response = connection.getresponse()
        body = response.read(1)
        if response.status != 204 or body:
            raise RuntimeError(f"{role} deployment health returned a closed result")
        if response.getheader("Cache-Control") != "no-store":
            raise RuntimeError(f"{role} deployment health is cacheable")
        if response.getheader("X-Content-Type-Options") != "nosniff":
            raise RuntimeError(f"{role} deployment health lacks response hardening")
    finally:
        connection.close()
    return {"outcome": "pass", "role": role, "url": base_url + HEALTH_PATH}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--role", choices=("publisher", "rendezvous"), required=True)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    result = probe(args.role, args.base_url.rstrip("/"))
    if args.json:
        print(json.dumps(result, sort_keys=True))
    else:
        print(f"{args.role} deployment health passed")


if __name__ == "__main__":
    main()
