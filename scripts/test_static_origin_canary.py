import contextlib
import hashlib
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
        if profile == "classic-v3":
            json_name = "classic-directory-v6/index.json"
            xml_name = "classic-directory-v6/index.xml"
            html_name = "classic-directory-v6/index.html"
        else:
            json_name = "game-directory-v2/canonical.json"
            xml_name = "game-directory-v2/projection.xml"
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
            "etag": f'"{path[7:-1]}-{hashlib.sha256(body).hexdigest()[:16]}"',
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
            if headers["If-None-Match"] != response_headers["etag"][0]:
                if len(body) > maximum_bytes:
                    raise canary.CanaryError("fake transport exceeded its bound")
                return canary.HttpResponse(200, response_headers, body)
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
        for profile in ("classic-v3", "game-v2"):
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
        fake = FakeOrigin("game-v2")
        current = fake.bodies["/index.html"][0]
        old = current.replace(b"<dd>42</dd>", b"<dd>41</dd>", 1)
        fake.bodies["/index.html"] = [old, current]
        result = self.verify("game-v2", fake)
        self.assertEqual(result.generation, 42)
        self.assertEqual(result.attempts, 2)

    def test_accepts_atomic_publication_before_head(self) -> None:
        fake = FakeOrigin("game-v2")
        published = False

        def atomic_publication(method, url, headers, maximum_bytes):
            nonlocal published
            if not published and method == "HEAD":
                set_generation(fake, 43)
                published = True
            return fake(method, url, headers, maximum_bytes)

        result = self.verify("game-v2", atomic_publication)
        self.assertEqual(result.generation, 43)
        self.assertEqual(result.attempts, 2)
        self.assertEqual(
            [(method, urllib.parse.urlsplit(url).path) for method, url, _, _ in fake.calls[:5]],
            [
                ("GET", "/index.html"),
                ("GET", "/index.json"),
                ("GET", "/index.xml"),
                ("HEAD", "/index.html"),
                ("GET", "/index.html"),
            ],
        )
        assert_complete_positive_attempt(self, fake.calls[5:])

    def test_accepts_larger_atomic_publication_before_conditional(self) -> None:
        fake = FakeOrigin("game-v2")
        published = False

        def atomic_publication(method, url, headers, maximum_bytes):
            nonlocal published
            if not published and headers.get("If-None-Match") is not None:
                set_generation(fake, 100)
                published = True
            return fake(method, url, headers, maximum_bytes)

        result = self.verify("game-v2", atomic_publication)
        self.assertEqual(result.generation, 100)
        self.assertEqual(result.attempts, 2)
        conditional = next(
            call for call in fake.calls if call[2].get("If-None-Match") is not None
        )
        self.assertEqual(
            conditional[3], canary.MAXIMUM_BYTES["game-v2"]["/index.html"]
        )
        restart = next(
            index
            for index, call in enumerate(fake.calls)
            if index > 4 and call[0] == "GET" and not call[2]
        )
        assert_complete_positive_attempt(self, fake.calls[restart:])

    def test_rejects_persistent_head_mismatch(self) -> None:
        fake = FakeOrigin("game-v2")
        original = fake.__call__

        def mismatched_head(method, url, headers, maximum_bytes):
            response = original(method, url, headers, maximum_bytes)
            if method == "HEAD" and url.endswith("/index.html"):
                values = dict(response.headers)
                values["etag"] = ('"unmatched-new-publication"',)
                return canary.HttpResponse(response.status, values, response.body)
            return response

        with self.assertRaisesRegex(canary.CanaryError, "matching newer publication"):
            self.verify("game-v2", mismatched_head)

    def test_rejects_same_generation_change_and_reused_validator(self) -> None:
        fake = FakeOrigin("game-v2")
        current = fake.bodies["/index.html"][0]
        generation, generated_at, expires_at, _, semantic = metadata(
            current, "game-v2", "/index.html"
        )
        older = canary.canonical_html(
            "game-v2", generation - 1, generated_at, expires_at, semantic
        ).encode()
        changed_older = canary.canonical_html(
            "game-v2", generation - 1, generated_at + 1, expires_at, semantic
        ).encode()
        fake.bodies["/index.html"] = [older, changed_older]
        with self.assertRaisesRegex(canary.CanaryError, "changed body"):
            self.verify("game-v2", fake)

        fake = FakeOrigin("game-v2")
        set_generation(fake, 43)
        reused = fake.headers("/index.html", fake.bodies["/index.html"][0])["etag"][0]
        fake.bodies["/index.html"] = [
            replace_generation(fake.bodies["/index.html"][0], "/index.html", 42),
            fake.bodies["/index.html"][0],
        ]
        fake.header_overrides[("/index.html", "etag")] = reused
        with self.assertRaisesRegex(canary.CanaryError, "reuse"):
            self.verify("game-v2", fake)

    def test_rejects_cross_attempt_same_generation_semantic_change(self) -> None:
        fake = FakeOrigin("game-v2")
        html = fake.bodies["/index.html"][0]
        _, generated_at, expires_at, _, semantic = metadata(
            html, "game-v2", "/index.html"
        )
        changed_server = json.loads(semantic[0])
        changed_server["name"] = "Changed publication"
        changed_semantic = (canary.semantic_server(changed_server), *semantic[1:])
        html_43 = canary.canonical_html(
            "game-v2", 43, generated_at, expires_at, changed_semantic
        ).encode()
        html_44 = canary.canonical_html(
            "game-v2", 44, generated_at, expires_at, changed_semantic
        ).encode()
        phase = "cohort"

        def contradictory_publication(method, url, headers, maximum_bytes):
            nonlocal phase
            path = urllib.parse.urlsplit(url).path
            if phase == "cohort" and method == "HEAD" and path == "/index.html":
                fake.bodies[path] = [html_43]
                phase = "confirmation"
            response = fake(method, url, headers, maximum_bytes)
            if (
                phase == "confirmation"
                and method == "GET"
                and path == "/index.html"
                and not headers
            ):
                fake.bodies["/index.html"] = [html_44]
                for other in ("/index.json", "/index.xml"):
                    fake.bodies[other] = [
                        replace_generation(fake.bodies[other][-1], other, 43)
                    ]
                phase = "retry"
            return response

        with self.assertRaisesRegex(
            canary.CanaryError, "one generation has inconsistent"
        ):
            self.verify("game-v2", contradictory_publication)

    def test_convergence_deadline_covers_positive_proofs(self) -> None:
        fake = FakeOrigin("game-v2")
        clock = Clock()

        def slow_origin(method, url, headers, maximum_bytes):
            response = fake(method, url, headers, maximum_bytes)
            clock.value += 0.3
            return response

        with self.assertRaisesRegex(canary.CanaryError, "did not converge"):
            self.verify(
                "game-v2",
                slow_origin,
                clock=clock,
                convergence_seconds=1,
            )
        self.assertEqual(len(fake.calls), 4)

    def test_rejects_invalid_conditional_publication_responses(self) -> None:
        for mode, message in (
            ("same", "without a newer publication"),
            ("expired", "future-dated or expired"),
            ("oversized", "invalid body length"),
            ("timeout", "timed out"),
        ):
            with self.subTest(mode=mode):
                fake = FakeOrigin("game-v2")
                original = fake.__call__

                def invalid_conditional(method, url, headers, maximum_bytes):
                    if headers.get("If-None-Match") is None:
                        return original(method, url, headers, maximum_bytes)
                    path = urllib.parse.urlsplit(url).path
                    body = fake.bodies[path][-1]
                    if mode == "timeout":
                        raise canary.CanaryError("conditional request timed out")
                    if mode == "expired":
                        body = replace_generation(body, path, 43)
                        body = replace_times(body, path, NOW - 100, NOW)
                    elif mode == "oversized":
                        body = b"x" * (canary.MAXIMUM_BYTES["game-v2"][path] + 1)
                    response_headers = fake.headers(path, fake.bodies[path][-1])
                    if mode == "expired":
                        response_headers = fake.headers(path, body)
                    if mode == "oversized":
                        response_headers["etag"] = ('"oversized-new-publication"',)
                        response_headers["content-length"] = (str(len(body)),)
                    return canary.HttpResponse(200, response_headers, body)

                with self.assertRaisesRegex(canary.CanaryError, message):
                    self.verify("game-v2", invalid_conditional)

    def test_rejects_unmatched_head_confirmation_and_invalid_304(self) -> None:
        fake = FakeOrigin("game-v2")
        original = fake.__call__
        head_seen = False

        def unmatched_confirmation(method, url, headers, maximum_bytes):
            nonlocal head_seen
            response = original(method, url, headers, maximum_bytes)
            if method == "HEAD" and url.endswith("/index.html"):
                set_generation(fake, 43)
                head_seen = True
                values = fake.headers("/index.html", fake.bodies["/index.html"][0])
                values["etag"] = ('"head-only-validator"',)
                return canary.HttpResponse(200, values, b"")
            self.assertFalse(head_seen and method == "GET" and headers)
            return response

        with self.assertRaisesRegex(canary.CanaryError, "HEAD.*changed ETag"):
            self.verify("game-v2", unmatched_confirmation)

        for body, etag, message in (
            (b"unexpected", None, "bodyless 304"),
            (b"", '"wrong-validator"', "changed its validator"),
        ):
            with self.subTest(message=message):
                fake = FakeOrigin("game-v2")
                original = fake.__call__

                def invalid_304(method, url, headers, maximum_bytes):
                    response = original(method, url, headers, maximum_bytes)
                    if headers.get("If-None-Match") is not None:
                        value = headers["If-None-Match"] if etag is None else etag
                        return canary.HttpResponse(304, {"etag": (value,)}, body)
                    return response

                with self.assertRaisesRegex(canary.CanaryError, message):
                    self.verify("game-v2", invalid_304)

    def test_repeated_valid_publications_exhaust_one_deadline(self) -> None:
        fake = FakeOrigin("game-v2")
        clock = Clock()
        generation = 42

        def continually_publishing(method, url, headers, maximum_bytes):
            nonlocal generation
            if method == "HEAD":
                generation += 1
                set_generation(fake, generation)
            response = fake(method, url, headers, maximum_bytes)
            clock.value += 0.08
            return response

        with self.assertRaisesRegex(canary.CanaryError, "did not converge"):
            self.verify(
                "game-v2",
                continually_publishing,
                clock=clock,
                convergence_seconds=1,
            )

    def test_late_invalid_response_is_not_masked_by_deadline(self) -> None:
        fake = FakeOrigin("game-v2")
        clock = Clock()

        def late_invalid(method, url, headers, maximum_bytes):
            response = fake(method, url, headers, maximum_bytes)
            if method == "HEAD":
                clock.value += 2
                return canary.HttpResponse(500, response.headers, b"")
            return response

        with self.assertRaisesRegex(canary.CanaryError, "bodyless 200"):
            self.verify(
                "game-v2", late_invalid, clock=clock, convergence_seconds=1
            )

    def test_rechecks_freshness_after_positive_proofs(self) -> None:
        fake = FakeOrigin("game-v2")
        set_times(fake, NOW - 100, NOW + 1)
        clock = Clock()

        def expiring_origin(method, url, headers, maximum_bytes):
            response = fake(method, url, headers, maximum_bytes)
            clock.value += 0.1
            return response

        with self.assertRaisesRegex(canary.CanaryError, "future-dated or expired"):
            self.verify(
                "game-v2", expiring_origin, clock=clock, convergence_seconds=2
            )

    def test_rejects_nonconvergent_and_nonadjacent_aliases(self) -> None:
        fake = FakeOrigin("game-v2")
        current = fake.bodies["/index.html"][0]
        fake.bodies["/index.html"] = [
            current.replace(b"<dd>42</dd>", b"<dd>40</dd>", 1)
        ]
        with self.assertRaisesRegex(canary.CanaryError, "adjacent-generation"):
            self.verify("game-v2", fake)

        fake = FakeOrigin("game-v2")
        current = fake.bodies["/index.html"][0]
        fake.bodies["/index.html"] = [
            current.replace(b"<dd>42</dd>", b"<dd>41</dd>", 1)
        ]
        with self.assertRaisesRegex(canary.CanaryError, "did not converge"):
            self.verify("game-v2", fake, convergence_seconds=1)

    def test_rejects_generation_regression_between_attempts(self) -> None:
        fake = FakeOrigin("game-v2")
        current = fake.bodies["/index.html"][0]
        generation_41 = current.replace(b"<dd>42</dd>", b"<dd>41</dd>", 1)
        fake.bodies["/index.html"] = [current, generation_41]
        current_json = fake.bodies["/index.json"][0]
        fake.bodies["/index.json"] = [
            current_json.replace(b'"generation":"42"', b'"generation":"41"', 1),
            current_json,
        ]
        with self.assertRaisesRegex(canary.CanaryError, "regressed"):
            self.verify("game-v2", fake)

    def test_rejects_malformed_or_reused_origin_validators(self) -> None:
        fake = FakeOrigin("game-v2")
        fake.header_overrides[("/index.html", "etag")] = 'W/"weak"'
        with self.assertRaisesRegex(canary.CanaryError, "strong ETag"):
            self.verify("game-v2", fake)

        fake = FakeOrigin("game-v2")
        for path in canary.PUBLIC_PATHS:
            fake.header_overrides[(path, "etag")] = '"shared"'
        with self.assertRaisesRegex(canary.CanaryError, "reuse"):
            self.verify("game-v2", fake)

    def test_requires_full_cross_format_server_semantics(self) -> None:
        fake = FakeOrigin("game-v2")
        fake.bodies["/index.xml"] = [
            fake.bodies["/index.xml"][0].replace(
                b"<name>Beta</name>", b"<name>Gamma</name>", 1
            )
        ]
        with self.assertRaisesRegex(canary.CanaryError, "inconsistent artifact"):
            self.verify("game-v2", fake)

    def test_content_length_is_optional_but_duplicates_fail_closed(self) -> None:
        fake = FakeOrigin("classic-v3")
        for path in canary.PUBLIC_PATHS:
            fake.header_overrides[(path, "content-length")] = None
        self.verify("classic-v3", fake)

        fake = FakeOrigin("classic-v3")
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
                "classic-v3",
                duplicate_header,
                now=clock.now,
                sleep=clock.sleep,
            )

    def test_rejects_header_policy_and_head_mismatch(self) -> None:
        fake = FakeOrigin("classic-v3")
        fake.header_overrides[("/index.json", "cache-control")] = "public, max-age=3600"
        with self.assertRaisesRegex(canary.CanaryError, "Cache-Control"):
            self.verify("classic-v3", fake)

        fake = FakeOrigin("classic-v3")
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
                "classic-v3",
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
                fake = FakeOrigin("game-v2")
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
                    self.verify("game-v2", fake)

    def test_rejects_public_manifest_and_wrong_https_root(self) -> None:
        fake = FakeOrigin("game-v2")
        fake.root_status = 308
        fake.root_headers = {
            "location": ("https://canary.example.org/index.html",),
        }
        with self.assertRaisesRegex(canary.CanaryError, "GET / must return 404"):
            self.verify("game-v2", fake)

        fake = FakeOrigin("game-v2")
        fake.negative_status = 200
        with self.assertRaisesRegex(canary.CanaryError, "expected 403/404"):
            self.verify("game-v2", fake)

        fake = FakeOrigin("game-v2")
        fake.root_headers = {"location": ("/index.html",)}
        with self.assertRaisesRegex(canary.CanaryError, "must not include Location"):
            self.verify("game-v2", fake)

        fake = FakeOrigin("game-v2")
        fake.root_headers = {"cf-worker-status": ("ok",)}
        with self.assertRaisesRegex(canary.CanaryError, "CF-Worker-Status"):
            self.verify("game-v2", fake)

        fake = FakeOrigin("game-v2")
        fake.root_head_status = 200
        with self.assertRaisesRegex(canary.CanaryError, "HEAD / must return"):
            self.verify("game-v2", fake)

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
        self.assertEqual(canary.alias_prefix("classic-v3", "canary-v6"),
                         "/canary-v6")
        self.assertEqual(canary.alias_prefix("classic-v3", ""), "")
        self.assertEqual(canary.alias_prefix("game-v2", "canary-v2"), "/canary-v2")
        for profile, prefix in (("classic-v3", "canary-v2"),
                                ("game-v2", "canary-v6"),
                                ("classic-v3", "precutover-v4")):
            with self.subTest(profile=profile, prefix=prefix), \
                    self.assertRaises(ValueError):
                canary.alias_prefix(profile, prefix)

    def test_json_decoder_rejects_duplicate_keys_and_noncanonical_bytes(self) -> None:
        body = fixture("game-directory-v2/canonical.json")
        duplicate = body.replace(
            b'{"schema":"atrinik-game-directory-v2",',
            b'{"schema":"atrinik-game-directory-v2","schema":"atrinik-game-directory-v2",',
            1,
        )
        with self.assertRaisesRegex(canary.CanaryError, "duplicates key"):
            canary.parse_json_artifact(duplicate, "game-v2")
        with self.assertRaisesRegex(canary.CanaryError, "canonically encoded"):
            canary.parse_json_artifact(body.replace(b'":', b'": ', 1), "game-v2")

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
        fake = FakeOrigin("game-v2")
        stdout = io.StringIO()
        with mock.patch.object(canary, "network_fetch", return_value=fake):
            with mock.patch.object(canary.time, "time", return_value=NOW):
                with contextlib.redirect_stdout(stdout):
                    result = canary.main([
                        "--profile", "game-v2",
                        "--base-url", "https://canary.example.org",
                        "--json",
                    ])
        self.assertEqual(result, 0)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["profile"], "game-v2")
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


