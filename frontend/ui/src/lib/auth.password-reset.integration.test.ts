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
const { RESET_NOT_AVAILABLE } = await import("./auth-recovery");

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

it("validates the reset page link without consuming it", async () => {
  const { default: ResetPasswordPage } = await import("@/app/auth/reset-password/page");
  const { RequestNewLink, ResetPasswordClient } =
    await import("@/app/auth/reset-password/reset-password-client");
  const page = async (token: string) =>
    (await ResetPasswordPage({ searchParams: Promise.resolve({ token }) })).type;
  expect(await page("unknown")).toBe(RequestNewLink);
  const token = await resetToken("ada@example.co");
  expect(await page(token)).toBe(ResetPasswordClient);
  expect(await page(token)).toBe(ResetPasswordClient);
  expect((await resetPassword(token, "fresh-password-2")).status).toBe(200);
  expect(await page(token)).toBe(RequestNewLink);
});

it("hides the reset form for an expired token", async () => {
  const { default: ResetPasswordPage } = await import("@/app/auth/reset-password/page");
  const { RequestNewLink } = await import("@/app/auth/reset-password/reset-password-client");
  const token = await resetToken("ada@example.co");
  const record = database.verification!.find(
    (row) => row.identifier === `reset-password:${token}`,
  )!;
  record.expiresAt = new Date(Date.now() - 1000);
  const page = await ResetPasswordPage({ searchParams: Promise.resolve({ token }) });
  expect(page.type).toBe(RequestNewLink);
});

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

/** Synthetic records: one account and its sign-in identities, as stored. */
function seedAccount(
  id: string,
  email: string,
  emailVerified: boolean,
  identities: { providerId: string; accountId: string }[],
) {
  const now = new Date();
  database.user.push({ id, email, name: id, emailVerified, createdAt: now, updatedAt: now });
  for (const [i, identity] of identities.entries()) {
    database.account.push({
      id: `${id}-acc-${i}`,
      userId: id,
      ...identity,
      createdAt: now,
      updatedAt: now,
    });
  }
  database.session.push({
    id: `${id}-session`,
    userId: id,
    token: `${id}-session-token`,
    expiresAt: new Date(now.getTime() + 3_600_000),
    createdAt: now,
    updatedAt: now,
  });
}

/** The token from the reset link the email would carry. */
async function resetToken(email: string): Promise<string> {
  afterResponse.length = 0;
  sendPasswordResetEmail.mockClear();
  await forgotPassword(email);
  for (const task of afterResponse) await task();
  const { resetUrl } = sendPasswordResetEmail.mock.calls[0]![0] as { resetUrl: string };
  return new URL(resetUrl).pathname.split("/").pop()!;
}

const providersOf = (userId: string) =>
  database.account
    .filter((a) => a.userId === userId)
    .map((a) => a.providerId)
    .sort();
const sessionsOf = (userId: string) => database.session.filter((s) => s.userId === userId);
const signIn = (email: string, password: string) => post("/sign-in/email", { email, password });

const accountsOf = (userId: string) =>
  structuredClone(database.account.filter((a) => a.userId === userId));
const resetPassword = (token: string, newPassword: string) =>
  post("/reset-password", { token, newPassword });

describe("a reset link recovers only accounts whose identities proved the mailbox", () => {
  it("recovers an ordinary password account", async () => {
    const token = await resetToken("ada@example.co");

    expect((await resetPassword(token, "fresh-password-1")).status).toBe(200);
    expect((await signIn("ada@example.co", "fresh-password-1")).status).toBe(200);
    expect((await signIn("ada@example.co", "test-password-123")).status).toBe(401);
  });

  it("changes nothing when the new password is rejected", async () => {
    const session = await signIn("ada@example.co", "test-password-123");
    expect(session.status).toBe(200);
    const user = database.user.find((u) => u.email === "ada@example.co")!;
    const accounts = accountsOf(user.id as string);
    const sessions = structuredClone(sessionsOf(user.id as string));
    expect(sessions.length).toBeGreaterThan(0);
    const token = await resetToken("ada@example.co");

    const rejected = await resetPassword(token, "short");
    expect(rejected.status).toBe(400);
    expect(accountsOf(user.id as string)).toEqual(accounts);
    expect(sessionsOf(user.id as string)).toEqual(sessions);
    expect((await signIn("ada@example.co", "test-password-123")).status).toBe(200);
    // The link still works for a valid password.
    expect((await resetPassword(token, "fresh-password-2")).status).toBe(200);
  });

  it("recovers a verified account and keeps its proven identities", async () => {
    seedAccount("u-google", "ny@example.co", true, [
      { providerId: "google", accountId: "google-sub-2" },
    ]);
    const token = await resetToken("ny@example.co");

    expect((await resetPassword(token, "new-password-321")).status).toBe(200);
    expect(providersOf("u-google")).toEqual(["credential", "google"]);
    expect((await signIn("ny@example.co", "new-password-321")).status).toBe(200);
  });

  it("changes nothing on a verified account when the new password is rejected", async () => {
    seedAccount("u-verified", "kim@example.co", true, [
      { providerId: "google", accountId: "google-sub-3" },
    ]);
    const accounts = accountsOf("u-verified");
    const sessions = structuredClone(sessionsOf("u-verified"));
    const token = await resetToken("kim@example.co");

    expect((await resetPassword(token, "short")).status).toBe(400);
    expect(accountsOf("u-verified")).toEqual(accounts);
    expect(sessionsOf("u-verified")).toEqual(sessions);
  });

  it.each([
    ["an unverified account with another identity", "lee@example.co", false, "google"],
    ["any account with an AgentID identity", "mo@example.co", true, "agentid"],
  ])("refuses %s and changes nothing", async (_case, email, verified, providerId) => {
    const id = `u-${providerId}-${verified}`;
    seedAccount(id, email, verified, [{ providerId, accountId: `${providerId}-sub` }]);
    const accounts = accountsOf(id);
    const sessions = structuredClone(sessionsOf(id));
    const token = await resetToken(email);

    const refused = await resetPassword(token, "new-password-456");
    expect(refused.status).toBe(403);
    expect((await refused.json()).message).toBe(RESET_NOT_AVAILABLE);
    expect(accountsOf(id)).toEqual(accounts);
    expect(sessionsOf(id)).toEqual(sessions);
    expect((await signIn(email, "new-password-456")).status).toBe(401);
  });

  it("changes nothing without a valid token", async () => {
    seedAccount("u-other", "oz@example.co", false, [
      { providerId: "agentid", accountId: "agent-sub-3" },
    ]);
    const accounts = accountsOf("u-other");

    expect((await resetPassword("not-a-real-token", "new-password-654")).status).toBe(400);
    expect(accountsOf("u-other")).toEqual(accounts);
    expect(sessionsOf("u-other")).toHaveLength(1);
  });

  it("answers the forgot-password form the same way for these accounts", async () => {
    seedAccount("u-social", "pat@example.co", false, [
      { providerId: "agentid", accountId: "agent-sub-4" },
    ]);
    const social = await forgotPassword("pat@example.co");
    const unknown = await forgotPassword("nobody@example.co");
    expect(social).toEqual(unknown);
  });
});
