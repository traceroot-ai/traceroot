import { test, expect, type APIRequestContext } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { signJWT } from "better-auth/crypto";
import Redis from "ioredis";

// Drives the real /api/auth/sign-up/email endpoint. Intentionally
// localhost-only: it creates accounts and must never touch a remote tenant.
const database = new URL(process.env.DATABASE_URL!);
if (!["localhost", "127.0.0.1"].includes(database.hostname))
  throw new Error("E2E requires local Postgres");
const base = process.env.E2E_BASE_URL ?? "http://localhost:3000";
if (!["localhost", "127.0.0.1"].includes(new URL(base).hostname))
  throw new Error("E2E requires a local UI server");

// Accepted signups run the real follow-up hooks. Refuse to run where they could
// post to Slack or send product mail, rather than trusting the local .env.
for (const name of ["TRACEROOT_SIGNUP_SLACK_WEBHOOK_URL", "RESEND_PRODUCT_TOPIC_ID"])
  if (process.env[name]?.trim()) throw new Error(`E2E must run with ${name} unset`);

const prisma = new PrismaClient();
const prefix = `signup-e2e-${randomUUID()}`;
// A real, deliverable domain for the accepted path. Nothing is delivered to it:
// the guard above keeps product mail and Slack off, verification mail (when
// on) uses a dummy key, and afterAll deletes the accounts.
const VALID_DOMAIN = "traceroot.ai";

// Each request gets its own client address (RFC 2544 benchmarking range), so
// the per-IP sign-up budget never leaks between tests or runs. Only the
// throttling test reuses one.
const octet = () => Math.floor(Math.random() * 254) + 1;
const ip = () => `198.18.${octet()}.${octet()}`;

const PASSWORD = "correct-horse-battery";
// The token Cloudflare's always-pass test secret accepts. Ignored when the
// CAPTCHA is off, so every block runs whichever way the server is configured.
const TURNSTILE_TEST_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

function signUp(
  request: APIRequestContext,
  email: string,
  clientIp = ip(),
  captchaToken: string | null = TURNSTILE_TEST_TOKEN,
) {
  return request.post("/api/auth/sign-up/email", {
    data: { name: "Signup E2E", email, password: PASSWORD },
    headers: {
      origin: base,
      "x-forwarded-for": clientIp,
      ...(captchaToken ? { "x-captcha-response": captchaToken } : {}),
    },
  });
}

function signIn(request: APIRequestContext, email: string) {
  return request.post("/api/auth/sign-in/email", {
    data: { email, password: PASSWORD },
    headers: { origin: base, "x-forwarded-for": ip() },
  });
}

test.afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: prefix } } });
  await prisma.$disconnect();
});

test.describe("sign-up domain policy", () => {
  for (const [domain, code] of [
    ["example.com", "EMAIL_DOMAIN_RESERVED"],
    ["foo.test", "EMAIL_DOMAIN_RESERVED"],
    ["mailinator.com", "EMAIL_DOMAIN_DISPOSABLE"],
  ] as const) {
    test(`rejects ${domain} without creating an account`, async ({ request }) => {
      const email = `${prefix}-${code.toLowerCase()}@${domain}`;
      const response = await signUp(request, email);
      expect(response.status()).toBe(400);
      expect((await response.json()).code).toBe(code);
      expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
    });
  }

  test("accepts a deliverable domain", async ({ request }) => {
    const email = `${prefix}-ok@${VALID_DOMAIN}`;
    const response = await signUp(request, email);
    expect(response.status()).toBe(200);
    expect(await prisma.user.findUnique({ where: { email } })).not.toBeNull();
  });

  test("shows the policy error inline on the sign-up form", async ({ page }) => {
    await page.goto("/auth/sign-up");
    await page.getByPlaceholder("John Doe").fill("Signup E2E");
    await page.getByPlaceholder("you@example.com").fill(`${prefix}@mailinator.com`);
    await page.getByPlaceholder("********").first().fill("correct-horse-battery");
    await page.getByPlaceholder("********").last().fill("correct-horse-battery");
    await page.getByRole("button", { name: "Sign up" }).click();
    await expect(page.getByText(/Disposable email addresses aren't supported/)).toBeVisible();
  });
});

// Verification is required only when the server can send mail, so this block
// needs the UI started with RESEND_API_KEY and a sender set (a dummy key is
// fine: the send fails and is logged, and the test mints the link itself).
test.describe("sign-up email verification", () => {
  test.skip(
    process.env.E2E_EMAIL_VERIFICATION !== "1",
    "set E2E_EMAIL_VERIFICATION=1 and start the UI with RESEND_API_KEY and a sender",
  );

  test("holds a valid signup inactive until the address is verified", async ({ request }) => {
    const email = `${prefix}-verify@${VALID_DOMAIN}`;
    const created = await signUp(request, email);
    expect(created.status()).toBe(200);
    expect((await created.json()).token).toBeNull();
    expect(created.headers()["set-cookie"] ?? "").not.toContain("session_token");
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.emailVerified).toBe(false);
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);

    const blocked = await signIn(request, email);
    expect(blocked.status()).toBe(403);
    expect((await blocked.json()).code).toBe("EMAIL_NOT_VERIFIED");

    // The link the verification email carries, signed with the server secret.
    const token = await signJWT({ email }, process.env.BETTER_AUTH_SECRET!, 3600);
    const verified = await request.get(
      `/api/auth/verify-email?token=${token}&callbackURL=%2Fonboarding`,
      { maxRedirects: 0 },
    );
    expect(verified.status()).toBe(302);
    expect(verified.headers()["location"]).toBe("/onboarding");
    expect(verified.headers()["set-cookie"]).toContain("session_token");
    expect((await prisma.user.findUniqueOrThrow({ where: { email } })).emailVerified).toBe(true);

    expect((await signIn(request, email)).status()).toBe(200);
  });

  test("answers a repeat signup like a new one, so it cannot probe for accounts", async ({
    request,
  }) => {
    const email = `${prefix}-repeat@${VALID_DOMAIN}`;
    expect((await signUp(request, email)).status()).toBe(200);
    const repeat = await signUp(request, email);
    expect(repeat.status()).toBe(200);
    expect((await repeat.json()).token).toBeNull();
  });
});

