import { describe, expect, it } from "vitest";
import { accessRouteCapability, accessRouteIndex } from "../src/access-crypto";
import { parseAccessResolveRequest } from "../src/access-resolve";

const capability = "3cc820e9a4e884e9515c8f8b211d1fdfaeb75afa1319fd1a1728a050ebe1c60e";
const nonce = "a1".repeat(32);
const encode = (input: string) => new TextEncoder().encode(input);
const request = JSON.stringify({ schema: "atrinik-access-resolve-v1", routeCapability: capability, clientNonce: nonce });

describe("private access resolution boundary", () => {
  it("uses binary capability bytes and a literal domain NUL", async () => {
    expect(await accessRouteCapability("0123456789ABCDEF")).toBe(capability);
    expect(await accessRouteIndex(capability)).toBe(
      "3425b795e82775b1f46b88efe11f9fdf9ae11be61564479d71d3e2f9d80d6b3f",
    );
    await expect(accessRouteIndex(capability.toUpperCase())).rejects.toThrow();
  });

  it("accepts the exact canonical object", () => {
    expect(parseAccessResolveRequest(encode(request))).toEqual(JSON.parse(request));
    expect(() => parseAccessResolveRequest(encode(` { "clientNonce":"${nonce}", "schema":"atrinik-access-resolve-v1", "routeCapability":"${capability}" }\n`))).toThrow();
  });

  it.each([
    request.replace('"clientNonce"', '"routeCapability"'),
    request.replace('"clientNonce"', '"route\\u0043apability"'),
    request.replace('"clientNonce"', '"unknown"'),
    request.replace(`"${nonce}"`, "null"),
    request.replace(`"${nonce}"`, "[1]"),
    request.replace(`"${nonce}"`, `"${nonce.toUpperCase()}"`),
    request.replace(`"${capability}"`, `"${capability.slice(1)}"`),
    request.replace('"schema"', '"__proto__"'),
    request + "{}",
    "\uFEFF" + request,
    request.slice(0, -1),
    request.slice(0, -1) + ',"extra":"x"}',
    " ".repeat(513),
  ])("rejects malformed, duplicate, unknown or oversized fields", (input) => {
    expect(() => parseAccessResolveRequest(encode(input))).toThrow();
  });

  it("rejects invalid UTF-8 without replacement decoding", () => {
    expect(() => parseAccessResolveRequest(new Uint8Array([0xff]))).toThrow();
  });
});
