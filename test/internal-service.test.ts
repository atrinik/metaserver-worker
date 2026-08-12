import { describe, expect, it, vi } from "vitest";

import {
  actorAliases,
  consumePublisherCoordinatorRequest,
  consumeRendezvousAdmissionAliases,
  INTERNAL_PAIR_TAG_HEADER,
  INTERNAL_PAIR_TAG_PREVIOUS_HEADER,
  INTERNAL_SOURCE_TAG_HEADER,
  INTERNAL_SOURCE_TAG_PREVIOUS_HEADER,
  publisherServiceRequest,
  rendezvousServiceRequest,
  validatePublisherServiceResponse,
  validateRendezvousServiceResponse,
} from "../src/internal-service";

const CURRENT = `v1.current.${"a".repeat(43)}`;
const PREVIOUS = `v1.previous.${"b".repeat(43)}`;
const PAIR_CURRENT = `v1.current.${"c".repeat(43)}`;
const PAIR_PREVIOUS = `v1.previous.${"d".repeat(43)}`;
const SAFE_DYNAMIC_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

describe("internal service boundary", () => {
  it("requires two distinct canonical source-tag aliases", () => {
    expect(actorAliases([CURRENT, PREVIOUS])).toEqual([CURRENT, PREVIOUS]);
    for (const invalid of [
      [],
      [CURRENT],
      [CURRENT, CURRENT],
      [CURRENT, PREVIOUS, PAIR_CURRENT],
      ["192.0.2.1", PREVIOUS],
    ]) {
      expect(() => actorAliases(invalid)).toThrow(
        "Source-tag key ring produced an invalid alias set",
      );
    }
  });

  it("forwards only the signed publisher header contract", async () => {
    const request = new Request(
      `https://publish.meta.atrinik.org/v1/classic/servers/${"1".repeat(64)}/publish`,
      {
        method: "POST",
        headers: {
          "Atrinik-Publish-Sequence": "1",
          "Atrinik-Server-ID": "1".repeat(64),
          "CF-Connecting-IP": "192.0.2.10",
          Cookie: "private=value",
          "Content-Digest": "sha-256=:AAAA:",
          "Content-Type": "application/json",
          Host: "publish.meta.atrinik.org",
          Signature: "sig1=:AAAA:",
          "Signature-Input": "sig1=()",
        },
        body: "{}",
      },
    );
    const forwarded = publisherServiceRequest(request);
    expect(forwarded.redirect).toBe("manual");
    expect(await forwarded.text()).toBe("{}");
    expect(forwarded.headers.get("Atrinik-Publish-Sequence")).toBe("1");
    expect(forwarded.headers.has("CF-Connecting-IP")).toBe(false);
    expect(forwarded.headers.has("Cookie")).toBe(false);
  });

  it("rejects spoofed internal headers before forwarding", () => {
    const request = new Request(
      `https://publish.meta.atrinik.org/v1/classic/servers/${"1".repeat(64)}/publish`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [INTERNAL_SOURCE_TAG_HEADER]: CURRENT,
        },
        body: "{}",
      },
    );
    expect(() => publisherServiceRequest(request)).toThrow(
      "The request is invalid.",
    );
  });

  it("rejects any request header outside the coordinator envelopes", () => {
    expect(() => consumePublisherCoordinatorRequest(new Request(
      `https://publish.meta.atrinik.org/v1/classic/servers/${"1".repeat(64)}/publish`,
      { headers: { "CF-Connecting-IP": "192.0.2.10" } },
    ))).toThrow("The request is invalid.");

    expect(() => rendezvousServiceRequest(new Request(
      `https://rendezvous.meta.atrinik.org/v1/classic/servers/${"2".repeat(64)}?role=client`,
      { headers: { Authorization: "must-not-cross" } },
    ), "client", {
      source: [CURRENT, PREVIOUS],
      pair: [PAIR_CURRENT, PAIR_PREVIOUS],
    })).toThrow("The request is invalid.");
  });

  it("consumes only Workerd's exact internal chunked-body marker", async () => {
    const url =
      `https://publish.meta.atrinik.org/v1/classic/servers/${"1".repeat(64)}/publish`;
    const request = new Request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Transfer-Encoding": "chunked",
      },
      body: "{}",
    });
    const consumed = consumePublisherCoordinatorRequest(request);
    expect(consumed.headers.has("Transfer-Encoding")).toBe(false);
    expect(await consumed.text()).toBe("{}");

    expect(() => consumePublisherCoordinatorRequest(new Request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Transfer-Encoding": "gzip",
      },
      body: "{}",
    }))).toThrow("The request is invalid.");
  });

  it("consumes the client alias envelope and strips it from the request", () => {
    const request = rendezvousServiceRequest(new Request(
      `https://rendezvous.meta.atrinik.org/v1/classic/servers/${"2".repeat(64)}?role=client`,
      {
        headers: {
          "CF-Connecting-IP": "192.0.2.20",
          Cookie: "private=value",
          Upgrade: "websocket",
        },
      },
    ), "client", {
      source: [CURRENT, PREVIOUS],
      pair: [PAIR_CURRENT, PAIR_PREVIOUS],
    });

    expect(request.headers.has("CF-Connecting-IP")).toBe(false);
    expect(request.headers.has("Cookie")).toBe(false);
    const consumed = consumeRendezvousAdmissionAliases(request, "client");
    expect(consumed.aliases).toEqual({
      source: [CURRENT, PREVIOUS],
      pair: [PAIR_CURRENT, PAIR_PREVIOUS],
    });
    for (const header of [
      INTERNAL_SOURCE_TAG_HEADER,
      INTERNAL_SOURCE_TAG_PREVIOUS_HEADER,
      INTERNAL_PAIR_TAG_HEADER,
      INTERNAL_PAIR_TAG_PREVIOUS_HEADER,
    ]) {
      expect(consumed.request.headers.has(header)).toBe(false);
    }
    expect(consumed.request.headers.get("Upgrade")).toBe("websocket");
  });

  it("rejects missing, malformed, or role-incoherent alias envelopes", () => {
    const serverUrl =
      `https://rendezvous.meta.atrinik.org/v1/classic/servers/${"3".repeat(64)}?role=server`;
    expect(() => consumeRendezvousAdmissionAliases(
      new Request(serverUrl),
      "server",
    )).toThrow("The request is invalid.");

    const headers = new Headers({
      [INTERNAL_SOURCE_TAG_HEADER]: CURRENT,
      [INTERNAL_SOURCE_TAG_PREVIOUS_HEADER]: PREVIOUS,
      [INTERNAL_PAIR_TAG_HEADER]: PAIR_CURRENT,
      [INTERNAL_PAIR_TAG_PREVIOUS_HEADER]: PAIR_PREVIOUS,
    });
    expect(() => consumeRendezvousAdmissionAliases(
      new Request(serverUrl, { headers }),
      "server",
    )).toThrow("The request is invalid.");
  });

  it("accepts only a bounded canonical publisher response", async () => {
    const token = "a".repeat(64);
    const safe = Response.json({ status: "ok", rendezvousToken: token }, {
      headers: SAFE_DYNAMIC_HEADERS,
    });
    const validated = await validatePublisherServiceResponse(safe);
    expect(validated).not.toBe(safe);
    expect(await validated.json()).toEqual({
      status: "ok",
      rendezvousToken: token,
    });

    const body = JSON.stringify({ status: "ok", rendezvousToken: token });
    const withRuntimeLength = await validatePublisherServiceResponse(
      new Response(body, {
        headers: {
          ...SAFE_DYNAMIC_HEADERS,
          "CF-Worker-Status": "ok",
          "Content-Length": String(new TextEncoder().encode(body).byteLength),
          "Content-Type": "application/json",
        },
      }),
    );
    expect(await withRuntimeLength.text()).toBe(body);
    expect(withRuntimeLength.headers.has("CF-Worker-Status")).toBe(false);

    const badRequestBody = JSON.stringify({
      error: { code: "bad_request", message: "The request is invalid." },
    });
    const withRuntimeErrorLength = await validatePublisherServiceResponse(
      new Response(badRequestBody, {
        status: 400,
        headers: {
          ...SAFE_DYNAMIC_HEADERS,
          "CF-Worker-Status": "ok",
          "Content-Length": String(
            new TextEncoder().encode(badRequestBody).byteLength,
          ),
          "Content-Type": "application/json; charset=utf-8",
        },
      }),
    );
    expect(withRuntimeErrorLength.status).toBe(400);
    expect(await withRuntimeErrorLength.text()).toBe(badRequestBody);
    expect(withRuntimeErrorLength.headers.has("CF-Worker-Status")).toBe(false);

    const replayBody = JSON.stringify({
      error: { code: "publish_replay", minimumNextSequence: "2" },
    });
    const replay = await validatePublisherServiceResponse(new Response(
      replayBody,
      {
        status: 409,
        headers: {
          ...SAFE_DYNAMIC_HEADERS,
          "CF-Worker-Status": "ok",
          "Content-Type": "application/json",
        },
      },
    ));
    expect(replay.status).toBe(409);
    expect(await replay.text()).toBe(replayBody);
    expect(replay.headers.has("CF-Worker-Status")).toBe(false);

    for (const response of [
      new Response(null, { status: 302, headers: {
        "Cache-Control": "no-store",
        Location: "https://example.net/",
      } }),
      new Response("cached", { headers: { "Cache-Control": "public" } }),
      new Response("location", { headers: {
        "Cache-Control": "no-store",
        Location: "https://example.net/",
      } }),
      Response.json({ status: "ok", rendezvousToken: token }, { headers: {
        ...SAFE_DYNAMIC_HEADERS,
        "Set-Cookie": "token=must-not-cross",
      } }),
      Response.json({ status: "ok", rendezvousToken: token }, { headers: {
        ...SAFE_DYNAMIC_HEADERS,
        Allow: "DELETE",
      } }),
      new Response(body, { headers: {
        ...SAFE_DYNAMIC_HEADERS,
        "Content-Length": String(
          new TextEncoder().encode(body).byteLength + 1,
        ),
        "Content-Type": "application/json",
      } }),
      new Response(body, { headers: {
        ...SAFE_DYNAMIC_HEADERS,
        "Content-Length": `0${new TextEncoder().encode(body).byteLength}`,
        "Content-Type": "application/json",
      } }),
      new Response(body, { headers: {
        ...SAFE_DYNAMIC_HEADERS,
        "Content-Length": String(new TextEncoder().encode(body).byteLength),
        "Content-Type": "application/json",
        "X-Unexpected": "value",
      } }),
      ...["exception", "healthy", "ok, ok"].map((workerStatus) =>
        new Response(body, { headers: {
          ...SAFE_DYNAMIC_HEADERS,
          "CF-Worker-Status": workerStatus,
          "Content-Type": "application/json",
        } })
      ),
      new Response("x".repeat(2_049), {
        status: 500,
        headers: SAFE_DYNAMIC_HEADERS,
      }),
      Response.json({
        error: {
          code: "method_not_allowed",
          message: "The request method is not allowed.",
        },
      }, {
        status: 405,
        headers: {
          ...SAFE_DYNAMIC_HEADERS,
          Allow: "DELETE",
        },
      }),
      new Response(JSON.stringify({
        error: {
          code: "publish_replay",
          minimumNextSequence: "18446744073709551616",
        },
      }), {
        status: 409,
        headers: {
          ...SAFE_DYNAMIC_HEADERS,
          "Content-Type": "application/json; charset=utf-8",
        },
      }),
    ]) {
      await expect(validatePublisherServiceResponse(response)).rejects.toThrow(
        "Dynamic service returned an unsafe response",
      );
    }
  });

  it("validates the complete rendezvous upgrade envelope", async () => {
    const pair = new WebSocketPair();
    const safe = new Response(null, {
      status: 101,
      headers: {
        ...SAFE_DYNAMIC_HEADERS,
        "CF-Worker-Status": "ok",
      },
      webSocket: pair[0],
    });
    const validated = await validateRendezvousServiceResponse(safe, null);
    expect(validated).not.toBe(safe);
    expect(validated.webSocket).toBe(pair[0]);
    expect(validated.headers.has("CF-Worker-Status")).toBe(false);
    pair[1].accept();
    pair[1].close(1000, "Test complete");

    const badStatusPair = new WebSocketPair();
    await expect(validateRendezvousServiceResponse(new Response(null, {
      status: 101,
      headers: {
        ...SAFE_DYNAMIC_HEADERS,
        "CF-Worker-Status": "exception",
      },
      webSocket: badStatusPair[0],
    }), null)).rejects.toThrow("Dynamic service returned an unsafe response");
    badStatusPair[1].accept();
    badStatusPair[1].close(1000, "Test complete");

    const lengthPair = new WebSocketPair();
    await expect(validateRendezvousServiceResponse(new Response(null, {
      status: 101,
      headers: {
        ...SAFE_DYNAMIC_HEADERS,
        "Content-Length": "0",
      },
      webSocket: lengthPair[0],
    }), null)).rejects.toThrow("Dynamic service returned an unsafe response");
    lengthPair[1].accept();
    lengthPair[1].close(1000, "Test complete");

    const wrongProtocolPair = new WebSocketPair();
    const wrongProtocol = new Response(null, {
      status: 101,
      headers: {
        "Cache-Control": "no-store",
        "Sec-WebSocket-Protocol": "wrong",
      },
      webSocket: wrongProtocolPair[0],
    });
    await expect(validateRendezvousServiceResponse(
      wrongProtocol,
      "atrinik-classic-rendezvous-invite-v1",
    )).rejects.toThrow("Dynamic service returned an unsafe response");

    await expect(validateRendezvousServiceResponse(
      new Response("cached", { status: 403, headers: {
        "Cache-Control": "public",
      } }),
      null,
    )).rejects.toThrow("Dynamic service returned an unsafe response");

    await expect(validateRendezvousServiceResponse(
      Response.json({ status: "not-an-upgrade" }, {
        headers: SAFE_DYNAMIC_HEADERS,
      }),
      null,
    )).rejects.toThrow("Dynamic service returned an unsafe response");

    await expect(validateRendezvousServiceResponse(
      new Response("WebSocket upgrade required\n", {
        status: 426,
        headers: {
          ...SAFE_DYNAMIC_HEADERS,
          "Content-Type": "text/plain; charset=utf-8",
          Upgrade: "h2c",
        },
      }),
      null,
    )).rejects.toThrow("Dynamic service returned an unsafe response");
  });

  it.each([
    ["Rendezvous server unavailable\n", "5"],
    ["Rendezvous room is full\n", "15"],
    ["Rendezvous room unavailable\n", "60"],
  ])("preserves the fixed room admission error %s", async (body, retryAfter) => {
    const response = await validateRendezvousServiceResponse(new Response(
      body,
      {
        status: 503,
        headers: {
          ...SAFE_DYNAMIC_HEADERS,
          "Content-Type": "text/plain; charset=utf-8",
          "Retry-After": retryAfter,
        },
      },
    ), null);
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe(retryAfter);
    expect(await response.text()).toBe(body);
  });

  it("accepts only the exact runtime length on fixed rendezvous errors", async () => {
    const body = "Rendezvous room unavailable\n";
    const headers = {
      ...SAFE_DYNAMIC_HEADERS,
      "CF-Worker-Status": "ok",
      "Content-Length": String(new TextEncoder().encode(body).byteLength),
      "Content-Type": "text/plain; charset=utf-8",
      "Retry-After": "60",
    };
    const accepted = await validateRendezvousServiceResponse(
      new Response(body, { status: 503, headers }),
      null,
    );
    expect(accepted.status).toBe(503);
    expect(await accepted.text()).toBe(body);
    expect(accepted.headers.has("CF-Worker-Status")).toBe(false);

    await expect(validateRendezvousServiceResponse(
      new Response(body, {
        status: 503,
        headers: { ...headers, "Content-Length": "0" },
      }),
      null,
    )).rejects.toThrow("Dynamic service returned an unsafe response");
  });

  it("bounds a coordinator response that never finishes", async () => {
    vi.useFakeTimers();
    try {
      const response = new Response(new ReadableStream({
        start() {
          // Deliberately leave the response stream open and silent.
        },
      }), {
        status: 500,
        headers: SAFE_DYNAMIC_HEADERS,
      });
      const assertion = expect(
        validatePublisherServiceResponse(response),
      ).rejects.toThrow("Dynamic service returned an unsafe response");
      await vi.advanceTimersByTimeAsync(15_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not wait for a hostile response-stream cancellation", async () => {
    let cancelStarted = false;
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(2_049));
      },
      cancel() {
        cancelStarted = true;
        return new Promise<void>(() => undefined);
      },
    }), {
      status: 500,
      headers: SAFE_DYNAMIC_HEADERS,
    });
    await expect(validatePublisherServiceResponse(response)).rejects.toThrow(
      "Dynamic service returned an unsafe response",
    );
    expect(cancelStarted).toBe(true);
  });
});
