import { describe, expect, it } from "vitest";

import {
  createRequestPrivacyContext,
  parseSourceTagKeyRing,
  RENDEZVOUS_REPLAY_TAG_VERSION,
  RequestPrivacyContext,
  requiredSourceTagKeyRing,
  SourceTagConfigurationError,
  SourceTagKeyEnvironment,
  SourceTagKeyConfiguration,
  SourceTagPurpose,
} from "../src/privacy";

const CURRENT_SECRET = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const PREVIOUS_SECRET = "__________________________________________8";
const SERVER_ID = "1".repeat(64);
const OTHER_SERVER_ID = "2".repeat(64);
const RENDEZVOUS_ROOM_ID = "a".repeat(64);
const RENDEZVOUS_CLIENT_TICKET = "b".repeat(64);
const SOURCE_TAG_NAMESPACE = "meta.example.test";

const CURRENT_CONFIGURATION: SourceTagKeyConfiguration = {
  currentKeyId: "2026-08",
  currentSecret: CURRENT_SECRET,
};

const ROTATING_CONFIGURATION: SourceTagKeyConfiguration = {
  ...CURRENT_CONFIGURATION,
  previousKeyId: "2026-07",
  previousSecret: PREVIOUS_SECRET,
};

function sourceRequest(sourceAddress?: string): Request {
  const headers = new Headers();
  if (sourceAddress !== undefined) {
    headers.set("CF-Connecting-IP", sourceAddress);
  }
  return new Request("https://publish.example.test/", { headers });
}

async function context(
  request = sourceRequest("192.0.2.10"),
  configuration = CURRENT_CONFIGURATION,
  namespace = SOURCE_TAG_NAMESPACE,
): Promise<RequestPrivacyContext> {
  return createRequestPrivacyContext(request, {
    keys: await parseSourceTagKeyRing(configuration),
    namespace,
  });
}

