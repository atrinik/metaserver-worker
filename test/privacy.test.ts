import { describe, expect, it } from "vitest";

import {
  parseSourceTagKeyRing,
  RENDEZVOUS_REPLAY_TAG_VERSION,
  requiredSourceTagKeyRing,
  SourceTagConfigurationError,
  SourceTagKeyEnvironment,
  SourceTagKeyConfiguration,
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


describe("access grant purpose tags",()=>{
  it("binds every target dimension and survives one key rotation without retaining the raw grant",async()=>{
    const previous=await parseSourceTagKeyRing(ROTATING_CONFIGURATION);
    const successor=await parseSourceTagKeyRing({currentKeyId:"2026-09",currentSecret:"AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
      previousKeyId:ROTATING_CONFIGURATION.currentKeyId,previousSecret:ROTATING_CONFIGURATION.currentSecret});
    const grant="a".repeat(64),nonce="b".repeat(64);
    const tags=await previous.accessGrantTags(SOURCE_TAG_NAMESPACE,"classic",SERVER_ID,grant,nonce);
    expect((await successor.accessGrantTags(SOURCE_TAG_NAMESPACE,"classic",SERVER_ID,grant,nonce))[1]).toBe(tags[0]);
    const separated=await Promise.all([
      previous.accessGrantTags("other.example.test","classic",SERVER_ID,grant,nonce),
      previous.accessGrantTags(SOURCE_TAG_NAMESPACE,"game",SERVER_ID,grant,nonce),
      previous.accessGrantTags(SOURCE_TAG_NAMESPACE,"classic",OTHER_SERVER_ID,grant,nonce),
      previous.accessGrantTags(SOURCE_TAG_NAMESPACE,"classic",SERVER_ID,"c".repeat(64),nonce),
      previous.accessGrantTags(SOURCE_TAG_NAMESPACE,"classic",SERVER_ID,grant,"c".repeat(64)),
    ]);
    for(const other of separated) expect(other[0]).not.toBe(tags[0]);
    expect(JSON.stringify(tags)).not.toContain(grant);
    expect(tags[0]).not.toBe((await previous.rendezvousReplayTags(SOURCE_TAG_NAMESPACE,SERVER_ID,grant))[0]);
  });
});
