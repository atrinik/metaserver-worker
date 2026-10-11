import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import application, { handlePublisherCoordinatorRequest } from "../src/index";
import type { CoreEnv } from "../src/core-env";
import { logUnexpectedError } from "../src/diagnostics";
import { classifyCanonicalPublisherRoute } from "../src/routes";
import {
  enabled,
  MAINTENANCE_NAME,
  MaintenanceScheduler,
} from "./maintenance";

export {
  DirectoryBuilder,
  DirectoryReconciliation,
  RendezvousRoom,
  RendezvousCoordinator,
  RendezvousHealth,
} from "../src/index";
export default application;

export type DevelopmentEnv = CoreEnv & {
  DEVELOPMENT_MAINTENANCE: string;
  DEVELOPMENT_MAINTENANCE_DO: DurableObjectNamespace<DevelopmentMaintenance>;
};

export class DevelopmentMaintenance extends DurableObject<DevelopmentEnv> {
  private scheduler: MaintenanceScheduler;

  constructor(ctx: DurableObjectState, env: DevelopmentEnv) {
    super(ctx, env);
    if (ctx.id.name !== MAINTENANCE_NAME) {
      throw new Error("Invalid development maintenance identity");
    }
    this.scheduler = new MaintenanceScheduler(
      ctx.storage,
      () => enabled(env),
      async (cron, scheduledTime) => {
        await application.scheduled(
          { cron, scheduledTime, noRetry() {} },
          env,
          ctx as unknown as ExecutionContext,
        );
      },
    );
  }

  async start(): Promise<void> {
    return this.scheduler.start();
  }

  async alarm(): Promise<void> {
    return this.scheduler.alarm();
  }
}

/** Same authenticated handler; only a successful canonical Classic v3 publish can bootstrap. */
export class PublisherCoordinator extends WorkerEntrypoint<DevelopmentEnv> {
  async fetch(request: Request): Promise<Response> {
    let classicPublish = false;
    if (enabled(this.env)) {
      try {
        const headers = new Headers(request.headers);
        headers.delete("Transfer-Encoding");
        classicPublish = classifyCanonicalPublisherRoute({
          target: request.url,
          method: request.method,
          headers,
          hasBody: request.body !== null,
        }, "publish.dev.meta.atrinik.org").publisherProfile === "classic-v3";
      } catch {
        // The unchanged authenticated handler owns request rejection.
      }
    }
    const response = await handlePublisherCoordinatorRequest(
      request,
      this.env,
      this.ctx,
    );
    if (classicPublish && response.status === 200) {
      // Constant-name/private RPC. Coalesced durable initialization does no
      // external work, and errors never replace the authenticated response.
      try {
        this.ctx.waitUntil(bootstrap(this.env).catch(reportBootstrapFailure));
      } catch {
        reportBootstrapFailure();
      }
    }
    return response;
  }
}

async function bootstrap(env: DevelopmentEnv): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      env.DEVELOPMENT_MAINTENANCE_DO.getByName(MAINTENANCE_NAME).start(),
      new Promise<void>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error("Development maintenance bootstrap deadline"));
        }, 5_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function reportBootstrapFailure(): void {
  try {
    logUnexpectedError("scheduled", "maintenance_failure");
  } catch {
    // Never replace a committed publisher response.
  }
}
