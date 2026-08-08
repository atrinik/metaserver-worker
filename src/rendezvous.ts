import { DurableObject } from "cloudflare:workers";

import {
  constantTimeEqual,
  normalizeIpAddress,
  SERVER_SIGNAL_CANDIDATE_KINDS,
  sha256Hex,
} from "./protocol";
import type { DirectCandidateKind } from "./protocol";
import type { RendezvousRole } from "./routes";
import type { RendezvousServerRecord } from "./types";

const MAX_SIGNAL_BYTES = 512;
const HEX_64 = /^[0-9a-f]{64}$/;
const RENDEZVOUS_ERROR_DEFINITIONS = {
  invalid_server_id: {
    body: "Invalid server ID\n",
    status: 400,
  },
  websocket_upgrade_required: {
    body: "WebSocket upgrade required\n",
    status: 426,
    headers: { Upgrade: "websocket" },
  },
  server_offline: {
    body: "Server is offline\n",
    status: 404,
  },
  invalid_rendezvous_token: {
    body: "Invalid rendezvous token\n",
    status: 401,
    headers: { "WWW-Authenticate": "Bearer" },
  },
  server_private: {
    body: "Server is private\n",
    status: 403,
  },
  room_forbidden: {
    body: "Forbidden\n",
    status: 403,
  },
  room_full: {
    body: "Rendezvous room is full\n",
    status: 503,
  },
} as const satisfies Readonly<Record<string, {
  readonly body: string;
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
}>>;

type RendezvousErrorCode = keyof typeof RENDEZVOUS_ERROR_DEFINITIONS;

export interface RendezvousAdmissionHooks {
  readonly listingTtlSeconds: number;
  serverAuthenticated(): Promise<void>;
}

export async function openRendezvous(
  request: Request,
  env: Env,
  serverId: string,
  role: RendezvousRole,
  hooks: RendezvousAdmissionHooks,
): Promise<Response> {
  if (!HEX_64.test(serverId)) {
    return fixedError("invalid_server_id");
  }
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return fixedError("websocket_upgrade_required");
  }

  const cutoff = Math.floor(Date.now() / 1_000) -
    hooks.listingTtlSeconds;
  const server = await env.DB.prepare(
    `SELECT is_public, rendezvous_token_hash
       FROM servers
      WHERE server_id = ? AND last_seen >= ?`,
  ).bind(serverId, cutoff).first<RendezvousServerRecord>();

  if (server === null) {
    return fixedError("server_offline");
  }

  if (role === "server") {
    const authorization = request.headers.get("Authorization") ?? "";
    const match = /^Bearer ([0-9a-f]{64})$/i.exec(authorization);
    const token = match?.[1] ?? "";
    const actual = await sha256Hex(token);
    if (!await constantTimeEqual(actual, server.rendezvous_token_hash)) {
      return fixedError("invalid_rendezvous_token");
    }
    await hooks.serverAuthenticated();
  } else {
    if (server.is_public !== 1) {
      return fixedError("server_private");
    }
  }

  const id = env.RENDEZVOUS.idFromName(serverId);
  const headers = new Headers({
    Upgrade: "websocket",
    "X-Atrinik-Role": role,
  });
  return env.RENDEZVOUS.get(id).fetch(new Request(request.url, {
    method: "GET",
    headers,
  }));
}

function fixedError(
  code: RendezvousErrorCode,
): Response {
  const definition = RENDEZVOUS_ERROR_DEFINITIONS[code];
  const headers = new Headers();
  if ("headers" in definition) {
    for (const [name, value] of Object.entries(definition.headers)) {
      headers.set(name, value);
    }
  }
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Type", "text/plain; charset=utf-8");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(definition.body, {
    status: definition.status,
    headers,
  });
}

/**
 * Signaling-only rendezvous room. It accepts no HTTP bodies and no binary
 * WebSocket messages, and forwards only validated direct-candidate signaling.
 */
