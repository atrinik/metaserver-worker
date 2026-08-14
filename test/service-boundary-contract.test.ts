import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  evictDurableObject,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  handlePublisherCoordinatorRequest,
  handleRendezvousCoordinatorRequest,
} from "../src/index";
import publisherWorker from "../src/publisher-worker";
import rendezvousWorker from "../src/rendezvous-worker";
import { sha256Hex } from "../src/protocol";
import { persistRendezvousPublication } from "../src/rendezvous-publication";
import { CLASSIC_RENDEZVOUS_INVITE_SUBPROTOCOL } from "../src/routes";
import classicV2Fixture from "./fixtures/metaserver-classic-publisher-v2.json";
import publisherFixture from "./fixtures/metaserver-publisher-v1.json";

const CURRENT_SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const PREVIOUS_SECRET = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";

function coreEnvironment(): Env {
  const allowed = { limit: async () => ({ success: true }) } as RateLimit;
  const directoryBuilder = {
    getByName: () => ({ nudge: async () => undefined }),
  } as unknown as Env["DIRECTORY_BUILDER"];
  return override(env, {
    DIRECTORY_BUILDER: directoryBuilder,
    PUBLISH_ENABLED: "enabled",
    GAME_PUBLISH_ENABLED: "enabled",
    RENDEZVOUS_ENABLED: "enabled",
    PUBLISH_IDENTITY_RATE_LIMITER: allowed,
    RENDEZVOUS_SERVER_RATE_LIMITER: allowed,
  });
}

function publisherEnvironment(
  core: Env,
  context: ExecutionContext,
): PublisherEnv {
  const base = {
    COORDINATOR: {
      fetch: (request: Request) =>
        handlePublisherCoordinatorRequest(request, core, context),
    } as PublisherEnv["COORDINATOR"],
    GLOBAL_RATE_LIMITER: {
      limit: async () => ({ success: true }),
    } as RateLimit,
    PUBLISH_HOSTNAME: "publish.meta.atrinik.org",
    PUBLISH_ENABLED: "disabled",
    GAME_PUBLISH_ENABLED: "disabled",
    ROUTE_DISABLED_RETRY_SECONDS: "300",
    SOURCE_TAG_KEY_CURRENT_ID: "2026-08-a",
    SOURCE_TAG_KEY_PREVIOUS_ID: "2026-07-a",
    SOURCE_TAG_KEY_CURRENT: CURRENT_SECRET,
    SOURCE_TAG_KEY_PREVIOUS: PREVIOUS_SECRET,
  } satisfies PublisherEnv;
  return override(base, {
    PUBLISH_ENABLED: "enabled",
    GAME_PUBLISH_ENABLED: "enabled",
  });
}

function rendezvousEnvironment(core: Env): RendezvousEnv {
  const base = {
    COORDINATOR: {
      fetch: (request: Request) =>
        handleRendezvousCoordinatorRequest(request, core),
    } as RendezvousEnv["COORDINATOR"],
    GLOBAL_RATE_LIMITER: {
      limit: async () => ({ success: true }),
    } as RateLimit,
    RENDEZVOUS_CLIENT_RATE_LIMITER: {
      limit: async () => ({ success: true }),
    } as RateLimit,
    RENDEZVOUS_HOSTNAME: "rendezvous.meta.atrinik.org",
    RENDEZVOUS_ENABLED: "disabled",
    ROUTE_DISABLED_RETRY_SECONDS: "300",
    SOURCE_TAG_KEY_CURRENT_ID: "2026-08-a",
    SOURCE_TAG_KEY_PREVIOUS_ID: "2026-07-a",
    SOURCE_TAG_KEY_CURRENT: CURRENT_SECRET,
    SOURCE_TAG_KEY_PREVIOUS: PREVIOUS_SECRET,
  } satisfies RendezvousEnv;
  return override(base, { RENDEZVOUS_ENABLED: "enabled" });
}

function signedPublishRequest(
  authority = publisherFixture.authority,
): Request {
  return new Request(
    `https://${authority}${publisherFixture.path}`,
    {
      method: "POST",
      headers: {
        "Atrinik-Publish-Sequence": publisherFixture.sequence,
        "Atrinik-Server-ID": publisherFixture.server_id,
        "CF-Connecting-IP": "192.0.2.150",
        Cookie: "must-not-cross=value",
        "Content-Digest": publisherFixture.content_digest,
        "Content-Type": publisherFixture.content_type,
        Signature: publisherFixture.signature_header,
        "Signature-Input": publisherFixture.signature_input,
      },
      body: publisherFixture.body,
    },
  );
}

