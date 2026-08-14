from __future__ import annotations

import unittest
from unittest import mock

import dynamic_edge_canary


class FakeResponse:
    status = 401
    body = b'{"error":{"code":"unauthorized"}}'

    def read(self, maximum: int) -> bytes:
        self.maximum = maximum
        return self.body[:maximum]

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

    def request(
        self,
        method: str,
        path: str,
        body: bytes | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        self.request_value = (method, path, body, headers or {})

    def getresponse(self) -> FakeResponse:
        return self.response

    def close(self) -> None:
        self.closed = True


class DynamicEdgeCanaryTest(unittest.TestCase):
    @mock.patch.object(dynamic_edge_canary.http.client, "HTTPSConnection", FakeConnection)
    def test_accepts_enabled_publisher_service_binding_rejection(self) -> None:
        FakeConnection.response = FakeResponse()
        result = dynamic_edge_canary.probe(
            "publisher", "https://publish.meta.atrinik.org", "enabled", 300
        )
        self.assertEqual(result["outcome"], "pass")
        self.assertEqual(
            result["path"],
            dynamic_edge_canary.PUBLISH_PATH,
        )
        self.assertTrue(result["path"].startswith("/v2/classic/servers/"))
        self.assertEqual(FakeConnection.response.maximum, 1_025)

    @mock.patch.object(dynamic_edge_canary.http.client, "HTTPSConnection", FakeConnection)
    def test_accepts_disabled_rendezvous_circuit_proof(self) -> None:
        response = FakeResponse()
        response.status = 503
        response.body = b'{"error":{"code":"service_disabled"}}'
        response.getheader = lambda name: {
            "Cache-Control": "no-store",
            "Retry-After": "300",
            "X-Content-Type-Options": "nosniff",
        }.get(name)
        FakeConnection.response = response
        result = dynamic_edge_canary.probe(
            "rendezvous", "https://rendezvous.meta.atrinik.org", "disabled", 300
        )
        self.assertEqual(result["method"], "GET")
        self.assertEqual(
            result["path"], f"/v1/classic/servers/{'0' * 64}?role=server"
        )

    @mock.patch.object(dynamic_edge_canary.http.client, "HTTPSConnection", FakeConnection)
    def test_accepts_enabled_rendezvous_service_binding_rejection(self) -> None:
        response = FakeResponse()
        response.status = 404
        response.body = b"Server is offline\n"
        FakeConnection.response = response
        result = dynamic_edge_canary.probe(
            "rendezvous", "https://rendezvous.meta.atrinik.org", "enabled", 300
        )
        self.assertEqual(result["outcome"], "pass")
        self.assertEqual(result["method"], "GET")

    def test_rejects_noncanonical_urls(self) -> None:
        for value in (
            "http://publish.meta.atrinik.org",
            "https://publish.meta.atrinik.org:8443",
            "https://publish.meta.atrinik.org/path",
            "https://publish.meta.atrinik.org?private=true",
        ):
            with self.assertRaises(ValueError):
                dynamic_edge_canary.probe("publisher", value, "enabled", 300)

    def test_canary_requests_are_inside_governed_waf_envelopes(self) -> None:
        publisher = dynamic_edge_canary.request_contract("publisher")
        rendezvous = dynamic_edge_canary.request_contract("rendezvous")
        self.assertEqual(publisher[:2], (
            "POST", dynamic_edge_canary.PUBLISH_PATH
        ))
        self.assertEqual(rendezvous[:2], (
            "GET", f"/v1/classic/servers/{'0' * 64}?role=server"
        ))
        self.assertEqual(len(publisher[1]), 92)
        self.assertTrue(publisher[1].startswith("/v2/classic/servers/"))
        self.assertEqual(len(rendezvous[1].split("?", maxsplit=1)[0]), 84)


if __name__ == "__main__":
    unittest.main()
