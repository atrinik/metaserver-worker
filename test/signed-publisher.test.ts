import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  evictDurableObject,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { handlePublisherCoordinatorRequest } from "../src/index";
import { gameDirectoryServerJsonByteLength } from "../src/directory-artifacts";
import { publisherServiceRequest } from "../src/internal-service";
import { sha256Hex } from "../src/protocol";
import publisherFixture from "./fixtures/metaserver-publisher-v1.json";
import gamePublisherFixture from "./fixtures/metaserver-game-publisher-v1.json";

interface SignedVector {
  readonly body: string;
  readonly content_digest: string;
  readonly nonce: string;
  readonly sequence: string;
  readonly signature_header: string;
  readonly signature_input: string;
}

interface StoredSignedPublication {
  readonly authentication_kind: string;
  readonly auth_key: string;
  readonly directory_fingerprint: string;
  readonly last_nonce: string;
  readonly last_sequence: string;
  readonly rendezvous_generation: string;
  readonly rendezvous_token_hash: string;
}

function initialVector(): SignedVector {
  return {
    body: publisherFixture.body,
    content_digest: publisherFixture.content_digest,
    nonce: publisherFixture.nonce,
    sequence: publisherFixture.sequence,
    signature_header: publisherFixture.signature_header,
    signature_input: publisherFixture.signature_input,
  };
}

function publishRequest(vector: SignedVector): Request {
  return new Request(`https://${publisherFixture.authority}${publisherFixture.path}`, {
    method: "POST",
    headers: {
      "Atrinik-Publish-Sequence": vector.sequence,
      "Atrinik-Server-ID": publisherFixture.server_id,
      "CF-Connecting-IP": "192.0.2.80",
      "Content-Digest": vector.content_digest,
      "Content-Type": publisherFixture.content_type,
      "Signature": vector.signature_header,
      "Signature-Input": vector.signature_input,
    },
    body: vector.body,
  });
}

function gamePublishRequest(): Request {
  return new Request(
    `https://${gamePublisherFixture.authority}${gamePublisherFixture.path}`,
    {
      method: "POST",
      headers: {
        "Atrinik-Publish-Sequence": gamePublisherFixture.sequence,
        "Atrinik-Server-ID": gamePublisherFixture.server_id,
        "CF-Connecting-IP": "198.51.100.81",
        "Content-Digest": gamePublisherFixture.content_digest,
        "Content-Type": gamePublisherFixture.content_type,
        "Signature": gamePublisherFixture.signature_header,
        "Signature-Input": gamePublisherFixture.signature_input,
      },
      body: gamePublisherFixture.body,
    },
  );
}

async function callWorker(
  request: Request,
  workerEnv: Env = env,
): Promise<Response> {
  const context = createExecutionContext();
  const response = await handlePublisherCoordinatorRequest(
    publisherServiceRequest(request),
    workerEnv,
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}

function testEnvironment(options: {
  readonly publishBurstAllowed?: boolean;
  readonly publishLimiter?: RateLimit;
} = {}): Env {
  const allowed = {
    limit: async () => ({ success: true }),
  } as RateLimit;
  const publish = {
    limit: async () => ({
      success: options.publishBurstAllowed ?? true,
    }),
  } as RateLimit;
  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === "GLOBAL_RATE_LIMITER") {
        return allowed;
      }
      if (property === "PUBLISH_IDENTITY_RATE_LIMITER") {
        return options.publishLimiter ?? publish;
      }
      if (
        property === "PUBLISH_ENABLED" ||
        property === "GAME_PUBLISH_ENABLED"
      ) {
        return "enabled";
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

async function storedPublication(): Promise<StoredSignedPublication | null> {
  return env.DB.prepare(
    `SELECT owners.authentication_kind, owners.auth_key,
            entries.directory_fingerprint,
            replay.last_nonce, replay.last_sequence,
            presence.rendezvous_generation,
            presence.rendezvous_token_hash
       FROM server_presence AS presence
       JOIN directory_entries AS entries
         ON entries.profile = presence.profile
        AND entries.server_id = presence.server_id
       JOIN server_owners AS owners USING (server_id)
       JOIN publisher_replay AS replay
         ON replay.server_id = presence.server_id
        AND replay.profile = presence.profile
      WHERE presence.server_id = ?
        AND presence.profile = 'classic-v1'`,
  ).bind(publisherFixture.server_id).first<StoredSignedPublication>();
}

beforeEach(async () => {
  const stub = env.RENDEZVOUS.getByName(publisherFixture.server_id);
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.deleteAll();
  });
  await evictDurableObject(stub);
  const gameStub = env.RENDEZVOUS.getByName(
    `game-v1:${gamePublisherFixture.server_id}`,
  );
  await runInDurableObject(gameStub, async (_instance, state) => {
    await state.storage.deleteAll();
  });
  await evictDurableObject(gameStub);
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
    env.DB.prepare("DELETE FROM server_blacklist"),
    env.DB.prepare("DELETE FROM request_budgets"),
    env.DB.prepare(
      "UPDATE directory_revisions SET revision = 0, updated_at = 0",
    ),
    env.DB.prepare(
      `UPDATE directory_artifact_publications
          SET published_revision = 0, generation = 0, generated_at = 0,
              expires_at = 0,
              model_sha256 = '${"0".repeat(64)}',
              html_sha256 = '${"0".repeat(64)}',
              xml_sha256 = '${"0".repeat(64)}',
              json_sha256 = '${"0".repeat(64)}',
              manifest_sha256 = '${"0".repeat(64)}',
              html_bytes = 0, xml_bytes = 0, json_bytes = 0,
              manifest_bytes = 0, published_at = 0`,
    ),
  ]);
  vi.spyOn(Date, "now").mockReturnValue(publisherFixture.created * 1_000);
});

