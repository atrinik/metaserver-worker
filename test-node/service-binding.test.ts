import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import publisherFixture from "../test/fixtures/metaserver-publisher-v1.json";

const CURRENT_SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const PREVIOUS_SECRET = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
const COMPATIBILITY_DATE = "2026-08-05";
const TEST_TOKEN = "a".repeat(64);

let miniflare: Miniflare;
let harness: WorkerFetcher;

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
              const forwardedHeaders = new Headers();
              const allowed = publisher
                ? ["Atrinik-Publish-Sequence", "Atrinik-Server-ID", "Content-Digest", "Content-Type", "Signature", "Signature-Input"]
                : ["Authorization", "Connection", "Sec-WebSocket-Key", "Sec-WebSocket-Protocol", "Sec-WebSocket-Version", "Upgrade"];
              for (const name of allowed) {
                const value = headers.get(name);
                if (value !== null) forwardedHeaders.set(name, value);
              }
              if (publisher) forwardedHeaders.set("Content-Type", "application/json");
              if (!publisher) {
                forwardedHeaders.set("Atrinik-Internal-Source-Tag", "v1.test-a.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
                forwardedHeaders.set("Atrinik-Internal-Source-Tag-Previous", "v1.test-b.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
              }
              const service = publisher
                ? env.PUBLISH_COORDINATOR
                : env.RENDEZVOUS_COORDINATOR;
              const forwarded = new Request(target, {
                method: request.method,
                headers: forwardedHeaders,
                redirect: "manual",
                ...(request.body === null ? {} : { body: request.body }),
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
});

afterAll(async () => {
  await miniflare?.dispose();
});

describe("compiled named Worker Service Bindings", () => {
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
        `INSERT INTO server_owners
           (server_id, auth_key, current_ip, ip_changed_at, created_at,
            updated_at, rendezvous_generation, authentication_kind)
         VALUES (?, ?, '', 0, ?, ?, ?, 'signed-certificate-v1')`,
      ).bind(
        publisherFixture.server_id,
        publisherFixture.server_id.repeat(2),
        now,
        now,
        "b".repeat(64),
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
});

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
