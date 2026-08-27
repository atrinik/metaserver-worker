import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import malformedObservationFixture from "./fixtures/rendezvous-health-v1-malformed-observation.json";
import noObservationFixture from "./fixtures/rendezvous-health-v1-no-observation.json";

import {
  handleRendezvousHealthRequest,
  INTERNAL_RENDEZVOUS_HEALTH_URL,
  normalizeRendezvousHealthCanary,
  recordRendezvousAuthenticatedAdmission,
  recordRendezvousHealthCanary,
  recordRendezvousSessionObservation,
  readRendezvousHealthSnapshot,
  RENDEZVOUS_HEALTH_FRESHNESS_SECONDS,
} from "../src/rendezvous-health";

const NOW = 1_000;
const TOKEN = "test-rendezvous-health-export-token";

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM rendezvous_health_observations").run();
});

describe("rendezvous health aggregate", () => {
  it("returns an explicit no-usable-observation result when empty", async () => {
    await expect(readRendezvousHealthSnapshot(env.DB, NOW)).resolves.toEqual(
      noObservationFixture,
    );
  });

  it("returns the malformed-observation fixture for a semantically invalid row", async () => {
    await env.DB.prepare(
      `INSERT INTO rendezvous_health_observations (
        singleton,
        observation_generation,
        window_started_at,
        source_timestamp,
        authenticated_admissions,
        session_completed,
        session_client_disconnected,
        session_expired,
        session_protocol_error,
        session_server_unavailable,
        session_server_replaced,
        session_authorization_failed,
        session_internal_error,
        canary_type,
        canary_route,
        canary_authenticated_control,
        canary_recent_admission,
        canary_observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` ,
    ).bind(
      1,
      1,
      NOW,
      NOW + RENDEZVOUS_HEALTH_FRESHNESS_SECONDS + 1,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      "none",
      "not_observed",
      "not_observed",
      "not_observed",
      0,
    ).run();

    await expect(readRendezvousHealthSnapshot(env.DB, NOW)).resolves.toEqual(
      malformedObservationFixture,
    );
  });

  it("normalizes bounded admission and terminal-session evidence", async () => {
    await recordRendezvousAuthenticatedAdmission(env.DB, NOW);
    await recordRendezvousSessionObservation(env.DB, "completed", NOW + 1);
    await recordRendezvousSessionObservation(
      env.DB,
      "server=private;ticket=secret",
      NOW + 2,
    );

    const snapshot = await readRendezvousHealthSnapshot(env.DB, NOW + 2);
    expect(snapshot.status).toBe("healthy");
    expect(snapshot.recent_authenticated_admissions).toBe(1);
    expect(snapshot.recent_sessions.total).toBe(2);
    expect(snapshot.recent_sessions.outcomes.completed).toBe(1);
    expect(snapshot.recent_sessions.outcomes.internal_error).toBe(1);
    expect(snapshot.freshness.state).toBe("fresh");
    expect(JSON.stringify(snapshot)).not.toMatch(
      /server_id|room|connection|ticket|candidate|credential|source_address|address/i,
    );
  });

  it("does not treat a route-only canary as authenticated health", async () => {
    await recordRendezvousHealthCanary(env.DB, {
      type: "route",
      route: "reachable",
      authenticatedControl: "not_observed",
      recentAdmission: "not_observed",
    }, NOW);

    const snapshot = await readRendezvousHealthSnapshot(env.DB, NOW);
    expect(snapshot.status).toBe("no_usable_observation");
    expect(snapshot.canary).toMatchObject({
      type: "route",
      route: "reachable",
      authenticated_control: "not_observed",
      recent_admission: "not_observed",
    });
  });

  it("accepts the Unix epoch as a bounded observation timestamp", async () => {
    await recordRendezvousHealthCanary(env.DB, {
      type: "route",
      route: "reachable",
      authenticatedControl: "not_observed",
      recentAdmission: "not_observed",
    }, 0);

    await expect(readRendezvousHealthSnapshot(env.DB, 0)).resolves.toMatchObject({
      source_timestamp: 0,
      observation_window: { started_at: 0, ended_at: 300 },
      canary: { type: "route", observed_at: 0 },
    });
  });

  it("reports an explicit route failure and a passing end-to-end canary", async () => {
    await recordRendezvousHealthCanary(env.DB, {
      type: "route",
      route: "failed",
      authenticatedControl: "not_observed",
      recentAdmission: "not_observed",
    }, NOW);
    await expect(readRendezvousHealthSnapshot(env.DB, NOW)).resolves.toMatchObject({
      status: "failed",
      reason: "canary_failed",
    });

    await recordRendezvousHealthCanary(env.DB, {
      type: "end_to_end",
      route: "reachable",
      authenticatedControl: "passed",
      recentAdmission: "passed",
    }, NOW + 1);
    await expect(readRendezvousHealthSnapshot(env.DB, NOW + 1)).resolves.toMatchObject({
      status: "healthy",
      reason: "canary_passed",
      canary: {
        type: "end_to_end",
        authenticated_control: "passed",
        recent_admission: "passed",
      },
    });
  });

  it("marks a source outside the bounded freshness window stale", async () => {
    await recordRendezvousAuthenticatedAdmission(env.DB, NOW);

    const snapshot = await readRendezvousHealthSnapshot(
      env.DB,
      NOW + RENDEZVOUS_HEALTH_FRESHNESS_SECONDS + 1,
    );
    expect(snapshot.status).toBe("stale");
    expect(snapshot.reason).toBe("stale_source");
    expect(snapshot.freshness.state).toBe("stale");
  });
});

