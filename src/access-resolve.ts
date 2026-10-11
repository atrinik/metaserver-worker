import { isAccessHash } from "./access-crypto";
import { HttpError } from "./http";

export const ACCESS_RESOLVE_MAX_BODY_BYTES = 512;
export const ACCESS_RESOLVE_SCHEMA = "atrinik-access-resolve-v1";
export interface AccessResolveRequest {
  readonly schema: typeof ACCESS_RESOLVE_SCHEMA;
  readonly routeCapability: string;
  readonly clientNonce: string;
}

/**
 * A flat string-only JSON object permits exact duplicate-key detection without
 * relying on JSON.parse's last-writer-wins behavior. Whitespace and JSON string
 * escapes retain their ordinary meaning; decoded duplicate keys are rejected.
 */
export function parseAccessResolveRequest(bytes: Uint8Array): AccessResolveRequest {
  if (bytes.length === 0 || bytes.length > ACCESS_RESOLVE_MAX_BODY_BYTES) {
    throw new HttpError("bad_request");
  }
  let input: string;
  try {
    input = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new HttpError("bad_request");
  }
  let offset = 0;
  const whitespace = () => {
    while (offset < input.length && /[\x20\x09\x0a\x0d]/.test(input[offset])) offset++;
  };
  const punctuation = (value: string) => {
    whitespace();
    if (input[offset++] !== value) throw new HttpError("bad_request");
  };
  const string = (): string => {
    whitespace();
    const start = offset;
    if (input[offset++] !== '"') throw new HttpError("bad_request");
    while (offset < input.length) {
      const value = input[offset++];
      if (value === "\\") {
        // JSON.parse below validates the complete escape, including hex digits.
        offset++;
      } else if (value === '"') {
        try { return JSON.parse(input.slice(start, offset)) as string; }
        catch { throw new HttpError("bad_request"); }
      }
    }
    throw new HttpError("bad_request");
  };
  const fields = new Map<string, string>();
  punctuation("{");
  for (let index = 0; index < 3; index++) {
    if (index !== 0) punctuation(",");
    const key = string();
    if (!["schema", "routeCapability", "clientNonce"].includes(key) || fields.has(key)) {
      throw new HttpError("bad_request");
    }
    punctuation(":");
    fields.set(key, string());
  }
  punctuation("}");
  whitespace();
  const routeCapability = fields.get("routeCapability");
  const clientNonce = fields.get("clientNonce");
  if (offset !== input.length || fields.get("schema") !== ACCESS_RESOLVE_SCHEMA ||
      !isAccessHash(routeCapability) || !isAccessHash(clientNonce) ||
      input !== JSON.stringify({ schema: ACCESS_RESOLVE_SCHEMA, routeCapability, clientNonce })) {
    throw new HttpError("bad_request");
  }
  return { schema: ACCESS_RESOLVE_SCHEMA, routeCapability, clientNonce };
}
