import publisherFixture from "./fixtures/metaserver-publisher-v1.json";
import { describe, expect, it } from "vitest";

import { HttpError } from "../src/http";
import {
  authenticateClassicPublish,
  PUBLISH_MAXIMUM_BODY_BYTES,
  readBoundedPublishBody,
} from "../src/publisher-auth";

const NOW = publisherFixture.created;

function fixtureRequest(overrides: {
  readonly body?: string;
  readonly headers?: Record<string, string>;
  readonly path?: string;
} = {}): Request {
  const body = overrides.body ?? publisherFixture.body;
  const headers = new Headers({
    "Atrinik-Publish-Sequence": publisherFixture.sequence,
    "Atrinik-Server-ID": publisherFixture.server_id,
    "Content-Digest": publisherFixture.content_digest,
    "Content-Type": publisherFixture.content_type,
    "Signature": publisherFixture.signature_header,
    "Signature-Input": publisherFixture.signature_input,
    ...overrides.headers,
  });
  return new Request(
    `https://${publisherFixture.authority}${overrides.path ?? publisherFixture.path}`,
    { method: "POST", headers, body },
  );
}

async function authenticate(request: Request) {
  const body = await readBoundedPublishBody(request.clone());
  return authenticateClassicPublish(
    request,
    body,
    publisherFixture.server_id,
    publisherFixture.authority,
    NOW,
  );
}