def replace_generation(body: bytes, path: str, generation: int) -> bytes:
    text = body.decode()
    if path == "/index.json":
        value = json.loads(text)
        value["generation"] = str(generation)
        return (
            json.dumps(value, separators=(",", ":"), ensure_ascii=False) + "\n"
        ).encode()
    if path == "/index.xml":
        return re_sub_attribute(text, "generation", str(generation)).encode()
    return re_sub_html_value(text, "Generation", str(generation)).encode()


def set_generation(fake: FakeOrigin, generation: int) -> None:
    for path in canary.PUBLIC_PATHS:
        fake.bodies[path] = [replace_generation(fake.bodies[path][-1], path, generation)]


def replace_times(
    body: bytes,
    path: str,
    generated_at: int,
    expires_at: int,
) -> bytes:
    if path == "/index.json":
        return reencode_game_json(body, generated_at, expires_at)
    if path == "/index.xml":
        return replace_xml_times(body, generated_at, expires_at)
    return replace_html_times(body, generated_at, expires_at)


def set_times(fake: FakeOrigin, generated_at: int, expires_at: int) -> None:
    for path in canary.PUBLIC_PATHS:
        fake.bodies[path] = [
            replace_times(fake.bodies[path][-1], path, generated_at, expires_at)
        ]


def assert_complete_positive_attempt(
    test: unittest.TestCase,
    calls: list[tuple[str, str, dict[str, str], int]],
) -> None:
    for path in canary.PUBLIC_PATHS:
        test.assertTrue(any(
            method == "GET"
            and urllib.parse.urlsplit(url).path == path
            and not headers
            for method, url, headers, _ in calls
        ))
        test.assertTrue(any(
            method == "HEAD" and urllib.parse.urlsplit(url).path == path
            for method, url, _, _ in calls
        ))
        test.assertTrue(any(
            method == "GET"
            and urllib.parse.urlsplit(url).path == path
            and headers.get("If-None-Match") is not None
            for method, url, headers, _ in calls
        ))


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
