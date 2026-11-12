import { test, expect, type APIRequestContext } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

const prisma = new PrismaClient();
const prefix = `signup-e2e-${randomUUID()}`;

// Keep the per-IP sign-up budget independent between tests.
const ip = () => `198.51.100.${Math.floor(Math.random() * 250) + 1}`;

function signUp(request: APIRequestContext, email: string, clientIp = ip()) {
  return request.post("/api/auth/sign-up/email", {
    data: { name: "Signup E2E", email, password: "correct-horse-battery" },
    headers: { origin: test.info().project.use.baseURL!, "x-forwarded-for": clientIp },
  });
}

test.afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: prefix } } });
  await prisma.$disconnect();
});

for (const domain of ["workspace.test", "workspace.local", "mailinator.com"]) {
  test(`creates a local account on ${domain}`, async ({ request }) => {
    const email = `${prefix}@${domain}`;
    const response = await signUp(request, email);
    expect(response.status()).toBe(200);
    expect(await prisma.user.findUnique({ where: { email } })).not.toBeNull();
  });
}
