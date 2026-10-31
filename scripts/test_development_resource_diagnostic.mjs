// Copyright (C) 2026 Atrinik contributors
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { diagnoseDevelopmentResources, verifyContext, formatDiagnostic } from "./diagnose-development-resources.mjs";
import { validateDiagnosticWorker } from "./development-resource-differences.mjs";
import publicNames from "./diagnostic-public-names.json" with { type: "json" };

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

test("public names are exactly the role-scoped checked-in source declarations", async () => {
  for (const [role, file] of [["core", "wrangler.jsonc"], ["publisher", "wrangler.publisher.jsonc"],
    ["rendezvous", "wrangler.rendezvous.jsonc"]]) {
    const config = JSON.parse(await readFile(new URL(`../${file}`, import.meta.url), "utf8"));
    assert.deepEqual(publicNames[role], {
      resources: [...(config.d1_databases ?? []), ...(config.r2_buckets ?? []), ...(config.analytics_engine_datasets ?? [])]
        .map(value => value.binding).concat([...(config.ratelimits ?? []), ...(config.durable_objects?.bindings ?? [])]
          .map(value => value.name)).sort(),
      variables: Object.keys(config.vars ?? {}).sort(), secrets: [...(config.secrets?.required ?? [])].sort(),
    });
  }
});

function withCoreBindings(f, bindings) {
  f.environment.ATRINIK_DELIVERY_RESOURCE_POLICY = JSON.stringify(f.policy);
  const base = f.fetcher;
  f.fetcher = async (url, options) => url.endsWith("/workers/scripts/atrinik-metaserver/settings")
    ? Response.json({ success: true, result: { bindings } }) : base(url, options);
}

test("public comparisons pair by name and resource type despite order and private insertions", async () => {
  const f = fixture(), core = f.policy.cohorts[0].workers[0];
  core.resources = [{ binding: "DB", type: "d1", id: secret },
    { binding: "DIRECTORY_METRICS", type: "analytics", id: "unchanged" }];
  core.variables = [{ binding: "PUBLISH_ENABLED", value: secret },
    { binding: "GAME_PUBLISH_ENABLED", value: "unchanged" }];
  core.secrets = ["SOURCE_TAG_KEY_CURRENT", "SOURCE_TAG_KEY_PREVIOUS", secret];
  withCoreBindings(f, [
    { name: "GAME_PUBLISH_ENABLED", type: "plain_text", text: "unchanged" },
    { name: "PUBLISH_ENABLED", type: "plain_text", text: "private-provider-value" },
    { name: secret, type: "plain_text", text: secret },
    { name: "DIRECTORY_METRICS", type: "analytics_engine", dataset: "unchanged" },
    { name: "DB", type: "d1", id: "private-provider-value" },
    { name: "SOURCE_TAG_KEY_CURRENT", type: "secret_text" },
  ]);
  const result = await run(f), collections = result.rows[0].collections;
  assert.equal(result.outcome, "rejected"); assertSanitized(result);
  assert.deepEqual(collections.resources, { policyCount: 2, liveCount: 2, publicNames: [
    { binding: "DB", type: "d1", membership: "both", idDiffers: true },
    { binding: "DIRECTORY_METRICS", type: "analytics", membership: "both", idDiffers: false },
  ], unrecognized: { policyCount: 0, liveCount: 0 } });
  assert.deepEqual(collections.variables, { policyCount: 2, liveCount: 3, publicNames: [
    { binding: "GAME_PUBLISH_ENABLED", membership: "both", valueDiffers: false },
    { binding: "PUBLISH_ENABLED", membership: "both", valueDiffers: true },
  ], unrecognized: { policyCount: 0, liveCount: 1 } });
  assert.deepEqual(collections.secrets, { policyCount: 3, liveCount: 1, publicNames: [
    { binding: "SOURCE_TAG_KEY_CURRENT", membership: "both" },
    { binding: "SOURCE_TAG_KEY_PREVIOUS", membership: "policy-only" },
  ], unrecognized: { policyCount: 1, liveCount: 0 } });
});

test("resource type changes and collection collisions remain distinct memberships", async () => {
  const f = fixture(), core = f.policy.cohorts[0].workers[0];
  core.resources = [{ binding: "DB", type: "d1", id: secret }];
  core.variables = [{ binding: "PUBLISH_ENABLED", value: secret }];
  withCoreBindings(f, [{ name: "DB", type: "r2_bucket", bucket_name: secret },
    { name: "PUBLISH_ENABLED", type: "secret_text" },
    { name: "GAME_PUBLISH_ENABLED", type: "plain_text", text: secret }]);
  const result = await run(f), collections = result.rows[0].collections;
  assert.deepEqual(collections.resources.publicNames, [
    { binding: "DB", type: "d1", membership: "policy-only" },
    { binding: "DB", type: "r2", membership: "live-only" },
  ]);
  assert.deepEqual(collections.variables.publicNames, [
    { binding: "GAME_PUBLISH_ENABLED", membership: "live-only" },
    { binding: "PUBLISH_ENABLED", membership: "policy-only" },
  ]);
  assert.deepEqual(collections.secrets, { policyCount: 0, liveCount: 1, publicNames: [],
    unrecognized: { policyCount: 0, liveCount: 1 } });
  assertSanitized(result);
});

