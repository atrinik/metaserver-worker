import { describe, expect, it } from "vitest";

import { SERVER_SIGNAL_CANDIDATE_KINDS } from "../src/protocol";
import inviteVector from "./fixtures/rendezvous-invite-v1.json";
import { parseAccessInit } from "../src/access-rendezvous";

import {
  INTERNAL_RENDEZVOUS_AUTHORIZATION_HEADER,
  INTERNAL_RENDEZVOUS_GENERATION_HEADER,
  INTERNAL_RENDEZVOUS_PUBLISH_URL,
  INTERNAL_RENDEZVOUS_PROTOCOL_HEADER,
  INTERNAL_RENDEZVOUS_ROLE_HEADER,
  INTERNAL_RENDEZVOUS_URL,
  LEGACY_INTERNAL_RENDEZVOUS_ROLE_HEADER,
  LEGACY_INTERNAL_RENDEZVOUS_V1_ROLE_HEADER,
  MAX_CLIENT_AUTHORIZATION_FRAMES,
  MAX_RENDEZVOUS_SESSION_SIGNAL_BYTES,
  MAX_RENDEZVOUS_CLIENT_SOCKETS,
  MAX_SERVER_CANDIDATES,
  MAX_SERVER_AUTHORIZATION_FRAMES,
  MAX_SIGNAL_BYTES,
  MAX_WEBSOCKET_CLOSE_REASON_BYTES,
  NORMAL_RENDEZVOUS_CLOSE,
  parseRendezvousSignal,
  RENDEZVOUS_CLOSE,
  RENDEZVOUS_ROLLING_WINDOW_MS,
  serializeRendezvousSignal,
  validateInternalRendezvousPublication,
  validateInternalRendezvousUpgrade,
} from "../src/rendezvous-contract";

const TICKET = "a".repeat(64);
const GENERATION = "0".repeat(64);
const PUBLICATION = Object.freeze({
  serverId: "1".repeat(64),
  directoryProfile: "classic-v3",
  certificate: "AA==",
  publisherSequence: "1",
  publisherNonce: "6".repeat(32),
  publisherNonceExpiresAt: 2_000_086_400,
  commitToken: "4".repeat(64),
  expectedGeneration: GENERATION,
  generation: "2".repeat(64),
  tokenHash: "3".repeat(64),
  now: 2_000_000_000,
  visibilityCutoff: 1_999_985_600,
  name: "Classic Server",
  playersCount: 2,
  version: "4.0.0",
  textComment: "Protected rendezvous",
  isPublic: true,
  quicHost: "play.example.test",
  quicPort: 1_730,
  quicCertSha256: "1".repeat(64),
  authorizationRequired: true,
  directoryFingerprint: "5".repeat(64),
});

function publicationRequest(
  body: unknown = PUBLICATION,
  init: RequestInit = {},
): Request {
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return new Request(INTERNAL_RENDEZVOUS_PUBLISH_URL, {
    method: "POST",
    ...init,
    headers,
    body: JSON.stringify(body),
  });
}

function internalRequest(
  role: string = "client",
  init: RequestInit = {},
  url = INTERNAL_RENDEZVOUS_URL,
): Request {
  const headers = new Headers(init.headers);
  if (!headers.has("Upgrade")) {
    headers.set("Upgrade", "websocket");
  }
  if (!headers.has(INTERNAL_RENDEZVOUS_ROLE_HEADER)) {
    headers.set(INTERNAL_RENDEZVOUS_ROLE_HEADER, role);
  }
  if (!headers.has(INTERNAL_RENDEZVOUS_PROTOCOL_HEADER)) {
    headers.set(INTERNAL_RENDEZVOUS_PROTOCOL_HEADER, "none");
  }
  if (!headers.has(INTERNAL_RENDEZVOUS_AUTHORIZATION_HEADER)) {
    headers.set(INTERNAL_RENDEZVOUS_AUTHORIZATION_HEADER, "not-required");
  }
  if (!headers.has(INTERNAL_RENDEZVOUS_GENERATION_HEADER)) {
    headers.set(INTERNAL_RENDEZVOUS_GENERATION_HEADER, GENERATION);
  }
  return new Request(url, { ...init, headers });
}

