// Copyright (C) 2026 Atrinik contributors
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { diagnoseDevelopmentResources, verifyContext, formatDiagnostic } from "./diagnose-development-resources.mjs";

const sha = "a".repeat(40);
const now = Date.parse("2026-10-31T12:00:00Z");
const workflow = ".github/workflows/diagnose-development-resources.yml";
const repository = { full_name: "atrinik/metaserver-worker" };
const secret = "private-credential-must-not-leave-the-process";

function fixture() {
  const accountId = "b".repeat(32);
  const cohorts = ["production", "development"].map(environment => {
    const core = environment === "production" ? "atrinik-metaserver" : "atrinik-metaserver-development";
    return { environment, accountId, workers: ["core", "publisher", "rendezvous"].map((role, index) => ({
      name: index ? `${core}-${role}` : core, role, resources: [], origins: [], variables: [], routes: [], secrets: [],
      services: index ? [{ binding: "COORDINATOR", service: core,
        entrypoint: role === "publisher" ? "PublisherCoordinator" : "RendezvousCoordinator" }] : [],
    })) };
  });
  const policy = { schema: "atrinik-delivery-resources-v1", cohorts };
  const environment = { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REPOSITORY: repository.full_name,
    GITHUB_REF: "refs/heads/main", GITHUB_RUN_ATTEMPT: "1", GITHUB_RUN_ID: "12", GITHUB_SHA: sha, GITHUB_WORKFLOW_SHA: sha,
    GITHUB_WORKFLOW_REF: `${repository.full_name}/${workflow}@refs/heads/main`, GITHUB_TOKEN: secret,
    CLOUDFLARE_ACCOUNT_ID: accountId, ATRINIK_DELIVERY_RESOURCE_POLICY: JSON.stringify(policy),
    ATRINIK_DELIVERY_RESOURCE_READ_TOKEN: secret };
  const github = {
    "": { ...repository, id: 1324297032, default_branch: "main", fork: false },
    "/branches/main": { name: "main", protected: true, commit: { sha } },
    "/actions/runs/12": { id: 12, run_attempt: 1, event: "workflow_dispatch", head_branch: "main", head_sha: sha,
      path: workflow, status: "in_progress", conclusion: null, repository, head_repository: repository,
      created_at: "2026-10-31T11:59:00Z" },
    "/environments/development": { name: "development", deployment_branch_policy: { protected_branches: true, custom_branch_policies: false } },
  };
  const requests = [];
  const fetcher = async (url, options) => {
    requests.push({ url, options });
    assert.equal(options.method, "GET"); assert.equal(options.redirect, "error");
    const parsed = new URL(url);
    if (parsed.origin === "https://api.github.com")
      return Response.json(github[parsed.pathname.replace(`/repos/${repository.full_name}`, "")]);
    assert.equal(parsed.origin, "https://api.cloudflare.com");
    assert.equal(options.headers.Authorization, `Bearer ${secret}`);
    let result = [];
    if (parsed.pathname.endsWith("/settings")) {
      const worker = cohorts.flatMap(c => c.workers).find(w => parsed.pathname.includes(`/${w.name}/`));
      result = { bindings: worker.services.map(s => ({ name: s.binding, type: "service", service: s.service, entrypoint: s.entrypoint })) };
    }
    return Response.json({ success: true, result, result_info: { count: 0 } });
  };
  return { environment, policy, github, requests, fetcher };
}
const run = f => diagnoseDevelopmentResources(f.environment, f.fetcher, now);
const assertSanitized = result => {
  const text = formatDiagnostic(result);
  assert.equal(text.includes(secret), false); assert.equal(text.includes("private-provider-value"), false);
  assert.doesNotMatch(text, /https?:\/\//u); assert.equal(text.includes("Authorization"), false);
};

test("manual trusted-main diagnostic reads all cohorts with GET only and never emits credentials", async () => {
  const f = fixture(); const result = await run(f);
  assert.equal(result.outcome, "matched"); assert.equal(result.rows.length, 6);
  assert.equal(f.requests.length, 22); assertSanitized(result);
  assert.equal(f.requests.filter(r => new URL(r.url).origin === "https://api.cloudflare.com").length, 18);
});

test("local, fork, wrong workflow, rerun and arbitrary ref fail before any network read", async () => {
  for (const [key, value] of [["GITHUB_ACTIONS", "false"], ["GITHUB_EVENT_NAME", "push"], ["GITHUB_REPOSITORY", "fork/repo"],
    ["GITHUB_REF", "refs/heads/topic"], ["GITHUB_RUN_ATTEMPT", "2"], ["GITHUB_RUN_ID", "12/other"],
    ["GITHUB_WORKFLOW_REF", "foreign"], ["GITHUB_WORKFLOW_SHA", "b".repeat(40)], ["GITHUB_TOKEN", ""]]) {
    const f = fixture(); f.environment[key] = value;
    assert.equal((await run(f)).category, "context-rejected"); assert.equal(f.requests.length, 0);
  }
});

test("secret-free preflight succeeds without reading protected inputs", async () => {
  const f = fixture();
  for (const key of ["CLOUDFLARE_ACCOUNT_ID", "ATRINIK_DELIVERY_RESOURCE_POLICY", "ATRINIK_DELIVERY_RESOURCE_READ_TOKEN"])
    Object.defineProperty(f.environment, key, { get() { throw new Error("protected input touched"); } });
  assert.equal((await verifyContext(f.environment, f.fetcher, now)).outcome, "context-verified");
  assert.equal(f.requests.length, 4);
});

test("current-main, run, repository and environment drift stop before provider or private inputs", async () => {
  for (const change of [f => { f.github["/branches/main"].commit.sha = "c".repeat(40); },
    f => { f.github["/actions/runs/12"].event = "pull_request"; },
    f => { f.github["/actions/runs/12"].path = "other.yml"; },
    f => { f.github["/actions/runs/12"].created_at = "2026-10-31T10:00:00Z"; },
    f => { f.github[""].id = 1; },
    f => { f.github["/environments/development"].deployment_branch_policy.protected_branches = false; }]) {
    const f = fixture(); change(f);
    Object.defineProperty(f.environment, "ATRINIK_DELIVERY_RESOURCE_POLICY", { get() { throw new Error("private input read"); } });
    assert.equal((await run(f)).category, "context-rejected");
    assert.equal(f.requests.every(r => r.url.startsWith("https://api.github.com/")), true);
  }
});

test("malformed, oversized, production-bootstrap and missing policy/token fail before provider reads", async () => {
  for (const change of [f => { f.environment.ATRINIK_DELIVERY_RESOURCE_POLICY = "{"; },
    f => { f.environment.ATRINIK_DELIVERY_RESOURCE_POLICY = "x".repeat(49 * 1024); },
    f => { f.environment.ATRINIK_DELIVERY_RESOURCE_POLICY = JSON.stringify({ ...f.policy, productionBootstrap: {} }); },
    f => { delete f.environment.ATRINIK_DELIVERY_RESOURCE_POLICY; },
    f => { f.environment.ATRINIK_DELIVERY_RESOURCE_READ_TOKEN = ""; },
    f => { f.environment.CLOUDFLARE_ACCOUNT_ID = "wrong"; }]) {
    const f = fixture(); change(f); const result = await run(f);
    assert.equal(result.category, "input-rejected"); assert.equal(f.requests.length, 4); assertSanitized(result);
  }
});

test("non-target values yield field paths; target plaintext keeps the existing fence exception", async () => {
  for (const index of [0, 1]) {
    const f = fixture(); f.policy.cohorts[index].workers[0].variables.push({ binding: "PRIVATE", value: secret });
    f.environment.ATRINIK_DELIVERY_RESOURCE_POLICY = JSON.stringify(f.policy);
    const result = await run(f); assert.equal(result.outcome, index === 0 ? "rejected" : "matched");
    if (index === 0) assert.deepEqual(result.rows[0].fields, ["/variables/length"]);
    assertSanitized(result);
  }
});

test("inventory array ordering matches the existing fence before comparing object fields", async () => {
  const f = fixture();
  f.policy.cohorts[0].workers[0].variables = [{ binding: "Z", value: "z" }, { value: "a", binding: "A" }];
  f.environment.ATRINIK_DELIVERY_RESOURCE_POLICY = JSON.stringify(f.policy);
  const base = f.fetcher;
  f.fetcher = async (url, options) => url.endsWith("/workers/scripts/atrinik-metaserver/settings")
    ? Response.json({ success: true, result: { bindings: [
      { name: "A", type: "plain_text", text: "a" }, { name: "Z", type: "plain_text", text: "z" },
    ] } }) : base(url, options);
  const result = await run(f);
  assert.equal(result.outcome, "rejected");
  assert.deepEqual(result.rows[0].fields, ["/variables/0/binding", "/variables/0/value", "/variables/1/binding", "/variables/1/value"]);
});

test("denied, throttled, malformed, paginated and oversized provider responses are bounded and redacted", async () => {
  for (const response of [() => new Response("private-provider-value", { status: 403 }),
    () => new Response("private-provider-value", { status: 429 }), () => new Response("invalid-json"),
    () => Response.json({ success: false, errors: [{ message: secret }] }),
    () => Response.json({ success: true, result: [], result_info: { total_pages: 2 } }),
    () => new Response("x".repeat(2_000_001)), () => { throw new Error(secret); }]) {
    const f = fixture(); const base = f.fetcher;
    f.fetcher = async (url, options) => new URL(url).origin === "https://api.cloudflare.com" ? response() : base(url, options);
    const result = await run(f); assert.equal(result.category, "resource-read-rejected");
    assert.equal(result.rows.length, 1); assertSanitized(result);
  }
});

test("unsupported provider binding emits projection category without its supplied name/value", async () => {
  const f = fixture(); const base = f.fetcher;
  f.fetcher = async (url, options) => new URL(url).origin === "https://api.cloudflare.com" && new URL(url).pathname.endsWith("/settings")
    ? Response.json({ success: true, result: { bindings: [{ type: secret, name: secret }] } }) : base(url, options);
  const result = await run(f); assert.equal(result.category, "resource-projection-rejected"); assertSanitized(result);
});

test("output ceiling replaces excess data with a closed error", () => {
  assert.deepEqual(JSON.parse(formatDiagnostic({ content: "x".repeat(65_536) })),
    { outcome: "rejected", mutation: false, category: "output-bound" });
});

test("workflow is dispatch-only, trusted before secrets, and never receives write-capable provider credentials", async () => {
  const source = await readFile(new URL(`../${workflow}`, import.meta.url), "utf8");
  assert.match(source, /on:\n  workflow_dispatch:\n/u);
  assert.doesNotMatch(source, /pull_request|workflow_run|push:|inputs:|id-token:|write|npm |wrangler/u);
  assert.match(source, /github\.ref == 'refs\/heads\/main' && github\.run_attempt == 1/u);
  assert.match(source, /ref: \$\{\{ github\.sha \}\}\n          persist-credentials: false/u);
  assert.ok(source.indexOf("--verify-context") < source.indexOf("secrets."));
  assert.deepEqual([...source.matchAll(/secrets\.([A-Z_]+)/gu)].map(m => m[1]).sort(),
    ["ATRINIK_DELIVERY_RESOURCE_POLICY", "ATRINIK_DELIVERY_RESOURCE_READ_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]);
});
