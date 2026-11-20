import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Forgot password" through the app's own auth options (lib/auth.ts), run by the
 * real better-auth handlers on an in-memory database. The forgot-password form
 * must not reveal which addresses have accounts, by its answer or by its timing,
 * so the email is neither prepared nor sent while the request is open.
 */

const baseURL = "https://cloud.example.com";

const database = vi.hoisted(
  (): Record<string, Record<string, unknown>[]> => ({
    user: [],
    session: [],
    account: [],
    verification: [],
    deviceCode: [],
    jwks: [],
  }),
);

vi.mock("better-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("better-auth")>();
  const { memoryAdapter } = await import("better-auth/adapters/memory");
  return {
    ...actual,
    betterAuth: (options: Parameters<typeof actual.betterAuth>[0]) =>
      actual.betterAuth({ ...options, database: memoryAdapter(database) }),
  };
});
vi.mock("better-auth/adapters/prisma", () => ({ prismaAdapter: () => ({}) }));
vi.mock("@traceroot/core", () => ({ prisma: {} }));
vi.mock("@/lib/posthog-server", () => ({ captureServerEvent: vi.fn() }));
vi.mock("@/lib/signup/on-user-created", () => ({ onUserCreated: vi.fn(async () => undefined) }));
vi.mock("@/lib/demo-workspace", () => ({ ensureDemoMembership: vi.fn(async () => undefined) }));
vi.mock("@/env", () => ({
  env: {
    BETTER_AUTH_SECRET: "local-test-secret-012345678901234567890123",
    BETTER_AUTH_URL: "https://cloud.example.com",
    TRACEROOT_CLOUD_ENV: "production",
    AUTH_GOOGLE_CLIENT_ID: "",
    AUTH_GOOGLE_CLIENT_SECRET: "",
    AUTH_AGENTID_CLIENT_ID: "",
    AUTH_AGENTID_CLIENT_SECRET: "",
    AUTH_TRUSTED_PROXY_CIDRS: "",
  },
}));
// Next runs after() work once the response has been sent; here the test does.
const afterResponse = vi.hoisted(() => [] as (() => unknown)[]);
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: () => unknown) => void afterResponse.push(task),
}));
const sendPasswordResetEmail = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => undefined));
vi.mock("@/lib/email/send-password-reset-email", () => ({ sendPasswordResetEmail }));

const { auth } = await import("./auth");

function post(path: string, body: Record<string, unknown>) {
  return auth.handler(
    new Request(`${baseURL}/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseURL },
      body: JSON.stringify(body),
    }),
  );
}

async function forgotPassword(email: string) {
  const response = await post("/request-password-reset", {
    email,
    redirectTo: "/auth/reset-password",
  });
  return { status: response.status, body: await response.text() };
}

beforeEach(async () => {
  for (const rows of Object.values(database)) rows.length = 0;
  afterResponse.length = 0;
  sendPasswordResetEmail.mockClear();
  const signUp = await post("/sign-up/email", {
    email: "ada@example.co",
    name: "Ada",
    password: "test-password-123",
  });
  expect(signUp.status).toBe(200);
  afterResponse.length = 0;
});

describe("forgot password with the app's auth options", () => {
  it("answers a known and an unknown address the same way", async () => {
    const known = await forgotPassword("ada@example.co");
    const unknown = await forgotPassword("nobody@example.co");

    expect(known.status).toBe(200);
    expect(unknown).toEqual(known);
  });

  it("prepares and sends the email only after the response", async () => {
    await forgotPassword("ada@example.co");

    // Nothing ran while the request was open.
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
    expect(afterResponse).toHaveLength(1);

    await afterResponse[0]!();
    expect(sendPasswordResetEmail).toHaveBeenCalledExactlyOnceWith({
      to: "ada@example.co",
      resetUrl: expect.stringMatching(
        /^https:\/\/cloud\.example\.com\/api\/auth\/reset-password\/\w+\?callbackURL=%2Fauth%2Freset-password$/,
      ),
    });
  });

  it("leaves nothing to do for an unknown address", async () => {
    await forgotPassword("nobody@example.co");

    expect(afterResponse).toHaveLength(0);
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
  });
});
