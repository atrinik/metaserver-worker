import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { developmentWorkerNames, promotionEnvironmentNames } from "./delivery-targets.mjs";
import { assertDirectoryBuildContext, DIRECTORY_RECONCILIATION_BUDGET_SECONDS } from "./production-delivery.mjs";
import { markDirectoryFailure, directoryFailureLine } from "./directory-reconciliation-diagnostics.mjs";

// The deadline covers all three paced authority checks plus proxy startup and
// the request. Leave the parent's budget enough room for startup and cleanup.
const STAGE_TIMEOUT_MS = (DIRECTORY_RECONCILIATION_BUDGET_SECONDS - 30) * 1_000;

// This helper is only entered by the production parent after its live fences.
// Its provider-backed observer receives the existing lease token separately from
// proxy bindings; the token is removed from the process environment before Wrangler.
const CLEANUP_TIMEOUT_MS = 10_000;
export function validateDirectoryProxyInput(config, environment) {
  const target = environment.ATRINIK_DELIVERY_ENVIRONMENT;
  const coordinatesValid = target === "development"
    ? environment.GITHUB_ACTIONS === "true" && environment.GITHUB_EVENT_NAME === "workflow_run" &&
      /^[0-9a-f]{40}$/u.test(environment.ATRINIK_DEVELOPMENT_SHA ?? "")
    : target === "production" && environment.GITHUB_ACTIONS === "true" &&
      environment.GITHUB_EVENT_NAME === "workflow_dispatch" &&
      /^[0-9a-f]{40}$/u.test(environment.ATRINIK_PROMOTION_SHA ?? "");
  if (!coordinatesValid ||
      !environment.CLOUDFLARE_API_TOKEN ||
      !/^[0-9a-f]{32}$/u.test(config?.account_id ?? "") ||
      config.account_id !== environment.CLOUDFLARE_ACCOUNT_ID ||
      typeof config.compatibility_date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(config.compatibility_date) ||
      JSON.stringify(config) !== JSON.stringify({
        name: `atrinik-${target}-directory-reconciliation`,
        account_id: config.account_id,
        compatibility_date: config.compatibility_date,
        workers_dev: false,
        preview_urls: false,
        services: [{
          binding: "DIRECTORY_RECONCILIATION", service: target === "development"
            ? developmentWorkerNames[0] : "atrinik-metaserver",
          entrypoint: "DirectoryReconciliation", remote: true,
        }],
      })) throw new Error("directory proxy authority rejected");
}

async function boundedCleanup(operation, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("directory proxy cleanup deadline exceeded")),
          milliseconds);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

export async function invokeDirectoryProxy({ configPath, config, environment,
  authorize, createProxy, timeoutMs = STAGE_TIMEOUT_MS, cleanupTimeoutMs = CLEANUP_TIMEOUT_MS }) {
  try {
    validateDirectoryProxyInput(config, environment);
    if (typeof authorize !== "function") throw new Error("directory proxy live authority missing");
  } catch (error) { throw markDirectoryFailure(error, "configuration"); }
  let phase = "authority-before-proxy";
  let timer;
  let proxy;
  let reader;
  let stopped = false;
  const abort = new AbortController();
  const assertRunning = () => {
    if (stopped || abort.signal.aborted) throw new Error("directory proxy deadline exceeded");
  };
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      stopped = true;
      abort.abort();
      reject(new Error("directory proxy deadline exceeded"));
    }, timeoutMs);
  });
  try {
    const operation = (async () => {
      await authorize();
      assertRunning();
      phase = "proxy-initialization";
      const acquired = await createProxy({ configPath, persist: false, remoteBindings: true });
      if (stopped) {
        await boundedCleanup(() => acquired.dispose(), cleanupTimeoutMs);
        throw new Error("directory proxy initialization expired");
      }
      proxy = acquired;
      // Initialization can take long enough to lose current-main or the lease.
      phase = "authority-before-request";
      await authorize();
      assertRunning();
      phase = "request";
      // Node's Request is not the SDK's Request, and its HTTP bridge adds
      // transport headers. The zero-argument RPC constructs the canonical
      // empty POST inside workerd instead. The deadline disposes the proxy;
      // it cannot roll back reconciliation already accepted by the core.
      const response = await proxy.env.DIRECTORY_RECONCILIATION.reconcile();
      if (stopped && response.body) {
        await boundedCleanup(() => response.body.cancel(), cleanupTimeoutMs);
      }
      assertRunning();
      phase = "response";
      if (response.status !== 200 || response.headers.get("Content-Type") !== "application/json" ||
          response.headers.get("Cache-Control") !== "no-store") {
        if (response.body) await response.body.cancel();
        throw new Error(response.status === 200 ? "directory proxy response rejected"
          : `directory proxy response rejected (http=${response.status})`);
      }
      phase = "receipt";
      // Read a bounded receipt before parsing; raw provider output never escapes.
      if (!response.body) throw new Error("directory proxy receipt missing");
      reader = response.body.getReader();
      const chunks = [];
      let bytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        assertRunning();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 4_096) throw new Error("directory proxy receipt too large");
        chunks.push(value);
      }
      let receipt;
      try { receipt = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { throw new Error("directory proxy receipt invalid"); }
      phase = "authority-after-receipt";
      await authorize();
      assertRunning();
      return receipt;
    })();
    return await Promise.race([operation, deadline]);
  } catch (error) {
    throw markDirectoryFailure(error, phase);
  } finally {
    stopped = true;
    abort.abort();
    clearTimeout(timer);
    // Cancellation and disposal share one independent bound, even when reads or
    // provider cleanup never settle. A cleanup timeout is a failed stage.
    try {
      await boundedCleanup(async () => {
        const results = await Promise.allSettled([
          reader ? reader.cancel() : Promise.resolve(),
          proxy ? proxy.dispose() : Promise.resolve(),
        ]);
        if (results.some((result) => result.status === "rejected"))
          throw new Error("directory proxy cleanup failed");
      }, cleanupTimeoutMs);
    } catch (error) { throw markDirectoryFailure(error, "cleanup"); }
  }
}

async function main() {
  if (process.argv.length !== 3) throw new Error("directory proxy invocation rejected");
  const configPath = resolve(process.argv[2]);
  const config = JSON.parse(await readFile(configPath, "utf8"));
  validateDirectoryProxyInput(config, process.env);
  const environment = { ...process.env };
  // The read-only authority checker retains these credentials in its private
  // closure; Wrangler and its remote-binding subprocesses cannot inherit them.
  for (const name of promotionEnvironmentNames) delete process.env[name];
  process.env.WRANGLER_LOG = "error";
  const receipt = await invokeDirectoryProxy({
    configPath, config, environment,
    authorize: () => assertDirectoryBuildContext(config, environment),
    createProxy: async (options) => {
      const { getPlatformProxy } = await import("wrangler");
      return getPlatformProxy(options);
    },
  });
  console.log(JSON.stringify(receipt));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(directoryFailureLine(error));
    process.exitCode = 1;
  });
}