async function expectCode(request: Request, code: string): Promise<void> {
  try {
    await authenticate(request);
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}`);
}

describe("signed publisher authentication", () => {
  it("verifies the protocol-owned certificate and RFC 9421 fixture", async () => {
    const authenticated = await authenticate(fixtureRequest());
    expect(authenticated.sequence).toBe(publisherFixture.sequence);
    expect(authenticated.nonce).toBe(publisherFixture.nonce);
    expect(authenticated.nonceExpiresAt).toBe(NOW + 86_400);
    expect(authenticated.payload).toEqual(JSON.parse(publisherFixture.body));
    expect(authenticated.certificateDer.byteLength).toBeGreaterThan(0);
  });

  it("rejects signed component and identity mutations", async () => {
    const changedBody = publisherFixture.changed.body;
    const cases = [
      fixtureRequest({ headers: { "Atrinik-Publish-Sequence": "7" } }),
      fixtureRequest({ headers: { "Atrinik-Server-ID": "0".repeat(64) } }),
      fixtureRequest({ headers: { "Content-Digest": "sha-256=:" + "A".repeat(43) + "=:" } }),
      fixtureRequest({ headers: { "Content-Type": "application/json; charset=utf-8" } }),
      fixtureRequest({ headers: { Signature: publisherFixture.signature_header.replace("R", "S") } }),
      fixtureRequest({ headers: { "Signature-Input": publisherFixture.game_signature_input } }),
      fixtureRequest({ path: publisherFixture.game_path }),
      fixtureRequest({
        body: changedBody,
        headers: { "Content-Digest": publisherFixture.changed.content_digest },
      }),
    ];
    for (const request of cases) {
      await expectCode(request, "unauthorized");
    }
  });

  it("rejects stale, future, malformed, and ambiguous signature metadata", async () => {
    const current = fixtureRequest();
    const body = await readBoundedPublishBody(current.clone());
    await expect(authenticateClassicPublish(
      current,
      body,
      publisherFixture.server_id,
      publisherFixture.authority,
      publisherFixture.expires + 1,
    )).rejects.toMatchObject({ code: "unauthorized" });
    await expect(authenticateClassicPublish(
      current,
      body,
      publisherFixture.server_id,
      publisherFixture.authority,
      publisherFixture.created - 301,
    )).rejects.toMatchObject({ code: "unauthorized" });
    await expect(authenticateClassicPublish(
      current,
      body,
      publisherFixture.server_id,
      publisherFixture.authority,
      publisherFixture.created - 300,
    )).resolves.toMatchObject({ sequence: publisherFixture.sequence });

    for (const value of [
      publisherFixture.signature_input.replace(";expires=1800000300", ";expires=1800000301"),
      publisherFixture.signature_input.replace(publisherFixture.nonce, "0".repeat(32)),
      publisherFixture.signature_input.replace(";alg=", ";unknown=1;alg="),
      `${publisherFixture.signature_input}, ${publisherFixture.signature_input}`,
    ]) {
      await expectCode(fixtureRequest({ headers: { "Signature-Input": value } }), "unauthorized");
    }
  });

  it("requires canonical JSON without duplicate or extra fields", async () => {
    const parsed = JSON.parse(publisherFixture.body) as Record<string, unknown>;
    await expectCode(fixtureRequest({
      body: ` ${publisherFixture.body}`,
    }), "bad_request");
    const bom = `\ufeff${publisherFixture.body}`;
    await expectCode(fixtureRequest({
      body: bom,
      headers: { "Content-Digest": await digestHeader(bom) },
    }), "bad_request");

    const duplicate = publisherFixture.body.replace(
      `"schema":"${String(parsed.schema)}",`,
      `"schema":"${String(parsed.schema)}","schema":"${String(parsed.schema)}",`,
    );
    const duplicateDigest = await digestHeader(duplicate);
    await expectCode(fixtureRequest({
      body: duplicate,
      headers: { "Content-Digest": duplicateDigest },
    }), "bad_request");

    const extra = JSON.stringify({ ...parsed, extra: true });
    await expectCode(fixtureRequest({
      body: extra,
      headers: { "Content-Digest": await digestHeader(extra) },
    }), "bad_request");

    for (const invalidName of [
      "\\ud800",
      "\\ud800A",
      "\\udc00",
      "\ufffe",
      "\uffff",
    ]) {
      const invalidScalar = publisherFixture.body.replace(
        '"name":"Atrinik Classic"',
        `"name":"${invalidName}"`,
      );
      await expectCode(fixtureRequest({
        body: invalidScalar,
        headers: { "Content-Digest": await digestHeader(invalidScalar) },
      }), "bad_request");
    }
  });

  it("accepts only a canonical paired explicit hostname before signature verification", async () => {
    const parsed = JSON.parse(publisherFixture.body) as Record<string, unknown>;
    for (const hostname of [
      "play.example.net",
      "xn--bcher-kva.example.org",
    ]) {
      const withHostname = JSON.stringify({
        ...parsed,
        hostname,
        port: 1730,
      });
      await expectCode(fixtureRequest({
        body: withHostname,
        headers: { "Content-Digest": await digestHeader(withHostname) },
      }), "unauthorized");
    }

    for (const hostname of ["192.0.2.1", "xn--a.example.org"]) {
      const invalidHostname = JSON.stringify({
        ...parsed,
        hostname,
        port: 1730,
      });
      await expectCode(fixtureRequest({
        body: invalidHostname,
        headers: { "Content-Digest": await digestHeader(invalidHostname) },
      }), "bad_request");
    }
  });

  it("bounds streamed request bodies before parsing", async () => {
    const oversized = new Request("https://publish.meta.atrinik.org/", {
      method: "POST",
      body: "x".repeat(PUBLISH_MAXIMUM_BODY_BYTES + 1),
    });
    await expect(readBoundedPublishBody(oversized)).rejects.toMatchObject({
      code: "payload_too_large",
    });
    await expect(readBoundedPublishBody(new Request(
      "https://publish.meta.atrinik.org/",
      { method: "POST", body: "" },
    ))).rejects.toMatchObject({ code: "body_required" });
  });
});

async function digestHeader(body: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(body),
  ));
  let binary = "";
  for (const byte of digest) {
    binary += String.fromCharCode(byte);
  }
  return `sha-256=:${btoa(binary)}:`;
}