describe("classic signed publisher", () => {
  it.each([null, "legacy-unknown"])(
    "preserves a committed legacy Room success for change marker %s",
    async (marker) => {
      const nudge = vi.fn(async () => {});
      const roomFetch = vi.fn(async () => new Response(null, {
        status: 204,
        ...(marker === null
          ? {}
          : { headers: { "X-Atrinik-Directory-Changed": marker } }),
      }));
      const base = testEnvironment();
      const mixedVersionEnv = new Proxy(base, {
        get(target, property, receiver) {
          if (property === "RENDEZVOUS") {
            return {
              getByName: () => ({ fetch: roomFetch }),
            } as unknown as DurableObjectNamespace;
          }
          if (property === "DIRECTORY_BUILDER") {
            return {
              getByName: () => ({ nudge }),
            } as unknown as DurableObjectNamespace;
          }
          return Reflect.get(target, property, receiver);
        },
      });

      const response = await callWorker(
        publishRequest(initialVector()),
        mixedVersionEnv,
      );
      expect(response.status).toBe(200);
      expect(roomFetch).toHaveBeenCalledTimes(1);
      expect(nudge).toHaveBeenCalledTimes(1);
    },
  );

  it("ships fail closed until the staged rollout explicitly enables it", async () => {
    const response = await callWorker(publishRequest(initialVector()));
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("300");
    expect(await storedPublication()).toBeNull();
    expect(await directoryState()).toEqual({ revision: 0, outbox: [] });
  });

  it("leaves replay, ownership, listing, revision, and token state unchanged when persistence fails before commit", async () => {
    const stub = env.RENDEZVOUS.getByName(publisherFixture.server_id);
    type PublicationPersister = (
      db: D1Database,
      publication: unknown,
    ) => Promise<{ readonly accepted: boolean; readonly visibleChanged: boolean }>;
    let originalPersister: PublicationPersister | null = null;
    await runInDurableObject(stub, (instance) => {
      originalPersister = Reflect.get(
        instance,
        "publicationPersister",
      ) as PublicationPersister;
      Reflect.set(instance, "publicationPersister", async () => {
        throw new Error("Injected failure before D1 publication commit");
      });
    });
    try {
      const rejected = await callWorker(
        publishRequest(initialVector()),
        testEnvironment(),
      );
      expect(rejected.status).toBe(500);
      expect(rejected.headers.get("Cache-Control")).toBe("no-store");
      expect(await storedPublication()).toBeNull();
      expect(await directoryState()).toEqual({ revision: 0, outbox: [] });
      expect(await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM publisher_nonces",
      ).first<number>("count")).toBe(0);
      await runInDurableObject(stub, async (_instance, state) => {
        expect(await state.storage.get("rendezvous:token-generation"))
          .toBeUndefined();
      });
    } finally {
      if (originalPersister !== null) {
        await runInDurableObject(stub, (instance) => {
          Reflect.set(instance, "publicationPersister", originalPersister);
        });
      }
    }
  });

  it("returns the exact token when D1 committed before an ambiguous result", async () => {
    const stub = env.RENDEZVOUS.getByName(publisherFixture.server_id);
    type PublicationPersister = (
      db: D1Database,
      publication: unknown,
    ) => Promise<{ readonly accepted: boolean; readonly visibleChanged: boolean }>;
    let originalPersister: PublicationPersister | null = null;
    await runInDurableObject(stub, (instance) => {
      originalPersister = Reflect.get(
        instance,
        "publicationPersister",
      ) as PublicationPersister;
      Reflect.set(instance, "publicationPersister", async (
        db: D1Database,
        publication: unknown,
      ) => {
        if (originalPersister === null) {
          throw new Error("Publication persister was not captured");
        }
        await originalPersister(db, publication);
        throw new Error("Injected response loss after signed D1 commit");
      });
    });
    try {
      const response = await callWorker(
        publishRequest(initialVector()),
        testEnvironment(),
      );
      expect(response.status).toBe(200);
      const result = await response.json<{
        readonly status: string;
        readonly rendezvousToken: string;
      }>();
      expect(result.status).toBe("ok");
      expect(result.rendezvousToken).toMatch(/^[0-9a-f]{64}$/);
      expect((await storedPublication())?.rendezvous_token_hash).toBe(
        await sha256Hex(result.rendezvousToken),
      );
      expect(await directoryState()).toEqual({ revision: 1, outbox: [1] });
      expect(await publishedRevision()).toBe(0);
    } finally {
      if (originalPersister !== null) {
        await runInDurableObject(stub, (instance) => {
          Reflect.set(instance, "publicationPersister", originalPersister);
        });
      }
    }
  });

  it("returns a machine-readable authenticated publisher burst limit without mutation", async () => {
    const response = await callWorker(
      publishRequest(initialVector()),
      testEnvironment({ publishBurstAllowed: false }),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(await response.json()).toEqual({
      error: {
        code: "rate_limited",
        message: "The request budget has been exhausted.",
        reason: "publish_burst",
        retry_after_seconds: 60,
      },
    });
    expect(await storedPublication()).toBeNull();
    expect(await directoryState()).toEqual({ revision: 0, outbox: [] });
  });

  it("charges an authenticated blacklisted identity before rejecting it", async () => {
    const limit = vi.fn(async () => ({ success: true }));
    const workerEnv = testEnvironment({
      publishLimiter: { limit } as RateLimit,
    });
    await env.DB.prepare(
      "INSERT INTO server_blacklist (pattern, reason, created_at) VALUES (?, ?, ?)",
    ).bind(
      `${publisherFixture.server_id.slice(0, 8)}*`,
      "test identity block",
      1,
    ).run();

    const response = await callWorker(
      publishRequest(initialVector()),
      workerEnv,
    );
    expect(response.status).toBe(403);
    expect(limit).toHaveBeenCalledTimes(1);
    expect(await storedPublication()).toBeNull();
  });

  it("registers, rejects replay, and revises only visible content", async () => {
    const workerEnv = testEnvironment();
    const spoofed = {
      ...initialVector(),
      signature_header:
        publisherFixture.signature_header.slice(0, -3) + "AA:",
    };
    const rejected = await callWorker(publishRequest(spoofed), workerEnv);
    expect(rejected.status).toBe(401);
    expect(await storedPublication()).toBeNull();
    expect(await directoryState()).toEqual({ revision: 0, outbox: [] });

    const initial = await callWorker(publishRequest(initialVector()), workerEnv);
    expect(initial.status).toBe(200);
    expect(initial.headers.get("Cache-Control")).toBe("no-store");
    const initialBody = await initial.json<{
      status: string;
      rendezvousToken: string;
    }>();
    expect(initialBody.status).toBe("ok");
    expect(initialBody.rendezvousToken).toMatch(/^[0-9a-f]{64}$/);

    const storedInitial = await storedPublication();
    expect(storedInitial).toMatchObject({
      authentication_kind: "signed-certificate-v1",
      auth_key: publisherFixture.server_id.repeat(2),
      last_nonce: publisherFixture.nonce,
      last_sequence: publisherFixture.sequence,
      rendezvous_token_hash: await sha256Hex(initialBody.rendezvousToken),
    });
    expect(await directoryState()).toEqual({ revision: 1, outbox: [1] });
    expect(await publishedRevision()).toBe(0);

    const replay = await callWorker(publishRequest(initialVector()), workerEnv);
    expect(replay.status).toBe(409);
    expect(replay.headers.get("Cache-Control")).toBe("no-store");
    expect(await replay.json()).toEqual({
      error: {
        code: "publish_replay",
        minimumNextSequence: publisherFixture.heartbeat.sequence,
      },
    });
    expect(await storedPublication()).toEqual(storedInitial);
    expect(await directoryState()).toEqual({ revision: 1, outbox: [1] });

    const stale = await callWorker(
      publishRequest(publisherFixture.stale),
      workerEnv,
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({
      error: {
        code: "publish_replay",
        minimumNextSequence: publisherFixture.heartbeat.sequence,
      },
    });

    const heartbeat = await callWorker(
      publishRequest(publisherFixture.heartbeat),
      workerEnv,
    );
    expect(heartbeat.status).toBe(200);
    expect(await directoryState()).toEqual({ revision: 1, outbox: [1] });
    const storedHeartbeat = await storedPublication();
    expect(storedHeartbeat?.last_sequence).toBe(
      publisherFixture.heartbeat.sequence,
    );
    expect(storedHeartbeat?.rendezvous_generation).not.toBe(
      storedInitial?.rendezvous_generation,
    );

    const changed = await callWorker(
      publishRequest(publisherFixture.changed),
      workerEnv,
    );
    expect(changed.status).toBe(200);
    expect(await directoryState()).toEqual({ revision: 2, outbox: [2] });
    expect(await publishedRevision()).toBe(0);

    const nonceReplay = await callWorker(
      publishRequest(publisherFixture.reused_nonce),
      workerEnv,
    );
    expect(nonceReplay.status).toBe(409);
    expect(await nonceReplay.json()).toEqual({
      error: {
        code: "publish_replay",
        minimumNextSequence: publisherFixture.reused_nonce.sequence,
      },
    });
    expect((await storedPublication())?.last_sequence).toBe(
      publisherFixture.changed.sequence,
    );
    expect(await directoryState()).toEqual({ revision: 2, outbox: [2] });

    const madePrivate = await callWorker(
      publishRequest(publisherFixture.private),
      workerEnv,
    );
    expect(madePrivate.status).toBe(200);
    const privateBody = await madePrivate.json<{
      status: string;
      rendezvousToken: string;
    }>();
    expect(privateBody.status).toBe("ok");
    expect(await storedPublication()).toBeNull();
    expect(await env.DB.prepare(
      `SELECT last_seen, rendezvous_token_hash, rendezvous_generation
         FROM server_presence
        WHERE profile = 'classic-v1' AND server_id = ?`,
    ).bind(publisherFixture.server_id).first()).toMatchObject({
      last_seen: publisherFixture.created,
      rendezvous_token_hash: await sha256Hex(privateBody.rendezvousToken),
      rendezvous_generation: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(await env.DB.prepare(
      `SELECT owners.authentication_kind, replay.last_sequence,
              replay.last_nonce
         FROM server_owners AS owners
         JOIN publisher_replay AS replay USING (server_id)
        WHERE owners.server_id = ? AND replay.profile = 'classic-v1'`,
    ).bind(publisherFixture.server_id).first()).toEqual({
      authentication_kind: "signed-certificate-v1",
      last_sequence: publisherFixture.private.sequence,
      last_nonce: publisherFixture.private.nonce,
    });
    expect(await directoryState()).toEqual({
      revision: 3,
      outbox: [3],
    });
    expect(await publishedRevision()).toBe(0);
    expect(await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM publisher_nonces
        WHERE server_id = ? AND profile = 'classic-v1'`,
    ).bind(publisherFixture.server_id).first<number>("count")).toBe(4);
  });
});

describe("Game Protocol 1 signed publisher", () => {
  it("fails closed at the coordinator while only the Game breaker is disabled", async () => {
    const enabled = testEnvironment();
    const gameDisabled = new Proxy(enabled, {
      get(target, property, receiver) {
        if (property === "GAME_PUBLISH_ENABLED") {
          return "disabled";
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const response = await callWorker(gamePublishRequest(), gameDisabled);
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("300");
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM request_budgets",
    ).first<number>("count")).toBe(0);
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM server_presence",
    ).first<number>("count")).toBe(0);
  });

  it("commits the protocol fixture into isolated Game state and rejects replay", async () => {
    const response = await callWorker(gamePublishRequest(), testEnvironment());
    expect(response.status).toBe(200);
    const body = await response.json<{
      readonly status: string;
      readonly rendezvousToken: string;
    }>();
    expect(body).toMatchObject({
      status: "ok",
      rendezvousToken: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const stored = await env.DB.prepare(
      `SELECT entries.name, entries.description, entries.region,
              entries.protocol_major, entries.protocol_minor,
              entries.content_id, entries.content_revision_sha256,
              entries.players_online, entries.players_capacity, entries.status,
              entries.game_json_bytes,
              entries.hostname, entries.port, entries.quic_cert_sha256,
              entries.password_required, presence.rendezvous_token_hash,
              replay.last_sequence, replay.last_nonce
         FROM directory_entries AS entries
         JOIN server_presence AS presence
           ON presence.profile = entries.profile
          AND presence.server_id = entries.server_id
         JOIN publisher_replay AS replay
           ON replay.profile = entries.profile
          AND replay.server_id = entries.server_id
        WHERE entries.profile = 'game-v1' AND entries.server_id = ?`,
    ).bind(gamePublisherFixture.server_id).first();
    expect(stored).toEqual({
      name: "Atrinik Game Alpha",
      description: "Cooperative Ω",
      region: "eu-west",
      protocol_major: 1,
      protocol_minor: 0,
      content_id: "atrinik-main",
      content_revision_sha256: "a".repeat(64),
      players_online: 3,
      players_capacity: 64,
      status: "online",
      game_json_bytes: gameDirectoryServerJsonByteLength({
        serverId: gamePublisherFixture.server_id,
        certificateSha256: gamePublisherFixture.server_id,
        name: "Atrinik Game Alpha",
        description: "Cooperative Ω",
        region: "eu-west",
        protocol: { major: 1, minor: 0 },
        content: {
          id: "atrinik-main",
          revisionSha256: "a".repeat(64),
        },
        players: { online: 3, capacity: 64 },
        status: "online",
        passwordRequired: false,
        endpoint: { hostname: "xn--bcher-kva.example.org", port: 13_327 },
      }),
      hostname: "xn--bcher-kva.example.org",
      port: 13_327,
      quic_cert_sha256: gamePublisherFixture.server_id,
      password_required: 0,
      rendezvous_token_hash: await sha256Hex(body.rendezvousToken),
      last_sequence: gamePublisherFixture.sequence,
      last_nonce: gamePublisherFixture.nonce,
    });
    expect(await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM directory_entries
        WHERE profile = 'classic-v1' AND server_id = ?`,
    ).bind(gamePublisherFixture.server_id).first<number>("count")).toBe(0);
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM servers WHERE server_id = ?",
    ).bind(gamePublisherFixture.server_id).first<number>("count")).toBe(0);
    expect(await env.DB.prepare(
      `SELECT request_count FROM request_budgets
        WHERE actor_key = ? AND scope = 'publish-game-server'`,
    ).bind(gamePublisherFixture.server_id).first<number>("request_count")).toBe(1);
    expect(await gameDirectoryState()).toEqual({ revision: 1, outbox: [1] });

    const gameStub = env.RENDEZVOUS.getByName(
      `game-v1:${gamePublisherFixture.server_id}`,
    );
    await runInDurableObject(gameStub, async (_instance, state) => {
      expect(await state.storage.get("rendezvous:token-generation"))
        .toMatch(/^[0-9a-f]{64}$/);
    });
    const classicStub = env.RENDEZVOUS.getByName(gamePublisherFixture.server_id);
    await runInDurableObject(classicStub, async (_instance, state) => {
      expect(await state.storage.get("rendezvous:token-generation"))
        .toBeUndefined();
    });

    const replay = await callWorker(gamePublishRequest(), testEnvironment());
    expect(replay.status).toBe(409);
    expect(await replay.json()).toEqual({
      error: { code: "publish_replay", minimumNextSequence: "43" },
    });
    expect(await gameDirectoryState()).toEqual({ revision: 1, outbox: [1] });
  });
});

