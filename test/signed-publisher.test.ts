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
import classicV2Fixture from "./fixtures/metaserver-classic-publisher-v2.json";

interface SignedVector {
  readonly body: string;
  readonly content_digest: string;
  readonly nonce: string;
  readonly sequence: string;
  readonly signature_header: string;
  readonly signature_input: string;
}

interface StoredSignedPublication {
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

function classicV2PublishRequest(
  vector: SignedVector & { readonly path: string },
): Request {
  return new Request(`https://${classicV2Fixture.authority}${vector.path}`, {
    method: "POST",
    headers: {
      "Atrinik-Publish-Sequence": vector.sequence,
      "Atrinik-Server-ID": classicV2Fixture.server_id,
      "CF-Connecting-IP": "192.0.2.82",
      "Content-Digest": vector.content_digest,
      "Content-Type": classicV2Fixture.content_type,
      Signature: vector.signature_header,
      "Signature-Input": vector.signature_input,
    },
    body: vector.body,
  });
}

interface MigrationEnvelope {
  readonly body: string;
  readonly created: number;
  readonly name: string;
  readonly server_id: string;
  readonly signature_base: string;
  readonly signature_base64: string;
}

function migrationPublishRequest(vector: MigrationEnvelope): Request {
  const values = new Map<string, string>();
  for (const line of vector.signature_base.split("\n")) {
    const separator = line.indexOf(": ");
    if (separator < 1) {
      throw new Error("Migration signature base is malformed");
    }
    values.set(line.slice(1, separator - 1), line.slice(separator + 2));
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (value === undefined) {
      throw new Error(`Migration signature base omits ${name}`);
    }
    return value;
  };
  return new Request(`https://${required("@authority")}${required("@path")}`, {
    method: required("@method"),
    headers: {
      "Atrinik-Publish-Sequence": required("atrinik-publish-sequence"),
      "Atrinik-Server-ID": required("atrinik-server-id"),
      "CF-Connecting-IP": "192.0.2.83",
      "Content-Digest": required("content-digest"),
      "Content-Type": required("content-type"),
      Signature: `atrinik=:${vector.signature_base64}:`,
      "Signature-Input": `atrinik=${required("@signature-params")}`,
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
    `SELECT entries.directory_fingerprint,
            replay.last_nonce, replay.last_sequence,
            presence.rendezvous_generation,
            presence.rendezvous_token_hash
       FROM server_presence AS presence
       JOIN directory_entries AS entries
         ON entries.profile = presence.profile
        AND entries.server_id = presence.server_id
       JOIN publisher_replay AS replay
         ON replay.server_id = presence.server_id
        AND replay.profile = presence.profile
      WHERE presence.server_id = ?
        AND presence.profile = 'classic-v1'`,
  ).bind(publisherFixture.server_id).first<StoredSignedPublication>();
}

async function snapshotSignedState(): Promise<unknown> {
  return Promise.all([
    "publisher_replay",
    "publisher_nonces",
    "server_presence",
    "directory_entries",
    "directory_revisions",
    "directory_outbox",
    "classic_identity_modes",
    "classic_receiver_mode",
  ].map(async (table) => ({
    table,
    rows: (await env.DB.prepare(`SELECT * FROM ${table} ORDER BY 1, 2, 3`)
      .all()).results,
  })));
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
    env.DB.prepare("DELETE FROM server_denials"),
    env.DB.prepare("DELETE FROM request_budgets"),
    env.DB.prepare("DELETE FROM classic_identity_modes"),
    env.DB.prepare(
      `UPDATE classic_receiver_mode
          SET mode = 'classic-v1-accepting', activated_at = NULL
        WHERE singleton = 1`,
    ),
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

  it("ships Classic publication when its rollout circuit is enabled", async () => {
    const response = await callWorker(publishRequest(initialVector()));
    expect(response.status).toBe(200);
    const result = await response.json<{
      readonly status: string;
      readonly rendezvousToken: string;
    }>();
    expect(result.status).toBe("ok");
    expect(result.rendezvousToken).toMatch(/^[0-9a-f]{64}$/);
    expect(await storedPublication()).not.toBeNull();
    expect(await directoryState()).toEqual({ revision: 1, outbox: [1] });
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

  it("charges an authenticated denied identity before rejecting it", async () => {
    const limit = vi.fn(async () => ({ success: true }));
    const workerEnv = testEnvironment({
      publishLimiter: { limit } as RateLimit,
    });
    await env.DB.prepare(
      "INSERT INTO server_denials (server_id, created_at) VALUES (?, ?)",
    ).bind(
      publisherFixture.server_id,
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
      `SELECT replay.last_sequence, replay.last_nonce
         FROM publisher_replay AS replay
        WHERE replay.server_id = ? AND replay.profile = 'classic-v1'`,
    ).bind(publisherFixture.server_id).first()).toEqual({
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

describe("Classic v2 signed publication migration", () => {
  it("leaves the complete v1 state unchanged when the v2 upgrade cannot commit", async () => {
    const envelope = (name: string) =>
      classicV2Fixture.migration.signed_envelopes.find(
        (vector) => vector.name === name,
      );
    const v1 = envelope("v1-100");
    const upgrade = envelope("v2-101-upgrade");
    if (v1 === undefined || upgrade === undefined) {
      throw new Error("Protocol fixture omits migration publications");
    }
    vi.spyOn(Date, "now").mockReturnValue(v1.created * 1_000);
    expect((await callWorker(
      migrationPublishRequest(v1),
      testEnvironment(),
    )).status).toBe(200);
    const before = await snapshotSignedState();
    const stub = env.RENDEZVOUS.getByName(upgrade.server_id);
    type PublicationPersister = (
      db: D1Database,
      publication: unknown,
    ) => Promise<{ readonly accepted: boolean; readonly visibleChanged: boolean }>;
    let original: PublicationPersister | null = null;
    await runInDurableObject(stub, (instance) => {
      original = Reflect.get(instance, "publicationPersister") as
        PublicationPersister;
      Reflect.set(instance, "publicationPersister", async () => {
        throw new Error("Injected v2 migration commit failure");
      });
    });
    try {
      vi.spyOn(Date, "now").mockReturnValue(upgrade.created * 1_000);
      expect((await callWorker(
        migrationPublishRequest(upgrade),
        testEnvironment(),
      )).status).toBe(500);
      expect(await snapshotSignedState()).toEqual(before);
    } finally {
      if (original !== null) {
        await runInDurableObject(stub, (instance) => {
          Reflect.set(instance, "publicationPersister", original);
        });
      }
    }
  });

  it("atomically upgrades one identity onto the shared replay lineage", async () => {
    const workerEnv = testEnvironment();
    const envelope = (name: string) =>
      classicV2Fixture.migration.signed_envelopes.find(
        (vector) => vector.name === name,
      );
    const v1 = envelope("v1-100");
    const upgrade = envelope("v2-101-upgrade");
    const retiredV1 = envelope("v1-102-post-upgrade");
    const nextV2 = envelope("v2-102-next");
    if (
      v1 === undefined || upgrade === undefined ||
      retiredV1 === undefined || nextV2 === undefined
    ) {
      throw new Error("Protocol fixture omits migration publications");
    }
    vi.spyOn(Date, "now").mockReturnValue(v1.created * 1_000);
    expect((await callWorker(migrationPublishRequest(v1), workerEnv)).status)
      .toBe(200);

    vi.spyOn(Date, "now").mockReturnValue(upgrade.created * 1_000);
    const upgraded = await callWorker(
      migrationPublishRequest(upgrade),
      workerEnv,
    );
    expect(upgraded.status).toBe(200);
    expect(await env.DB.prepare(
      `SELECT mode FROM classic_identity_modes WHERE server_id = ?`,
    ).bind(upgrade.server_id).first<string>("mode")).toBe("v2-only");
    expect(await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM server_presence
        WHERE server_id = ? AND profile = 'classic-v1'`,
    ).bind(upgrade.server_id).first<number>("count")).toBe(0);
    expect(await env.DB.prepare(
      `SELECT entries.access_code_required, entries.password_required,
              replay.last_sequence
         FROM directory_entries AS entries
         JOIN publisher_replay AS replay
           ON replay.server_id = entries.server_id
          AND replay.profile = entries.profile
        WHERE entries.server_id = ? AND entries.profile = 'classic-v2'`,
    ).bind(upgrade.server_id).first()).toMatchObject({
      access_code_required: 1,
      password_required: null,
      last_sequence: upgrade.sequence,
    });

    vi.spyOn(Date, "now").mockReturnValue(retiredV1.created * 1_000);
    const retired = await callWorker(
      migrationPublishRequest(retiredV1),
      workerEnv,
    );
    expect(retired.status).toBe(410);
    expect(retired.headers.get("Cache-Control")).toBe("no-store");
    expect(await retired.json()).toEqual({
      error: { code: "profile_retired" },
    });

    vi.spyOn(Date, "now").mockReturnValue(upgrade.created * 1_000);
    const replay = await callWorker(
      migrationPublishRequest(upgrade),
      workerEnv,
    );
    expect(replay.status).toBe(409);
    expect(await replay.json()).toEqual({
      error: {
        code: "publish_replay",
        minimumNextSequence: nextV2.sequence,
      },
    });

    vi.spyOn(Date, "now").mockReturnValue(nextV2.created * 1_000);
    const advanced = await callWorker(
      migrationPublishRequest(nextV2),
      workerEnv,
    );
    expect(advanced.status).toBe(200);
    expect(await env.DB.prepare(
      `SELECT last_sequence FROM publisher_replay
        WHERE server_id = ? AND profile = 'classic-v2'`,
    ).bind(upgrade.server_id).first<string>("last_sequence"))
      .toBe(nextV2.sequence);
  });

  it("returns the fixed global retirement response without consuming v1 state", async () => {
    const workerEnv = testEnvironment();
    const accepted = await callWorker(publishRequest(initialVector()), workerEnv);
    expect(accepted.status).toBe(200);
    await env.DB.prepare(
      `UPDATE classic_receiver_mode
          SET mode = 'classic-v1-retired', activated_at = ?
        WHERE singleton = 1 AND mode = 'classic-v1-accepting'`,
    ).bind(publisherFixture.created).run();
    const before = await snapshotSignedState();

    const retired = await callWorker(
      publishRequest(publisherFixture.heartbeat),
      workerEnv,
    );
    expect(retired.status).toBe(410);
    expect(await retired.text()).toBe(
      '{"error":{"code":"profile_retired"}}',
    );
    expect(await snapshotSignedState()).toEqual(before);
  });

  it("rejects globally retired v1 before pulling the request body", async () => {
    await env.DB.prepare(
      `UPDATE classic_receiver_mode
          SET mode = 'classic-v1-retired', activated_at = ?
        WHERE singleton = 1 AND mode = 'classic-v1-accepting'`,
    ).bind(publisherFixture.created).run();
    const internal = publisherServiceRequest(publishRequest(initialVector()));
    const context = createExecutionContext();
    const response = await handlePublisherCoordinatorRequest(
      internal,
      testEnvironment(),
      context,
    );
    await waitOnExecutionContext(context);
    expect(response.status).toBe(410);
    expect(await response.text()).toBe(
      '{"error":{"code":"profile_retired"}}',
    );
    expect(internal.bodyUsed).toBe(false);
  });

  it("accepts uint64 max once and then returns exhaustion without a minimum", async () => {
    const workerEnv = testEnvironment();
    const envelope = (name: string) =>
      classicV2Fixture.migration.signed_envelopes.find(
        (vector) => vector.name === name,
      );
    const maximumMinusOne = envelope("v2-max-minus-one");
    const maximum = envelope("v2-max");
    const exhausted = envelope("v2-max-exhausted");
    if (
      maximumMinusOne === undefined || maximum === undefined ||
      exhausted === undefined
    ) {
      throw new Error("Protocol fixture omits maximum sequence vectors");
    }
    for (const vector of [maximumMinusOne, maximum]) {
      vi.spyOn(Date, "now").mockReturnValue(vector.created * 1_000);
      const response = await callWorker(
        migrationPublishRequest(vector),
        workerEnv,
      );
      expect(response.status).toBe(200);
    }
    const before = await snapshotSignedState();
    vi.spyOn(Date, "now").mockReturnValue(exhausted.created * 1_000);
    const response = await callWorker(
      migrationPublishRequest(exhausted),
      workerEnv,
    );
    expect(response.status).toBe(409);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: { code: "publish_sequence_exhausted" },
    });
    expect(await snapshotSignedState()).toEqual(before);
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

  it("attributes a Game identity denial to the Game publisher", async () => {
    await env.DB.prepare(
      "INSERT INTO server_denials (server_id, created_at) VALUES (?, ?)",
    ).bind(
      gamePublisherFixture.server_id,
      1,
    ).run();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    const response = await callWorker(gamePublishRequest(), testEnvironment());

    expect(response.status).toBe(403);
    expect(warning).toHaveBeenCalledWith({
      event: "blacklist_match",
      route: "publish-game",
      dimension: "server_identity",
    });
    warning.mockRestore();
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