function classicV2SignedPublishRequest(
  vector: (typeof classicV2Fixture.positive)[number],
): Request {
  return new Request(`https://${classicV2Fixture.authority}${vector.path}`, {
    method: "POST",
    headers: {
      "Atrinik-Publish-Sequence": vector.sequence,
      "Atrinik-Server-ID": classicV2Fixture.server_id,
      "CF-Connecting-IP": "192.0.2.152",
      "Content-Digest": vector.content_digest,
      "Content-Type": classicV2Fixture.content_type,
      Signature: vector.signature_header,
      "Signature-Input": vector.signature_input,
    },
    body: vector.body,
  });
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

beforeEach(async () => {
  const stub = env.RENDEZVOUS.getByName(publisherFixture.server_id);
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.deleteAll();
  });
  await evictDurableObject(stub);
  const v2Stub = env.RENDEZVOUS.getByName(classicV2Fixture.server_id);
  await runInDurableObject(v2Stub, async (_instance, state) => {
    await state.storage.deleteAll();
  });
  await evictDurableObject(v2Stub);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM directory_artifact_history"),
    env.DB.prepare("DELETE FROM directory_artifact_commits"),
    env.DB.prepare("DELETE FROM directory_expiry_commits"),
    env.DB.prepare("DELETE FROM directory_outbox"),
    env.DB.prepare("DELETE FROM publisher_nonces"),
    env.DB.prepare("DELETE FROM publisher_replay"),
    env.DB.prepare("DELETE FROM directory_entries"),
    env.DB.prepare("DELETE FROM server_presence"),
    env.DB.prepare("DELETE FROM request_budgets"),
    env.DB.prepare("DELETE FROM rendezvous_pair_attempts"),
    env.DB.prepare("DELETE FROM rendezvous_pair_cooldowns"),
    env.DB.prepare("DELETE FROM classic_identity_modes"),
    env.DB.prepare(
      `UPDATE classic_receiver_mode
          SET mode = 'classic-v1-accepting', activated_at = NULL
        WHERE singleton = 1`,
    ),
    env.DB.prepare(
      "UPDATE directory_revisions SET revision = 0, updated_at = 0",
    ),
  ]);
  vi.spyOn(Date, "now").mockReturnValue(publisherFixture.created * 1_000);
});

