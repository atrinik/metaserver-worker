import contextlib
import io
import json
import unittest
import urllib.parse
from unittest import mock

import edge_ingress_canary as canary


ALTERNATE_URLS = (
    "https://atrinik-metaserver.account.workers.dev/",
    "https://atrinik-metaserver-publisher.account.workers.dev/",
    "https://version-atrinik-metaserver-publisher.account.workers.dev/",
    "https://atrinik-metaserver-rendezvous.account.workers.dev/",
    "https://version-atrinik-metaserver-rendezvous.account.workers.dev/",
)


class FakeEdge:
    def __init__(self) -> None:
        self.redirect_status = 308
        self.redirect_host = "static.example.org"
        self.block_status = 403
        self.hsts = "max-age=300"
        self.internal_header = False
        self.calls: list[canary.Request] = []

    def __call__(
        self,
        request: canary.Request,
        maximum_bytes: int,
    ) -> canary.HttpResponse:
        self.calls.append(request)
        parsed = urllib.parse.urlsplit(request.url)
        headers: dict[str, tuple[str, ...]] = {}
        body = b""
        if parsed.hostname is not None and parsed.hostname.endswith(".workers.dev"):
            status = 404
        elif parsed.scheme == "http":
            if (
                parsed.hostname == "static.example.org"
                and request.method in ("GET", "HEAD")
                and not parsed.query
                and parsed.path in canary.STATIC_PATHS
            ):
                headers["location"] = (
                    f"https://{self.redirect_host}{parsed.path}",
                )
                status = self.redirect_status
            else:
                status = self.block_status
                body = b"blocked" if maximum_bytes else b""
        else:
            status = 200 if parsed.hostname == "static.example.org" else 400
            headers["strict-transport-security"] = (self.hsts,)
        if self.internal_header:
            headers["cf-worker-status"] = ("ok",)
        return canary.HttpResponse(status, headers, body)


