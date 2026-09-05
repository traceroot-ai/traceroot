import { describe, expect, it, vi } from "vitest";

/**
 * Captures the options object handed to betterAuth() so the wiring can be
 * asserted without a database or a validated environment.
 *
 * The properties checked here are the ones whose absence fails silently.
 * Dropping the trustedProxies wiring would not throw or fail a type check: a
 * deployment behind a proxy that appends would keep serving, with every
 * multi-hop caller quietly sharing one bucket. trusted-proxies.test.ts pins the
 * library behaviour that makes this matter.
 */
const betterAuthMock = vi.fn((options: Record<string, unknown>) => ({
  options,
  $Infer: { Session: {} },
}));

vi.mock("better-auth", () => ({ betterAuth: (o: Record<string, unknown>) => betterAuthMock(o) }));
vi.mock("better-auth/adapters/prisma", () => ({ prismaAdapter: () => ({}) }));
vi.mock("better-auth/plugins", () => ({
  admin: () => ({ id: "admin" }),
  deviceAuthorization: () => ({ id: "device-authorization" }),
  jwt: () => ({ id: "jwt" }),
}));
vi.mock("@traceroot/core", () => ({ prisma: {} }));
vi.mock("@/env", () => ({
  env: {
    BETTER_AUTH_SECRET: "test-secret",
    BETTER_AUTH_URL: "http://localhost:3000",
    AUTH_GOOGLE_CLIENT_ID: "",
    AUTH_GOOGLE_CLIENT_SECRET: "",
    // A getter, not a value: vi.resetModules() re-evaluates auth.ts but keeps
    // this mock cached, so the value has to be read at access time for the
    // invalid-CIDR test below to reach the config.
    get AUTH_TRUSTED_PROXY_CIDRS() {
      return process.env.TEST_TRUSTED_PROXY_CIDRS ?? "10.0.0.0/16";
    },
  },
}));

await import("./auth");
const options = betterAuthMock.mock.calls[0]?.[0] as {
  advanced: { ipAddress: { trustedProxies: string[]; disableIpTracking?: boolean } };
  rateLimit: { customRules: Record<string, { window: number; max: number }> };
};

describe("auth options", () => {
  it("passes the configured trusted proxies through to better-auth", () => {
    expect(options.advanced.ipAddress.trustedProxies).toEqual(["10.0.0.0/16"]);
  });

  it("does not disable IP tracking, which would drop rate limiting entirely", () => {
    expect(options.advanced.ipAddress.disableIpTracking).toBeUndefined();
  });

  it("keeps the device-code creation cap", () => {
    expect(options.rateLimit.customRules["/device/code"]).toEqual({ window: 60, max: 10 });
  });
});

describe("auth options with an invalid trusted-proxy value", () => {
  it("fails to load rather than silently reverting to single-entry mode", async () => {
    // A replaced trustedProxyCidrs call, or one wrapped in try/catch, would
    // pass every other test here and ship a deployment that looks healthy with
    // the exact keying bug this config exists to fix. The throw has to reach
    // the module import.
    vi.resetModules();
    process.env.TEST_TRUSTED_PROXY_CIDRS = "10.0.0.0/16,nonsense";
    try {
      await expect(import("./auth")).rejects.toThrow(/nonsense/);
    } finally {
      delete process.env.TEST_TRUSTED_PROXY_CIDRS;
    }
  });
});
