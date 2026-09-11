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
      exclude: [
        "**/*.test.ts",
        "**/*.test.tsx",
        "**/*.spec.ts",
        "**/*.d.ts",
        "**/types.ts",
        // Next.js route entrypoints are thin composition (params -> view) and are
        // exercised by the view mount smokes, not unit-covered directly.
        "**/app/**/page.tsx",
        "**/app/**/layout.tsx",
        // Local dev-server build output; its compiled chunks lack usable
        // sourcemaps and crash the untested-files coverage scan.
        "**/.next/**",
      ],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
