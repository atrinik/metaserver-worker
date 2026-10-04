export const INTERNAL_ACCESS_PROBE_URL = "https://rendezvous.internal/v4/access/probe";
export const INTERNAL_ACCESS_REVOKE_URL = "https://rendezvous.internal/v4/access/revoke";
export interface ParsedAccessInit {
  readonly ok: true;
  readonly access: true;
  readonly grant: string;
  readonly clientNonce: string;
  readonly bytes: number;
}
export function parseAccessInit(message: string | ArrayBuffer): ParsedAccessInit | null {
  if (typeof message !== "string" || message.length > 256) return null;
  let object: Record<string, unknown>;
  try { object = JSON.parse(message) as Record<string, unknown>; } catch { return null; }
  if (object === null || typeof object !== "object" || Array.isArray(object) ||
      object.type !== "access_init" || object.version !== 1 ||
      typeof object.grant !== "string" || !/^[0-9a-f]{64}$/.test(object.grant) ||
      typeof object.client_nonce !== "string" || !/^[0-9a-f]{64}$/.test(object.client_nonce)) return null;
  const canonical = JSON.stringify({ type: "access_init", version: 1,
    grant: object.grant, client_nonce: object.client_nonce });
  if (canonical !== message) return null;
  return { ok: true, access: true, grant: object.grant, clientNonce: object.client_nonce,
    bytes: new TextEncoder().encode(message).byteLength };
}
