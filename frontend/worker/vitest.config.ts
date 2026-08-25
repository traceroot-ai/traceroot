import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // The e2e suite needs live services; it has its own config (vitest.e2e.config.ts).
    exclude: ["**/node_modules/**", "**/*.e2e.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["lcov"],
      reportsDirectory: "./coverage",
      reportOnFailure: true,
      exclude: ["**/*.test.ts", "**/*.spec.ts", "**/*.d.ts", "**/types.ts"],
    },
  },
});
