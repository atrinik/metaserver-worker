import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleAccessResolve, handleAccessRouteMutation } from "../src/access-controller";
import { accessRouteIndex } from "../src/access-crypto";
import { authenticateAccessRoute } from "../src/access-route-auth";
import { handlePublisherCoordinatorRequest } from "../src/index";
import { publisherServiceRequest } from "../src/internal-service";
import publisherWorker from "../src/publisher-worker";
import routes from "./fixtures/access-routes-v1.json";
import game from "./fixtures/metaserver-game-publisher-v2.json";

const now = routes.signature_vectors[0].created;
const capability = "a".repeat(64);
const tables = ["access_grants", "access_route_receipts", "access_routes",
  "access_request_budgets", "publisher_nonces", "publisher_replay", "server_presence"];
const encode = (value: string) => new TextEncoder().encode(value);
const base64 = (value: Uint8Array) => btoa(String.fromCharCode(...value));
const base64urlHex = (value: string) => base64(Uint8Array.from(
  value.match(/../g)!, byte => parseInt(byte, 16))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

// The public protocol fixture certificate uses the P-256 generator (scalar 1).
// This deliberately public test key signs the Game variant of the same tuple.
async function gameRouteRequest(vector: typeof routes.signature_vectors[number]): Promise<Request> {
  const body = vector.body.replace('"profile":"classic"', '"profile":"game"');
  const path = vector.path.replace("/classic/", "/game/");
  const digest = `sha-256=:${base64(new Uint8Array(await crypto.subtle.digest("SHA-256", encode(body))))}:`;
  const key = await crypto.subtle.importKey("jwk", {
    kty: "EC", crv: "P-256",
    x: base64urlHex("6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296"),
    y: base64urlHex("4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5"),
    d: base64urlHex("0".repeat(63) + "1"),
  }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const signatureBase = vector.signature_base.replace(vector.path, path).replace(vector.content_digest, digest);
  const signature = base64(new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, key, encode(signatureBase))));
  const request = new Request(`https://${vector.authority}${path}`, {
    method: "POST", headers: {
      "Content-Type": "application/json", "Content-Digest": digest,
      "Atrinik-Server-ID": vector.server_id, "Atrinik-Publish-Sequence": vector.sequence,
      Signature: `atrinik=:${signature}:`, "Signature-Input": vector.signature_input,
    }, body,
  });
  // Prove denial is tested with a valid Game signature, not an auth failure.
  expect((await authenticateAccessRoute(request, encode(body), "game",
    vector.server_id, vector.authority, now)).payload.profile).toBe("game");
  return request;
}

function enabledEnvironment(): Env {
  const allowed = { limit: async () => ({ success: true }) } as RateLimit;
  return new Proxy(env, { get(target, property, receiver) {
    if (property === "PUBLISH_ENABLED" || property === "GAME_PUBLISH_ENABLED") return "enabled";
    if (["GLOBAL_RATE_LIMITER", "PUBLISH_IDENTITY_RATE_LIMITER", "ACCESS_ROUTE_RATE_LIMITER"].includes(String(property))) return allowed;
    return Reflect.get(target, property, receiver);
  } });
}

async function seed(profile: "classic" | "game", index?: string) {
  const publication = profile === "classic" ? "classic-v3" : "game-v2";
  await env.DB.prepare(`INSERT INTO publisher_replay(server_id,profile,last_sequence,last_nonce,commit_token,updated_at)
    VALUES(?,?,'1',?,?,?)`).bind(game.server_id, publication, "1".repeat(32), "0".repeat(64), now).run();
  await env.DB.prepare(`INSERT INTO server_presence(profile,server_id,last_seen,rendezvous_token_hash,
    rendezvous_generation,certificate,name,hostname,port,access_required)
    VALUES(?,?,?,?,?,?,'Private fixture',NULL,NULL,1)`)
    .bind(publication, game.server_id, now, "d".repeat(64), "c".repeat(64), game.certificate_der_base64).run();
  if (index !== undefined) await env.DB.prepare(`INSERT INTO access_routes(route_index,profile,server_id,
    token_id,token_revision,state,expires_at,reservation_id,reserved_until,created_at,revoked_at)
    VALUES(?,?,?,?,'1','active',NULL,?,?,?,NULL)`)
    .bind(index, profile, game.server_id, "e".repeat(32), "f".repeat(32), now + 60, now).run();
}

async function snapshot() {
  return Promise.all(tables.map(async table => ({ table,
    rows: (await env.DB.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all()).results,
  })));
}

async function expectUnavailable(response: Response) {
  expect(response.status).toBe(404);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.text()).toBe('{"error":{"code":"access_unavailable"}}');
}

