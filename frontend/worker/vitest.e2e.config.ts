import { defineConfig } from "vitest/config";

/**
 * The alerts end-to-end suite: real Postgres, ClickHouse and REST backend, with
 * only the Redis queue and the Slack client stubbed at the process boundary.
 * Kept out of `pnpm test` (see vitest.config.ts) because it needs the dev
 * stack up; run it with `pnpm test:e2e`. See src/alerts/__e2e__/README.md.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.e2e.test.ts"],
    // Scenarios share one database and one project namespace per file; the
    // files run one at a time so their cleanups cannot race.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