describe("private rendezvous health entrypoint", () => {
  it("requires the exact private URL, token, and header envelope", async () => {
    const wrongToken = await healthRequest("GET", undefined, "wrong-token");
    expect((await handleRendezvousHealthRequest(
      wrongToken,
      { DB: env.DB, RENDEZVOUS_HEALTH_EXPORT_TOKEN: TOKEN },
      NOW,
    )).status).toBe(403);

    const publicRoute = new Request(
      "https://rendezvous.meta.atrinik.org/v1/classic/health",
      { headers: { Authorization: `Bearer ${TOKEN}` } },
    );
    expect((await handleRendezvousHealthRequest(
      publicRoute,
      { DB: env.DB, RENDEZVOUS_HEALTH_EXPORT_TOKEN: TOKEN },
      NOW,
    )).status).toBe(403);

    const alternateHeaders = await healthRequest("GET", undefined, TOKEN, {
      "X-Forwarded-For": "192.0.2.1",
    });
    expect((await handleRendezvousHealthRequest(
      alternateHeaders,
      { DB: env.DB, RENDEZVOUS_HEALTH_EXPORT_TOKEN: TOKEN },
      NOW,
    )).status).toBe(403);
  });

  it("exports the bounded snapshot and accepts only normalized canary input", async () => {
    const get = await handleRendezvousHealthRequest(
      await healthRequest("GET"),
      { DB: env.DB, RENDEZVOUS_HEALTH_EXPORT_TOKEN: TOKEN },
      NOW,
    );
    expect(get.status).toBe(200);
    expect(get.headers.get("Cache-Control")).toBe("no-store");
    expect(await get.json()).toMatchObject({
      schema: "rendezvous-health-v1",
      status: "no_usable_observation",
    });

    const post = await handleRendezvousHealthRequest(
      await healthRequest(
        "POST",
        JSON.stringify({
          type: "end_to_end",
          route: "reachable",
          authenticated_control: "passed",
          recent_admission: "passed",
        }),
      ),
      { DB: env.DB, RENDEZVOUS_HEALTH_EXPORT_TOKEN: TOKEN },
      NOW,
    );
    expect(post.status).toBe(204);
    await expect(readRendezvousHealthSnapshot(env.DB, NOW)).resolves.toMatchObject({
      status: "healthy",
      canary: { type: "end_to_end" },
    });

    const malformed = await handleRendezvousHealthRequest(
      await healthRequest(
        "POST",
        JSON.stringify({
          type: "route",
          route: "reachable",
          ticket: "must-not-be-accepted",
        }),
      ),
      { DB: env.DB, RENDEZVOUS_HEALTH_EXPORT_TOKEN: TOKEN },
      NOW,
    );
    expect(malformed.status).toBe(400);
  });

  it("rejects malformed canary values before persistence", () => {
    expect(normalizeRendezvousHealthCanary({
      type: "route",
      route: "reachable",
      authenticated_control: "passed",
      recent_admission: "passed",
    })).toBeNull();
    expect(normalizeRendezvousHealthCanary({
      type: "end_to_end",
      route: "reachable",
      authenticated_control: "passed",
      recent_admission: "not_observed",
    })).toBeNull();
    expect(normalizeRendezvousHealthCanary({
      type: "end_to_end",
      route: "failed",
      authenticated_control: "not_observed",
      recent_admission: "not_observed",
      extra: true,
    })).toBeNull();
  });
});

async function healthRequest(
  method: "GET" | "POST",
  body?: string,
  token = TOKEN,
  extraHeaders: Record<string, string> = {},
): Promise<Request> {
  return new Request(INTERNAL_RENDEZVOUS_HEALTH_URL, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...extraHeaders,
    },
    ...(body === undefined ? {} : { body }),
  });
}
