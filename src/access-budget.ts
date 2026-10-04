import type { AccessProfile } from "./access-route-auth";
import { HttpError } from "./http";

/** Only authenticated identity or capability-eligible callers may allocate. */
export async function consumeAccessBudget(
  db: D1Database, profile: AccessProfile, serverId: string,
  scope: "routes" | "resolve", now: number,
): Promise<void> {
  const duration = scope === "routes" ? 3600 : 60;
  const limit = scope === "routes" ? 64 : 60;
  const start = Math.floor(now / duration) * duration;
  const results = await db.batch([
    db.prepare(`DELETE FROM access_request_budgets WHERE (profile,server_id,scope) IN (
      SELECT profile,server_id,scope FROM access_request_budgets WHERE expires_at<=? LIMIT 256)`).bind(now),
    db.prepare(`INSERT INTO access_request_budgets(profile,server_id,scope,window_start,expires_at,request_count)
      VALUES(?,?,?,?,?,1) ON CONFLICT(profile,server_id,scope) DO UPDATE SET
        window_start=excluded.window_start,expires_at=excluded.expires_at,
        request_count=CASE WHEN access_request_budgets.window_start=excluded.window_start
          THEN access_request_budgets.request_count+1 ELSE 1 END
      WHERE access_request_budgets.window_start<excluded.window_start OR
        (access_request_budgets.window_start=excluded.window_start AND access_request_budgets.request_count<?)`
    ).bind(profile, serverId, scope, start, start + duration, limit),
  ]);
  if (results.some((result) => !result.success)) throw new HttpError("request_control_unavailable");
  if (results[1].meta.changes !== 1) throw new HttpError("rate_limited", { retryAfterSeconds: start + duration - now });
}
