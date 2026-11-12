import { beforeEach, describe, expect, it, vi } from "vitest";
import { signupEmailPolicyHook } from "@/lib/signup/email-policy-hook";

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
const betterAuthMock = vi.hoisted(() =>
  vi.fn((options: Record<string, unknown>) => ({
    options,
    $Infer: { Session: {} },
  })),
);

vi.mock("better-auth", () => ({ betterAuth: (o: Record<string, unknown>) => betterAuthMock(o) }));
vi.mock("better-auth/adapters/prisma", () => ({ prismaAdapter: () => ({}) }));
vi.mock("better-auth/plugins", () => ({
  admin: () => ({ id: "admin" }),
  deviceAuthorization: () => ({ id: "device-authorization" }),
  jwt: () => ({ id: "jwt" }),
}));
vi.mock("@traceroot/core", () => ({ prisma: {} }));
const captureServerEventMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/posthog-server", () => ({ captureServerEvent: captureServerEventMock }));
const onUserCreatedMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => undefined));
vi.mock("@/lib/signup/on-user-created", () => ({ onUserCreated: onUserCreatedMock }));
const signupAttributionPropertiesMock = vi.hoisted(() => vi.fn((): Record<string, string> => ({})));
vi.mock("@/lib/signup/attribution", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/signup/attribution")>()),
  signupAttributionProperties: signupAttributionPropertiesMock,
}));
vi.mock("@/env", () => ({
  env: {
    BETTER_AUTH_SECRET: "test-secret",
    BETTER_AUTH_URL: "https://app.traceroot.ai",
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
  databaseHooks: {
    user: {
      create: {
        before: (user: { email: string }, context?: { path: string } | null) => Promise<void>;
        after: (user: Record<string, unknown>, context?: { path: string } | null) => Promise<void>;
      };
    };
  };
};

describe("auth options", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signupAttributionPropertiesMock.mockReturnValue({});
  });

  it("passes the configured trusted proxies through to better-auth", () => {
    expect(options.advanced.ipAddress.trustedProxies).toEqual(["10.0.0.0/16"]);
  });

  it("does not disable IP tracking, which would drop rate limiting entirely", () => {
    expect(options.advanced.ipAddress.disableIpTracking).toBeUndefined();
  });

  it("keeps the device-code creation cap", () => {
    expect(options.rateLimit.customRules["/device/code"]).toEqual({ window: 60, max: 10 });
  });

  it("sends user_signed_up when a user is created", async () => {
    await options.databaseHooks.user.create.after({ id: "user-1" });
    expect(captureServerEventMock).toHaveBeenCalledExactlyOnceWith("user-1", "user_signed_up", {});
  });

  it("enriches the existing signup event instead of emitting a second one", async () => {
    const properties = {
      utm_source: "github",
      marketing_attribution_model: "last_campaign_touch",
    };
    signupAttributionPropertiesMock.mockReturnValue(properties);
    const context = { path: "/sign-up/email" };
    await options.databaseHooks.user.create.after({ id: "user-1" }, context);
    expect(signupAttributionPropertiesMock).toHaveBeenCalledWith(context);
    expect(captureServerEventMock).toHaveBeenCalledExactlyOnceWith(
      "user-1",
      "user_signed_up",
      properties,
    );
  });

  it.each([
    ["/sign-up/email", "a@mail.EXAMPLE.COM.", "EMAIL_DOMAIN_RESERVED"],
    ["/sign-up/email", "a@foo.test", "EMAIL_DOMAIN_RESERVED"],
    ["/sign-up/email", "a@localhost", "EMAIL_DOMAIN_RESERVED"],
    ["/sign-up/email", "a@[127.0.0.1]", "EMAIL_DOMAIN_RESERVED"],
    ["/sign-up/email", "invalid", "EMAIL_DOMAIN_RESERVED"],
    ["/callback/:id", '"a@b"@sub.YOPMAIL.COM ', "EMAIL_DOMAIN_DISPOSABLE"],
  ])("rejects %s with %s before creating a user", async (path, email, code) => {
    await expect(
      options.databaseHooks.user.create.before({ email }, { path }),
    ).rejects.toMatchObject({
      status: "BAD_REQUEST",
      body: { code },
    });
  });

  it.each([
    ["/sign-up/email", "a@example.co"],
    ["/sign-up/email", "a@notmailinator.com"],
    ["/sign-up/email", "a@mailinator.com.au"],
  ])("allows %s with %s", async (path, email) => {
    await expect(
      options.databaseHooks.user.create.before({ email }, { path }),
    ).resolves.toBeUndefined();
  });

  it.each([
    "http://localhost:3000",
    "https://staging.traceroot.ai",
    "https://tracing.example.org",
    "https://app.traceroot.ai.example.org",
  ])("leaves domain policy disabled for %s", (authURL) => {
    expect(signupEmailPolicyHook(authURL)).toBeUndefined();
  });

  it("hands every new user to the sign-up follow-up with the endpoint path", async () => {
    const { after } = options.databaseHooks.user.create;
    await after({ id: "u1", email: "a@example.com", name: undefined }, { path: "/sign-up/email" });
    const user = { id: "u1", email: "a@example.com", name: null };
    expect(onUserCreatedMock).toHaveBeenCalledWith(user, { path: "/sign-up/email" });
  });

  it("resolves before the follow-up settles and logs its later rejection", async () => {
    let reject!: (error: Error) => void;
    onUserCreatedMock.mockReturnValueOnce(new Promise<undefined>((_, r) => (reject = r)));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { after } = options.databaseHooks.user.create;
    await expect(after({ id: "u2", email: "b@example.com" }, null)).resolves.toBeUndefined();
    const error = new Error("slack down");
    reject(error);
    await vi.waitFor(() => expect(spy).toHaveBeenCalledWith("[signup] follow-up failed:", error));
    spy.mockRestore();
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
