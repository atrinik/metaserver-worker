import { defineConfig } from "vitest/config";
export default defineConfig({
  cacheDir: "./.wrangler/development-vitest",
  test: {
    environment: "node",
    include: ["development/core.test.ts"],
    testTimeout: 10_000,
  },
});
