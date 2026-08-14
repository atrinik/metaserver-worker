import contextlib
import io
import json
import re
import unittest
import urllib.parse
from collections.abc import Mapping
from email.utils import formatdate
from pathlib import Path
from unittest import mock

import static_origin_canary as canary


FIXTURES = Path(__file__).parents[1] / "test" / "fixtures"
NOW = 1_786_219_300


def fixture(path: str) -> bytes:
    return (FIXTURES / path).read_bytes()


def metadata(
    body: bytes,
    profile: str,
    path: str,
) -> tuple[int, int, int, tuple[str, ...], tuple[str, ...]]:
    return canary.parse_artifact(path, body, profile)


def html_fixture(profile: str, source: bytes) -> bytes:
    value = json.loads(source)
    _, semantic = canary.canonical_servers(value["servers"], profile)
    return canary.canonical_html(
        profile,
        int(value["generation"]),
        int(value["generatedAt"]),
        int(value["expiresAt"]),
        semantic,
    ).encode()


class Clock:
    def __init__(self, value: float = NOW) -> None:
        self.value = value

    def now(self) -> float:
        return self.value

    def sleep(self, seconds: float) -> None:
        self.value += max(seconds, 0.001)


class FakeOrigin:
    def __init__(self, profile: str) -> None:
        if profile == "classic-v1":
            json_name = "classic-directory-v4/index.json"
            xml_name = "classic-directory-v4/index.xml"
            html_name = None
        elif profile == "classic-v2":
            json_name = "classic-directory-v5/index.json"
            xml_name = "classic-directory-v5/index.xml"
            html_name = "classic-directory-v5/index.html"
        else:
            json_name = "game-directory-v1/canonical.json"
            xml_name = "game-directory-v1/projection.xml"
            html_name = None
        json_body = fixture(json_name)
        self.profile = profile
        self.bodies: dict[str, list[bytes]] = {
            "/index.html": [
                fixture(html_name)
                if html_name is not None
                else html_fixture(profile, json_body)
            ],
            "/index.json": [json_body],
            "/index.xml": [fixture(xml_name)],
        }
        self.header_overrides: dict[tuple[str, str], str | None] = {}
        self.negative_status = 403
        self.root_status = 404
        self.root_head_status = 404
        self.root_headers: dict[str, tuple[str, ...]] = {}
        self.root_body = b"not found"
        self.calls: list[tuple[str, str, dict[str, str], int]] = []

    def selected_body(self, path: str) -> bytes:
        bodies = self.bodies[path]
        return bodies.pop(0) if len(bodies) > 1 else bodies[0]

    def headers(self, path: str, body: bytes) -> dict[str, tuple[str, ...]]:
        _, generated_at, expires_at, _, _ = metadata(body, self.profile, path)
        values = {
            "content-length": str(len(body)),
            "content-type": canary.CONTENT_TYPES[path],
            "etag": f'"{path[7:-1]}-opaque"',
            "last-modified": formatdate(generated_at + 1, usegmt=True),
            "expires": formatdate(expires_at, usegmt=True),
            "cache-control": ", ".join(sorted(canary.REQUIRED_CACHE_DIRECTIVES)),
            "content-security-policy": canary.REQUIRED_CSP,
            "x-content-type-options": "nosniff",
            "access-control-allow-origin": "*",
        }
        for (override_path, name), value in self.header_overrides.items():
            if override_path == path:
                if value is None:
                    values.pop(name.lower(), None)
                else:
                    values[name.lower()] = value
        return {name: (value,) for name, value in values.items()}

    def __call__(
        self,
        method: str,
        url: str,
        headers: Mapping[str, str],
        maximum_bytes: int,
    ) -> canary.HttpResponse:
        self.calls.append((method, url, dict(headers), maximum_bytes))
        parsed = urllib.parse.urlsplit(url)
        if method in ("GET", "HEAD") and parsed.path == "/" and not parsed.query:
            return canary.HttpResponse(
                self.root_head_status if method == "HEAD" else self.root_status,
                self.root_headers,
                b"" if method == "HEAD" else self.root_body,
            )
        if (
            parsed.query
            or parsed.path not in canary.PUBLIC_PATHS
            or method not in ("GET", "HEAD")
        ):
            return canary.HttpResponse(self.negative_status, {}, b"blocked")

        body = self.selected_body(parsed.path)
        response_headers = self.headers(parsed.path, body)
        if headers.get("If-None-Match") is not None:
            return canary.HttpResponse(
                304,
                {"etag": response_headers["etag"]},
                b"",
            )
        if method == "HEAD":
            return canary.HttpResponse(200, response_headers, b"")
        if len(body) > maximum_bytes:
            raise canary.CanaryError("fake transport exceeded its bound")
        return canary.HttpResponse(200, response_headers, body)


