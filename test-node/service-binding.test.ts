import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import classicV2Fixture from "../test/fixtures/metaserver-classic-publisher-v2.json";
import publisherFixture from "../test/fixtures/metaserver-publisher-v1.json";

const CURRENT_SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const PREVIOUS_SECRET = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
const COMPATIBILITY_DATE = "2026-08-05";
const TEST_TOKEN = "a".repeat(64);

let miniflare: Miniflare;
let harness: WorkerFetcher;
let publisher: WorkerFetcher;
let rendezvous: WorkerFetcher;

beforeAll(async () => {
  const core = await readConfiguration("wrangler.jsonc");
  const publisherConfiguration = await readConfiguration(
    "wrangler.publisher.jsonc",
  );
  const rendezvousConfiguration = await readConfiguration(
    "wrangler.rendezvous.jsonc",
  );
  miniflare = new Miniflare({
    workers: [
      {
        name: "harness",
        modules: true,
        script: `
          export default {
            async fetch(request, env) {
              const headers = new Headers(request.headers);
              const target = headers.get("X-Atrinik-Test-Target");
              if (target === null) return new Response("Missing target", { status: 400 });
              const publisher = new URL(target).hostname === "publish.meta.atrinik.org";
              const edge = headers.get("X-Atrinik-Test-Edge") === "1";
              const forwardedHeaders = new Headers();
              const allowed = publisher
                ? ["Atrinik-Publish-Sequence", "Atrinik-Server-ID", "Content-Digest", "Content-Type", "Signature", "Signature-Input"]
                : ["Authorization", "Connection", "Sec-WebSocket-Key", "Sec-WebSocket-Protocol", "Sec-WebSocket-Version", "Upgrade"];
              if (edge) allowed.push("CF-Connecting-IP");
              for (const name of allowed) {
                const value = headers.get(name);
                if (value !== null) forwardedHeaders.set(name, value);
              }
              if (publisher) forwardedHeaders.set("Content-Type", "application/json");
              if (!publisher && !edge) {
                forwardedHeaders.set("Atrinik-Internal-Source-Tag", "v1.test-a.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
                forwardedHeaders.set("Atrinik-Internal-Source-Tag-Previous", "v1.test-b.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
              }
              const service = edge
                ? (publisher ? env.PUBLISH_EDGE : env.RENDEZVOUS_EDGE)
                : (publisher ? env.PUBLISH_COORDINATOR : env.RENDEZVOUS_COORDINATOR);
              const body = request.body === null
                ? undefined
                : await request.arrayBuffer();
              const forwarded = new Request(target, {
                method: request.method,
                headers: forwardedHeaders,
                redirect: "manual",
                ...(body === undefined ? {} : { body }),
              });
              return service.fetch(forwarded);
            },
          };
        `,
        compatibilityDate: COMPATIBILITY_DATE,
        compatibilityFlags: ["nodejs_compat", "no_web_socket_compression"],
        serviceBindings: {
          PUBLISH_COORDINATOR: {
            name: "core",
            entrypoint: "PublisherCoordinator",
          },
          RENDEZVOUS_COORDINATOR: {
            name: "core",
            entrypoint: "RendezvousCoordinator",
          },
          PUBLISH_EDGE: "publisher",
          RENDEZVOUS_EDGE: "rendezvous",
        },
      },
      {
        name: "publisher",
        modules: true,
        scriptPath: "dist/publisher/publisher-worker.js",
        compatibilityDate: COMPATIBILITY_DATE,
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          ...publisherConfiguration.vars,
          PUBLISH_ENABLED: "enabled",
          GAME_PUBLISH_ENABLED: "enabled",
          SOURCE_TAG_KEY_CURRENT: CURRENT_SECRET,
          SOURCE_TAG_KEY_PREVIOUS: PREVIOUS_SECRET,
        },
        ratelimits: rateLimits(publisherConfiguration),
        serviceBindings: {
          COORDINATOR: {
            name: "core",
            entrypoint: "PublisherCoordinator",
          },
        },
      },
      {
        name: "rendezvous",
        modules: true,
        scriptPath: "dist/rendezvous/rendezvous-worker.js",
        compatibilityDate: COMPATIBILITY_DATE,
        compatibilityFlags: ["nodejs_compat", "no_web_socket_compression"],
        bindings: {
          ...rendezvousConfiguration.vars,
          RENDEZVOUS_ENABLED: "enabled",
          SOURCE_TAG_KEY_CURRENT: CURRENT_SECRET,
          SOURCE_TAG_KEY_PREVIOUS: PREVIOUS_SECRET,
        },
        ratelimits: rateLimits(rendezvousConfiguration),
        serviceBindings: {
          COORDINATOR: {
            name: "core",
            entrypoint: "RendezvousCoordinator",
          },
        },
      },
      {
        name: "core",
        modules: true,
        scriptPath: "dist/core/index.js",
        compatibilityDate: COMPATIBILITY_DATE,
        compatibilityFlags: ["nodejs_compat", "no_web_socket_compression"],
        bindings: {
          ...core.vars,
          PUBLISH_ENABLED: "enabled",
          GAME_PUBLISH_ENABLED: "enabled",
          RENDEZVOUS_ENABLED: "enabled",
          SOURCE_TAG_KEY_CURRENT: CURRENT_SECRET,
          SOURCE_TAG_KEY_PREVIOUS: PREVIOUS_SECRET,
        },
        d1Databases: { DB: "service-boundary-test" },
        durableObjects: {
          RENDEZVOUS: {
            className: "RendezvousRoom",
            useSQLite: true,
          },
          DIRECTORY_BUILDER: {
            className: "DirectoryBuilder",
            useSQLite: true,
          },
        },
        r2Buckets: {
          DIRECTORY_GENERATIONS: "service-boundary-generations",
          CLASSIC_DIRECTORY_PUBLIC: "service-boundary-classic",
          GAME_DIRECTORY_PUBLIC: "service-boundary-game",
        },
        analyticsEngineDatasets: {
          RENDEZVOUS_METRICS: { dataset: "service_boundary_rendezvous" },
          DIRECTORY_METRICS: { dataset: "service_boundary_directory" },
        },
        ratelimits: rateLimits(core),
      },
    ],
  });

  const bindings = await miniflare.getBindings<{ DB: D1Database }>("core");
  for (const migration of await readD1Migrations("migrations")) {
    await bindings.DB.batch(
      migration.queries.map((query) => bindings.DB.prepare(query)),
    );
  }
  harness = await miniflare.getWorker("harness") as unknown as WorkerFetcher;
  publisher = await miniflare.getWorker("publisher") as unknown as WorkerFetcher;
  rendezvous = await miniflare.getWorker("rendezvous") as unknown as WorkerFetcher;
});

