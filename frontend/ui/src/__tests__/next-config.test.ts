import { execSync } from "node:child_process";

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

  it("falls back to git describe when APP_VERSION is unset", async () => {
    delete process.env.APP_VERSION;
    const config = await import("../../next.config.js");
    const expected = execSync("git describe --tags --abbrev=0", {
      cwd: new URL("../../", import.meta.url),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    expect(config.default.env.NEXT_PUBLIC_APP_VERSION).toBe(expected);
  });

  it("falls back to dev when APP_VERSION is explicitly set to dev", async () => {
    vi.stubEnv("APP_VERSION", "dev");
    const config = await import("../../next.config.js?fallback-dev");
    expect(config.default.env.NEXT_PUBLIC_APP_VERSION).toBe("dev");
  });
});