describe("privacy-safe source tags", () => {
  it("matches independently generated deterministic HMAC vectors", async () => {
    const privacy = await context();

    expect(await privacy.tag(SourceTagPurpose.GlobalIngress)).toBe(
      "v1.2026-08.RA_EdJMPqDYZch9WFQn0sszNHf1iSoD4brS4yzetq3I",
    );
    expect(await privacy.serverTag(
      SourceTagPurpose.RendezvousClientServer,
      SERVER_ID,
    )).toBe(
      "v1.2026-08.yCxLOdjopfJWBpmkqmOMsztsYx3xiO3GEeS2TVTP1A0",
    );

    expect(Object.keys(privacy).sort()).toEqual([
      "serverTag",
      "serverTags",
      "tag",
      "tags",
    ]);
    expect(JSON.stringify(privacy)).not.toContain("192.0.2.10");
  });

  it("uses the existing canonical IPv4 and IPv6 address semantics", async () => {
    const canonicalIpv4 = await context(sourceRequest("192.0.2.10"));
    const paddedIpv4 = await context(sourceRequest("192.000.002.010"));
    expect(await paddedIpv4.tag(SourceTagPurpose.GlobalIngress)).toBe(
      await canonicalIpv4.tag(SourceTagPurpose.GlobalIngress),
    );

    const compressedIpv6 = await context(sourceRequest("[2001:db8::1]"));
    const expandedIpv6 = await context(sourceRequest(
      "2001:0db8:0000:0000:0000:0000:0000:0001",
    ));
    expect(await compressedIpv6.tag(SourceTagPurpose.GlobalIngress)).toBe(
      await expandedIpv6.tag(SourceTagPurpose.GlobalIngress),
    );
    expect(await compressedIpv6.tag(SourceTagPurpose.GlobalIngress)).toBe(
      "v1.2026-08.ZbXZU0IN34gemqplm3rBbol1p9mq_KnkhuJ1NKFOPlk",
    );

    await expect(
      context(sourceRequest("[2001:db8::1%eth0]")),
    ).rejects.toMatchObject({
      message: "The source address is invalid",
      status: 400,
    });
  });

  it("separates public deployment namespaces without changing tag shape", async () => {
    const production = await context();
    const canary = await context(
      sourceRequest("192.0.2.10"),
      CURRENT_CONFIGURATION,
      "canary.meta.example.test",
    );

    const productionTag = await production.tag(
      SourceTagPurpose.GlobalIngress,
    );
    const canaryTag = await canary.tag(SourceTagPurpose.GlobalIngress);
    expect(canaryTag).toBe(
      "v1.2026-08.lLMBDJU43ZVPWFHiSOCxDQnTRs7HEEiWpFh4NirQu2g",
    );
    expect(canaryTag).not.toBe(productionTag);
    expect(productionTag).toMatch(
      /^v1\.2026-08\.[A-Za-z0-9_-]{43}$/,
    );
    expect(canaryTag).toMatch(/^v1\.2026-08\.[A-Za-z0-9_-]{43}$/);
  });

  it("separates every source-tag purpose and server dimension", async () => {
    const privacy = await context();
    const tags = await Promise.all([
      privacy.tag(SourceTagPurpose.GlobalIngress),
      privacy.tag(SourceTagPurpose.RendezvousClientGlobal),
      privacy.serverTag(SourceTagPurpose.RendezvousClientServer, SERVER_ID),
      privacy.serverTag(SourceTagPurpose.RendezvousClientServer, OTHER_SERVER_ID),
    ]);

    expect(new Set(tags).size).toBe(tags.length);
    expect(tags.every((tag) =>
      /^v1\.2026-08\.[A-Za-z0-9_-]{43}$/.test(tag)
    )).toBe(true);
  });

  it("returns current then previous tags during key rotation", async () => {
    const oldPrivacy = await context(sourceRequest("192.0.2.10"), {
      currentKeyId: "old",
      currentSecret: PREVIOUS_SECRET,
    });
    const rotatedPrivacy = await context(sourceRequest("192.0.2.10"), {
      currentKeyId: "new",
      currentSecret: CURRENT_SECRET,
      previousKeyId: "old",
      previousSecret: PREVIOUS_SECRET,
    });

    const tags = await rotatedPrivacy.tags(SourceTagPurpose.GlobalIngress);
    expect(tags).toEqual([
      "v1.new.RA_EdJMPqDYZch9WFQn0sszNHf1iSoD4brS4yzetq3I",
      "v1.old.x3Wr3NE3XHmnJUni0v7uOm37UqsRhvkkYwdM18EOeOU",
    ]);
    expect(await rotatedPrivacy.tag(SourceTagPurpose.GlobalIngress)).toBe(tags[0]);
    expect(tags[1]).toBe(await oldPrivacy.tag(SourceTagPurpose.GlobalIngress));

    const serverTags = await rotatedPrivacy.serverTags(
      SourceTagPurpose.RendezvousClientServer,
      SERVER_ID,
    );
    expect(serverTags).toHaveLength(2);
    expect(await rotatedPrivacy.serverTag(
      SourceTagPurpose.RendezvousClientServer,
      SERVER_ID,
    )).toBe(serverTags[0]);
    expect(serverTags[1]).toBe(await oldPrivacy.serverTag(
      SourceTagPurpose.RendezvousClientServer,
      SERVER_ID,
    ));
    expect(Object.isFrozen(tags)).toBe(true);
    expect(Object.isFrozen(serverTags)).toBe(true);
  });

  it("fails closed on missing or malformed key material", async () => {
    const invalidConfigurations: SourceTagKeyConfiguration[] = [
      { currentKeyId: undefined, currentSecret: CURRENT_SECRET },
      { currentKeyId: "current", currentSecret: undefined },
      { currentKeyId: "", currentSecret: CURRENT_SECRET },
      { currentKeyId: "a".repeat(33), currentSecret: CURRENT_SECRET },
      { currentKeyId: "contains.dot", currentSecret: CURRENT_SECRET },
      { currentKeyId: "non-ascii-é", currentSecret: CURRENT_SECRET },
      { currentKeyId: "current", currentSecret: "A".repeat(42) },
      { currentKeyId: "current", currentSecret: `${CURRENT_SECRET}=` },
      { currentKeyId: "current", currentSecret: CURRENT_SECRET.replace("A", "+") },
      { currentKeyId: "current", currentSecret: `${CURRENT_SECRET.slice(0, -1)}9` },
      {
        currentKeyId: "current",
        currentSecret: CURRENT_SECRET,
        previousKeyId: "previous",
      },
      {
        currentKeyId: "current",
        currentSecret: CURRENT_SECRET,
        previousSecret: PREVIOUS_SECRET,
      },
      {
        currentKeyId: "current",
        currentSecret: CURRENT_SECRET,
        previousKeyId: "current",
        previousSecret: PREVIOUS_SECRET,
      },
      {
        currentKeyId: "current",
        currentSecret: CURRENT_SECRET,
        previousKeyId: "previous",
        previousSecret: CURRENT_SECRET,
      },
      {
        currentKeyId: "current",
        currentSecret: CURRENT_SECRET,
        previousKeyId: "previous",
        previousSecret: "not-a-secret",
      },
    ];

    for (const configuration of invalidConfigurations) {
      await expect(parseSourceTagKeyRing(configuration)).rejects.toBeInstanceOf(
        SourceTagConfigurationError,
      );
    }
  });

  it("fails closed on a missing or non-canonical public namespace", async () => {
    const keys = await parseSourceTagKeyRing(CURRENT_CONFIGURATION);
    const overlong = ["a".repeat(63), "b".repeat(63), "c".repeat(63),
      "d".repeat(63)].join(".");
    const invalidNamespaces: unknown[] = [
      undefined,
      "",
      "localhost",
      "META.EXAMPLE.TEST",
      "meta.example.test.",
      " meta.example.test",
      "meta.example.test ",
      "https://meta.example.test",
      "meta.example.test:443",
      "meta_example.test",
      "-meta.example.test",
      "meta-.example.test",
      "méta.example.test",
      `meta.${"a".repeat(64)}.test`,
      overlong,
    ];

    for (const namespace of invalidNamespaces) {
      expect(() => createRequestPrivacyContext(
        sourceRequest("192.0.2.10"),
        { keys, namespace: namespace as string },
      )).toThrowError(SourceTagConfigurationError);
    }
  });

  it("requires a valid Cloudflare source address", async () => {
    await expect(context(sourceRequest())).rejects.toMatchObject({
      message: "The source address is unavailable",
      status: 400,
    });
    await expect(context(sourceRequest("not-an-address"))).rejects.toMatchObject({
      message: "The source address is invalid",
      status: 400,
    });
  });

  it("rejects malformed server IDs before deriving pair tags", async () => {
    const privacy = await context();
    await expect(privacy.serverTag(
      SourceTagPurpose.RendezvousClientServer,
      "A".repeat(64),
    )).rejects.toThrow("64 lowercase hex digits");
    await expect(privacy.serverTags(
      SourceTagPurpose.RendezvousClientServer,
      "1".repeat(63),
    )).rejects.toThrow("64 lowercase hex digits");
  });
});

