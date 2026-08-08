import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

function room(name: string): DurableObjectStub {
  return env.RENDEZVOUS.get(env.RENDEZVOUS.idFromName(name));
}

function roomRequest(role?: string): Request {
  const headers = new Headers({ Upgrade: "websocket" });
  if (role !== undefined) {
    headers.set("X-Atrinik-Role", role);
  }
  return new Request("https://rendezvous.internal/", { headers });
}

async function expectFixedError(
  response: Response,
  status: number,
  body: string,
): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("Content-Type")).toBe(
    "text/plain; charset=utf-8",
  );
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(response.headers.has("Location")).toBe(false);
  expect(await response.text()).toBe(body);
}

describe("RendezvousRoom HTTP boundary", () => {
  it("rejects every internal request outside the exact upgrade contract", async () => {
    const stub = room("invalid-upgrade-contract");
    const invalid = [
      new Request("https://rendezvous.internal/", {
        method: "POST",
        headers: {
          "X-Atrinik-Role": "client",
        },
      }),
      new Request("https://rendezvous.internal/", {
        headers: { "X-Atrinik-Role": "client" },
      }),
      new Request("https://rendezvous.internal/", {
        headers: {
          Upgrade: "h2c",
          "X-Atrinik-Role": "client",
        },
      }),
      new Request("https://rendezvous.internal/", {
        method: "POST",
        headers: {
          Upgrade: "websocket",
          "Content-Type": "text/plain",
          "X-Atrinik-Role": "client",
        },
        body: "candidate",
      }),
      new Request("https://rendezvous.internal/", {
        headers: {
          Upgrade: "websocket",
          "Content-Type": "application/json",
          "X-Atrinik-Role": "client",
        },
      }),
    ];

    for (const [index, request] of invalid.entries()) {
      const response = await stub.fetch(request);
      if (response.status === 101 && response.webSocket !== null) {
        response.webSocket.accept();
        response.webSocket.close(1000, "Test cleanup");
      }
      expect(response.status, `invalid request fixture ${index}`).toBe(403);
      await expectFixedError(
        response,
        403,
        "Forbidden\n",
      );
    }
  });

  it("returns one fixed non-cacheable response for every invalid internal role", async () => {
    const stub = room("invalid-role-response-contract");
    for (const role of [
      undefined,
      "",
      "CLIENT",
      "client,server",
      "attacker-controlled-role",
    ]) {
      await expectFixedError(
        await stub.fetch(roomRequest(role)),
        403,
        "Forbidden\n",
      );
    }
  });

  it("returns a fixed non-cacheable response at the absolute client-room limit", async () => {
    const stub = room("full-room-response-contract");
    const sockets: WebSocket[] = [];
    try {
      for (let index = 0; index < 64; index += 1) {
        const response = await stub.fetch(roomRequest("client"));
        expect(response.status).toBe(101);
        const socket = response.webSocket;
        if (socket === null) {
          throw new Error("Rendezvous room returned no client WebSocket");
        }
        socket.accept();
        sockets.push(socket);
      }

      await expectFixedError(
        await stub.fetch(roomRequest("client")),
        503,
        "Rendezvous room is full\n",
      );
    } finally {
      for (const socket of sockets) {
        socket.close(1000, "Test cleanup");
      }
    }
  });

  it("closes a socket cleanly when signaling JSON is null", async () => {
    const response = await room("null-signaling-json").fetch(
      roomRequest("client"),
    );
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (socket === null) {
      throw new Error("Rendezvous room returned no client WebSocket");
    }
    socket.accept();
    const closed = new Promise<CloseEvent>((resolve) => {
      socket.addEventListener("close", resolve, { once: true });
    });
    socket.send("null");

    await expect(closed).resolves.toMatchObject({
      code: 1008,
      reason: "Invalid signaling JSON",
    });
  });

  it("lets the runtime complete an abnormal hibernatable socket teardown", async () => {
    const stub = room("abnormal-socket-teardown");
    const response = await stub.fetch(roomRequest("client"));
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (socket === null) {
      throw new Error("Rendezvous room returned no client WebSocket");
    }
    socket.accept();
    const closed = new Promise<CloseEvent>((resolve) => {
      socket.addEventListener("close", resolve, { once: true });
    });

    await evictDurableObject(stub, { webSockets: "close" });
    await expect(closed).resolves.toBeInstanceOf(CloseEvent);
  });
});
