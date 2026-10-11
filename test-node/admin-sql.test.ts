import { execFileSync } from "node:child_process";
import { readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { unstable_splitSqlQuery } from "wrangler";
import { afterAll, beforeAll, expect, it } from "vitest";

let runtime: Miniflare;
let database: D1Database;
const owner = "a".repeat(64);
const other = "b".repeat(64);
beforeAll(async () => {
  runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: "export default {fetch(){return new Response(null,{status:404})}}",
    compatibilityDate: "2026-08-05",
    d1Databases: ["DB"],
  }));
  database = (await runtime.getBindings<{ DB: D1Database }>()).DB;
  for (const migration of await readD1Migrations("migrations")) {
    await database.batch(migration.queries.map(query => database.prepare(query)));
  }
});
afterAll(async () => { await runtime?.dispose(); });

it("executes identity reset through Wrangler's file splitter as one D1 transaction", async () => {
  for (const identity of [owner, other]) {
    await database.prepare(
      "INSERT INTO access_routes VALUES (?, 'classic', ?, ?, '1', 'active', NULL, ?, 200, 100, NULL)",
    ).bind(identity, identity, "1".repeat(32), "2".repeat(32)).run();
    await database.prepare(
      "INSERT INTO access_grants VALUES (?, ?, ?, 'classic', ?, '1', ?, ?, 200, NULL)",
    ).bind(identity + "1", identity + "2", identity, identity, "c".repeat(64), "d".repeat(64)).run();
    await database.prepare(
      "INSERT INTO publisher_replay VALUES (?, 'classic-v3', '1', ?, ?, 100)",
    ).bind(identity, "e".repeat(32), "f".repeat(64)).run();
  }
  const sql = execFileSync("python3", ["scripts/admin_sql.py", "reset-identity", owner], { encoding: "utf8" });
  expect(sql).toContain("BEGIN TRANSACTION;");
  const queries = unstable_splitSqlQuery(sql);
  expect(queries.some(query => /^\s*(BEGIN|COMMIT)\b/m.test(query))).toBe(false);

  // A late failure must restore earlier capability revocation and grant deletion.
  await database.prepare(
    "CREATE TRIGGER reject_reset BEFORE DELETE ON publisher_replay BEGIN SELECT RAISE(ABORT, 'reset blocked'); END",
  ).run();
  await expect(database.batch(queries.map(query => database.prepare(query)))).rejects.toThrow();
  expect(await database.prepare("SELECT state FROM access_routes WHERE server_id=?").bind(owner).first("state")).toBe("active");
  expect(await database.prepare("SELECT count(*) AS n FROM access_grants").first("n")).toBe(2);
  await database.prepare("DROP TRIGGER reject_reset").run();
  await database.batch(queries.map(query => database.prepare(query)));
  expect(await database.prepare("SELECT state FROM access_routes WHERE server_id=?").bind(owner).first("state")).toBe("revoked");
  expect(await database.prepare("SELECT state FROM access_routes WHERE server_id=?").bind(other).first("state")).toBe("active");
  expect(await database.prepare("SELECT count(*) AS n FROM access_grants WHERE server_id=?").bind(owner).first("n")).toBe(0);
  expect(await database.prepare("SELECT count(*) AS n FROM publisher_replay WHERE server_id=?").bind(owner).first("n")).toBe(0);
});
