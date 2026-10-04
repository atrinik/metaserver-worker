import { describe, expect, it } from "vitest";
import { parseAccessRoutePayload } from "../src/access-route-auth";
const input = {
  schema: "atrinik-access-route-v1", profile: "classic", serverId: "1".repeat(64),
  certificate: "AA==", operation: "reserve", requestId: "2".repeat(32),
  tokenId: "3".repeat(32), tokenRevision: "18446744073709551615",
  index: "4".repeat(64), reservationId: null, expiresAt: null,
};
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

describe("signed access route canonical body", () => {
  it("accepts a canonical typed tuple with never expiry and uint64 revision", () => {
    expect(parseAccessRoutePayload(encode(input))).toEqual(input);
  });
  it.each([
    { tokenRevision: "0" }, { tokenRevision: "01" },
    { tokenRevision: "18446744073709551616" }, { expiresAt: "253402300800" },
    { expiresAt: "0" }, { expiresAt: 123 }, { profile: "classic-v3" },
    { operation: "activate" }, { operation: "delete" }, { reservationId: "a".repeat(32) },
    { requestId: "A".repeat(32) }, { index: "0".repeat(63) }, { extra: true },
  ])("rejects unknown, noncanonical and cross-operation values", (change) => {
    expect(() => parseAccessRoutePayload(encode({ ...input, ...change }))).toThrow();
  });
  it("rejects duplicate keys even when their last value is canonical", () => {
    const body = JSON.stringify(input).replace('"profile":"classic"', '"profile":"game","profile":"classic"');
    expect(() => parseAccessRoutePayload(new TextEncoder().encode(body))).toThrow();
  });
  it("rejects whitespace, alternate key order and UTF-8 replacement", () => {
    expect(() => parseAccessRoutePayload(new TextEncoder().encode(" " + JSON.stringify(input)))).toThrow();
    const { schema, ...rest } = input;
    expect(() => parseAccessRoutePayload(encode({ ...rest, schema }))).toThrow();
    expect(() => parseAccessRoutePayload(new Uint8Array([0xff]))).toThrow();
  });
});
