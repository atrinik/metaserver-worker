import { env } from "cloudflare:workers";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { sha256Hex } from "../src/protocol";
import { RendezvousRoom } from "../src/rendezvous";
import { decodeRendezvousAttachment } from "../src/rendezvous-attachments";
import { RENDEZVOUS_TERMINAL_OUTCOMES } from "../src/rendezvous-metrics";
import type {
  RendezvousTerminalOutcome,
  RendezvousTerminalSummary,
} from "../src/rendezvous-metrics";
import {
  INTERNAL_DIRECTORY_CHANGED_HEADER,
  INTERNAL_RENDEZVOUS_AUTHORIZATION_HEADER,
  INTERNAL_RENDEZVOUS_GENERATION_HEADER,
  INTERNAL_RENDEZVOUS_PUBLISH_URL,
  INTERNAL_RENDEZVOUS_PROTOCOL_HEADER,
  INTERNAL_RENDEZVOUS_ROLE_HEADER,
  INTERNAL_RENDEZVOUS_URL,
  LEGACY_INTERNAL_RENDEZVOUS_ROLE_HEADER,
  RENDEZVOUS_ROLLING_WINDOW_MS,
} from "../src/rendezvous-contract";
import { CLASSIC_RENDEZVOUS_INVITE_SUBPROTOCOL } from "../src/routes";

const EVENT_TIMEOUT_MS = 2_000;
const PROTOCOL_CLOSE = {
  code: 4_000,
  reason: "Invalid rendezvous message",
} as const;
const EXPIRED_CLOSE = {
  code: 4_001,
  reason: "Rendezvous session expired",
} as const;
const SERVER_UNAVAILABLE_CLOSE = {
  code: 4_002,
  reason: "Rendezvous server unavailable",
} as const;
const INTERNAL_CLOSE = {
  code: 4_003,
  reason: "Rendezvous internal error",
} as const;
const REPLACED_CLOSE = {
  code: 4_004,
  reason: "Rendezvous server replaced",
} as const;
const COMPLETE_CLOSE = {
  code: 1_000,
  reason: "Rendezvous complete",
} as const;

let roomSequence = 0;

function room(name: string): DurableObjectStub<RendezvousRoom> {
  roomSequence += 1;
  const id = env.RENDEZVOUS.idFromName(`${name}-${roomSequence}`);
  return env.RENDEZVOUS.get(id);
}

function roomRequest(
  role?: string,
  init: RequestInit = {},
  url = INTERNAL_RENDEZVOUS_URL,
): Request {
  const headers = new Headers(init.headers);
  if (!headers.has("Upgrade")) {
    headers.set("Upgrade", "websocket");
  }
  if (role !== undefined) {
    headers.set(INTERNAL_RENDEZVOUS_ROLE_HEADER, role);
  }
  if (!headers.has(INTERNAL_RENDEZVOUS_PROTOCOL_HEADER)) {
    headers.set(INTERNAL_RENDEZVOUS_PROTOCOL_HEADER, "none");
  }
  if (!headers.has(INTERNAL_RENDEZVOUS_AUTHORIZATION_HEADER)) {
    headers.set(INTERNAL_RENDEZVOUS_AUTHORIZATION_HEADER, "not-required");
  }
  if (!headers.has(INTERNAL_RENDEZVOUS_GENERATION_HEADER)) {
    headers.set(INTERNAL_RENDEZVOUS_GENERATION_HEADER, "0".repeat(64));
  }
  return new Request(url, { ...init, headers });
}

async function connect(
  stub: DurableObjectStub,
  role: "client" | "server",
  options: {
    readonly inviteProtocol?: boolean;
    readonly authorizationRequired?: boolean;
    readonly generation?: string;
  } = {},
): Promise<WebSocket> {
  const inviteProtocol = options.inviteProtocol ?? false;
  const headers = {
    [INTERNAL_RENDEZVOUS_PROTOCOL_HEADER]: inviteProtocol
      ? "classic-invite-v1"
      : "none",
    [INTERNAL_RENDEZVOUS_AUTHORIZATION_HEADER]:
      options.authorizationRequired ? "required" : "not-required",
    [INTERNAL_RENDEZVOUS_GENERATION_HEADER]:
      options.generation ?? "0".repeat(64),
  };
  const response = await stub.fetch(roomRequest(role, { headers }));
  expect(response.status).toBe(101);
  expect(response.headers.get("Sec-WebSocket-Protocol")).toBe(
    inviteProtocol ? CLASSIC_RENDEZVOUS_INVITE_SUBPROTOCOL : null,
  );
  const socket = response.webSocket;
  if (socket === null) {
    throw new Error(`Accepted ${role} upgrade returned no WebSocket`);
  }
  socket.accept();
  return socket;
}

async function rotateGeneration(
  stub: DurableObjectStub,
  serverId: string,
  expectedGeneration: string,
  generation: string,
): Promise<Response> {
  return stub.fetch(generationPublicationRequest(
    serverId,
    expectedGeneration,
    generation,
  ));
}

function generationPublicationRequest(
  serverId: string,
  expectedGeneration: string,
  generation: string,
  directoryProfile: "classic-v1" | "classic-v2" | "game-v1" = "classic-v1",
): Request {
  const publisherSequence = BigInt(`0x${generation.slice(0, 16)}`).toString();
  const profileFields = directoryProfile !== "game-v1"
    ? {
        playersCount: 0,
        version: "4.0.0",
        textComment: "Generation rotation",
      }
    : {
        description: "Generation rotation",
        region: null,
        protocolMajor: 1,
        protocolMinor: 0,
        contentId: "atrinik-main",
        contentRevisionSha256: "b".repeat(64),
        playersOnline: 0,
        playersCapacity: 64,
        status: "online",
      };
  return new Request(INTERNAL_RENDEZVOUS_PUBLISH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      serverId,
      directoryProfile,
      publisherSequence,
      publisherNonce: generation.slice(0, 32),
      publisherNonceExpiresAt: 2_000_086_400,
      commitToken: "d".repeat(64),
      expectedGeneration,
      generation,
      tokenHash: "f".repeat(64),
      now: 2_000_000_000,
      visibilityCutoff: 1_999_985_600,
      name: "Generation test",
      ...profileFields,
      isPublic: true,
      quicHost: "",
      quicPort: 1,
      quicCertSha256: serverId,
      authorizationRequired: true,
      directoryFingerprint: "c".repeat(64),
    }),
  });
}

async function seedPublishedGeneration(
  serverId: string,
  generation: string,
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO publisher_replay
         (server_id, profile, last_sequence, last_nonce, commit_token, updated_at)
       VALUES (?, 'classic-v1', '1', ?, ?, 0)`,
    ).bind(serverId, "1".repeat(32), "1".repeat(64)),
    env.DB.prepare(
      `INSERT INTO server_presence
         (profile, server_id, last_seen, rendezvous_token_hash,
          rendezvous_generation)
       VALUES ('classic-v1', ?, 2000000000, ?, ?)`,
    ).bind(serverId, "e".repeat(64), generation),
    env.DB.prepare(
      `INSERT INTO directory_entries
         (profile, server_id, name, players_count, version, text_comment,
          hostname, port, quic_cert_sha256, password_required,
          directory_fingerprint)
       VALUES ('classic-v1', ?, 'Generation test', 0, '4.0.0',
               'Generation rotation', NULL, NULL, ?, 1, ?)`,
    ).bind(serverId, serverId, "b".repeat(64)),
  ]);
}

function ticket(index: number): string {
  return index.toString(16).padStart(64, "0");
}

function terminalOutcomeCode(outcome: RendezvousTerminalOutcome): number {
  const code = RENDEZVOUS_TERMINAL_OUTCOMES.indexOf(outcome);
  if (code < 0) {
    throw new Error("Unknown rendezvous terminal outcome");
  }
  return code;
}

function clientCandidate(
  selectedTicket: string,
  host = "192.0.2.10",
  port = 49_152,
): string {
  return JSON.stringify({
    type: "client_candidate",
    host,
    port,
    ticket: selectedTicket,
  });
}

function serverCandidate(
  selectedTicket: string,
  candidateIndex = 0,
): string {
  return JSON.stringify({
    type: "server_candidate",
    host: `192.0.2.${candidateIndex + 20}`,
    port: 1_730 + candidateIndex,
    kind: "srflx",
    ticket: selectedTicket,
  });
}

function complete(selectedTicket: string): string {
  return JSON.stringify({ type: "complete", ticket: selectedTicket });
}

function authInit(selectedTicket: string, inviteId = "a".repeat(32)): string {
  return JSON.stringify({
    type: "auth_init",
    version: 1,
    ticket: selectedTicket,
    invite_id: inviteId,
  });
}

function authChallenge(
  selectedTicket: string,
  challenge = "b".repeat(64),
): string {
  return JSON.stringify({
    type: "auth_challenge",
    version: 1,
    ticket: selectedTicket,
    challenge,
  });
}

function authProof(selectedTicket: string, proof = "c".repeat(64)): string {
  return JSON.stringify({
    type: "auth_proof",
    version: 1,
    ticket: selectedTicket,
    proof,
  });
}

function authResult(selectedTicket: string, authorized: boolean): string {
  return JSON.stringify({
    type: "auth_result",
    version: 1,
    ticket: selectedTicket,
    authorized,
  });
}

function nextMessage(
  socket: WebSocket,
  label = "WebSocket message",
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${label}`));
    }, EVENT_TIMEOUT_MS);
    const onMessage = (event: MessageEvent): void => {
      cleanup();
      resolve(String(event.data));
    };
    const onClose = (event: CloseEvent): void => {
      cleanup();
      reject(new Error(
        `${label} socket closed first (${event.code}: ${event.reason})`,
      ));
    };
    const onError = (): void => {
      cleanup();
      reject(new Error(`${label} socket errored`));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);
    };
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onError);
  });
}

function nextMessages(
  socket: WebSocket,
  count: number,
  label = "WebSocket messages",
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const messages: string[] = [];
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(
        `Timed out waiting for ${label} (${messages.length}/${count})`,
      ));
    }, EVENT_TIMEOUT_MS);
    const onMessage = (event: MessageEvent): void => {
      messages.push(String(event.data));
      if (messages.length === count) {
        cleanup();
        resolve(messages);
      }
    };
    const onClose = (event: CloseEvent): void => {
      cleanup();
      reject(new Error(
        `${label} socket closed after ${messages.length}/${count} ` +
        `(${event.code}: ${event.reason})`,
      ));
    };
    const onError = (): void => {
      cleanup();
      reject(new Error(`${label} socket errored`));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);
    };
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onError);
  });
}

async function nextJson(
  socket: WebSocket,
  label?: string,
): Promise<Record<string, unknown>> {
  return JSON.parse(await nextMessage(socket, label)) as Record<string, unknown>;
}

function nextClose(
  socket: WebSocket,
  label = "WebSocket close",
): Promise<CloseEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${label}`));
    }, EVENT_TIMEOUT_MS);
    const onClose = (event: CloseEvent): void => {
      cleanup();
      resolve(event);
    };
    const onError = (): void => {
      cleanup();
      reject(new Error(`${label} socket errored`));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);
    };
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onError);
  });
}

function closeForCleanup(...sockets: WebSocket[]): void {
  for (const socket of sockets) {
    if (socket.readyState === 1) {
      socket.close(1_000, "Test cleanup");
    }
  }
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${label}`));
    }, EVENT_TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function injectCurrentServer(
  stub: DurableObjectStub<RendezvousRoom>,
  controlId: string,
  openedAt: number,
): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => {
    const pair = new WebSocketPair();
    const roomServer = pair[1];
    state.acceptWebSocket(roomServer, ["server"]);
    roomServer.serializeAttachment({
      v: 2,
      r: "s",
      u: true,
      p: false,
      c: controlId,
      g: "0".repeat(64),
      o: openedAt,
      t: [],
    });
    pair[0].accept();
  });
}

async function disconnectInjectedServer(
  stub: DurableObjectStub<RendezvousRoom>,
  controlId: string,
  reason: string,
): Promise<void> {
  await runInDurableObject(stub, async (instance, state) => {
    const socket = state.getWebSockets("server").find((candidate) => {
      const stored = candidate.deserializeAttachment() as
        | { readonly c?: unknown }
        | null;
      return stored?.c === controlId;
    });
    if (socket === undefined) {
      throw new Error("Injected server to disconnect is absent");
    }
    await instance.webSocketClose(socket, 1_000, reason, true);
    if (socket.readyState === WebSocket.OPEN) {
      socket.close(1_000, reason);
    }
  });
}

async function closeRoomServersForCleanup(
  stub: DurableObjectStub<RendezvousRoom>,
): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => {
    for (const socket of state.getWebSockets("server")) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.close(1_000, "Test cleanup");
      }
    }
  });
}

async function currentControlIds(
  stub: DurableObjectStub<RendezvousRoom>,
): Promise<string[]> {
  return runInDurableObject(stub, (_instance, state) =>
    state.getWebSockets("server").flatMap((socket) => {
      const attachment = socket.deserializeAttachment() as {
        readonly r?: unknown;
        readonly u?: unknown;
        readonly c?: unknown;
      } | null;
      return attachment?.r === "s" && attachment.u === true &&
        typeof attachment.c === "string"
        ? [attachment.c]
        : [];
    })
  );
}

async function expectFixedError(
  response: Response,
  status: number,
  body: string,
  retryAfter?: string,
): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("Content-Type")).toBe(
    "text/plain; charset=utf-8",
  );
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(response.headers.has("Location")).toBe(false);
  expect(response.headers.get("Retry-After")).toBe(retryAfter ?? null);
  expect(await response.text()).toBe(body);
}

async function seedAdmissions(
  stub: DurableObjectStub,
  timestamps: readonly number[],
): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.transactionSync(() => {
      for (const timestamp of timestamps) {
        state.storage.sql.exec(
          "INSERT INTO rendezvous_admissions (accepted_at_ms) VALUES (?)",
          timestamp,
        );
      }
    });
  });
}

async function admissionCount(stub: DurableObjectStub): Promise<number> {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM rendezvous_admissions",
    ).one().count
  );
}

async function recordTerminalSummaries(
  stub: DurableObjectStub<RendezvousRoom>,
): Promise<RendezvousTerminalSummary[]> {
  const summaries: RendezvousTerminalSummary[] = [];
  await runInDurableObject(stub, (instance: RendezvousRoom) => {
    Reflect.set(
      instance,
      "terminalMetricWriter",
      (
        _dataset: Pick<AnalyticsEngineDataset, "writeDataPoint">,
        summary: RendezvousTerminalSummary,
      ): void => {
        summaries.push({ ...summary });
      },
    );
  });
  return summaries;
}

