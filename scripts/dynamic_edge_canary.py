#!/usr/bin/env python3
"""Probe one public edge through its governed production request envelope."""

from __future__ import annotations

import argparse
import base64
import http.client
import json
from pathlib import Path
from urllib.parse import urlsplit


SERVER_ID = "0" * 64
PUBLISH_DOCUMENT = json.loads(
    (
        Path(__file__).parent.parent
        / "test/fixtures/metaserver-classic-publisher-v2.json"
    )
    .read_text(encoding="utf-8")
)
PUBLISH_FIXTURE = PUBLISH_DOCUMENT["positive"][0]
PUBLISH_PATH = PUBLISH_FIXTURE["path"]
RENDEZVOUS_PATH = f"/v1/classic/servers/{SERVER_ID}?role=server"
MAXIMUM_RESPONSE_BYTES = 1_024


def request_contract(role: str) -> tuple[str, str, bytes | None, dict[str, str]]:
    if role == "publisher":
        return (
            "POST",
            PUBLISH_PATH,
            PUBLISH_FIXTURE["body"].encode(),
            {
                "Atrinik-Publish-Sequence": PUBLISH_FIXTURE["sequence"],
                "Atrinik-Server-ID": PUBLISH_DOCUMENT["server_id"],
                "Content-Digest": PUBLISH_FIXTURE["content_digest"],
                "Content-Type": PUBLISH_DOCUMENT["content_type"],
                "Signature": f"atrinik=:{base64.b64encode(bytes(64)).decode()}:",
                "Signature-Input": PUBLISH_FIXTURE["signature_input"],
            },
        )
    return (
        "GET",
        RENDEZVOUS_PATH,
        None,
        {
            "Connection": "Upgrade",
            "Sec-WebSocket-Key": "AAAAAAAAAAAAAAAAAAAAAA==",
            "Sec-WebSocket-Version": "13",
            "Upgrade": "websocket",
        },
    )


def probe(
    role: str,
    base_url: str,
    expected_circuit: str,
    disabled_retry_seconds: int,
) -> dict[str, object]:
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
    if expected_circuit not in ("enabled", "disabled"):
        raise ValueError("expected circuit must be enabled or disabled")
    if not 1 <= disabled_retry_seconds <= 86_400:
        raise ValueError("disabled retry seconds are invalid")
    method, path, body, headers = request_contract(role)
    headers.update({
        "Accept": "application/json",
        "User-Agent": "atrinik-deployment-canary/1",
    })
    connection = http.client.HTTPSConnection(parsed.hostname, timeout=10)
    try:
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        response_body = response.read(MAXIMUM_RESPONSE_BYTES + 1)
        if len(response_body) > MAXIMUM_RESPONSE_BYTES:
            raise RuntimeError(f"{role} canary response exceeds the bound")
        enabled_proof = {
            "publisher": (401, "unauthorized"),
            "rendezvous": (404, "not_found"),
        }[role]
        expected_status, expected_code = (
            enabled_proof
            if expected_circuit == "enabled"
            else (503, "service_disabled")
        )
        if response.status != expected_status:
            raise RuntimeError(f"{role} canonical envelope returned a closed result")
        if expected_circuit == "enabled" and role == "rendezvous":
            if response_body != b"Server is offline\n":
                raise RuntimeError(f"{role} canonical envelope returned the wrong proof")
        else:
            try:
                payload = json.loads(response_body)
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise RuntimeError(
                    f"{role} canonical envelope returned invalid JSON"
                ) from error
            if payload.get("error", {}).get("code") != expected_code:
                raise RuntimeError(f"{role} canonical envelope returned the wrong proof")
        if response.getheader("Cache-Control") != "no-store":
            raise RuntimeError(f"{role} canonical envelope is cacheable")
        if response.getheader("X-Content-Type-Options") != "nosniff":
            raise RuntimeError(f"{role} canonical envelope lacks response hardening")
        retry_after = response.getheader("Retry-After")
        if expected_circuit == "disabled":
            if retry_after != str(disabled_retry_seconds):
                raise RuntimeError(f"{role} disabled circuit retry policy drifted")
        elif retry_after is not None:
            raise RuntimeError(f"{role} enabled circuit returned a retry policy")
    finally:
        connection.close()
    return {
        "method": method,
        "outcome": "pass",
        "path": path,
        "role": role,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--role", choices=("publisher", "rendezvous"), required=True)
    parser.add_argument("--base-url", required=True)
    parser.add_argument(
        "--expected-circuit", choices=("enabled", "disabled"), required=True
    )
    parser.add_argument("--disabled-retry-seconds", type=int, required=True)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    result = probe(
        args.role,
        args.base_url.rstrip("/"),
        args.expected_circuit,
        args.disabled_retry_seconds,
    )
    if args.json:
        print(json.dumps(result, sort_keys=True))
    else:
        print(f"{args.role} canonical envelope passed")


if __name__ == "__main__":
    main()
