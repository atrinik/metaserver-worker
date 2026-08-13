import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const projectDirectory = path.dirname(fileURLToPath(import.meta.url));
const TEST_SOURCE_TAG_KEY_CURRENT =
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TEST_SOURCE_TAG_KEY_PREVIOUS =
  "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";

// Wrangler validates required secret names while loading the config, before
// Miniflare applies its binding overrides. These public test vectors keep that
// validation quiet and are also the exact values injected into the runtime.
process.env.SOURCE_TAG_KEY_CURRENT ??= TEST_SOURCE_TAG_KEY_CURRENT;
process.env.SOURCE_TAG_KEY_PREVIOUS ??= TEST_SOURCE_TAG_KEY_PREVIOUS;
process.env.DIRECTORY_CACHE_PURGE_TOKEN ??=
  "test-directory-cache-purge-token";

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
          SOURCE_TAG_KEY_CURRENT: TEST_SOURCE_TAG_KEY_CURRENT,
          SOURCE_TAG_KEY_PREVIOUS: TEST_SOURCE_TAG_KEY_PREVIOUS,
          DIRECTORY_CACHE_PURGE_TOKEN: "test-directory-cache-purge-token",
          PUBLISH_SERVER_DAILY_LIMIT: "8",
          RENDEZVOUS_SERVER_DAILY_LIMIT: "8",
          RENDEZVOUS_CLIENT_PAIR_BURST_LIMIT: "20",
          RENDEZVOUS_CLIENT_PAIR_WINDOW_SECONDS: "60",
          RENDEZVOUS_CLIENT_PAIR_INITIAL_COOLDOWN_SECONDS: "30",
          RENDEZVOUS_CLIENT_PAIR_MAXIMUM_COOLDOWN_SECONDS: "900",
          RENDEZVOUS_CLIENT_PAIR_RESET_SECONDS: "1800",
          RENDEZVOUS_ACTIVE_CLIENT_LIMIT: "16",
          RENDEZVOUS_CLIENT_SESSION_SECONDS: "15",
        },
      },
    })),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
