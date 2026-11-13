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
const genericOAuthMock = vi.hoisted(() =>
  vi.fn((options: Record<string, unknown>) => ({ id: "generic-oauth", options })),
);
vi.mock("better-auth/plugins", () => ({
  admin: () => ({ id: "admin" }),
  deviceAuthorization: () => ({ id: "device-authorization" }),
  genericOAuth: (o: Record<string, unknown>) => genericOAuthMock(o),
  jwt: () => ({ id: "jwt" }),
}));
vi.mock("@traceroot/core", () => ({ prisma: {} }));
const captureServerEventMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/posthog-server", () => ({ captureServerEvent: captureServerEventMock }));
const onUserCreatedMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => undefined));
vi.mock("@/lib/signup/on-user-created", () => ({ onUserCreated: onUserCreatedMock }));
const signupAttributionPropertiesMock = vi.hoisted(() => vi.fn((): Record<string, string> => ({})));
vi.mock("@/lib/signup/attribution", () => ({
  signupAttributionProperties: signupAttributionPropertiesMock,
}));
vi.mock("@/env", () => ({
  env: {
    BETTER_AUTH_SECRET: "test-secret",
    BETTER_AUTH_URL: "http://localhost:3000",
    AUTH_GOOGLE_CLIENT_ID: "",
    AUTH_GOOGLE_CLIENT_SECRET: "",
    get AUTH_AGENTID_CLIENT_ID() {
      return process.env.TEST_AGENTID_CLIENT_ID ?? "";
    },
    get AUTH_AGENTID_CLIENT_SECRET() {
      return process.env.TEST_AGENTID_CLIENT_SECRET ?? "";
    },
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
  account: { accountLinking: { enabled: boolean; trustedProviders: string[] } };
  onAPIError: { errorURL: string };
  user?: { validateUserInfo?: unknown };
  plugins: { id: string }[];
  advanced: { ipAddress: { trustedProxies: string[]; disableIpTracking?: boolean } };
  rateLimit: { customRules: Record<string, { window: number; max: number }> };
  databaseHooks: {
    user: {
      create: {
        after: (
          user: Record<string, unknown>,
          context?: { path: string; params?: { id: string } } | null,
        ) => Promise<void>;
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

  it("sends failed OAuth callbacks to the app's own error page", () => {
    expect(options.onAPIError.errorURL).toBe("http://localhost:3000/auth/error");
  });

  it("trusts only Google for account linking, never AgentID", () => {
    expect(options.account.accountLinking.trustedProviders).toEqual(["google"]);
  });

  it("registers no AgentID provider, and no sign-up cap, when its credentials are unset", () => {
    expect(genericOAuthMock).not.toHaveBeenCalled();
    expect(options.plugins.map((p) => p.id)).not.toContain("generic-oauth");
    expect(options.user).toBeUndefined();
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

  it("hands every new user to the sign-up follow-up with the endpoint path", async () => {
    const { after } = options.databaseHooks.user.create;
    await after({ id: "u1", email: "a@example.com", name: undefined }, { path: "/sign-up/email" });
    const user = { id: "u1", email: "a@example.com", name: null };
    expect(onUserCreatedMock).toHaveBeenCalledWith(user, { path: "/sign-up/email" });
  });

  it("hands a social sign-up's provider id from the callback route param", async () => {
    const { after } = options.databaseHooks.user.create;
    await after(
      { id: "u3", email: "agent@agentmail.to" },
      {
        path: "/callback/:id",
        params: { id: "agentid" },
      },
    );
    expect(onUserCreatedMock).toHaveBeenCalledWith(expect.objectContaining({ id: "u3" }), {
      path: "/callback/:id",
      provider: "agentid",
    });
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

describe("auth options with AgentID configured", () => {
  it("registers the AgentID provider and its per-owner cap", async () => {
    vi.resetModules();
    betterAuthMock.mockClear();
    genericOAuthMock.mockClear();
    process.env.TEST_AGENTID_CLIENT_ID = "agentid-client";
    process.env.TEST_AGENTID_CLIENT_SECRET = "agentid-secret";
    try {
      await import("./auth");
    } finally {
      delete process.env.TEST_AGENTID_CLIENT_ID;
      delete process.env.TEST_AGENTID_CLIENT_SECRET;
    }
    const configured = betterAuthMock.mock.calls[0]?.[0] as typeof options;
    const { config } = genericOAuthMock.mock.calls[0]?.[0] as {
      config: { providerId: string; clientId: string }[];
    };
    expect(config).toEqual([
      expect.objectContaining({ providerId: "agentid", clientId: "agentid-client" }),
    ]);
    expect(typeof configured.user?.validateUserInfo).toBe("function");
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
