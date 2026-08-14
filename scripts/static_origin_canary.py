#!/usr/bin/env python3
"""Verify one deployed static directory origin without mutating Cloudflare.

The verifier uses only public HTTPS requests. It accepts no Cloudflare token,
does not call the Cloudflare API, and cannot create, update, or delete a
resource. Production hostnames require an explicit acknowledgement so the
default workflow remains an isolated canary.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import ipaddress
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as element_tree
from collections import defaultdict
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from email.utils import format_datetime, parsedate_to_datetime
from typing import NoReturn


PRODUCTION_HOSTS = frozenset({"meta.atrinik.org", "classic.meta.atrinik.org"})
PUBLIC_PATHS = ("/index.html", "/index.json", "/index.xml")
CONTENT_TYPES = {
    "/index.html": "text/html; charset=utf-8",
    "/index.json": "application/json; charset=utf-8",
    "/index.xml": "application/xml; charset=utf-8",
}
MAXIMUM_BYTES = {
    "classic-v1": {path: 4 * 1024 * 1024 for path in PUBLIC_PATHS},
    "classic-v2": {path: 4 * 1024 * 1024 for path in PUBLIC_PATHS},
    "game-v1": {
        "/index.html": 4 * 1024 * 1024,
        "/index.json": 262_144,
        "/index.xml": 4 * 1024 * 1024,
    },
}
SCHEMAS = {
    "classic-v1": "atrinik-classic-directory-v4",
    "classic-v2": "atrinik-classic-directory-v5",
    "game-v1": "atrinik-directory-v1",
}
REQUIRED_CSP = (
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; "
    "form-action 'none'; frame-ancestors 'none'"
)
REQUIRED_CACHE_DIRECTIVES = frozenset(
    {"public", "must-revalidate", "stale-if-error=0", "no-transform"}
)
NEGATIVE_REQUESTS = (
    ("GET", "/manifest.json"),
    ("HEAD", "/manifest.json"),
    ("GET", "/v1/private"),
    ("GET", "/?unexpected=1"),
    ("GET", "/index.json?unexpected=1"),
    ("HEAD", "/index.json?unexpected=1"),
    ("GET", "/INDEX.JSON"),
    ("GET", "/%69ndex.json"),
    ("GET", "/index.json/"),
    ("POST", "/"),
    ("POST", "/index.json"),
    ("OPTIONS", "/index.json"),
)
FORBIDDEN_FIELDS = frozenset(
    {
        "sourceip",
        "source_ip",
        "candidate",
        "candidates",
        "ticket",
        "token",
        "rendezvoustoken",
        "nonce",
        "signature",
        "authorization",
        "password",
        "joinpassword",
        "revision",
        "internalrevision",
    }
)
HOSTNAME = re.compile(
    r"^(?=.{1,253}$)(?=.*[a-z])"
    r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
    r"(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$"
)
GENERATION = re.compile(r"^[1-9][0-9]{0,19}$")
SERVER_ID = re.compile(r"^[0-9a-f]{64}$")
MAX_UINT64 = 18_446_744_073_709_551_615
MAX_ERROR_BYTES = 64 * 1024


class CanaryError(RuntimeError):
    """A public origin violated the reviewed static-directory contract."""


@dataclass(frozen=True)
class HttpResponse:
    status: int
    headers: Mapping[str, tuple[str, ...]]
    body: bytes


@dataclass(frozen=True)
class ArtifactObservation:
    path: str
    generation: int
    generated_at: int
    expires_at: int
    server_ids: tuple[str, ...]
    semantic_servers: tuple[str, ...]
    etag: str
    body_sha256: str
    byte_length: int
    response: HttpResponse


@dataclass(frozen=True)
class CanaryResult:
    profile: str
    host: str
    generation: int
    generated_at: int
    expires_at: int
    attempts: int
    artifacts: Mapping[str, int]


Fetch = Callable[[str, str, Mapping[str, str], int], HttpResponse]


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        return None


def fail(message: str) -> NoReturn:
    raise CanaryError(message)


def base_origin(value: str, allow_production: bool) -> tuple[str, str]:
    parsed = urllib.parse.urlsplit(value)
    if (
        parsed.scheme != "https"
        or parsed.username is not None
        or parsed.password is not None
        or parsed.port is not None
        or parsed.query
        or parsed.fragment
        or parsed.path not in ("", "/")
        or parsed.hostname is None
        or parsed.netloc != parsed.hostname
        or parsed.hostname != parsed.hostname.lower()
        or not canonical_hostname(parsed.hostname)
    ):
        raise ValueError("base URL must be one canonical HTTPS DNS origin")
    if parsed.hostname in PRODUCTION_HOSTS and not allow_production:
        raise ValueError(
            "production origins require --allow-production; use an isolated "
            "canary hostname by default"
        )
    return f"https://{parsed.hostname}", parsed.hostname


def alias_prefix(profile: str, value: str) -> str:
    if value == "":
        return ""
    if profile == "classic-v2" and value == "canary-v5":
        return "/canary-v5"
    raise ValueError("alias prefix is invalid for the selected profile")


def canonical_hostname(value: str) -> bool:
    if HOSTNAME.fullmatch(value) is None:
        return False
    try:
        ipaddress.ip_address(value)
        return False
    except ValueError:
        pass
    labels = value.split(".")
    if all(
        label.isdecimal()
        or (
            label.startswith("0x")
            and len(label) > 2
            and all(character in "0123456789abcdef" for character in label[2:])
        )
        for label in labels
    ):
        return False
    for label in labels:
        if label.startswith("xn--"):
            try:
                decoded = label.encode("ascii").decode("idna")
                if decoded.encode("idna").decode("ascii") != label:
                    return False
            except UnicodeError:
                return False
    return True


def _headers(message) -> Mapping[str, tuple[str, ...]]:  # noqa: ANN001
    values: dict[str, list[str]] = defaultdict(list)
    for name, value in message.items():
        values[name.lower()].append(value)
    return {name: tuple(items) for name, items in values.items()}


def network_fetch(timeout: float) -> Fetch:
    opener = urllib.request.build_opener(_NoRedirect())

    def fetch(
        method: str,
        url: str,
        headers: Mapping[str, str],
        maximum_bytes: int,
    ) -> HttpResponse:
        request = urllib.request.Request(
            url,
            method=method,
            headers={
                "Accept-Encoding": "identity",
                "User-Agent": "atrinik-static-origin-canary/1",
                **headers,
            },
        )
        response = None
        try:
            response = opener.open(request, timeout=timeout)
        except urllib.error.HTTPError as error:
            response = error
        except (OSError, urllib.error.URLError) as error:
            fail(f"{method} {url} failed: {error}")
        try:
            body = response.read(maximum_bytes + 1)
            if len(body) > maximum_bytes:
                fail(f"{method} {url} exceeded {maximum_bytes} bytes")
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


def optional_header(response: HttpResponse, name: str) -> str | None:
    values = response.headers.get(name.lower(), ())
    if len(values) > 1:
        fail(f"response includes duplicate {name} headers")
    return None if not values else values[0]


def no_header(response: HttpResponse, name: str) -> None:
    if response.headers.get(name.lower(), ()):
        fail(f"response must not include {name}")


def strong_etag(value: str) -> bool:
    if len(value) < 3 or len(value) > 128 or value[0] != '"' or value[-1] != '"':
        return False
    return all(
        0x21 <= ord(character) <= 0x7E and character not in {'"', "\\"}
        for character in value[1:-1]
    )


def http_timestamp(value: str, name: str) -> int:
    try:
        parsed = parsedate_to_datetime(value)
    except (TypeError, ValueError) as error:
        fail(f"{name} is not an HTTP date: {error}")
    if parsed.tzinfo is None or format_datetime(parsed, usegmt=True) != value:
        fail(f"{name} is not a canonical GMT HTTP date")
    timestamp = parsed.timestamp()
    if not timestamp.is_integer() or timestamp < 0:
        fail(f"{name} timestamp is invalid")
    return int(timestamp)


def canonical_generation(value: object) -> int:
    if not isinstance(value, str) or GENERATION.fullmatch(value) is None:
        fail("artifact generation is invalid")
    generation = int(value)
    if generation > MAX_UINT64:
        fail("artifact generation exceeds uint64")
    return generation


def canonical_timestamp(value: object, context: str) -> int:
    if isinstance(value, bool):
        fail(f"{context} is invalid")
    if isinstance(value, str):
        if not value.isascii() or not value.isdecimal() or (
            len(value) > 1 and value.startswith("0")
        ):
            fail(f"{context} is invalid")
        parsed = int(value)
    elif isinstance(value, int):
        parsed = value
    else:
        fail(f"{context} is invalid")
    if parsed < 0 or parsed > 253_402_300_799:
        fail(f"{context} is outside the supported Unix range")
    return parsed


def canonical_integer(
    value: object,
    minimum: int,
    maximum: int,
    context: str,
) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or value < minimum
        or value > maximum
    ):
        fail(f"{context} is invalid")
    return value


def canonical_integer_text(
    value: object,
    minimum: int,
    maximum: int,
    context: str,
) -> int:
    if (
        not isinstance(value, str)
        or not value.isascii()
        or not value.isdecimal()
        or (len(value) > 1 and value.startswith("0"))
    ):
        fail(f"{context} is invalid")
    parsed = int(value)
    if parsed < minimum or parsed > maximum:
        fail(f"{context} is invalid")
    return parsed


def canonical_boolean(value: object, context: str) -> bool:
    if not isinstance(value, bool):
        fail(f"{context} is invalid")
    return value


def canonical_boolean_text(value: object, context: str) -> bool:
    if value == "true":
        return True
    if value == "false":
        return False
    fail(f"{context} is invalid")


def canonical_text(
    value: object,
    minimum_bytes: int,
    maximum_bytes: int,
    context: str,
    game: bool = False,
) -> str:
    if not isinstance(value, str):
        fail(f"{context} is invalid")
    try:
        length = len(value.encode("utf-8"))
    except UnicodeEncodeError:
        fail(f"{context} contains an unpaired surrogate")
    if length < minimum_bytes or length > maximum_bytes:
        fail(f"{context} has an invalid UTF-8 length")
    for character in value:
        scalar = ord(character)
        if (
            scalar <= 0x1F
            or scalar == 0x7F
            or scalar in (0xFFFE, 0xFFFF)
            or (game and (0x80 <= scalar <= 0x9F or scalar in (0x2028, 0x2029)))
        ):
            fail(f"{context} contains forbidden text")
    return value


def exact_keys(
    value: object,
    required: Sequence[str],
    optional: Sequence[str],
    context: str,
) -> dict[str, object]:
    if not isinstance(value, dict):
        fail(f"{context} is not an object")
    keys = list(value)
    expected = list(required)
    if keys != expected and keys != expected + list(optional):
        fail(f"{context} keys or key order are invalid")
    return value


def canonical_digest(value: object, context: str) -> str:
    if not isinstance(value, str) or SERVER_ID.fullmatch(value) is None:
        fail(f"{context} is invalid")
    return value


def canonical_endpoint(value: object, context: str) -> dict[str, object]:
    endpoint = exact_keys(value, ("hostname", "port"), (), context)
    hostname = endpoint["hostname"]
    if not isinstance(hostname, str) or not canonical_hostname(hostname):
        fail(f"{context} hostname is invalid")
    return {
        "hostname": hostname,
        "port": canonical_integer(endpoint["port"], 1, 65_535, context),
    }


def semantic_server(value: Mapping[str, object]) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def escape_html(value: object) -> str:
    return (
        str(value)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&#39;")
    )


def render_html_endpoint(endpoint: object) -> str:
    if endpoint is None:
        return "not published"
    if not isinstance(endpoint, dict):
        fail("HTML endpoint model is invalid")
    return f"<code>{escape_html(endpoint['hostname'])}:{endpoint['port']}</code>"


def render_html_row(profile: str, server: Mapping[str, object]) -> str:
    classic = profile != "game-v1"
    policy_key = (
        "accessCodeRequired" if profile == "classic-v2" else "passwordRequired"
    )
    protected = bool(server[policy_key])
    policy = (
        ("protected" if protected else "open")
        if profile == "classic-v2"
        else ("required" if protected else "not required")
    )
    if classic:
        cells = (
            f"<code>{server['serverId']}</code>",
            escape_html(server["name"]),
            escape_html(server["version"]),
            str(server["playersCount"]),
            escape_html(server["textComment"]),
            f"<code>{server['certificateSha256']}</code>",
            "listed",
            policy,
            render_html_endpoint(server.get("endpoint")),
        )
    else:
        protocol = server["protocol"]
        content = server["content"]
        players = server["players"]
        if not all(isinstance(value, dict) for value in (protocol, content, players)):
            fail("Game HTML model is invalid")
        cells = (
            f"<code>{server['serverId']}</code>",
            f"<code>{server['certificateSha256']}</code>",
            escape_html(server["name"]),
            escape_html(server["description"]),
            (
                "not published"
                if "region" not in server
                else escape_html(server["region"])
            ),
            f"1.{protocol['minor']}",
            escape_html(content["id"]),
            f"<code>{content['revisionSha256']}</code>",
            f"{players['online']}/{players['capacity']}",
            str(server["status"]),
            policy,
            render_html_endpoint(server.get("endpoint")),
        )
    return "      <tr>" + "".join(f"<td>{cell}</td>" for cell in cells) + "</tr>"


def canonical_html(
    profile: str,
    generation: int,
    generated_at: int,
    expires_at: int,
    semantic: Sequence[str],
) -> str:
    classic = profile != "game-v1"
    title = "Atrinik Classic servers" if classic else "Atrinik servers"
    headings = (
        (
            "Server ID", "Name", "Version", "Players", "Comment",
            "Certificate SHA-256", "Status",
            "Access code" if profile == "classic-v2" else "Password",
            "Direct endpoint",
        )
        if classic
        else (
            "Server ID", "Certificate SHA-256", "Name", "Description",
            "Region", "Protocol", "Content ID", "Content revision SHA-256",
            "Players", "Status", "Password", "Direct endpoint",
        )
    )
    servers = tuple(json.loads(value) for value in semantic)
    rows = tuple(render_html_row(profile, server) for server in servers)
    heading_html = "".join(f'<th scope="col">{heading}</th>' for heading in headings)
    joined_rows = "\n".join(rows)
    row_html = "" if not rows else f"\n{joined_rows}\n    "
    return (
        "<!doctype html>\n"
        '<html lang="en">\n'
        "<head>\n"
        '  <meta charset="utf-8">\n'
        '  <meta name="viewport" content="width=device-width, initial-scale=1">\n'
        '  <meta http-equiv="Content-Security-Policy" '
        'content="default-src \'none\'; base-uri \'none\'; form-action \'none\'">\n'
        f"  <title>{title}</title>\n"
        "</head>\n"
        "<body>\n"
        "<main>\n"
        f"  <h1>{title}</h1>\n"
        "  <dl>\n"
        f"    <dt>Schema</dt><dd><code>{SCHEMAS[profile]}</code></dd>\n"
        f"    <dt>Generation</dt><dd>{generation}</dd>\n"
        f"    <dt>Generated at</dt><dd>{generated_at}</dd>\n"
        f"    <dt>Expires at</dt><dd>{expires_at}</dd>\n"
        "  </dl>\n"
        "  <table>\n"
        f"    <thead><tr>{heading_html}</tr></thead>\n"
        f"    <tbody>{row_html}</tbody>\n"
        "  </table>\n"
        "</main>\n"
        "</body>\n"
        "</html>\n"
    )


def canonical_classic_server(
    value: object, index: int, profile: str = "classic-v1"
) -> dict[str, object]:
    context = f"classic server {index}"
    policy_key = (
        "accessCodeRequired" if profile == "classic-v2" else "passwordRequired"
    )
    server = exact_keys(
        value,
        (
            "serverId",
            "name",
            "playersCount",
            "version",
            "textComment",
            "certificateSha256",
            policy_key,
        ),
        ("endpoint",),
        context,
    )
    server_id = canonical_digest(server["serverId"], f"{context} identity")
    certificate = canonical_digest(
        server["certificateSha256"], f"{context} certificate"
    )
    if certificate != server_id:
        fail(f"{context} certificate does not match its identity")
    result: dict[str, object] = {
        "serverId": server_id,
        "name": canonical_text(server["name"], 1, 80, f"{context} name"),
        "playersCount": canonical_integer(
            server["playersCount"], 0, 4_294_967_295, f"{context} players"
        ),
        "version": canonical_text(server["version"], 1, 32, f"{context} version"),
        "textComment": canonical_text(
            server["textComment"], 0, 256, f"{context} comment"
        ),
        "certificateSha256": certificate,
        policy_key: canonical_boolean(
            server[policy_key], f"{context} access policy"
        ),
    }
    if "endpoint" in server:
        result["endpoint"] = canonical_endpoint(
            server["endpoint"], f"{context} endpoint"
        )
    return result


def canonical_game_server(value: object, index: int) -> dict[str, object]:
    context = f"game server {index}"
    if not isinstance(value, dict):
        fail(f"{context} is not an object")
    without_region = [
        "serverId", "certificateSha256", "name", "description", "protocol",
        "content", "players", "status", "passwordRequired",
    ]
    with_region = without_region[:4] + ["region"] + without_region[4:]
    expected = with_region if "region" in value else without_region
    if "endpoint" in value:
        expected = expected + ["endpoint"]
    if list(value) != expected:
        fail(f"{context} keys or key order are invalid")
    server_id = canonical_digest(value["serverId"], f"{context} identity")
    certificate = canonical_digest(
        value["certificateSha256"], f"{context} certificate"
    )
    if certificate != server_id:
        fail(f"{context} certificate does not match its identity")
    protocol = exact_keys(
        value["protocol"], ("major", "minor"), (), f"{context} protocol"
    )
    canonical_integer(protocol["major"], 1, 1, f"{context} protocol major")
    content = exact_keys(
        value["content"], ("id", "revisionSha256"), (), f"{context} content"
    )
    content_id = content["id"]
    if (
        not isinstance(content_id, str)
        or re.fullmatch(
            r"[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?", content_id
        ) is None
    ):
        fail(f"{context} content ID is invalid")
    players = exact_keys(
        value["players"], ("online", "capacity"), (), f"{context} players"
    )
    online = canonical_integer(
        players["online"], 0, 100_000, f"{context} online players"
    )
    capacity = canonical_integer(
        players["capacity"], 1, 100_000, f"{context} capacity"
    )
    if online > capacity:
        fail(f"{context} player counts are invalid")
    status = value["status"]
    if status not in ("online", "full", "maintenance") or (
        (status == "online" and online >= capacity)
        or (status == "full" and online != capacity)
        or (status == "maintenance" and online != 0)
    ):
        fail(f"{context} status is invalid")
    result: dict[str, object] = {
        "serverId": server_id,
        "certificateSha256": certificate,
        "name": canonical_text(value["name"], 1, 80, f"{context} name", True),
        "description": canonical_text(
            value["description"], 0, 512, f"{context} description", True
        ),
    }
    if "region" in value:
        region = value["region"]
        if (
            not isinstance(region, str)
            or re.fullmatch(
                r"[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?", region
            ) is None
        ):
            fail(f"{context} region is invalid")
        result["region"] = region
    result.update({
        "protocol": {
            "major": 1,
            "minor": canonical_integer(
                protocol["minor"], 0, 65_535, f"{context} protocol minor"
            ),
        },
        "content": {
            "id": content_id,
            "revisionSha256": canonical_digest(
                content["revisionSha256"], f"{context} content revision"
            ),
        },
        "players": {"online": online, "capacity": capacity},
        "status": status,
        "passwordRequired": canonical_boolean(
            value["passwordRequired"], f"{context} password requirement"
        ),
    })
    if "endpoint" in value:
        result["endpoint"] = canonical_endpoint(
            value["endpoint"], f"{context} endpoint"
        )
    return result


def canonical_servers(
    values: object,
    profile: str,
) -> tuple[tuple[str, ...], tuple[str, ...]]:
    if not isinstance(values, list) or len(values) > 512:
        fail("server collection is invalid")
    canonical = tuple(
        canonical_classic_server(value, index, profile)
        if profile != "game-v1"
        else canonical_game_server(value, index)
        for index, value in enumerate(values)
    )
    identities = tuple(str(value["serverId"]) for value in canonical)
    if identities != tuple(sorted(set(identities))):
        fail("server identities are not strictly ordered")
    return identities, tuple(semantic_server(value) for value in canonical)


def reject_forbidden_fields(value: object) -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            if key.lower() in FORBIDDEN_FIELDS:
                fail(f"artifact exposes forbidden field {key}")
            reject_forbidden_fields(child)
    elif isinstance(value, list):
        for child in value:
            reject_forbidden_fields(child)


def parse_json_artifact(
    body: bytes,
    profile: str,
) -> tuple[int, int, int, tuple[str, ...], tuple[str, ...]]:
    try:
        text = body.decode("utf-8", errors="strict")
        value = json.loads(
            text,
            object_pairs_hook=unique_json_object,
            parse_constant=lambda constant: fail(
                f"JSON artifact contains invalid constant {constant}"
            ),
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"JSON artifact is invalid: {error}")
    if not text.endswith("\n") or not isinstance(value, dict):
        fail("JSON artifact is not one complete canonical object")
    expected_keys = (
        ["schema", "protocol", "generation", "generatedAt", "expiresAt", "servers"]
        if profile != "game-v1"
        else ["schema", "generation", "generatedAt", "expiresAt", "servers"]
    )
    if list(value) != expected_keys:
        fail("JSON artifact keys or top-level order are invalid")
    canonical = json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
    ) + "\n"
    if canonical != text:
        fail("JSON artifact is not canonically encoded")
    reject_forbidden_fields(value)
    if value.get("schema") != SCHEMAS[profile]:
        fail("JSON artifact schema is invalid")
    if profile != "game-v1" and value.get("protocol") != (
        5 if profile == "classic-v2" else 4
    ):
        fail("classic JSON protocol is invalid")
    generation = canonical_generation(value.get("generation"))
    generated_at = canonical_timestamp(value.get("generatedAt"), "generatedAt")
    expires_at = canonical_timestamp(value.get("expiresAt"), "expiresAt")
    identities, semantic = canonical_servers(value.get("servers"), profile)
    return (
        generation,
        generated_at,
        expires_at,
        identities,
        semantic,
    )


def unique_json_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    value: dict[str, object] = {}
    for key, child in pairs:
        if key in value:
            fail(f"JSON artifact duplicates key {key}")
        value[key] = child
    return value


def xml_text(element: element_tree.Element, context: str) -> str:
    if element.attrib or list(element):
        fail(f"{context} is not one plain XML text element")
    return "" if element.text is None else element.text


def xml_whitespace(value: str | None, context: str) -> None:
    if value is not None and not value.isspace():
        fail(f"{context} contains unexpected XML character data")


def classic_xml_server(
    server: element_tree.Element,
    index: int,
    profile: str = "classic-v1",
) -> dict[str, object]:
    context = f"classic XML server {index}"
    if server.tag != "Server":
        fail(f"{context} element name is invalid")
    if server.attrib:
        fail(f"{context} has unexpected attributes")
    xml_whitespace(server.text, context)
    xml_whitespace(server.tail, context)
    children = list(server)
    for child in children:
        xml_whitespace(child.tail, f"{context} layout")
    tags = [child.tag for child in children]
    policy_tag = (
        "AccessCodeRequired" if profile == "classic-v2" else "PasswordRequired"
    )
    without_endpoint = [
        "Id", "Name", "PlayersCount", "Version", "TextComment",
        "CertificateSha256", policy_tag,
    ]
    with_endpoint = without_endpoint[:5] + ["Address", "Port"] + without_endpoint[5:]
    if tags not in (without_endpoint, with_endpoint):
        fail(f"{context} elements or element order are invalid")
    values = {child.tag: xml_text(child, f"{context} {child.tag}") for child in children}
    value: dict[str, object] = {
        "serverId": values["Id"],
        "name": values["Name"],
        "playersCount": canonical_integer_text(
            values["PlayersCount"], 0, 4_294_967_295, f"{context} players"
        ),
        "version": values["Version"],
        "textComment": values["TextComment"],
        "certificateSha256": values["CertificateSha256"],
        (
            "accessCodeRequired"
            if profile == "classic-v2"
            else "passwordRequired"
        ): canonical_boolean_text(
            values[policy_tag], f"{context} access policy"
        ),
    }
    if "Address" in values:
        value["endpoint"] = {
            "hostname": values["Address"],
            "port": canonical_integer_text(
                values["Port"], 1, 65_535, f"{context} endpoint"
            ),
        }
    return canonical_classic_server(value, index, profile)


def game_xml_server(
    server: element_tree.Element,
    index: int,
) -> dict[str, object]:
    context = f"game XML server {index}"
    if server.tag != "server":
        fail(f"{context} element name is invalid")
    if list(server.attrib) != [
        "id", "certificate-sha256", "status", "password-required",
    ]:
        fail(f"{context} attributes or attribute order are invalid")
    xml_whitespace(server.text, context)
    xml_whitespace(server.tail, context)
    children = list(server)
    for child in children:
        xml_whitespace(child.tail, f"{context} layout")
    tags = [child.tag for child in children]
    without_region = ["name", "description", "protocol", "content", "players"]
    with_region = ["name", "description", "region", "protocol", "content", "players"]
    expected = with_region if "region" in tags else without_region
    if "endpoint" in tags:
        expected = expected + ["endpoint"]
    if tags != expected:
        fail(f"{context} elements or element order are invalid")
    by_tag = {child.tag: child for child in children}
    for name in ("name", "description", "region"):
        if name in by_tag and (by_tag[name].attrib or list(by_tag[name])):
            fail(f"{context} {name} is not one plain text element")
    protocol = by_tag["protocol"]
    content = by_tag["content"]
    players = by_tag["players"]
    if list(protocol.attrib) != ["major", "minor"] or protocol.text:
        fail(f"{context} protocol is invalid")
    if list(content.attrib) != ["id", "revision-sha256"] or content.text:
        fail(f"{context} content is invalid")
    if list(players.attrib) != ["online", "capacity"] or players.text:
        fail(f"{context} players are invalid")
    value: dict[str, object] = {
        "serverId": server.attrib["id"],
        "certificateSha256": server.attrib["certificate-sha256"],
        "name": "" if by_tag["name"].text is None else by_tag["name"].text,
        "description": (
            "" if by_tag["description"].text is None else by_tag["description"].text
        ),
    }
    if "region" in by_tag:
        value["region"] = "" if by_tag["region"].text is None else by_tag["region"].text
    value.update({
        "protocol": {
            "major": canonical_integer_text(
                protocol.attrib["major"], 1, 1, f"{context} protocol major"
            ),
            "minor": canonical_integer_text(
                protocol.attrib["minor"], 0, 65_535, f"{context} protocol minor"
            ),
        },
        "content": {
            "id": content.attrib["id"],
            "revisionSha256": content.attrib["revision-sha256"],
        },
        "players": {
            "online": canonical_integer_text(
                players.attrib["online"], 0, 100_000, f"{context} online players"
            ),
            "capacity": canonical_integer_text(
                players.attrib["capacity"], 1, 100_000, f"{context} capacity"
            ),
        },
        "status": server.attrib["status"],
        "passwordRequired": canonical_boolean_text(
            server.attrib["password-required"], f"{context} password requirement"
        ),
    })
    if "endpoint" in by_tag:
        endpoint = by_tag["endpoint"]
        if list(endpoint.attrib) != ["hostname", "port"] or endpoint.text:
            fail(f"{context} endpoint is invalid")
        value["endpoint"] = {
            "hostname": endpoint.attrib["hostname"],
            "port": canonical_integer_text(
                endpoint.attrib["port"], 1, 65_535, f"{context} endpoint"
            ),
        }
    return canonical_game_server(value, index)


def parse_xml_artifact(
    body: bytes,
    profile: str,
) -> tuple[int, int, int, tuple[str, ...], tuple[str, ...]]:
    try:
        text = body.decode("utf-8", errors="strict")
    except UnicodeDecodeError as error:
        fail(f"XML artifact is not UTF-8: {error}")
    if not text.startswith('<?xml version="1.0" encoding="UTF-8"?>\n'):
        fail("XML artifact omits the exact XML declaration")
    lowered = text.lower()
    if "<!doctype" in lowered or "<!entity" in lowered or "<!--" in text:
        fail("XML artifact contains forbidden declarations or comments")
    if "<?" in text[len('<?xml version="1.0" encoding="UTF-8"?>') :]:
        fail("XML artifact contains an extra processing instruction")
    try:
        root = element_tree.fromstring(text)
    except element_tree.ParseError as error:
        fail(f"XML artifact is invalid: {error}")
    expected_tag = "Servers" if profile != "game-v1" else "directory"
    if root.tag != expected_tag or root.attrib.get("schema") != SCHEMAS[profile]:
        fail("XML artifact root is invalid")
    if profile != "game-v1" and root.attrib.get("protocol") != (
        "5" if profile == "classic-v2" else "4"
    ):
        fail("classic XML protocol is invalid")
    expected_attributes = (
        ["protocol", "schema", "generation", "generated-at", "expires-at"]
        if profile != "game-v1"
        else ["schema", "generation", "generated-at", "expires-at"]
    )
    if list(root.attrib) != expected_attributes:
        fail("XML artifact root attributes or attribute order are invalid")
    xml_whitespace(root.text, "XML root")
    xml_whitespace(root.tail, "XML root")
    servers = tuple(
        classic_xml_server(server, index, profile)
        if profile != "game-v1"
        else game_xml_server(server, index)
        for index, server in enumerate(list(root))
    )
    if len(servers) > 512:
        fail("XML contains too many servers")
    identities = tuple(str(server["serverId"]) for server in servers)
    if identities != tuple(sorted(set(identities))):
        fail("XML server identities are not strictly ordered")
    return (
        canonical_generation(root.attrib.get("generation")),
        canonical_timestamp(root.attrib.get("generated-at"), "generated-at"),
        canonical_timestamp(root.attrib.get("expires-at"), "expires-at"),
        identities,
        tuple(semantic_server(server) for server in servers),
    )


def _html_value(text: str, label: str, code: bool = False) -> str:
    wrapper = "<code>([^<]+)</code>" if code else "([^<]+)"
    match = re.search(rf"<dt>{re.escape(label)}</dt><dd>{wrapper}</dd>", text)
    if match is None:
        fail(f"HTML artifact omits {label}")
    return match.group(1)


def html_cell(fragment: str, context: str, code: bool = False) -> str:
    if code:
        match = re.fullmatch(r"<code>([^<>]*)</code>", fragment)
        if match is None:
            fail(f"{context} is not one code cell")
        fragment = match.group(1)
    elif "<" in fragment or ">" in fragment:
        fail(f"{context} contains unexpected markup")
    return html.unescape(fragment)


def html_endpoint(fragment: str, context: str) -> dict[str, object] | None:
    if fragment == "not published":
        return None
    value = html_cell(fragment, context, code=True)
    hostname, separator, port = value.rpartition(":")
    if not separator:
        fail(f"{context} is invalid")
    return canonical_endpoint(
        {
            "hostname": hostname,
            "port": canonical_integer_text(port, 1, 65_535, context),
        },
        context,
    )


def classic_html_server(
    cells: Sequence[str], index: int, profile: str = "classic-v1"
) -> dict[str, object]:
    context = f"classic HTML server {index}"
    if len(cells) != 9:
        fail(f"{context} has an invalid column count")
    if html_cell(cells[6], f"{context} status") != "listed":
        fail(f"{context} status is invalid")
    policy = html_cell(cells[7], f"{context} access policy")
    allowed_policy = (
        ("open", "protected")
        if profile == "classic-v2"
        else ("required", "not required")
    )
    if policy not in allowed_policy:
        fail(f"{context} access policy is invalid")
    policy_key = (
        "accessCodeRequired" if profile == "classic-v2" else "passwordRequired"
    )
    value: dict[str, object] = {
        "serverId": html_cell(cells[0], f"{context} identity", code=True),
        "name": html_cell(cells[1], f"{context} name"),
        "playersCount": canonical_integer_text(
            html_cell(cells[3], f"{context} players"),
            0,
            4_294_967_295,
            f"{context} players",
        ),
        "version": html_cell(cells[2], f"{context} version"),
        "textComment": html_cell(cells[4], f"{context} comment"),
        "certificateSha256": html_cell(
            cells[5], f"{context} certificate", code=True
        ),
        policy_key: policy in ("required", "protected"),
    }
    endpoint = html_endpoint(cells[8], f"{context} endpoint")
    if endpoint is not None:
        value["endpoint"] = endpoint
    return canonical_classic_server(value, index, profile)


def game_html_server(cells: Sequence[str], index: int) -> dict[str, object]:
    context = f"game HTML server {index}"
    if len(cells) != 12:
        fail(f"{context} has an invalid column count")
    protocol_match = re.fullmatch(
        r"1\.([0-9]+)", html_cell(cells[5], f"{context} protocol")
    )
    players_match = re.fullmatch(
        r"([0-9]+)/([0-9]+)", html_cell(cells[8], f"{context} players")
    )
    if protocol_match is None or players_match is None:
        fail(f"{context} protocol or players are invalid")
    password = html_cell(cells[10], f"{context} password")
    if password not in ("required", "not required"):
        fail(f"{context} password requirement is invalid")
    value: dict[str, object] = {
        "serverId": html_cell(cells[0], f"{context} identity", code=True),
        "certificateSha256": html_cell(
            cells[1], f"{context} certificate", code=True
        ),
        "name": html_cell(cells[2], f"{context} name"),
        "description": html_cell(cells[3], f"{context} description"),
    }
    region = html_cell(cells[4], f"{context} region")
    if region != "not published":
        value["region"] = region
    value.update({
        "protocol": {
            "major": 1,
            "minor": canonical_integer_text(
                protocol_match.group(1), 0, 65_535, f"{context} protocol"
            ),
        },
        "content": {
            "id": html_cell(cells[6], f"{context} content"),
            "revisionSha256": html_cell(
                cells[7], f"{context} content revision", code=True
            ),
        },
        "players": {
            "online": canonical_integer_text(
                players_match.group(1), 0, 100_000, f"{context} online players"
            ),
            "capacity": canonical_integer_text(
                players_match.group(2), 1, 100_000, f"{context} capacity"
            ),
        },
        "status": html_cell(cells[9], f"{context} status"),
        "passwordRequired": password == "required",
    })
    endpoint = html_endpoint(cells[11], f"{context} endpoint")
    if endpoint is not None:
        value["endpoint"] = endpoint
    return canonical_game_server(value, index)


def parse_html_artifact(
    body: bytes,
    profile: str,
) -> tuple[int, int, int, tuple[str, ...], tuple[str, ...]]:
    try:
        text = body.decode("utf-8", errors="strict")
    except UnicodeDecodeError as error:
        fail(f"HTML artifact is not UTF-8: {error}")
    lowered = text.lower()
    if not lowered.startswith("<!doctype html>\n") or any(
        token in lowered for token in ("<script", "<form", "javascript:")
    ):
        fail("HTML artifact contains an unsafe or invalid document shape")
    if _html_value(text, "Schema", code=True) != SCHEMAS[profile]:
        fail("HTML artifact schema is invalid")
    rows = [
        re.findall(r"<td>(.*?)</td>", row, flags=re.DOTALL)
        for row in re.findall(r"<tr>(.*?)</tr>", text, flags=re.DOTALL)
        if "<td>" in row
    ]
    if len(rows) > 512:
        fail("HTML contains too many servers")
    servers = tuple(
        classic_html_server(cells, index, profile)
        if profile != "game-v1"
        else game_html_server(cells, index)
        for index, cells in enumerate(rows)
    )
    identities = tuple(str(server["serverId"]) for server in servers)
    if identities != tuple(sorted(set(identities))):
        fail("HTML server identities are not strictly ordered")
    generation = canonical_generation(_html_value(text, "Generation"))
    generated_at = canonical_timestamp(
        _html_value(text, "Generated at"), "Generated at"
    )
    expires_at = canonical_timestamp(_html_value(text, "Expires at"), "Expires at")
    semantic = tuple(semantic_server(server) for server in servers)
    if text != canonical_html(
        profile,
        generation,
        generated_at,
        expires_at,
        semantic,
    ):
        fail("HTML artifact is not the exact canonical projection")
    return (
        generation,
        generated_at,
        expires_at,
        identities,
        semantic,
    )


def parse_artifact(
    path: str,
    body: bytes,
    profile: str,
) -> tuple[int, int, int, tuple[str, ...], tuple[str, ...]]:
    if path == "/index.json":
        return parse_json_artifact(body, profile)
    if path == "/index.xml":
        return parse_xml_artifact(body, profile)
    return parse_html_artifact(body, profile)


def observe_artifact(
    fetch: Fetch,
    origin: str,
    path: str,
    profile: str,
    now: int,
) -> ArtifactObservation:
    maximum_bytes = MAXIMUM_BYTES[profile][path]
    response = fetch("GET", origin + path, {}, maximum_bytes)
    if response.status != 200:
        fail(f"GET {path} returned {response.status}, expected 200")
    if len(response.body) == 0:
        fail(f"GET {path} returned an empty body")
    content_length = optional_header(response, "Content-Length")
    if content_length is not None and (
        not content_length.isdecimal() or int(content_length) != len(response.body)
    ):
        fail(f"GET {path} has an invalid Content-Length")
    if one_header(response, "Content-Type") != CONTENT_TYPES[path]:
        fail(f"GET {path} has an invalid Content-Type")
    etag = one_header(response, "ETag")
    if not strong_etag(etag):
        fail(f"GET {path} has an invalid strong ETag")
    cache_directives = tuple(
        part.strip().lower() for part in one_header(response, "Cache-Control").split(",")
    )
    if len(cache_directives) != len(set(cache_directives)) or frozenset(
        cache_directives
    ) != REQUIRED_CACHE_DIRECTIVES:
        fail(f"GET {path} has an invalid Cache-Control policy")
    if one_header(response, "Content-Security-Policy") != REQUIRED_CSP:
        fail(f"GET {path} has an invalid Content-Security-Policy")
    if one_header(response, "X-Content-Type-Options").lower() != "nosniff":
        fail(f"GET {path} has an invalid nosniff policy")
    if one_header(response, "Access-Control-Allow-Origin") != "*":
        fail(f"GET {path} has an invalid CORS policy")
    no_header(response, "Set-Cookie")
    no_header(response, "Content-Encoding")

    generation, generated_at, expires_at, identities, semantic = parse_artifact(
        path, response.body, profile
    )
    if generated_at > now + 300 or now >= expires_at:
        fail(f"GET {path} is future-dated or expired")
    if expires_at <= generated_at or expires_at - generated_at > 14_400:
        fail(f"GET {path} has an invalid freshness interval")
    last_modified = http_timestamp(one_header(response, "Last-Modified"), "Last-Modified")
    if last_modified < generated_at or last_modified >= expires_at:
        fail(f"GET {path} has an invalid publication time")
    if http_timestamp(one_header(response, "Expires"), "Expires") != expires_at:
        fail(f"GET {path} HTTP expiry differs from its body")

    return ArtifactObservation(
        path=path,
        generation=generation,
        generated_at=generated_at,
        expires_at=expires_at,
        server_ids=identities,
        semantic_servers=semantic,
        etag=etag,
        body_sha256=hashlib.sha256(response.body).hexdigest(),
        byte_length=len(response.body),
        response=response,
    )


def verify_head_and_conditional(
    fetch: Fetch,
    origin: str,
    artifact: ArtifactObservation,
) -> None:
    head = fetch("HEAD", origin + artifact.path, {}, 0)
    if head.status != 200 or head.body:
        fail(f"HEAD {artifact.path} did not return one bodyless 200")
    for name in (
        "Content-Type",
        "ETag",
        "Last-Modified",
        "Expires",
        "Cache-Control",
        "Content-Security-Policy",
        "X-Content-Type-Options",
        "Access-Control-Allow-Origin",
    ):
        if one_header(head, name) != one_header(artifact.response, name):
            fail(f"HEAD {artifact.path} changed {name}")
    head_length = optional_header(head, "Content-Length")
    if head_length is not None and (
        not head_length.isdecimal() or int(head_length) != artifact.byte_length
    ):
        fail(f"HEAD {artifact.path} has an invalid Content-Length")
    no_header(head, "Set-Cookie")

    conditional = fetch(
        "GET",
        origin + artifact.path,
        {"If-None-Match": artifact.etag},
        artifact.byte_length,
    )
    if conditional.status != 304 or conditional.body:
        fail(f"conditional GET {artifact.path} did not return one bodyless 304")
    if one_header(conditional, "ETag") != artifact.etag:
        fail(f"conditional GET {artifact.path} changed its validator")
    no_header(conditional, "Set-Cookie")
    no_header(conditional, "Content-Encoding")


def cohort_is_coherent(observations: Sequence[ArtifactObservation]) -> bool:
    return len(
        {
            (
                observation.generation,
                observation.generated_at,
                observation.expires_at,
                observation.semantic_servers,
            )
            for observation in observations
        }
    ) == 1


def verify_validator_separation(observations: Sequence[ArtifactObservation]) -> None:
    body_by_etag: dict[str, str] = {}
    for observation in observations:
        prior = body_by_etag.get(observation.etag)
        if prior is not None and prior != observation.body_sha256:
            fail("different representations reuse one HTTP validator")
        body_by_etag[observation.etag] = observation.body_sha256


def verify_root_and_negative_routes(fetch: Fetch, origin: str) -> None:
    root = fetch("GET", origin + "/", {}, MAX_ERROR_BYTES)
    if root.status != 404:
        fail("HTTPS GET / must return 404")
    no_header(root, "Location")
    no_header(root, "Set-Cookie")
    no_header(root, "CF-Worker-Status")
    root_head = fetch("HEAD", origin + "/", {}, 0)
    if root_head.status != 404 or root_head.body:
        fail("HTTPS HEAD / must return one bodyless 404")
    no_header(root_head, "Location")
    no_header(root_head, "Set-Cookie")
    no_header(root_head, "CF-Worker-Status")

    for method, path in NEGATIVE_REQUESTS:
        response = fetch(method, origin + path, {}, MAX_ERROR_BYTES)
        if response.status not in (403, 404):
            fail(f"{method} {path} returned {response.status}, expected 403/404")
        no_header(response, "Set-Cookie")


def verify_static_origin(
    origin: str,
    host: str,
    profile: str,
    fetch: Fetch,
    now: Callable[[], float] | None = None,
    sleep: Callable[[float], None] | None = None,
    convergence_seconds: int = 15,
) -> CanaryResult:
    now_function = time.time if now is None else now
    sleep_function = time.sleep if sleep is None else sleep
    started = now_function()
    deadline = started + convergence_seconds
    attempts = 0
    previous_generation = {path: 0 for path in PUBLIC_PATHS}
    observations: tuple[ArtifactObservation, ...]
    while True:
        attempts += 1
        current_time = int(now_function())
        observations = tuple(
            observe_artifact(fetch, origin, path, profile, current_time)
            for path in PUBLIC_PATHS
        )
        generations = [observation.generation for observation in observations]
        if max(generations) - min(generations) > 1:
            fail("public aliases exceed adjacent-generation convergence")
        for observation in observations:
            if observation.generation < previous_generation[observation.path]:
                fail(f"{observation.path} regressed to an older generation")
            previous_generation[observation.path] = observation.generation
        if cohort_is_coherent(observations):
            break
        coordinates = {
            (
                observation.generation,
                observation.generated_at,
                observation.expires_at,
            )
            for observation in observations
        }
        if len(coordinates) == 1:
            fail("one generation has inconsistent artifact representations")
        if now_function() >= deadline:
            fail("public aliases did not converge within the reviewed bound")
        sleep_function(min(1.0, max(0.0, deadline - now_function())))

    verify_validator_separation(observations)
    for observation in observations:
        verify_head_and_conditional(fetch, origin, observation)
    verify_root_and_negative_routes(fetch, origin)
    first = observations[0]
    return CanaryResult(
        profile=profile,
        host=host,
        generation=first.generation,
        generated_at=first.generated_at,
        expires_at=first.expires_at,
        attempts=attempts,
        artifacts={item.path: item.byte_length for item in observations},
    )


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    root.add_argument("--profile", choices=tuple(MAXIMUM_BYTES), required=True)
    root.add_argument("--base-url", required=True)
    root.add_argument("--alias-prefix", default="")
    root.add_argument("--timeout", type=float, default=10.0)
    root.add_argument("--convergence-seconds", type=int, default=15)
    root.add_argument("--allow-production", action="store_true")
    root.add_argument("--json", action="store_true", dest="json_output")
    return root


def main(argv: Sequence[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        if not 0.25 <= args.timeout <= 30:
            raise ValueError("timeout must be between 0.25 and 30 seconds")
        if not 1 <= args.convergence_seconds <= 300:
            raise ValueError("convergence must be between 1 and 300 seconds")
        origin, host = base_origin(args.base_url, args.allow_production)
        origin += alias_prefix(args.profile, args.alias_prefix)
        result = verify_static_origin(
            origin,
            host,
            args.profile,
            network_fetch(args.timeout),
            convergence_seconds=args.convergence_seconds,
        )
    except (CanaryError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2

    payload = {
        "profile": result.profile,
        "host": result.host,
        "generation": str(result.generation),
        "generated_at": result.generated_at,
        "expires_at": result.expires_at,
        "attempts": result.attempts,
        "artifact_bytes": dict(sorted(result.artifacts.items())),
    }
    if args.json_output:
        print(json.dumps(payload, sort_keys=True, separators=(",", ":")))
    else:
        print(
            f"{result.profile} static origin valid: {result.host}; "
            f"generation {result.generation}; {result.attempts} attempt(s)"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