describe("internal rendezvous upgrade contract", () => {
  it("accepts only the two exact versioned internal roles", () => {
    expect(validateInternalRendezvousUpgrade(internalRequest("client"))).toEqual({
      role: "client",
      accessProtocol: false,
      authorizationRequired: false,
      generation: GENERATION,
    });
    expect(validateInternalRendezvousUpgrade(internalRequest("server"))).toEqual({
      role: "server",
      accessProtocol: false,
      authorizationRequired: false,
      generation: GENERATION,
    });
    expect(INTERNAL_RENDEZVOUS_URL).toContain("/v4");
    expect(INTERNAL_RENDEZVOUS_ROLE_HEADER).toContain("V4");
    expect(INTERNAL_RENDEZVOUS_ROLE_HEADER).not.toBe(
      LEGACY_INTERNAL_RENDEZVOUS_ROLE_HEADER,
    );
  });

  it("rejects legacy, missing, ambiguous, and non-canonical roles", () => {
    const missing = new Request(INTERNAL_RENDEZVOUS_URL, {
      headers: { Upgrade: "websocket" },
    });
    expect(validateInternalRendezvousUpgrade(missing)).toBeNull();

    for (const role of ["", "CLIENT", "client, server", "operator"] as const) {
      expect(validateInternalRendezvousUpgrade(internalRequest(role))).toBeNull();
    }

    const legacyOnly = new Request("https://rendezvous.internal/", {
      headers: {
        Upgrade: "websocket",
        [LEGACY_INTERNAL_RENDEZVOUS_ROLE_HEADER]: "client",
      },
    });
    expect(validateInternalRendezvousUpgrade(legacyOnly)).toBeNull();

    const both = internalRequest("client", {
      headers: { [LEGACY_INTERNAL_RENDEZVOUS_ROLE_HEADER]: "client" },
    });
    expect(validateInternalRendezvousUpgrade(both)).toBeNull();

    const v1 = internalRequest("client", {
      headers: { [LEGACY_INTERNAL_RENDEZVOUS_V1_ROLE_HEADER]: "client" },
    });
    expect(validateInternalRendezvousUpgrade(v1)).toBeNull();

    const v2 = internalRequest("client", {
      headers: { "X-Atrinik-Rendezvous-V2-Role": "client" },
    });
    expect(validateInternalRendezvousUpgrade(v2)).toBeNull();
    expect(validateInternalRendezvousUpgrade(internalRequest(
      "client",
      {},
      "https://rendezvous.internal/v2",
    ))).toBeNull();
  });

  it("accepts only coherent invite-protocol authorization metadata", () => {
    expect(validateInternalRendezvousUpgrade(internalRequest("client", {
      headers: {
        [INTERNAL_RENDEZVOUS_PROTOCOL_HEADER]: "access-tokens-v1",
        [INTERNAL_RENDEZVOUS_AUTHORIZATION_HEADER]: "required",
      },
    }))).toEqual({
      role: "client",
      accessProtocol: true,
      authorizationRequired: true,
      generation: GENERATION,
    });
    expect(validateInternalRendezvousUpgrade(internalRequest("server", {
      headers: {
        [INTERNAL_RENDEZVOUS_PROTOCOL_HEADER]: "access-tokens-v1",
      },
    }))).toEqual({
      role: "server",
      accessProtocol: true,
      authorizationRequired: false,
      generation: GENERATION,
    });

    const invalid = [
      internalRequest("client", {
        headers: {
          [INTERNAL_RENDEZVOUS_PROTOCOL_HEADER]: "access-tokens-v1",
        },
      }),
      internalRequest("client", {
        headers: {
          [INTERNAL_RENDEZVOUS_AUTHORIZATION_HEADER]: "required",
        },
      }),
      internalRequest("server", {
        headers: {
          [INTERNAL_RENDEZVOUS_PROTOCOL_HEADER]: "access-tokens-v1",
          [INTERNAL_RENDEZVOUS_AUTHORIZATION_HEADER]: "required",
        },
      }),
      internalRequest("client", {
        headers: {
          [INTERNAL_RENDEZVOUS_PROTOCOL_HEADER]: "classic-invite-v2",
        },
      }),
      internalRequest("client", {
        headers: {
          [INTERNAL_RENDEZVOUS_AUTHORIZATION_HEADER]: "optional",
        },
      }),
    ];
    for (const request of invalid) {
      expect(validateInternalRendezvousUpgrade(request)).toBeNull();
    }
  });

  it("accepts only an exact bounded publication commit", async () => {
    await expect(validateInternalRendezvousPublication(publicationRequest()))
      .resolves.toEqual(PUBLICATION);
    await expect(validateInternalRendezvousPublication(publicationRequest({
      ...PUBLICATION,
      expectedGeneration: null,
      quicHost: "",
      quicPort: 1,
    }))).resolves.toMatchObject({
      expectedGeneration: null,
      quicHost: "",
      quicPort: 1,
    });
    const gamePublication = {
      serverId: PUBLICATION.serverId,
      directoryProfile: "game-v2",
      certificate: "AA==",
      publisherSequence: "1",
      publisherNonce: "6".repeat(32),
      publisherNonceExpiresAt: PUBLICATION.now + 86_400,
      commitToken: PUBLICATION.commitToken,
      expectedGeneration: PUBLICATION.expectedGeneration,
      generation: PUBLICATION.generation,
      tokenHash: PUBLICATION.tokenHash,
      now: PUBLICATION.now,
      visibilityCutoff: PUBLICATION.visibilityCutoff,
      name: "Game Server",
      description: "Protected game rendezvous",
      region: "eu-west",
      protocolMajor: 1,
      protocolMinor: 0,
      contentId: "atrinik-main",
      contentRevisionSha256: "7".repeat(64),
      playersOnline: 2,
      playersCapacity: 32,
      status: "online",
      isPublic: true,
      quicHost: "play.example.test",
      quicPort: 1_730,
      quicCertSha256: PUBLICATION.quicCertSha256,
      authorizationRequired: true,
      directoryFingerprint: PUBLICATION.directoryFingerprint,
    } as const;
    await expect(validateInternalRendezvousPublication(
      publicationRequest(gamePublication),
    )).resolves.toEqual(gamePublication);
    const maximumText = {
      ...PUBLICATION,
      name: "é".repeat(40),
      version: "é".repeat(16),
      textComment: "é".repeat(128),
    };
    await expect(validateInternalRendezvousPublication(
      publicationRequest(maximumText),
    )).resolves.toEqual(maximumText);

    const invalidBodies = [
      {
        ...PUBLICATION,
        publisherAuthentication: "compat-key-v1",
      },
      { ...PUBLICATION, generation: "A".repeat(64) },
      { ...PUBLICATION, serverId: "4".repeat(64) },
      { ...PUBLICATION, quicHost: "EXAMPLE.invalid" },
      { ...PUBLICATION, quicHost: "xn--a.example.org" },
      { ...PUBLICATION, quicHost: "", quicPort: 1_730 },
      { ...PUBLICATION, quicPort: 0 },
      { ...PUBLICATION, playersCount: -1 },
      { ...PUBLICATION, extra: true },
      { ...PUBLICATION, name: "x".repeat(81) },
      { ...PUBLICATION, name: "é".repeat(41) },
      { ...PUBLICATION, textComment: "line\nbreak" },
    ];
    for (const body of invalidBodies) {
      await expect(validateInternalRendezvousPublication(
        publicationRequest(body),
      )).resolves.toBeNull();
    }

    for (const request of [
      new Request(INTERNAL_RENDEZVOUS_PUBLISH_URL, { method: "POST" }),
      publicationRequest(PUBLICATION, { headers: { "Content-Type": "text/plain" } }),
      publicationRequest(PUBLICATION, { headers: { Upgrade: "websocket" } }),
      publicationRequest(PUBLICATION, {
        headers: { [INTERNAL_RENDEZVOUS_GENERATION_HEADER]: GENERATION },
      }),
      publicationRequest({ ...PUBLICATION, textComment: "x".repeat(2_049) }),
    ]) {
      await expect(validateInternalRendezvousPublication(request)).resolves.toBeNull();
    }
  });

  it("rejects every deviation from the fixed URL and bodyless GET upgrade", () => {
    const invalid = [
      internalRequest("client", {}, "https://rendezvous.internal/"),
      internalRequest("client", {}, `${INTERNAL_RENDEZVOUS_URL}/`),
      internalRequest("client", {}, `${INTERNAL_RENDEZVOUS_URL}?role=client`),
      internalRequest("client", { method: "HEAD" }),
      internalRequest("client", { method: "POST", body: "" }),
      internalRequest("client", { headers: { Upgrade: "h2c" } }),
      internalRequest("client", { headers: { Upgrade: "WebSocket" } }),
    ];
    for (const request of invalid) {
      expect(validateInternalRendezvousUpgrade(request)).toBeNull();
    }
  });

  it("rejects body metadata even when no body stream is present", () => {
    for (const header of [
      "Content-Length",
      "Content-Type",
      "Content-Encoding",
      "Transfer-Encoding",
    ]) {
      const value = header === "Content-Length" ? "0" : "identity";
      const request = internalRequest("client", {
        headers: { [header]: value },
      });
      expect(validateInternalRendezvousUpgrade(request), header).toBeNull();
    }
  });
});