beforeEach(async () => {
  vi.spyOn(Date, "now").mockReturnValue(now * 1000);
  await env.DB.batch(tables.map(table => env.DB.prepare(`DELETE FROM ${table}`)));
});

describe("Game access availability", () => {
  it.each(routes.signature_vectors)("denies signed Game $operation before auth, D1, budgets or room allocation", async vector => {
    await seed("game");
    const before = await snapshot();
    const request = await gameRouteRequest(vector);
    const prepare = vi.fn((sql: string) => env.DB.prepare(sql));
    const batch = vi.fn((statements: D1PreparedStatement[]) => env.DB.batch(statements));
    const accessLimit = vi.fn(async () => ({ success: true }));
    const getByName = vi.fn(() => { throw new Error("Game access must not allocate a room"); });
    const core = new Proxy(enabledEnvironment(), { get(target, property, receiver) {
      if (property === "DB") return { prepare, batch } as unknown as D1Database;
      if (property === "ACCESS_ROUTE_RATE_LIMITER") return { limit: accessLimit };
      if (property === "RENDEZVOUS") return { getByName };
      return Reflect.get(target, property, receiver);
    } });
    const context = createExecutionContext();
    const edge = new Proxy(core, { get(target, property, receiver) {
      if (property === "COORDINATOR") return {
        fetch: (internal: Request) => handlePublisherCoordinatorRequest(internal, core, context),
      };
      return Reflect.get(target, property, receiver);
    } }) as unknown as PublisherEnv;
    await expectUnavailable(await publisherWorker.fetch(request, edge));
    await waitOnExecutionContext(context);
    expect(prepare).not.toHaveBeenCalled(); expect(batch).not.toHaveBeenCalled();
    expect(accessLimit).not.toHaveBeenCalled(); expect(getByName).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
  });

  it("rejects an unread malformed Game body before authentication", async () => {
    const request = new Request(`https://${game.authority}/v1/access/servers/game/${game.server_id}/routes`,
      { method: "POST", body: "not a signed body" });
    await expectUnavailable(await handleAccessRouteMutation(request, enabledEnvironment(), "game",
      game.server_id, game.authority, now));
    expect(request.bodyUsed).toBe(false);
  });

  it("keeps a previously stored Game route inert after a denied revoke", async () => {
    const index = await accessRouteIndex(capability);
    await seed("game", index);
    const before = await snapshot();
    const request = await gameRouteRequest(routes.signature_vectors.find(vector => vector.operation === "revoke")!);
    await expectUnavailable(await handleAccessRouteMutation(request, enabledEnvironment(), "game",
      game.server_id, game.authority, now));
    expect(await snapshot()).toEqual(before);
    await expectUnavailable(await handleAccessResolve(new Request("https://rendezvous.meta.atrinik.org/v1/access/resolve", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schema: "atrinik-access-resolve-v1", routeCapability: capability, clientNonce: "b".repeat(64) }),
    }), enabledEnvironment(), now, 14400));
    expect(await env.DB.prepare("SELECT count(*) AS n FROM access_grants").first<number>("n")).toBe(0);
  });

  it("continues to reserve supported Classic routes with Game publication enabled", async () => {
    await seed("classic");
    const vector = routes.signature_vectors[0];
    const response = await handleAccessRouteMutation(new Request(`https://${vector.authority}${vector.path}`, {
      method: "POST", headers: {
        "Content-Type": "application/json", "Content-Digest": vector.content_digest,
        "Atrinik-Server-ID": vector.server_id, "Atrinik-Publish-Sequence": vector.sequence,
        Signature: vector.signature_header, "Signature-Input": vector.signature_input,
      }, body: vector.body,
    }), enabledEnvironment(), "classic", vector.server_id, vector.authority, now);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ outcome: "reserved" });
    expect(await env.DB.prepare("SELECT count(*) AS n FROM access_routes WHERE profile='classic'").first<number>("n")).toBe(1);
  });

  it("continues ordinary signed Game publication when its publication circuit is enabled", async () => {
    const context = createExecutionContext();
    const response = await handlePublisherCoordinatorRequest(publisherServiceRequest(new Request(
      `https://${game.authority}${game.path}`, { method: "POST", headers: {
        "Content-Type": game.content_type, "Content-Digest": game.content_digest,
        "Atrinik-Server-ID": game.server_id, "Atrinik-Publish-Sequence": game.sequence,
        Signature: game.signature_header, "Signature-Input": game.signature_input,
      }, body: game.body })), enabledEnvironment(), context);
    await waitOnExecutionContext(context);
    expect(response.status).toBe(200);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM server_presence WHERE profile='game-v2'").first<number>("n")).toBe(1);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM access_routes").first<number>("n")).toBe(0);
  });
});
