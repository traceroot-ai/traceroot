import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["lcov"],
      reportsDirectory: "./coverage",
      reportOnFailure: true,
      exclude: ["**/*.test.ts", "**/*.spec.ts", "**/*.d.ts", "**/types.ts"],
    },
  },
});
