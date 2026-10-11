import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const INTERNAL_URL = "https://internal.atrinik.invalid/v1/directory-reconciliation";
const STAGE_TIMEOUT_MS = 90_000;

// This helper is only entered by the production parent after its live fences.
// It receives deployment authentication, never the parent lease token or configs.
export function validateDirectoryProxyInput(config, environment) {
  if (environment.WORKERS_CI !== "1" || environment.WORKERS_CI_BRANCH !== "main" ||
      !/^[0-9a-f]{40}$/u.test(environment.WORKERS_CI_COMMIT_SHA ?? "") ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
        .test(environment.WORKERS_CI_BUILD_UUID ?? "") ||
      !environment.CLOUDFLARE_API_TOKEN ||
      !/^[0-9a-f]{32}$/u.test(config?.account_id ?? "") ||
      config.account_id !== environment.CLOUDFLARE_ACCOUNT_ID ||
      typeof config.compatibility_date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(config.compatibility_date) ||
      JSON.stringify(config) !== JSON.stringify({
        name: "atrinik-production-directory-reconciliation",
        account_id: config.account_id,
        compatibility_date: config.compatibility_date,
        workers_dev: false,
        preview_urls: false,
        services: [{
          binding: "DIRECTORY_RECONCILIATION", service: "atrinik-metaserver",
          entrypoint: "DirectoryReconciliation", remote: true,
        }],
      })) throw new Error("directory proxy authority rejected");
}

export async function invokeDirectoryProxy({ configPath, config, environment,
  createProxy, timeoutMs = STAGE_TIMEOUT_MS }) {
  validateDirectoryProxyInput(config, environment);
  let timer;
  let proxy;
  let stopped = false;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      stopped = true;
      reject(new Error("directory proxy deadline exceeded"));
    }, timeoutMs);
  });
  try {
    const operation = (async () => {
      const acquired = await createProxy({ configPath, persist: false, remoteBindings: true });
      if (stopped) {
        await acquired.dispose();
        throw new Error("directory proxy initialization expired");
      }
      proxy = acquired;
      const response = await proxy.env.DIRECTORY_RECONCILIATION.fetch(
        new Request(INTERNAL_URL, { method: "POST", redirect: "error" }));
      if (response.status !== 200 || response.headers.get("Content-Type") !== "application/json" ||
          response.headers.get("Cache-Control") !== "no-store")
        throw new Error("directory proxy response rejected");
      // Read a bounded receipt before parsing; raw provider output never escapes.
      if (!response.body) throw new Error("directory proxy receipt missing");
      const reader = response.body.getReader();
      const chunks = [];
      let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 4_096) throw new Error("directory proxy receipt too large");
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      const receipt = Buffer.concat(chunks).toString("utf8");
      return JSON.parse(receipt);
    })();
    return await Promise.race([operation, deadline]);
  } finally {
    stopped = true;
    clearTimeout(timer);
    if (proxy) await proxy.dispose();
  }
}

async function main() {
  if (process.argv.length !== 3) throw new Error("directory proxy invocation rejected");
  const configPath = resolve(process.argv[2]);
  const config = JSON.parse(await readFile(configPath, "utf8"));
  validateDirectoryProxyInput(config, process.env);
  // Suppress routine Wrangler output; only the bounded receipt uses stdout.
  process.env.WRANGLER_LOG = "error";
  const { getPlatformProxy } = await import("wrangler");
  const receipt = await invokeDirectoryProxy({
    configPath, config, environment: process.env, createProxy: getPlatformProxy,
  });
  console.log(JSON.stringify(receipt));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error("directory reconciliation stage failed");
    process.exitCode = 1;
  });
}
