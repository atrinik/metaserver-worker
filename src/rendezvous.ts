import {
  INTERNAL_RENDEZVOUS_ROLE_HEADER,
  INTERNAL_RENDEZVOUS_URL,
} from "./rendezvous-contract";
import { constantTimeEqual, sha256Hex } from "./protocol";
import type { RendezvousRole } from "./routes";
import type { RendezvousServerRecord } from "./types";

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
  rendezvous_authorization_unavailable: {
    body: "Protected rendezvous authorization is unavailable\n",
    status: 503,
    headers: { "Retry-After": "300" },
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

  const cutoff = Math.floor(Date.now() / 1_000) - hooks.listingTtlSeconds;
  const server = await env.DB.prepare(
    `SELECT is_public, password_required, rendezvous_token_hash
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
    // Issue #20 will replace this safe dependency boundary with a bounded
    // password authorization exchange before any candidate is disclosed.
    if (server.password_required === 1) {
      return fixedError("rendezvous_authorization_unavailable");
    }
  }

  return env.RENDEZVOUS.getByName(serverId).fetch(new Request(
    INTERNAL_RENDEZVOUS_URL,
    {
      method: "GET",
      headers: {
        Upgrade: "websocket",
        [INTERNAL_RENDEZVOUS_ROLE_HEADER]: role,
      },
    },
  ));
}

function fixedError(code: RendezvousErrorCode): Response {
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

export { RendezvousRoom } from "./rendezvous-room";
