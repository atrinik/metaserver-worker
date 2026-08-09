import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  evictDurableObject,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index";
import { sha256Hex } from "../src/protocol";
import publisherFixture from "./fixtures/metaserver-publisher-v1.json";

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

async function callWorker(
  request: Request,
  workerEnv: Env = env,
): Promise<Response> {
  const context = createExecutionContext();
  const response = await worker.fetch(request, workerEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

function testEnvironment(options: {
  readonly publishBurstAllowed?: boolean;
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
        return publish;
      }
      if (property === "PUBLISH_ENABLED") {
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
  await env.DB.batch([
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

describe("classic signed publisher", () => {
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
      auth_key: "0".repeat(128),
      last_nonce: publisherFixture.nonce,
      last_sequence: publisherFixture.sequence,
      rendezvous_token_hash: await sha256Hex(initialBody.rendezvousToken),
    });
    expect(await directoryState()).toEqual({ revision: 1, outbox: [1] });

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
    expect(await directoryState()).toEqual({ revision: 2, outbox: [1, 2] });

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
    expect(await directoryState()).toEqual({ revision: 2, outbox: [1, 2] });

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
      outbox: [1, 2, 3],
    });
    expect(await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM publisher_nonces
        WHERE server_id = ? AND profile = 'classic-v1'`,
    ).bind(publisherFixture.server_id).first<number>("count")).toBe(4);
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
