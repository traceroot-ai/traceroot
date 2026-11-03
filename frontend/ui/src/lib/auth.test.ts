import { beforeEach, describe, expect, it, vi } from "vitest";

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
const onEmailVerifiedMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => undefined));
vi.mock("@/lib/signup/on-user-created", () => ({
  onUserCreated: onUserCreatedMock,
  onEmailVerified: onEmailVerifiedMock,
}));
const sendVerificationEmailMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => undefined));
vi.mock("@/lib/signup/verification-email", () => ({
  // Read at import time; the env var lets one test reload auth.ts without mail.
  isVerificationMailConfigured: () => process.env.TEST_NO_VERIFICATION_MAIL !== "1",
  sendVerificationEmail: sendVerificationEmailMock,
}));
const signupAttributionPropertiesMock = vi.hoisted(() => vi.fn((): Record<string, string> => ({})));
vi.mock("@/lib/signup/attribution", () => ({
  isSelfSignup: (context: { path?: string } | null) => context?.path !== "/admin/create-user",
  signupAttributionProperties: signupAttributionPropertiesMock,
}));
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
  emailAndPassword: { requireEmailVerification: boolean };
  emailVerification: {
    sendVerificationEmail: (data: {
      user: { id: string; email: string };
      url: string;
    }) => Promise<void>;
    sendOnSignIn: boolean;
    afterEmailVerification: (user: {
      id: string;
      email: string;
      name: string;
      createdAt: Date;
    }) => Promise<void>;
  };
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

  it("rejects a self-service account on a reserved or disposable domain", async () => {
    const { before } = options.databaseHooks.user.create;
    await expect(
      before({ email: "a@example.com" }, { path: "/sign-up/email" }),
    ).rejects.toMatchObject({ status: "BAD_REQUEST", body: { code: "EMAIL_DOMAIN_RESERVED" } });
    await expect(
      before({ email: "a@yopmail.com" }, { path: "/callback/:id" }),
    ).rejects.toMatchObject({
      body: { code: "EMAIL_DOMAIN_DISPOSABLE" },
    });
    await expect(
      before({ email: "a@acme.io" }, { path: "/sign-up/email" }),
    ).resolves.toBeUndefined();
  });

  it("lets staff provision an account on any domain", async () => {
    const { before } = options.databaseHooks.user.create;
    await expect(
      before({ email: "a@example.com" }, { path: "/admin/create-user" }),
    ).resolves.toBeUndefined();
  });

  it("hands every new user to the sign-up follow-up with the endpoint path", async () => {
    const { after } = options.databaseHooks.user.create;
    await after({ id: "u1", email: "a@example.com", name: undefined }, { path: "/sign-up/email" });
    const user = { id: "u1", email: "a@example.com", name: null };
    expect(onUserCreatedMock).toHaveBeenCalledWith(
      user,
      { path: "/sign-up/email" },
      { awaitingVerification: true },
    );
  });

  it("requires verification for email sign-in and resends the link on an attempt", () => {
    expect(options.emailAndPassword.requireEmailVerification).toBe(true);
    expect(options.emailVerification.sendOnSignIn).toBe(true);
  });

  it("delivers the verification link through the mail module", async () => {
    const data = { user: { id: "u1", email: "a@acme.io" }, url: "https://x/verify-email?token=t" };
    await options.emailVerification.sendVerificationEmail(data);
    expect(sendVerificationEmailMock).toHaveBeenCalledWith(data);
  });

  it("does not hold back the follow-up for an account that arrives verified", async () => {
    const { after } = options.databaseHooks.user.create;
    await after({ id: "u3", email: "g@acme.io", emailVerified: true }, { path: "/callback/:id" });
    expect(onUserCreatedMock).toHaveBeenCalledWith(
      expect.anything(),
      { path: "/callback/:id" },
      { awaitingVerification: false },
    );
  });

  it("runs the held follow-up once the address is verified, without awaiting it", async () => {
    const createdAt = new Date();
    const verifiedUser = { id: "u1", email: "a@acme.io", name: "A", createdAt };
    let reject!: (error: Error) => void;
    onEmailVerifiedMock.mockReturnValueOnce(new Promise<undefined>((_, r) => (reject = r)));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      options.emailVerification.afterEmailVerification(verifiedUser),
    ).resolves.toBeUndefined();
    expect(onEmailVerifiedMock).toHaveBeenCalledWith(verifiedUser);
    const error = new Error("slack down");
    reject(error);
    await vi.waitFor(() =>
      expect(spy).toHaveBeenCalledWith("[signup] verified follow-up failed:", error),
    );
    spy.mockRestore();
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

describe("auth options without verification mail", () => {
  it("does not require verification, so new accounts are not locked out", async () => {
    vi.resetModules();
    betterAuthMock.mockClear();
    process.env.TEST_NO_VERIFICATION_MAIL = "1";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await import("./auth");
      const reloaded = betterAuthMock.mock.calls[0]?.[0] as typeof options;
      expect(reloaded.emailAndPassword.requireEmailVerification).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("email verification is off"));
    } finally {
      delete process.env.TEST_NO_VERIFICATION_MAIL;
      warn.mockRestore();
    }
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
