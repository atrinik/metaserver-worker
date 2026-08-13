import { describe, expect, it } from "vitest";

import {
  constantTimeEqual,
  DIRECT_CANDIDATE_KINDS,
  normalizeIpAddress,
  randomToken,
  RequestError,
  SERVER_SIGNAL_CANDIDATE_KINDS,
  sha256Hex,
} from "../src/protocol";

describe("canonical protocol helpers", () => {
  it("hashes, compares, and generates bounded tokens", async () => {
    await expect(sha256Hex("abc")).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    await expect(constantTimeEqual("same", "same")).resolves.toBe(true);
    await expect(constantTimeEqual("same", "different")).resolves.toBe(false);
    expect(randomToken()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("retains only canonical rendezvous candidate kinds", () => {
    expect(DIRECT_CANDIDATE_KINDS).toEqual([
      "lan", "ipv6", "prflx", "mapped", "srflx", "directory",
    ]);
    expect(SERVER_SIGNAL_CANDIDATE_KINDS).toEqual([
      "lan", "ipv6", "mapped", "srflx",
    ]);
  });

  it("canonicalizes IPv4 and IPv6 addresses", () => {
    expect(normalizeIpAddress("192.000.002.010")).toBe("192.0.2.10");
    expect(normalizeIpAddress("[2001:0DB8::1]")).toBe(
      "2001:0db8:0000:0000:0000:0000:0000:0001",
    );
    expect(normalizeIpAddress("::ffff:192.0.2.1")).toBe(
      "0000:0000:0000:0000:0000:ffff:c000:0201",
    );
  });

  it("rejects malformed, scoped, or ambiguous addresses", () => {
    for (const address of [
      "192.0.2.1%zone", "2001:db8::1%eth0", "[192.0.2.1]",
      "[2001:db8::1", "[2001:db8::1]:443", "1::2::3", "",
    ]) {
      expect(() => normalizeIpAddress(address)).toThrow(RequestError);
    }
  });
});
