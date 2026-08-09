import {
  INTERNAL_RENDEZVOUS_AUTHORIZATION_HEADER,
  INTERNAL_RENDEZVOUS_GENERATION_HEADER,
  INTERNAL_RENDEZVOUS_PROTOCOL_HEADER,
  INTERNAL_RENDEZVOUS_ROLE_HEADER,
  INTERNAL_RENDEZVOUS_URL,
} from "./rendezvous-contract";
import { constantTimeEqual, sha256Hex } from "./protocol";
import { CLASSIC_RENDEZVOUS_INVITE_SUBPROTOCOL } from "./routes";
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
  invalid_websocket_subprotocol: {
    body: "Invalid WebSocket subprotocol\n",
    status: 400,
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
  const requestedSubprotocol = request.headers.get("Sec-WebSocket-Protocol");
  if (
    requestedSubprotocol !== null &&
    requestedSubprotocol !== CLASSIC_RENDEZVOUS_INVITE_SUBPROTOCOL
  ) {
    return fixedError("invalid_websocket_subprotocol");
  }
  const inviteProtocol = requestedSubprotocol ===
    CLASSIC_RENDEZVOUS_INVITE_SUBPROTOCOL;

  const cutoff = Math.floor(Date.now() / 1_000) - hooks.listingTtlSeconds;
  const server = await env.DB.prepare(
    `SELECT entries.password_required, presence.rendezvous_token_hash,
            presence.rendezvous_generation
       FROM server_presence AS presence
       JOIN directory_entries AS entries
         ON entries.profile = presence.profile
        AND entries.server_id = presence.server_id
      WHERE presence.profile = 'classic-v1'
        AND presence.server_id = ?
        AND presence.last_seen > ?`,
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
    if (server.password_required === 1) {
      if (!inviteProtocol) {
        return fixedError("rendezvous_authorization_unavailable");
      }
    } else if (inviteProtocol) {
      return fixedError("invalid_websocket_subprotocol");
    }
  }

  return env.RENDEZVOUS.getByName(serverId).fetch(new Request(
    INTERNAL_RENDEZVOUS_URL,
    {
      method: "GET",
      headers: {
        Upgrade: "websocket",
        [INTERNAL_RENDEZVOUS_ROLE_HEADER]: role,
        [INTERNAL_RENDEZVOUS_PROTOCOL_HEADER]: inviteProtocol
          ? "classic-invite-v1"
          : "none",
        [INTERNAL_RENDEZVOUS_AUTHORIZATION_HEADER]:
          role === "client" && server.password_required === 1
            ? "required"
            : "not-required",
        [INTERNAL_RENDEZVOUS_GENERATION_HEADER]:
          server.rendezvous_generation,
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