afterAll(async () => {
  await miniflare?.dispose();
});

describe("compiled named Worker Service Bindings", () => {
  it("carries both credential-free production canary envelopes to core", async () => {
    const serverId = "0".repeat(64);
    const publishResponse = await fetchPublisherCanary();
    expect(publishResponse.status).toBe(401);
    const publishBody = await publishResponse.json() as {
      error?: { code?: string };
    };
    expect(publishBody.error?.code).toBe("unauthorized");

    const rendezvousTarget =
      `https://rendezvous.meta.atrinik.org/v1/classic/servers/${serverId}?role=server`;
    const rendezvousResponse = await harness.fetch(
      "http://service-binding.test/forward",
      {
        headers: {
          "CF-Connecting-IP": "192.0.2.212",
          Connection: "Upgrade",
          "Sec-WebSocket-Key": "AAAAAAAAAAAAAAAAAAAAAA==",
          "Sec-WebSocket-Version": "13",
          Upgrade: "websocket",
          "X-Atrinik-Test-Edge": "1",
          "X-Atrinik-Test-Target": rendezvousTarget,
        },
      },
    );
    expect(rendezvousResponse.status).toBe(404);
    expect(await rendezvousResponse.text()).toBe("Server is offline\n");
  });

  it("carries a signed request without public source state", async () => {
    const target = `https://${publisherFixture.authority}${publisherFixture.path}`;
    const response = await harness.fetch("http://service-binding.test/forward", {
        method: "POST",
        headers: {
          "Atrinik-Publish-Sequence": publisherFixture.sequence,
          "Atrinik-Server-ID": publisherFixture.server_id,
          "CF-Connecting-IP": "192.0.2.210",
          Cookie: "must-not-cross=value",
          "Content-Digest": publisherFixture.content_digest,
          "Content-Type": publisherFixture.content_type,
          "X-Atrinik-Test-Target": target,
          Signature: "atrinik=:AAAA:",
          "Signature-Input": publisherFixture.signature_input,
        },
        body: publisherFixture.body,
      });

    expect(response.status, await response.clone().text()).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: {
        code: "unauthorized",
        message: "Authentication failed.",
      },
    });
  });

  it("hands a real WebSocket 101 and selected subprotocol across the binding", async () => {
    const bindings = await miniflare.getBindings<{ DB: D1Database }>("core");
    const now = Math.floor(Date.now() / 1_000);
    const tokenHash = createHash("sha256").update(TEST_TOKEN).digest("hex");
    await bindings.DB.batch([
      bindings.DB.prepare(
        `INSERT INTO publisher_replay
           (server_id, profile, last_sequence, last_nonce, commit_token, updated_at)
         VALUES (?, 'classic-v1', '1', ?, ?, ?)`,
      ).bind(
        publisherFixture.server_id,
        "1".repeat(32),
        "1".repeat(64),
        now,
      ),
      bindings.DB.prepare(
        `INSERT INTO server_presence
           (profile, server_id, last_seen, rendezvous_token_hash,
            rendezvous_generation)
         VALUES ('classic-v1', ?, ?, ?, ?)`,
      ).bind(
        publisherFixture.server_id,
        now,
        tokenHash,
        "b".repeat(64),
      ),
      bindings.DB.prepare(
        `INSERT INTO directory_entries
           (profile, server_id, name, players_count, version, text_comment,
            hostname, port, quic_cert_sha256, password_required,
            directory_fingerprint)
         VALUES ('classic-v1', ?, 'Binding test', 0, '1.0', '', NULL, NULL,
                 ?, 1, ?)`,
      ).bind(
        publisherFixture.server_id,
        publisherFixture.server_id,
        "c".repeat(64),
      ),
    ]);

    const protocol = "atrinik-classic-rendezvous-invite-v1";
    const target = `https://rendezvous.meta.atrinik.org/v1/classic/servers/${publisherFixture.server_id}?role=server`;
    const response = await harness.fetch("http://service-binding.test/forward", {
        headers: {
          Authorization: `Bearer ${TEST_TOKEN}`,
          "CF-Connecting-IP": "192.0.2.211",
          Cookie: "must-not-cross=value",
          "X-Atrinik-Test-Target": target,
          "Sec-WebSocket-Protocol": protocol,
          Upgrade: "websocket",
        },
      });

    if (response.status !== 101) {
      throw new Error(`${response.status}: ${await response.text()}`);
    }
    expect(response.status).toBe(101);
    expect(response.headers.get("Sec-WebSocket-Protocol")).toBe(protocol);
    expect(response.webSocket).not.toBeNull();
    response.webSocket?.accept();
    response.webSocket?.close(1000, "Test complete");
  });

  it("keeps the v2 publisher canary valid after global v1 retirement", async () => {
    const bindings = await miniflare.getBindings<{ DB: D1Database }>("core");
    await bindings.DB.prepare(
      `UPDATE classic_receiver_mode
          SET mode = 'classic-v1-retired', activated_at = ?
        WHERE singleton = 1 AND mode = 'classic-v1-accepting'`,
    ).bind(Math.floor(Date.now() / 1_000)).run();

    const response = await fetchPublisherCanary();
    expect(response.status, await response.clone().text()).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "unauthorized" },
    });
  });
});