describe("RendezvousRoom HTTP and admission boundary", () => {
  it("accepts only the exact versioned, bodyless internal upgrade", async () => {
    const stub = room("invalid-upgrade-contract");
    const invalid = [
      new Request(INTERNAL_RENDEZVOUS_URL, {
        method: "POST",
        headers: { [INTERNAL_RENDEZVOUS_ROLE_HEADER]: "server" },
      }),
      new Request(INTERNAL_RENDEZVOUS_URL, {
        headers: { [INTERNAL_RENDEZVOUS_ROLE_HEADER]: "server" },
      }),
      roomRequest("server", { headers: { Upgrade: "h2c" } }),
      roomRequest("server", { headers: { "Content-Type": "text/plain" } }),
      roomRequest("server", {}, `${INTERNAL_RENDEZVOUS_URL}/`),
      roomRequest("server", {}, `${INTERNAL_RENDEZVOUS_URL}?role=server`),
    ];

    for (const request of invalid) {
      await expectFixedError(
        await stub.fetch(request),
        403,
        "Forbidden\n",
      );
    }
  });

  it("fails closed across both directions of a legacy deployment skew", async () => {
    const stub = room("legacy-version-skew");
    const legacyOnly = new Request("https://rendezvous.internal/", {
      headers: {
        Upgrade: "websocket",
        [LEGACY_INTERNAL_RENDEZVOUS_ROLE_HEADER]: "server",
      },
    });
    const newWorkerToLegacyUrl = roomRequest(
      "server",
      {},
      "https://rendezvous.internal/",
    );
    const bothHeaders = roomRequest("server", {
      headers: { [LEGACY_INTERNAL_RENDEZVOUS_ROLE_HEADER]: "server" },
    });

    for (const request of [legacyOnly, newWorkerToLegacyUrl, bothHeaders]) {
      await expectFixedError(
        await stub.fetch(request),
        403,
        "Forbidden\n",
      );
    }
  });

  it("rejects missing and non-canonical internal roles identically", async () => {
    const stub = room("invalid-role-contract");
    for (const role of [undefined, "", "CLIENT", "client,server", "operator"]) {
      await expectFixedError(
        await stub.fetch(roomRequest(role)),
        403,
        "Forbidden\n",
      );
    }
  });

  it("rejects a contract-valid game publication at the classic room boundary", async () => {
    const serverId = ticket(49_999);
    const oldGeneration = "1".repeat(64);
    const newGeneration = "2".repeat(64);
    await seedPublishedGeneration(serverId, oldGeneration);
    const stub = env.RENDEZVOUS.getByName(serverId);

    await expectFixedError(
      await stub.fetch(generationPublicationRequest(
        serverId,
        oldGeneration,
        newGeneration,
        "game-v1",
      )),
      403,
      "Forbidden\n",
    );
    expect(await env.DB.prepare(
      `SELECT rendezvous_generation
         FROM server_presence
        WHERE profile = 'classic-v1' AND server_id = ?`,
    ).bind(serverId).first<string>("rendezvous_generation"))
      .toBe(oldGeneration);
  });

  it("requires one live server control connection before client admission", async () => {
    await expectFixedError(
      await room("missing-server").fetch(roomRequest("client")),
      503,
      "Rendezvous server unavailable\n",
      "5",
    );
  });

  it("enforces the 16-active-client operational ceiling", async () => {
    const stub = room("active-client-ceiling");
    const server = await connect(stub, "server");
    const clients: WebSocket[] = [];
    try {
      for (let index = 0; index < 16; index += 1) {
        clients.push(await connect(stub, "client"));
      }

      await expectFixedError(
        await stub.fetch(roomRequest("client")),
        503,
        "Rendezvous room is full\n",
        "15",
      );
    } finally {
      closeForCleanup(...clients, server);
    }
  });

  it("enforces the 64-client hard ceiling even for terminal sockets", async () => {
    const stub = room("hard-client-ceiling");
    const server = await connect(stub, "server");
    const clients: WebSocket[] = [];
    try {
      for (let index = 0; index < 64; index += 1) {
        clients.push(await connect(stub, "client"));
        await runInDurableObject(stub, (_instance, state) => {
          const active = state.getWebSockets("client").find((socket) => {
            const attachment = socket.deserializeAttachment() as
              | { r?: unknown; s?: unknown }
              | null;
            return attachment?.r === "c" && attachment.s === 0;
          });
          const attachment = active?.deserializeAttachment() as
            | Record<string, unknown>
            | null
            | undefined;
          if (active === undefined || attachment === null ||
            attachment === undefined) {
            throw new Error("Newly admitted client attachment is absent");
          }
          active.serializeAttachment({
            ...attachment,
            s: 2,
            p: 6,
            y: terminalOutcomeCode("internal_error"),
          });
          state.storage.sql.exec("DELETE FROM rendezvous_admissions");
        });
      }

      await expectFixedError(
        await stub.fetch(roomRequest("client")),
        503,
        "Rendezvous room is full\n",
        "15",
      );
    } finally {
      closeForCleanup(...clients, server);
    }
  });

  it("does not turn the rolling replay horizon into a 50-session quota", async () => {
    const stub = room("replay-horizon-not-quota");
    const server = await connect(stub, "server");
    const futureTimestamp = Date.now() + 5_000;
    await seedAdmissions(stub, Array(100).fill(futureTimestamp));

    const client = await connect(stub, "client");
    try {
      expect(await admissionCount(stub)).toBe(101);
    } finally {
      closeForCleanup(client, server);
    }
  });

  it("prunes the exact rolling cutoff while retaining the next millisecond", async () => {
    const stub = room("rolling-session-boundary");
    const now = 2_000_000_000_000;
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(now);
    let server: WebSocket | undefined;
    let client: WebSocket | undefined;
    try {
      server = await connect(stub, "server");
      await seedAdmissions(stub, [
        now - RENDEZVOUS_ROLLING_WINDOW_MS,
        now - RENDEZVOUS_ROLLING_WINDOW_MS + 1,
      ]);

      client = await connect(stub, "client");
      expect(await admissionCount(stub)).toBe(2);
    } finally {
      closeForCleanup(...[client, server].filter(
        (socket): socket is WebSocket => socket !== undefined,
      ));
      dateNow.mockRestore();
    }
  });

  it("serializes concurrent replay-ledger reservations without a daily rejection", async () => {
    const stub = room("concurrent-replay-reservations");
    const server = await connect(stub, "server");
    await seedAdmissions(stub, Array(49).fill(Date.now() + 5_000));

    const responses = await Promise.all([
      stub.fetch(roomRequest("client")),
      stub.fetch(roomRequest("client")),
    ]);
    expect(responses.map(({ status }) => status)).toEqual([101, 101]);
    const sockets = responses.map(({ webSocket }) => {
      if (webSocket === null) {
        throw new Error("Concurrent accepted response returned no WebSocket");
      }
      webSocket.accept();
      return webSocket;
    });
    try {
      expect(await admissionCount(stub)).toBe(51);
    } finally {
      closeForCleanup(...sockets, server);
    }
  });

  it("releases an admission when post-quota upgrade construction fails", async () => {
    const stub = room("failed-client-upgrade-rollback");
    const server = await connect(stub, "server");
    const randomUuid = vi.spyOn(crypto, "randomUUID")
      .mockImplementationOnce(() => {
        throw new Error("injected client upgrade failure");
      });
    try {
      await expectFixedError(
        await stub.fetch(roomRequest("client")),
        503,
        "Rendezvous server unavailable\n",
        "5",
      );
      expect(await admissionCount(stub)).toBe(0);

      randomUuid.mockRestore();
      const client = await connect(stub, "client");
      expect(await admissionCount(stub)).toBe(1);
      closeForCleanup(client);
    } finally {
      randomUuid.mockRestore();
      closeForCleanup(server);
    }
  });

  it("keeps terminal telemetry suppressed when response construction fails", async () => {
    const stub = room("failed-client-response-rollback");
    const server = await connect(stub, "server");
    const summaries = await recordTerminalSummaries(stub);
    await runInDurableObject(stub, (instance: RendezvousRoom) => {
      Reflect.set(instance, "createUpgradeResponse", () => {
        throw new Error("Injected upgrade response failure");
      });
    });
    try {
      await expectFixedError(
        await stub.fetch(roomRequest("client")),
        503,
        "Rendezvous server unavailable\n",
        "5",
      );
      expect(await admissionCount(stub)).toBe(0);
      await Promise.resolve();
      expect(summaries).toEqual([]);
      expect(server.readyState).toBe(WebSocket.OPEN);
    } finally {
      closeForCleanup(server);
    }
  });

  it("propagates teardown failure during post-admission reconciliation", async () => {
    const stub = room("post-admission-teardown-failure");
    const server = await connect(stub, "server");

    await runInDurableObject(stub, async (instance, state) => {
      const originalSchedule = (Reflect.get(
        instance,
        "scheduleNextAlarm",
      ) as (now: number) => Promise<void>).bind(instance);
      const faultRestorers: Array<() => void> = [];
      let injected = false;
      Reflect.set(instance, "scheduleNextAlarm", async (now: number) => {
        await originalSchedule(now);
        if (injected) {
          return;
        }
        injected = true;
        const current = state.getWebSockets("server")[0]
          ?.deserializeAttachment() as
            | Record<string, unknown>
            | null
            | undefined;
        if (current === null || current === undefined) {
          throw new Error("Admission reconciliation server is absent");
        }
        const pair = new WebSocketPair();
        state.acceptWebSocket(pair[1], ["server"]);
        pair[1].serializeAttachment({
          ...current,
          o: Number(current.o) + 1,
        });
        pair[0].accept();
        for (const socket of state.getWebSockets("server")) {
          const serialize = vi.spyOn(socket, "serializeAttachment")
            .mockImplementation(() => {
              throw new Error("Injected reconciliation persistence failure");
            });
          const close = vi.spyOn(socket, "close").mockImplementation(() => {
            throw new Error("Injected reconciliation close failure");
          });
          faultRestorers.push(() => {
            close.mockRestore();
            serialize.mockRestore();
          });
        }
      });

      const acceptClient = Reflect.get(instance, "acceptClient") as (
        now: number,
        policy: {
          readonly rendezvousActiveClientLimit: number;
          readonly rendezvousClientSessionSeconds: number;
        },
        authorizationRequired: boolean,
        inviteProtocol: boolean,
        generation: string,
      ) => Promise<Response>;
      try {
        await expect(acceptClient.call(instance, Date.now(), {
          rendezvousActiveClientLimit: 16,
          rendezvousClientSessionSeconds: 15,
        }, false, false, "0".repeat(64))).rejects.toMatchObject({
          name: "RendezvousTeardownIntegrityError",
          message: "Rendezvous duplicate controls were not retired",
        });
        expect(await state.storage.get(
          "rendezvous:teardown-recovery-required",
        )).toBe(true);
        expect(state.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM rendezvous_admissions",
        ).one().count).toBe(0);
      } finally {
        for (const restore of faultRestorers.reverse()) {
          restore();
        }
        Reflect.set(instance, "scheduleNextAlarm", originalSchedule);
      }
      await expect(instance.alarm()).resolves.toBeUndefined();
    });

    closeForCleanup(server);
  });

  it("reports only actual visible publication changes to the outer Worker", async () => {
    const serverId = ticket(40_001);
    const firstGeneration = "1".repeat(64);
    const secondGeneration = "2".repeat(64);
    const thirdGeneration = "3".repeat(64);
    await seedPublishedGeneration(serverId, firstGeneration);
    const stub = env.RENDEZVOUS.getByName(serverId);

    const changed = await stub.fetch(generationPublicationRequest(
      serverId,
      firstGeneration,
      secondGeneration,
    ));
    expect(changed.status).toBe(204);
    expect(changed.headers.get(INTERNAL_DIRECTORY_CHANGED_HEADER)).toBe("1");

    const heartbeat = await stub.fetch(generationPublicationRequest(
      serverId,
      secondGeneration,
      thirdGeneration,
    ));
    expect(heartbeat.status).toBe(204);
    expect(heartbeat.headers.get(INTERNAL_DIRECTORY_CHANGED_HEADER)).toBe("0");
  });
});

