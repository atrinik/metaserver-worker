import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
export const directoryInterfacePath = "deployment/directory-reconciliation-interface.json";
const supported = {
  schemaVersion: 1,
  entrypoint: "DirectoryReconciliation",
  transport: "service-binding-rpc",
  method: "reconcile",
  argumentCount: 0,
  request: { method: "POST", url: "https://internal.atrinik.invalid/v1/directory-reconciliation", body: null },
  receipt: { schema: "directory-reconciliation-v1", maximumBytes: 4096, profiles: ["classic-v3", "game-v2"] },
};
export const incompatibleDirectoryInterface =
  "selected source directory reconciliation interface is missing or unsupported";

// Read only data, never import or execute selected-source compatibility code.
// Live delivery/planning require the exact regular blob from selected HEAD;
// local validation/dry runs can check a candidate before it is committed.
export async function readDirectoryInterface(sourceRoot, { committed = true } = {}) {
  try {
    const path = resolve(sourceRoot, directoryInterfacePath);
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.size > 4096) throw new Error();
    const bytes = await readFile(path);
    if (bytes.byteLength > 4096 || bytes.toString("utf8") !==
      `${JSON.stringify(supported, null, 2)}\n`) throw new Error();
    let sourceSha = null;
    if (committed) {
      const git = async (...args) => (await execute("git", ["--no-pager", "-C", sourceRoot, ...args],
        { encoding: "utf8", maxBuffer: 8192, timeout: 10_000,
          env: { PATH: process.env.PATH, LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null" } })).stdout;
      sourceSha = (await git("rev-parse", "HEAD")).trim();
      if (!/^[0-9a-f]{40}$/u.test(sourceSha)) throw new Error();
      const tree = await git("ls-tree", sourceSha, "--", directoryInterfacePath);
      if (!/^100644 blob [0-9a-f]{40}\tdeployment\/directory-reconciliation-interface\.json\n$/u.test(tree))
        throw new Error();
      if ((await git("show", `${sourceSha}:${directoryInterfacePath}`)) !== bytes.toString("utf8"))
        throw new Error();
    }
    return { sourceSha, digest: createHash("sha256").update(bytes).digest("hex") };
  } catch { throw new Error(incompatibleDirectoryInterface); }
}
