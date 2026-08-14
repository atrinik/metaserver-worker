import { describe, expect, it, vi } from "vitest";

import publisherWorker from "../src/publisher-worker";
import rendezvousWorker from "../src/rendezvous-worker";
import {
  INTERNAL_PAIR_TAG_HEADER,
  INTERNAL_PAIR_TAG_PREVIOUS_HEADER,
  INTERNAL_SOURCE_TAG_HEADER,
  INTERNAL_SOURCE_TAG_PREVIOUS_HEADER,
} from "../src/internal-service";
import { CLASSIC_RENDEZVOUS_INVITE_SUBPROTOCOL } from "../src/routes";

const CURRENT_SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const PREVIOUS_SECRET = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
const SERVER_ID = "4".repeat(64);
const SAFE_DYNAMIC_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

function publisherSuccess(): Response {
  return Response.json({
    status: "ok",
    rendezvousToken: "a".repeat(64),
  }, { headers: SAFE_DYNAMIC_HEADERS });
}

function invalidRendezvousToken(): Response {
  return new Response("Invalid rendezvous token\n", {
    status: 401,
    headers: {
      ...SAFE_DYNAMIC_HEADERS,
      "Content-Type": "text/plain; charset=utf-8",
      "WWW-Authenticate": "Bearer",
    },
  });
}

function publisherEnvironment(
  fetch: (request: Request) => Promise<Response>,
  limit = vi.fn(async () => ({ success: true })),
): { readonly env: PublisherEnv; readonly limit: typeof limit } {
  const base = {
    COORDINATOR: {
      fetch,
      deploymentHealth: async () => "publisher",
    } as PublisherEnv["COORDINATOR"],
    GLOBAL_RATE_LIMITER: { limit } as RateLimit,
    PUBLISH_HOSTNAME: "publish.meta.atrinik.org",
    PUBLISH_ENABLED: "disabled",
    GAME_PUBLISH_ENABLED: "disabled",
    ROUTE_DISABLED_RETRY_SECONDS: "300",
    SOURCE_TAG_KEY_CURRENT_ID: "2026-08-a",
    SOURCE_TAG_KEY_PREVIOUS_ID: "2026-07-a",
    SOURCE_TAG_KEY_CURRENT: CURRENT_SECRET,
    SOURCE_TAG_KEY_PREVIOUS: PREVIOUS_SECRET,
  } satisfies PublisherEnv;
  return {
    env: override(base, {
      PUBLISH_ENABLED: "enabled",
      GAME_PUBLISH_ENABLED: "enabled",
    }),
    limit,
  };
}

function rendezvousEnvironment(
  fetch: (request: Request) => Promise<Response>,
  globalLimit = vi.fn(async () => ({ success: true })),
  clientLimit = vi.fn(async () => ({ success: true })),
): {
  readonly env: RendezvousEnv;
  readonly globalLimit: typeof globalLimit;
  readonly clientLimit: typeof clientLimit;
} {
  const base = {
    COORDINATOR: {
      fetch,
      deploymentHealth: async () => "rendezvous",
    } as RendezvousEnv["COORDINATOR"],
    GLOBAL_RATE_LIMITER: { limit: globalLimit } as RateLimit,
    RENDEZVOUS_CLIENT_RATE_LIMITER: { limit: clientLimit } as RateLimit,
    RENDEZVOUS_HOSTNAME: "rendezvous.meta.atrinik.org",
    RENDEZVOUS_ENABLED: "disabled",
    ROUTE_DISABLED_RETRY_SECONDS: "300",
    SOURCE_TAG_KEY_CURRENT_ID: "2026-08-a",
    SOURCE_TAG_KEY_PREVIOUS_ID: "2026-07-a",
    SOURCE_TAG_KEY_CURRENT: CURRENT_SECRET,
    SOURCE_TAG_KEY_PREVIOUS: PREVIOUS_SECRET,
  } satisfies RendezvousEnv;
  return {
    env: override(base, { RENDEZVOUS_ENABLED: "enabled" }),
    globalLimit,
    clientLimit,
  };
}