class StaticOriginCanaryTests(unittest.TestCase):
    def verify(self, profile: str, fake: FakeOrigin | None = None, **kwargs):
        origin = fake or FakeOrigin(profile)
        clock = kwargs.pop("clock", Clock())
        return canary.verify_static_origin(
            "https://canary.example.org",
            "canary.example.org",
            profile,
            origin,
            now=clock.now,
            sleep=clock.sleep,
            convergence_seconds=kwargs.pop("convergence_seconds", 2),
            **kwargs,
        )

    def test_accepts_exact_game_and_classic_static_origins(self) -> None:
        for profile in ("classic-v1", "classic-v2", "game-v1"):
            with self.subTest(profile=profile):
                fake = FakeOrigin(profile)
                result = self.verify(profile, fake)
                self.assertEqual(result.generation, 42)
                self.assertEqual(result.attempts, 1)
                self.assertEqual(set(result.artifacts), set(canary.PUBLIC_PATHS))
                self.assertTrue(any(call[0] == "HEAD" for call in fake.calls))
                self.assertTrue(any(
                    call[2].get("If-None-Match") for call in fake.calls
                ))
                for method, path in canary.NEGATIVE_REQUESTS:
                    self.assertTrue(any(
                        call[0] == method and call[1].endswith(path)
                        for call in fake.calls
                    ))
                for path in canary.PUBLIC_PATHS:
                    self.assertTrue(any(
                        call[1].endswith(path)
                        and call[3] == canary.MAXIMUM_BYTES[profile][path]
                        for call in fake.calls
                    ))

    def test_accepts_one_adjacent_monotonic_convergence(self) -> None:
        fake = FakeOrigin("game-v1")
        current = fake.bodies["/index.html"][0]
        old = current.replace(b"<dd>42</dd>", b"<dd>41</dd>", 1)
        fake.bodies["/index.html"] = [old, current]
        result = self.verify("game-v1", fake)
        self.assertEqual(result.generation, 42)
        self.assertEqual(result.attempts, 2)

    def test_rejects_nonconvergent_and_nonadjacent_aliases(self) -> None:
        fake = FakeOrigin("game-v1")
        current = fake.bodies["/index.html"][0]
        fake.bodies["/index.html"] = [
            current.replace(b"<dd>42</dd>", b"<dd>40</dd>", 1)
        ]
        with self.assertRaisesRegex(canary.CanaryError, "adjacent-generation"):
            self.verify("game-v1", fake)

        fake = FakeOrigin("game-v1")
        current = fake.bodies["/index.html"][0]
        fake.bodies["/index.html"] = [
            current.replace(b"<dd>42</dd>", b"<dd>41</dd>", 1)
        ]
        with self.assertRaisesRegex(canary.CanaryError, "did not converge"):
            self.verify("game-v1", fake, convergence_seconds=1)

    def test_rejects_generation_regression_between_attempts(self) -> None:
        fake = FakeOrigin("game-v1")
        current = fake.bodies["/index.html"][0]
        generation_41 = current.replace(b"<dd>42</dd>", b"<dd>41</dd>", 1)
        fake.bodies["/index.html"] = [current, generation_41]
        current_json = fake.bodies["/index.json"][0]
        fake.bodies["/index.json"] = [
            current_json.replace(b'"generation":"42"', b'"generation":"41"', 1),
            current_json,
        ]
        with self.assertRaisesRegex(canary.CanaryError, "regressed"):
            self.verify("game-v1", fake)

    def test_rejects_malformed_or_reused_origin_validators(self) -> None:
        fake = FakeOrigin("game-v1")
        fake.header_overrides[("/index.html", "etag")] = 'W/"weak"'
        with self.assertRaisesRegex(canary.CanaryError, "strong ETag"):
            self.verify("game-v1", fake)

        fake = FakeOrigin("game-v1")
        for path in canary.PUBLIC_PATHS:
            fake.header_overrides[(path, "etag")] = '"shared"'
        with self.assertRaisesRegex(canary.CanaryError, "reuse"):
            self.verify("game-v1", fake)

    def test_requires_full_cross_format_server_semantics(self) -> None:
        fake = FakeOrigin("game-v1")
        fake.bodies["/index.xml"] = [
            fake.bodies["/index.xml"][0].replace(
                b"<name>Beta</name>", b"<name>Gamma</name>", 1
            )
        ]
        with self.assertRaisesRegex(canary.CanaryError, "inconsistent artifact"):
            self.verify("game-v1", fake)

    def test_content_length_is_optional_but_duplicates_fail_closed(self) -> None:
        fake = FakeOrigin("classic-v1")
        for path in canary.PUBLIC_PATHS:
            fake.header_overrides[(path, "content-length")] = None
        self.verify("classic-v1", fake)

        fake = FakeOrigin("classic-v1")
        original = fake.__call__

        def duplicate_header(method, url, headers, maximum_bytes):
            response = original(method, url, headers, maximum_bytes)
            if method == "GET" and url.endswith("/index.json") and response.status == 200:
                values = dict(response.headers)
                values["etag"] = ('"json-opaque"', '"duplicate"')
                return canary.HttpResponse(response.status, values, response.body)
            return response

        clock = Clock()
        with self.assertRaisesRegex(canary.CanaryError, "exactly one ETag"):
            canary.verify_static_origin(
                "https://canary.example.org",
                "canary.example.org",
                "classic-v1",
                duplicate_header,
                now=clock.now,
                sleep=clock.sleep,
            )

    def test_rejects_header_policy_and_head_mismatch(self) -> None:
        fake = FakeOrigin("classic-v1")
        fake.header_overrides[("/index.json", "cache-control")] = "public, max-age=3600"
        with self.assertRaisesRegex(canary.CanaryError, "Cache-Control"):
            self.verify("classic-v1", fake)

        fake = FakeOrigin("classic-v1")
        original = fake.__call__

        def mismatched_head(method, url, headers, maximum_bytes):
            response = original(method, url, headers, maximum_bytes)
            if method == "HEAD" and url.endswith("/index.xml"):
                values = dict(response.headers)
                values["etag"] = ('"different"',)
                return canary.HttpResponse(response.status, values, response.body)
            return response

        clock = Clock()
        with self.assertRaisesRegex(canary.CanaryError, "HEAD.*ETag"):
            canary.verify_static_origin(
                "https://canary.example.org",
                "canary.example.org",
                "classic-v1",
                mismatched_head,
                now=clock.now,
                sleep=clock.sleep,
            )

    def test_rejects_expired_future_or_overlong_freshness(self) -> None:
        for generated_at, expires_at, message in (
            (NOW - 100, NOW, "future-dated or expired"),
            (NOW + 301, NOW + 1000, "future-dated or expired"),
            (NOW - 1, NOW + 14_500, "freshness interval"),
        ):
            with self.subTest(message=message):
                fake = FakeOrigin("game-v1")
                for path, bodies in fake.bodies.items():
                    body = bodies[0]
                    if path == "/index.json":
                        body = reencode_game_json(body, generated_at, expires_at)
                    elif path == "/index.xml":
                        body = replace_xml_times(body, generated_at, expires_at)
                    else:
                        body = replace_html_times(body, generated_at, expires_at)
                    fake.bodies[path] = [body]
                with self.assertRaisesRegex(canary.CanaryError, message):
                    self.verify("game-v1", fake)

    def test_rejects_public_manifest_and_wrong_https_root(self) -> None:
        fake = FakeOrigin("game-v1")
        fake.root_status = 308
        fake.root_headers = {
            "location": ("https://canary.example.org/index.html",),
        }
        with self.assertRaisesRegex(canary.CanaryError, "GET / must return 404"):
            self.verify("game-v1", fake)

        fake = FakeOrigin("game-v1")
        fake.negative_status = 200
        with self.assertRaisesRegex(canary.CanaryError, "expected 403/404"):
            self.verify("game-v1", fake)

        fake = FakeOrigin("game-v1")
        fake.root_headers = {"location": ("/index.html",)}
        with self.assertRaisesRegex(canary.CanaryError, "must not include Location"):
            self.verify("game-v1", fake)

        fake = FakeOrigin("game-v1")
        fake.root_headers = {"cf-worker-status": ("ok",)}
        with self.assertRaisesRegex(canary.CanaryError, "CF-Worker-Status"):
            self.verify("game-v1", fake)

        fake = FakeOrigin("game-v1")
        fake.root_head_status = 200
        with self.assertRaisesRegex(canary.CanaryError, "HEAD / must return"):
            self.verify("game-v1", fake)

    def test_origin_input_is_canonical_and_production_is_explicit(self) -> None:
        self.assertEqual(
            canary.base_origin("https://canary.example.org/", False),
            ("https://canary.example.org", "canary.example.org"),
        )
        for value in (
            "http://canary.example.org",
            "https://CANARY.example.org",
            "https://user@canary.example.org",
            "https://canary.example.org:8443",
            "https://canary.example.org/path",
            "https://127.0.0.1",
            "https://127.1",
            "https://0x7f.0.0.1",
            "https://xn--a.example.org",
        ):
            with self.subTest(value=value), self.assertRaises(ValueError):
                canary.base_origin(value, False)
        with self.assertRaisesRegex(ValueError, "--allow-production"):
            canary.base_origin("https://meta.atrinik.org", False)
        self.assertEqual(
            canary.base_origin("https://meta.atrinik.org", True)[1],
            "meta.atrinik.org",
        )
        self.assertEqual(
            canary.base_origin("https://xn--bcher-kva.example.org", False)[1],
            "xn--bcher-kva.example.org",
        )
        self.assertEqual(canary.alias_prefix("classic-v2", "canary-v5"),
                         "/canary-v5")
        self.assertEqual(canary.alias_prefix("classic-v2", ""), "")
        for profile, prefix in (("classic-v1", "canary-v5"),
                                ("game-v1", "canary-v5"),
                                ("classic-v2", "precutover-v4")):
            with self.subTest(profile=profile, prefix=prefix), \
                    self.assertRaises(ValueError):
                canary.alias_prefix(profile, prefix)

    def test_json_decoder_rejects_duplicate_keys_and_noncanonical_bytes(self) -> None:
        body = fixture("game-directory-v1/canonical.json")
        duplicate = body.replace(
            b'{"schema":"atrinik-directory-v1",',
            b'{"schema":"atrinik-directory-v1","schema":"atrinik-directory-v1",',
            1,
        )
        with self.assertRaisesRegex(canary.CanaryError, "duplicates key"):
            canary.parse_json_artifact(duplicate, "game-v1")
        with self.assertRaisesRegex(canary.CanaryError, "canonically encoded"):
            canary.parse_json_artifact(body.replace(b'":', b'": ', 1), "game-v1")

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
        with mock.patch.object(canary.urllib.request, "build_opener", return_value=opener):
            fetch = canary.network_fetch(1)
        with self.assertRaisesRegex(canary.CanaryError, "exceeded 3 bytes"):
            fetch("GET", "https://canary.example.org/index.json", {}, 3)
        self.assertEqual(response.read_size, 4)
        self.assertTrue(response.closed)

    def test_cli_emits_bounded_machine_readable_summary(self) -> None:
        fake = FakeOrigin("game-v1")
        stdout = io.StringIO()
        with mock.patch.object(canary, "network_fetch", return_value=fake):
            with mock.patch.object(canary.time, "time", return_value=NOW):
                with contextlib.redirect_stdout(stdout):
                    result = canary.main([
                        "--profile", "game-v1",
                        "--base-url", "https://canary.example.org",
                        "--json",
                    ])
        self.assertEqual(result, 0)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["profile"], "game-v1")
        self.assertEqual(payload["generation"], "42")
        self.assertNotIn("etag", payload)
        self.assertNotIn("sha256", payload)


