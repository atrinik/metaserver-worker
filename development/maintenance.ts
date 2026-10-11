/** Development-only, constant-size alarm state; never store request identities. */
export const MAINTENANCE_NAME = "development-maintenance-v1";
export const MAINTENANCE_MARKER = "classic-development-alarms-v1";
export const STATE_KEY = "development-maintenance:v1";
const FIVE_MINUTES = 300_000;
const HOUR = 3_600_000;
const RETRY = 60_000;
const MAX_ATTEMPTS = 3;

type Gate = {
  DEVELOPMENT_MAINTENANCE?: string;
  PUBLISH_ENABLED?: string;
  RENDEZVOUS_ENABLED?: string;
  GAME_PUBLISH_ENABLED?: string;
  PUBLISH_HOSTNAME?: string;
  RENDEZVOUS_HOSTNAME?: string;
  CLASSIC_DIRECTORY_PUBLIC_ORIGIN?: string;
  GAME_DIRECTORY_PUBLIC_ORIGIN?: string;
  DIRECTORY_CACHE_ZONE_ID?: string;
};

export function enabled(env: Gate): boolean {
  // Resource ownership comes from the deployment role's fresh provider
  // metadata. This local fence contains no private account/zone identifiers.
  return env.DEVELOPMENT_MAINTENANCE === MAINTENANCE_MARKER &&
    env.PUBLISH_ENABLED === "enabled" && env.RENDEZVOUS_ENABLED === "enabled" &&
    env.GAME_PUBLISH_ENABLED === "disabled" &&
    env.PUBLISH_HOSTNAME === "publish.dev.meta.atrinik.org" &&
    env.RENDEZVOUS_HOSTNAME === "rendezvous.dev.meta.atrinik.org" &&
    env.CLASSIC_DIRECTORY_PUBLIC_ORIGIN === "https://classic.dev.meta.atrinik.org" &&
    env.GAME_DIRECTORY_PUBLIC_ORIGIN === "https://game.dev.meta.atrinik.org" &&
    typeof env.DIRECTORY_CACHE_ZONE_ID === "string" &&
    /^[0-9a-f]{32}$/.test(env.DIRECTORY_CACHE_ZONE_ID);
}

export function nextReconciliation(now: number): number {
  return (Math.floor(now / FIVE_MINUTES) + 1) * FIVE_MINUTES;
}

export function nextCleanup(now: number): number {
  const candidate = Math.floor(now / HOUR) * HOUR + 17 * 60_000;
  return candidate > now ? candidate : candidate + HOUR;
}

interface TaskState {
  due: number;
  attempts: number;
}
export interface MaintenanceState {
  version: 1;
  reconciliation: TaskState;
  cleanup: TaskState;
}

interface StorageTransaction {
  put(key: string, value: MaintenanceState): Promise<void>;
  delete(key: string): Promise<boolean>;
  setAlarm(time: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}
export interface MaintenanceStorage extends StorageTransaction {
  get<T>(key: string): Promise<T | undefined>;
  transaction<T>(callback: (transaction: StorageTransaction) => Promise<T>): Promise<T>;
}

type Work = (cron: "*/5 * * * *" | "17 * * * *", now: number) => Promise<void>;

function validState(value: unknown): value is MaintenanceState {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).sort().join() !== "cleanup,reconciliation,version") {
    return false;
  }
  const v = value as MaintenanceState;
  return v.version === 1 && [v.reconciliation, v.cleanup].every((task) =>
    task && typeof task === "object" && !Array.isArray(task) &&
    Object.keys(task).sort().join() === "attempts,due" &&
    Number.isSafeInteger(task.due) && task.due > 0 &&
    Number.isInteger(task.attempts) && task.attempts >= 0 &&
    task.attempts < MAX_ATTEMPTS
  );
}

