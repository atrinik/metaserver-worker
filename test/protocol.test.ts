import { describe, expect, it } from "vitest";

import {
  isDirectoryText,
  isGameDirectoryText,
} from "../src/directory-state";
import {
  constantTimeEqual,
  deriveStoredKey,
  deriveUpdateProof,
  escapeXml,
  formatOtpResponse,
  normalizeIpAddress,
  parseUpdatePayload,
  RequestError,
  sha512Hex,
} from "../src/protocol";

function validForm(): FormData {
  const form = new FormData();
  form.set("server_id", "1".repeat(64));
  form.set("quic_host", "198.51.100.20");
  form.set("quic_port", "1730");
  form.set("quic_cert_sha256", "1".repeat(64));
  form.set("num_players", "2");
  form.set("name", "Test & Friends");
  form.set("version", "4.0.0");
  form.set("text_comment", "Ready <now>");
  form.set("otp", "otp-value");
  form.set("cotp", "b".repeat(128));
  form.set("key", "a".repeat(128));
  form.set("registration", "1");
  return form;
}

describe("protocol helpers", () => {
  it("matches the C authentication formula", async () => {
    expect(await sha512Hex("abc")).toBe(
      "ddaf35a193617abacc417349ae204131" +
      "12e6fa4e89a97ea20a9eeee64b55d39a" +
      "2192992a274fc1a836ba3c23a3feebbd" +
      "454d4423643ce80e2a9ac94fa54ca49f",
    );
    const stored = await deriveStoredKey("a".repeat(128), "1".repeat(64));
    const proof = await deriveUpdateProof("otp", stored, "b".repeat(128));
    expect(proof).toMatch(/^[0-9a-f]{128}$/);
    await expect(constantTimeEqual(proof, proof)).resolves.toBe(true);
    await expect(constantTimeEqual(proof, "0".repeat(128))).resolves.toBe(false);
    await expect(constantTimeEqual(proof, "short")).resolves.toBe(false);
  });

  it("keeps the exact OTP response expected by the C parser", () => {
    expect(formatOtpResponse("token")).toBe('{"otp": "token"}');
  });

  it("canonicalizes IP addresses", () => {
    expect(normalizeIpAddress("[2001:0DB8::1]")).toBe(
      "2001:0db8:0000:0000:0000:0000:0000:0001",
    );
    expect(normalizeIpAddress("::ffff:192.0.2.1")).toBe(
      "0000:0000:0000:0000:0000:ffff:c000:0201",
    );
    expect(normalizeIpAddress("[::ffff:192.0.2.1]")).toBe(
      "0000:0000:0000:0000:0000:ffff:c000:0201",
    );
    expect(normalizeIpAddress("2001:db8::192.0.2.1")).toBe(
      "2001:0db8:0000:0000:0000:0000:c000:0201",
    );
  });

  it("rejects zones, malformed brackets, and non-terminal embedded IPv4", () => {
    for (const address of [
      "192.0.2.1%zone",
      "2001:db8::1%eth0",
      "2001:db8::1%",
      "[2001:db8::1%eth0]",
      "[192.0.2.1]",
      "[2001:db8::1",
      "2001:db8::1]",
      "[[2001:db8::1]]",
      "2001:[db8::1]",
      "[2001:db8::1]:443",
      "192.0.2.1:1:2:3:4:5:6",
      "1:192.0.2.1:2:3:4:5:6",
      "::192.0.2.1:1",
      "192.0.2.1::",
      "1.2.3.4:5.6.7.8:1:2:3:4",
      "1::2::3",
      "1:2:3:4:5:6:7:8:9",
      "2001:db8",
      "[]",
      "",
    ]) {
      expect(() => normalizeIpAddress(address), address).toThrow(RequestError);
    }
  });

  it("parses a complete QUIC update and rejects malformed fields", () => {
    const parsed = parseUpdatePayload(validForm());
    expect(parsed.serverId).toBe("1".repeat(64));
    expect(parsed.quicPort).toBe(1730);
    expect(parsed.playersCount).toBe(2);
    expect(parsed.isPublic).toBe(false);

    for (const [field, value] of [
      ["quic_port", "1730junk"],
      ["quic_port", "0"],
      ["quic_port", "65536"],
      ["num_players", "2players"],
      ["num_players", "4294967296"],
      ["server_id", "z".repeat(64)],
      ["quic_cert_sha256", "2".repeat(63)],
      ["quic_cert_sha256", "2".repeat(64)],
    ]) {
      const form = validForm();
      form.set(field, value);
      expect(() => parseUpdatePayload(form)).toThrow(RequestError);
    }
  });

  it("enforces directory text byte and control-character bounds", () => {
    for (const [field, value] of [
      ["name", "😀".repeat(21)],
      ["version", "é".repeat(17)],
      ["text_comment", "😀".repeat(65)],
      ["name", "contains\nnewline"],
      ["version", "contains\u007fdelete"],
      ["text_comment", "contains\u0000nul"],
      ["name", "contains\ufffenoncharacter"],
      ["text_comment", "contains\uffffnoncharacter"],
    ]) {
      const form = validForm();
      form.set(field, value);
      expect(() => parseUpdatePayload(form), field).toThrow(RequestError);
    }

    const unicode = validForm();
    unicode.set("name", "Café 🐉");
    unicode.set("text_comment", "Bienvenue — 游んでいって");
    expect(parseUpdatePayload(unicode)).toMatchObject({
      name: "Café 🐉",
      textComment: "Bienvenue — 游んでいって",
    });
    expect(isDirectoryText("unpaired\ud800surrogate", 80, false)).toBe(false);
  });

  it("applies the stricter Game Protocol 1 display-text scalar contract", () => {
    for (const scalar of ["\u0085", "\u2028", "\u2029"]) {
      expect(isDirectoryText(`before${scalar}after`, 80, false)).toBe(true);
      expect(isGameDirectoryText(`before${scalar}after`, 80, false)).toBe(false);
    }
    for (const scalar of ["\ufffe", "\uffff"]) {
      expect(isDirectoryText(`before${scalar}after`, 80, false)).toBe(false);
      expect(isGameDirectoryText(`before${scalar}after`, 80, false)).toBe(false);
    }
    expect(isGameDirectoryText("Café 🐉", 80, false)).toBe(true);
    expect(isGameDirectoryText("😀".repeat(21), 80, false)).toBe(false);
    expect(isGameDirectoryText("unpaired\udfff", 80, false)).toBe(false);
  });

  it("rejects duplicate required and optional update fields", () => {
    for (const [field, value] of [
      ["otp", "second-token"],
      ["server_id", "2".repeat(64)],
      ["quic_host", "198.51.100.21"],
      ["public", "0"],
    ]) {
      const form = validForm();
      if (!form.has(field)) {
        form.set(field, "1");
      }
      form.append(field, value);
      expect(() => parseUpdatePayload(form)).toThrow(RequestError);
    }
  });

  it("escapes XML control and markup characters", () => {
    expect(escapeXml("<&a\u0000b\ufffe\uffff'\"")).toBe(
      "&lt;&amp;ab&apos;&quot;",
    );
  });
});
