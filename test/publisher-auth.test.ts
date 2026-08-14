import publisherFixture from "./fixtures/metaserver-publisher-v1.json";
import gamePublisherFixture from "./fixtures/metaserver-game-publisher-v1.json";
import classicV2Fixture from "./fixtures/metaserver-classic-publisher-v2.json";
import { describe, expect, it } from "vitest";

import { HttpError } from "../src/http";
import {
  authenticateClassicPublish,
  authenticateClassicV2Publish,
  authenticateGamePublish,
  PUBLISH_MAXIMUM_BODY_BYTES,
  readBoundedPublishBody,
} from "../src/publisher-auth";

interface ClassicV2Vector {
  readonly body: string;
  readonly content_digest: string;
  readonly created: number;
  readonly nonce: string;
  readonly path: string;
  readonly sequence: string;
  readonly signature_header: string;
  readonly signature_input: string;
}

function classicV2Request(vector: ClassicV2Vector): Request {
  return new Request(`https://${classicV2Fixture.authority}${vector.path}`, {
    method: "POST",
    headers: {
      "Atrinik-Publish-Sequence": vector.sequence,
      "Atrinik-Server-ID": classicV2Fixture.server_id,
      "Content-Digest": vector.content_digest,
      "Content-Type": classicV2Fixture.content_type,
      Signature: vector.signature_header,
      "Signature-Input": vector.signature_input,
    },
    body: vector.body,
  });
}

function requestFromSignatureBase(vector: {
  readonly body: string;
  readonly signature_base: string;
  readonly signature_base64: string;
}): Request {
  const values = new Map<string, string>();
  for (const line of vector.signature_base.split("\n")) {
    const separator = line.indexOf(": ");
    if (separator < 1) {
      throw new Error("Protocol fixture signature base is malformed");
    }
    values.set(line.slice(1, separator - 1), line.slice(separator + 2));
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (value === undefined) {
      throw new Error(`Protocol fixture omits ${name}`);
    }
    return value;
  };
  return new Request(
    `https://${required("@authority")}${required("@path")}`,
    {
      method: required("@method"),
      headers: {
        "Atrinik-Publish-Sequence": required("atrinik-publish-sequence"),
        "Atrinik-Server-ID": required("atrinik-server-id"),
        "Content-Digest": required("content-digest"),
        "Content-Type": required("content-type"),
        Signature: `atrinik=:${vector.signature_base64}:`,
        "Signature-Input": `atrinik=${required("@signature-params")}`,
      },
      body: vector.body,
    },
  );
}

async function authenticateClassicV2(request: Request, now: number) {
  return authenticateClassicV2Publish(
    request,
    await readBoundedPublishBody(request.clone()),
    classicV2Fixture.server_id,
    classicV2Fixture.authority,
    now,
  );
}

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

