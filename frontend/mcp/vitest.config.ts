import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["lcov"],
      reportsDirectory: "./coverage",
      reportOnFailure: true,
      exclude: [
        "**/*.test.ts",
        "**/*.spec.ts",
        "**/*.d.ts",
        "**/types.ts",
        // Process bootstrap only: it reads env and listens; every decision
        // it makes lives in app.ts, which the tests drive.
        "src/index.ts",
      ],
    },
  },
});