describe("RendezvousRoom protected authorization", () => {
  it("requires an invite-capable current server before protected admission", async () => {
    const stub = room("protected-server-capability");
    const server = await connect(stub, "server");
    await expectFixedError(
      await stub.fetch(roomRequest("client", {
        headers: {
          [INTERNAL_RENDEZVOUS_PROTOCOL_HEADER]: "classic-invite-v1",
          [INTERNAL_RENDEZVOUS_AUTHORIZATION_HEADER]: "required",
        },
      })),
      503,
      "Rendezvous server unavailable\n",
      "5",
    );
    await expect(admissionCount(stub)).resolves.toBe(0);
    closeForCleanup(server);
  });

  it("gates candidates behind a hibernation-safe four-frame exchange", async () => {
    const stub = room("protected-success");
    const server = await connect(stub, "server", { inviteProtocol: true });
    const client = await connect(stub, "client", {
      inviteProtocol: true,
      authorizationRequired: true,
    });
    const selectedTicket = ticket(700);

    let relayed = nextJson(server, "authorization init");
    client.send(authInit(selectedTicket));
    expect(await relayed).toEqual(JSON.parse(authInit(selectedTicket)));
    await runInDurableObject(stub, (_instance, state) => {
      const serialized = JSON.stringify(
        state.getWebSockets().map((socket) => socket.deserializeAttachment()),
      );
      expect(serialized).not.toMatch(/invite_id|challenge|proof|secret/);
    });
    await evictDurableObject(stub);

    relayed = nextJson(client, "authorization challenge");
    server.send(authChallenge(selectedTicket));
    expect(await relayed).toEqual(JSON.parse(authChallenge(selectedTicket)));
    await evictDurableObject(stub);

    relayed = nextJson(server, "authorization proof");
    client.send(authProof(selectedTicket));
    expect(await relayed).toEqual(JSON.parse(authProof(selectedTicket)));
    await evictDurableObject(stub);

    relayed = nextJson(client, "authorization result");
    server.send(authResult(selectedTicket, true));
    expect(await relayed).toEqual(JSON.parse(authResult(selectedTicket, true)));
    await evictDurableObject(stub);

    relayed = nextJson(server, "authorized client candidate");
    client.send(clientCandidate(selectedTicket));
    expect(await relayed).toEqual(JSON.parse(clientCandidate(selectedTicket)));
    const candidate = nextJson(client, "authorized server candidate");
    server.send(serverCandidate(selectedTicket));
    expect(await candidate).toEqual(JSON.parse(serverCandidate(selectedTicket)));
    const completed = nextJson(client, "authorized completion");
    const clientClosed = nextClose(client, "authorized completion close");
    server.send(complete(selectedTicket));
    expect(await completed).toEqual(JSON.parse(complete(selectedTicket)));
    await expect(clientClosed).resolves.toMatchObject(COMPLETE_CLOSE);
    closeForCleanup(server);
  });

  it.each([
    ["before auth_init", 0],
    ["after auth_init", 1],
    ["after auth_challenge", 2],
    ["after auth_proof", 3],
    ["after authorization", 4],
  ] as const)("invalidates protected state %s on token rotation", async (
    _label,
    prefix,
  ) => {
    const serverId = ticket(50_000 + prefix);
    const oldGeneration = "1".repeat(64);
    const newGeneration = "2".repeat(64);
    await seedPublishedGeneration(serverId, oldGeneration);
    const stub = env.RENDEZVOUS.getByName(serverId);
    const server = await connect(stub, "server", {
      inviteProtocol: true,
      generation: oldGeneration,
    });
    const client = await connect(stub, "client", {
      inviteProtocol: true,
      authorizationRequired: true,
      generation: oldGeneration,
    });
    const selectedTicket = ticket(720 + prefix);

    if (prefix >= 1) {
      const init = nextJson(server, "generation init");
      client.send(authInit(selectedTicket));
      await init;
    }
    if (prefix >= 2) {
      const challenge = nextJson(client, "generation challenge");
      server.send(authChallenge(selectedTicket));
      await challenge;
    }
    if (prefix >= 3) {
      const proof = nextJson(server, "generation proof");
      client.send(authProof(selectedTicket));
      await proof;
    }
    if (prefix >= 4) {
      const result = nextJson(client, "generation result");
      server.send(authResult(selectedTicket, true));
      await result;
    }

    const serverClosed = nextClose(server, "rotated server close");
    const clientClosed = nextClose(client, "rotated client close");
    expect((await rotateGeneration(
      stub,
      serverId,
      oldGeneration,
      newGeneration,
    )).status).toBe(204);
    await expect(serverClosed).resolves.toMatchObject(REPLACED_CLOSE);
    await expect(clientClosed).resolves.toMatchObject(REPLACED_CLOSE);

    await evictDurableObject(stub);
    await expectFixedError(
      await stub.fetch(roomRequest("server", {
        headers: {
          [INTERNAL_RENDEZVOUS_GENERATION_HEADER]: oldGeneration,
        },
      })),
      503,
      "Rendezvous room unavailable\n",
      "60",
    );
    const replacement = await connect(stub, "server", {
      inviteProtocol: true,
      generation: newGeneration,
    });
    const nextClient = await connect(stub, "client", {
      inviteProtocol: true,
      authorizationRequired: true,
      generation: newGeneration,
    });
    closeForCleanup(nextClient, replacement);
  });

  it("serializes a cold upgrade reconciliation with publication", async () => {
    const serverId = ticket(50_100);
    const oldGeneration = "3".repeat(64);
    const newGeneration = "4".repeat(64);
    await seedPublishedGeneration(serverId, oldGeneration);
    const stub = env.RENDEZVOUS.getByName(serverId);

    await runInDurableObject(stub, async (instance, state) => {
      const roomEnv = Reflect.get(instance, "env") as Env;
      let releaseStaleRead = (): void => {};
      const staleReadGate = new Promise<void>((resolve) => {
        releaseStaleRead = resolve;
      });
      let markStaleRead = (): void => {};
      const staleRead = new Promise<void>((resolve) => {
        markStaleRead = resolve;
      });
      const internals = instance as unknown as {
        reconcilePublishedGeneration(serverId: string): Promise<string | null>;
      };
      let firstReconciliation = true;
      const reconcileSpy = vi.spyOn(internals, "reconcilePublishedGeneration")
        .mockImplementation(async (_selectedServerId: string) => {
          if (!firstReconciliation) {
            throw new Error("Stale reconciliation test spy was not restored");
          }
          firstReconciliation = false;
          reconcileSpy.mockRestore();
          markStaleRead();
          await staleReadGate;
          Reflect.set(instance, "currentGeneration", oldGeneration);
          return oldGeneration;
        });

      const staleUpgrade = instance.fetch(roomRequest("server", {
        headers: {
          [INTERNAL_RENDEZVOUS_GENERATION_HEADER]: oldGeneration,
        },
      }));
      await staleRead;
      const publication = instance.fetch(generationPublicationRequest(
        serverId,
        oldGeneration,
        newGeneration,
      ));
      let publicationSettled = false;
      void publication.then(() => {
        publicationSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(publicationSettled).toBe(false);
      expect(await roomEnv.DB.prepare(
        `SELECT rendezvous_generation
           FROM server_presence
          WHERE profile = 'classic-v1' AND server_id = ?`,
      ).bind(serverId).first<string>("rendezvous_generation"))
        .toBe(oldGeneration);
      releaseStaleRead();

      const [upgradeResponse, publicationResponse] = await Promise.all([
        staleUpgrade,
        publication,
      ]);
      expect(upgradeResponse.status).toBe(101);
      expect(publicationResponse.status).toBe(204);
      expect(publicationResponse.headers.get(INTERNAL_DIRECTORY_CHANGED_HEADER))
        .toBe("1");
      const oldSocket = upgradeResponse.webSocket;
      if (oldSocket === null) {
        throw new Error("Serialized stale upgrade returned no WebSocket");
      }
      oldSocket.accept();
      closeForCleanup(oldSocket);
      expect(await state.storage.get("rendezvous:token-generation"))
        .toBe(newGeneration);
      expect(state.getWebSockets("server").filter((socket) => {
        const attachment = decodeRendezvousAttachment(
          socket.deserializeAttachment(),
        );
        return attachment?.role === "server" && attachment.current;
      })).toHaveLength(0);
    });
    expect(await env.DB.prepare(
      `SELECT rendezvous_generation
         FROM server_presence
        WHERE profile = 'classic-v1' AND server_id = ?`,
    ).bind(serverId).first<string>("rendezvous_generation")).toBe(newGeneration);

    await evictDurableObject(stub);
    await expectFixedError(
      await stub.fetch(roomRequest("server", {
        headers: {
          [INTERNAL_RENDEZVOUS_GENERATION_HEADER]: oldGeneration,
        },
      })),
      503,
      "Rendezvous room unavailable\n",
      "60",
    );
    const current = await connect(stub, "server", {
      generation: newGeneration,
    });
    closeForCleanup(current);
  });

  it("acknowledges an exact publication committed before an ambiguous rejection", async () => {
    const serverId = ticket(50_101);
    const oldGeneration = "5".repeat(64);
    const newGeneration = "6".repeat(64);
    await seedPublishedGeneration(serverId, oldGeneration);
    const stub = env.RENDEZVOUS.getByName(serverId);

    await runInDurableObject(stub, async (instance, state) => {
      const originalPersister = Reflect.get(
        instance,
        "publicationPersister",
      ) as (
        db: D1Database,
        publication: unknown,
      ) => Promise<void>;
      Reflect.set(instance, "publicationPersister", async (
        db: D1Database,
        publication: unknown,
      ) => {
        await originalPersister(db, publication);
        throw new Error("Injected response loss after D1 commit");
      });
      try {
        const response = await instance.fetch(generationPublicationRequest(
          serverId,
          oldGeneration,
          newGeneration,
        ));
        expect(response.status).toBe(204);
        expect(response.headers.get(INTERNAL_DIRECTORY_CHANGED_HEADER)).toBe("1");
        expect(await state.storage.get("rendezvous:token-generation"))
          .toBe(newGeneration);
      } finally {
        Reflect.set(instance, "publicationPersister", originalPersister);
      }
    });

    expect(await env.DB.prepare(
      `SELECT presence.rendezvous_generation AS listing_generation,
              presence.rendezvous_token_hash
         FROM server_presence AS presence
        WHERE presence.profile = 'classic-v1' AND presence.server_id = ?`,
    ).bind(serverId).first()).toEqual({
      listing_generation: newGeneration,
      rendezvous_token_hash: "f".repeat(64),
    });
    await evictDurableObject(stub);
    const current = await connect(stub, "server", {
      generation: newGeneration,
    });
    closeForCleanup(current);
  });

  it("persists recovery quarantine when publish-time retirement cannot finish", async () => {
    const serverId = ticket(50_102);
    const oldGeneration = "7".repeat(64);
    const newGeneration = "8".repeat(64);
    await seedPublishedGeneration(serverId, oldGeneration);
    const stub = env.RENDEZVOUS.getByName(serverId);

    await runInDurableObject(stub, async (instance, state) => {
      const oldResponse = await instance.fetch(roomRequest("server", {
        headers: {
          [INTERNAL_RENDEZVOUS_GENERATION_HEADER]: oldGeneration,
        },
      }));
      expect(oldResponse.status).toBe(101);
      const oldPeer = oldResponse.webSocket;
      const roomServer = state.getWebSockets("server")[0];
      if (oldPeer === null || roomServer === undefined) {
        throw new Error("Publish teardown test server pair is absent");
      }
      oldPeer.accept();
      const serialize = vi.spyOn(roomServer, "serializeAttachment")
        .mockImplementation(() => {
          throw new Error("Injected generation retirement write failure");
        });
      const close = vi.spyOn(roomServer, "close").mockImplementation(() => {
        throw new Error("Injected generation retirement close failure");
      });
      try {
        await expect(instance.fetch(generationPublicationRequest(
          serverId,
          oldGeneration,
          newGeneration,
        ))).rejects.toMatchObject({
          name: "RendezvousTeardownIntegrityError",
          message: "Rendezvous server teardown was not persisted",
        });
        expect(await state.storage.get(
          "rendezvous:teardown-recovery-required",
        )).toBe(true);
        expect(await state.storage.get("rendezvous:token-generation"))
          .toBe(newGeneration);
      } finally {
        close.mockRestore();
        serialize.mockRestore();
        await instance.alarm();
        closeForCleanup(oldPeer);
      }
    });

    expect(await env.DB.prepare(
      `SELECT rendezvous_generation
         FROM server_presence
        WHERE profile = 'classic-v1' AND server_id = ?`,
    ).bind(serverId).first<string>("rendezvous_generation")).toBe(oldGeneration);
    await evictDurableObject(stub);
    const recovered = await connect(stub, "server", {
      generation: oldGeneration,
    });
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.get(
        "rendezvous:teardown-recovery-required",
      )).toBeUndefined();
      expect(await state.storage.get("rendezvous:token-generation"))
        .toBe(oldGeneration);
    });
    closeForCleanup(recovered);
  });

  it("keeps authorization and candidates isolated between protected clients", async () => {
    const stub = room("protected-client-isolation");
    const server = await connect(stub, "server", { inviteProtocol: true });
    const firstClient = await connect(stub, "client", {
      inviteProtocol: true,
      authorizationRequired: true,
    });
    const secondClient = await connect(stub, "client", {
      inviteProtocol: true,
      authorizationRequired: true,
    });
    const firstTicket = ticket(707);
    const secondTicket = ticket(708);
    try {
      let relayed = nextJson(server, "first protected init");
      firstClient.send(authInit(firstTicket, "1".repeat(32)));
      expect(await relayed).toEqual(
        JSON.parse(authInit(firstTicket, "1".repeat(32))),
      );
      relayed = nextJson(server, "second protected init");
      secondClient.send(authInit(secondTicket, "2".repeat(32)));
      expect(await relayed).toEqual(
        JSON.parse(authInit(secondTicket, "2".repeat(32))),
      );

      relayed = nextJson(firstClient, "first protected challenge");
      server.send(authChallenge(firstTicket, "3".repeat(64)));
      expect(await relayed).toEqual(
        JSON.parse(authChallenge(firstTicket, "3".repeat(64))),
      );
      relayed = nextJson(secondClient, "second protected challenge");
      server.send(authChallenge(secondTicket, "4".repeat(64)));
      expect(await relayed).toEqual(
        JSON.parse(authChallenge(secondTicket, "4".repeat(64))),
      );

      relayed = nextJson(server, "first protected proof");
      firstClient.send(authProof(firstTicket, "5".repeat(64)));
      expect(await relayed).toEqual(
        JSON.parse(authProof(firstTicket, "5".repeat(64))),
      );
      relayed = nextJson(server, "second protected proof");
      secondClient.send(authProof(secondTicket, "6".repeat(64)));
      expect(await relayed).toEqual(
        JSON.parse(authProof(secondTicket, "6".repeat(64))),
      );

      relayed = nextJson(firstClient, "first protected result");
      server.send(authResult(firstTicket, true));
      expect(await relayed).toEqual(JSON.parse(authResult(firstTicket, true)));

      const secondLeak = vi.fn();
      secondClient.addEventListener("message", secondLeak);
      relayed = nextJson(server, "first authorized candidate");
      firstClient.send(clientCandidate(firstTicket));
      expect(await relayed).toEqual(JSON.parse(clientCandidate(firstTicket)));
      const firstReply = nextJson(firstClient, "first isolated reply");
      server.send(serverCandidate(firstTicket));
      expect(await firstReply).toEqual(JSON.parse(serverCandidate(firstTicket)));
      await Promise.resolve();
      expect(secondLeak).not.toHaveBeenCalled();

      const unauthorizedForward = vi.fn();
      server.addEventListener("message", unauthorizedForward);
      const secondClosed = nextClose(
        secondClient,
        "second preauthorization candidate close",
      );
      secondClient.send(clientCandidate(secondTicket));
      await expect(secondClosed).resolves.toMatchObject(PROTOCOL_CLOSE);
      await Promise.resolve();
      expect(unauthorizedForward).not.toHaveBeenCalled();
      expect(server.readyState).toBe(WebSocket.OPEN);
      secondClient.removeEventListener("message", secondLeak);
      server.removeEventListener("message", unauthorizedForward);
    } finally {
      closeForCleanup(firstClient, secondClient, server);
    }
  });

  it("rejects a protected ticket replay after control replacement and eviction", async () => {
    const stub = room("protected-ticket-replay");
    const originalServer = await connect(stub, "server", {
      inviteProtocol: true,
    });
    const originalClient = await connect(stub, "client", {
      inviteProtocol: true,
      authorizationRequired: true,
    });
    const selectedTicket = ticket(709);
    const offered = nextJson(originalServer, "original protected init");
    originalClient.send(authInit(selectedTicket));
    await offered;

    const originalClientClosed = nextClose(
      originalClient,
      "original protected client control-disconnect close",
    );
    originalServer.close(1_000, "Test control disconnect");
    await expect(originalClientClosed).resolves.toMatchObject(
      SERVER_UNAVAILABLE_CLOSE,
    );
    await evictDurableObject(stub);

    const replacementServer = await connect(stub, "server", {
      inviteProtocol: true,
    });
    const replacementClient = await connect(stub, "client", {
      inviteProtocol: true,
      authorizationRequired: true,
    });
    const forwarded = vi.fn();
    replacementServer.addEventListener("message", forwarded);
    const replayClosed = nextClose(
      replacementClient,
      "replayed protected ticket close",
    );
    replacementClient.send(authInit(selectedTicket));
    await expect(replayClosed).resolves.toMatchObject(PROTOCOL_CLOSE);
    await Promise.resolve();
    expect(forwarded).not.toHaveBeenCalled();
    replacementServer.removeEventListener("message", forwarded);
    closeForCleanup(replacementServer);
  });

  it("expires an incomplete protected authorization after 15 seconds", async () => {
    const stub = room("protected-authorization-expiry");
    const now = 2_250_000_000_000;
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(now);
    let server: WebSocket | undefined;
    let client: WebSocket | undefined;
    try {
      server = await connect(stub, "server", { inviteProtocol: true });
      client = await connect(stub, "client", {
        inviteProtocol: true,
        authorizationRequired: true,
      });
      const init = nextJson(server, "expiring protected init");
      client.send(authInit(ticket(710)));
      await init;

      dateNow.mockReturnValue(now + 15_000);
      await evictDurableObject(stub);
      const summaries = await recordTerminalSummaries(stub);
      const closed = nextClose(client, "expired protected client close");
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      await expect(closed).resolves.toMatchObject(EXPIRED_CLOSE);
      expect(summaries).toEqual([
        expect.objectContaining({ outcome: "session_expired" }),
      ]);
    } finally {
      closeForCleanup(...[client, server].filter(
        (socket): socket is WebSocket => socket !== undefined,
      ));
      dateNow.mockRestore();
    }
  });

  it("closes a protected client that discloses a candidate before authorization", async () => {
    const stub = room("protected-candidate-downgrade");
    const server = await connect(stub, "server", { inviteProtocol: true });
    const client = await connect(stub, "client", {
      inviteProtocol: true,
      authorizationRequired: true,
    });
    const clientClosed = nextClose(client, "preauthorization candidate close");
    client.send(clientCandidate(ticket(701)));
    await expect(clientClosed).resolves.toMatchObject(PROTOCOL_CLOSE);
    await runInDurableObject(stub, (_instance, state) => {
      const roomServer = state.getWebSockets("server")[0];
      const stored = roomServer?.deserializeAttachment() as
        | { readonly t?: unknown[] }
        | null
        | undefined;
      expect(stored?.t).toEqual([]);
    });
    closeForCleanup(server);
  });

  it("forwards one generic denial and records authorization failure", async () => {
    const stub = room("protected-denial");
    const server = await connect(stub, "server", { inviteProtocol: true });
    const client = await connect(stub, "client", {
      inviteProtocol: true,
      authorizationRequired: true,
    });
    const summaries = await recordTerminalSummaries(stub);
    const selectedTicket = ticket(702);
    let relayed = nextJson(server, "denial init");
    client.send(authInit(selectedTicket));
    await relayed;
    relayed = nextJson(client, "denial challenge");
    server.send(authChallenge(selectedTicket));
    await relayed;
    relayed = nextJson(server, "denial proof");
    client.send(authProof(selectedTicket));
    await relayed;

    const denied = nextJson(client, "authorization denial");
    const clientClosed = nextClose(client, "authorization denial close");
    server.send(authResult(selectedTicket, false));
    expect(await denied).toEqual(JSON.parse(authResult(selectedTicket, false)));
    await expect(clientClosed).resolves.toMatchObject({
      code: 4_005,
      reason: "Rendezvous authorization failed",
    });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      outcome: "authorization_failed",
      clientFramesAccepted: 2,
      serverFramesMatched: 2,
      framesForwarded: 4,
    });
    await evictDurableObject(stub);
    const nextClient = await connect(stub, "client", {
      inviteProtocol: true,
      authorizationRequired: true,
    });
    const nextInit = nextJson(server, "post-denial authorization init");
    nextClient.send(authInit(ticket(711)));
    expect(await nextInit).toEqual(JSON.parse(authInit(ticket(711))));
    closeForCleanup(nextClient, server);
  });

  it("rejects cross-ticket and repeated authorization frames", async () => {
    const crossStub = room("protected-cross-ticket");
    const crossServer = await connect(crossStub, "server", {
      inviteProtocol: true,
    });
    const crossClient = await connect(crossStub, "client", {
      inviteProtocol: true,
      authorizationRequired: true,
    });
    const selectedTicket = ticket(703);
    const init = nextJson(crossServer, "cross-ticket init");
    crossClient.send(authInit(selectedTicket));
    await init;
    const serverClosed = nextClose(crossServer, "cross-ticket server close");
    const clientClosed = nextClose(crossClient, "cross-ticket client close");
    crossServer.send(authChallenge(ticket(704)));
    await expect(serverClosed).resolves.toMatchObject(PROTOCOL_CLOSE);
    await expect(clientClosed).resolves.toMatchObject(PROTOCOL_CLOSE);

    const repeatStub = room("protected-repeated-proof");
    const repeatServer = await connect(repeatStub, "server", {
      inviteProtocol: true,
    });
    const repeatClient = await connect(repeatStub, "client", {
      inviteProtocol: true,
      authorizationRequired: true,
    });
    const repeatTicket = ticket(705);
    let frame = nextJson(repeatServer, "repeat init");
    repeatClient.send(authInit(repeatTicket));
    await frame;
    frame = nextJson(repeatClient, "repeat challenge");
    repeatServer.send(authChallenge(repeatTicket));
    await frame;
    frame = nextJson(repeatServer, "first proof");
    repeatClient.send(authProof(repeatTicket));
    await frame;
    const repeatClosed = nextClose(repeatClient, "repeated proof close");
    repeatClient.send(authProof(repeatTicket));
    await expect(repeatClosed).resolves.toMatchObject(PROTOCOL_CLOSE);
    closeForCleanup(repeatServer);
  });

  it("permits one causal late authorization frame and rejects repetition", async () => {
    const stub = room("protected-late-authorization");
    const server = await connect(stub, "server", { inviteProtocol: true });
    const client = await connect(stub, "client", {
      inviteProtocol: true,
      authorizationRequired: true,
    });
    const selectedTicket = ticket(712);
    const init = nextJson(server, "late-frame init");
    client.send(authInit(selectedTicket));
    await init;

    const clientClosed = nextClose(client, "terminal prechallenge client");
    client.send(authProof(selectedTicket));
    await expect(clientClosed).resolves.toMatchObject(PROTOCOL_CLOSE);

    server.send(authChallenge(selectedTicket));
    const serverClosed = nextClose(server, "repeated late challenge server close");
    server.send(authChallenge(selectedTicket));
    await expect(serverClosed).resolves.toMatchObject(PROTOCOL_CLOSE);
  });

  it("invalidates pending authorization when the server control is replaced", async () => {
    const stub = room("protected-replacement");
    const server = await connect(stub, "server", { inviteProtocol: true });
    const client = await connect(stub, "client", {
      inviteProtocol: true,
      authorizationRequired: true,
    });
    const init = nextJson(server, "replacement pending init");
    client.send(authInit(ticket(706)));
    await init;
    const serverClosed = nextClose(server, "protected replaced server");
    const clientClosed = nextClose(client, "protected replaced client");
    const replacement = await connect(stub, "server", { inviteProtocol: true });
    await expect(serverClosed).resolves.toMatchObject(REPLACED_CLOSE);
    await expect(clientClosed).resolves.toMatchObject(REPLACED_CLOSE);
    closeForCleanup(replacement);
  });
});

