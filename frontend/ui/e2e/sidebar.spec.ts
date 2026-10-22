import { test, expect, type BrowserContext } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { createHmac, randomUUID } from "node:crypto";

// Intentionally localhost-only: fixtures must never touch a remote tenant.
const database = new URL(process.env.DATABASE_URL!);
if (!["localhost", "127.0.0.1"].includes(database.hostname))
  throw new Error("E2E requires local Postgres");
const prisma = new PrismaClient();
const prefix = `sidebar-e2e-${randomUUID()}`;
const ids = {
  user: `${prefix}-user`,
  workspace: `${prefix}-workspace`,
  project: `${prefix}-project`,
};
const base = process.env.E2E_BASE_URL ?? "http://localhost:3000";
if (!["localhost", "127.0.0.1"].includes(new URL(base).hostname))
  throw new Error("E2E requires a local UI server");
async function login(context: BrowserContext, userId: string) {
  const token = randomUUID();
  await prisma.session.create({
    data: { id: randomUUID(), token, userId, expiresAt: new Date(Date.now() + 86400000) },
  });
  const signature = createHmac("sha256", process.env.BETTER_AUTH_SECRET!)
    .update(token)
    .digest("base64");
  await context.addCookies([
    {
      name: "better-auth.session_token",
      value: encodeURIComponent(`${token}.${signature}`),
      url: base,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
}

test.beforeAll(async () => {
  await prisma.user.create({
    data: { id: ids.user, email: `${prefix}@example.com`, name: "E2E user", emailVerified: true },
  });
  await prisma.workspace.create({
    data: {
      id: ids.workspace,
      name: "E2E sidebar workspace",
      members: { create: { id: randomUUID(), userId: ids.user, role: "ADMIN" } },
      projects: { create: { id: ids.project, name: "E2E project" } },
    },
  });
});
test.afterAll(async () => {
  // Only IDs allocated above; never delete existing user/customer data.
  await prisma.workspace.deleteMany({ where: { id: ids.workspace } });
  await prisma.user.deleteMany({ where: { id: ids.user } });
  await prisma.$disconnect();
});

test("the agent page is labelled Agent in the sidebar, expanded and collapsed", async ({
  context,
  page,
}) => {
  await login(context, ids.user);
  await page.goto(`/projects/${ids.project}/home`);
  const agent = page.locator("nav a").first();
  await expect(agent).toHaveText("Agent");
  await expect(agent).toHaveAttribute("href", `/projects/${ids.project}/home`);
  await expect(agent).toHaveClass(/(^|\s)bg-muted(\s|$)/);
  await expect(page.locator("nav a").getByText("Home", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Toggle sidebar" }).click();
  await expect(agent).toHaveText("");
  await agent.hover();
  await expect(page.getByRole("tooltip")).toHaveText("Agent");
});

test("links hovered while expanded don't leave tooltips open after collapsing", async ({
  context,
  page,
}) => {
  await login(context, ids.user);
  await page.goto(`/projects/${ids.project}/home`);
  const links = page.locator("nav a");
  // Retry the hover: one that lands before hydration opens nothing
  for (const link of await links.all()) {
    await expect(async () => {
      await page.mouse.move(800, 400);
      await link.hover();
      await expect(link).toHaveAttribute("data-state", /open/, { timeout: 1000 });
    }).toPass();
  }
  await page.mouse.move(800, 400);
  await expect(links.first()).toHaveAttribute("data-state", "closed");

  await page.getByRole("button", { name: "Toggle sidebar" }).click();
  await page.mouse.move(800, 400);
  await expect(links.first()).toHaveText("");
  await expect(page.getByRole("tooltip")).toHaveCount(0);

  await links.nth(2).hover();
  await expect(page.getByRole("tooltip")).toHaveCount(1);
  await expect(page.getByRole("tooltip")).toHaveText("Detectors");
});
