import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("next.config.js env block", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads NEXT_PUBLIC_APP_VERSION from APP_VERSION env var when set", async () => {
    vi.stubEnv("APP_VERSION", "v0.2.0");
    const config = await import("../../next.config.js");
    expect(config.default.env.NEXT_PUBLIC_APP_VERSION).toBe("v0.2.0");
  });

  it("falls back to package.json version when APP_VERSION is unset", async () => {
    delete process.env.APP_VERSION;
    const config = await import("../../next.config.js");
    const pkg = await import("../../package.json");
    expect(config.default.env.NEXT_PUBLIC_APP_VERSION).toBe(pkg.default.version);
  });
});