describe("RendezvousRoom ticket-scoped relay", () => {
  it("routes each ticket only to the client socket that claimed it", async () => {
    const stub = room("ticket-isolation");
    const server = await connect(stub, "server");
    const firstClient = await connect(stub, "client");
    const secondClient = await connect(stub, "client");
    const firstTicket = ticket(1);
    const secondTicket = ticket(2);
    try {
      const firstOffer = nextMessage(server, "first client offer");
      firstClient.send(clientCandidate(firstTicket));
      expect(await firstOffer).toBe(
        `{"type":"client_candidate","host":"192.0.2.10",` +
        `"port":49152,"ticket":"${firstTicket}"}`,
      );

      const secondOffer = nextJson(server, "second client offer");
      secondClient.send(clientCandidate(secondTicket));
      expect(await secondOffer).toMatchObject({
        type: "client_candidate",
        ticket: secondTicket,
      });

      const firstReply = nextMessage(firstClient, "first ticket reply");
      const secondReply = nextJson(secondClient, "second ticket reply");
      server.send(serverCandidate(firstTicket));
      expect(await firstReply).toBe(
        `{"type":"server_candidate","host":"192.0.2.20",` +
        `"port":1730,"kind":"srflx","ticket":"${firstTicket}"}`,
      );

      server.send(serverCandidate(secondTicket, 1));
      expect(await secondReply).toMatchObject({
        type: "server_candidate",
        ticket: secondTicket,
      });
    } finally {
      closeForCleanup(firstClient, secondClient, server);
    }
  });

  it("rejects duplicate ticket claims made from another client socket", async () => {
    const stub = room("duplicate-ticket");
    const server = await connect(stub, "server");
    const owner = await connect(stub, "client");
    const duplicate = await connect(stub, "client");
    const selectedTicket = ticket(3);
    try {
      const offered = nextJson(server, "owned ticket offer");
      owner.send(clientCandidate(selectedTicket));
      await offered;

      const duplicateClosed = nextClose(duplicate, "duplicate ticket close");
      duplicate.send(clientCandidate(selectedTicket));
      await expect(duplicateClosed).resolves.toMatchObject(PROTOCOL_CLOSE);

      const ownerReply = nextJson(owner, "ticket owner reply");
      server.send(serverCandidate(selectedTicket));
      expect(await ownerReply).toMatchObject({
        type: "server_candidate",
        ticket: selectedTicket,
      });
      expect(server.readyState).toBe(1);
    } finally {
      closeForCleanup(owner, duplicate, server);
    }
  });

  it("rejects replay after server disconnect, eviction, and reconnect", async () => {
    const stub = room("ticket-replay-after-reconnect");
    const originalServer = await connect(stub, "server");
    const originalClient = await connect(stub, "client");
    const selectedTicket = ticket(65);
    const offered = nextJson(originalServer, "original replay ticket offer");
    originalClient.send(clientCandidate(selectedTicket));
    await offered;

    const originalClientClosed = nextClose(
      originalClient,
      "original client server-disconnect close",
    );
    originalServer.close(1_000, "Test control disconnect");
    await expect(originalClientClosed).resolves.toMatchObject(
      SERVER_UNAVAILABLE_CLOSE,
    );
    await evictDurableObject(stub);

    const replacementServer = await connect(stub, "server");
    const replacementClient = await connect(stub, "client");
    const forwarded = vi.fn();
    replacementServer.addEventListener("message", forwarded);
    const replayClosed = nextClose(replacementClient, "replayed ticket close");
    replacementClient.send(clientCandidate(selectedTicket));
    await expect(replayClosed).resolves.toMatchObject(PROTOCOL_CLOSE);
    await Promise.resolve();
    expect(forwarded).not.toHaveBeenCalled();
    expect(replacementServer.readyState).toBe(1);
    replacementServer.removeEventListener("message", forwarded);
    closeForCleanup(replacementServer);
  });

  it("forwards only the first of two back-to-back client candidates", async () => {
    const stub = room("one-client-candidate");
    const server = await connect(stub, "server");
    const client = await connect(stub, "client");
    try {
      const offered = nextJson(server, "first client candidate");
      const closed = nextClose(client, "second client candidate close");
      client.send(clientCandidate(ticket(4)));
      client.send(clientCandidate(ticket(5)));
      await expect(offered).resolves.toMatchObject({ ticket: ticket(4) });
      await expect(closed).resolves.toMatchObject(PROTOCOL_CLOSE);
      expect(server.readyState).toBe(1);
    } finally {
      closeForCleanup(client, server);
    }
  });

  it("retires a server control whose candidate send fails", async () => {
    const stub = room("server-send-failure");
    const server = await connect(stub, "server");
    const client = await connect(stub, "client");
    const summaries = await recordTerminalSummaries(stub);
    let restoreSend = (): void => {};
    await runInDurableObject(stub, (_instance, state) => {
      const roomServer = state.getWebSockets("server")[0];
      if (roomServer === undefined) {
        throw new Error("Send-failure server room socket is absent");
      }
      const send = vi.spyOn(roomServer, "send").mockImplementation(() => {
        throw new Error("Injected server-control send failure");
      });
      restoreSend = (): void => send.mockRestore();
    });
    try {
      const serverClosed = nextClose(server, "send-failure server close");
      const clientClosed = nextClose(client, "send-failure client close");
      client.send(clientCandidate(ticket(68)));
      await expect(serverClosed).resolves.toMatchObject(
        SERVER_UNAVAILABLE_CLOSE,
      );
      await expect(clientClosed).resolves.toMatchObject(
        SERVER_UNAVAILABLE_CLOSE,
      );
      expect(summaries).toEqual([
        expect.objectContaining({
          outcome: "server_unavailable",
          clientFramesAccepted: 1,
          framesForwarded: 0,
        }),
      ]);
      await expectFixedError(
        await stub.fetch(roomRequest("client")),
        503,
        "Rendezvous server unavailable\n",
        "5",
      );
    } finally {
      restoreSend();
      closeForCleanup(client, server);
    }
  });

  it("drops bounded late frames for a known disconnected ticket", async () => {
    const stub = room("late-known-ticket-frames");
    const server = await connect(stub, "server");
    const client = await connect(stub, "client");
    const selectedTicket = ticket(12);
    const offered = nextJson(server, "disconnected client offer");
    client.send(clientCandidate(selectedTicket));
    await offered;

    await runInDurableObject(stub, async (instance, state) => {
      const roomClient = state.getWebSockets("client")[0];
      if (roomClient === undefined) {
        throw new Error("Client room socket is absent");
      }
      const handler = instance as unknown as {
        webSocketClose(
          socket: WebSocket,
          code: number,
          reason: string,
          clean: boolean,
        ): Promise<void>;
      };
      await handler.webSocketClose(roomClient, 1_000, "", true);
      roomClient.close(1_000, "Test disconnect");
    });

    server.send(serverCandidate(selectedTicket));
    server.send(complete(selectedTicket));

    const nextClient = await connect(stub, "client");
    const nextTicket = ticket(13);
    const offeredAgain = nextJson(server, "offer after late frames");
    nextClient.send(clientCandidate(nextTicket));
    expect(await offeredAgain).toMatchObject({ ticket: nextTicket });
    closeForCleanup(nextClient, server);
  });

  it("allows 12 back-to-back server candidates and fails the control on the 13th", async () => {
    const stub = room("server-candidate-ceiling");
    const server = await connect(stub, "server");
    const client = await connect(stub, "client");
    const selectedTicket = ticket(6);
    const offered = nextJson(server, "candidate-limit offer");
    client.send(clientCandidate(selectedTicket));
    await offered;

    const relayed = nextMessages(client, 12, "12 server candidates");
    const serverClosed = nextClose(server, "13th candidate server close");
    const clientClosed = nextClose(client, "13th candidate client close");
    for (let index = 0; index < 13; index += 1) {
      server.send(serverCandidate(selectedTicket, index));
    }
    expect((await relayed).map((frame) => JSON.parse(frame))).toEqual(
      Array.from({ length: 12 }, (_, index) => ({
        type: "server_candidate",
        host: `192.0.2.${index + 20}`,
        port: 1_730 + index,
        kind: "srflx",
        ticket: selectedTicket,
      })),
    );
    await expect(serverClosed).resolves.toMatchObject(PROTOCOL_CLOSE);
    await expect(clientClosed).resolves.toMatchObject(PROTOCOL_CLOSE);
  });

  it("preserves candidate-before-completion order in one server burst", async () => {
    const stub = room("ordered-server-burst");
    const server = await connect(stub, "server");
    const client = await connect(stub, "client");
    const selectedTicket = ticket(60);
    const offered = nextJson(server, "ordered burst offer");
    client.send(clientCandidate(selectedTicket));
    await offered;

    const frames = nextMessages(client, 13, "ordered server burst");
    const clientClosed = nextClose(client, "ordered burst completion close");
    for (let index = 0; index < 12; index += 1) {
      server.send(serverCandidate(selectedTicket, index));
    }
    server.send(complete(selectedTicket));

    const parsed = (await frames).map((frame) => JSON.parse(frame)) as Array<{
      type: string;
    }>;
    expect(parsed.slice(0, 12).every(({ type }) =>
      type === "server_candidate"
    )).toBe(true);
    expect(parsed[12]).toEqual({ type: "complete", ticket: selectedTicket });
    await expect(clientClosed).resolves.toMatchObject(COMPLETE_CLOSE);
    closeForCleanup(server);
  });

  it("does not start a second client digest while the first frame is pending", async () => {
    const stub = room("client-message-fifo");
    const server = await connect(stub, "server");
    const client = await connect(stub, "client");
    const firstTicket = ticket(61);
    const offered = nextJson(server, "FIFO client offer");
    const clientClosed = nextClose(client, "FIFO duplicate client close");

    await runInDurableObject(stub, async (instance: RendezvousRoom, state) => {
      const roomClient = state.getWebSockets("client")[0];
      if (roomClient === undefined) {
        throw new Error("FIFO client room socket is absent");
      }
      let releaseDigest: (() => void) | undefined;
      const digestGate = new Promise<void>((resolve) => {
        releaseDigest = resolve;
      });
      let digestCalls = 0;
      Reflect.set(instance, "digestTicket", async (rawTicket: string) => {
        digestCalls += 1;
        if (digestCalls === 1) {
          await digestGate;
        }
        return sha256Hex(rawTicket);
      });

      const first = instance.webSocketMessage(
        roomClient,
        clientCandidate(firstTicket),
      );
      const second = instance.webSocketMessage(
        roomClient,
        clientCandidate(ticket(62)),
      );
      await vi.waitFor(() => expect(digestCalls).toBe(1));
      releaseDigest?.();
      await Promise.all([first, second]);
      expect(digestCalls).toBe(1);
    });

    await expect(offered).resolves.toMatchObject({ ticket: firstTicket });
    await expect(clientClosed).resolves.toMatchObject(PROTOCOL_CLOSE);
    closeForCleanup(server);
  });

  it("does not relabel a terminal client after delayed digest work", async () => {
    const stub = room("delayed-client-terminal-outcome");
    const server = await connect(stub, "server");
    const client = await connect(stub, "client");
    const summaries = await recordTerminalSummaries(stub);
    const serverClosed = nextClose(server, "delayed digest server close");
    const clientClosed = nextClose(client, "delayed digest client close");

    await runInDurableObject(stub, async (instance, state) => {
      const roomClient = state.getWebSockets("client")[0];
      const roomServer = state.getWebSockets("server")[0];
      if (roomClient === undefined || roomServer === undefined) {
        throw new Error("Delayed digest sockets are absent");
      }
      let releaseDigest: (() => void) | undefined;
      const digestGate = new Promise<void>((resolve) => {
        releaseDigest = resolve;
      });
      let digestCalls = 0;
      Reflect.set(instance, "digestTicket", async (rawTicket: string) => {
        digestCalls += 1;
        await digestGate;
        return sha256Hex(rawTicket);
      });
      const serialize = roomClient.serializeAttachment.bind(roomClient);
      let writes = 0;
      const serializeSpy = vi.spyOn(roomClient, "serializeAttachment")
        .mockImplementation((value) => {
          writes += 1;
          if (writes === 2) {
            throw new Error("Injected delayed metric-marker failure");
          }
          serialize(value);
        });

      try {
        const pending = instance.webSocketMessage(
          roomClient,
          clientCandidate(ticket(98)),
        );
        await vi.waitFor(() => expect(digestCalls).toBe(1));
        await instance.webSocketError(
          roomServer,
          new Error("Injected concurrent server failure"),
        );
        releaseDigest?.();
        await pending;
      } finally {
        releaseDigest?.();
        serializeSpy.mockRestore();
      }
    });

    await expect(serverClosed).resolves.toMatchObject(INTERNAL_CLOSE);
    await expect(clientClosed).resolves.toMatchObject(INTERNAL_CLOSE);
    expect(summaries).toEqual([
      expect.objectContaining({ outcome: "internal_error" }),
    ]);
    closeForCleanup(client, server);
  });

  it("does not let completion overtake a pending server candidate digest", async () => {
    const stub = room("server-message-fifo");
    const server = await connect(stub, "server");
    const client = await connect(stub, "client");
    const selectedTicket = ticket(63);
    const offered = nextJson(server, "FIFO server offer");
    client.send(clientCandidate(selectedTicket));
    await offered;

    const frames = nextMessages(client, 2, "FIFO server frames");
    const clientClosed = nextClose(client, "FIFO server completion close");
    await runInDurableObject(stub, async (instance: RendezvousRoom, state) => {
      const roomServer = state.getWebSockets("server")[0];
      if (roomServer === undefined) {
        throw new Error("FIFO server room socket is absent");
      }
      let releaseDigest: (() => void) | undefined;
      const digestGate = new Promise<void>((resolve) => {
        releaseDigest = resolve;
      });
      let digestCalls = 0;
      Reflect.set(instance, "digestTicket", async (rawTicket: string) => {
        digestCalls += 1;
        if (digestCalls === 1) {
          await digestGate;
        }
        return sha256Hex(rawTicket);
      });

      const candidate = instance.webSocketMessage(
        roomServer,
        serverCandidate(selectedTicket),
      );
      const completion = instance.webSocketMessage(
        roomServer,
        complete(selectedTicket),
      );
      await vi.waitFor(() => expect(digestCalls).toBe(1));
      releaseDigest?.();
      await Promise.all([candidate, completion]);
      expect(digestCalls).toBe(2);
    });

    expect((await frames).map((frame) => JSON.parse(frame))).toEqual([
      JSON.parse(serverCandidate(selectedTicket)),
      JSON.parse(complete(selectedTicket)),
    ]);
    await expect(clientClosed).resolves.toMatchObject(COMPLETE_CLOSE);
    closeForCleanup(server);
  });

  it("bounds queued server work before starting additional digests", async () => {
    const stub = room("bounded-server-message-queue");
    const server = await connect(stub, "server");
    const client = await connect(stub, "client");
    const selectedTicket = ticket(66);
    const offered = nextJson(server, "bounded queue offer");
    client.send(clientCandidate(selectedTicket));
    await offered;

    const serverClosed = nextClose(server, "bounded queue server close");
    const clientClosed = nextClose(client, "bounded queue client close");
    await runInDurableObject(stub, async (instance: RendezvousRoom, state) => {
      const roomServer = state.getWebSockets("server")[0];
      if (roomServer === undefined) {
        throw new Error("Bounded queue server room socket is absent");
      }
      let releaseDigest: (() => void) | undefined;
      const digestGate = new Promise<void>((resolve) => {
        releaseDigest = resolve;
      });
      let digestCalls = 0;
      Reflect.set(instance, "digestTicket", async (rawTicket: string) => {
        digestCalls += 1;
        await digestGate;
        return sha256Hex(rawTicket);
      });

      const first = instance.webSocketMessage(
        roomServer,
        serverCandidate(selectedTicket),
      );
      await vi.waitFor(() => expect(digestCalls).toBe(1));

      // 16 active sessions * 15 valid server frames, plus one queued protocol
      // violation, is the reviewed hard pending-work ceiling. The next event
      // closes synchronously and none of the queued closures starts WebCrypto.
      const queued = Array.from({ length: 241 }, () =>
        instance.webSocketMessage(
          roomServer,
          serverCandidate(selectedTicket),
        )
      );
      releaseDigest?.();
      await Promise.all([first, ...queued]);
      expect(digestCalls).toBe(1);
    });

    await expect(serverClosed).resolves.toMatchObject(PROTOCOL_CLOSE);
    await expect(clientClosed).resolves.toMatchObject(PROTOCOL_CLOSE);
  });

  it.each([
    ["oversized text", "x".repeat(1_000_000)],
    ["large binary", new ArrayBuffer(1_000_000)],
  ] as const)(
    "rejects %s before the pending FIFO retains it",
    async (_label, oversizedFrame) => {
      const stub = room("oversized-pending-frame");
      const server = await connect(stub, "server");
      const client = await connect(stub, "client");
      const selectedTicket = ticket(67);
      const offered = nextJson(server, "oversized queue offer");
      client.send(clientCandidate(selectedTicket));
      await offered;

      const serverClosed = nextClose(server, "oversized queue server close");
      const clientClosed = nextClose(client, "oversized queue client close");
      await runInDurableObject(stub, async (instance: RendezvousRoom, state) => {
        const roomServer = state.getWebSockets("server")[0];
        if (roomServer === undefined) {
          throw new Error("Oversized queue server room socket is absent");
        }
        let releaseDigest: (() => void) | undefined;
        const digestGate = new Promise<void>((resolve) => {
          releaseDigest = resolve;
        });
        let digestCalls = 0;
        Reflect.set(instance, "digestTicket", async (rawTicket: string) => {
          digestCalls += 1;
          await digestGate;
          return sha256Hex(rawTicket);
        });

        const first = instance.webSocketMessage(
          roomServer,
          serverCandidate(selectedTicket),
        );
        await vi.waitFor(() => expect(digestCalls).toBe(1));
        const rejected = instance.webSocketMessage(
          roomServer,
          oversizedFrame,
        );
        const queues = Reflect.get(instance, "messageQueues") as WeakMap<
          WebSocket,
          { pending: number }
        >;
        expect(queues.get(roomServer)?.pending).toBe(1);
        await rejected;
        releaseDigest?.();
        await first;
        expect(digestCalls).toBe(1);
      });

      await expect(serverClosed).resolves.toMatchObject(PROTOCOL_CLOSE);
      await expect(clientClosed).resolves.toMatchObject(PROTOCOL_CLOSE);
    },
  );

  it("delivers one completion before a normal client close", async () => {
    const stub = room("single-completion");
    const server = await connect(stub, "server");
    const client = await connect(stub, "client");
    const selectedTicket = ticket(7);
    const offered = nextJson(server, "completion offer");
    client.send(clientCandidate(selectedTicket));
    await offered;

    const attachmentWrites: unknown[] = [];
    let restoreSerialize = (): void => {};
    await runInDurableObject(stub, (_instance, state) => {
      const roomClient = state.getWebSockets("client")[0];
      if (roomClient === undefined) {
        throw new Error("Completion client room socket is absent");
      }
      const serialize = roomClient.serializeAttachment.bind(roomClient);
      const spy = vi.spyOn(roomClient, "serializeAttachment")
        .mockImplementation((value) => {
          attachmentWrites.push(structuredClone(value));
          serialize(value);
        });
      restoreSerialize = (): void => spy.mockRestore();
    });

    try {
      const completed = nextJson(client, "completion message");
      const clientClosed = nextClose(client, "completion client close");
      server.send(complete(selectedTicket));
      expect(await completed).toEqual({
        type: "complete",
        ticket: selectedTicket,
      });
      await expect(clientClosed).resolves.toMatchObject(COMPLETE_CLOSE);
      expect(attachmentWrites.length).toBeGreaterThan(0);
      expect(attachmentWrites.every(
        (stored) => decodeRendezvousAttachment(stored) !== null,
      )).toBe(true);
    } finally {
      restoreSerialize();
    }

    const serverClosed = nextClose(server, "duplicate completion server close");
    server.send(complete(selectedTicket));
    await expect(serverClosed).resolves.toMatchObject(PROTOCOL_CLOSE);
  });

  it("reports a failed completion delivery as an internal error", async () => {
    const stub = room("completion-send-failure");
    const server = await connect(stub, "server");
    const client = await connect(stub, "client");
    const summaries = await recordTerminalSummaries(stub);
    const selectedTicket = ticket(75);
    const offered = nextJson(server, "failed completion offer");
    client.send(clientCandidate(selectedTicket));
    await offered;

    let restoreSend = (): void => {};
    await runInDurableObject(stub, (_instance, state) => {
      const roomClient = state.getWebSockets("client")[0];
      if (roomClient === undefined) {
        throw new Error("Completion send-failure client room socket is absent");
      }
      const send = vi.spyOn(roomClient, "send").mockImplementation(() => {
        throw new Error("Injected client completion send failure");
      });
      restoreSend = (): void => send.mockRestore();
    });

    try {
      const closed = nextClose(client, "failed completion client close");
      server.send(complete(selectedTicket));
      await expect(closed).resolves.toMatchObject(INTERNAL_CLOSE);
      expect(summaries).toEqual([
        expect.objectContaining({
          outcome: "internal_error",
          clientFramesAccepted: 1,
          serverFramesMatched: 1,
          framesForwarded: 1,
        }),
      ]);
      expect(summaries).not.toContainEqual(
        expect.objectContaining({ outcome: "completed" }),
      );
    } finally {
      restoreSend();
      closeForCleanup(client, server);
    }
  });

  it.each([
    ["malformed JSON", "null"],
    ["unsupported fields", JSON.stringify({
      type: "client_candidate",
      host: "192.0.2.1",
      port: 1_730,
      ticket: ticket(8),
      extra: true,
    })],
    ["an oversized text frame", "x".repeat(513)],
    ["a binary frame", new Uint8Array([1, 2, 3]).buffer],
  ] as const)("closes a client that sends %s", async (_label, frame) => {
    const stub = room("invalid-client-frame");
    const server = await connect(stub, "server");
    const client = await connect(stub, "client");
    try {
      const closed = nextClose(client, "invalid client frame close");
      client.send(frame);
      await expect(closed).resolves.toMatchObject(PROTOCOL_CLOSE);
      expect(server.readyState).toBe(1);
    } finally {
      closeForCleanup(client, server);
    }
  });
});