class EdgeIngressCanaryTests(unittest.TestCase):
    def verify(self, fake: FakeEdge | None = None) -> canary.CanaryResult:
        return canary.verify_ingress(
            fake or FakeEdge(),
            "static.example.org",
            "publisher.example.org",
            "rendezvous.example.org",
            300,
            ALTERNATE_URLS,
        )

    def test_accepts_exact_redirect_block_and_hsts_cohort(self) -> None:
        fake = FakeEdge()
        result = self.verify(fake)
        self.assertEqual(result.redirect_checks, 8)
        self.assertEqual(result.block_checks, 8)
        self.assertEqual(result.hsts_checks, 3)
        self.assertEqual(result.alternate_checks, 5)
        self.assertEqual(len(fake.calls), 24)
        self.assertTrue(any(call.body == b"{}" for call in fake.calls))
        self.assertTrue(any(
            call.headers.get("Upgrade") == "websocket" for call in fake.calls
        ))

    def test_rejects_cross_host_or_non_308_static_redirect(self) -> None:
        fake = FakeEdge()
        fake.redirect_host = "other.example.org"
        with self.assertRaisesRegex(canary.CanaryError, "changed host"):
            self.verify(fake)

        fake = FakeEdge()
        fake.redirect_status = 301
        with self.assertRaisesRegex(canary.CanaryError, "did not return 308"):
            self.verify(fake)

    def test_rejects_redirected_or_unblocked_negative_plaintext(self) -> None:
        fake = FakeEdge()
        fake.block_status = 200
        with self.assertRaisesRegex(canary.CanaryError, "expected WAF 403"):
            self.verify(fake)

        fake = FakeEdge()
        fake.block_status = 404
        with self.assertRaisesRegex(canary.CanaryError, "expected WAF 403"):
            self.verify(fake)

        original = FakeEdge()

        def redirected(
            request: canary.Request,
            maximum_bytes: int,
        ) -> canary.HttpResponse:
            response = original(request, maximum_bytes)
            if request.url.startswith("http://publisher"):
                return canary.HttpResponse(
                    403,
                    {"location": (request.url.replace("http://", "https://"),)},
                    b"",
                )
            return response

        with self.assertRaisesRegex(canary.CanaryError, "must not include Location"):
            self.verify(redirected)

    def test_rejects_missing_overbroad_or_duplicate_hsts(self) -> None:
        for value in (
            "",
            "max-age=301",
            "max-age=300; includeSubDomains",
            "max-age=300; preload",
        ):
            with self.subTest(value=value):
                fake = FakeEdge()
                fake.hsts = value
                with self.assertRaisesRegex(canary.CanaryError, "invalid staged HSTS"):
                    self.verify(fake)

        original = FakeEdge()

        def duplicate(
            request: canary.Request,
            maximum_bytes: int,
        ) -> canary.HttpResponse:
            response = original(request, maximum_bytes)
            if request.url.startswith("https://"):
                headers = dict(response.headers)
                headers["strict-transport-security"] = ("max-age=300", "max-age=300")
                return canary.HttpResponse(response.status, headers, response.body)
            return response

        with self.assertRaisesRegex(canary.CanaryError, "exactly one"):
            self.verify(duplicate)

    def test_network_transport_reads_only_one_byte_past_the_bound(self) -> None:
        class Response:
            status = 200
            headers: dict[str, str] = {}

            def __init__(self) -> None:
                self.closed = False
                self.read_size = -1

            def read(self, size: int) -> bytes:
                self.read_size = size
                return b"1234"

            def close(self) -> None:
                self.closed = True

        response = Response()
        opener = mock.Mock()
        opener.open.return_value = response
        with mock.patch.object(
            canary.urllib.request,
            "build_opener",
            return_value=opener,
        ):
            fetch = canary.network_fetch(1)
        with self.assertRaisesRegex(canary.CanaryError, "exceeded 3 bytes"):
            fetch(canary.Request("GET", "https://static.example.org/", {}), 3)
        self.assertEqual(response.read_size, 4)
        self.assertTrue(response.closed)

    def test_rejects_internal_metadata_on_every_public_response_class(self) -> None:
        fake = FakeEdge()
        fake.internal_header = True
        with self.assertRaisesRegex(canary.CanaryError, "CF-Worker-Status"):
            self.verify(fake)

    def test_hosts_are_canonical_distinct_and_production_is_explicit(self) -> None:
        canary.validate_hosts(
            ("static.example.org", "publisher.example.org", "rendezvous.example.org"),
            False,
        )
        for hosts in (
            ("STATIC.example.org", "publisher.example.org", "rendezvous.example.org"),
            ("127.0.0.1", "publisher.example.org", "rendezvous.example.org"),
            ("0x7f.0.0.1", "publisher.example.org", "rendezvous.example.org"),
            ("static.example.org", "static.example.org", "rendezvous.example.org"),
        ):
            with self.subTest(hosts=hosts), self.assertRaises(ValueError):
                canary.validate_hosts(hosts, False)
        with self.assertRaisesRegex(ValueError, "--allow-production"):
            canary.validate_hosts(
                (
                    "classic.meta.atrinik.org",
                    "publish.meta.atrinik.org",
                    "rendezvous.meta.atrinik.org",
                ),
                False,
            )

    def test_alternate_urls_are_exact_canonical_workers_dev_origins(self) -> None:
        self.assertEqual(
            canary.validate_alternate_urls(*ALTERNATE_URLS),
            ALTERNATE_URLS,
        )
        invalid_replacements = (
            (0, "https://unrelated.account.workers.dev/"),
            (1, "https://atrinik-metaserver-publisher.other.workers.dev/"),
            (2, "https://atrinik-metaserver-publisher.account.workers.dev/"),
            (3, "https://unrelated.account.workers.dev/"),
            (4, "https://version-unrelated.account.workers.dev/"),
            (4, "http://version-atrinik-metaserver-rendezvous.account.workers.dev/"),
            (4, "https://user@version-atrinik-metaserver-rendezvous.account.workers.dev/"),
            (4, "https://version-atrinik-metaserver-rendezvous.account.workers.dev/path"),
            (4, "https://version-atrinik-metaserver-rendezvous.account.workers.dev/?query=1"),
            (4, "https://version-atrinik-metaserver-rendezvous.account.workers.dev:443/"),
        )
        for index, replacement in invalid_replacements:
            cohort = list(ALTERNATE_URLS)
            cohort[index] = replacement
            with self.subTest(cohort=cohort), self.assertRaises(ValueError):
                canary.validate_alternate_urls(*cohort)

    def test_rejects_reachable_or_redirecting_alternate_worker_url(self) -> None:
        original = FakeEdge()

        def reachable(
            request: canary.Request,
            maximum_bytes: int,
        ) -> canary.HttpResponse:
            response = original(request, maximum_bytes)
            if request.url == ALTERNATE_URLS[0]:
                return canary.HttpResponse(200, {}, b"")
            return response

        with self.assertRaisesRegex(canary.CanaryError, "remains reachable"):
            self.verify(reachable)

        def redirected(
            request: canary.Request,
            maximum_bytes: int,
        ) -> canary.HttpResponse:
            response = original(request, maximum_bytes)
            if request.url == ALTERNATE_URLS[0]:
                return canary.HttpResponse(404, {"location": ("https://x/",)}, b"")
            return response

        with self.assertRaisesRegex(canary.CanaryError, "must not include Location"):
            self.verify(redirected)

    def test_cli_emits_only_bounded_machine_readable_outcomes(self) -> None:
        stdout = io.StringIO()
        with mock.patch.object(canary, "network_fetch", return_value=FakeEdge()):
            with contextlib.redirect_stdout(stdout):
                result = canary.main(
                    [
                        "--static-host", "static.example.org",
                        "--publisher-host", "publisher.example.org",
                        "--rendezvous-host", "rendezvous.example.org",
                        "--core-base-url", ALTERNATE_URLS[0],
                        "--publisher-base-url", ALTERNATE_URLS[1],
                        "--publisher-version-url", ALTERNATE_URLS[2],
                        "--rendezvous-base-url", ALTERNATE_URLS[3],
                        "--rendezvous-version-url", ALTERNATE_URLS[4],
                        "--json",
                    ]
                )
        self.assertEqual(result, 0)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["result"], "accepted")
        self.assertEqual(payload["redirect_checks"], 8)
        self.assertEqual(payload["block_checks"], 8)
        self.assertEqual(payload["hsts_checks"], 3)
        self.assertEqual(payload["alternate_checks"], 5)
        for forbidden in ("body", "header", "url", "token", "server_id"):
            self.assertNotIn(forbidden, payload)


if __name__ == "__main__":
    unittest.main()