describe("rendezvous signal contract", () => {
  it("rejects every retired invitation authorization frame", () => {
    for (const frame of Object.values(inviteVector.frames)) {
      expect(parseRendezvousSignal(frame)).toMatchObject({ ok: false });
    }
  });

  it("accepts only the canonical bounded grant initialization frame", () => {
    const frame = JSON.stringify({ type: "access_init", version: 1,
      grant: TICKET, client_nonce: "b".repeat(64) });
    expect(parseAccessInit(frame)).toEqual({ ok: true, access: true,
      grant: TICKET, clientNonce: "b".repeat(64), bytes: frame.length });
    for (const malformed of [
      ` ${frame}`, frame + " ", frame.replace('"version":1', '"version":2'),
      frame.replace('"version":1', '"version":1,"version":1'),
      frame.replace(TICKET, TICKET.toUpperCase()),
      frame.replace('"type":"access_init","version":1', '"version":1,"type":"access_init"'),
      frame.slice(0,-1) + ',"extra":true}', "x".repeat(257), "null", "[]",
    ]) expect(parseAccessInit(malformed)).toBeNull();
    expect(parseAccessInit(new ArrayBuffer(1))).toBeNull();
  });

  it("normalizes client candidates and serializes classic property order", () => {
    const input = JSON.stringify({
      ticket: TICKET,
      port: 1_730,
      host: "[2001:0DB8::1]",
      type: "client_candidate",
    });
    const parsed = parseRendezvousSignal(input);
    expect(parsed).toEqual({
      ok: true,
      signal: {
        type: "client_candidate",
        host: "2001:0db8:0000:0000:0000:0000:0000:0001",
        port: 1_730,
        ticket: TICKET,
      },
      serialized:
        '{"type":"client_candidate","host":"2001:0db8:0000:0000:0000:0000:0000:0001","port":1730,"ticket":"' +
        TICKET +
        '"}',
      bytes: new TextEncoder().encode(input).byteLength,
    });
  });

  it("accepts exactly the existing server signaling candidate kinds", () => {
    for (const kind of ["lan", "ipv6", "mapped", "srflx"] as const) {
      const parsed = parseRendezvousSignal(JSON.stringify({
        type: "server_candidate",
        host: "192.000.002.001",
        port: 65_535,
        kind,
        ticket: TICKET,
      }));
      expect(parsed.ok, kind).toBe(true);
      if (parsed.ok) {
        expect(parsed.signal).toEqual({
          type: "server_candidate",
          host: "192.0.2.1",
          port: 65_535,
          kind,
          ticket: TICKET,
        });
        expect(parsed.serialized).toBe(
          `{"type":"server_candidate","host":"192.0.2.1",` +
          `"port":65535,"kind":"${kind}","ticket":"${TICKET}"}`,
        );
      }
    }

    for (const kind of ["prflx", "directory", "direct", "relay", "LAN"]) {
      expect(parseRendezvousSignal(JSON.stringify({
        type: "server_candidate",
        host: "192.0.2.1",
        port: 1,
        kind,
        ticket: TICKET,
      }))).toEqual({ ok: false, error: "unsupported_signal" });
    }
  });

  it("accepts and canonically serializes completion", () => {
    const input = `{ "ticket": "${TICKET}", "type": "complete" }`;
    const parsed = parseRendezvousSignal(input);
    expect(parsed).toMatchObject({
      ok: true,
      signal: { type: "complete", ticket: TICKET },
      serialized: `{"type":"complete","ticket":"${TICKET}"}`,
    });
    expect(serializeRendezvousSignal({
      type: "complete",
      ticket: TICKET,
    })).toBe(`{"type":"complete","ticket":"${TICKET}"}`);
  });

  it("enforces exact keys for every signaling shape", () => {
    const invalid: unknown[] = [
      null,
      [],
      "candidate",
      1,
      {},
      { type: "complete" },
      { type: "complete", ticket: TICKET, extra: false },
      {
        type: "client_candidate",
        host: "192.0.2.1",
        port: 1,
        ticket: TICKET,
        kind: "lan",
      },
      {
        type: "server_candidate",
        host: "192.0.2.1",
        port: 1,
        ticket: TICKET,
      },
      {
        type: "server_candidate",
        host: "192.0.2.1",
        port: 1,
        kind: "lan",
        ticket: TICKET,
        extra: null,
      },
    ];
    for (const fixture of invalid) {
      expect(
        parseRendezvousSignal(JSON.stringify(fixture)),
        JSON.stringify(fixture),
      )
        .toEqual({ ok: false, error: "unsupported_signal" });
    }
  });

  it("rejects non-numeric hosts, invalid ports, and non-lowercase tickets", () => {
    const base = {
      type: "client_candidate",
      host: "192.0.2.1",
      port: 1_730,
      ticket: TICKET,
    };
    for (const host of [
      "example.test",
      "192.0.2.1:1730",
      "[192.0.2.1]",
      "2001:db8::1%eth0",
      "",
    ]) {
      expect(parseRendezvousSignal(JSON.stringify({ ...base, host })), host)
        .toEqual({ ok: false, error: "unsupported_signal" });
    }
    for (const port of [0, 65_536, -1, 1.5, "1730", null]) {
      expect(
        parseRendezvousSignal(JSON.stringify({ ...base, port })),
        String(port),
      )
        .toEqual({ ok: false, error: "unsupported_signal" });
    }
    for (const ticket of [
      "A".repeat(64),
      "a".repeat(63),
      "g".repeat(64),
      1,
    ]) {
      expect(parseRendezvousSignal(JSON.stringify({ ...base, ticket })))
        .toEqual({ ok: false, error: "unsupported_signal" });
    }
  });

  it("distinguishes binary, oversized, malformed, and unsupported frames", () => {
    expect(parseRendezvousSignal(new Uint8Array([123, 125]).buffer)).toEqual({
      ok: false,
      error: "binary",
    });
    expect(parseRendezvousSignal("x".repeat(MAX_SIGNAL_BYTES + 1))).toEqual({
      ok: false,
      error: "too_large",
    });
    expect(parseRendezvousSignal("é".repeat(257))).toEqual({
      ok: false,
      error: "too_large",
    });
    expect(parseRendezvousSignal("{")).toEqual({
      ok: false,
      error: "invalid_json",
    });
    expect(parseRendezvousSignal("null")).toEqual({
      ok: false,
      error: "unsupported_signal",
    });
  });

  it("accepts exactly 512 input bytes and rejects 513", () => {
    const base = `{"type":"complete","ticket":"${TICKET}"}`;
    const exact = base + " ".repeat(MAX_SIGNAL_BYTES - base.length);
    const over = `${exact} `;
    expect(new TextEncoder().encode(exact)).toHaveLength(MAX_SIGNAL_BYTES);
    expect(new TextEncoder().encode(over)).toHaveLength(MAX_SIGNAL_BYTES + 1);

    const parsed = parseRendezvousSignal(exact);
    expect(parsed).toMatchObject({ ok: true, bytes: MAX_SIGNAL_BYTES });
    expect(parseRendezvousSignal(over)).toEqual({
      ok: false,
      error: "too_large",
    });
  });
});

