import { describe, expect, it } from "vitest";

import { HttpError } from "../src/http";
import {
  classifyCanonicalRoute,
  CLASSIC_RENDEZVOUS_INVITE_SUBPROTOCOL,
  PUBLISH_AUTHORITY,
  PUBLISH_MAX_BODY_BYTES,
  RENDEZVOUS_AUTHORITY,
} from "../src/routes";
import type { RouteInput } from "../src/routes";

const SERVER_ID = "1".repeat(64);

function publisherInput(
  path = `/v1/servers/${SERVER_ID}/publish`,
  overrides: Partial<RouteInput> = {},
): RouteInput {
  return {
    target: `https://${PUBLISH_AUTHORITY}${path}`,
    method: "POST",
    headers: new Headers({ "Content-Type": "application/json" }),
    hasBody: true,
    ...overrides,
  };
}

function rendezvousInput(
  path = `/v1/servers/${SERVER_ID}?role=client`,
  overrides: Partial<RouteInput> = {},
): RouteInput {
  return {
    target: `https://${RENDEZVOUS_AUTHORITY}${path}`,
    method: "GET",
    headers: new Headers({
      Connection: "Upgrade",
      Upgrade: "websocket",
      "Sec-WebSocket-Key": "MDEyMzQ1Njc4OWFiY2RlZg==",
      "Sec-WebSocket-Version": "13",
    }),
    hasBody: false,
    ...overrides,
  };
}

