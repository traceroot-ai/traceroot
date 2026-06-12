import { defineConfig } from "vitest/config";
import path from "path";
export default defineConfig({
  // Next.js sets tsconfig "jsx": "preserve", which esbuild would pass through
  // untransformed; component tests need the automatic runtime instead.
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["lcov"],
      reportsDirectory: "./coverage",
      reportOnFailure: true,
      exclude: ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "**/*.d.ts", "**/types.ts"],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
