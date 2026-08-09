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
import { CLASSIC_RENDEZVOUS_INVITE_SUBPROTOCOL } from "../src/routes";
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
    ROUTE_DISABLED_RETRY_SECONDS: "300",
    SOURCE_TAG_KEY_CURRENT_ID: "2026-08-a",
    SOURCE_TAG_KEY_PREVIOUS_ID: "2026-07-a",
    SOURCE_TAG_KEY_CURRENT: CURRENT_SECRET,
    SOURCE_TAG_KEY_PREVIOUS: PREVIOUS_SECRET,
  } satisfies PublisherEnv;
  return override(base, { PUBLISH_ENABLED: "enabled" });
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
  await env.DB.batch([
    env.DB.prepare("DELETE FROM directory_artifact_history"),
    env.DB.prepare("DELETE FROM directory_artifact_commits"),
    env.DB.prepare("DELETE FROM directory_expiry_commits"),
    env.DB.prepare("DELETE FROM directory_outbox"),
    env.DB.prepare("DELETE FROM publisher_nonces"),
    env.DB.prepare("DELETE FROM publisher_replay"),
    env.DB.prepare("DELETE FROM directory_entries"),
    env.DB.prepare("DELETE FROM server_presence"),
    env.DB.prepare("DELETE FROM servers"),
    env.DB.prepare("DELETE FROM server_owners"),
    env.DB.prepare("DELETE FROM request_budgets"),
    env.DB.prepare(
      "UPDATE directory_revisions SET revision = 0, updated_at = 0",
    ),
  ]);
  vi.spyOn(Date, "now").mockReturnValue(publisherFixture.created * 1_000);
});

describe("in-process service-boundary contract", () => {
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
});
