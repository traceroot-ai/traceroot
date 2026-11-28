import { test, expect, type APIRequestContext } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

const base = process.env.E2E_BASE_URL ?? "http://localhost:3000";
test.use({ baseURL: base });
const database = new URL(process.env.DATABASE_URL!);
if (
  !["localhost", "127.0.0.1"].includes(database.hostname) ||
  !["localhost", "127.0.0.1"].includes(new URL(base).hostname)
)
  throw new Error("Demo access E2E requires a local UI and Postgres");
const workspaceId = process.env.DEMO_WORKSPACE_ID;
if (!workspaceId) throw new Error("Set DEMO_WORKSPACE_ID to an unused test workspace id");
const prisma = new PrismaClient();
const prefix = `demo-access-e2e-${randomUUID()}`;
const projectId = `${prefix}-project`;
const email = `${prefix}@example.com`;
const password = randomUUID();
let userId: string | undefined;
let seeded = false;

async function signIn(request: APIRequestContext) {
  const response = await request.post(`${base}/api/auth/sign-in/email`, {
    headers: { Origin: base },
    data: { email, password },
  });
  expect(response.status()).toBe(200);
}

test.beforeAll(async () => {
  // create (never upsert): an existing workspace makes the test fail before any cleanup.
  await prisma.workspace.create({
    data: {
      id: workspaceId,
      name: "Published demo",
      projects: {
        create: {
          id: projectId,
          name: "Sample project",
          rcaModel: "private-model",
          detectors: {
            create: {
              id: `${prefix}-detector`,
              name: "Example failure",
              template: "failure",
              prompt: "PRIVATE_WORKING_PROMPT",
              outputSchema: [{ name: "private_field", type: "string" }],
            },
          },
          dashboards: {
            create: { id: `${prefix}-dashboard`, name: "Overview", createdBy: "private-staff-id" },
          },
        },
      },
    },
  });
  seeded = true;
});

test.afterAll(async () => {
  if (seeded) await prisma.workspace.delete({ where: { id: workspaceId } });
  if (userId) await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

test("demo membership requires a choice and stays revoked after another login", async ({
  page,
  context,
}) => {
  test.setTimeout(180_000);
  const request = context.request;
  const fixture = await request.post(`${base}/api/internal/project-dashboard`, {
    headers: { "X-Internal-Secret": process.env.INTERNAL_API_SECRET! },
    data: { projectId, dashboardId: `${prefix}-dashboard` },
  });
  // Prove the UI uses the database seeded above before creating an account.
  expect(fixture.status()).toBe(200);
  expect((await fixture.json()).dashboard.id).toBe(`${prefix}-dashboard`);
  const signup = await request.post(`${base}/api/auth/sign-up/email`, {
    headers: { Origin: base },
    data: { email, password, name: "Demo visitor" },
  });
  expect(signup.status()).toBe(200);
  userId = (await signup.json()).user.id;
  const membership = () =>
    prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: workspaceId!, userId: userId! } },
    });
  expect(await membership()).toBeNull();
  await signIn(request);
  expect(await membership()).toBeNull();
  expect((await request.get(`${base}/api/projects/${projectId}`)).status()).toBe(403);

  await page.goto(`${base}/demo`);
  await expect(page.getByRole("button", { name: "Join demo", exact: true })).toBeVisible();
  expect(await membership()).toBeNull();
  await page.getByRole("button", { name: "Join demo", exact: true }).click();
  await expect(page).toHaveURL(`${base}/projects/${projectId}/traces`);
  expect((await membership())?.role).toBe("VIEWER");

  const configuration = await (await request.get(`${base}/api/projects/${projectId}`)).json();
  expect(configuration).not.toHaveProperty("rca_model");
  expect(configuration).not.toHaveProperty("access_key_count");
  const detectors = await (await request.get(`${base}/api/projects/${projectId}/detectors`)).json();
  expect(JSON.stringify(detectors)).not.toContain("PRIVATE_WORKING_PROMPT");
  expect(JSON.stringify(detectors)).not.toContain("private_field");
  const dashboards = await (
    await request.get(`${base}/api/projects/${projectId}/dashboards`)
  ).json();
  expect(dashboards.data[0].creator).toBe("Demo");
  expect(JSON.stringify(dashboards)).not.toContain("private-staff-id");
  expect((await request.get(`${base}/api/projects/${projectId}/api-keys`)).status()).toBe(403);
  expect((await request.get(`${base}/api/workspaces/${workspaceId}/members`)).status()).toBe(403);

  // Repeated join remains one VIEWER membership.
  const joins = await Promise.all([
    request.post(`${base}/api/demo`),
    request.post(`${base}/api/demo`),
  ]);
  expect(joins.map((response) => response.status())).toEqual([200, 200]);
  await page.goto(`${base}/demo`);
  await page.getByRole("button", { name: "Leave demo", exact: true }).click();
  await expect(page.getByRole("button", { name: "Join demo", exact: true })).toBeVisible();
  expect(await membership()).toBeNull();
  expect((await request.get(`${base}/api/projects/${projectId}`)).status()).toBe(403);
  await request.post(`${base}/api/auth/sign-out`, { headers: { Origin: base } });
  await signIn(request);
  expect(await membership()).toBeNull();
  expect((await request.get(`${base}/api/projects/${projectId}`)).status()).toBe(403);

  await prisma.workspaceMember.create({
    data: { id: `${prefix}-admin`, workspaceId: workspaceId!, userId: userId!, role: "ADMIN" },
  });
  expect((await request.post(`${base}/api/demo`)).status()).toBe(200);
  expect((await membership())?.role).toBe("ADMIN");
  expect((await request.delete(`${base}/api/demo`)).status()).toBe(403);
  expect((await membership())?.role).toBe("ADMIN");
});
