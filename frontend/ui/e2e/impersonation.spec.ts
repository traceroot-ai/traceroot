import { test, expect, type BrowserContext, type APIRequestContext } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { createHmac, randomUUID } from "node:crypto";

// Intentionally localhost-only: fixtures must never touch a remote tenant.
const database = new URL(process.env.DATABASE_URL!);
if (!["localhost", "127.0.0.1"].includes(database.hostname))
  throw new Error("E2E requires local Postgres");
const prisma = new PrismaClient();
const prefix = `support-e2e-${randomUUID()}`;
const ids = {
  admin: `${prefix}-admin`,
  support: `${prefix}-support`,
  employee: `${prefix}-employee`,
  customer: `${prefix}-customer`,
  viewer: `${prefix}-viewer`,
  workspace: `${prefix}-workspace`,
  second: `${prefix}-second`,
  project: `${prefix}-project`,
};
const emails = {
  admin: `${prefix}-admin@traceroot.ai`,
  support: `${prefix}-support@traceroot.ai`,
  employee: `${prefix}-employee@traceroot.ai`,
  customer: `${prefix}@example.com`,
  viewer: `${prefix}-viewer@example.com`,
};
const base = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const restBase = process.env.E2E_REST_URL ?? "http://localhost:8000";
for (const url of [base, restBase])
  if (!["localhost", "127.0.0.1"].includes(new URL(url).hostname))
    throw new Error("E2E requires local UI and REST servers");
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
const start = (
  request: APIRequestContext,
  userId = ids.customer,
  reason = "Investigate E2E support ticket",
) =>
  request.post("/api/auth/support/start", { data: { userId, reason }, headers: { origin: base } });
const stop = (request: APIRequestContext) =>
  request.post("/api/auth/support/stop", { data: {}, headers: { origin: base } });
const grant = (request: APIRequestContext, email: string, role: string | null) =>
  request.post("/api/support", { data: { email, role }, headers: { origin: base } });

test.beforeAll(async () => {
  for (const key of ["admin", "support", "employee", "customer", "viewer"] as const)
    await prisma.user.create({
      data: {
        id: ids[key],
        email: emails[key],
        name: `E2E ${key}`,
        emailVerified: true,
        role: key === "admin" || key === "support" ? key : null,
      },
    });
  await prisma.workspace.create({
    data: {
      id: ids.workspace,
      name: "E2E customer workspace",
      members: {
        create: [
          { id: randomUUID(), userId: ids.customer, role: "ADMIN" },
          { id: randomUUID(), userId: ids.viewer, role: "VIEWER" },
        ],
      },
      projects: { create: { id: ids.project, name: "E2E project" } },
    },
  });
  await prisma.workspace.create({
    data: {
      id: ids.second,
      name: "E2E second workspace",
      members: { create: { id: randomUUID(), userId: ids.customer, role: "MEMBER" } },
    },
  });
});
test.afterAll(async () => {
  // Only IDs allocated above; never delete existing user/customer data.
  await prisma.workspace.deleteMany({ where: { id: { in: [ids.workspace, ids.second] } } });
  await prisma.user.deleteMany({
    where: { id: { in: [ids.admin, ids.support, ids.employee, ids.customer, ids.viewer] } },
  });
  await prisma.auditLog.deleteMany({
    where: { actorUserId: { in: [ids.admin, ids.support, ids.employee] } },
  });
  await prisma.$disconnect();
});

test("stale restoration cookie cannot replace a fresh customer login", async ({ context }) => {
  await login(context, ids.admin);
  expect((await start(context.request)).status()).toBe(200);
  await login(context, ids.viewer);
  expect((await stop(context.request)).status()).toBe(200);
  const session = await (await context.request.get("/api/auth/get-session")).json();
  expect(session.user.id).toBe(ids.viewer);
  expect((await context.cookies()).some((cookie) => cookie.name.includes("support_original"))).toBe(
    false,
  );
});

test("expired impersonation can recover from the admin page", async ({ context, page }) => {
  await login(context, ids.admin);
  expect((await start(context.request)).status()).toBe(200);
  const { session } = await (await context.request.get("/api/auth/get-session")).json();
  await prisma.session.update({ where: { id: session.id }, data: { expiresAt: new Date(0) } });
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "This support session has ended" })).toBeVisible();
  await page.getByRole("button", { name: "Back to my account" }).first().click();
  await expect(page.getByRole("heading", { name: "Support console" })).toBeVisible();
});