describe("in-process service-boundary contract", () => {
  it("selects open and access-code-protected v2 rendezvous without v1 password state", async () => {
    const core = coreEnvironment();
    const edge = rendezvousEnvironment(core);
    const publish = async (name: string) => {
      const vector = classicV2Fixture.positive.find((item) => item.name === name);
      if (vector === undefined) {
        throw new Error(`Classic v2 fixture omits ${name}`);
      }
      vi.spyOn(Date, "now").mockReturnValue(vector.created * 1_000);
      const context = createExecutionContext();
      const response = await publisherWorker.fetch(
        classicV2SignedPublishRequest(vector),
        publisherEnvironment(core, context),
      );
      await waitOnExecutionContext(context);
      expect(response.status).toBe(200);
      return response.json<{ readonly rendezvousToken: string }>();
    };
    const request = (role: "client" | "server", token?: string, invite = false) =>
      new Request(
        `https://rendezvous.meta.atrinik.org/v1/classic/servers/${classicV2Fixture.server_id}?role=${role}`,
        {
          headers: {
            ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
            "CF-Connecting-IP": role === "client" ? "192.0.2.153" : "192.0.2.154",
            Upgrade: "websocket",
            ...(invite
              ? { "Sec-WebSocket-Protocol": CLASSIC_RENDEZVOUS_INVITE_SUBPROTOCOL }
              : {}),
          },
        },
      );

    const open = await publish("public-open-addressless");
    const openServer = await rendezvousWorker.fetch(
      request("server", open.rendezvousToken),
      edge,
    );
    expect(openServer.status).toBe(101);
    openServer.webSocket?.accept();
    const openClient = await rendezvousWorker.fetch(request("client"), edge);
    expect(openClient.status).toBe(101);
    openClient.webSocket?.accept();

    const protectedPublication = await publish("public-protected-endpoint");
    const protectedServer = await rendezvousWorker.fetch(
      request("server", protectedPublication.rendezvousToken, true),
      edge,
    );
    expect(protectedServer.status).toBe(101);
    protectedServer.webSocket?.accept();
    expect((await rendezvousWorker.fetch(request("client"), edge)).status)
      .toBe(503);
    const protectedClient = await rendezvousWorker.fetch(
      request("client", undefined, true),
      edge,
    );
    expect(protectedClient.status).toBe(101);
    protectedClient.webSocket?.accept();

    const row = await env.DB.prepare(
      `SELECT access_code_required, password_required
         FROM directory_entries
        WHERE profile = 'classic-v2' AND server_id = ?`,
    ).bind(classicV2Fixture.server_id).first();
    expect(row).toEqual({ access_code_required: 1, password_required: null });
    for (const socket of [openClient, openServer, protectedClient, protectedServer]) {
      socket.webSocket?.close(1000, "Test complete");
    }
  });

  it("does not let one source/day counter lock out distinct server identities", async () => {
    const core = coreEnvironment();
    const edge = rendezvousEnvironment(core);
    const now = publisherFixture.created;
    for (const [index, serverId] of ["4".repeat(64), "5".repeat(64)].entries()) {
      const token = String(index + 1).repeat(64);
      await persistRendezvousPublication(env.DB, {
        serverId,
        directoryProfile: "classic-v1",
        publisherSequence: String(index + 1),
        publisherNonce: String(index + 1).repeat(32),
        publisherNonceExpiresAt: now + 86_400,
        commitToken: String(index + 6).repeat(64),
        expectedGeneration: null,
        generation: String(index + 8).repeat(64),
        tokenHash: await sha256Hex(token),
        now,
        visibilityCutoff: now - 14_400,
        name: `Shared source ${index}`,
        playersCount: 0,
        version: "5.9.0",
        textComment: "Canonical identity isolation",
        isPublic: true,
        quicHost: "",
        quicPort: 1,
        quicCertSha256: serverId,
        authorizationRequired: false,
        directoryFingerprint: (index === 0 ? "a" : "b").repeat(64),
      });
      const response = await rendezvousWorker.fetch(new Request(
        `https://rendezvous.meta.atrinik.org/v1/classic/servers/${serverId}?role=server`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "CF-Connecting-IP": "192.0.2.200",
            Upgrade: "websocket",
          },
        },
      ), edge);
      expect(response.status).toBe(101);
      response.webSocket?.accept();
      response.webSocket?.close(1000, "Test complete");
    }

    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM request_budgets WHERE scope = 'rendezvous-server'",
    ).first<number>("count")).toBe(2);
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM request_budgets WHERE scope = 'rendezvous-server-source'",
    ).first<number>("count")).toBe(0);
  });

  it("keeps isolated canary authorities aligned across edge and core", async () => {
    const core = override(coreEnvironment(), {
      PUBLISH_HOSTNAME: "publish-canary.example.test",
      RENDEZVOUS_HOSTNAME: "rendezvous-canary.example.test",
    });
    const context = createExecutionContext();
    const publisherEdge = override(publisherEnvironment(core, context), {
      PUBLISH_HOSTNAME: "publish-canary.example.test",
    });
    const rejectedSignature = await publisherWorker.fetch(
      signedPublishRequest("publish-canary.example.test"),
      publisherEdge,
    );
    await waitOnExecutionContext(context);
    expect(rejectedSignature.status).toBe(401);

    const rendezvousEdge = override(rendezvousEnvironment(core), {
      RENDEZVOUS_HOSTNAME: "rendezvous-canary.example.test",
    });
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const offline = await rendezvousWorker.fetch(new Request(
        `https://rendezvous-canary.example.test/v1/classic/servers/${publisherFixture.server_id}?role=client`,
        {
          headers: {
            "CF-Connecting-IP": "192.0.2.149",
            Upgrade: "websocket",
          },
        },
      ), rendezvousEdge);
      expect(offline.status).toBe(404);
    }
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM rendezvous_pair_attempts",
    ).first<number>("count")).toBe(0);
  });

  it("preserves a fixed no-server admission response through both boundaries", async () => {
    const core = coreEnvironment();
    const context = createExecutionContext();
    const published = await publisherWorker.fetch(
      signedPublishRequest(),
      publisherEnvironment(core, context),
    );
    await waitOnExecutionContext(context);
    expect(published.status).toBe(200);

    const response = await rendezvousWorker.fetch(new Request(
      `https://rendezvous.meta.atrinik.org/v1/classic/servers/${publisherFixture.server_id}?role=client`,
      {
        headers: {
          "CF-Connecting-IP": "192.0.2.151",
          "Sec-WebSocket-Protocol":
            CLASSIC_RENDEZVOUS_INVITE_SUBPROTOCOL,
          Upgrade: "websocket",
        },
      },
    ), rendezvousEnvironment(core));
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("5");
    expect(await response.text()).toBe("Rendezvous server unavailable\n");
  });

  it("preserves a signed publish and WebSocket admission without forwarding the source address", async () => {
    const core = coreEnvironment();
    const context = createExecutionContext();
    const published = await publisherWorker.fetch(
      signedPublishRequest(),
      publisherEnvironment(core, context),
    );
    await waitOnExecutionContext(context);

    expect(published.status).toBe(200);
    const publication = await published.json<{
      readonly rendezvousToken: string;
      readonly status: string;
    }>();
    expect(publication.status).toBe("ok");
    expect(publication.rendezvousToken).toMatch(/^[0-9a-f]{64}$/);
    const stored = await env.DB.prepare(
      `SELECT presence.rendezvous_generation, entries.server_id
         FROM server_presence AS presence
         JOIN directory_entries AS entries
           ON entries.profile = presence.profile
          AND entries.server_id = presence.server_id
        WHERE presence.profile = 'classic-v1'
          AND presence.server_id = ?`,
    ).bind(publisherFixture.server_id).first<{
      readonly rendezvous_generation: string;
      readonly server_id: string;
    }>();
    expect(stored?.server_id).toBe(publisherFixture.server_id);
    expect(stored?.rendezvous_generation).toMatch(/^[0-9a-f]{64}$/);

    const admitted = await rendezvousWorker.fetch(new Request(
      `https://rendezvous.meta.atrinik.org/v1/classic/servers/${publisherFixture.server_id}?role=server`,
      {
        headers: {
          Authorization: `Bearer ${publication.rendezvousToken}`,
          "CF-Connecting-IP": "192.0.2.151",
          Cookie: "must-not-cross=value",
          Upgrade: "websocket",
          "Sec-WebSocket-Protocol":
            CLASSIC_RENDEZVOUS_INVITE_SUBPROTOCOL,
        },
      },
    ), rendezvousEnvironment(core));

    expect(admitted.status).toBe(101);
    expect(admitted.headers.get("Cache-Control")).toBe("no-store");
    expect(admitted.headers.get("Sec-WebSocket-Protocol")).toBe(
      CLASSIC_RENDEZVOUS_INVITE_SUBPROTOCOL,
    );
    const socket = admitted.webSocket;
    expect(socket).not.toBeNull();
    socket?.accept();
    socket?.close(1000, "Test complete");
  });

  it("applies the canonical pair cooldown only after live-target eligibility", async () => {
    const core = coreEnvironment();
    const context = createExecutionContext();
    const published = await publisherWorker.fetch(
      signedPublishRequest(),
      publisherEnvironment(core, context),
    );
    await waitOnExecutionContext(context);
    const { rendezvousToken } = await published.json<{
      readonly rendezvousToken: string;
    }>();
    expect(rendezvousToken).toMatch(/^[0-9a-f]{64}$/);
    const roomSockets: WebSocket[] = [];
    const admissionCore = override(core, {
      RENDEZVOUS: {
        getByName: () => ({
          fetch: async () => {
            const pair = new WebSocketPair();
            pair[1].accept();
            roomSockets.push(pair[1]);
            return new Response(null, {
              status: 101,
              headers: {
                "Cache-Control": "no-store",
                "Sec-WebSocket-Protocol":
                  CLASSIC_RENDEZVOUS_INVITE_SUBPROTOCOL,
                "X-Content-Type-Options": "nosniff",
              },
              webSocket: pair[0],
            });
          },
        }),
      } as unknown as Env["RENDEZVOUS"],
    });
    const edge = rendezvousEnvironment(admissionCore);

    const clientRequest = () => new Request(
      `https://rendezvous.meta.atrinik.org/v1/classic/servers/${publisherFixture.server_id}?role=client`,
      {
        headers: {
          "CF-Connecting-IP": "192.0.2.171",
          "Sec-WebSocket-Protocol":
            CLASSIC_RENDEZVOUS_INVITE_SUBPROTOCOL,
          Upgrade: "websocket",
        },
      },
    );
    const clients: WebSocket[] = [];
    try {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const admitted = await rendezvousWorker.fetch(clientRequest(), edge);
        expect(admitted.status).toBe(101);
        const socket = admitted.webSocket;
        if (socket === null) {
          throw new Error("Accepted canonical client returned no WebSocket");
        }
        socket.accept();
        clients.push(socket);
        socket.close(1000, "Test attempt complete");
      }
      const blocked = await rendezvousWorker.fetch(clientRequest(), edge);
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get("Retry-After")).toBe("30");
      expect(await blocked.json()).toEqual({
        error: {
          code: "rate_limited",
          message: "The request budget has been exhausted.",
          reason: "rendezvous_client_pair_cooldown",
          retry_after_seconds: 30,
        },
      });
      expect(await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM request_budgets
          WHERE scope IN (
            'rendezvous-client-source',
            'rendezvous-client-source-server'
          )`,
      ).first<number>("count")).toBe(0);
      expect(await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM rendezvous_pair_cooldowns",
      ).first<number>("count")).toBe(2);
    } finally {
      for (const client of clients) {
        client.close(1000, "Test cleanup");
      }
      for (const roomSocket of roomSockets) {
        roomSocket.close(1000, "Test cleanup");
      }
    }
  });
});