describe("rendezvous structural constants", () => {
  it("keeps all work budgets fixed and internally consistent", () => {
    expect(MAX_SIGNAL_BYTES).toBe(512);
    expect(MAX_SERVER_CANDIDATES).toBe(12);
    expect(MAX_RENDEZVOUS_CLIENT_SOCKETS).toBe(64);
    expect(RENDEZVOUS_ROLLING_WINDOW_MS).toBe(86_400_000);
    expect(MAX_CLIENT_AUTHORIZATION_FRAMES).toBe(2);
    expect(MAX_SERVER_AUTHORIZATION_FRAMES).toBe(2);
    expect(MAX_RENDEZVOUS_SESSION_SIGNAL_BYTES).toBe(9_216);
    expect(MAX_RENDEZVOUS_SESSION_SIGNAL_BYTES).toBe(
      MAX_SIGNAL_BYTES * (2 + 2 + 1 + MAX_SERVER_CANDIDATES + 1),
    );
    expect(SERVER_SIGNAL_CANDIDATE_KINDS).toEqual([
      "lan", "ipv6", "mapped", "srflx",
    ]);
    expect(Object.isFrozen(SERVER_SIGNAL_CANDIDATE_KINDS)).toBe(true);
  });

  it("uses unique private close codes and bounded non-secret reasons", () => {
    const closes = Object.values(RENDEZVOUS_CLOSE);
    expect(new Set(closes.map(({ code }) => code)).size).toBe(closes.length);
    for (const { code, reason } of closes) {
      expect(code).toBeGreaterThanOrEqual(4_000);
      expect(code).toBeLessThanOrEqual(4_999);
      expect(new TextEncoder().encode(reason).byteLength).toBeLessThanOrEqual(
        MAX_WEBSOCKET_CLOSE_REASON_BYTES,
      );
    }
    expect(NORMAL_RENDEZVOUS_CLOSE.code).toBe(1_000);
    expect(new TextEncoder().encode(NORMAL_RENDEZVOUS_CLOSE.reason).byteLength)
      .toBeLessThanOrEqual(MAX_WEBSOCKET_CLOSE_REASON_BYTES);
  });
});
