// Copyright (C) 2026 Atrinik contributors
// GitHub supplies artifact runtime credentials only to this trusted Node action.
// The controller subprocess allowlists keep them out of selected source tooling.
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const controllerRoot = fileURLToPath(new URL("../", import.meta.url));
const controller = fileURLToPath(new URL("./production-promotion.mjs", import.meta.url));
const failure = JSON.stringify({ outcome: "production-promotion-stopped", reason: "pinned-node-launch-failed" });

export async function runPinnedPromotion({ environment = process.env, run = spawnSync,
  reportFailure = (record) => console.error(record) } = {}) {
  try {
    // setup-node installs this exact .nvmrc under the runner's tool cache. The
    // action host's node24 patch and PATH never select the controller runtime.
    const version = (await readFile(new URL("../.nvmrc", import.meta.url), "utf8")).trim();
    const cache = environment.RUNNER_TOOL_CACHE;
    if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch) ||
      !/^\d+\.\d+\.\d+$/u.test(version) || typeof cache !== "string" ||
      !isAbsolute(cache) || resolve(cache) !== cache || await realpath(cache) !== cache)
      throw new Error();
    const node = join(cache, "node", version, process.arch, "bin", "node");
    if (await realpath(node) !== node || !(await lstat(node)).isFile()) throw new Error();
    await access(node, constants.X_OK);
    const probe = run(node, ["--version"], { cwd: controllerRoot, env: {}, shell: false,
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5_000,
      killSignal: "SIGKILL", maxBuffer: 1024 });
    if (probe.error || probe.signal || probe.status !== 0 || probe.stdout !== `v${version}\n` || probe.stderr !== "")
      throw new Error();
    // Only this fixed trusted controller receives the action's artifact runtime
    // capabilities and deployment credentials. Never accept caller arguments or
    // Node preload configuration; the engine still sanitizes selected children.
    const childEnvironment = { ...environment };
    delete childEnvironment.NODE_OPTIONS;
    delete childEnvironment.NODE_PATH;
    const child = run(node, [controller, "--execute"], { cwd: controllerRoot,
      env: childEnvironment, shell: false, stdio: "inherit", timeout: 30 * 60 * 1000, killSignal: "SIGKILL" });
    if (child.error) throw new Error();
    if (Number.isInteger(child.status) && child.status >= 0 && child.status <= 255) return child.status;
    if (child.signal && Number.isInteger(osConstants.signals[child.signal])) return 128 + osConstants.signals[child.signal];
    throw new Error();
  } catch {
    // Do not reflect paths, process errors, probe output or credential contents.
    reportFailure(failure);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await runPinnedPromotion();
