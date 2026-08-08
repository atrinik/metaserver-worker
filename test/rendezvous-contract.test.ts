import { describe, expect, it } from "vitest";

import { SERVER_SIGNAL_CANDIDATE_KINDS } from "../src/protocol";

import {
  INTERNAL_RENDEZVOUS_ROLE_HEADER,
  INTERNAL_RENDEZVOUS_URL,
  LEGACY_INTERNAL_RENDEZVOUS_ROLE_HEADER,
  MAX_RENDEZVOUS_SESSION_SIGNAL_BYTES,
  MAX_RENDEZVOUS_CLIENT_SOCKETS,
  MAX_SERVER_CANDIDATES,
  MAX_SIGNAL_BYTES,
  MAX_WEBSOCKET_CLOSE_REASON_BYTES,
  NORMAL_RENDEZVOUS_CLOSE,
  parseRendezvousSignal,
  RENDEZVOUS_CLOSE,
  RENDEZVOUS_ROLLING_WINDOW_MS,
  serializeRendezvousSignal,
  validateInternalRendezvousUpgrade,
} from "../src/rendezvous-contract";

const TICKET = "a".repeat(64);

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
  return new Request(url, { ...init, headers });
}

describe("internal rendezvous upgrade contract", () => {
  it("accepts only the two exact versioned internal roles", () => {
    expect(validateInternalRendezvousUpgrade(internalRequest("client"))).toBe(
      "client",
    );
    expect(validateInternalRendezvousUpgrade(internalRequest("server"))).toBe(
      "server",
    );
    expect(INTERNAL_RENDEZVOUS_URL).toContain("/v1");
    expect(INTERNAL_RENDEZVOUS_ROLE_HEADER).toContain("V1");
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
    expect(MAX_RENDEZVOUS_SESSION_SIGNAL_BYTES).toBe(7_168);
    expect(MAX_RENDEZVOUS_SESSION_SIGNAL_BYTES).toBe(
      MAX_SIGNAL_BYTES * (1 + MAX_SERVER_CANDIDATES + 1),
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
