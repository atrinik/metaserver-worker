import { isAccessHash } from "./access-crypto";
import { HttpError } from "./http";
import { authenticateSignedPublish } from "./publisher-auth";

export const ACCESS_ROUTE_SCHEMA = "atrinik-access-route-v1";
export const ACCESS_ROUTE_SIGNATURE_TAG = "atrinik-access-routes-v1";
export type AccessProfile = "classic" | "game";
export type AccessRouteOperation = "reserve" | "activate" | "revoke" | "result";
export interface AccessRoutePayload {
  readonly schema: typeof ACCESS_ROUTE_SCHEMA;
  readonly profile: AccessProfile;
  readonly serverId: string;
  readonly certificate: string;
  readonly operation: AccessRouteOperation;
  readonly requestId: string;
  readonly tokenId: string;
  readonly tokenRevision: string;
  readonly index: string;
  readonly reservationId: string | null;
  readonly expiresAt: string | null;
}
const ID = /^[0-9a-f]{32}$/;
const UNSIGNED = /^[1-9][0-9]{0,19}$/;
const MAX_UINT64 = 18446744073709551615n;
const MAX_EXPIRY = 253402300799n;

export function parseAccessRoutePayload(body: Uint8Array): AccessRoutePayload {
  if (body.length === 0 || body.length > 4096) throw new HttpError("bad_request");
  let text: string;
  let value: Record<string, unknown>;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
    value = JSON.parse(text) as Record<string, unknown>;
  } catch { throw new HttpError("bad_request"); }
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      value.schema !== ACCESS_ROUTE_SCHEMA ||
      (value.profile !== "classic" && value.profile !== "game") ||
      !isAccessHash(value.serverId) || typeof value.certificate !== "string" ||
      value.certificate.length === 0 || value.certificate.length > 2732 ||
      !["reserve", "activate", "revoke", "result"].includes(value.operation as string) ||
      !isId(value.requestId) || !isId(value.tokenId) ||
      !isDecimal(value.tokenRevision, MAX_UINT64) || !isAccessHash(value.index) ||
      (value.reservationId !== null && !isId(value.reservationId)) ||
      (value.expiresAt !== null && !isDecimal(value.expiresAt, MAX_EXPIRY)) ||
      (value.operation === "reserve" && value.reservationId !== null) ||
      (value.operation === "activate" && value.reservationId === null)) {
    throw new HttpError("bad_request");
  }
  const payload: AccessRoutePayload = {
    schema: ACCESS_ROUTE_SCHEMA,
    profile: value.profile,
    serverId: value.serverId,
    certificate: value.certificate,
    operation: value.operation as AccessRouteOperation,
    requestId: value.requestId,
    tokenId: value.tokenId,
    tokenRevision: value.tokenRevision,
    index: value.index,
    reservationId: value.reservationId as string | null,
    expiresAt: value.expiresAt as string | null,
  };
  // Reject duplicates, unknown keys, alternate order, BOM, escapes and trailing
  // bytes before validating the signature over this exact canonical body.
  if (JSON.stringify(payload) !== text) throw new HttpError("bad_request");
  return payload;
}

export async function authenticateAccessRoute(
  request: Request,
  body: Uint8Array,
  profile: AccessProfile,
  serverId: string,
  authority: string,
  now: number,
) {
  const payload = parseAccessRoutePayload(body);
  if (payload.profile !== profile) throw new HttpError("unauthorized");
  return authenticateSignedPublish(request, body, serverId, authority, now,
    ACCESS_ROUTE_SIGNATURE_TAG,
    `/v1/access/servers/${profile}/${serverId}/routes`, payload);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}
function isDecimal(value: unknown, maximum: bigint): value is string {
  return typeof value === "string" && UNSIGNED.test(value) && BigInt(value) <= maximum;
}