function canonicalError(input: RouteInput): HttpError {
  try {
    classifyCanonicalRoute(input);
  } catch (error) {
    if (error instanceof HttpError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected canonical route classification to fail");
}

describe("canonical dynamic route grammar", () => {
  it("classifies all generation-specific publisher paths", () => {
    expect(classifyCanonicalRoute(publisherInput())).toEqual({
      kind: "publish",
      generation: "game-protocol-1",
      publisherProfile: "game-v1",
      serverId: SERVER_ID,
      authority: PUBLISH_AUTHORITY,
      maximumBodyBytes: 4_096,
    });
    expect(classifyCanonicalRoute(publisherInput(
      `/v1/classic/servers/${SERVER_ID}/publish`,
      {
        target: `https://PUBLISH.META.ATRINIK.ORG/v1/classic/servers/${SERVER_ID}/publish`,
      },
    ))).toEqual({
      kind: "publish",
      generation: "classic",
      publisherProfile: "classic-v1",
      serverId: SERVER_ID,
      authority: PUBLISH_AUTHORITY,
      maximumBodyBytes: PUBLISH_MAX_BODY_BYTES,
    });
    expect(classifyCanonicalRoute(publisherInput(
      `/v2/classic/servers/${SERVER_ID}/publish`,
    ))).toEqual({
      kind: "publish",
      generation: "classic",
      publisherProfile: "classic-v2",
      serverId: SERVER_ID,
      authority: PUBLISH_AUTHORITY,
      maximumBodyBytes: PUBLISH_MAX_BODY_BYTES,
    });
  });

  it("classifies both generation-specific rendezvous paths and roles", () => {
    expect(classifyCanonicalRoute(rendezvousInput())).toEqual({
      kind: "rendezvous",
      generation: "game-protocol-1",
      serverId: SERVER_ID,
      role: "client",
      subprotocol: null,
      authority: RENDEZVOUS_AUTHORITY,
    });
    expect(classifyCanonicalRoute(rendezvousInput(
      `/v1/classic/servers/${SERVER_ID}?role=server`,
      {
        headers: new Headers({
          Upgrade: "websocket",
          "Sec-WebSocket-Protocol":
            CLASSIC_RENDEZVOUS_INVITE_SUBPROTOCOL,
        }),
      },
    ))).toEqual({
      kind: "rendezvous",
      generation: "classic",
      serverId: SERVER_ID,
      role: "server",
      subprotocol: CLASSIC_RENDEZVOUS_INVITE_SUBPROTOCOL,
      authority: RENDEZVOUS_AUTHORITY,
    });
  });

  it("rejects alternate authorities, explicit ports, and non-HTTPS targets", () => {
    for (const target of [
      `https://meta.atrinik.org/v1/servers/${SERVER_ID}/publish`,
      `https://classic.meta.atrinik.org/v1/servers/${SERVER_ID}/publish`,
      `https://example.net/v1/servers/${SERVER_ID}/publish`,
    ]) {
      expect(canonicalError(publisherInput(undefined, { target })).code).toBe(
        "misdirected_request",
      );
    }

    for (const target of [
      `http://${PUBLISH_AUTHORITY}/v1/servers/${SERVER_ID}/publish`,
      `https://${PUBLISH_AUTHORITY}:443/v1/servers/${SERVER_ID}/publish`,
      `https://user@${PUBLISH_AUTHORITY}/v1/servers/${SERVER_ID}/publish`,
      `https://${PUBLISH_AUTHORITY}/v1/servers/${SERVER_ID}/publish#fragment`,
    ]) {
      expect(canonicalError(publisherInput(undefined, { target })).code).toBe(
        "invalid_target",
      );
    }
  });

  it("rejects ambiguous, encoded, normalized, and non-exact paths", () => {
    for (const path of [
      `/v1/servers/${SERVER_ID}/publish/`,
      `/v1//servers/${SERVER_ID}/publish`,
      `/v1/./servers/${SERVER_ID}/publish`,
      `/v1/other/../servers/${SERVER_ID}/publish`,
    ]) {
      expect(["invalid_target", "not_found"]).toContain(
        canonicalError(publisherInput(path)).code,
      );
    }

    for (const path of [
      `/v1/%73ervers/${SERVER_ID}/publish`,
      `/v1/servers/%31${SERVER_ID.slice(1)}/publish`,
      `/v1/%2e/servers/${SERVER_ID}/publish`,
      `/v1\\servers\\${SERVER_ID}\\publish`,
    ]) {
      expect(canonicalError(publisherInput(path)).code).toBe("invalid_target");
    }
  });

  it("rejects invalid server IDs without normalizing them", () => {
    for (const id of [
      "1".repeat(63),
      "1".repeat(65),
      "A".repeat(64),
      "z".repeat(64),
    ]) {
      expect(canonicalError(publisherInput(
        `/v1/servers/${id}/publish`,
      )).code).toBe("invalid_server_id");
      expect(canonicalError(rendezvousInput(
        `/v1/servers/${id}?role=client`,
      )).code).toBe("invalid_server_id");
    }
  });

  it("keeps the Classic v2 route exact and rejects aliases", () => {
    for (const path of [
      `/v2/classic/servers/${SERVER_ID}/publish/`,
      `/v2/classics/servers/${SERVER_ID}/publish`,
      `/v2/classic/server/${SERVER_ID}/publish`,
      `/v2/servers/${SERVER_ID}/publish`,
      `/v1/classic-v2/servers/${SERVER_ID}/publish`,
    ]) {
      expect(canonicalError(publisherInput(path)).code).toBe("not_found");
    }
    expect(canonicalError(publisherInput(
      `/v2/%63lassic/servers/${SERVER_ID}/publish`,
    )).code).toBe("invalid_target");
  });

  it("keeps publisher methods, queries, and service paths exact", () => {
    for (const method of ["GET", "HEAD", "PUT", "post"]) {
      const error = canonicalError(publisherInput(undefined, { method }));
      expect(error.code).toBe("method_not_allowed");
      expect(error.allow).toEqual(["POST"]);
    }
    for (const suffix of ["?", "?role=server", "?x=1", "?x=1&x=1"]) {
      expect(canonicalError(publisherInput(
        `/v1/servers/${SERVER_ID}/publish${suffix}`,
      )).code).toBe("unexpected_query");
    }
    expect(canonicalError(publisherInput(
      `/v1/servers/${SERVER_ID}`,
    )).code).toBe("not_found");
    expect(canonicalError(publisherInput(undefined, {
      target: `https://${RENDEZVOUS_AUTHORITY}/v1/servers/${SERVER_ID}/publish`,
    })).code).toBe("not_found");
  });

  it("requires one unencoded JSON publisher body within 4 KiB", () => {
    expect(canonicalError(publisherInput(undefined, {
      hasBody: false,
    })).code).toBe("body_required");
    expect(canonicalError(publisherInput(undefined, {
      headers: new Headers({
        "Content-Length": "0",
        "Content-Type": "application/json",
      }),
    })).code).toBe("body_required");

    for (const contentType of [
      "",
      "application/json; charset=utf-8",
      "Application/Json",
      "text/json",
    ]) {
      const headers = new Headers();
      if (contentType !== "") {
        headers.set("Content-Type", contentType);
      }
      expect(canonicalError(publisherInput(undefined, { headers })).code).toBe(
        "unsupported_media_type",
      );
    }

    expect(classifyCanonicalRoute(publisherInput(undefined, {
      headers: new Headers({
        "Content-Length": String(PUBLISH_MAX_BODY_BYTES),
        "Content-Type": "application/json",
      }),
    })).kind).toBe("publish");
    expect(canonicalError(publisherInput(undefined, {
      headers: new Headers({
        "Content-Length": String(PUBLISH_MAX_BODY_BYTES + 1),
        "Content-Type": "application/json",
      }),
    })).code).toBe("payload_too_large");

    for (const name of ["Content-Encoding", "Transfer-Encoding"]) {
      expect(canonicalError(publisherInput(undefined, {
        headers: new Headers({
          "Content-Type": "application/json",
          [name]: name === "Content-Encoding" ? "gzip" : "chunked",
        }),
      })).code).toBe("unsupported_media_type");
    }
  });

  it("rejects duplicate, comma-joined, malformed, and conflicting headers", () => {
    for (const headers of [
      new Headers([
        ["Content-Type", "application/json"],
        ["Content-Type", "application/json"],
      ]),
      new Headers({
        "Content-Type": "application/json",
        "Content-Length": "1, 1",
      }),
      new Headers({
        "Content-Type": "application/json",
        Signature: "sig1=:AA==:, sig2=:AA==:",
      }),
      new Headers({
        "Content-Type": "application/json",
        Host: `${PUBLISH_AUTHORITY}, ${PUBLISH_AUTHORITY}`,
      }),
    ]) {
      expect(canonicalError(publisherInput(undefined, { headers })).code).toBe(
        "ambiguous_header",
      );
    }

    for (const length of ["-1", "+1", "01", "1.0", "1e3", "words"]) {
      expect(canonicalError(publisherInput(undefined, {
        headers: new Headers({
          "Content-Type": "application/json",
          "Content-Length": length,
        }),
      })).code).toBe("ambiguous_header");
    }

    expect(canonicalError(publisherInput(undefined, {
      headers: new Headers({
        "Content-Type": "application/json",
        Host: RENDEZVOUS_AUTHORITY,
      }),
    })).code).toBe("misdirected_request");
    expect(canonicalError(publisherInput(undefined, {
      headers: new Headers({
        "Content-Type": "application/json",
        Upgrade: "websocket",
      }),
    })).code).toBe("bad_request");
  });

  it("keeps rendezvous method and query grammar exact", () => {
    for (const method of ["POST", "HEAD", "PUT", "get"]) {
      const error = canonicalError(rendezvousInput(undefined, { method }));
      expect(error.code).toBe("method_not_allowed");
      expect(error.allow).toEqual(["GET"]);
    }
    for (const query of [
      "",
      "role=CLIENT",
      "role=client&role=client",
      "role=client&extra=1",
      "extra=1&role=client",
      "role=%63lient",
      "role=client+",
      "role",
    ]) {
      expect(canonicalError(rendezvousInput(
        `/v1/servers/${SERVER_ID}?${query}`,
      )).code).toBe("unexpected_query");
    }
    expect(canonicalError(rendezvousInput(
      `/v1/servers/${SERVER_ID}`,
    )).code).toBe("unexpected_query");
  });

  it("requires a bodyless, unambiguous WebSocket upgrade", () => {
    expect(canonicalError(rendezvousInput(undefined, {
      headers: new Headers(),
    })).code).toBe("upgrade_required");
    expect(canonicalError(rendezvousInput(undefined, {
      headers: new Headers({ Upgrade: "websocket, h2c" }),
    })).code).toBe("ambiguous_header");

    for (const headers of [
      new Headers({ Upgrade: "h2c" }),
      new Headers({ Upgrade: "websocket", Connection: "close" }),
      new Headers({
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "12",
      }),
      new Headers({
        Upgrade: "websocket",
        "Sec-WebSocket-Key": "not-a-websocket-key",
      }),
    ]) {
      expect(canonicalError(rendezvousInput(undefined, { headers })).code).toBe(
        "upgrade_required",
      );
    }

    expect(canonicalError(rendezvousInput(undefined, {
      hasBody: true,
    })).code).toBe("unexpected_body");
    for (const [name, value] of [
      ["Content-Length", "0"],
      ["Content-Length", "1"],
      ["Content-Length", "words"],
      ["Content-Type", "application/json"],
      ["Content-Encoding", "identity"],
      ["Transfer-Encoding", "chunked"],
    ] as const) {
      expect(canonicalError(rendezvousInput(undefined, {
        headers: new Headers({
          Upgrade: "websocket",
          [name]: value,
        }),
      })).code).toBe("unexpected_body");
    }
  });

  it("rejects every unsupported WebSocket subprotocol", () => {
    expect(canonicalError(rendezvousInput(undefined, {
      headers: new Headers({
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": CLASSIC_RENDEZVOUS_INVITE_SUBPROTOCOL,
      }),
    })).code).toBe("bad_request");
    expect(canonicalError(rendezvousInput(undefined, {
      headers: new Headers({
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": "atrinik-rendezvous",
      }),
    })).code).toBe("bad_request");
    expect(canonicalError(rendezvousInput(undefined, {
      headers: new Headers({
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": "atrinik-rendezvous, other",
      }),
    })).code).toBe("ambiguous_header");
  });
  it("rejects retired public paths on every canonical authority", () => {
    for (const authority of [PUBLISH_AUTHORITY, RENDEZVOUS_AUTHORITY]) {
      for (const path of [
        "/", "/v2/servers", "/index.wsgi/otp", "/index.wsgi/update",
        `/v2/rendezvous/${SERVER_ID}?role=client`,
      ]) {
        const error = canonicalError({
          target: `https://${authority}${path}`,
          method: "GET",
          headers: new Headers(),
          hasBody: false,
        });
        expect(error.code).toBe("not_found");
      }
    }
  });
});