async function fetchPublisherCanary(): Promise<Response> {
  const vector = classicV2Fixture.positive[0];
  const target = `https://${classicV2Fixture.authority}${vector.path}`;
  return await harness.fetch("http://service-binding.test/forward", {
    method: "POST",
    headers: {
      "CF-Connecting-IP": "192.0.2.211",
      "Atrinik-Publish-Sequence": vector.sequence,
      "Atrinik-Server-ID": classicV2Fixture.server_id,
      "Content-Digest": vector.content_digest,
      "Content-Type": classicV2Fixture.content_type,
      Signature: `atrinik=:${"A".repeat(86)}==:`,
      "Signature-Input": vector.signature_input,
      "X-Atrinik-Test-Edge": "1",
      "X-Atrinik-Test-Target": target,
    },
    body: new TextEncoder().encode(vector.body),
  });
}

interface WranglerConfiguration {
  readonly vars: Readonly<Record<string, string>>;
  readonly ratelimits: readonly {
    readonly name: string;
    readonly namespace_id: string;
    readonly simple: { readonly limit: number; readonly period: 10 | 60 };
  }[];
}

interface WorkerFetcher {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

async function readConfiguration(name: string): Promise<WranglerConfiguration> {
  return JSON.parse(await readFile(name, "utf8")) as WranglerConfiguration;
}

function rateLimits(configuration: WranglerConfiguration): Record<string, {
  readonly namespace_id: string;
  readonly simple: { readonly limit: number; readonly period: 10 | 60 };
}> {
  return Object.fromEntries(configuration.ratelimits.map((binding) => [
    binding.name,
    {
      namespace_id: `test-${binding.namespace_id}`,
      simple: { limit: 1_000, period: binding.simple.period },
    },
  ]));
}