function override<T extends object>(
  target: T,
  values: Partial<Record<keyof T, unknown>>,
): T {
  return new Proxy(target, {
    get(original, property, receiver) {
      if (Object.prototype.hasOwnProperty.call(values, property)) {
        return Reflect.get(values, property);
      }
      return Reflect.get(original, property, receiver);
    },
  });
}

function publisherRequest(
  headers: HeadersInit = {},
  authority = "publish.meta.atrinik.org",
): Request {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("CF-Connecting-IP", "192.0.2.40");
  requestHeaders.set("Content-Type", "application/json");
  requestHeaders.set("Cookie", "publisher-private=value");
  return new Request(
    `https://${authority}/v1/classic/servers/${SERVER_ID}/publish`,
    { method: "POST", headers: requestHeaders, body: "{}" },
  );
}

function gamePublisherRequest(): Request {
  const headers = new Headers({
    "CF-Connecting-IP": "192.0.2.42",
    "Content-Type": "application/json",
  });
  return new Request(
    `https://publish.meta.atrinik.org/v1/servers/${SERVER_ID}/publish`,
    { method: "POST", headers, body: "{}" },
  );
}

function rendezvousRequest(
  role: "client" | "server",
  headers: HeadersInit = {},
  authority = "rendezvous.meta.atrinik.org",
): Request {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("CF-Connecting-IP", "192.0.2.41");
  requestHeaders.set("Cookie", "rendezvous-private=value");
  requestHeaders.set("Upgrade", "websocket");
  return new Request(
    `https://${authority}/v1/classic/servers/${SERVER_ID}?role=${role}`,
    { headers: requestHeaders },
  );
}

describe("publisher edge Worker", () => {
  it("proves its core Service Binding while the public circuit is disabled", async () => {
    const fetch = vi.fn(async () => publisherSuccess());
    const configured = publisherEnvironment(fetch);
    const response = await publisherWorker.fetch(
      new Request(
        "https://publish.meta.atrinik.org/.well-known/atrinik-deployment-health",
      ),
      override(configured.env, { PUBLISH_ENABLED: "disabled" }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(fetch).not.toHaveBeenCalled();
    expect(configured.limit).not.toHaveBeenCalled();
  });

  it("accepts only its configured isolated canary authority", async () => {
    const configured = publisherEnvironment(async () => publisherSuccess());
    const canary = override(configured.env, {
      PUBLISH_HOSTNAME: "publish-canary.example.test",
    });
    expect((await publisherWorker.fetch(publisherRequest(
      {},
      "publish-canary.example.test",
    ), canary)).status).toBe(200);
    expect((await publisherWorker.fetch(publisherRequest(), canary)).status)
      .toBe(421);
  });

  it("fails closed before admission while its circuit is disabled", async () => {
    const fetch = vi.fn(async () => Response.json({}, {
      headers: SAFE_DYNAMIC_HEADERS,
    }));
    const configured = publisherEnvironment(fetch);
    const disabled = override(configured.env, { PUBLISH_ENABLED: "disabled" });
    const response = await publisherWorker.fetch(publisherRequest(), disabled);
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("300");
    expect(fetch).not.toHaveBeenCalled();
    expect(configured.limit).not.toHaveBeenCalled();
  });

  it("admits the exact route and forwards no request-source or browser state", async () => {
    let forwarded: Request | undefined;
    const fetch = vi.fn(async (request: Request) => {
      forwarded = request;
      return publisherSuccess();
    });
    const configured = publisherEnvironment(fetch);
    const response = await publisherWorker.fetch(
      publisherRequest(),
      configured.env,
    );
    expect(response.status).toBe(200);
    expect(configured.limit).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(forwarded).toBeDefined();
    expect(forwarded?.headers.has("CF-Connecting-IP")).toBe(false);
    expect(forwarded?.headers.has("Cookie")).toBe(false);
    expect(forwarded?.cf).toBeUndefined();
    expect(await forwarded?.text()).toBe("{}");
  });

  it("never dispatches cross-service or spoofed internal requests", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetch = vi.fn(async () => Response.json({}, {
      headers: SAFE_DYNAMIC_HEADERS,
    }));
    const configured = publisherEnvironment(fetch);
    const crossService = await publisherWorker.fetch(rendezvousRequest("client"), configured.env);
    expect(crossService.status).toBe(421);

    const spoofed = await publisherWorker.fetch(publisherRequest({
      [INTERNAL_SOURCE_TAG_HEADER]: `v1.current.${"a".repeat(43)}`,
    }), configured.env);
    expect(spoofed.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
    expect(configured.limit).not.toHaveBeenCalled();
  });

  it("gates Game publication with an independent circuit breaker", async () => {
    const fetch = vi.fn(async () => publisherSuccess());
    const configured = publisherEnvironment(fetch);
    const disabled = override(configured.env, {
      GAME_PUBLISH_ENABLED: "disabled",
    });
    const response = await publisherWorker.fetch(gamePublisherRequest(), disabled);
    expect(response.status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
    expect(configured.limit).not.toHaveBeenCalled();

    expect((await publisherWorker.fetch(
      gamePublisherRequest(),
      configured.env,
    )).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(configured.limit).toHaveBeenCalledTimes(2);
  });

  it("turns an unsafe coordinator response into a fixed error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const configured = publisherEnvironment(async () => new Response(null, {
      status: 302,
      headers: {
        "Cache-Control": "no-store",
        Location: "https://example.net/token",
      },
    }));
    const response = await publisherWorker.fetch(publisherRequest(), configured.env);
    expect(response.status).toBe(500);
    expect(response.headers.has("Location")).toBe(false);
    expect(await response.text()).not.toContain("example.net");
  });
});

