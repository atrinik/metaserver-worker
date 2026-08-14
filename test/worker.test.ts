import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  createScheduledController,
} from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import worker from "../src/index";
import type { CoreEnv } from "../src/core-env";

function overrideEnv(overrides: Partial<CoreEnv>): CoreEnv {
  return new Proxy(env as CoreEnv, {
    get(target, property, receiver) {
      if (Object.prototype.hasOwnProperty.call(overrides, property)) {
        return Reflect.get(overrides, property);
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

describe("domainless core Worker", () => {
  it("exports no public fetch handler", () => {
    expect(Object.keys(worker)).toEqual(["scheduled"]);
    expect("fetch" in worker).toBe(false);
  });

  it("reconciles both directory profiles on the five-minute schedule", async () => {
    const reconcile = vi.fn(async () => {});
    const getByName = vi.fn(() => ({ reconcile }));
    await worker.scheduled(
      createScheduledController({ cron: "*/5 * * * *" }),
      overrideEnv({
        DIRECTORY_BUILDER: { getByName } as unknown as CoreEnv["DIRECTORY_BUILDER"],
      }),
      createExecutionContext(),
    );
    expect(getByName.mock.calls).toEqual([
      ["classic-v1"],
      ["classic-v2"],
      ["game-v1"],
    ]);
    expect(reconcile).toHaveBeenCalledTimes(3);
  });

  it("sanitizes scheduled configuration failures", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(worker.scheduled(
      createScheduledController(),
      overrideEnv({ LISTING_TTL_SECONDS: "0" }),
      createExecutionContext(),
    )).rejects.toThrow("Scheduled maintenance failed");
    expect(logged.mock.calls).toEqual([[{
      event: "unexpected_error",
      handler: "scheduled",
      code: "maintenance_failure",
    }]]);
  });
});
