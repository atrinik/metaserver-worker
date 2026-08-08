import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const projectDirectory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        d1Databases: ["DB"],
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(
            path.join(projectDirectory, "migrations"),
          ),
          COMPAT_HOSTNAME: "meta.example.test",
          SOURCE_TAG_KEY_CURRENT:
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          SOURCE_TAG_KEY_PREVIOUS:
            "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
          COMPAT_STATUS_DAILY_LIMIT: "8",
          COMPAT_DIRECTORY_DAILY_LIMIT: "8",
          COMPAT_OTP_DAILY_LIMIT: "48",
          COMPAT_UPDATE_SOURCE_DAILY_LIMIT: "48",
          COMPAT_UPDATE_SERVER_DAILY_LIMIT: "8",
          COMPAT_RENDEZVOUS_CLIENT_SOURCE_DAILY_LIMIT: "50",
          COMPAT_RENDEZVOUS_CLIENT_PAIR_DAILY_LIMIT: "10",
          COMPAT_RENDEZVOUS_SERVER_SOURCE_DAILY_LIMIT: "8",
          COMPAT_RENDEZVOUS_SERVER_DAILY_LIMIT: "8",
        },
      },
    })),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
