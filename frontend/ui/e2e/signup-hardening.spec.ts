import { test, expect, type APIRequestContext } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

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
// A real, deliverable domain for the accepted path. Nothing is sent to it: the
// guard above keeps product mail and Slack off, and afterAll deletes the
// accounts.
const VALID_DOMAIN = "traceroot.ai";

// Keep the per-IP sign-up budget independent between tests.
const ip = () => `198.51.100.${Math.floor(Math.random() * 250) + 1}`;

function signUp(request: APIRequestContext, email: string, clientIp = ip()) {
  return request.post("/api/auth/sign-up/email", {
    data: { name: "Signup E2E", email, password: "correct-horse-battery" },
    headers: { origin: base, "x-forwarded-for": clientIp },
  });
}

test.afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: prefix } } });
  await prisma.$disconnect();
});

test.describe("sign-up domain policy", () => {
  for (const [domain, code] of [
    ["example.com", "EMAIL_DOMAIN_RESERVED"],
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
});