async function directoryState(): Promise<{
  readonly revision: number;
  readonly outbox: readonly number[];
}> {
  const revision = await env.DB.prepare(
    "SELECT revision FROM directory_revisions WHERE profile = 'classic-v1'",
  ).first<number>("revision");
  const outbox = await env.DB.prepare(
    `SELECT revision FROM directory_outbox
      WHERE profile = 'classic-v1' ORDER BY revision`,
  ).all<{ revision: number }>();
  if (revision === null) {
    throw new Error("Classic directory revision is missing");
  }
  return {
    revision,
    outbox: outbox.results.map((row) => row.revision),
  };
}

async function gameDirectoryState(): Promise<{
  readonly revision: number;
  readonly outbox: readonly number[];
}> {
  const revision = await env.DB.prepare(
    "SELECT revision FROM directory_revisions WHERE profile = 'game-v1'",
  ).first<number>("revision");
  const outbox = await env.DB.prepare(
    `SELECT revision FROM directory_outbox
      WHERE profile = 'game-v1' ORDER BY revision`,
  ).all<{ revision: number }>();
  if (revision === null) {
    throw new Error("Game directory revision is missing");
  }
  return { revision, outbox: outbox.results.map((row) => row.revision) };
}

async function publishedRevision(): Promise<number | null> {
  return env.DB.prepare(
    `SELECT published_revision FROM directory_artifact_publications
      WHERE profile = 'classic-v1'`,
  ).first<number>("published_revision");
}
