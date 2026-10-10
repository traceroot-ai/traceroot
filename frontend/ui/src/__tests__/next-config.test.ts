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
    expect(config.default.env?.NEXT_PUBLIC_APP_VERSION).toBe("v0.2.0");
  });

  it("falls back to git describe (or 'dev' when no tag is reachable) when APP_VERSION is unset", async () => {
    delete process.env.APP_VERSION;
    const config = await import("../../next.config.js");
    // Mirror resolveAppVersion(): git describe, falling back to "dev" when it
    // throws (e.g. a shallow CI checkout with no tags fetched).
    let expected: string;
    try {
      expected = execSync("git describe --tags --abbrev=0 --match 'v[0-9]*.[0-9]*.[0-9]*'", {
        cwd: new URL("../../", import.meta.url),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      expected = "dev";
    }
    expect(config.default.env?.NEXT_PUBLIC_APP_VERSION).toBe(expected);
  });

  it("falls back to dev when APP_VERSION is explicitly set to dev", async () => {
    vi.stubEnv("APP_VERSION", "dev");
    // The query string is a vitest cache-buster so the module re-evaluates; TypeScript
    // cannot resolve it as a path, hence the expect-error.
    // @ts-expect-error query-string import is not a resolvable module path
    const config = await import("../../next.config.js?fallback-dev");
    expect(config.default.env?.NEXT_PUBLIC_APP_VERSION).toBe("dev");
  });
});

describe("next.config.js security headers", () => {
  it("does not advertise the framework in X-Powered-By", async () => {
    const config = await import("../../next.config.js");
    expect(config.default.poweredByHeader).toBe(false);
  });

  it("sends HSTS, nosniff, frame denial and a referrer policy on every path", async () => {
    const config = await import("../../next.config.js");
    expect(await config.default.headers?.()).toEqual([
      {
        source: "/:path*",
        headers: [
          { key: "Strict-Transport-Security", value: "max-age=63072000" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ]);
  });
});
