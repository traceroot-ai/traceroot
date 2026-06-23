import { afterEach, describe, expect, it, vi } from "vitest";

const originalEnv = process.env;

async function loadEnv(overrides: Record<string, string | undefined>) {
  vi.resetModules();
  process.env = {
    ...originalEnv,
    BETTER_AUTH_SECRET: "test-secret",
    INTERNAL_API_SECRET: "internal-secret",
    ...overrides,
  };
  return import("./env");
}

afterEach(() => {
  process.env = originalEnv;
});

describe("env", () => {
  it("defaults optional GitHub social auth credentials to empty strings", async () => {
    const { env } = await loadEnv({
      AUTH_GITHUB_CLIENT_ID: undefined,
      AUTH_GITHUB_CLIENT_SECRET: undefined,
    });

    expect(env.AUTH_GITHUB_CLIENT_ID).toBe("");
    expect(env.AUTH_GITHUB_CLIENT_SECRET).toBe("");
  });

  it("reads configured GitHub social auth credentials", async () => {
    const { env } = await loadEnv({
      AUTH_GITHUB_CLIENT_ID: "github-client-id",
      AUTH_GITHUB_CLIENT_SECRET: "github-client-secret",
    });

    expect(env.AUTH_GITHUB_CLIENT_ID).toBe("github-client-id");
    expect(env.AUTH_GITHUB_CLIENT_SECRET).toBe("github-client-secret");
  });
});