describe("Classic v2 protocol-owned publisher vectors", () => {
  it("accepts every signed v2 policy and endpoint combination", async () => {
    for (const vector of classicV2Fixture.positive) {
      const authenticated = await authenticateClassicV2(
        classicV2Request(vector),
        vector.created,
      );
      expect(authenticated).toMatchObject({
        sequence: vector.sequence,
        nonce: vector.nonce,
        payload: JSON.parse(vector.body),
      });
    }
  });

  it("rejects every language-neutral v2 body negative", async () => {
    const positive = classicV2Fixture.positive[0];
    if (positive === undefined) {
      throw new Error("Protocol fixture omits a positive vector");
    }
    for (const vector of classicV2Fixture.negative) {
      const request = classicV2Request({ ...positive, body: vector.body });
      await expect(authenticateClassicV2(request, positive.created)).rejects
        .toBeInstanceOf(HttpError);
    }
  });

  it("rejects every cryptographic, identity, and route-domain negative", async () => {
    for (const vector of classicV2Fixture.signature_negative) {
      await expect(authenticateClassicV2(
        requestFromSignatureBase(vector),
        classicV2Fixture.positive[0]?.created ?? 0,
      )).rejects.toBeInstanceOf(HttpError);
    }
  });

  it("rejects both frozen cross-version replay directions", async () => {
    const v1AtV2 = classicV2Fixture.cross_profile_replay.find(
      (vector) => vector.name === "v1-at-v2",
    );
    const v2AtV1 = classicV2Fixture.cross_profile_replay.find(
      (vector) => vector.name === "v2-at-v1",
    );
    expect(v1AtV2).toBeDefined();
    expect(v2AtV1).toBeDefined();
    await expect(authenticateClassicV2(
      requestFromSignatureBase({
        body: v1AtV2!.body,
        signature_base: v1AtV2!.target_signature_base,
        signature_base64: v1AtV2!.signature_base64,
      }),
      classicV2Fixture.positive[0]?.created ?? 0,
    )).rejects.toBeInstanceOf(HttpError);
    const request = requestFromSignatureBase({
      body: v2AtV1!.body,
      signature_base: v2AtV1!.target_signature_base,
      signature_base64: v2AtV1!.signature_base64,
    });
    await expect(authenticateClassicPublish(
      request,
      await readBoundedPublishBody(request.clone()),
      classicV2Fixture.server_id,
      classicV2Fixture.authority,
      classicV2Fixture.positive[0]?.created ?? 0,
    )).rejects.toBeInstanceOf(HttpError);
  });
});

describe("Game Protocol 1 signed publisher authentication", () => {
  function gameRequest(body = gamePublisherFixture.body): Request {
    return new Request(
      `https://${gamePublisherFixture.authority}${gamePublisherFixture.path}`,
      {
        method: "POST",
        headers: {
          "Atrinik-Publish-Sequence": gamePublisherFixture.sequence,
          "Atrinik-Server-ID": gamePublisherFixture.server_id,
          "Content-Digest": gamePublisherFixture.content_digest,
          "Content-Type": gamePublisherFixture.content_type,
          "Signature": gamePublisherFixture.signature_header,
          "Signature-Input": gamePublisherFixture.signature_input,
        },
        body,
      },
    );
  }

  async function authenticateGame(request: Request) {
    return authenticateGamePublish(
      request,
      await readBoundedPublishBody(request.clone()),
      gamePublisherFixture.server_id,
      gamePublisherFixture.authority,
      gamePublisherFixture.created,
    );
  }

  it("verifies the protocol-owned Game body, certificate, and signature", async () => {
    const authenticated = await authenticateGame(gameRequest());
    expect(authenticated.sequence).toBe(gamePublisherFixture.sequence);
    expect(authenticated.nonce).toBe(gamePublisherFixture.nonce);
    expect(authenticated.payload).toEqual(JSON.parse(gamePublisherFixture.body));
    expect(authenticated.certificateDer.byteLength).toBeGreaterThan(0);
  });

  it("rejects every language-neutral negative body before state admission", async () => {
    for (const vector of gamePublisherFixture.negative) {
      await expect(authenticateGame(gameRequest(vector.body))).rejects
        .toMatchObject({
          code: vector.error === "invalid_identity"
            ? "unauthorized"
            : "bad_request",
        });
    }
  });

  it("keeps classic and Game schema, path, and signature domains disjoint", async () => {
    const classic = fixtureRequest();
    await expect(authenticateGamePublish(
      classic,
      await readBoundedPublishBody(classic.clone()),
      publisherFixture.server_id,
      publisherFixture.authority,
      NOW,
    )).rejects.toMatchObject({ code: "bad_request" });
    const game = gameRequest();
    await expect(authenticateClassicPublish(
      game,
      await readBoundedPublishBody(game.clone()),
      gamePublisherFixture.server_id,
      gamePublisherFixture.authority,
      gamePublisherFixture.created,
    )).rejects.toMatchObject({ code: "bad_request" });
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
