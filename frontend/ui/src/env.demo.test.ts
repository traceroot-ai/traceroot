import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("BETTER_AUTH_SECRET", "demo-schema-test-secret-value");
  vi.stubEnv("INTERNAL_API_SECRET", "demo-schema-test-secret-value");
  vi.stubEnv("DEMO_AI_DAILY_MESSAGE_LIMIT", undefined);
  vi.stubEnv("DEMO_AI_MODEL", undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe("demo AI configuration", () => {
  it.each([undefined, "", "   "])("defaults an unset or blank limit: %s", async (value) => {
    vi.stubEnv("DEMO_AI_DAILY_MESSAGE_LIMIT", value);
    expect((await import("./env")).env.DEMO_AI_DAILY_MESSAGE_LIMIT).toBe(5);
  });
  it("preserves explicit zero", async () => {
    vi.stubEnv("DEMO_AI_DAILY_MESSAGE_LIMIT", "0");
    expect((await import("./env")).env.DEMO_AI_DAILY_MESSAGE_LIMIT).toBe(0);
  });
  it.each(["", "   "])("rejects a blank model: %s", async (value) => {
    vi.stubEnv("DEMO_AI_MODEL", value);
    await expect(import("./env")).rejects.toThrow(/DEMO_AI_MODEL/);
  });
});