def reencode_game_json(body: bytes, generated_at: int, expires_at: int) -> bytes:
    value = json.loads(body)
    value["generatedAt"] = str(generated_at)
    value["expiresAt"] = str(expires_at)
    return (json.dumps(value, separators=(",", ":"), ensure_ascii=False) + "\n").encode()


def replace_xml_times(body: bytes, generated_at: int, expires_at: int) -> bytes:
    text = body.decode()
    text = re_sub_attribute(text, "generated-at", str(generated_at))
    text = re_sub_attribute(text, "expires-at", str(expires_at))
    return text.encode()


def replace_html_times(body: bytes, generated_at: int, expires_at: int) -> bytes:
    text = body.decode()
    text = re_sub_html_value(text, "Generated at", str(generated_at))
    text = re_sub_html_value(text, "Expires at", str(expires_at))
    return text.encode()


def re_sub_attribute(text: str, name: str, value: str) -> str:
    return re.sub(rf'{name}="[0-9]+"', f'{name}="{value}"', text, count=1)


def re_sub_html_value(text: str, name: str, value: str) -> str:
    return re.sub(
        rf"<dt>{re.escape(name)}</dt><dd>[0-9]+</dd>",
        f"<dt>{name}</dt><dd>{value}</dd>",
        text,
        count=1,
    )


if __name__ == "__main__":
    unittest.main()