test("out-of-range console page clamps to the last non-empty page", async ({ context, page }) => {
  await login(context, ids.admin);
  await page.goto(`/admin?q=${encodeURIComponent(emails.customer)}&page=999`);
  await expect(page.getByText(/1 results · Page 1 of 1/)).toBeVisible();
  await expect(page.getByText(emails.customer, { exact: true })).toBeVisible();
});

test("support UI: browse, search, workspaces, reason, banner, exit and audit", async ({
  page,
  context,
}) => {
  await login(context, ids.support);
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Support console" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Staff access" })).toHaveCount(0);
  await expect(page.locator('nav a[href="/admin"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Account menu" }).click();
  await expect(page.getByRole("link", { name: "Support console", exact: true })).toBeVisible();
  await page.screenshot({ path: "/tmp/impersonation-account-menu.png", fullPage: true });
  await page.getByRole("link", { name: "Support console", exact: true }).click();
  await expect(page.getByRole("link", { name: "Support console", exact: true })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Access logs" })).toHaveCount(0);
  expect((await context.request.get("/api/support?view=staff")).status()).toBe(404);
  await page.getByRole("textbox", { name: "Search users" }).fill(emails.customer);
  await expect(page.getByText(emails.customer, { exact: true })).toBeVisible();
  const customerRow = page.getByRole("row").filter({ hasText: emails.customer });
  await expect(customerRow.getByRole("cell")).toHaveCount(3);
  await expect(customerRow.getByRole("cell").nth(1)).toHaveText("2");
  await expect(customerRow.getByRole("cell").first()).toContainText(ids.customer);
  await expect(customerRow.getByRole("cell").first().getByRole("button")).toHaveCount(0);
  await page.screenshot({ path: "/tmp/impersonation-user-two-lines.png", fullPage: true });
  await expect(page.getByRole("columnheader", { name: "User ID", exact: true })).toHaveCount(0);
  await expect(page.getByText("Workspace admin", { exact: true })).toHaveCount(0);
  await expect(customerRow.getByRole("button", { name: /workspaces/ })).toHaveCount(0);
  await customerRow.getByRole("button", { name: "Impersonate", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveAccessibleName(`Impersonate E2E customer`);
  await expect(page.getByRole("dialog")).toHaveAccessibleDescription(emails.customer);
  await expect(page.getByRole("dialog").getByText(/Read-only:|Read \+ write:/)).toHaveCount(0);
  await page.screenshot({ path: "/tmp/impersonation-simple-dialog.png", fullPage: true });
  await expect(page.getByText("Maximum 2 hours", { exact: false })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Start session" })).toBeEnabled();
  await page
    .getByRole("textbox", { name: "Reason" })
    .fill("Investigate missing traces in E2E ticket");
  await page.getByRole("button", { name: "Start session" }).click();
  await page.waitForURL(base + "/");
  await expect(page.getByRole("button", { name: "Exit impersonation" })).toBeVisible();
  await expect(page.getByText("Read-only", { exact: true })).toBeVisible();
  await expect(page.getByText("Reason:", { exact: false })).toHaveCount(0);
  await expect(
    page.getByText("Investigate missing traces in E2E ticket", { exact: false }),
  ).toHaveCount(0);
  expect((await context.request.get("/api/workspaces")).status()).toBe(200);
  expect(
    (
      await context.request.put(`/api/workspaces/${ids.workspace}`, {
        data: { name: "not allowed" },
      })
    ).status(),
  ).toBe(403);
  await page.getByRole("button", { name: "Exit impersonation" }).click();
  await page.waitForURL(/\/admin\?/);
  await expect(page.getByRole("textbox", { name: "Search users" })).toHaveValue(emails.customer);
  const audit = await prisma.auditLog.findFirst({
    where: { actorUserId: ids.support, operation: "impersonation.started" },
    orderBy: { createTime: "desc" },
  });
  expect(audit?.summary).toMatchObject({ reason: "Investigate missing traces in E2E ticket" });
  expect(audit?.endReason).toBe("exit");
});

test("staff grants, no self-change, role boundaries and immediate revocation", async ({
  context,
  browser,
}) => {
  await login(context, ids.admin);
  const staff = await browser.newContext({ baseURL: base });
  await login(staff, ids.employee);
  try {
    expect((await staff.request.get("/admin")).status()).toBe(404);
    expect((await grant(context.request, emails.admin, "support")).status()).toBe(400);
    expect((await grant(context.request, emails.customer, "support")).status()).toBe(400);
    expect((await grant(context.request, emails.employee.toUpperCase(), "support")).status()).toBe(
      200,
    );
    expect((await staff.request.get("/api/support")).status()).toBe(200);
    expect((await grant(staff.request, emails.employee, "admin")).status()).toBe(404);
    expect((await start(staff.request, ids.admin)).status()).toBe(403);
    expect((await start(staff.request, ids.customer, "x".repeat(501))).status()).toBe(400);
    expect((await start(staff.request)).status()).toBe(200);
    expect((await grant(context.request, emails.employee, null)).status()).toBe(200);
    expect((await staff.request.get("/api/workspaces")).status()).toBe(403);
    expect((await stop(staff.request)).status()).toBe(200);
    expect((await staff.request.get("/api/support")).status()).toBe(404);
    expect(
      await prisma.auditLog.count({
        where: {
          targetUserId: ids.employee,
          operation: { in: ["staff.granted", "staff.revoked"] },
        },
      }),
    ).toBe(2);
  } finally {
    await staff.close();
  }
});

test("admin writes preserve customer permissions; downgrade immediately removes writes", async ({
  context,
  browser,
}) => {
  await login(context, ids.admin);
  expect((await start(context.request, ids.viewer)).status()).toBe(200);
  expect(
    (
      await context.request.put(`/api/workspaces/${ids.workspace}`, {
        data: { name: "forbidden viewer write" },
      })
    ).status(),
  ).toBe(403);
  await stop(context.request);
  expect((await start(context.request)).status()).toBe(200);
  expect(
    (
      await context.request.put(`/api/workspaces/${ids.workspace}`, {
        data: { name: "E2E renamed by admin" },
      })
    ).status(),
  ).toBe(200);
  const audit = await prisma.auditLog.findFirst({
    where: {
      actorUserId: ids.admin,
      targetUserId: ids.customer,
      operation: "impersonation.write",
      outcome: "success",
    },
  });
  expect(audit?.workspaceId).toBe(ids.workspace);
  expect(audit?.actorEmail).toBe(emails.admin);
  await stop(context.request);
  // Use a separately granted admin, never change the real founder's account.
  expect((await grant(context.request, emails.employee, "admin")).status()).toBe(200);
  const other = await browser.newContext({ baseURL: base });
  await login(other, ids.employee);
  try {
    expect((await start(other.request)).status()).toBe(200);
    expect((await grant(context.request, emails.employee, "support")).status()).toBe(200);
    expect((await other.request.get("/api/workspaces")).status()).toBe(200);
    expect(
      (
        await other.request.put(`/api/workspaces/${ids.workspace}`, {
          data: { name: "forbidden after downgrade" },
        })
      ).status(),
    ).toBe(403);
    await stop(other.request);
  } finally {
    await other.close();
  }
});

test("hard blocks credential escapes without an impersonation-specific duration cap", async ({
  context,
}) => {
  await login(context, ids.admin);
  expect((await start(context.request)).status()).toBe(200);
  const sessionResponse = await context.request.get("/api/auth/get-session");
  expect(sessionResponse.headers()["set-auth-jwt"]).toBeUndefined();
  const { session } = await sessionResponse.json();
  expect((await context.request.get("/api/auth/token")).status()).toBe(403);
  expect(
    (
      await context.request.post(`/api/workspaces/${ids.workspace}/model-providers/test`, {
        data: { providerId: "stored", baseUrl: "https://example.com" },
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await context.request.patch(`/api/workspaces/${ids.workspace}/model-providers/stored`, {
        data: { baseUrl: "https://example.com" },
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await context.request.post("/api/auth/device/approve", {
        data: { userCode: "ABCD-EFGH" },
        headers: { origin: base },
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await context.request.post("/api/auth/update-user", {
        data: { name: "takeover" },
        headers: { origin: base },
      })
    ).status(),
  ).toBe(403);
  expect(
    (await context.request.get(`/api/github/token?workspaceId=${ids.workspace}`)).status(),
  ).toBe(403);
  expect(
    (
      await context.request.post("/api/cli/token", {
        headers: { authorization: `Bearer ${session.token}` },
      })
    ).status(),
  ).toBe(401);
  expect(
    (
      await context.request.post("/api/auth/admin/impersonate-user", {
        data: { userId: ids.viewer },
        headers: { origin: base },
      })
    ).status(),
  ).toBe(403);
  expect((await context.request.get(`/api/projects/${ids.project}/dashboards`)).status()).toBe(200);
  expect(await prisma.dashboard.count({ where: { projectId: ids.project } })).toBe(0);
  await prisma.session.update({
    where: { id: session.id },
    data: { createdAt: new Date(Date.now() - 7201000), expiresAt: new Date(Date.now() + 86400000) },
  });
  expect((await context.request.get("/api/workspaces")).status()).toBe(200);
  const inactiveExpiry = new Date(Date.now() - 1000);
  await prisma.session.update({ where: { id: session.id }, data: { expiresAt: inactiveExpiry } });
  expect((await stop(context.request)).status()).toBe(200);
  const ended = await prisma.auditLog.findFirst({
    where: { impersonationSessionId: session.id, operation: "impersonation.started" },
  });
  expect(ended?.endReason).toBe("expired");
  expect((await context.request.get("/api/support")).status()).toBe(200);
});

test("Python reads use the real session, reject forged identity and revoked support", async ({
  context,
  browser,
}) => {
  await login(context, ids.support);
  const outsider = await browser.newContext();
  try {
    expect(
      (
        await outsider.request.get(`${restBase}/api/v1/projects/${ids.project}/traces/exists`, {
          headers: { "x-user-id": ids.customer },
        })
      ).status(),
    ).toBe(401);
    expect((await start(context.request)).status()).toBe(200);
    expect(
      (
        await context.request.get(`${restBase}/api/v1/projects/${ids.project}/traces/exists`)
      ).status(),
    ).toBe(200);
    const { session } = await (await context.request.get("/api/auth/get-session")).json();
    await prisma.auditLog.updateMany({
      where: { impersonationSessionId: session.id },
      data: { endedAt: new Date(), endReason: "revoked" },
    });
    expect(
      (
        await context.request.get(`${restBase}/api/v1/projects/${ids.project}/traces/exists`)
      ).status(),
    ).toBe(401);
    await stop(context.request);
  } finally {
    await outsider.close();
  }
});

test("admin UI grants access and deep links switch customers through an audited exit", async ({
  page,
  context,
}) => {
  await login(context, ids.admin);
  await page.goto("/admin");
  await page.getByRole("tab", { name: "Staff access" }).click();
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Access logs" })).toHaveCount(0);
  const listing = await (
    await context.request.get("/api/support?view=staff&q=ignored&page=2")
  ).json();
  expect(listing.rows.some((user: { id: string }) => user.id === ids.employee)).toBe(true);
  expect(
    listing.rows.every((user: { email: string }) =>
      user.email.toLowerCase().endsWith("@traceroot.ai"),
    ),
  ).toBe(true);
  const ownRow = page.getByRole("row").filter({ hasText: emails.admin });
  await expect(ownRow.getByRole("button", { name: "Admin", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(ownRow.getByRole("button", { name: "Support", exact: true })).toBeDisabled();
  const employeeRow = page.getByRole("row").filter({ hasText: emails.employee });
  const setRole = async (label: string) => {
    await employeeRow.getByRole("button", { name: label, exact: true }).click();
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  };
  await setRole("Admin");
  await expect(employeeRow.getByRole("button", { name: "Admin", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await setRole("Support");
  await expect(employeeRow.getByRole("button", { name: "Support", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await setRole("No Access");
  await expect(employeeRow.getByRole("button", { name: "No Access", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.screenshot({ path: "/tmp/impersonation-staff-inline.png", fullPage: true });
  await expect(page.getByText(emails.employee, { exact: true })).toBeVisible();
  await page.goto(`/admin/impersonate?userId=${ids.customer}`);
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("textbox", { name: "Reason" }).fill("Deep link support investigation");
  await page.getByRole("button", { name: "Start session" }).click();
  await expect(page.getByRole("button", { name: "Exit impersonation", exact: true })).toBeVisible();
  await page.goto(`/admin/impersonate?userId=${ids.viewer}`);
  await page.getByRole("button", { name: "Exit and continue" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveAccessibleDescription(emails.viewer);
  const started = await prisma.auditLog.findFirst({
    where: {
      actorUserId: ids.admin,
      summary: { path: ["reason"], equals: "Deep link support investigation" },
    },
  });
  expect(started?.endReason).toBe("exit");
});

test("exit without a restoration cookie still revokes the impersonated token", async ({
  context,
}) => {
  await login(context, ids.support);
  expect((await start(context.request)).status()).toBe(200);
  const { session } = await (await context.request.get("/api/auth/get-session")).json();
  await context.clearCookies({ name: "better-auth.support_original" });
  const response = await stop(context.request);
  expect(response.status()).toBe(200);
  expect((await response.json()).restored).toBe(false);
  expect(await prisma.session.findUnique({ where: { id: session.id } })).toBeNull();
  const audit = await prisma.auditLog.findFirst({
    where: { impersonationSessionId: session.id, operation: "impersonation.started" },
  });
  expect(audit?.endReason).toBe("exit");
});

test("optional reason: omitted, blank and short values still produce an audit record", async ({
  context,
}) => {
  await login(context, ids.support);
  for (const reason of [undefined, "", "   ", " x "]) {
    const response = await context.request.post("/api/auth/support/start", {
      data: { userId: ids.customer, ...(reason === undefined ? {} : { reason }) },
      headers: { origin: base },
    });
    expect(response.status()).toBe(200);
    const { session } = await (await context.request.get("/api/auth/get-session")).json();
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { impersonationSessionId: session.id, operation: "impersonation.started" },
    });
    expect(audit.summary).toMatchObject({ reason: reason?.trim() || null });
    expect((await stop(context.request)).status()).toBe(200);
  }
});

test("customer session can be started in the UI without entering a reason", async ({
  page,
  context,
}) => {
  await login(context, ids.support);
  await page.goto(`/admin/impersonate?userId=${ids.customer}`);
  await expect(page.getByRole("textbox", { name: "Reason (optional)", exact: true })).toHaveValue(
    "",
  );
  await page.getByRole("button", { name: "Start session" }).click();
  await expect(page.getByRole("button", { name: "Exit impersonation", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Exit impersonation", exact: true }).click();
  await page.waitForURL(/\/admin\?/);
});

test("an ended session unwinds itself instead of stranding the employee", async ({
  page,
  context,
}) => {
  await login(context, ids.support);
  try {
    // API path: the next session read restores the employee login by itself.
    expect((await start(context.request)).status()).toBe(200);
    await prisma.user.update({ where: { id: ids.customer }, data: { banned: true } });
    const session = await context.request.get("/api/auth/get-session");
    expect(session.status()).toBe(200);
    expect((await session.json())?.user?.id).toBe(ids.support);
    expect((await context.request.get("/api/support?view=users")).status()).toBe(200);
    const audit = await prisma.auditLog.findFirst({
      where: { actorUserId: ids.support, operation: "impersonation.started" },
      orderBy: { createTime: "desc" },
    });
    expect(audit?.endReason).toBe("target_unavailable");
    // Stopping again on the restored login must not sign the employee out.
    const again = await stop(context.request);
    expect((await again.json()).restored).toBe(true);
    expect((await context.request.get("/api/support?view=users")).status()).toBe(200);

    // Page path: the console offers a way back rather than a 404.
    await prisma.user.update({ where: { id: ids.customer }, data: { banned: false } });
    expect((await start(context.request)).status()).toBe(200);
    await prisma.user.update({ where: { id: ids.customer }, data: { banned: true } });
    await page.goto("/admin");
    await expect(
      page.getByRole("heading", { name: "This support session has ended" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Back to my account" }).click();
    await expect(page.getByRole("heading", { name: "Support console" })).toBeVisible();
  } finally {
    await prisma.user.update({ where: { id: ids.customer }, data: { banned: false } });
  }
});