// better-auth only rate-limits in production, so this needs `next build` +
// `next start`. With REDIS_URL set it also checks the counter is in Redis, i.e.
// shared by every replica rather than held in one process.
test.describe("sign-up throttling", () => {
  test.skip(
    process.env.E2E_RATE_LIMIT !== "1",
    "set E2E_RATE_LIMIT=1 and run against a production build (next build && next start)",
  );

  test("throttles rapid repeated signups from one address", async ({ request }) => {
    const clientIp = ip();
    const MAX = 10; // the /sign-up/email rule in lib/auth.ts
    for (let i = 0; i < MAX; i++) {
      const response = await signUp(request, `${prefix}-burst-${i}@${VALID_DOMAIN}`, clientIp);
      expect(response.status(), `signup ${i + 1} of ${MAX}`).toBe(200);
    }
    const throttled = await signUp(request, `${prefix}-burst-over@${VALID_DOMAIN}`, clientIp);
    expect(throttled.status()).toBe(429);
    // About an hour until the window frees up.
    expect(Number(throttled.headers()["x-retry-after"])).toBeGreaterThan(3500);
    expect(
      await prisma.user.findUnique({ where: { email: `${prefix}-burst-over@${VALID_DOMAIN}` } }),
    ).toBeNull();

    // Another address still has its own budget.
    expect((await signUp(request, `${prefix}-other@${VALID_DOMAIN}`)).status()).toBe(200);

    if (process.env.REDIS_URL) {
      const redis = new Redis(process.env.REDIS_URL);
      try {
        const key = `traceroot:auth-rate-limit:${clientIp}|/sign-up/email`;
        expect(Number(await redis.get(key))).toBe(MAX + 1);
        await redis.del(key);
      } finally {
        redis.disconnect();
      }
    }
  });
});

// Needs the UI started with Cloudflare's always-pass test keys:
// TURNSTILE_SITE_KEY=1x00000000000000000000AA
// TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA
test.describe("sign-up CAPTCHA", () => {
  test.skip(
    process.env.E2E_CAPTCHA !== "1",
    "set E2E_CAPTCHA=1 and start the UI with the Turnstile test keys",
  );

  test("refuses a signup that carries no CAPTCHA token", async ({ request }) => {
    const email = `${prefix}-nocaptcha@${VALID_DOMAIN}`;
    const response = await signUp(request, email, ip(), null);
    expect(response.status()).toBe(400);
    expect((await response.json()).code).toBe("MISSING_RESPONSE");
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
  });

  test("loads the widget under the page CSP and signs up once it passes", async ({ page }) => {
    const violations: string[] = [];
    page.on("console", (message) => {
      if (/Content Security Policy/i.test(message.text())) violations.push(message.text());
    });
    await page.goto("/auth/sign-up");
    await page.getByPlaceholder("John Doe").fill("Signup E2E");
    await page.getByPlaceholder("you@example.com").fill(`${prefix}-widget@${VALID_DOMAIN}`);
    await page.getByPlaceholder("********").first().fill(PASSWORD);
    await page.getByPlaceholder("********").last().fill(PASSWORD);
    const submit = page.getByRole("button", { name: "Sign up" });
    // The test site key passes on its own once the challenge frame has run.
    await expect(submit).toBeEnabled({ timeout: 30_000 });
    await submit.click();
    await expect(page.getByText(/Check your inbox|get started/i).first()).toBeVisible();
    expect(violations).toEqual([]);
  });
});