describe("RendezvousRoom terminal metrics", () => {
  it("emits one completed summary with the accepted work totals", async () => {
    const stub = room("completed-terminal-metric");
    const server = await connect(stub, "server");
    const client = await connect(stub, "client");
    const summaries = await recordTerminalSummaries(stub);
    const selectedTicket = ticket(80);
    try {
      const offered = nextMessage(server, "metric completion offer");
      client.send(clientCandidate(selectedTicket));
      await offered;

      const completed = nextMessage(client, "metric completion frame");
      const closed = nextClose(client, "metric completion close");
      server.send(complete(selectedTicket));
      await completed;
      await expect(closed).resolves.toMatchObject(COMPLETE_CLOSE);

      expect(summaries).toEqual([
        expect.objectContaining({
          outcome: "completed",
          clientFramesAccepted: 1,
          serverFramesMatched: 1,
          framesForwarded: 2,
        }),
      ]);
    } finally {
      closeForCleanup(client, server);
    }
  });

  it("emits one protocol summary even if teardown is delivered again", async () => {
    const stub = room("protocol-terminal-metric");
    const server = await connect(stub, "server");
    const client = await connect(stub, "client");
    const summaries = await recordTerminalSummaries(stub);
    let roomClient: WebSocket | undefined;
    await runInDurableObject(stub, (_instance, state) => {
      roomClient = state.getWebSockets("client")[0];
    });
    if (roomClient === undefined) {
      throw new Error("Metric test client room socket is absent");
    }
    const capturedRoomClient = roomClient;
    try {
      const closed = nextClose(client, "metric protocol close");
      client.send("null");
      await expect(closed).resolves.toMatchObject(PROTOCOL_CLOSE);

      await runInDurableObject(stub, (instance: RendezvousRoom) =>
        instance.webSocketClose(
          capturedRoomClient,
          PROTOCOL_CLOSE.code,
          PROTOCOL_CLOSE.reason,
          true,
        )
      );
      expect(summaries).toEqual([
        expect.objectContaining({
          outcome: "protocol_error",
          clientFramesAccepted: 0,
          serverFramesMatched: 0,
          framesForwarded: 0,
          signalBytes: 0,
        }),
      ]);
    } finally {
      closeForCleanup(client, server);
    }
  });

  it("emits one expiry summary from the hibernation-safe alarm", async () => {
    const stub = room("expiry-terminal-metric");
    const now = 2_100_000_000_000;
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(now);
    let server: WebSocket | undefined;
    let client: WebSocket | undefined;
    try {
      server = await connect(stub, "server");
      client = await connect(stub, "client");
      const summaries = await recordTerminalSummaries(stub);
      dateNow.mockReturnValue(now + 15_000);

      const closed = nextClose(client, "metric expiry close");
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      await expect(closed).resolves.toMatchObject(EXPIRED_CLOSE);
      expect(summaries).toEqual([
        expect.objectContaining({
          outcome: "session_expired",
          durationMs: 15_000,
        }),
      ]);
    } finally {
      closeForCleanup(...[client, server].filter(
        (socket): socket is WebSocket => socket !== undefined,
      ));
      dateNow.mockRestore();
    }
  });

  it("distinguishes server loss from server replacement", async () => {
    const unavailableStub = room("unavailable-terminal-metric");
    const unavailableServer = await connect(unavailableStub, "server");
    const unavailableClient = await connect(unavailableStub, "client");
    const unavailableSummaries = await recordTerminalSummaries(
      unavailableStub,
    );
    const unavailableClose = nextClose(
      unavailableClient,
      "metric server-unavailable close",
    );
    unavailableServer.close(1_000, "Metric test server disconnect");
    await expect(unavailableClose).resolves.toMatchObject(
      SERVER_UNAVAILABLE_CLOSE,
    );
    expect(unavailableSummaries).toEqual([
      expect.objectContaining({ outcome: "server_unavailable" }),
    ]);

    const replacedStub = room("replaced-terminal-metric");
    const replacedServer = await connect(replacedStub, "server");
    const replacedClient = await connect(replacedStub, "client");
    const replacedSummaries = await recordTerminalSummaries(replacedStub);
    const replacedClientClose = nextClose(
      replacedClient,
      "metric server-replaced client close",
    );
    const replacedServerClose = nextClose(
      replacedServer,
      "metric server-replaced control close",
    );
    const replacement = await connect(replacedStub, "server");
    await expect(replacedClientClose).resolves.toMatchObject(REPLACED_CLOSE);
    await expect(replacedServerClose).resolves.toMatchObject(REPLACED_CLOSE);
    expect(replacedSummaries).toEqual([
      expect.objectContaining({ outcome: "server_replaced" }),
    ]);
    closeForCleanup(
      unavailableClient,
      unavailableServer,
      replacedClient,
      replacedServer,
      replacement,
    );
  });

  it("records direct disconnect and WebSocket-error outcomes", async () => {
    const disconnectedStub = room("disconnected-terminal-metric");
    const disconnectedServer = await connect(disconnectedStub, "server");
    const disconnectedClient = await connect(disconnectedStub, "client");
    const disconnectedSummaries = await recordTerminalSummaries(
      disconnectedStub,
    );
    disconnectedClient.close(1_000, "Metric test client disconnect");
    await vi.waitFor(() => expect(disconnectedSummaries).toEqual([
      expect.objectContaining({ outcome: "client_disconnected" }),
    ]));

    const errorStub = room("internal-terminal-metric");
    const errorServer = await connect(errorStub, "server");
    const errorClient = await connect(errorStub, "client");
    const errorSummaries = await recordTerminalSummaries(errorStub);
    const errorClose = nextClose(errorClient, "metric WebSocket error close");
    await runInDurableObject(errorStub, async (
      instance: RendezvousRoom,
      state,
    ) => {
      const roomClient = state.getWebSockets("client")[0];
      if (roomClient === undefined) {
        throw new Error("Metric WebSocket-error room client is absent");
      }
      await instance.webSocketError(
        roomClient,
        new Error("Injected peer-controlled error"),
      );
    });
    await expect(errorClose).resolves.toMatchObject(INTERNAL_CLOSE);
    expect(errorSummaries).toEqual([
      expect.objectContaining({ outcome: "internal_error" }),
    ]);
    closeForCleanup(
      disconnectedClient,
      disconnectedServer,
      errorClient,
      errorServer,
    );
  });

  it("retries an undurable metric marker without relabeling after eviction", async () => {
    const stub = room("undurable-terminal-metric-marker");
    const server = await connect(stub, "server");
    const client = await connect(stub, "client");
    const selectedTicket = ticket(86);
    const offered = nextMessage(server, "undurable metric offer");
    client.send(clientCandidate(selectedTicket));
    await offered;

    const beforeEviction = await recordTerminalSummaries(stub);
    await runInDurableObject(stub, (_instance, state) => {
      const roomClient = state.getWebSockets("client")[0];
      if (roomClient === undefined) {
        throw new Error("Undurable-metric room client is absent");
      }
      const serialize = roomClient.serializeAttachment.bind(roomClient);
      let writes = 0;
      vi.spyOn(roomClient, "serializeAttachment").mockImplementation((value) => {
        writes += 1;
        if (writes === 2) {
          throw new Error("Injected terminal metric-marker write failure");
        }
        serialize(value);
      });
      vi.spyOn(roomClient, "close").mockImplementationOnce(() => {
        throw new Error("Injected terminal transport-close failure");
      });
    });
    client.send(clientCandidate(ticket(87)));
    await vi.waitFor(async () => {
      const stored = await runInDurableObject(stub, (_instance, state) =>
        state.getWebSockets("client")[0]?.deserializeAttachment() as
          | Record<string, unknown>
          | null
          | undefined
      );
      expect(stored).toMatchObject({
        s: 2,
        t: null,
        d: null,
        m: false,
        y: terminalOutcomeCode("protocol_error"),
      });
    });
    expect(beforeEviction).toEqual([]);

    await evictDurableObject(stub);
    const afterEviction = await recordTerminalSummaries(stub);
    await runInDurableObject(stub, async (instance, state) => {
      const roomClient = state.getWebSockets("client")[0];
      if (roomClient === undefined) {
        throw new Error("Reconstructed undurable-metric client is absent");
      }
      await instance.webSocketError(
        roomClient,
        new Error("Injected post-reconstruction error"),
      );
      expect(roomClient.deserializeAttachment()).toMatchObject({
        s: 2,
        m: true,
        y: terminalOutcomeCode("protocol_error"),
      });
    });
    expect(beforeEviction).toEqual([]);
    expect(afterEviction).toEqual([
      expect.objectContaining({ outcome: "protocol_error" }),
    ]);
    closeForCleanup(client, server);
  });

  it("preserves the original outcome when terminal writes fail before close", async () => {
    const stub = room("terminal-write-failure-outcome");
    const server = await connect(stub, "server");
    const client = await connect(stub, "client");
    const selectedTicket = ticket(89);
    const offered = nextMessage(server, "terminal-write failure offer");
    client.send(clientCandidate(selectedTicket));
    await offered;
    const summaries = await recordTerminalSummaries(stub);
    const attachmentWrites: unknown[] = [];

    await runInDurableObject(stub, (_instance, state) => {
      const roomClient = state.getWebSockets("client")[0];
      if (roomClient === undefined) {
        throw new Error("Terminal-write failure client is absent");
      }
      const serialize = roomClient.serializeAttachment.bind(roomClient);
      let writes = 0;
      vi.spyOn(roomClient, "serializeAttachment").mockImplementation((value) => {
        attachmentWrites.push(structuredClone(value));
        writes += 1;
        if (writes <= 2) {
          throw new Error("Injected terminal attachment write failure");
        }
        serialize(value);
      });
    });

    const closed = nextClose(client, "terminal-write protocol close");
    client.send(clientCandidate(ticket(90)));
    await expect(closed).resolves.toMatchObject(PROTOCOL_CLOSE);
    await vi.waitFor(() => expect(summaries).toEqual([
      expect.objectContaining({ outcome: "protocol_error" }),
    ]));
    expect(attachmentWrites.at(-1)).toMatchObject({
      s: 2,
      m: true,
      y: terminalOutcomeCode("protocol_error"),
    });
    closeForCleanup(client, server);
  });

  it("retries an unresolved teardown without relabeling its outcome", async () => {
    const stub = room("unresolved-client-teardown");
    const server = await connect(stub, "server");
    const client = await connect(stub, "client");
    const selectedTicket = ticket(91);
    const offered = nextMessage(server, "unresolved teardown offer");
    client.send(clientCandidate(selectedTicket));
    await offered;
    const summaries = await recordTerminalSummaries(stub);
    const closed = nextClose(client, "retried protocol close");

    await runInDurableObject(stub, async (instance, state) => {
      const roomClient = state.getWebSockets("client")[0];
      if (roomClient === undefined) {
        throw new Error("Unresolved teardown client is absent");
      }
      const serialize = vi.spyOn(roomClient, "serializeAttachment")
        .mockImplementation(() => {
          throw new Error("Injected unresolved attachment write failure");
        });
      const close = vi.spyOn(roomClient, "close").mockImplementation(() => {
        throw new Error("Injected unresolved transport close failure");
      });
      try {
        await expect(instance.webSocketMessage(
          roomClient,
          clientCandidate(ticket(92)),
        )).rejects.toMatchObject({
          name: "RendezvousTeardownIntegrityError",
          message: "Rendezvous client teardown was not persisted",
        });
      } finally {
        close.mockRestore();
        serialize.mockRestore();
      }

      await expect(instance.alarm()).resolves.toBeUndefined();
      expect(roomClient.deserializeAttachment()).toMatchObject({
        s: 2,
        t: null,
        d: null,
        m: true,
        y: terminalOutcomeCode("protocol_error"),
      });
    });

    await expect(closed).resolves.toMatchObject(PROTOCOL_CLOSE);
    expect(summaries).toEqual([
      expect.objectContaining({ outcome: "protocol_error" }),
    ]);
    closeForCleanup(client, server);
  });

  it("quarantines unresolved teardown state across instance reset", async () => {
    const stub = room("reset-during-unresolved-teardown");
    const server = await connect(stub, "server");
    const client = await connect(stub, "client");
    const selectedTicket = ticket(96);
    const offered = nextMessage(server, "reset teardown offer");
    client.send(clientCandidate(selectedTicket));
    await offered;

    await runInDurableObject(stub, async (instance, state) => {
      const roomClient = state.getWebSockets("client")[0];
      if (roomClient === undefined) {
        throw new Error("Reset teardown client is absent");
      }
      const serialize = vi.spyOn(roomClient, "serializeAttachment")
        .mockImplementation(() => {
          throw new Error("Injected reset persistence failure");
        });
      const close = vi.spyOn(roomClient, "close").mockImplementation(() => {
        throw new Error("Injected reset close failure");
      });
      try {
        await expect(instance.webSocketMessage(
          roomClient,
          clientCandidate(ticket(97)),
        )).rejects.toMatchObject({
          name: "RendezvousTeardownIntegrityError",
        });
        expect(await state.storage.get(
          "rendezvous:teardown-recovery-required",
        )).toBe(true);
      } finally {
        close.mockRestore();
        serialize.mockRestore();
      }
    });

    const serverClosed = nextClose(server, "quarantined server close");
    const clientClosed = nextClose(client, "quarantined client close");
    await evictDurableObject(stub);
    await expectFixedError(
      await stub.fetch(roomRequest("client")),
      503,
      "Rendezvous server unavailable\n",
      "5",
    );
    await expect(serverClosed).resolves.toMatchObject(INTERNAL_CLOSE);
    await expect(clientClosed).resolves.toMatchObject(INTERNAL_CLOSE);
    expect(await currentControlIds(stub)).toEqual([]);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.get(
        "rendezvous:teardown-recovery-required",
      )).toBeUndefined();
    });
    closeForCleanup(client, server);
  });

  it("suppresses guessed metrics for a reconstructed local close", async () => {
    const stub = room("reconstructed-local-close");
    const server = await connect(stub, "server");
    const client = await connect(stub, "client");
    const selectedTicket = ticket(93);
    const offered = nextMessage(server, "reconstructed close offer");
    client.send(clientCandidate(selectedTicket));
    await offered;
    await evictDurableObject(stub);
    const summaries = await recordTerminalSummaries(stub);

    await runInDurableObject(stub, async (instance, state) => {
      const roomClient = state.getWebSockets("client")[0];
      if (roomClient === undefined) {
        throw new Error("Reconstructed local-close client is absent");
      }
      await instance.webSocketClose(
        roomClient,
        PROTOCOL_CLOSE.code,
        PROTOCOL_CLOSE.reason,
        true,
      );
      expect(roomClient.deserializeAttachment()).toMatchObject({
        s: 2,
        t: null,
        d: null,
        m: true,
        y: terminalOutcomeCode("protocol_error"),
      });
    });
    expect(summaries).toEqual([]);
    closeForCleanup(client, server);
  });

  it("does not emit a terminal point for a rejected client upgrade", async () => {
    const stub = room("rejected-terminal-metric");
    const summaries = await recordTerminalSummaries(stub);

    await expectFixedError(
      await stub.fetch(roomRequest("client")),
      503,
      "Rendezvous server unavailable\n",
      "5",
    );
    expect(summaries).toEqual([]);
  });
});

