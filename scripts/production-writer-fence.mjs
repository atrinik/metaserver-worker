// Copyright (C) 2026 Atrinik contributors
import { transitionDigest, validateProductionWriterFence } from "./deployment-environment-transition.mjs";

const stop = () => { throw new Error("production writer fence could not be verified"); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
// Provider observation metadata is not part of the sealed build environment.
// GET environment_variables documents created_on; preserve only governed fields.
export function normalizeBuildEnvironment(environment) {
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) stop();
  return Object.fromEntries(Object.entries(environment).map(([name, entry]) => {
    if (!/^[A-Z][A-Z0-9_]*$/u.test(name) || !entry || typeof entry !== "object" || Array.isArray(entry) ||
        Object.keys(entry).some(key => !["created_on", "is_secret", "value"].includes(key)) ||
        typeof entry.is_secret !== "boolean" ||
        (entry.is_secret ? entry.value !== null : typeof entry.value !== "string") ||
        (Object.hasOwn(entry, "created_on") &&
          (typeof entry.created_on !== "string" ||
           !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(entry.created_on) ||
           !Number.isFinite(Date.parse(entry.created_on))))) stop();
    return [name, { is_secret: entry.is_secret, value: entry.value }];
  }));
}

export async function assertProductionPromotionWriterFence({ environment, fetcher = fetch }) {
  try {
    const account = environment.CLOUDFLARE_ACCOUNT_ID;
    const token = environment.ATRINIK_PRODUCTION_BUILDS_READ_TOKEN;
    const policy = JSON.parse(environment.ATRINIK_PRODUCTION_WRITER_FENCE_POLICY);
    if (!/^[0-9a-f]{32}$/u.test(account) || !token || policy.accountId !== account ||
        policy.scriptName !== "atrinik-metaserver" || !/^[0-9a-f]{32}$/u.test(policy.externalScriptId) ||
        !uuid.test(policy.productionTriggerUuid) || !uuid.test(policy.reviewTriggerUuid) ||
        policy.productionTriggerUuid === policy.reviewTriggerUuid ||
        !Array.isArray(policy.workers) || policy.workers.length !== 3 ||
        new Set(policy.workers.map((w) => w.tag)).size !== 3 ||
        JSON.stringify(policy.workers.map((w) => w.name).sort()) !== JSON.stringify([
          "atrinik-metaserver", "atrinik-metaserver-publisher", "atrinik-metaserver-rendezvous"]) ||
        policy.workers.some((w) => !/^[0-9a-f]{32}$/u.test(w.tag)) ||
        policy.workers.find((w) => w.name === policy.scriptName)?.tag !== policy.externalScriptId ||
        !Array.isArray(policy.developmentWorkers) || policy.developmentWorkers.length !== 3 ||
        JSON.stringify(policy.developmentWorkers.map((w) => w.name).sort()) !== JSON.stringify([
          "atrinik-metaserver-development", "atrinik-metaserver-development-publisher",
          "atrinik-metaserver-development-rendezvous"]) ||
        policy.developmentWorkers.some((w) => !/^[0-9a-f]{32}$/u.test(w.tag)) ||
        new Set([...policy.workers, ...policy.developmentWorkers].map((w) => w.tag)).size !== 6) stop();
    const get = async (path) => {
      const response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {
        headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) stop();
      let bytes = 0;
      const chunks = [];
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > 1024 * 1024) stop();
        chunks.push(Buffer.from(chunk));
      }
      const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (envelope.success !== true || envelope.errors?.length) stop();
      return envelope;
    };
    const staticList = async (path, identity, maximum = 10000) => {
      // Scripts and trigger endpoints document no pagination query parameters.
      const response = await get(path);
      const rows = response.result;
      if (!Array.isArray(rows) || rows.length > maximum ||
          new Set(rows.map(identity)).size !== rows.length || rows.some((r) => !identity(r))) stop();
      const info = response.result_info;
      if (info && ((info.total_count !== undefined && info.total_count !== rows.length) ||
          (info.total_pages !== undefined && info.total_pages > 1) || info.next_page === true)) stop();
      return rows.sort((a, b) => identity(a).localeCompare(identity(b)));
    };
    const list = async (path, identity) => {
      const rows = [], seen = new Set();
      let expectedTotal;
      for (let page = 1; page <= 100; ++page) {
        const response = await get(`${path}?page=${page}&per_page=200`);
        if (!Array.isArray(response.result)) stop();
        let info = response.result_info;
        // Builds returns an unpaginated empty envelope, or total_pages=0, for no history.
        if (page === 1 && response.result.length === 0 && (!info ||
            (info.total_pages === 0 && info.total_count === 0 && info.page === 1 && info.next_page === false)))
          info = { page: 1, count: 0, total_count: 0, total_pages: 1 };
        if (!info || info.page !== page || !Number.isSafeInteger(info.total_count) ||
            info.total_count < 0 || !Number.isSafeInteger(info.total_pages) ||
            info.total_pages < 1 || info.total_pages > 100 ||
            (info.count !== undefined && info.count !== response.result.length) ||
            (expectedTotal !== undefined && expectedTotal !== info.total_count)) stop();
        expectedTotal = info.total_count;
        for (const row of response.result) {
          const id = identity(row);
          if (!id || seen.has(id)) stop();
          seen.add(id); rows.push(row);
        }
        if (page === info.total_pages) {
          if (rows.length !== expectedTotal) stop();
          return rows.sort((a, b) => identity(a).localeCompare(identity(b)));
        }
      }
      stop();
    };
    const capture = async () => {
      const scripts = await staticList("/workers/scripts", (r) => r.id);
      const script = scripts.filter((r) => r.id === policy.scriptName);
      if (script.length !== 1 || script[0].tag !== policy.externalScriptId) stop();
      const peers = [];
      for (const worker of [...policy.workers, ...policy.developmentWorkers]) {
        const matches = scripts.filter((r) => r.id === worker.name);
        if (matches.length !== 1 || matches[0].tag !== worker.tag) stop();
        if (worker.name === policy.scriptName) continue;
        const triggers = await staticList(`/builds/workers/${worker.tag}/triggers`, (r) => r.trigger_uuid, 2);
        const builds = await list(`/builds/workers/${worker.tag}/builds`, (r) => r.build_uuid);
        if (triggers.length || builds.some((b) => b.status !== "stopped")) stop();
        peers.push({ name: worker.name, tag: worker.tag, triggers });
      }
      const triggers = await staticList(`/builds/workers/${policy.externalScriptId}/triggers`, (r) => r.trigger_uuid, 2);
      const environments = {};
      for (const id of [policy.productionTriggerUuid, policy.reviewTriggerUuid])
        environments[id] = normalizeBuildEnvironment((await get(`/builds/triggers/${id}/environment_variables`)).result);
      const builds = await list(`/builds/workers/${policy.externalScriptId}/builds`, (r) => r.build_uuid);
      return { triggers, environments, builds, peers };
    };
    const first = await capture();
    validateProductionWriterFence(first, policy);
    const second = await capture();
    const validation = validateProductionWriterFence(second, policy);
    // Build status changes in the review trigger do not own PROD; control-plane equality is exact.
    if (transitionDigest({ triggers: first.triggers, environments: first.environments, peers: first.peers }) !==
        transitionDigest({ triggers: second.triggers, environments: second.environments, peers: second.peers })) stop();
    return validation;
  } catch { stop(); }
}
