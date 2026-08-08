import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index";
import {
  deriveStoredKey,
  deriveUpdateProof,
  sha256Hex,
} from "../src/protocol";

const BASE_URL = "https://meta.example.test";
const SOURCE_IP = "192.0.2.10";
const INITIAL_SERVER_ID = "1".repeat(64);
const RAW_KEY = "a".repeat(128);
const COTP = "b".repeat(128);
const PERSISTENCE_TEST_TRIGGERS = [
  "server_owners_test_ignore_update",
  "servers_test_ignore_insert",
] as const;
let activeSourceIp = SOURCE_IP;
let activeServerId = INITIAL_SERVER_ID;
let sourceSequence = 20;

interface StoredOtpSource {
  readonly source_ip: string;
  readonly source_tag: string | null;
  readonly source_tag_previous: string | null;
}

async function callWorker(
  request: Request,
  workerEnv: Env = env,
): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, workerEnv, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

function overrideEnv(
  overrides: Partial<Record<keyof Env, unknown>>,
): Env {
  return new Proxy(env, {
    get(target, property, receiver) {
      if (Object.prototype.hasOwnProperty.call(overrides, property)) {
        return Reflect.get(overrides, property);
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

function nextWebSocketMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.addEventListener("message", (event) => resolve(String(event.data)), {
      once: true,
    });
    socket.addEventListener("error", () => reject(new Error("WebSocket error")), {
      once: true,
    });
  });
}

function closeAcceptedWebSocket(response: Response): void {
  const socket = response.webSocket;
  if (socket === null) {
    throw new Error("Accepted rendezvous response returned no WebSocket");
  }
  socket.accept();
  socket.close(1000, "Test complete");
}

function request(
  path: string,
  init: RequestInit = {},
  sourceIp = activeSourceIp,
): Request {
  const headers = new Headers(init.headers);
  headers.set("CF-Connecting-IP", sourceIp);
  return new Request(`${BASE_URL}${path}`, { ...init, headers });
}

async function issueOtp(
  sourceIp = activeSourceIp,
  workerEnv: Env = env,
): Promise<string> {
  const response = await callWorker(
    request("/index.wsgi/otp", {}, sourceIp),
    workerEnv,
  );
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).toMatch(/^\{"otp": "[0-9a-f]{64}"\}$/);
  const token = (JSON.parse(body) as { otp: string }).otp;
  const stored = await readStoredOtp(token, workerEnv);
  expect(stored?.source_ip).toBe("");
  expect(stored?.source_tag).toMatch(/^v1\.[A-Za-z0-9_-]{1,32}\.[A-Za-z0-9_-]{43}$/);
  expect(stored?.source_tag_previous).toMatch(
    /^v1\.[A-Za-z0-9_-]{1,32}\.[A-Za-z0-9_-]{43}$/,
  );
  expect(stored?.source_tag_previous).not.toBe(stored?.source_tag);
  expect(JSON.stringify(stored)).not.toContain(sourceIp);
  return token;
}

async function readStoredOtp(
  token: string,
  workerEnv: Env = env,
): Promise<StoredOtpSource | null> {
  return workerEnv.DB.prepare(
    `SELECT source_ip, source_tag, source_tag_previous
       FROM one_time_tokens
      WHERE token_hash = ?`,
  )
    .bind(await sha256Hex(token))
    .first<StoredOtpSource>();
}

function updateForm(
  otp: string,
  key: string,
  serverId = activeServerId,
): FormData {
  const form = new FormData();
  form.set("server_id", serverId);
  form.set("quic_host", "198.51.100.20");
  form.set("quic_port", "1730");
  form.set("quic_cert_sha256", serverId);
  form.set("num_players", "2");
  form.set("name", "Test Server");
  form.set("version", "4.0.0");
  form.set("text_comment", "Worker integration test");
  form.set("otp", otp);
  form.set("cotp", COTP);
  form.set("key", key);
  form.set("registration", "1");
  form.set("public", "1");
  return form;
}

async function postUpdate(
  form: FormData,
  sourceIp = activeSourceIp,
  workerEnv: Env = env,
): Promise<Response> {
  return callWorker(
    request("/index.wsgi/update", { method: "POST", body: form }, sourceIp),
    workerEnv,
  );
}

beforeEach(async () => {
  sourceSequence += 1;
  activeSourceIp = `192.0.2.${sourceSequence}`;
  activeServerId = sourceSequence.toString(16).padStart(64, "0");
  for (const trigger of PERSISTENCE_TEST_TRIGGERS) {
    await env.DB.prepare(`DROP TRIGGER IF EXISTS ${trigger}`).run();
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM servers"),
    env.DB.prepare("DELETE FROM server_owners"),
    env.DB.prepare("DELETE FROM one_time_tokens"),
    env.DB.prepare("DELETE FROM rate_limits"),
    env.DB.prepare("DELETE FROM request_budgets"),
    env.DB.prepare("DELETE FROM server_blacklist"),
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("metaserver Worker", () => {
  it("serves health and an empty QUIC directory", async () => {
    const health = await callWorker(request("/"));
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ service: "Atrinik metaserver", status: "ok" });

    const listing = await callWorker(request("/v2/servers"));
    expect(listing.headers.get("Content-Type")).toBe("application/xml; charset=utf-8");
    expect(await listing.text()).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Servers protocol="3"></Servers>',
    );
    expect((await callWorker(request("/index.wsgi"))).status).toBe(404);
  });

  it("keeps non-rendezvous routes independent of room-only policy", async () => {
    const missingRoomPolicy = overrideEnv({
      RENDEZVOUS_CLIENT_ROLLING_LIMIT: undefined,
      RENDEZVOUS_ACTIVE_CLIENT_LIMIT: undefined,
      RENDEZVOUS_CLIENT_SESSION_SECONDS: undefined,
    });
    const health = await callWorker(request("/"), missingRoomPolicy);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({
      service: "Atrinik metaserver",
      status: "ok",
    });
  });

  it("rejects invalid room policy before rendezvous admission work", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const globalLimit = vi.fn(async () => ({ success: true }));
    const rendezvousLimit = vi.fn(async () => ({ success: true }));
    const getByName = vi.fn(() => {
      throw new Error("Rendezvous Durable Object must not be invoked");
    });
    const invalid = overrideEnv({
      RENDEZVOUS_CLIENT_ROLLING_LIMIT: undefined,
      GLOBAL_RATE_LIMITER: { limit: globalLimit },
      RENDEZVOUS_CLIENT_RATE_LIMITER: { limit: rendezvousLimit },
      RENDEZVOUS: { getByName },
    });

    const response = await callWorker(request(
      `/v2/rendezvous/${activeServerId}?role=client`,
      { headers: { Upgrade: "websocket" } },
    ), invalid);

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(await response.json()).toEqual({
      error: {
        code: "request_control_unavailable",
        message: "Request admission is temporarily unavailable.",
      },
    });
    expect(globalLimit).not.toHaveBeenCalled();
    expect(rendezvousLimit).not.toHaveBeenCalled();
    expect(getByName).not.toHaveBeenCalled();
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM request_budgets",
    ).first<number>("count")).toBe(0);
  });

  it("rejects an alternate authority before request-control work", async () => {
    const foreign = new Request("https://example.test/v2/servers", {
      headers: { "CF-Connecting-IP": activeSourceIp },
    });
    const response = await callWorker(foreign);
    expect(response.status).toBe(421);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      error: { code: "misdirected_request" },
    });
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM request_budgets",
    ).first<number>("count")).toBe(0);
  });

  it("fails closed when a configured limit exceeds policy", async () => {
    const invalid = overrideEnv({ COMPAT_DIRECTORY_DAILY_LIMIT: "101" });
    const response = await callWorker(request("/v2/servers"), invalid);
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(await response.json()).toEqual({
      error: {
        code: "request_control_unavailable",
        message: "Request admission is temporarily unavailable.",
      },
    });
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM request_budgets",
    ).first<number>("count")).toBe(0);
  });

  it("fails closed and reports an invalid compatibility hostname as configuration", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const invalid = overrideEnv({ COMPAT_HOSTNAME: "META.EXAMPLE.TEST" });

    const response = await callWorker(request("/v2/servers"), invalid);
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(await response.json()).toEqual({
      error: {
        code: "request_control_unavailable",
        message: "Request admission is temporarily unavailable.",
      },
    });
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM request_budgets",
    ).first<number>("count")).toBe(0);
    expect(logged.mock.calls).toEqual([[{
      event: "unexpected_error",
      handler: "fetch",
      code: "request_control_configuration",
    }]]);
  });

  it("returns stable global and route-daily rate-limit responses", async () => {
    for (let requestNumber = 0; requestNumber < 8; requestNumber += 1) {
      expect((await callWorker(request("/v2/servers"))).status).toBe(200);
    }
    const daily = await callWorker(request("/v2/servers"));
    expect(daily.status).toBe(429);
    const dailyBody = await daily.json<{
      error: { reason: string; retry_after_seconds: number };
    }>();
    expect(dailyBody.error.reason).toBe("compat_directory_daily");
    expect(daily.headers.get("Retry-After")).toBe(
      String(dailyBody.error.retry_after_seconds),
    );
    expect(await env.DB.prepare(
      `SELECT COUNT(*) AS rows, MIN(request_count) AS minimum,
              MAX(request_count) AS maximum
         FROM request_budgets
        WHERE scope = 'compat-directory'`,
    ).first<{ rows: number; minimum: number; maximum: number }>()).toEqual({
      rows: 2,
      minimum: 8,
      maximum: 8,
    });

    const statusSource = `192.0.2.${sourceSequence + 99}`;
    for (let requestNumber = 0; requestNumber < 8; requestNumber += 1) {
      expect((await callWorker(request("/", {}, statusSource))).status).toBe(200);
    }
    const statusDaily = await callWorker(request("/", {}, statusSource));
    expect(statusDaily.status).toBe(429);
    expect(await statusDaily.json()).toMatchObject({
      error: { reason: "compat_status_daily" },
    });

    activeSourceIp = `192.0.2.${sourceSequence + 100}`;
    for (let requestNumber = 0; requestNumber < 10; requestNumber += 1) {
      expect((await callWorker(request("/index.wsgi/otp"))).status).toBe(200);
    }
    const burst = await callWorker(request("/index.wsgi/otp"));
    expect(burst.status).toBe(429);
    expect(burst.headers.get("Retry-After")).toBe("60");
    expect(await burst.json()).toMatchObject({
      error: {
        code: "rate_limited",
        reason: "global_burst",
        retry_after_seconds: 60,
      },
    });
  });

  it("emits only curated redacted diagnostics and keeps high-volume outcomes silent", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect((await callWorker(request("/"))).status).toBe(200);
    expect((await callWorker(request("/v2/servers"))).status).toBe(200);
    expect((await callWorker(request("/missing"))).status).toBe(404);
    expect(debug).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();

    const wrongMethod = await callWorker(request("/", { method: "POST" }));
    expect(wrongMethod.status).toBe(405);
    expect(warn).toHaveBeenLastCalledWith({
      event: "request_rejected",
      route: "unclassified",
      code: "method_not_allowed",
      status: 405,
    });

    const ambiguous = await callWorker(request("/", {
      headers: { Host: "meta.example.test, meta.example.test" },
    }));
    expect(ambiguous.status).toBe(400);
    expect(warn).toHaveBeenLastCalledWith({
      event: "request_rejected",
      route: "unclassified",
      code: "ambiguous_header",
      status: 400,
    });
    expect(warn).toHaveBeenCalledTimes(2);

    warn.mockClear();
    const invalidSource = request("/", {}, "not-an-ip-address");
    expect((await callWorker(invalidSource)).status).toBe(400);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenLastCalledWith({
      event: "request_rejected",
      route: "compat-status",
      code: "bad_request",
      status: 400,
    });

    warn.mockClear();
    await env.DB.prepare(
      "INSERT INTO server_blacklist (pattern, reason, created_at) VALUES (?, ?, ?)",
    ).bind(`${activeServerId.slice(0, 8)}*`, "test identity block", 1).run();
    expect((await postUpdate(updateForm(await issueOtp(), RAW_KEY))).status).toBe(403);
    expect(warn.mock.calls).toEqual([
      [{
        event: "blacklist_match",
        route: "compat-update",
        dimension: "server_identity",
      }],
      [{
        event: "request_rejected",
        route: "compat-update",
        code: "forbidden",
        status: 403,
      }],
    ]);
    const serializedWarnings = JSON.stringify(warn.mock.calls);
    for (const forbidden of [
      activeSourceIp,
      activeServerId,
      "test identity block",
      RAW_KEY,
    ]) {
      expect(serializedWarnings).not.toContain(forbidden);
    }

    warn.mockClear();
    await env.DB.prepare("DELETE FROM server_blacklist").run();
    await env.DB.prepare(
      "INSERT INTO server_blacklist (pattern, reason, created_at) VALUES (?, ?, ?)",
    ).bind("192.0.2.*", "test source block", 1).run();
    expect((await postUpdate(updateForm(await issueOtp(), RAW_KEY))).status).toBe(403);
    expect(warn.mock.calls).toEqual([
      [{
        event: "blacklist_match",
        route: "compat-update",
        dimension: "request_source",
      }],
      [{
        event: "request_rejected",
        route: "compat-update",
        code: "forbidden",
        status: 403,
      }],
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("test source block");

    warn.mockClear();
    const limitedSource = "198.51.100.240";
    for (let requestNumber = 0; requestNumber < 8; requestNumber += 1) {
      expect((await callWorker(request("/", {}, limitedSource))).status).toBe(200);
    }
    expect((await callWorker(request("/", {}, limitedSource))).status).toBe(429);

    const disabled = overrideEnv({ COMPAT_STATUS_ENABLED: "disabled" });
    expect((await callWorker(
      request("/", {}, "198.51.100.241"),
      disabled,
    )).status).toBe(503);

    expect(debug).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("emits a bounded diagnostic for a request-control dependency failure", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const sensitiveCause = `must-not-log-${activeSourceIp}-${activeServerId}`;
    const unavailable = overrideEnv({
      GLOBAL_RATE_LIMITER: {
        limit: async () => {
          throw new Error(sensitiveCause);
        },
      } as RateLimit,
    });

    const response = await callWorker(request("/"), unavailable);
    expect(response.status).toBe(503);
    expect(logged.mock.calls).toEqual([[{
      event: "unexpected_error",
      handler: "fetch",
      code: "request_control_dependency",
      dependency: "native-rate-limit",
    }]]);
    expect(JSON.stringify(logged.mock.calls)).not.toContain(sensitiveCause);
  });

  it("separates operational D1 failures from programming failures", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const failingDatabase = (message: string): D1Database =>
      new Proxy(env.DB, {
        get(target, property, receiver) {
          if (property === "prepare") {
            return () => {
              throw new Error(message);
            };
          }
          return Reflect.get(target, property, receiver);
        },
      });

    const operationalDetail = `network-reset-${activeSourceIp}-${activeServerId}`;
    const operational = overrideEnv({
      DB: failingDatabase(operationalDetail),
    });
    expect((await callWorker(request("/"), operational)).status).toBe(503);
    expect(logged.mock.calls).toEqual([[{
      event: "unexpected_error",
      handler: "fetch",
      code: "request_control_dependency",
      dependency: "d1",
    }]]);
    expect(JSON.stringify(logged.mock.calls)).not.toContain(operationalDetail);

    logged.mockClear();
    const programmingDetail = `D1_TYPE_ERROR: ${RAW_KEY}`;
    const programming = overrideEnv({
      DB: failingDatabase(programmingDetail),
    });
    expect((await callWorker(
      request("/", {}, "198.51.100.199"),
      programming,
    )).status).toBe(500);
    expect(logged.mock.calls).toEqual([[{
      event: "unexpected_error",
      handler: "fetch",
      code: "unhandled_exception",
    }]]);
    expect(JSON.stringify(logged.mock.calls)).not.toContain(programmingDetail);
  });

  it("registers and accepts a second authenticated identity update", async () => {
    const firstOtp = await issueOtp();
    expect((await postUpdate(updateForm(firstOtp, RAW_KEY))).status).toBe(200);

    const storedKey = await deriveStoredKey(RAW_KEY, activeServerId);
    const owner = await env.DB.prepare(
      "SELECT server_id, auth_key FROM server_owners WHERE server_id = ?",
    )
      .bind(activeServerId)
      .first<{ server_id: string; auth_key: string }>();
    expect(owner).toEqual({ server_id: activeServerId, auth_key: storedKey });
    expect(await env.DB.prepare(
      "SELECT current_ip FROM server_owners WHERE server_id = ?",
    ).bind(activeServerId).first<string>("current_ip")).toBe("");
    expect(await env.DB.prepare(
      "SELECT source_ip FROM servers WHERE server_id = ?",
    ).bind(activeServerId).first<string>("source_ip")).toBe("");

    const secondOtp = await issueOtp();
    const proof = await deriveUpdateProof(secondOtp, storedKey, COTP);
    const secondForm = updateForm(secondOtp, proof);
    secondForm.set("registration", "0");
    secondForm.set("quic_host", "198.51.100.21");
    secondForm.set("quic_port", "1731");
    expect((await postUpdate(secondForm)).status).toBe(200);

    const body = await (await callWorker(request("/v2/servers"))).text();
    expect(body).toContain(`<Id>${activeServerId}</Id>`);
    expect(body).toContain("<Address>198.51.100.21</Address><Port>1731</Port>");
    expect(body).not.toContain("198.51.100.20");
  });

  it("preserves the token and listing when the identity budget rejects", async () => {
    expect((await postUpdate(updateForm(await issueOtp(), RAW_KEY))).status).toBe(200);
    const storedKey = await deriveStoredKey(RAW_KEY, activeServerId);
    const token = await issueOtp();
    const proof = await deriveUpdateProof(token, storedKey, COTP);
    const now = Math.floor(Date.now() / 1_000);
    const windowStart = Math.floor(now / 86_400) * 86_400;
    await env.DB.prepare(
      `INSERT INTO request_budgets
         (actor_key, scope, window_start, request_count, expires_at)
       VALUES (?, 'compat-update-server', ?, 8, ?)`,
    ).bind(activeServerId, windowStart, windowStart + 86_400).run();

    const rejectedForm = updateForm(token, proof);
    rejectedForm.set("registration", "0");
    rejectedForm.set("quic_host", "198.51.100.99");
    const rejected = await postUpdate(rejectedForm);
    expect(rejected.status).toBe(429);
    expect(await rejected.json()).toMatchObject({
      error: { reason: "compat_update_server_daily" },
    });
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM one_time_tokens WHERE token_hash = ?",
    ).bind(await sha256Hex(token)).first<number>("count")).toBe(1);
    expect(await env.DB.prepare(
      "SELECT quic_host FROM servers WHERE server_id = ?",
    ).bind(activeServerId).first<string>("quic_host")).toBe("198.51.100.20");

    await env.DB.prepare(
      "DELETE FROM request_budgets WHERE actor_key = ? AND scope = 'compat-update-server'",
    ).bind(activeServerId).run();
    const retryForm = updateForm(token, proof);
    retryForm.set("registration", "0");
    retryForm.set("quic_host", "198.51.100.99");
    expect((await postUpdate(retryForm)).status).toBe(200);
  });

  it("atomically consumes one overlap-key token under concurrency", async () => {
    expect((await postUpdate(updateForm(await issueOtp(), RAW_KEY))).status).toBe(200);
    const storedKey = await deriveStoredKey(RAW_KEY, activeServerId);
    const token = await issueOtp();
    const proof = await deriveUpdateProof(token, storedKey, COTP);
    const first = updateForm(token, proof);
    const second = updateForm(token, proof);
    first.set("registration", "0");
    second.set("registration", "0");

    const responses = await Promise.all([postUpdate(first), postUpdate(second)]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 401]);
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM one_time_tokens WHERE token_hash = ?",
    ).bind(await sha256Hex(token)).first<number>("count")).toBe(0);
  });

  it("atomically consumes one legacy raw-source token under concurrency", async () => {
    expect((await postUpdate(updateForm(await issueOtp(), RAW_KEY))).status).toBe(200);
    const storedKey = await deriveStoredKey(RAW_KEY, activeServerId);
    const token = "concurrent-legacy-token";
    const now = Math.floor(Date.now() / 1_000);
    await env.DB.prepare(
      `INSERT INTO one_time_tokens
         (token_hash, source_ip, expires_at, created_at)
       VALUES (?, ?, ?, ?)`,
    ).bind(await sha256Hex(token), activeSourceIp, now + 60, now).run();
    const proof = await deriveUpdateProof(token, storedKey, COTP);
    const first = updateForm(token, proof);
    const second = updateForm(token, proof);
    first.set("registration", "0");
    second.set("registration", "0");

    const responses = await Promise.all([postUpdate(first), postUpdate(second)]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 401]);
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM one_time_tokens WHERE token_hash = ?",
    ).bind(await sha256Hex(token)).first<number>("count")).toBe(0);
  });

  it("rejects a replayed one-time token", async () => {
    const otp = await issueOtp();
    expect((await postUpdate(updateForm(otp, RAW_KEY))).status).toBe(200);
    const storedKey = await deriveStoredKey(RAW_KEY, activeServerId);

    const replayProof = await deriveUpdateProof(otp, storedKey, COTP);
    const replay = updateForm(otp, replayProof);
    replay.set("registration", "0");
    expect((await postUpdate(replay)).status).toBe(401);
  });

  it("rejects an expired one-time token", async () => {
    expect((await postUpdate(updateForm(await issueOtp(), RAW_KEY))).status).toBe(200);
    const storedKey = await deriveStoredKey(RAW_KEY, activeServerId);
    const expired = await issueOtp();
    const expiredProof = await deriveUpdateProof(expired, storedKey, COTP);
    const expiredForm = updateForm(expired, expiredProof);
    expiredForm.set("registration", "0");
    await env.DB.prepare("UPDATE one_time_tokens SET expires_at = 0").run();
    expect((await postUpdate(expiredForm)).status).toBe(401);
  });

  it("does not burn a tagged token submitted from the wrong source", async () => {
    expect((await postUpdate(updateForm(await issueOtp(), RAW_KEY))).status).toBe(200);
    const storedKey = await deriveStoredKey(RAW_KEY, activeServerId);
    const wrongSourceToken = await issueOtp();
    const wrongSourceProof = await deriveUpdateProof(
      wrongSourceToken,
      storedKey,
      COTP,
    );
    const wrongSourceForm = updateForm(wrongSourceToken, wrongSourceProof);
    wrongSourceForm.set("registration", "0");
    expect((await postUpdate(
      wrongSourceForm,
      "198.51.100.11",
    )).status).toBe(401);
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM one_time_tokens WHERE token_hash = ?",
    ).bind(await sha256Hex(wrongSourceToken)).first<number>("count")).toBe(1);
    expect((await postUpdate(wrongSourceForm)).status).toBe(200);
  });

  it("does not burn a token when the owner proof is incorrect", async () => {
    expect((await postUpdate(updateForm(await issueOtp(), RAW_KEY))).status).toBe(200);
    const storedKey = await deriveStoredKey(RAW_KEY, activeServerId);
    const wrongKeyOtp = await issueOtp();
    const wrongProof = await deriveUpdateProof(wrongKeyOtp, storedKey, "c".repeat(128));
    const wrongKeyForm = updateForm(wrongKeyOtp, wrongProof);
    wrongKeyForm.set("registration", "0");
    expect((await postUpdate(wrongKeyForm)).status).toBe(401);
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM one_time_tokens WHERE token_hash = ?",
    ).bind(await sha256Hex(wrongKeyOtp)).first<number>("count")).toBe(1);

    const correctProof = await deriveUpdateProof(wrongKeyOtp, storedKey, COTP);
    const correctForm = updateForm(wrongKeyOtp, correctProof);
    correctForm.set("registration", "0");
    expect((await postUpdate(correctForm)).status).toBe(200);
  });

  it("never infers a public QUIC endpoint from the request source", async () => {
    const form = updateForm(await issueOtp(), RAW_KEY);
    form.delete("quic_host");
    expect((await postUpdate(form)).status).toBe(200);

    const stored = await env.DB.prepare(
      "SELECT source_ip, quic_host FROM servers WHERE server_id = ?",
    ).bind(activeServerId).first<{ source_ip: string; quic_host: string }>();
    expect(stored).toEqual({ source_ip: "", quic_host: "" });
    expect(JSON.stringify(stored)).not.toContain(activeSourceIp);
    const listing = await (await callWorker(request("/v2/servers"))).text();
    expect(listing).toContain("<Address></Address>");
    expect(listing).not.toContain(activeSourceIp);
  });

  it("consumes an already-issued legacy raw-source token during migration", async () => {
    const token = "legacy-token";
    await env.DB.prepare(
      `INSERT INTO one_time_tokens
         (token_hash, source_ip, expires_at, created_at)
       VALUES (?, ?, ?, ?)`,
    ).bind(
      await sha256Hex(token),
      activeSourceIp,
      Math.floor(Date.now() / 1_000) + 60,
      Math.floor(Date.now() / 1_000),
    ).run();

    expect((await postUpdate(updateForm(token, RAW_KEY))).status).toBe(200);
    expect(await env.DB.prepare(
      "SELECT token_hash FROM one_time_tokens WHERE token_hash = ?",
    ).bind(await sha256Hex(token)).first()).toBeNull();
  });

  it("consumes OTPs in both directions during an A/Z to B/A rollout", async () => {
    const keyA = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const keyZ = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
    const keyB = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI";
    const oldEnv = overrideEnv({
      SOURCE_TAG_KEY_CURRENT_ID: "key-a",
      SOURCE_TAG_KEY_CURRENT: keyA,
      SOURCE_TAG_KEY_PREVIOUS_ID: "key-z",
      SOURCE_TAG_KEY_PREVIOUS: keyZ,
    });
    const newEnv = overrideEnv({
      SOURCE_TAG_KEY_CURRENT_ID: "key-b",
      SOURCE_TAG_KEY_CURRENT: keyB,
      SOURCE_TAG_KEY_PREVIOUS_ID: "key-a",
      SOURCE_TAG_KEY_PREVIOUS: keyA,
    });

    const oldToken = await issueOtp(activeSourceIp, oldEnv);
    const oldStored = await readStoredOtp(oldToken, oldEnv);
    expect([
      oldStored?.source_tag?.split(".")[1],
      oldStored?.source_tag_previous?.split(".")[1],
    ]).toEqual(["key-a", "key-z"]);
    expect((await postUpdate(
      updateForm(oldToken, RAW_KEY),
      activeSourceIp,
      newEnv,
    )).status).toBe(200);

    const storedKey = await deriveStoredKey(RAW_KEY, activeServerId);
    const newToken = await issueOtp(activeSourceIp, newEnv);
    const newStored = await readStoredOtp(newToken, newEnv);
    expect([
      newStored?.source_tag?.split(".")[1],
      newStored?.source_tag_previous?.split(".")[1],
    ]).toEqual(["key-b", "key-a"]);
    const proof = await deriveUpdateProof(newToken, storedKey, COTP);
    const update = updateForm(newToken, proof);
    update.set("registration", "0");
    expect((await postUpdate(update, activeSourceIp, oldEnv)).status).toBe(200);
  });

  it("retains an OTP when the consumer key pair has no overlap", async () => {
    const keyA = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const keyZ = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
    const keyB = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI";
    const keyC = "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM";
    const oldEnv = overrideEnv({
      SOURCE_TAG_KEY_CURRENT_ID: "key-a",
      SOURCE_TAG_KEY_CURRENT: keyA,
      SOURCE_TAG_KEY_PREVIOUS_ID: "key-z",
      SOURCE_TAG_KEY_PREVIOUS: keyZ,
    });
    const disjointEnv = overrideEnv({
      SOURCE_TAG_KEY_CURRENT_ID: "key-c",
      SOURCE_TAG_KEY_CURRENT: keyC,
      SOURCE_TAG_KEY_PREVIOUS_ID: "key-b",
      SOURCE_TAG_KEY_PREVIOUS: keyB,
    });

    const token = await issueOtp(activeSourceIp, oldEnv);
    const form = updateForm(token, RAW_KEY);
    expect((await postUpdate(form, activeSourceIp, disjointEnv)).status).toBe(401);
    expect(await readStoredOtp(token)).not.toBeNull();
    expect((await postUpdate(form, activeSourceIp, oldEnv)).status).toBe(200);
  });

  it("fails OTP issuance closed when no overlap key is configured", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const oneKeyEnv = overrideEnv({
      SOURCE_TAG_KEY_PREVIOUS_ID: undefined,
      SOURCE_TAG_KEY_PREVIOUS: undefined,
    });

    for (const path of ["/", "/v2/servers", "/index.wsgi/otp"]) {
      expect((await callWorker(request(path), oneKeyEnv)).status).toBe(503);
    }
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM one_time_tokens",
    ).first<number>("count")).toBe(0);
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM request_budgets",
    ).first<number>("count")).toBe(0);
    expect(logged.mock.calls).toEqual(Array.from({ length: 3 }, () => [{
      event: "unexpected_error",
      handler: "fetch",
      code: "source_tag_configuration",
    }]));
  });

  it("reloads source-tag bindings when one Env identity rotates in place", async () => {
    const keyA = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const keyZ = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
    const keyB = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI";
    const overrides: Partial<Record<keyof Env, unknown>> = {
      SOURCE_TAG_KEY_CURRENT_ID: "key-a",
      SOURCE_TAG_KEY_CURRENT: keyA,
      SOURCE_TAG_KEY_PREVIOUS_ID: "key-z",
      SOURCE_TAG_KEY_PREVIOUS: keyZ,
    };
    const rotatingEnv = overrideEnv(overrides);

    const before = await readStoredOtp(
      await issueOtp(activeSourceIp, rotatingEnv),
      rotatingEnv,
    );
    expect([
      before?.source_tag?.split(".")[1],
      before?.source_tag_previous?.split(".")[1],
    ]).toEqual(["key-a", "key-z"]);

    Object.assign(overrides, {
      SOURCE_TAG_KEY_CURRENT_ID: "key-b",
      SOURCE_TAG_KEY_CURRENT: keyB,
      SOURCE_TAG_KEY_PREVIOUS_ID: "key-a",
      SOURCE_TAG_KEY_PREVIOUS: keyA,
    });
    const after = await readStoredOtp(
      await issueOtp(activeSourceIp, rotatingEnv),
      rotatingEnv,
    );
    expect([
      after?.source_tag?.split(".")[1],
      after?.source_tag_previous?.split(".")[1],
    ]).toEqual(["key-b", "key-a"]);
  });

  it("treats the exact token-expiry timestamp as expired", async () => {
    const fixedNow = 2_000_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(fixedNow);
    const token = await issueOtp();
    const now = Math.floor(fixedNow / 1_000);
    await env.DB.prepare(
      "UPDATE one_time_tokens SET expires_at = ? WHERE token_hash = ?",
    ).bind(now, await sha256Hex(token)).run();

    expect((await postUpdate(updateForm(token, RAW_KEY))).status).toBe(401);
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM one_time_tokens WHERE token_hash = ?",
    ).bind(await sha256Hex(token)).first<number>("count")).toBe(1);

    await worker.scheduled(
      createScheduledController(),
      env,
      createExecutionContext(),
    );
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM one_time_tokens WHERE token_hash = ?",
    ).bind(await sha256Hex(token)).first<number>("count")).toBe(0);
  });

  it("rechecks token expiry after request admission", async () => {
    const token = await issueOtp();
    const admittedAt = 2_000_000_000;
    await env.DB.prepare(
      "UPDATE one_time_tokens SET expires_at = ? WHERE token_hash = ?",
    ).bind(admittedAt + 1, await sha256Hex(token)).run();
    let calls = 0;
    vi.spyOn(Date, "now").mockImplementation(() => {
      calls += 1;
      return (calls === 1 ? admittedAt : admittedAt + 2) * 1_000;
    });

    expect((await postUpdate(updateForm(token, RAW_KEY))).status).toBe(401);
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(await readStoredOtp(token)).not.toBeNull();
  });

  it("fails closed when an existing update has no ownership record", async () => {
    const missingId = "3".repeat(64);
    const otp = await issueOtp();
    const form = updateForm(otp, "d".repeat(128), missingId);
    form.set("registration", "0");
    expect((await postUpdate(form)).status).toBe(409);
    expect(await env.DB.prepare(
      "SELECT server_id FROM server_owners WHERE server_id = ?",
    ).bind(missingId).first()).toBeNull();
  });

  it("never reports success when a required persistence write is ignored", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await postUpdate(updateForm(
      await issueOtp(),
      RAW_KEY,
    ))).status).toBe(200);

    await env.DB.prepare(
      `CREATE TRIGGER server_owners_test_ignore_update
       BEFORE UPDATE ON server_owners
       WHEN NEW.server_id = '${activeServerId}'
       BEGIN
         SELECT RAISE(IGNORE);
       END`,
    ).run();
    const existingOtp = await issueOtp();
    const storedKey = await deriveStoredKey(RAW_KEY, activeServerId);
    const existing = updateForm(
      existingOtp,
      await deriveUpdateProof(existingOtp, storedKey, COTP),
    );
    existing.set("registration", "0");
    const ignoredOwner = await postUpdate(existing);
    expect(ignoredOwner.status).toBe(500);
    expect(await ignoredOwner.json()).toEqual({
      error: {
        code: "internal_error",
        message: "An internal error occurred.",
      },
    });
    await env.DB.prepare(
      "DROP TRIGGER server_owners_test_ignore_update",
    ).run();

    const secondServerId = "e".repeat(64);
    const registrationOtp = await issueOtp();
    await env.DB.prepare(
      `CREATE TRIGGER servers_test_ignore_insert
       BEFORE INSERT ON servers
       WHEN NEW.server_id = '${secondServerId}'
       BEGIN
         SELECT RAISE(IGNORE);
       END`,
    ).run();
    const ignoredListing = await postUpdate(updateForm(
      registrationOtp,
      RAW_KEY,
      secondServerId,
    ));
    expect(ignoredListing.status).toBe(500);
    expect(await ignoredListing.json()).toEqual({
      error: {
        code: "internal_error",
        message: "An internal error occurred.",
      },
    });
    await env.DB.prepare("DROP TRIGGER servers_test_ignore_insert").run();

    expect(logged.mock.calls).toEqual(Array.from({ length: 2 }, () => [{
      event: "unexpected_error",
      handler: "fetch",
      code: "unhandled_exception",
    }]));
  });

  it("allows only one concurrent first claim for an identity", async () => {
    const [firstOtp, secondOtp] = await Promise.all([issueOtp(), issueOtp()]);
    const responses = await Promise.all([
      postUpdate(updateForm(firstOtp, "a".repeat(128))),
      postUpdate(updateForm(secondOtp, "c".repeat(128))),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 401]);
  });

  it("rejects an explicitly oversized update body", async () => {
    const otp = await issueOtp();
    const response = await callWorker(request("/index.wsgi/update", {
      method: "POST",
      body: updateForm(otp, RAW_KEY),
      headers: { "Content-Length": "100001" },
    }));
    expect(response.status).toBe(413);

    const streamed = await callWorker(request("/index.wsgi/update", {
      method: "POST",
      body: "x".repeat(100_001),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }));
    expect(streamed.status).toBe(413);
  });

  it("preserves the bounded 413 when oversized-body cancellation fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sensitive = `cancel-failure-${activeSourceIp}-${RAW_KEY}`;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(100_001)));
      },
      cancel() {
        throw new Error(sensitive);
      },
    });

    const response = await callWorker(request("/index.wsgi/update", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    }));
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: {
        code: "payload_too_large",
        message: "The request body is too large.",
      },
    });
    expect(error).not.toHaveBeenCalled();
    expect(warn.mock.calls).toEqual([[{
      event: "request_rejected",
      route: "compat-update",
      code: "payload_too_large",
      status: 413,
    }]]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(sensitive);
  });

  it("returns a bounded client error for malformed multipart data", async () => {
    const response = await callWorker(request("/index.wsgi/update", {
      method: "POST",
      headers: {
        "Content-Type": "multipart/form-data; boundary=test-boundary",
      },
      body: "--test-boundary\r\nContent-Disposition: form-data; name=\"otp\"\r\n\r\ntruncated",
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "bad_request",
        message: "The request is invalid.",
      },
    });
  });

  it("enforces identity and source-IP blacklist patterns", async () => {
    await env.DB.prepare(
      "INSERT INTO server_blacklist (pattern, reason, created_at) VALUES (?, ?, ?)",
    ).bind(`${activeServerId.slice(0, 8)}*`, "test identity block", 1).run();
    expect((await postUpdate(updateForm(await issueOtp(), RAW_KEY))).status).toBe(403);

    await env.DB.prepare("DELETE FROM server_blacklist").run();
    await env.DB.prepare(
      "INSERT INTO server_blacklist (pattern, reason, created_at) VALUES (?, ?, ?)",
    ).bind("192.0.2.*", "test address block", 1).run();
    expect((await postUpdate(updateForm(await issueOtp(), RAW_KEY))).status).toBe(403);
  });

  it("removes stale listings and expired operational rows on schedule", async () => {
    await env.DB.prepare(
      `INSERT INTO server_owners
         (server_id, auth_key, current_ip, ip_changed_at, created_at, updated_at)
       VALUES (?, ?, ?, 0, 0, 0)`,
    ).bind(activeServerId, "a".repeat(128), SOURCE_IP).run();
    await env.DB.prepare(
      `INSERT INTO servers
         (server_id, source_ip, name, players_count, version, text_comment,
          last_seen, is_public, quic_host, quic_port, quic_cert_sha256,
          password_required, rendezvous_token_hash)
       VALUES (?, ?, 'Stale', 0, '4.0.0', 'stale', 0, 1, ?, 1730, ?, 0, ?)`,
    ).bind(
      activeServerId,
      SOURCE_IP,
      SOURCE_IP,
      activeServerId,
      "f".repeat(64),
    ).run();
    await env.DB.prepare(
      "INSERT INTO one_time_tokens (token_hash, source_ip, expires_at, created_at) VALUES ('old', ?, 0, 0)",
    ).bind(SOURCE_IP).run();
    await env.DB.prepare(
      "INSERT INTO rate_limits (source_ip, scope, window_start, request_count) VALUES (?, 'old', 0, 1)",
    ).bind(SOURCE_IP).run();
    await env.DB.prepare(
      `INSERT INTO request_budgets
         (actor_key, scope, window_start, request_count, expires_at)
       VALUES (?, 'compat-directory', 0, 1, 1)`,
    ).bind(`v1.old.${"A".repeat(43)}`).run();

    await worker.scheduled(createScheduledController(), env, createExecutionContext());

    for (const table of [
      "servers",
      "one_time_tokens",
      "rate_limits",
      "request_budgets",
    ]) {
      const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`)
        .first<{ count: number }>();
      expect(row?.count).toBe(0);
    }
    const owners = await env.DB.prepare("SELECT COUNT(*) AS count FROM server_owners")
      .first<{ count: number }>();
    expect(owners?.count).toBe(1);
  });

  it("sanitizes scheduled-maintenance failures before they escape", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const sensitive = `maintenance-${activeSourceIp}-${activeServerId}-${RAW_KEY}`;
    const failingDatabase = new Proxy(env.DB, {
      get(target, property, receiver) {
        if (property === "prepare") {
          return () => {
            throw new Error(sensitive);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const failingEnv = overrideEnv({ DB: failingDatabase });

    let thrown: unknown;
    try {
      await worker.scheduled(
        createScheduledController(),
        failingEnv,
        createExecutionContext(),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("Scheduled maintenance failed");
    expect((thrown as Error).cause).toBeUndefined();
    expect((thrown as Error).message).not.toContain(sensitive);
    expect(logged.mock.calls).toEqual([[{
      event: "unexpected_error",
      handler: "scheduled",
      code: "maintenance_failure",
    }]]);
    expect(JSON.stringify(logged.mock.calls)).not.toContain(sensitive);
  });

  it("stops unauthenticated server rendezvous traffic at its daily source budget", async () => {
    const path = `/v2/rendezvous/${activeServerId}?role=server`;
    for (let requestNumber = 0; requestNumber < 8; requestNumber += 1) {
      const response = await callWorker(request(path, {
        headers: { Upgrade: "websocket" },
      }));
      expect(response.status).toBe(404);
    }

    const rejected = await callWorker(request(path, {
      headers: { Upgrade: "websocket" },
    }));
    expect(rejected.status).toBe(429);
    expect(await rejected.json()).toMatchObject({
      error: { reason: "rendezvous_server_source_daily" },
    });
    expect(await env.DB.prepare(
      `SELECT COUNT(*) AS rows, MIN(request_count) AS minimum,
              MAX(request_count) AS maximum
         FROM request_budgets
        WHERE scope = 'rendezvous-server-source'`,
    ).first<{ rows: number; minimum: number; maximum: number }>()).toEqual({
      rows: 2,
      minimum: 8,
      maximum: 8,
    });
  });

  it("charges the server-identity rendezvous budget only after bearer authentication", async () => {
    const registration = await postUpdate(updateForm(await issueOtp(), RAW_KEY));
    expect(registration.status).toBe(200);
    const { rendezvousToken } = await registration.json<{
      rendezvousToken: string;
    }>();
    const path = `/v2/rendezvous/${activeServerId}?role=server`;

    const invalid = await callWorker(request(path, {
      headers: {
        Authorization: `Bearer ${"0".repeat(64)}`,
        Upgrade: "websocket",
      },
    }));
    expect(invalid.status).toBe(401);
    expect(await env.DB.prepare(
      `SELECT COUNT(*) AS count
         FROM request_budgets
        WHERE actor_key = ? AND scope = 'rendezvous-server'`,
    ).bind(activeServerId).first<number>("count")).toBe(0);

    const valid = await callWorker(request(path, {
      headers: {
        Authorization: `Bearer ${rendezvousToken}`,
        Upgrade: "websocket",
      },
    }));
    expect(valid.status).toBe(101);
    closeAcceptedWebSocket(valid);
    expect(await env.DB.prepare(
      `SELECT COUNT(*) AS rows, MIN(request_count) AS minimum,
              MAX(request_count) AS maximum
         FROM request_budgets
        WHERE actor_key = ? AND scope = 'rendezvous-server'`,
    ).bind(activeServerId).first<{
      rows: number;
      minimum: number;
      maximum: number;
    }>()).toEqual({ rows: 1, minimum: 1, maximum: 1 });
  });

  it("keeps client source and source/server-pair rendezvous budgets independent", async () => {
    const firstServerId = activeServerId;
    const secondServerId = "f".repeat(64);
    const firstRegistration = await postUpdate(updateForm(
      await issueOtp(),
      RAW_KEY,
      firstServerId,
    ));
    expect(firstRegistration.status).toBe(200);
    const firstRendezvousToken = (await firstRegistration.json<{
      rendezvousToken: string;
    }>()).rendezvousToken;
    const secondRegistration = await postUpdate(updateForm(
      await issueOtp(),
      RAW_KEY,
      secondServerId,
    ));
    expect(secondRegistration.status).toBe(200);
    const secondRendezvousToken = (await secondRegistration.json<{
      rendezvousToken: string;
    }>()).rendezvousToken;

    const acceptingLimiter: RateLimit = {
      async limit() {
        return { success: true };
      },
    };
    const controlled = overrideEnv({
      GLOBAL_RATE_LIMITER: acceptingLimiter,
      RENDEZVOUS_CLIENT_RATE_LIMITER: acceptingLimiter,
      COMPAT_RENDEZVOUS_CLIENT_SOURCE_DAILY_LIMIT: "4",
      COMPAT_RENDEZVOUS_CLIENT_PAIR_DAILY_LIMIT: "2",
    });
    const clientSource = "198.51.100.200";
    const openServer = async (
      serverId: string,
      rendezvousToken: string,
    ): Promise<WebSocket> => {
      const response = await callWorker(request(
        `/v2/rendezvous/${serverId}?role=server`,
        {
          headers: {
            Authorization: `Bearer ${rendezvousToken}`,
            Upgrade: "websocket",
          },
        },
      ), controlled);
      expect(response.status).toBe(101);
      const socket = response.webSocket;
      if (socket === null) {
        throw new Error("Accepted server control returned no WebSocket");
      }
      socket.accept();
      return socket;
    };
    const firstServerSocket = await openServer(
      firstServerId,
      firstRendezvousToken,
    );
    const secondServerSocket = await openServer(
      secondServerId,
      secondRendezvousToken,
    );
    const openClient = (serverId: string): Promise<Response> => callWorker(
      request(
        `/v2/rendezvous/${serverId}?role=client`,
        { headers: { Upgrade: "websocket" } },
        clientSource,
      ),
      controlled,
    );

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const accepted = await openClient(firstServerId);
      expect(accepted.status).toBe(101);
      closeAcceptedWebSocket(accepted);
    }
    const pairRejected = await openClient(firstServerId);
    expect(pairRejected.status).toBe(429);
    expect(await pairRejected.json()).toMatchObject({
      error: { reason: "rendezvous_client_pair_daily" },
    });
    expect(await env.DB.prepare(
      `SELECT COUNT(*) AS rows, MIN(request_count) AS minimum,
              MAX(request_count) AS maximum
         FROM request_budgets
        WHERE scope = 'rendezvous-client-source'`,
    ).first<{
      rows: number;
      minimum: number;
      maximum: number;
    }>()).toEqual({ rows: 2, minimum: 3, maximum: 3 });
    expect(await env.DB.prepare(
      `SELECT COUNT(*) AS rows, MIN(request_count) AS minimum,
              MAX(request_count) AS maximum
         FROM request_budgets
        WHERE scope = 'rendezvous-client-source-server'`,
    ).first<{
      rows: number;
      minimum: number;
      maximum: number;
    }>()).toEqual({ rows: 2, minimum: 2, maximum: 2 });

    const secondPairAccepted = await openClient(secondServerId);
    expect(secondPairAccepted.status).toBe(101);
    closeAcceptedWebSocket(secondPairAccepted);
    const sourceRejected = await openClient(secondServerId);
    expect(sourceRejected.status).toBe(429);
    expect(await sourceRejected.json()).toMatchObject({
      error: { reason: "rendezvous_client_source_daily" },
    });

    expect(await env.DB.prepare(
      `SELECT COUNT(*) AS rows, MIN(request_count) AS minimum,
              MAX(request_count) AS maximum
         FROM request_budgets
        WHERE scope = 'rendezvous-client-source'`,
    ).first<{
      rows: number;
      minimum: number;
      maximum: number;
    }>()).toEqual({ rows: 2, minimum: 4, maximum: 4 });
    expect((await env.DB.prepare(
      `SELECT request_count, COUNT(*) AS aliases
         FROM request_budgets
        WHERE scope = 'rendezvous-client-source-server'
        GROUP BY request_count
        ORDER BY request_count`,
    ).all<{
      request_count: number;
      aliases: number;
    }>()).results).toEqual([
      { request_count: 1, aliases: 2 },
      { request_count: 2, aliases: 2 },
    ]);
    firstServerSocket.close(1000, "Test complete");
    secondServerSocket.close(1000, "Test complete");
  });

  it("fails protected client rendezvous closed until authorization is available", async () => {
    const form = updateForm(await issueOtp(), RAW_KEY);
    form.set("password_required", "1");
    const registration = await postUpdate(form);
    expect(registration.status).toBe(200);
    const { rendezvousToken } = await registration.json<{
      rendezvousToken: string;
    }>();

    const serverControl = await callWorker(request(
      `/v2/rendezvous/${activeServerId}?role=server`,
      {
        headers: {
          Authorization: `Bearer ${rendezvousToken}`,
          Upgrade: "websocket",
        },
      },
    ));
    expect(serverControl.status).toBe(101);
    const serverSocket = serverControl.webSocket;
    if (serverSocket === null) {
      throw new Error("Accepted server control returned no WebSocket");
    }
    serverSocket.accept();

    const client = await callWorker(request(
      `/v2/rendezvous/${activeServerId}?role=client`,
      { headers: { Upgrade: "websocket" } },
    ));
    expect(client.status).toBe(503);
    expect(client.headers.get("Cache-Control")).toBe("no-store");
    expect(client.headers.get("Retry-After")).toBe("300");
    expect(await client.text()).toBe(
      "Protected rendezvous authorization is unavailable\n",
    );
    expect(serverSocket.readyState).toBe(WebSocket.OPEN);
    serverSocket.close(1000, "Test complete");
  });

  it("lists opted-in servers and relays rendezvous candidates", async () => {
    const response = await postUpdate(updateForm(await issueOtp(), RAW_KEY));
    expect(response.status).toBe(200);
    const result = await response.json<{ rendezvousToken: string; status: string }>();
    expect(result.status).toBe("ok");
    expect(result.rendezvousToken).toMatch(/^[0-9a-f]{64}$/);

    const body = await (await callWorker(request("/v2/servers"))).text();
    expect(body).toContain(`<Id>${activeServerId}</Id>`);
    expect(body).toContain("<Address>198.51.100.20</Address>");
    expect(body).not.toContain("<Hostname>");

    const upgradeRequired = await callWorker(
      request(`/v2/rendezvous/${activeServerId}?role=client`),
    );
    expect(upgradeRequired.status).toBe(426);

    const queryToken = await callWorker(request(
      `/v2/rendezvous/${activeServerId}?role=server&token=${result.rendezvousToken}`,
      { headers: { Upgrade: "websocket" } },
    ));
    expect(queryToken.status).toBe(400);
    expect(queryToken.headers.has("WWW-Authenticate")).toBe(false);

    const authorized = await callWorker(request(
      `/v2/rendezvous/${activeServerId}?role=server`,
      {
        headers: {
          Authorization: `Bearer ${result.rendezvousToken}`,
          Upgrade: "websocket",
        },
      },
    ));
    expect(authorized.status).toBe(101);
    const serverSocket = authorized.webSocket!;
    serverSocket.accept();

    const clientRendezvous = await callWorker(request(
      `/v2/rendezvous/${activeServerId}?role=client`,
      { headers: { Upgrade: "websocket" } },
    ));
    expect(clientRendezvous.status).toBe(101);
    const clientSocket = clientRendezvous.webSocket!;
    clientSocket.accept();

    const ticket = "c".repeat(64);
    const offered = nextWebSocketMessage(serverSocket);
    clientSocket.send(JSON.stringify({
      type: "client_candidate",
      host: "::ffff:192.0.2.44",
      port: 49_152,
      ticket,
    }));
    expect(JSON.parse(await offered)).toEqual({
      type: "client_candidate",
      host: "0000:0000:0000:0000:0000:ffff:c000:022c",
      port: 49_152,
      ticket,
    });

    const candidate = nextWebSocketMessage(clientSocket);
    serverSocket.send(JSON.stringify({
      type: "server_candidate",
      host: "2001:db8::20",
      port: 1_730,
      kind: "ipv6",
      ticket,
    }));
    expect(JSON.parse(await candidate)).toEqual({
      type: "server_candidate",
      host: "2001:0db8:0000:0000:0000:0000:0000:0020",
      port: 1_730,
      kind: "ipv6",
      ticket,
    });

    const completed = nextWebSocketMessage(clientSocket);
    serverSocket.send(JSON.stringify({ type: "complete", ticket }));
    expect(JSON.parse(await completed)).toEqual({ type: "complete", ticket });

    clientSocket.close(1000, "Test complete");
    serverSocket.close(1000, "Test complete");
  });
});