export class RendezvousRoom extends DurableObject<Env> {
  constructor(
    ctx: DurableObjectState,
    env: Env,
  ) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    if (!isValidRoomUpgrade(request)) {
      return fixedError("room_forbidden");
    }
    const role = request.headers.get("X-Atrinik-Role");
    if (role !== "server" && role !== "client") {
      return fixedError("room_forbidden");
    }

    if (role === "client" &&
        this.ctx.getWebSockets("client").length >= 64) {
      return fixedError("room_full");
    }
    if (role === "server") {
      for (const existing of this.ctx.getWebSockets("server")) {
        existing.close(1000, "Server control connection replaced");
      }
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const room = pair[1];
    this.ctx.acceptWebSocket(room, [role]);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== "string" ||
        new TextEncoder().encode(message).byteLength > MAX_SIGNAL_BYTES) {
      socket.close(1008, "Invalid signaling message");
      return;
    }

    let signal: unknown;
    try {
      signal = JSON.parse(message);
    } catch {
      socket.close(1008, "Invalid signaling JSON");
      return;
    }
    if (
      signal === null ||
      typeof signal !== "object" ||
      Array.isArray(signal)
    ) {
      socket.close(1008, "Invalid signaling JSON");
      return;
    }

    const fields = signal as Record<string, unknown>;

    let candidateHost: string | null = null;
    if (typeof fields.host === "string") {
      try {
        candidateHost = normalizeIpAddress(fields.host);
      } catch {
        candidateHost = null;
      }
    }
    const isClientCandidate = fields.type === "client_candidate" &&
      candidateHost !== null &&
      Number.isInteger(fields.port) &&
      Number(fields.port) >= 1 && Number(fields.port) <= 65_535 &&
      typeof fields.ticket === "string" &&
      /^[0-9a-f]{64}$/.test(fields.ticket);
    const isServerCandidate = fields.type === "server_candidate" &&
      candidateHost !== null &&
      Number.isInteger(fields.port) &&
      Number(fields.port) >= 1 && Number(fields.port) <= 65_535 &&
      typeof fields.kind === "string" &&
      SERVER_SIGNAL_CANDIDATE_KINDS.has(fields.kind as DirectCandidateKind) &&
      typeof fields.ticket === "string" &&
      /^[0-9a-f]{64}$/.test(fields.ticket);
    const isComplete = fields.type === "complete" &&
      typeof fields.ticket === "string" &&
      /^[0-9a-f]{64}$/.test(fields.ticket);
    if (!isClientCandidate && !isServerCandidate && !isComplete) {
      socket.close(1008, "Unsupported signaling message");
      return;
    }

    const sourceIsServer = this.ctx.getTags(socket).includes("server");
    if ((sourceIsServer && !isServerCandidate && !isComplete) ||
        (!sourceIsServer && !isClientCandidate)) {
      socket.close(1008, "Message not allowed for role");
      return;
    }

    const forwarded = isClientCandidate
      ? JSON.stringify({
          type: "client_candidate",
          host: candidateHost,
          port: fields.port,
          ticket: fields.ticket,
        })
      : isServerCandidate
        ? JSON.stringify({
            type: "server_candidate",
            host: candidateHost,
            port: fields.port,
            kind: fields.kind,
            ticket: fields.ticket,
          })
        : JSON.stringify({ type: "complete", ticket: fields.ticket });
    const targets = this.ctx.getWebSockets(
      sourceIsServer ? "client" : "server",
    );
    for (const target of targets) {
      try {
        target.send(forwarded);
      } catch {
        // Hibernating sockets can disappear between enumeration and send.
      }
    }
  }

}

function isValidRoomUpgrade(request: Request): boolean {
  if (
    request.method !== "GET" ||
    request.body !== null ||
    request.headers.get("Upgrade") !== "websocket"
  ) {
    return false;
  }
  for (const name of [
    "Content-Length",
    "Content-Type",
    "Content-Encoding",
    "Transfer-Encoding",
  ]) {
    if (request.headers.has(name)) {
      return false;
    }
  }
  return true;
}
