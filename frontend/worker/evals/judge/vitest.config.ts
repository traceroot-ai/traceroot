import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["evals/judge/judge.eval.ts"],
    testTimeout: 3 * 60 * 60 * 1000,
  },
});
