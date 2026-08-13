import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  RendezvousAdmissionStore,
  RendezvousAdmissionStoreError,
} from "../src/rendezvous-admission";
import { RENDEZVOUS_ROLLING_WINDOW_MS } from "../src/rendezvous-contract";
import { RendezvousRoom } from "../src/rendezvous";

let admissionRoomSequence = 0;

function admissionRoom(name: string): DurableObjectStub<RendezvousRoom> {
  admissionRoomSequence += 1;
  return env.RENDEZVOUS.getByName(
    `admission-store-${name}-${admissionRoomSequence}`,
  );
}

describe("RendezvousAdmissionStore", () => {
  it("retains replay rows without turning the security horizon into a quota", async () => {
    const stub = admissionRoom("storage-only");
    await runInDurableObject(stub, (_instance, state) => {
      const store = new RendezvousAdmissionStore(state.storage);
      store.initialize();
      const now = 2_000_000_000_000;
      const oldest = now - 50_000;
      for (let index = 0; index < 100; index += 1) {
        expect(store.consume(oldest + index)).toMatchObject({
          accepted: true,
        });
      }
      expect(store.consume(now)).toMatchObject({ accepted: true });
    });
  });

  it("reports emergency replay storage exhaustion as capacity, not rate limiting", async () => {
    const stub = admissionRoom("emergency-capacity");
    await runInDurableObject(stub, (_instance, state) => {
      const store = new RendezvousAdmissionStore(state.storage, 2);
      store.initialize();
      expect(store.consume(2_000_000_000_000)).toMatchObject({ accepted: true });
      expect(store.consume(2_000_000_000_001)).toMatchObject({ accepted: true });
      expect(store.consume(2_000_000_000_002)).toEqual({
        accepted: false,
        reason: "storage_capacity",
      });
    });
  });

  it("initializes at the emergency ceiling without materializing the ledger", async () => {
    const stub = admissionRoom("bounded-cold-start");
    await runInDurableObject(stub, (_instance, state) => {
      const store = new RendezvousAdmissionStore(state.storage);
      store.initialize();
      const now = 2_000_000_000_000;
      state.storage.sql.exec(
        `WITH digits(n) AS (
           VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)
         )
         INSERT INTO rendezvous_admissions (accepted_at_ms)
         SELECT ?1 - 100000 +
                a.n + 10 * b.n + 100 * c.n + 1000 * d.n + 10000 * e.n
           FROM digits AS a
           CROSS JOIN digits AS b
           CROSS JOIN digits AS c
           CROSS JOIN digits AS d
           CROSS JOIN digits AS e`,
        now,
      );

      const restarted = new RendezvousAdmissionStore(state.storage);
      expect(() => restarted.initialize()).not.toThrow();
      expect(restarted.consume(now)).toEqual({
        accepted: false,
        reason: "storage_capacity",
      });
    });
  });

  it("prunes an expired replay backlog in fixed batches before admission", async () => {
    const stub = admissionRoom("bounded-prune-backlog");
    await runInDurableObject(stub, (_instance, state) => {
      const store = new RendezvousAdmissionStore(state.storage);
      store.initialize();
      const now = 2_000_000_000_000;
      const cutoff = now - RENDEZVOUS_ROLLING_WINDOW_MS;
      state.storage.sql.exec(
        `WITH RECURSIVE expired(n) AS (
           VALUES (1)
           UNION ALL
           SELECT n + 1 FROM expired WHERE n < 600
         )
         INSERT INTO rendezvous_admissions (accepted_at_ms)
         SELECT ?1 - n FROM expired`,
        cutoff,
      );

      expect(store.consume(now)).toEqual({
        accepted: false,
        reason: "maintenance_backlog",
      });
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM rendezvous_admissions",
      ).one().count).toBe(344);
      expect(store.consume(now)).toEqual({
        accepted: false,
        reason: "maintenance_backlog",
      });
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM rendezvous_admissions",
      ).one().count).toBe(88);
      expect(store.consume(now)).toMatchObject({ accepted: true });
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM rendezvous_admissions",
      ).one().count).toBe(1);
    });
  });

  it("detects replay across current and previous key aliases atomically", async () => {
    const stub = admissionRoom("replay-aliases");
    await runInDurableObject(stub, (_instance, state) => {
      const store = new RendezvousAdmissionStore(state.storage);
      store.initialize();
      const first = store.consume(2_000_000_000_000);
      const second = store.consume(2_000_000_000_001);
      if (!first.accepted || !second.accepted) {
        throw new Error("Replay test admissions were unexpectedly rejected");
      }

      const current = `v1.current.${"A".repeat(43)}`;
      const previous = `v1.previous.${"E".repeat(43)}`;
      expect(store.claimReplayTags(first.admissionId, [
        current,
        previous,
      ])).toEqual({ claimed: true });
      expect(store.claimReplayTags(second.admissionId, [
        previous,
        `v1.older.${"I".repeat(43)}`,
      ])).toEqual({ claimed: false, reason: "replay" });

      expect(store.release(first.admissionId)).toBe(false);
      expect(store.release(second.admissionId)).toBe(true);
    });
  });

  it("prunes at the exact rolling cutoff and updates the earliest alarm", async () => {
    const stub = admissionRoom("exact-prune");
    await runInDurableObject(stub, (_instance, state) => {
      const store = new RendezvousAdmissionStore(state.storage);
      store.initialize();
      const acceptedAt = 2_000_000_000_000;
      expect(store.consume(acceptedAt)).toMatchObject({ accepted: true });
      expect(store.earliestRetainedExpiryMs()).toBe(
        acceptedAt + RENDEZVOUS_ROLLING_WINDOW_MS,
      );
      expect(store.prune(
        acceptedAt + RENDEZVOUS_ROLLING_WINDOW_MS - 1,
      )).toBe(0);
      expect(store.prune(
        acceptedAt + RENDEZVOUS_ROLLING_WINDOW_MS,
      )).toBe(1);
      expect(store.earliestRetainedExpiryMs()).toBeNull();
    });
  });

  it("fails closed on a future persisted schema version", async () => {
    const stub = admissionRoom("future-schema");
    await runInDurableObject(stub, (_instance, state) => {
      const store = new RendezvousAdmissionStore(state.storage);
      store.initialize();
      state.storage.sql.exec(
        "INSERT INTO _rendezvous_schema_migrations (version) VALUES (2)",
      );

      expect(() => store.initialize()).toThrowError(
        new RendezvousAdmissionStoreError("unsupported_schema"),
      );
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM rendezvous_admissions",
      ).one().count).toBe(0);
    });
  });

  it("rejects malformed or same-key replay tag pairs before mutation", async () => {
    const stub = admissionRoom("invalid-replay-tags");
    await runInDurableObject(stub, (_instance, state) => {
      const store = new RendezvousAdmissionStore(state.storage);
      store.initialize();
      const admission = store.consume(2_000_000_000_000);
      if (!admission.accepted) {
        throw new Error("Replay validation admission was rejected");
      }

      expect(() => store.claimReplayTags(admission.admissionId, [
        `v1.same.${"A".repeat(43)}`,
        `v1.same.${"E".repeat(43)}`,
      ])).toThrow("Invalid rendezvous replay tags");
      expect(() => store.claimReplayTags(admission.admissionId, [
        "raw-ticket",
        `v1.previous.${"E".repeat(43)}`,
      ])).toThrow("Invalid rendezvous replay tags");
      expect(store.release(admission.admissionId)).toBe(true);
    });
  });

  it("keeps SQLite replay-tag checks equivalent to the JS boundary", async () => {
    const stub = admissionRoom("sqlite-replay-tag-grammar");
    await runInDurableObject(stub, (_instance, state) => {
      const store = new RendezvousAdmissionStore(state.storage);
      store.initialize();
      const current = `v1.a.${"A".repeat(43)}`;
      const previous = `v1.${"b".repeat(32)}.${"E".repeat(43)}`;
      expect(() => state.storage.sql.exec(
        `INSERT INTO rendezvous_admissions
           (accepted_at_ms, ticket_replay_tag_current,
            ticket_replay_tag_previous)
         VALUES (?, ?, ?)`,
        2_000_000_000_000,
        current,
        previous,
      )).not.toThrow();

      const malformedPairs: ReadonlyArray<readonly [string, string]> = [
        [`v2.c.${"I".repeat(43)}`, `v1.d.${"M".repeat(43)}`],
        [`v1.bad!.${"Q".repeat(43)}`, `v1.e.${"U".repeat(43)}`],
        [`v1.f.${"Y".repeat(42)}`, `v1.g.${"c".repeat(43)}`],
        [`v1.h.${"g".repeat(42)}!`, `v1.i.${"k".repeat(43)}`],
        [`v1.j.${"o".repeat(42)}B`, `v1.k.${"s".repeat(43)}`],
        [`v1.same.${"w".repeat(43)}`, `v1.same.${"0".repeat(43)}`],
        [`v1.equal.${"4".repeat(43)}`, `v1.equal.${"4".repeat(43)}`],
      ];
      for (const [index, [invalidCurrent, invalidPrevious]] of
        malformedPairs.entries()) {
        expect(() => state.storage.sql.exec(
          `INSERT INTO rendezvous_admissions
             (accepted_at_ms, ticket_replay_tag_current,
              ticket_replay_tag_previous)
           VALUES (?, ?, ?)`,
          2_000_000_000_001 + index,
          invalidCurrent,
          invalidPrevious,
        )).toThrow();
      }
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM rendezvous_admissions",
      ).one().count).toBe(1);
      expect(() => store.initialize()).not.toThrow();
    });
  });
});