/** One shared in-flight promise coalesces starts and prevents concurrent runs. */
export class MaintenanceScheduler {
  private active: Promise<void> | undefined;
  private activeKind: "start" | "alarm" | undefined;
  private storage: MaintenanceStorage;
  private gate: () => boolean;
  private work: Work;
  private clock: () => number;

  constructor(
    storage: MaintenanceStorage,
    gate: () => boolean,
    work: Work,
    clock = Date.now,
  ) {
    this.storage = storage;
    this.gate = gate;
    this.work = work;
    this.clock = clock;
  }

  start(): Promise<void> {
    return this.exclusive("start", () => this.initialize());
  }

  alarm(): Promise<void> {
    // An alarm consumed while start() is finishing must still run/rearm. An
    // authenticated start during an alarm may safely share the alarm's work.
    if (this.active !== undefined && this.activeKind === "start") {
      return this.active.then(() => this.alarm());
    }
    return this.exclusive("alarm", () => this.run());
  }

  private exclusive(
    kind: "start" | "alarm",
    action: () => Promise<void>,
  ): Promise<void> {
    if (this.active !== undefined) return this.active;
    const active = Promise.resolve().then(action);
    this.active = active;
    this.activeKind = kind;
    void active.finally(() => {
      if (this.active === active) {
        this.active = undefined;
        this.activeKind = undefined;
      }
    }).catch(() => undefined);
    return active;
  }

  private async reset(): Promise<void> {
    await this.storage.transaction(async (tx) => {
      await tx.deleteAlarm();
      await tx.delete(STATE_KEY);
    });
  }

  private async persist(state: MaintenanceState): Promise<void> {
    const alarm = Math.max(
      this.clock() + 1,
      Math.min(state.reconciliation.due, state.cleanup.due),
    );
    await this.storage.transaction(async (tx) => {
      await tx.put(STATE_KEY, state);
      await tx.setAlarm(alarm);
    });
  }

  private async initialize(): Promise<void> {
    if (!this.gate()) return this.reset();
    const previous = await this.storage.get<unknown>(STATE_KEY);
    if (previous !== undefined && !validState(previous)) {
      await this.reset();
      throw new Error("Invalid development maintenance state");
    }
    const now = this.clock();
    const state: MaintenanceState = previous ?? {
      version: 1,
      reconciliation: { due: now + 1, attempts: 0 },
      cleanup: { due: nextCleanup(now), attempts: 0 },
    };
    await this.persist(state);
  }

  private async run(): Promise<void> {
    if (!this.gate()) return this.reset();
    const previous = await this.storage.get<unknown>(STATE_KEY);
    if (!validState(previous)) {
      await this.reset();
      if (previous !== undefined) throw new Error("Invalid development maintenance state");
      return;
    }
    const state = structuredClone(previous);
    const now = this.clock();
    const tasks = (["reconciliation", "cleanup"] as const).filter(
      (name) => state[name].due <= now,
    );
    // Reserve bounded retries and arm recovery BEFORE any external operation.
    // A restart can repeat idempotent maintenance, but cannot lose its alarm.
    for (const name of tasks) {
      const attempts = state[name].attempts + 1;
      state[name] = attempts < MAX_ATTEMPTS
        ? { due: now + RETRY, attempts }
        : {
          due: name === "cleanup" ? nextCleanup(now) : nextReconciliation(now),
          attempts: 0,
        };
    }
    await this.persist(state);
    for (const name of tasks) {
      if (!this.gate()) return this.reset();
      try {
        await this.work(
          name === "cleanup" ? "17 * * * *" : "*/5 * * * *",
          now,
        );
      } catch {
        // Existing handlers emit fixed diagnostics. Persisted bounded retry
        // remains armed; no error value or request information is recorded.
        continue;
      }
      if (!this.gate()) return this.reset();
      state[name] = {
        due: name === "cleanup"
          ? nextCleanup(this.clock()) : nextReconciliation(this.clock()),
        attempts: 0,
      };
      await this.persist(state);
    }
  }
}
