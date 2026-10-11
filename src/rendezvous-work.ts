import { HttpError } from "./http";
import { requiredSourceTagKeyRing } from "./privacy";
import type { SourceTagKeyEnvironment } from "./privacy";
import { readBoundedPublishBody } from "./publisher-auth";

export const ADMISSION_HEADER = "X-Atrinik-Rendezvous-Admission";
export const TICKET_HEADER = "X-Atrinik-Rendezvous-Ticket";
export const CLIENT_NONCE_HEADER = "X-Atrinik-Access-Client-Nonce";
export const ADMISSION_SCHEMA = "atrinik-rendezvous-admission-v1";
export const ADMISSION_DIFFICULTY = 24;
const HEX_64 = /^[0-9a-f]{64}$/;
const TOKEN = /^v1\.([A-Za-z0-9_-]{1,32})\.([1-9][0-9]{0,11})\.([0-9a-f]{64})\.([0-9a-f]{32})\.([0-9a-f]{64})$/;

export interface ValidatedAdmission {
  readonly ticket: string;
  readonly expiresAt: number;
  readonly clientNonce: string | null;
}

export async function ticketHash(ticket: string): Promise<string> {
  const bytes = Uint8Array.from(ticket.match(/../g)!, part => parseInt(part, 16));
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

/** Blind issuance has no D1, Durable Object, or challenge-state dependency. */
export async function issueRendezvousChallenge(request: Request, env: SourceTagKeyEnvironment,
  authority: string, serverId: string, now = Math.floor(Date.now() / 1000)): Promise<Response> {
  const bytes = await readBoundedPublishBody(request, 256);
  let body: string;
  try { body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new HttpError("bad_request"); }
  const match = /^\{"schema":"atrinik-rendezvous-admission-v1","ticketHash":"([0-9a-f]{64})"\}$/.exec(body);
  if (match === null) throw new HttpError("bad_request");
  const ring = await requiredSourceTagKeyRing(env);
  const prefix = `v1.${ring.admissionKeyId}.${now}.${match[1]}.${hex(crypto.getRandomValues(new Uint8Array(16)))}`;
  const challenge = `${prefix}.${await ring.signAdmission(authority, serverId, prefix)}`;
  return new Response(JSON.stringify({ schema: ADMISSION_SCHEMA, challenge,
    difficulty: ADMISSION_DIFFICULTY, expiresAt: String(now + 60) }), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff" },
  });
}

export function parseAdmissionToken(token: string): { keyId: string; issuedAt: number;
  expiresAt: number; ticketHash: string; prefix: string; mac: string } | null {
  const match = TOKEN.exec(token);
  if (match === null) return null;
  const issuedAt = Number(match[2]);
  if (!Number.isSafeInteger(issuedAt) || issuedAt > 253402300739) return null;
  return { keyId: match[1], issuedAt, expiresAt: issuedAt + 60, ticketHash: match[3],
    prefix: token.slice(0, token.lastIndexOf(".")), mac: match[5] };
}

/** Fixed cost verification occurs before any presence or room lookup. */
export async function verifyRendezvousAdmission(request: Request, env: SourceTagKeyEnvironment,
  authority: string, serverId: string, protectedClient: boolean): Promise<ValidatedAdmission | null> {
  const proof = request.headers.get(ADMISSION_HEADER);
  if (proof === null || proof.length > 256) return null;
  const split = proof.lastIndexOf(".");
  const token = proof.slice(0, split), solution = proof.slice(split + 1);
  if (!/^[0-9a-f]{16}$/.test(solution)) return null;
  const parsed = parseAdmissionToken(token);
  const now = Math.floor(Date.now() / 1000);
  if (parsed === null || now < parsed.issuedAt || now >= parsed.expiresAt) return null;
  let ticket: string;
  let clientNonce: string | null = null;
  if (protectedClient) {
    const authorization = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.get("Authorization") ?? "");
    clientNonce = request.headers.get(CLIENT_NONCE_HEADER);
    if (authorization === null || clientNonce === null || !HEX_64.test(clientNonce) || request.headers.has(TICKET_HEADER)) return null;
    ticket = authorization[1];
  } else {
    ticket = request.headers.get(TICKET_HEADER) ?? "";
    if (!HEX_64.test(ticket) || request.headers.has("Authorization") || request.headers.has(CLIENT_NONCE_HEADER)) return null;
  }
  if (await ticketHash(ticket) !== parsed.ticketHash) return null;
  const ring = await requiredSourceTagKeyRing(env);
  if (!await ring.verifyAdmission(authority, serverId, parsed.prefix, parsed.keyId, parsed.mac)) return null;
  const work = new Uint8Array(await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(`atrinik-rendezvous-work-v1\0${token}\0${solution}`)));
  if (work[0] !== 0 || work[1] !== 0 || work[2] !== 0 || Math.floor(Date.now() / 1000) >= parsed.expiresAt) return null;
  return { ticket, clientNonce, expiresAt: parsed.expiresAt };
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}
