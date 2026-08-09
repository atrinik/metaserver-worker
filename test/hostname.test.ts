import { describe, expect, it } from "vitest";

import { isCanonicalHostname } from "../src/hostname";

describe("canonical explicit directory hostname", () => {
  it.each([
    "play.example.net",
    "xn--bcher-kva.example.org",
    "123.example",
    "0x7f.example",
    `${"a".repeat(63)}.example`,
    `${Array.from({ length: 25 }, () => "a".repeat(9)).join(".")}.io`,
  ])("accepts %s", (hostname) => {
    expect(isCanonicalHostname(hostname)).toBe(true);
  });

  it.each([
    "192.0.2.1",
    "127.1",
    "0177.0.0.1",
    "0x7f.0.0.1",
    "0x7f.0x0.0x0.0x1",
    "2130706433",
    "[2001:db8::1]",
    "2001:db8::1",
    "fe80::1%eth0",
    "localhost",
    "PLAY.example.net",
    "play.example.net.",
    "play..example",
    "-play.example",
    "play-.example",
    "play_example.net",
    "play.example.net:1730",
    "https://play.example.net",
    "user@play.example.net",
    "*.example.net",
    "pláy.example.net",
    "xn--a.example.org",
    "xn--0.example.org",
    "xn--0ca24w.example.org",
    `${"a".repeat(64)}.example`,
    `${"a".repeat(250)}.io`,
    "",
  ])("rejects %s", (hostname) => {
    expect(isCanonicalHostname(hostname)).toBe(false);
  });
});
