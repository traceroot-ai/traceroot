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
        // Live-only wiring for the eval harness: it talks to a running stack
        // and a real model, so no unit test reaches it. Reporting it would
        // put permanently-uncovered lines into the diff-coverage gate; every
        // decision it makes lives in a covered module beside it.
        "evals/run.ts",
      ],
    },
  },
});
