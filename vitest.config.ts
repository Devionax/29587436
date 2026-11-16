import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globalSetup: ["./tests/setup/global-setup.ts"],
    setupFiles: ["./tests/setup/env.ts"],
    testTimeout: 30_000,
    hookTimeout: 180_000,
    // Graceful Postgres shutdown is capped at 20s in the test harness; this
    // only bounds how long Vitest waits afterwards for worker handles to close.
    teardownTimeout: 30_000,
    // Tests share one database cluster; keep files sequential.
    fileParallelism: false,
  },
});