describe("durable rendezvous replay tags", () => {
  it("matches independent versioned HMAC-SHA256 vectors", async () => {
    const ring = await parseSourceTagKeyRing(ROTATING_CONFIGURATION);
    const tags = await ring.rendezvousReplayTags(
      SOURCE_TAG_NAMESPACE,
      RENDEZVOUS_ROOM_ID,
      RENDEZVOUS_CLIENT_TICKET,
    );

    expect(RENDEZVOUS_REPLAY_TAG_VERSION).toBe("v1");
    expect(tags).toEqual([
      "v1.2026-08.0UEaF1QMkll78umnuuRxqLLEipAyQxAmW7WiFoveMaA",
      "v1.2026-07.mrkxFVWmyVIiQjl3VIQzuAq4fZD6YQSvvNPgekpDiok",
    ]);
    expect(tags).toHaveLength(2);
    expect(Object.isFrozen(tags)).toBe(true);
    expect(tags.every((tag) =>
      /^v1\.2026-0[78]\.[A-Za-z0-9_-]{43}$/.test(tag)
    )).toBe(true);
    const serialized = JSON.stringify({ ring, tags });
    expect(serialized).not.toContain(CURRENT_SECRET);
    expect(serialized).not.toContain(PREVIOUS_SECRET);
    expect(serialized).not.toContain(RENDEZVOUS_ROOM_ID);
    expect(serialized).not.toContain(RENDEZVOUS_CLIENT_TICKET);
  });

  it("keeps the overlap tag stable across an in-place A/Z to B/A rotation", async () => {
    const keyA = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const keyZ = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
    const keyB = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI";
    const environment: {
      SOURCE_TAG_KEY_CURRENT_ID: unknown;
      SOURCE_TAG_KEY_CURRENT: unknown;
      SOURCE_TAG_KEY_PREVIOUS_ID: unknown;
      SOURCE_TAG_KEY_PREVIOUS: unknown;
    } = {
      SOURCE_TAG_KEY_CURRENT_ID: "key-a",
      SOURCE_TAG_KEY_CURRENT: keyA,
      SOURCE_TAG_KEY_PREVIOUS_ID: "key-z",
      SOURCE_TAG_KEY_PREVIOUS: keyZ,
    };

    const oldRing = await requiredSourceTagKeyRing(environment);
    expect(await requiredSourceTagKeyRing(environment)).toBe(oldRing);
    const oldTags = await oldRing.rendezvousReplayTags(
      SOURCE_TAG_NAMESPACE,
      RENDEZVOUS_ROOM_ID,
      RENDEZVOUS_CLIENT_TICKET,
    );

    Object.assign(environment, {
      SOURCE_TAG_KEY_CURRENT_ID: "key-b",
      SOURCE_TAG_KEY_CURRENT: keyB,
      SOURCE_TAG_KEY_PREVIOUS_ID: "key-a",
      SOURCE_TAG_KEY_PREVIOUS: keyA,
    });
    const newRing = await requiredSourceTagKeyRing(environment);
    const newTags = await newRing.rendezvousReplayTags(
      SOURCE_TAG_NAMESPACE,
      RENDEZVOUS_ROOM_ID,
      RENDEZVOUS_CLIENT_TICKET,
    );

    expect(newRing).not.toBe(oldRing);
    expect(oldTags.map((tag) => tag.split(".")[1])).toEqual([
      "key-a",
      "key-z",
    ]);
    expect(newTags.map((tag) => tag.split(".")[1])).toEqual([
      "key-b",
      "key-a",
    ]);
    expect(newTags[1]).toBe(oldTags[0]);
  });

  it("separates canonical deployment hostname namespaces", async () => {
    const ring = await parseSourceTagKeyRing(ROTATING_CONFIGURATION);
    const production = await ring.rendezvousReplayTags(
      SOURCE_TAG_NAMESPACE,
      RENDEZVOUS_ROOM_ID,
      RENDEZVOUS_CLIENT_TICKET,
    );
    const canary = await ring.rendezvousReplayTags(
      "canary.meta.example.test",
      RENDEZVOUS_ROOM_ID,
      RENDEZVOUS_CLIENT_TICKET,
    );

    expect(canary).not.toEqual(production);
    expect(new Set([...production, ...canary]).size).toBe(4);
  });

  it("separates Durable Object room identities", async () => {
    const ring = await parseSourceTagKeyRing(ROTATING_CONFIGURATION);
    const first = await ring.rendezvousReplayTags(
      SOURCE_TAG_NAMESPACE,
      RENDEZVOUS_ROOM_ID,
      RENDEZVOUS_CLIENT_TICKET,
    );
    const second = await ring.rendezvousReplayTags(
      SOURCE_TAG_NAMESPACE,
      "c".repeat(64),
      RENDEZVOUS_CLIENT_TICKET,
    );

    expect(second).not.toEqual(first);
    expect(new Set([...first, ...second]).size).toBe(4);
  });

  it("separates client tickets within one room", async () => {
    const ring = await parseSourceTagKeyRing(ROTATING_CONFIGURATION);
    const first = await ring.rendezvousReplayTags(
      SOURCE_TAG_NAMESPACE,
      RENDEZVOUS_ROOM_ID,
      RENDEZVOUS_CLIENT_TICKET,
    );
    const second = await ring.rendezvousReplayTags(
      SOURCE_TAG_NAMESPACE,
      RENDEZVOUS_ROOM_ID,
      "d".repeat(64),
    );

    expect(second).not.toEqual(first);
    expect(new Set([...first, ...second]).size).toBe(4);
  });

  it("fails closed on incomplete key rings and malformed dimensions", async () => {
    const invalidEnvironments: SourceTagKeyEnvironment[] = [
      {
        SOURCE_TAG_KEY_CURRENT_ID: "current",
        SOURCE_TAG_KEY_CURRENT: CURRENT_SECRET,
      },
      {
        SOURCE_TAG_KEY_CURRENT_ID: "current",
        SOURCE_TAG_KEY_CURRENT: CURRENT_SECRET,
        SOURCE_TAG_KEY_PREVIOUS: PREVIOUS_SECRET,
      },
      {
        SOURCE_TAG_KEY_CURRENT_ID: "current",
        SOURCE_TAG_KEY_CURRENT: CURRENT_SECRET,
        SOURCE_TAG_KEY_PREVIOUS_ID: "previous",
      },
      {
        SOURCE_TAG_KEY_CURRENT: CURRENT_SECRET,
        SOURCE_TAG_KEY_PREVIOUS_ID: "previous",
        SOURCE_TAG_KEY_PREVIOUS: PREVIOUS_SECRET,
      },
    ];
    for (const environment of invalidEnvironments) {
      await expect(requiredSourceTagKeyRing(environment)).rejects
        .toBeInstanceOf(SourceTagConfigurationError);
    }

    const oneKeyRing = await parseSourceTagKeyRing(CURRENT_CONFIGURATION);
    await expect(oneKeyRing.rendezvousReplayTags(
      SOURCE_TAG_NAMESPACE,
      RENDEZVOUS_ROOM_ID,
      RENDEZVOUS_CLIENT_TICKET,
    )).rejects.toThrow(
      "Rendezvous replay tags require exactly two source-tag keys",
    );

    const ring = await parseSourceTagKeyRing(ROTATING_CONFIGURATION);
    for (const namespace of [
      "META.EXAMPLE.TEST",
      "meta.example.test.",
      "meta.example.test:443",
    ]) {
      await expect(ring.rendezvousReplayTags(
        namespace,
        RENDEZVOUS_ROOM_ID,
        RENDEZVOUS_CLIENT_TICKET,
      )).rejects.toThrow(SourceTagConfigurationError);
    }

    for (const roomId of [
      "",
      "a".repeat(63),
      "a".repeat(65),
      "A".repeat(64),
      "g".repeat(64),
      undefined,
      null,
    ]) {
      await expect(ring.rendezvousReplayTags(
        SOURCE_TAG_NAMESPACE,
        roomId as string,
        RENDEZVOUS_CLIENT_TICKET,
      )).rejects.toThrow(
        "Rendezvous room ID must contain exactly 64 lowercase hex digits",
      );
    }

    for (const clientTicket of [
      "",
      "b".repeat(63),
      "b".repeat(65),
      "B".repeat(64),
      "g".repeat(64),
      undefined,
      null,
    ]) {
      await expect(ring.rendezvousReplayTags(
        SOURCE_TAG_NAMESPACE,
        RENDEZVOUS_ROOM_ID,
        clientTicket as string,
      )).rejects.toThrow(
        "Rendezvous client ticket must contain exactly 64 lowercase hex digits",
      );
    }
  });
});