describe("RendezvousRoom hibernation, expiry, and privacy", () => {
  it("reschedules an early alarm and expires the client at 15 seconds", async () => {
    const stub = room("client-expiry-alarm");
    const now = 2_000_000_000_000;
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(now);
    let server: WebSocket | undefined;
    let client: WebSocket | undefined;
    try {
      server = await connect(stub, "server");
      client = await connect(stub, "client");
      expect(await admissionCount(stub)).toBe(1);

      await evictDurableObject(stub);
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      expect(client.readyState).toBe(1);
      expect(await runInDurableObject(stub, (_instance, state) =>
        state.storage.getAlarm()
      )).toBe(now + 15_000);

      dateNow.mockReturnValue(now + 15_000);
      await evictDurableObject(stub);
      const closed = nextClose(client, "expired client close");
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      await expect(closed).resolves.toMatchObject(EXPIRED_CLOSE);
      expect(await admissionCount(stub)).toBe(1);
      expect(await runInDurableObject(stub, (_instance, state) =>
        state.storage.getAlarm()
      )).toBe(now + RENDEZVOUS_ROLLING_WINDOW_MS);
    } finally {
      closeForCleanup(...[client, server].filter(
        (socket): socket is WebSocket => socket !== undefined,
      ));
      dateNow.mockRestore();
    }
  });

  it("preserves a terminal close retry across an unrelated close event", async () => {
    const stub = room("terminal-client-expiry-alarm");
    const now = 2_200_000_000_000;
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(now);
    let server: WebSocket | undefined;
    let client: WebSocket | undefined;
    let unrelatedClient: WebSocket | undefined;
    try {
      server = await connect(stub, "server");
      client = await connect(stub, "client");
      dateNow.mockReturnValue(now + 2_000);
      unrelatedClient = await connect(stub, "client");
      await runInDurableObject(stub, (_instance, state) => {
        const roomClient = state.getWebSockets("client").find((socket) => {
          const stored = socket.deserializeAttachment() as
            | { readonly o?: unknown }
            | null;
          return stored?.o === now;
        });
        const attachment = roomClient?.deserializeAttachment() as
          | Record<string, unknown>
          | null
          | undefined;
        if (roomClient === undefined || attachment === null ||
          attachment === undefined) {
          throw new Error("Terminal alarm client attachment is absent");
        }
        // Model a process failure after the terminal transition and summary
        // were persisted but before WebSocket.close() completed.
        roomClient.serializeAttachment({
          ...attachment,
          s: 2,
          p: 6,
          m: true,
          y: terminalOutcomeCode("internal_error"),
        });
      });
      await evictDurableObject(stub);
      dateNow.mockReturnValue(now + 15_000);
      const unrelatedClosed = nextClose(
        unrelatedClient,
        "unrelated client close",
      );

      await runInDurableObject(stub, async (instance, state) => {
        const sockets = state.getWebSockets("client");
        const terminal = sockets.find((socket) => {
          const stored = socket.deserializeAttachment() as
            | { readonly s?: unknown }
            | null;
          return stored?.s === 2;
        });
        const unrelated = sockets.find((socket) => socket !== terminal);
        if (terminal === undefined || unrelated === undefined) {
          throw new Error("Terminal retry test sockets are absent");
        }

        const close = vi.spyOn(terminal, "close").mockImplementation(() => {
          throw new Error("Injected terminal close failure");
        });
        await instance.alarm();
        close.mockRestore();
        expect(await state.storage.getAlarm()).toBe(now + 16_000);

        // Model an unrelated close callback arriving before that retry. It
        // must not delete or move the terminal socket's overdue alarm.
        unrelated.close(1_000, "Test close");
        await instance.webSocketClose(unrelated, 1_000, "Test close", true);
        expect(unrelated.readyState).not.toBe(WebSocket.OPEN);
        expect(await state.storage.getAlarm()).toBe(now + 16_000);
      });
      await expect(unrelatedClosed).resolves.toMatchObject({
        code: 1_000,
        reason: "Test close",
      });

      const closed = nextClose(client, "retried terminal client close");
      dateNow.mockReturnValue(now + 16_000);
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      await expect(closed).resolves.toMatchObject(INTERNAL_CLOSE);
      expect(await runInDurableObject(stub, (_instance, state) =>
        state.storage.getAlarm()
      )).toBe(now + RENDEZVOUS_ROLLING_WINDOW_MS);
    } finally {
      closeForCleanup(...[client, unrelatedClient, server].filter(
        (socket): socket is WebSocket => socket !== undefined,
      ));
      dateNow.mockRestore();
    }
  });

  it("caps persistent terminal close failures with fixed backoff", async () => {
    const stub = room("terminal-close-retry-cap");
    const now = 2_300_000_000_000;
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(now);
    let server: WebSocket | undefined;
    let client: WebSocket | undefined;
    try {
      server = await connect(stub, "server");
      client = await connect(stub, "client");
      await runInDurableObject(stub, async (instance, state) => {
        const roomClient = state.getWebSockets("client")[0];
        const attachment = roomClient?.deserializeAttachment() as
          | Record<string, unknown>
          | null
          | undefined;
        if (roomClient === undefined || attachment === null ||
          attachment === undefined) {
          throw new Error("Retry-cap client attachment is absent");
        }
        roomClient.serializeAttachment({
          ...attachment,
          s: 2,
          p: 6,
          m: true,
          y: terminalOutcomeCode("internal_error"),
        });
        const close = vi.spyOn(roomClient, "close").mockImplementation(() => {
          throw new Error("Injected persistent close failure");
        });
        const attempts = [
          [now + 15_000, now + 16_000],
          [now + 16_000, now + 18_000],
          [now + 18_000, now + 22_000],
          [now + 22_000, now + RENDEZVOUS_ROLLING_WINDOW_MS],
        ] as const;
        for (const [attemptAt, nextAlarm] of attempts) {
          dateNow.mockReturnValue(attemptAt);
          await instance.alarm();
          expect(await state.storage.getAlarm()).toBe(nextAlarm);
        }
        const stored = roomClient.deserializeAttachment() as {
          readonly k?: unknown;
        } | null;
        expect(stored?.k).toBe(4);
        close.mockRestore();
      });
      expect(client.readyState).toBe(WebSocket.OPEN);
    } finally {
      closeForCleanup(...[client, server].filter(
        (socket): socket is WebSocket => socket !== undefined,
      ));
      dateNow.mockRestore();
    }
  });

  it("uses bounded platform retries when close state cannot persist", async () => {
    const stub = room("terminal-close-persistence-failure");
    const now = 2_400_000_000_000;
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(now);
    let server: WebSocket | undefined;
    let client: WebSocket | undefined;
    try {
      server = await connect(stub, "server");
      client = await connect(stub, "client");
      await runInDurableObject(stub, async (instance, state) => {
        const roomClient = state.getWebSockets("client")[0];
        const attachment = roomClient?.deserializeAttachment() as
          | Record<string, unknown>
          | null
          | undefined;
        if (roomClient === undefined || attachment === null ||
          attachment === undefined) {
          throw new Error("Undurable-retry client attachment is absent");
        }
        roomClient.serializeAttachment({
          ...attachment,
          s: 2,
          p: 6,
          m: true,
          y: terminalOutcomeCode("internal_error"),
        });
        dateNow.mockReturnValue(now + 15_000);
        const serialize = vi.spyOn(
          roomClient,
          "serializeAttachment",
        ).mockImplementation(() => {
          throw new Error("Injected retry-state persistence failure");
        });
        const close = vi.spyOn(roomClient, "close").mockImplementation(() => {
          throw new Error("Injected terminal close failure");
        });
        const setAlarm = vi.spyOn(state.storage, "setAlarm");

        await expect(instance.alarm()).rejects.toThrow(
          "Rendezvous terminal teardown state was not persisted",
        );
        expect(serialize).toHaveBeenCalledTimes(1);
        expect(close).toHaveBeenCalledTimes(1);
        expect(setAlarm).not.toHaveBeenCalled();
        expect(roomClient.deserializeAttachment()).toMatchObject({
          k: 0,
          s: 2,
        });

        setAlarm.mockRestore();
        close.mockRestore();
        serialize.mockRestore();
      });
    } finally {
      closeForCleanup(...[client, server].filter(
        (socket): socket is WebSocket => socket !== undefined,
      ));
      dateNow.mockRestore();
    }
  });

  it("restores ticket routing from attachments after Durable Object eviction", async () => {
    const stub = room("hibernation-restore");
    const server = await connect(stub, "server");
    const client = await connect(stub, "client");
    const selectedTicket = ticket(9);

    const offered = nextJson(server, "post-eviction offer");
    client.send(clientCandidate(selectedTicket));
    expect(await offered).toMatchObject({
      type: "client_candidate",
      ticket: selectedTicket,
    });

    await evictDurableObject(stub);
    const relayed = nextJson(client, "post-eviction response");
    server.send(serverCandidate(selectedTicket));
    expect(await relayed).toMatchObject({
      type: "server_candidate",
      ticket: selectedTicket,
    });
    closeForCleanup(client, server);
  });

  it("keeps 50 live ticket entries within the hibernation attachment ceiling", async () => {
    const stub = room("maximum-ticket-attachment");
    const server = await connect(stub, "server");
    const attachmentSize = await runInDurableObject(
      stub,
      (_instance, state) => {
        const socket = state.getWebSockets("server")[0];
        const attachment = socket?.deserializeAttachment() as
          | Record<string, unknown>
          | null
          | undefined;
        if (socket === undefined || attachment === null ||
          attachment === undefined) {
          throw new Error("Accepted server attachment is absent");
        }
        const now = Date.now();
        const tickets = Array.from({ length: 50 }, (_, index) => [
          ticket(100 + index),
          crypto.randomUUID(),
          now,
          now + 15_000,
          1,
          0,
          0,
          1,
          0,
          0,
          0,
        ]);
        const stored = { ...attachment, t: tickets };
        socket.serializeAttachment(stored);
        return {
          entries: tickets.length,
          bytes: new TextEncoder().encode(JSON.stringify(stored)).byteLength,
        };
      },
    );
    expect(attachmentSize.entries).toBe(50);
    expect(attachmentSize.bytes).toBeLessThanOrEqual(16_384);

    await evictDurableObject(stub);
    const client = await connect(stub, "client");
    closeForCleanup(client, server);
  });

  it("fails closed when a stored attachment has an extra field", async () => {
    const stub = room("extra-attachment-field");
    const server = await connect(stub, "server");
    await runInDurableObject(stub, (_instance, state) => {
      const socket = state.getWebSockets("server")[0];
      const attachment = socket?.deserializeAttachment() as
        | Record<string, unknown>
        | null
        | undefined;
      if (socket === undefined || attachment === null ||
        attachment === undefined) {
        throw new Error("Accepted server attachment is absent");
      }
      socket.serializeAttachment({ ...attachment, extra: true });
    });

    const serverClosed = nextClose(server, "invalid attachment server close");
    await expectFixedError(
      await stub.fetch(roomRequest("client")),
      503,
      "Rendezvous server unavailable\n",
      "5",
    );
    await expect(serverClosed).resolves.toMatchObject(INTERNAL_CLOSE);
  });

  it("fails closed when a socket tag and attachment role disagree", async () => {
    const stub = room("attachment-role-mismatch");
    const server = await connect(stub, "server");
    const client = await connect(stub, "client");
    await runInDurableObject(stub, (_instance, state) => {
      const roomServer = state.getWebSockets("server")[0];
      const roomClient = state.getWebSockets("client")[0];
      const clientAttachment = roomClient?.deserializeAttachment();
      if (
        roomServer === undefined ||
        roomClient === undefined ||
        clientAttachment === null ||
        clientAttachment === undefined
      ) {
        throw new Error("Role-mismatch test attachment is absent");
      }
      roomServer.serializeAttachment(clientAttachment);
    });

    const serverClosed = nextClose(server, "role-mismatch server close");
    const clientClosed = nextClose(client, "role-mismatch client close");
    server.send(clientCandidate(ticket(70)));
    await expect(serverClosed).resolves.toMatchObject(INTERNAL_CLOSE);
    await expect(clientClosed).resolves.toMatchObject(INTERNAL_CLOSE);
  });

  it("rejects a legacy unversioned server attachment after hibernation", async () => {
    const stub = room("legacy-attachment");
    const server = await connect(stub, "server");
    await runInDurableObject(stub, (_instance, state) => {
      const socket = state.getWebSockets("server")[0];
      if (socket === undefined) {
        throw new Error("Accepted server is absent from the room");
      }
      socket.serializeAttachment({ role: "server", current: true });
    });
    await evictDurableObject(stub);

    await expectFixedError(
      await stub.fetch(roomRequest("client")),
      503,
      "Rendezvous server unavailable\n",
      "5",
    );
    closeForCleanup(server);
  });

  it("fails closed after reconstruction with a future SQLite schema", async () => {
    const stub = room("future-room-schema");
    const server = await connect(stub, "server");
    const client = await connect(stub, "client");
    const selectedTicket = ticket(76);
    const offered = nextJson(server, "future-schema client offer");
    client.send(clientCandidate(selectedTicket));
    await offered;
    const before = await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO _rendezvous_schema_migrations (version) VALUES (2)",
      );
      const roomClient = state.getWebSockets("client")[0];
      const attachment = roomClient?.deserializeAttachment() as
        | Record<string, unknown>
        | null
        | undefined;
      if (attachment === null || attachment === undefined) {
        throw new Error("Future-schema client attachment is absent");
      }
      return {
        attachment,
        count: state.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM rendezvous_admissions",
        ).one().count,
      };
    });
    expect(before.count).toBe(1);
    expect(before.attachment).toMatchObject({
      s: 1,
      t: selectedTicket,
      d: await sha256Hex(selectedTicket),
    });
    await evictDurableObject(stub);

    const serverClosed = nextClose(server, "future-schema server close");
    const clientClosed = nextClose(client, "future-schema client close");
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await expect(serverClosed).resolves.toMatchObject(INTERNAL_CLOSE);
    await expect(clientClosed).resolves.toMatchObject(INTERNAL_CLOSE);
    expect(await runInDurableObject(stub, (_instance, state) =>
      state.storage.getAlarm()
    )).toBeNull();
    await expectFixedError(
      await stub.fetch(roomRequest("client")),
      503,
      "Rendezvous room unavailable\n",
      "60",
    );
    closeForCleanup(client, server);
  });

  it("scrubs routing state when initialization fails before close succeeds", async () => {
    const stub = room("initialization-failure-scrub");
    const server = await connect(stub, "server");
    const client = await connect(stub, "client");
    const selectedTicket = ticket(77);
    const offered = nextJson(server, "initialization scrub offer");
    client.send(clientCandidate(selectedTicket));
    await offered;

    await runInDurableObject(stub, async (instance, state) => {
      const roomClient = state.getWebSockets("client")[0];
      const roomServer = state.getWebSockets("server")[0];
      if (roomClient === undefined || roomServer === undefined) {
        throw new Error("Initialization scrub sockets are absent");
      }
      const clientClose = vi.spyOn(roomClient, "close")
        .mockImplementation(() => {
          throw new Error("Injected initialization client close failure");
        });
      const serverClose = vi.spyOn(roomServer, "close")
        .mockImplementation(() => {
          throw new Error("Injected initialization server close failure");
        });
      try {
        Reflect.set(instance, "initializationFailed", true);
        await expect(instance.alarm()).resolves.toBeUndefined();
        expect(roomClient.deserializeAttachment()).toMatchObject({
          s: 2,
          t: null,
          d: null,
          y: terminalOutcomeCode("internal_error"),
          k: 0,
        });
        expect(roomServer.deserializeAttachment()).toMatchObject({
          u: false,
          t: [],
        });
        expect(await state.storage.getAlarm()).not.toBeNull();
      } finally {
        clientClose.mockRestore();
        serverClose.mockRestore();
      }
    });
    closeForCleanup(client, server);
  });

  it("uses bounded alarm retries when initialization state cannot be scrubbed", async () => {
    const stub = room("initialization-failure-double-failure");
    const server = await connect(stub, "server");
    const client = await connect(stub, "client");
    const selectedTicket = ticket(78);
    const offered = nextJson(server, "initialization double-failure offer");
    client.send(clientCandidate(selectedTicket));
    await offered;

    await runInDurableObject(stub, async (instance, state) => {
      const roomClient = state.getWebSockets("client")[0];
      if (roomClient === undefined) {
        throw new Error("Initialization double-failure client is absent");
      }
      const serialize = vi.spyOn(roomClient, "serializeAttachment")
        .mockImplementation(() => {
          throw new Error("Injected initialization persistence failure");
        });
      const close = vi.spyOn(roomClient, "close").mockImplementation(() => {
        throw new Error("Injected initialization close failure");
      });
      const setAlarm = vi.spyOn(state.storage, "setAlarm");
      try {
        Reflect.set(instance, "initializationFailed", true);
        await expect(instance.alarm()).rejects.toThrow(
          "Rendezvous initialization teardown was not persisted",
        );
        expect(setAlarm).not.toHaveBeenCalled();
        expect(roomClient.deserializeAttachment()).toMatchObject({
          s: 1,
          t: selectedTicket,
          d: await sha256Hex(selectedTicket),
          k: 0,
        });
      } finally {
        setAlarm.mockRestore();
        close.mockRestore();
        serialize.mockRestore();
      }
    });
    closeForCleanup(client, server);
  });

  it("reconciles an interrupted server replacement deterministically", async () => {
    const stub = room("interrupted-server-replacement");
    const oldServer = await connect(stub, "server");
    const oldClient = await connect(stub, "client");
    const replacementControlId = crypto.randomUUID();
    await injectCurrentServer(stub, replacementControlId, Date.now() + 1);

    const oldServerClosed = nextClose(oldServer, "reconciled old server close");
    const oldClientClosed = nextClose(oldClient, "reconciled old client close");
    const replacementClient = await connect(stub, "client");
    await expect(oldServerClosed).resolves.toMatchObject(REPLACED_CLOSE);
    await expect(oldClientClosed).resolves.toMatchObject(REPLACED_CLOSE);
    expect(await currentControlIds(stub)).toEqual([replacementControlId]);
    await runInDurableObject(stub, (_instance, state) => {
      for (const socket of state.getWebSockets("server")) {
        socket.close(1_000, "Test cleanup");
      }
    });
    closeForCleanup(
      oldClient,
      oldServer,
      replacementClient,
    );
  });

  it("reconciles every control in a three-way interrupted replacement", async () => {
    const stub = room("three-way-server-replacement");
    const original = await connect(stub, "server");
    const now = Date.now();
    const newestControlId = crypto.randomUUID();
    const fallbackControlId = crypto.randomUUID();
    await injectCurrentServer(
      stub,
      newestControlId,
      now + 2,
    );
    await injectCurrentServer(
      stub,
      fallbackControlId,
      now + 1,
    );
    let restoreFaults = (): void => {};
    await runInDurableObject(stub, (_instance, state) => {
      const faulted = state.getWebSockets("server").find((socket) => {
        const stored = socket.deserializeAttachment() as
          | { readonly c?: unknown }
          | null;
        return stored?.c === fallbackControlId;
      });
      if (faulted === undefined) {
        throw new Error("Three-way fallback control is absent");
      }
      const serialize = vi.spyOn(faulted, "serializeAttachment")
        .mockImplementation(() => {
          throw new Error("Injected fallback persistence failure");
        });
      const close = vi.spyOn(faulted, "close").mockImplementation(() => {
        throw new Error("Injected fallback close failure");
      });
      restoreFaults = () => {
        close.mockRestore();
        serialize.mockRestore();
      };
    });

    let client: WebSocket | null = null;
    try {
      client = await connect(stub, "client");
      expect(await currentControlIds(stub)).toEqual([fallbackControlId]);
    } finally {
      restoreFaults();
      await closeRoomServersForCleanup(stub);
      closeForCleanup(...[client, original].filter(
        (socket): socket is WebSocket => socket !== null,
      ));
    }
  });

  it("does not revive an older control when the deterministic winner departs", async () => {
    const stub = room("departed-replacement-winner");
    const oldServer = await connect(stub, "server");
    const oldClient = await connect(stub, "client");
    const replacementControlId = crypto.randomUUID();
    await injectCurrentServer(
      stub,
      replacementControlId,
      Date.now() + 1,
    );
    const oldServerClosed = nextClose(oldServer, "retired fallback server");
    const oldClientClosed = nextClose(oldClient, "winner-departed client");

    await disconnectInjectedServer(
      stub,
      replacementControlId,
      "Injected winner disconnect",
    );
    await expect(oldServerClosed).resolves.toMatchObject(
      SERVER_UNAVAILABLE_CLOSE,
    );
    await expect(oldClientClosed).resolves.toMatchObject(
      SERVER_UNAVAILABLE_CLOSE,
    );
    await evictDurableObject(stub);
    expect(await currentControlIds(stub)).toEqual([]);
    await expectFixedError(
      await stub.fetch(roomRequest("client")),
      503,
      "Rendezvous server unavailable\n",
      "5",
    );
    closeForCleanup(oldClient, oldServer);
  });

  it("keeps a newer control when an interrupted predecessor departs", async () => {
    const stub = room("departed-old-control");
    const oldServer = await connect(stub, "server");
    const oldClient = await connect(stub, "client");
    const replacementControlId = crypto.randomUUID();
    await injectCurrentServer(
      stub,
      replacementControlId,
      Date.now() + 1,
    );
    const oldClientClosed = nextClose(oldClient, "old-control client close");

    oldServer.close(1_000, "Injected predecessor disconnect");
    await expect(oldClientClosed).resolves.toMatchObject(REPLACED_CLOSE);
    expect(await currentControlIds(stub)).toEqual([replacementControlId]);
    const client = await connect(stub, "client");
    await runInDurableObject(stub, (_instance, state) => {
      const stored = state.getWebSockets("client")[0]
        ?.deserializeAttachment() as { readonly c?: unknown } | null;
      expect(stored?.c).toBe(replacementControlId);
    });
    await closeRoomServersForCleanup(stub);
    closeForCleanup(client, oldClient, oldServer);
  });

  it("fails closed when current servers share a control ID", async () => {
    const stub = room("duplicate-server-control-id");
    const server = await connect(stub, "server");
    const client = await connect(stub, "client");
    const [controlId] = await currentControlIds(stub);
    if (controlId === undefined) {
      throw new Error("Original server control ID is absent");
    }
    await injectCurrentServer(stub, controlId, Date.now() + 1);

    const serverClosed = nextClose(server, "duplicate-control server close");
    const clientClosed = nextClose(client, "duplicate-control client close");
    await expectFixedError(
      await stub.fetch(roomRequest("client")),
      503,
      "Rendezvous server unavailable\n",
      "5",
    );
    await expect(serverClosed).resolves.toMatchObject(INTERNAL_CLOSE);
    await expect(clientClosed).resolves.toMatchObject(INTERNAL_CLOSE);
    expect(await currentControlIds(stub)).toEqual([]);
    closeForCleanup(client, server);
  });

  it("does not let a delayed old-server close invalidate a replacement", async () => {
    const stub = room("delayed-server-close");
    const oldServer = await connect(stub, "server");
    let oldRoomSocket: WebSocket | undefined;
    await runInDurableObject(stub, (_instance, state) => {
      oldRoomSocket = state.getWebSockets("server")[0];
    });
    const oldClient = await connect(stub, "client");
    const oldServerClosed = nextClose(oldServer, "replaced server close");
    const oldClientClosed = nextClose(oldClient, "replaced client close");

    const replacement = await connect(stub, "server");
    await expect(oldServerClosed).resolves.toMatchObject(REPLACED_CLOSE);
    await expect(oldClientClosed).resolves.toMatchObject(REPLACED_CLOSE);
    const replacementClient = await connect(stub, "client");

    if (oldRoomSocket === undefined) {
      throw new Error("Old room-side server socket was not captured");
    }
    await runInDurableObject(stub, async (instance) => {
      const handler = instance as unknown as {
        webSocketClose(
          socket: WebSocket,
          code: number,
          reason: string,
          clean: boolean,
        ): Promise<void>;
      };
      await handler.webSocketClose(oldRoomSocket!, 1_000, "", true);
    });

    const selectedTicket = ticket(10);
    const offered = nextJson(replacement, "replacement server offer");
    replacementClient.send(clientCandidate(selectedTicket));
    expect(await offered).toMatchObject({ ticket: selectedTicket });
    const reply = nextJson(replacementClient, "replacement server reply");
    replacement.send(serverCandidate(selectedTicket));
    expect(await reply).toMatchObject({ ticket: selectedTicket });
    closeForCleanup(replacementClient, replacement);
  });

  it("preserves the current control when replacement preparation fails", async () => {
    const stub = room("failed-server-replacement");
    const server = await connect(stub, "server");
    const client = await connect(stub, "client");
    const randomUuid = vi.spyOn(crypto, "randomUUID")
      .mockImplementationOnce(() => {
        throw new Error("injected replacement preparation failure");
      });
    try {
      await expectFixedError(
        await within(
          stub.fetch(roomRequest("server")),
          "rejected replacement response",
        ),
        503,
        "Rendezvous room unavailable\n",
        "60",
      );
      expect(server.readyState).toBe(1);
      expect(client.readyState).toBe(1);

      const selectedTicket = ticket(64);
      const offered = nextJson(server, "offer after failed replacement");
      client.send(clientCandidate(selectedTicket));
      await expect(offered).resolves.toMatchObject({ ticket: selectedTicket });
    } finally {
      randomUuid.mockRestore();
      closeForCleanup(client, server);
    }
  });

  it("rejects replacement when the current control cannot retire", async () => {
    const stub = room("undurable-server-retirement");
    const server = await connect(stub, "server");
    const client = await connect(stub, "client");
    const originalControlIds = await currentControlIds(stub);
    let restoreFaults = (): void => {};
    await runInDurableObject(stub, (_instance, state) => {
      const roomServer = state.getWebSockets("server")[0];
      if (roomServer === undefined) {
        throw new Error("Current room server is absent");
      }
      const serialize = vi.spyOn(roomServer, "serializeAttachment")
        .mockImplementation(() => {
          throw new Error("Injected server retirement persistence failure");
        });
      const close = vi.spyOn(roomServer, "close").mockImplementation(() => {
        throw new Error("Injected server retirement close failure");
      });
      restoreFaults = () => {
        close.mockRestore();
        serialize.mockRestore();
      };
    });

    try {
      await expectFixedError(
        await stub.fetch(roomRequest("server")),
        503,
        "Rendezvous room unavailable\n",
        "60",
      );
      expect(server.readyState).toBe(1);
      expect(client.readyState).toBe(1);
      expect(await within(
        currentControlIds(stub),
        "current control after rejected replacement",
      )).toEqual(originalControlIds);
    } finally {
      restoreFaults();
    }

    await within(evictDurableObject(stub), "rejected replacement eviction");
    expect(await within(
      currentControlIds(stub),
      "current control after rejected replacement eviction",
    )).toEqual(originalControlIds);
    const selectedTicket = ticket(88);
    const offered = nextJson(server, "offer after rejected replacement");
    client.send(clientCandidate(selectedTicket));
    await expect(offered).resolves.toMatchObject({ ticket: selectedTicket });
    closeForCleanup(client, server);
  });

  it("persists recovery quarantine for unresolved replacement clients", async () => {
    const stub = room("unresolved-replacement-client");
    const oldServer = await connect(stub, "server");
    const oldClient = await connect(stub, "client");
    const oldServerClosed = nextClose(oldServer, "quarantined old server");
    let restoreFaults = (): void => {};
    await runInDurableObject(stub, (_instance, state) => {
      const roomClient = state.getWebSockets("client")[0];
      if (roomClient === undefined) {
        throw new Error("Replacement quarantine client is absent");
      }
      const serialize = vi.spyOn(roomClient, "serializeAttachment")
        .mockImplementation(() => {
          throw new Error("Injected replacement client persistence failure");
        });
      const close = vi.spyOn(roomClient, "close").mockImplementation(() => {
        throw new Error("Injected replacement client close failure");
      });
      const setAlarm = vi.spyOn(state.storage, "setAlarm")
        .mockResolvedValue(undefined);
      restoreFaults = () => {
        setAlarm.mockRestore();
        close.mockRestore();
        serialize.mockRestore();
      };
    });

    let replacement: WebSocket | null = null;
    try {
      const response = await stub.fetch(roomRequest("server"));
      expect(response.status).toBe(101);
      replacement = response.webSocket;
      if (replacement === null) {
        throw new Error("Quarantine replacement has no WebSocket");
      }
      replacement.accept();
      await expect(oldServerClosed).resolves.toMatchObject(REPLACED_CLOSE);
      await runInDurableObject(stub, async (instance, state) => {
        Reflect.set(instance, "replacementQuarantineProbe", true);
        expect(await state.storage.get(
          "rendezvous:teardown-recovery-required",
        )).toBe(true);
      });
    } finally {
      restoreFaults();
    }

    await vi.waitFor(async () => {
      const serverCount = await runInDurableObject(
        stub,
        (_instance, state) => state.getWebSockets("server").length,
      );
      expect(serverCount).toBe(1);
    });

    const oldClientClosed = nextClose(oldClient, "quarantined old client");
    const replacementClosed = nextClose(replacement, "quarantined replacement");
    await evictDurableObject(stub);
    const reconstructed = await runInDurableObject(
      stub,
      async (instance, state) => ({
        oldInstance: Reflect.get(instance, "replacementQuarantineProbe"),
        recovery: await state.storage.get(
          "rendezvous:teardown-recovery-required",
        ),
      }),
    );
    expect(reconstructed).toEqual({
      oldInstance: undefined,
      recovery: undefined,
    });
    await expect(oldClientClosed).resolves.toMatchObject(INTERNAL_CLOSE);
    await expect(replacementClosed).resolves.toMatchObject(INTERNAL_CLOSE);
    expect(await currentControlIds(stub)).toEqual([]);
    await expectFixedError(
      await stub.fetch(roomRequest("client")),
      503,
      "Rendezvous server unavailable\n",
      "5",
    );
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.get(
        "rendezvous:teardown-recovery-required",
      )).toBeUndefined();
    });
    closeForCleanup(oldClient, oldServer, replacement);
  });

  it("does not revive a transport-retired control after eviction", async () => {
    const stub = room("transport-retired-server");
    const oldServer = await connect(stub, "server");
    const oldClient = await connect(stub, "client");
    const oldServerClosed = nextClose(oldServer, "transport-retired server");
    const oldClientClosed = nextClose(oldClient, "transport-retired client");
    let restoreFault = (): void => {};
    await runInDurableObject(stub, (_instance, state) => {
      const roomServer = state.getWebSockets("server")[0];
      if (roomServer === undefined) {
        throw new Error("Transport-retirement room server is absent");
      }
      const serialize = vi.spyOn(roomServer, "serializeAttachment")
        .mockImplementation(() => {
          throw new Error("Injected server retirement persistence failure");
        });
      restoreFault = () => serialize.mockRestore();
    });

    let replacement: WebSocket | null = null;
    try {
      const response = await stub.fetch(roomRequest("server"));
      expect(response.status).toBe(101);
      replacement = response.webSocket;
      if (replacement === null) {
        throw new Error("Replacement upgrade has no WebSocket");
      }
      replacement.accept();
    } finally {
      restoreFault();
    }

    await expect(oldServerClosed).resolves.toMatchObject(REPLACED_CLOSE);
    await expect(oldClientClosed).resolves.toMatchObject(REPLACED_CLOSE);
    replacement.close(1_000, "Disconnect replacement before eviction");
    await vi.waitFor(async () => {
      expect(await currentControlIds(stub)).toEqual([]);
    });
    await evictDurableObject(stub);
    expect(await currentControlIds(stub)).toEqual([]);
    await expectFixedError(
      await stub.fetch(roomRequest("client")),
      503,
      "Rendezvous server unavailable\n",
      "5",
    );
    closeForCleanup(oldClient, oldServer, replacement);
  });

  it("closes clients with a fixed reason when the current server disconnects", async () => {
    const stub = room("current-server-disconnect");
    const server = await connect(stub, "server");
    const client = await connect(stub, "client");
    const clientClosed = nextClose(client, "server-disconnected client close");

    server.close(1_000, "peer-controlled reason that must not be forwarded");
    await expect(clientClosed).resolves.toMatchObject(
      SERVER_UNAVAILABLE_CLOSE,
    );
    await expectFixedError(
      await stub.fetch(roomRequest("client")),
      503,
      "Rendezvous server unavailable\n",
      "5",
    );
  });

  it("invalidates and closes both roles after a server WebSocket error", async () => {
    const stub = room("server-websocket-error");
    const server = await connect(stub, "server");
    const client = await connect(stub, "client");
    const serverClosed = nextClose(server, "errored server close");
    const clientClosed = nextClose(client, "errored server client close");

    await runInDurableObject(stub, async (instance: RendezvousRoom, state) => {
      const roomServer = state.getWebSockets("server")[0];
      if (roomServer === undefined) {
        throw new Error("Errored server room socket is absent");
      }
      await instance.webSocketError(
        roomServer,
        new Error("peer-controlled error text must not escape"),
      );
    });

    await expect(serverClosed).resolves.toMatchObject(INTERNAL_CLOSE);
    await expect(clientClosed).resolves.toMatchObject(INTERNAL_CLOSE);
    await evictDurableObject(stub);
    await expectFixedError(
      await stub.fetch(roomRequest("client")),
      503,
      "Rendezvous server unavailable\n",
      "5",
    );
  });

  it("finishes sibling cleanup before surfacing server teardown failure", async () => {
    const stub = room("server-teardown-batch");
    const server = await connect(stub, "server");
    const firstClient = await connect(stub, "client");
    const secondClient = await connect(stub, "client");
    const serverClosed = nextClose(server, "batched teardown server close");
    const firstClosed = nextClose(firstClient, "retried first client close");
    const secondClosed = nextClose(secondClient, "batched second client close");

    await runInDurableObject(stub, async (instance, state) => {
      const roomServer = state.getWebSockets("server")[0];
      const roomClients = state.getWebSockets("client");
      const faultedClient = roomClients[0];
      if (roomServer === undefined || faultedClient === undefined) {
        throw new Error("Batched teardown sockets are absent");
      }
      const serialize = vi.spyOn(faultedClient, "serializeAttachment")
        .mockImplementation(() => {
          throw new Error("Injected batched client persistence failure");
        });
      const close = vi.spyOn(faultedClient, "close")
        .mockImplementation(() => {
          throw new Error("Injected batched client close failure");
        });
      try {
        await expect(instance.webSocketError(
          roomServer,
          new Error("Injected server transport error"),
        )).rejects.toMatchObject({
          name: "RendezvousTeardownIntegrityError",
          message: "Rendezvous server teardown was not persisted",
        });
      } finally {
        close.mockRestore();
        serialize.mockRestore();
      }
      await expect(instance.alarm()).resolves.toBeUndefined();
    });

    await expect(serverClosed).resolves.toMatchObject(INTERNAL_CLOSE);
    await expect(firstClosed).resolves.toMatchObject(INTERNAL_CLOSE);
    await expect(secondClosed).resolves.toMatchObject(INTERNAL_CLOSE);
    closeForCleanup(firstClient, secondClient, server);
  });

  it("retries an unresolved server teardown with its original outcome", async () => {
    const stub = room("unresolved-server-teardown");
    const server = await connect(stub, "server");
    const client = await connect(stub, "client");
    const serverClosed = nextClose(server, "retried server protocol close");
    const clientClosed = nextClose(client, "server protocol client close");

    await runInDurableObject(stub, async (instance, state) => {
      const roomServer = state.getWebSockets("server")[0];
      if (roomServer === undefined) {
        throw new Error("Unresolved teardown server is absent");
      }
      const serialize = vi.spyOn(roomServer, "serializeAttachment")
        .mockImplementation(() => {
          throw new Error("Injected unresolved server persistence failure");
        });
      const close = vi.spyOn(roomServer, "close").mockImplementation(() => {
        throw new Error("Injected unresolved server close failure");
      });
      try {
        await expect(instance.webSocketMessage(
          roomServer,
          clientCandidate(ticket(94)),
        )).rejects.toMatchObject({
          name: "RendezvousTeardownIntegrityError",
          message: "Rendezvous server teardown was not persisted",
        });
      } finally {
        close.mockRestore();
        serialize.mockRestore();
      }
      await expect(instance.alarm()).resolves.toBeUndefined();
    });

    await expect(serverClosed).resolves.toMatchObject(PROTOCOL_CLOSE);
    await expect(clientClosed).resolves.toMatchObject(PROTOCOL_CLOSE);
    await evictDurableObject(stub);
    expect(await currentControlIds(stub)).toEqual([]);
    closeForCleanup(client, server);
  });

  it("makes a client WebSocket error terminal across eviction", async () => {
    const stub = room("client-websocket-error");
    const server = await connect(stub, "server");
    const client = await connect(stub, "client");
    const clientClosed = nextClose(client, "errored client close");

    await runInDurableObject(stub, async (instance: RendezvousRoom, state) => {
      const roomClient = state.getWebSockets("client")[0];
      if (roomClient === undefined) {
        throw new Error("Errored client room socket is absent");
      }
      await instance.webSocketError(
        roomClient,
        new Error("peer-controlled error text must not escape"),
      );
    });

    await expect(clientClosed).resolves.toMatchObject(INTERNAL_CLOSE);
    await evictDurableObject(stub);
    const replacement = await connect(stub, "client");
    closeForCleanup(replacement, server);
  });

  it("persists only admission metadata and opaque replay tags in SQL", async () => {
    const stub = room("sql-privacy");
    const server = await connect(stub, "server");
    const client = await connect(stub, "client");
    const selectedTicket = ticket(11);
    const offered = nextJson(server, "privacy test offer");
    client.send(clientCandidate(selectedTicket, "2001:db8::11"));
    await offered;

    const snapshot = await runInDurableObject(stub, (_instance, state) => ({
      schema: state.storage.sql.exec<{ name: string; sql: string }>(
        `SELECT name, sql FROM sqlite_master
           WHERE type = 'table'
             AND name NOT LIKE 'sqlite_%'
             AND name NOT GLOB '_cf_*'
           ORDER BY name`,
      ).toArray(),
      admissionColumns: state.storage.sql.exec<{ name: string }>(
        "PRAGMA table_info(rendezvous_admissions)",
      ).toArray().map(({ name }) => name),
      admissions: state.storage.sql.exec<{
        id: number;
        accepted_at_ms: number;
        ticket_replay_tag_current: string | null;
        ticket_replay_tag_previous: string | null;
      }>(
        `SELECT id, accepted_at_ms, ticket_replay_tag_current,
                ticket_replay_tag_previous
           FROM rendezvous_admissions`,
      ).toArray(),
    }));

    expect(snapshot.schema.map(({ name }) => name)).toEqual([
      "_rendezvous_schema_migrations",
      "rendezvous_admissions",
    ]);
    expect(snapshot.admissionColumns).toEqual([
      "id",
      "accepted_at_ms",
      "ticket_replay_tag_current",
      "ticket_replay_tag_previous",
    ]);
    expect(snapshot.admissions).toHaveLength(1);
    const storedAdmission = snapshot.admissions[0];
    expect(storedAdmission?.ticket_replay_tag_current).toMatch(
      /^v1\.[A-Za-z0-9_-]{1,32}\.[A-Za-z0-9_-]{43}$/,
    );
    expect(storedAdmission?.ticket_replay_tag_previous).toMatch(
      /^v1\.[A-Za-z0-9_-]{1,32}\.[A-Za-z0-9_-]{43}$/,
    );
    expect(storedAdmission?.ticket_replay_tag_previous).not.toBe(
      storedAdmission?.ticket_replay_tag_current,
    );
    const persisted = JSON.stringify(snapshot.admissions);
    expect(persisted).not.toContain(selectedTicket);
    expect(persisted).not.toContain("2001:db8::11");
    expect(persisted).not.toMatch(/candidate|address|hostname/i);
    closeForCleanup(client, server);
  });
});
