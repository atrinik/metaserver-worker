import { describe, expect, it } from "vitest";

import {
  ATTACHMENT_VERSION,
  decodeRendezvousAttachment,
  encodeRendezvousAttachment,
  MAX_RETAINED_TICKETS,
  MAX_SESSION_MS,
} from "../src/rendezvous-attachments";
import type {
  ClientAttachment,
  ServerAttachment,
  StoredTicketState,
  TicketState,
} from "../src/rendezvous-attachments";
import {
  RENDEZVOUS_TERMINAL_OUTCOMES,
  TERMINAL_CLOSE_RETRY_HORIZON_MS,
} from "../src/rendezvous-contract";

const OPENED_AT = 1_750_000_000_000;
const CONTROL_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLIENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RAW_TICKET = "a".repeat(64);
const TICKET_DIGEST = "b".repeat(64);

function connectionId(index: number): string {
  return `aaaaaaaa-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function digest(index: number): string {
  return `c${index.toString(16).padStart(63, "0")}`;
}

function awaitingClient(): ClientAttachment {
  return {
    v: ATTACHMENT_VERSION,
    role: "client",
    controlId: CONTROL_ID,
    connectionId: CLIENT_ID,
    admissionId: 7,
    openedAt: OPENED_AT,
    expiresAt: OPENED_AT + MAX_SESSION_MS,
    ticket: null,
    ticketDigest: null,
    stage: "awaiting_candidate",
    clientCandidates: 0,
    serverCandidates: 0,
    completionCount: 0,
    signalBytes: 0,
    framesForwarded: 0,
    summaryEmitted: false,
    terminalOutcome: null,
    terminalCloseAttempts: 0,
  };
}

function exchangingClient(): ClientAttachment {
  return {
    ...awaitingClient(),
    ticket: RAW_TICKET,
    ticketDigest: TICKET_DIGEST,
    stage: "candidate_exchange",
    clientCandidates: 1,
    serverCandidates: 2,
    signalBytes: 384,
    framesForwarded: 3,
  };
}

function terminalClient(): ClientAttachment {
  return {
    ...exchangingClient(),
    ticket: null,
    ticketDigest: null,
    stage: "terminal",
    completionCount: 1,
    signalBytes: 512,
    framesForwarded: 4,
    summaryEmitted: true,
    terminalOutcome: "completed",
  };
}

function ticketState(index: number): TicketState {
  return {
    ticketDigest: digest(index + 1),
    clientConnectionId: connectionId(index + 1),
    openedAt: OPENED_AT,
    expiresAt: OPENED_AT + MAX_SESSION_MS,
    stage: "candidate_exchange",
    serverCandidates: 0,
    completionCount: 0,
    signalBytes: 1,
  };
}

function serverAttachment(tickets: TicketState[] = []): ServerAttachment {
  return {
    v: ATTACHMENT_VERSION,
    role: "server",
    current: true,
    controlId: CONTROL_ID,
    openedAt: OPENED_AT,
    tickets,
  };
}

function replaceTupleValue(
  tuple: readonly unknown[],
  index: number,
  value: unknown,
): unknown[] {
  const replaced = [...tuple];
  replaced[index] = value;
  return replaced;
}

describe("rendezvous hibernation attachments", () => {
  it("round-trips every valid attachment role through the pure boundary", () => {
    const serverTicket: TicketState = {
      ...ticketState(0),
      stage: "terminal",
      serverCandidates: 2,
      completionCount: 1,
      signalBytes: 512,
    };
    const attachments = [
      awaitingClient(),
      exchangingClient(),
      ...RENDEZVOUS_TERMINAL_OUTCOMES.map((terminalOutcome) => ({
        ...terminalClient(),
        terminalOutcome,
      })),
      serverAttachment([serverTicket]),
    ];

    for (const attachment of attachments) {
      expect(
        decodeRendezvousAttachment(
          encodeRendezvousAttachment(attachment),
        ),
      ).toEqual(attachment);
    }
  });

  it("keeps the maximum 50-ticket server attachment below 16 KiB", () => {
    const attachment = serverAttachment(
      Array.from({ length: MAX_RETAINED_TICKETS }, (_, index) =>
        ticketState(index)),
    );
    const stored = encodeRendezvousAttachment(attachment);

    expect(MAX_RETAINED_TICKETS).toBe(50);
    expect(decodeRendezvousAttachment(stored)).toEqual(attachment);
    expect(
      new TextEncoder().encode(JSON.stringify(stored)).byteLength,
    ).toBeLessThanOrEqual(16_384);

    const overflow = encodeRendezvousAttachment(serverAttachment([
      ...attachment.tickets,
      ticketState(MAX_RETAINED_TICKETS),
    ]));
    expect(decodeRendezvousAttachment(overflow)).toBeNull();
  });

  it("rejects extra, legacy, and version-skewed shapes", () => {
    const client = encodeRendezvousAttachment(awaitingClient());
    const server = encodeRendezvousAttachment(serverAttachment());
    const invalid: readonly unknown[] = [
      null,
      [],
      "client",
      {},
      { ...client, extra: true },
      { ...server, extra: true },
      { role: "client", stage: "awaiting_candidate" },
      { role: "server", current: true },
      { ...client, v: 0 },
      { ...client, v: 2 },
      { ...server, v: 0 },
      { ...server, v: 2 },
      { ...server, r: "server" },
    ];

    for (const value of invalid) {
      expect(decodeRendezvousAttachment(value)).toBeNull();
    }
  });

  it("rejects impossible client counters and stages", () => {
    const awaiting = encodeRendezvousAttachment(awaitingClient());
    const exchange = encodeRendezvousAttachment(exchangingClient());
    const terminal = encodeRendezvousAttachment(terminalClient());
    const invalid: readonly unknown[] = [
      { ...awaiting, t: RAW_TICKET, d: TICKET_DIGEST },
      { ...awaiting, n: 1, b: 1 },
      { ...exchange, s: 0 },
      { ...exchange, n: 0 },
      { ...exchange, z: 1 },
      { ...exchange, b: 0 },
      { ...exchange, f: 5 },
      { ...exchange, k: 1 },
      { ...awaiting, y: 0 },
      { ...terminal, s: 1 },
      { ...terminal, t: RAW_TICKET, d: TICKET_DIGEST },
      { ...terminal, y: null },
      { ...terminal, y: -1 },
      { ...terminal, y: 7 },
      { ...terminal, k: -1 },
      { ...terminal, k: 5 },
      { ...terminal, q: 13 },
      { ...terminal, z: 2 },
      { ...terminal, s: 3 },
    ];

    for (const value of invalid) {
      expect(decodeRendezvousAttachment(value)).toBeNull();
    }
  });

  it("rejects impossible server-ticket counters and stages", () => {
    const stored = encodeRendezvousAttachment(
      serverAttachment([ticketState(0)]),
    );
    const tuple = stored.t[0];
    const invalidTuples = [
      replaceTupleValue(tuple, 4, 2),
      replaceTupleValue(tuple, 5, 13),
      replaceTupleValue(tuple, 6, 2),
      replaceTupleValue(tuple, 7, 0),
      replaceTupleValue(
        replaceTupleValue(tuple, 4, 0),
        6,
        1,
      ),
    ];

    for (const invalidTuple of invalidTuples) {
      expect(decodeRendezvousAttachment({
        ...stored,
        t: [invalidTuple],
      })).toBeNull();
    }
  });

  it("rejects malformed ticket tuple sizes and layouts", () => {
    const stored = encodeRendezvousAttachment(
      serverAttachment([ticketState(0)]),
    );
    const tuple = stored.t[0];
    const withExtraProperty = [...tuple];
    Object.assign(withExtraProperty, { extra: true });
    const sparse = [...tuple];
    delete sparse[3];
    const malformed = [
      tuple.slice(0, 7),
      [...tuple, 0],
      withExtraProperty,
      sparse,
    ];

    for (const malformedTuple of malformed) {
      expect(decodeRendezvousAttachment({
        ...stored,
        t: [malformedTuple],
      })).toBeNull();
    }
  });

  it("rejects duplicate ticket digests and client connection IDs", () => {
    const first = encodeRendezvousAttachment(
      serverAttachment([ticketState(0)]),
    ).t[0];
    const second = encodeRendezvousAttachment(
      serverAttachment([ticketState(1)]),
    ).t[0];
    const stored = encodeRendezvousAttachment(serverAttachment());
    const duplicateDigest: StoredTicketState = [
      first[0], second[1], second[2], second[3], second[4], second[5],
      second[6], second[7],
    ];
    const duplicateConnection: StoredTicketState = [
      second[0], first[1], second[2], second[3], second[4], second[5],
      second[6], second[7],
    ];

    expect(decodeRendezvousAttachment({
      ...stored,
      t: [first, duplicateDigest],
    })).toBeNull();
    expect(decodeRendezvousAttachment({
      ...stored,
      t: [first, duplicateConnection],
    })).toBeNull();
  });

  it("rejects noncanonical identifiers and timestamps", () => {
    const client = encodeRendezvousAttachment(exchangingClient());
    const server = encodeRendezvousAttachment(
      serverAttachment([ticketState(0)]),
    );
    const tuple = server.t[0];
    const invalid: ReadonlyArray<readonly [string, unknown]> = [
      ["uppercase control ID", { ...client, c: CONTROL_ID.toUpperCase() }],
      ["uppercase connection ID", { ...client, i: CLIENT_ID.toUpperCase() }],
      ["non-v4 connection ID", {
        ...client,
        i: "bbbbbbbb-bbbb-3bbb-8bbb-bbbbbbbbbbbb",
      }],
      ["noncanonical UUID variant", {
        ...server,
        c: "aaaaaaaa-aaaa-4aaa-7aaa-aaaaaaaaaaaa",
      }],
      ["zero admission ID", { ...client, a: 0 }],
      ["fractional admission ID", { ...client, a: 1.5 }],
      ["uppercase ticket", { ...client, t: RAW_TICKET.toUpperCase() }],
      ["uppercase digest", { ...client, d: TICKET_DIGEST.toUpperCase() }],
      ["string timestamp", { ...client, o: String(OPENED_AT) }],
      ["fractional timestamp", { ...client, o: OPENED_AT + 0.5 }],
      ["negative timestamp", { ...client, o: -1 }],
      ["unsafe timestamp", { ...client, o: Number.MAX_SAFE_INTEGER + 1 }],
      ["non-increasing timestamps", { ...client, x: OPENED_AT }],
      ["overlong session", {
        ...client,
        x: OPENED_AT + MAX_SESSION_MS + 1,
      }],
      ["terminal retry horizon exceeds safe timestamp", {
        ...encodeRendezvousAttachment(terminalClient()),
        o: Number.MAX_SAFE_INTEGER -
          TERMINAL_CLOSE_RETRY_HORIZON_MS - MAX_SESSION_MS + 1,
        x: Number.MAX_SAFE_INTEGER - TERMINAL_CLOSE_RETRY_HORIZON_MS + 1,
      }],
      ["server string timestamp", { ...server, o: String(OPENED_AT) }],
      ["server fractional timestamp", { ...server, o: OPENED_AT + 0.5 }],
      ["ticket uppercase digest", {
        ...server,
        t: [replaceTupleValue(tuple, 0, tuple[0].toUpperCase())],
      }],
      ["ticket uppercase connection ID", {
        ...server,
        t: [replaceTupleValue(tuple, 1, tuple[1].toUpperCase())],
      }],
      ["ticket fractional timestamp", {
        ...server,
        t: [replaceTupleValue(tuple, 2, OPENED_AT + 0.5)],
      }],
      ["ticket non-increasing timestamps", {
        ...server,
        t: [replaceTupleValue(tuple, 3, OPENED_AT)],
      }],
      ["ticket overlong session", {
        ...server,
        t: [replaceTupleValue(tuple, 3, OPENED_AT + MAX_SESSION_MS + 1)],
      }],
    ];

    for (const [name, value] of invalid) {
      expect(decodeRendezvousAttachment(value), name).toBeNull();
    }
  });
});