describe("rendezvous edge Worker", () => {
  it("proves its core Service Binding while the public circuit is disabled", async () => {
    const fetch = vi.fn(async () => invalidRendezvousToken());
    const configured = rendezvousEnvironment(fetch);
    const response = await rendezvousWorker.fetch(
      new Request(
        "https://rendezvous.meta.atrinik.org/.well-known/atrinik-deployment-health",
      ),
      override(configured.env, { RENDEZVOUS_ENABLED: "disabled" }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(fetch).not.toHaveBeenCalled();
    expect(configured.globalLimit).not.toHaveBeenCalled();
    expect(configured.clientLimit).not.toHaveBeenCalled();
  });

  it("accepts only its configured isolated canary authority", async () => {
    const configured = rendezvousEnvironment(async () =>
      invalidRendezvousToken());
    const canary = override(configured.env, {
      RENDEZVOUS_HOSTNAME: "rendezvous-canary.example.test",
    });
    expect((await rendezvousWorker.fetch(rendezvousRequest(
      "server",
      { Authorization: `Bearer ${"a".repeat(64)}` },
      "rendezvous-canary.example.test",
    ), canary)).status).toBe(401);
    expect((await rendezvousWorker.fetch(rendezvousRequest(
      "server",
      { Authorization: `Bearer ${"a".repeat(64)}` },
    ), canary)).status).toBe(421);
  });

  it("forwards a client upgrade with opaque aliases and no raw source", async () => {
    let forwarded: Request | undefined;
    const pair = new WebSocketPair();
    const configured = rendezvousEnvironment(async (request) => {
      forwarded = request;
      return new Response(null, {
        status: 101,
        headers: SAFE_DYNAMIC_HEADERS,
        webSocket: pair[0],
      });
    });
    const response = await rendezvousWorker.fetch(
      rendezvousRequest("client"),
      configured.env,
    );
    expect(response.status).toBe(101);
    expect(response.webSocket).not.toBeNull();
    expect(configured.globalLimit).not.toHaveBeenCalled();
    expect(configured.clientLimit).toHaveBeenCalledTimes(2);
    expect(forwarded?.headers.has("CF-Connecting-IP")).toBe(false);
    expect(forwarded?.headers.has("Cookie")).toBe(false);
    expect(forwarded?.cf).toBeUndefined();
    expect(forwarded?.headers.has(INTERNAL_SOURCE_TAG_HEADER)).toBe(false);
    expect(forwarded?.headers.has(INTERNAL_SOURCE_TAG_PREVIOUS_HEADER)).toBe(false);
    for (const header of [
      INTERNAL_PAIR_TAG_HEADER,
      INTERNAL_PAIR_TAG_PREVIOUS_HEADER,
    ]) {
      expect(forwarded?.headers.get(header)).toMatch(
        /^v1\.(2026-08-a|2026-07-a)\.[A-Za-z0-9_-]{43}$/,
      );
    }
    pair[1].accept();
    pair[1].close(1000, "Test complete");
  });

  it("keeps server admission independent of the client limiter and pair tags", async () => {
    let forwarded: Request | undefined;
    const configured = rendezvousEnvironment(async (request) => {
      forwarded = request;
      return invalidRendezvousToken();
    });
    const response = await rendezvousWorker.fetch(
      rendezvousRequest("server", { Authorization: `Bearer ${"a".repeat(64)}` }),
      configured.env,
    );
    expect(response.status).toBe(401);
    expect(configured.globalLimit).toHaveBeenCalledTimes(2);
    expect(configured.clientLimit).not.toHaveBeenCalled();
    expect(forwarded?.headers.has(INTERNAL_PAIR_TAG_HEADER)).toBe(false);
    expect(forwarded?.headers.has(INTERNAL_PAIR_TAG_PREVIOUS_HEADER)).toBe(false);
  });

  it("requires an exact echoed subprotocol on a successful upgrade", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const pair = new WebSocketPair();
    const configured = rendezvousEnvironment(async () => new Response(null, {
      status: 101,
      headers: SAFE_DYNAMIC_HEADERS,
      webSocket: pair[0],
    }));
    const response = await rendezvousWorker.fetch(rendezvousRequest("client", {
      "Sec-WebSocket-Protocol": CLASSIC_RENDEZVOUS_INVITE_SUBPROTOCOL,
    }), configured.env);
    expect(response.status).toBe(500);
  });

  it("never dispatches publisher paths or spoofed aliases", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetch = vi.fn(async () => new Response("denied", {
      status: 403,
      headers: SAFE_DYNAMIC_HEADERS,
    }));
    const configured = rendezvousEnvironment(fetch);
    expect((await rendezvousWorker.fetch(publisherRequest(), configured.env)).status).toBe(421);
    expect((await rendezvousWorker.fetch(rendezvousRequest("client", {
      [INTERNAL_SOURCE_TAG_HEADER]: `v1.current.${"a".repeat(43)}`,
    }), configured.env)).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
    expect(configured.globalLimit).not.toHaveBeenCalled();
    expect(configured.clientLimit).not.toHaveBeenCalled();
  });

  it("keeps the reserved game rendezvous disabled before any admission work", async () => {
    const fetch = vi.fn(async () => new Response("denied", {
      status: 403,
      headers: SAFE_DYNAMIC_HEADERS,
    }));
    const configured = rendezvousEnvironment(fetch);
    const response = await rendezvousWorker.fetch(new Request(
      `https://rendezvous.meta.atrinik.org/v1/servers/${SERVER_ID}?role=client`,
      {
        headers: {
          "CF-Connecting-IP": "192.0.2.43",
          Upgrade: "websocket",
        },
      },
    ), configured.env);
    expect(response.status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
    expect(configured.globalLimit).not.toHaveBeenCalled();
    expect(configured.clientLimit).not.toHaveBeenCalled();
  });
});
