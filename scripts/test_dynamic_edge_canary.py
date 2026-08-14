from __future__ import annotations

import unittest
from unittest import mock

import dynamic_edge_canary


class FakeResponse:
    status = 204

    def read(self, maximum: int) -> bytes:
        self.maximum = maximum
        return b""

    def getheader(self, name: str) -> str | None:
        return {
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        }.get(name)


class FakeConnection:
    response = FakeResponse()

    def __init__(self, host: str, timeout: int) -> None:
        self.host = host
        self.timeout = timeout

    def request(self, method: str, path: str, headers: dict[str, str]) -> None:
        self.request_value = (method, path, headers)

    def getresponse(self) -> FakeResponse:
        return self.response

    def close(self) -> None:
        self.closed = True


class DynamicEdgeCanaryTest(unittest.TestCase):
    @mock.patch.object(dynamic_edge_canary.http.client, "HTTPSConnection", FakeConnection)
    def test_accepts_one_bounded_hardened_health_response(self) -> None:
        result = dynamic_edge_canary.probe("publisher", "https://publish.meta.atrinik.org")
        self.assertEqual(result["outcome"], "pass")
        self.assertEqual(FakeConnection.response.maximum, 1)

    def test_rejects_noncanonical_urls(self) -> None:
        for value in (
            "http://publish.meta.atrinik.org",
            "https://publish.meta.atrinik.org:8443",
            "https://publish.meta.atrinik.org/path",
            "https://publish.meta.atrinik.org?private=true",
        ):
            with self.assertRaises(ValueError):
                dynamic_edge_canary.probe("publisher", value)


if __name__ == "__main__":
    unittest.main()
