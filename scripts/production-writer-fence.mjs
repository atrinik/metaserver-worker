// Copyright (C) 2026 Atrinik contributors
import { productionReadFailure } from "./production-read-pacing.mjs";
import { normalizeTransitionTrigger, transitionDigest, validateProductionWriterFence } from "./deployment-environment-transition.mjs";

const stop = () => { throw new Error("production writer fence could not be verified"); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
function validProviderTimestamp(value) {
  if (typeof value !== "string") return false;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/u.exec(value);
  if (!parts) return false;
  const [, year, month, day, hour, minute, second, offsetHour = "0", offsetMinute = "0"] = parts;
  const leapYear = Number(year) % 4 === 0 && (Number(year) % 100 !== 0 || Number(year) % 400 === 0);
  const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return Number(month) >= 1 && Number(month) <= 12 && Number(day) >= 1 &&
    Number(day) <= monthDays[Number(month) - 1] && Number(hour) <= 23 &&
    Number(minute) <= 59 && Number(second) <= 59 && Number(offsetHour) <= 23 && Number(offsetMinute) <= 59;
}

// Provider observation metadata is not part of the sealed build environment.
// GET environment_variables documents created_on; preserve only governed fields.
export function normalizeBuildEnvironment(environment) {
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) stop();
  return Object.fromEntries(Object.entries(environment).map(([name, entry]) => {
    if (!/^[A-Z][A-Z0-9_]*$/u.test(name) || !entry || typeof entry !== "object" || Array.isArray(entry) ||
        Object.keys(entry).some(key => !["created_on", "is_secret", "value"].includes(key)) ||
        typeof entry.is_secret !== "boolean" ||
        (entry.is_secret ? entry.value !== null : typeof entry.value !== "string") ||
        (Object.hasOwn(entry, "created_on") && !validProviderTimestamp(entry.created_on))) stop();
    return [name, { is_secret: entry.is_secret, value: entry.value }];
  }));
}

// This proves only eligibility to wait, never permission to write. The ordinary
// validator still requires every build stopped at the final observation.
function inertDrainBuilds(snapshot, policy) {
  if (policy.disposition !== "retained-inert-builds") stop();
  validateProductionWriterFence({ ...snapshot, builds: [] }, policy);
  const identities = new Map();
  for (const build of snapshot.builds) {
    if (!uuid.test(build.build_uuid) || identities.has(build.build_uuid) ||
        !["queued", "initializing", "running", "stopped"].includes(build.status) ||
        ![policy.productionTriggerUuid, policy.reviewTriggerUuid].includes(build.trigger?.trigger_uuid) ||
        build.trigger.external_script_id !== policy.externalScriptId) stop();
    if (build.status !== "stopped") {
      const current = snapshot.triggers.find(trigger => trigger.trigger_uuid === build.trigger.trigger_uuid);
      const { build_token_uuid: token, ...expected } = normalizeTransitionTrigger(current);
      const { build_token_uuid: observedToken, ...observed } = normalizeTransitionTrigger(build.trigger);
      const metadata = build.build_trigger_metadata;
      if (transitionDigest(expected) !== transitionDigest(observed) ||
          (observedToken !== undefined && observedToken !== token) ||
          metadata?.build_token_uuid !== token || metadata.build_command !== "exit 1" ||
          metadata.deploy_command !== "exit 1" || metadata.root_directory !== current.root_directory ||
          metadata.provider_type !== "github" || metadata.provider_account_name !== "atrinik" ||
          metadata.repo_name !== "metaserver-worker" || typeof metadata.branch !== "string" ||
          !metadata.branch || (build.trigger.trigger_uuid === policy.productionTriggerUuid
            ? metadata.branch !== "main" : metadata.branch === "main") ||
          transitionDigest(normalizeBuildEnvironment(metadata.environment_variables)) !==
            transitionDigest(snapshot.environments[current.trigger_uuid])) stop();
    }
    identities.set(build.build_uuid, {
      status: build.status,
      launch: transitionDigest({ trigger: build.trigger, metadata: build.build_trigger_metadata }),
    });
  }
  return identities;
}

export async function assertProductionPromotionWriterFence({ environment, fetcher = fetch,
  allowDrain = false, now = () => performance.now(),
  wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)) }) {
  try {
    let deadline;
    let waited = false;
    let drainedIdentities;
    const remaining = () => {
      const value = deadline === undefined ? 20_000 : deadline - now();
      if (!Number.isFinite(value) || value <= 0) stop();
      return Math.max(1, Math.ceil(Math.min(20_000, value)));
    };
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
        headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(remaining()),
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
    let first = await capture();
    if (allowDrain && first.builds.some(build => build.status !== "stopped")) {
      let identities = inertDrainBuilds(first, policy);
      const controls = transitionDigest({ triggers: first.triggers, environments: first.environments, peers: first.peers });
      deadline = now() + 60_000;
      if (!Number.isFinite(deadline)) stop();
      // A fixed attempt bound also fails closed if an injected clock stops advancing.
      for (let attempt = 0; ; attempt += 1) {
        remaining();
        if (attempt === 12) stop();
        await wait(Math.min(5_000, remaining()));
        waited = true;
        remaining();
        const current = await capture();
        remaining();
        const next = inertDrainBuilds(current, policy);
        if (transitionDigest({ triggers: current.triggers, environments: current.environments, peers: current.peers }) !== controls ||
            identities.size !== next.size) stop();
        for (const [id, value] of next) {
          const previous = identities.get(id);
          if (!previous || previous.launch !== value.launch ||
              (previous.status === "stopped" && value.status !== "stopped")) stop();
        }
        first = current;
        identities = next;
        if (first.builds.every(build => build.status === "stopped")) break;
      }
      drainedIdentities = identities;
    }
    validateProductionWriterFence(first, policy);
    const second = await capture();
    const validation = validateProductionWriterFence(second, policy);
    if (drainedIdentities) {
      const finalIdentities = inertDrainBuilds(second, policy);
      if (finalIdentities.size !== drainedIdentities.size || [...finalIdentities].some(([id, value]) =>
        value.launch !== drainedIdentities.get(id)?.launch)) stop();
    }
    // Build status changes in the review trigger do not own PROD; control-plane equality is exact.
    if (transitionDigest({ triggers: first.triggers, environments: first.environments, peers: first.peers }) !==
        transitionDigest({ triggers: second.triggers, environments: second.environments, peers: second.peers })) stop();
    if (waited) remaining();
    return { ...validation, waited };
  } catch (error) {
    if (productionReadFailure(error)) throw error;
    stop();
  }
}