test("unknown names including serialization and prototype labels reveal only counts", async () => {
  const f = fixture(), core = f.policy.cohorts[0].workers[0];
  const names = [secret, "__proto__", "toJSON", "constructor", "private-provider-value\n/variables/DB"];
  core.secrets = names;
  core.resources = [{ binding: secret, type: "d1", id: secret }];
  withCoreBindings(f, [{ name: "private-provider-value", type: "r2_bucket", bucket_name: secret }]);
  const result = await run(f), collections = result.rows[0].collections;
  assert.deepEqual(collections.secrets, { policyCount: names.length, liveCount: 0, publicNames: [],
    unrecognized: { policyCount: names.length, liveCount: 0 } });
  assert.deepEqual(collections.resources, { policyCount: 1, liveCount: 1, publicNames: [],
    unrecognized: { policyCount: 1, liveCount: 1 } });
  const output = formatDiagnostic(result);
  for (const name of names) assert.equal(output.includes(name), false);
  assertSanitized(result);
});

test("collection summaries survive the field cap and unknown inventory growth", async () => {
  const f = fixture(), core = f.policy.cohorts[0].workers[0];
  core.resources = Array.from({ length: 150 }, (_, i) => ({ binding: `private-policy-${i}`, type: "d1", id: `private-id-${i}` }));
  core.variables = [{ binding: "PUBLISH_ENABLED", value: secret }];
  withCoreBindings(f, Array.from({ length: 150 }, (_, i) => ({ name: `private-live-${i}`, type: "r2_bucket", bucket_name: secret })));
  const result = await run(f), row = result.rows[0];
  assert.equal(row.fields.length, 128); assert.equal(row.fieldLimitReached, true);
  assert.deepEqual(row.collections.resources.unrecognized, { policyCount: 150, liveCount: 150 });
  assert.equal(row.collections.variables.publicNames[0].membership, "policy-only");
  assert.ok(Buffer.byteLength(formatDiagnostic(result)) < 10_000);
  assert.doesNotMatch(formatDiagnostic(result), /private-policy|private-live|private-id/u);
  assertSanitized(result);
});

test("duplicate live names and nested private provider fields reject without reflecting keys", async () => {
  for (const bindings of [
    [{ name: "DB", type: "d1", id: secret }, { name: "DB", type: "r2_bucket", bucket_name: secret }],
    [{ name: "DB", type: "d1", id: { [secret]: "private-provider-value" } }],
    [{ name: { [secret]: secret }, type: "secret_text" }],
    [{ name: "COORDINATOR", type: "service", service: { [secret]: secret }, entrypoint: "x" }],
  ]) {
    const f = fixture(); withCoreBindings(f, bindings);
    const result = await run(f);
    assert.equal(result.category, "resource-projection-rejected"); assertSanitized(result);
  }
});

test("projection validation rejects getters and hooks without invoking them", () => {
  for (const change of [
    worker => Object.defineProperty(worker, "name", { get() { assert.fail("getter invoked"); } }),
    worker => { worker.resources = [{ binding: "DB", get type() { assert.fail("getter invoked"); }, id: secret }]; },
    worker => { worker.resources = [{ binding: "DB", type: "d1", id: { toJSON() { assert.fail("hook invoked"); } } }]; },
    worker => { Object.defineProperty(worker.secrets, "0", { get() { assert.fail("getter invoked"); } }); },
    worker => { Object.defineProperty(worker.secrets, Symbol.iterator, { get() { assert.fail("iterator invoked"); } }); },
    worker => { worker.role = { toString() { assert.fail("role stringified"); } }; },
  ]) {
    const worker = fixture().policy.cohorts[0].workers[0]; change(worker);
    assert.throws(() => validateDiagnosticWorker(worker), /^Error: diagnostic projection rejected$/u);
  }
});

test("projection collection limit rejects excess before producing a partial inventory", async () => {
  const f = fixture();
  withCoreBindings(f, Array.from({ length: 4097 }, (_, index) => ({ name: `private-${index}`, type: "secret_text" })));
  const result = await run(f);
  assert.equal(result.category, "resource-projection-rejected");
  assert.equal(result.rows.length, 1); assert.equal(result.rows[0].collections, undefined);
  assertSanitized(result);
});

test("malicious response and error getters are reduced to closed failure categories", async () => {
  for (const response of [() => ({ get status() { throw new Error(secret); } }),
    () => { throw { get message() { assert.fail("error getter invoked"); }, toString() { assert.fail("error stringified"); } }; }]) {
    const f = fixture(), base = f.fetcher;
    f.fetcher = async (url, options) => new URL(url).origin === "https://api.cloudflare.com" ? response() : base(url, options);
    const result = await run(f);
    assert.equal(result.category, "resource-read-rejected"); assertSanitized(result);
  }
});

test("provider status objects cannot enter diagnostic output", async () => {
  const f = fixture(), base = f.fetcher;
  f.fetcher = async (url, options) => {
    const response = await base(url, options);
    if (new URL(url).origin === "https://api.cloudflare.com")
      return { status: { [secret]: secret }, ok: response.ok, body: response.body };
    return response;
  };
  const result = await run(f);
  assert.equal(result.outcome, "matched");
  assert.equal(result.rows.flatMap(row => row.requests).every(request => request.status === null), true);
  assertSanitized(result);
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
