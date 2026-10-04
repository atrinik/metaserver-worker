import { describe, expect, it } from "vitest";
import vector from "./fixtures/access-routes-v1.json";
import { authenticateAccessRoute, parseAccessRoutePayload } from "../src/access-route-auth";
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


describe("protocol-owned route signatures", () => {
  it.each(vector.signature_vectors)("authenticates $operation and binds authority/profile/body", async (v) => {
    const headers={"Content-Type":"application/json","Content-Digest":v.content_digest,
      "Atrinik-Server-ID":v.server_id,"Atrinik-Publish-Sequence":v.sequence,
      Signature:v.signature_header,"Signature-Input":v.signature_input};
    const request=new Request(`https://${v.authority}${v.path}`,{method:"POST",headers,body:v.body});
    const body=new TextEncoder().encode(v.body);
    const parsed=parseAccessRoutePayload(body);
    expect((await authenticateAccessRoute(request,body,parsed.profile,v.server_id,v.authority,v.created)).payload).toEqual(parsed);
    await expect(authenticateAccessRoute(request,body,parsed.profile,v.server_id,"other.example.test",v.created)).rejects.toThrow();
    await expect(authenticateAccessRoute(request,body,parsed.profile === "classic" ? "game" : "classic",v.server_id,v.authority,v.created)).rejects.toThrow();
    await expect(authenticateAccessRoute(request,body,parsed.profile,v.server_id,v.authority,v.created+301)).rejects.toThrow();
  });
});
