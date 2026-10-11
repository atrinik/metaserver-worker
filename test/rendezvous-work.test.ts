import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { handleRendezvousCoordinatorRequest } from "../src/index";
import { issueRendezvousChallenge, parseAdmissionToken, ticketHash, verifyRendezvousAdmission } from "../src/rendezvous-work";
import { validateChallengeServiceResponse } from "../src/internal-service";
import { INTERNAL_RENDEZVOUS_URL, INTERNAL_RENDEZVOUS_ADMISSION_HEADER,
  INTERNAL_RENDEZVOUS_TICKET_HEADER, INTERNAL_RENDEZVOUS_EXPIRY_HEADER } from "../src/rendezvous-contract";
import { admissionHeaders, admissionKeys, admissionProof, admissionVector as v } from "./admission-fixture";

const url = `https://${v.authority}/v1/classic/servers/${v.serverId}?role=client`;
const safeHeaders = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Type": "application/json" };
function request(headers: HeadersInit = admissionHeaders()): Request {
  return new Request(url, { headers });
}
function challengeBody(ticketHash = v.ticketHash): string {
  return JSON.stringify({ schema: "atrinik-rendezvous-admission-v1", ticketHash });
}
function challengeRequest(serverId = v.serverId, body = challengeBody()): Request {
  return new Request(`https://${v.authority}/v1/rendezvous/challenge/classic/${serverId}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body,
  });
}
function coreEnvironment() {
  const fetch = vi.fn(async (_request: Request) => new Response("Rendezvous server unavailable\n", {
    status: 503, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
      "Content-Type": "text/plain; charset=utf-8", "Retry-After": "5" },
  }));
  const lookup = vi.fn(() => ({ fetch }));
  const prepare = vi.fn(() => { throw new Error("Admission must precede D1"); });
  const core = new Proxy(env, { get(target, property, receiver) {
    const overrides: Record<string, unknown> = { ...admissionKeys, RENDEZVOUS_HOSTNAME: v.authority,
      RENDEZVOUS_ENABLED: "enabled", RENDEZVOUS: { getByName: lookup }, DB: { prepare } };
    return Object.hasOwn(overrides, property) ? overrides[String(property)] : Reflect.get(target, property, receiver);
  }});
  return { core, lookup, fetch, prepare };
}
beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(Number(v.issuedAt) * 1000); });

describe("mandatory rendezvous admission work", () => {
  it("accepts the independent binary-ticket SHA-256 and 24-bit work vector", async () => {
    expect(await ticketHash(v.ticket)).toBe(v.ticketHash);
    expect(await verifyRendezvousAdmission(request(), admissionKeys, v.authority, v.serverId, false))
      .toEqual({ ticket: v.ticket, expiresAt: Number(v.expiresAt), clientNonce: null });
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(
      `atrinik-rendezvous-work-v1\0${v.token}\0${v.solution}`));
    expect(Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, "0")).join(""))
      .toBe(v.workDigest);
  });
  it("accepts the same proof through the overlapping previous key", async () => {
    const rotated = { SOURCE_TAG_KEY_CURRENT_ID: "next", SOURCE_TAG_KEY_CURRENT: admissionKeys.SOURCE_TAG_KEY_PREVIOUS,
      SOURCE_TAG_KEY_PREVIOUS_ID: v.keyId, SOURCE_TAG_KEY_PREVIOUS: admissionKeys.SOURCE_TAG_KEY_CURRENT };
    expect(await verifyRendezvousAdmission(request(), rotated, v.authority, v.serverId, false)).not.toBeNull();
    expect(await verifyRendezvousAdmission(request(), { ...rotated, SOURCE_TAG_KEY_PREVIOUS_ID: "retired" },
      v.authority, v.serverId, false)).toBeNull();
  });
  it("binds protected proof to the exact grant and nonce header", async () => {
    const headers = admissionHeaders(true);
    expect(await verifyRendezvousAdmission(request(headers), admissionKeys, v.authority, v.serverId, true))
      .toEqual({ ticket: v.ticket, expiresAt: Number(v.expiresAt), clientNonce: "b".repeat(64) });
    for (const change of [ { Authorization: `Bearer ${"3".repeat(64)}` },
      { "X-Atrinik-Access-Client-Nonce": "B".repeat(64) }, { "X-Atrinik-Rendezvous-Ticket": v.ticket } ]) {
      expect(await verifyRendezvousAdmission(request({ ...headers, ...change }), admissionKeys,
        v.authority, v.serverId, true)).toBeNull();
    }
    const missing = new Headers(headers); missing.delete("X-Atrinik-Access-Client-Nonce");
    expect(await verifyRendezvousAdmission(request(missing), admissionKeys, v.authority, v.serverId, true)).toBeNull();
  });
  it("rejects malformed, oversized, substituted and insufficient proofs before room or D1 lookup", async () => {
    const { core, lookup, prepare } = coreEnvironment();
    const proofs = ["", "v1", admissionProof + "x", "x".repeat(257),
      `${v.token}.0000000000000000`, `${v.token}.${v.solution.toUpperCase()}`,
      admissionProof.replace(v.mac, "0".repeat(64)), admissionProof.replace(v.ticketHash, "0".repeat(64)),
      admissionProof.replace(v.issuedAt, `0${v.issuedAt}`), admissionProof.replace("v1.", "v2.")];
    for (const proof of proofs) {
      const response = await handleRendezvousCoordinatorRequest(request({ ...admissionHeaders(),
        "X-Atrinik-Rendezvous-Admission": proof }), core);
      expect(response.status).toBe(403);
      expect(await response.text()).toBe("Forbidden\n");
    }
    for (const change of [{ "X-Atrinik-Rendezvous-Ticket": "3".repeat(64) },
      { Authorization: `Bearer ${v.ticket}` }, { "X-Atrinik-Access-Client-Nonce": "b".repeat(64) }]) {
      expect((await handleRendezvousCoordinatorRequest(request({ ...admissionHeaders(), ...change }), core)).status)
        .toBeGreaterThanOrEqual(400);
    }
    expect(lookup).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
  });
  it("returns fixed 428 for missing proof before any storage dispatch", async () => {
    const { core, lookup, prepare } = coreEnvironment();
    const response = await handleRendezvousCoordinatorRequest(request({ Upgrade: "websocket" }), core);
    expect(response.status).toBe(428);
    expect(await response.text()).toBe("Rendezvous admission required\n");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(lookup).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
  });
  it("dispatches the premined valid proof with only v5 validated admission fields", async () => {
    const { core, lookup, fetch, prepare } = coreEnvironment();
    prepare.mockImplementation(() => ({ bind: () => ({ first: async () => ({
      authorization_required: 0, rendezvous_token_hash: "4".repeat(64), rendezvous_generation: "5".repeat(64),
    }) }) }) as never);
    const response = await handleRendezvousCoordinatorRequest(request(), core);
    expect(response.status).toBe(503);
    expect(lookup).toHaveBeenCalledExactlyOnceWith(v.serverId);
    const internal = fetch.mock.calls[0]?.[0] as Request | undefined;
    expect(internal?.url).toBe(INTERNAL_RENDEZVOUS_URL);
    expect(internal?.headers.get(INTERNAL_RENDEZVOUS_ADMISSION_HEADER)).toBe("work-v1-24");
    expect(internal?.headers.get(INTERNAL_RENDEZVOUS_TICKET_HEADER)).toBe(v.ticket);
    expect(internal?.headers.get(INTERNAL_RENDEZVOUS_EXPIRY_HEADER)).toBe(v.expiresAt);
    expect(internal?.headers.has("X-Atrinik-Rendezvous-Admission")).toBe(false);
  });
  it("rejects wrong authority, target, future issue time and reached expiry", async () => {
    expect(await verifyRendezvousAdmission(request(), admissionKeys, "other.example.invalid", v.serverId, false)).toBeNull();
    expect(await verifyRendezvousAdmission(request(), admissionKeys, v.authority, "4".repeat(64), false)).toBeNull();
    for (const now of [Number(v.issuedAt) - 1, Number(v.expiresAt), Number(v.expiresAt) + 1]) {
      vi.mocked(Date.now).mockReturnValue(now * 1000);
      expect(await verifyRendezvousAdmission(request(), admissionKeys, v.authority, v.serverId, false)).toBeNull();
    }
    for (const token of [v.token.replace(v.issuedAt, "0"), v.token.replace(v.issuedAt, "253402300740"),
      v.token.replace(v.nonce, "A".repeat(32))]) expect(parseAdmissionToken(token)).toBeNull();
  });
  it("issues canonical blind challenges for arbitrary identities without storage", async () => {
    const { core, lookup, prepare } = coreEnvironment();
    for (const serverId of [v.serverId, "0".repeat(64), "f".repeat(64)]) {
      const response = await handleRendezvousCoordinatorRequest(challengeRequest(serverId), core);
      expect(response.status).toBe(200);
      const bytes = await response.text(); expect(new TextEncoder().encode(bytes).length).toBeLessThanOrEqual(512);
      const value = JSON.parse(bytes);
      expect(bytes).toBe(JSON.stringify({ schema: "atrinik-rendezvous-admission-v1", challenge: value.challenge,
        difficulty: 24, expiresAt: v.expiresAt }));
      const parsed = parseAdmissionToken(value.challenge); expect(parsed?.ticketHash).toBe(v.ticketHash);
      expect(parsed?.issuedAt).toBe(Number(v.issuedAt));
    }
    expect(lookup).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
  });
  it("rejects noncanonical and oversized challenge bodies", async () => {
    for (const body of [challengeBody() + " ", challengeBody().replace('{"schema"', '{ "schema"'),
      JSON.stringify({ ticketHash: v.ticketHash, schema: "atrinik-rendezvous-admission-v1" }),
      challengeBody("A".repeat(64)), challengeBody().replace("v1", "v2"), "x".repeat(257)]) {
      await expect(issueRendezvousChallenge(challengeRequest(v.serverId, body), admissionKeys, v.authority, v.serverId))
        .rejects.toThrow();
    }
  });
  it("closes the challenge service response allowlist around fixed difficulty, expiry and metadata", async () => {
    const value = { schema: "atrinik-rendezvous-admission-v1", challenge: v.token, difficulty: 24, expiresAt: v.expiresAt };
    const body = JSON.stringify(value);
    expect(await (await validateChallengeServiceResponse(new Response(body, { headers: safeHeaders }))).text()).toBe(body);
    for (const bad of [{ ...value, difficulty: 0 }, { ...value, difficulty: 23 }, { ...value, difficulty: 25 },
      { ...value, expiresAt: String(Number(v.expiresAt) + 1) }, { ...value, extra: true }]) {
      await expect(validateChallengeServiceResponse(new Response(JSON.stringify(bad), { headers: safeHeaders }))).rejects.toThrow();
    }
    for (const headers of [{ ...safeHeaders, "Set-Cookie": "secret=value" },
      { ...safeHeaders, Location: "https://other.example.invalid" }, { ...safeHeaders, "X-Extra": "value" }]) {
      await expect(validateChallengeServiceResponse(new Response(body, { headers }))).rejects.toThrow();
    }
  });
});
