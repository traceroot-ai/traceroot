import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@/lib/support/route-guard", () => ({
  withImpersonationPolicy: (handler: unknown) => handler,
}));
vi.mock("@/lib/dashboard-seed", () => ({ seedDefaultDashboard: vi.fn() }));

const db = vi.hoisted(() => ({
  project: { findFirst: vi.fn() },
  detector: { findMany: vi.fn(), findFirst: vi.fn(), count: vi.fn() },
  dashboard: { findMany: vi.fn(), findFirst: vi.fn() },
  user: { findMany: vi.fn() },
}));
const access = vi.hoisted(() => ({ workspaceId: "demo", role: "VIEWER" }));
vi.mock("@traceroot/core", async (original) => ({
  ...(await original<typeof import("@traceroot/core")>()),
  prisma: { ...db, $transaction: (queries: Promise<unknown>[]) => Promise.all(queries) },
}));
vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: async () => ({ user: { id: "visitor" } }),
  requireProjectAccess: async () => ({
    project: { id: "project", workspaceId: access.workspaceId },
    membership: { role: access.role },
  }),
  successResponse: (data: unknown, status = 200) => ({ status, data }),
  errorResponse: (error: string, status: number) => ({ status, data: { error } }),
}));
vi.mock("@/lib/route-helpers", () => ({
  requireProjectAuth: async (params: Promise<unknown>) => ({
    user: { id: "visitor" },
    params: await params,
  }),
}));

import { GET as project } from "./projects/[projectId]/route";
import { GET as detectors } from "./projects/[projectId]/detectors/route";
import { GET as detector } from "./projects/[projectId]/detectors/[detectorId]/route";
import { GET as dashboards } from "./projects/[projectId]/dashboards/route";
import { GET as dashboard } from "./projects/[projectId]/dashboards/[dashboardId]/route";
import { getTemplate } from "@/features/detectors/templates";

const internalDetector = {
  id: "detector",
  projectId: "project",
  name: "Example failures",
  template: "failure",
  prompt: "INTERNAL_PROMPT",
  outputSchema: [{ name: "INTERNAL_SCHEMA", type: "string" }],
  sampleRate: 97,
  enabled: true,
  enableRca: true,
  enableSignals: true,
  detectionModel: "INTERNAL_MODEL",
  detectionProvider: "INTERNAL_PROVIDER",
  detectionSource: "byok",
  trigger: { conditions: [{ field: "cost", op: ">", value: 981 }] },
  createTime: "2026-11-01",
  updateTime: "2026-11-01",
  futureSecret: "INTERNAL_FUTURE_FIELD",
};
const params = {
  params: Promise.resolve({
    projectId: "project",
    detectorId: "detector",
    dashboardId: "dashboard",
  }),
};
const request = { nextUrl: new URL("https://app.example/api?search_query=failures") };
type Result = { status: number; data: Record<string, unknown> };
const call = (handler: unknown) =>
  (handler as (req: unknown, ctx: unknown) => Promise<Result>)(request, params);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DEMO_WORKSPACE_ID", "demo");
  access.workspaceId = "demo";
  access.role = "VIEWER";
  db.project.findFirst.mockImplementation(async ({ where }) => {
    if (where.workspaceId && where.workspaceId !== access.workspaceId) return null;
    return {
      id: "project",
      workspaceId: access.workspaceId,
      name: "Demo Project",
      traceTtlDays: null,
      rcaModel: "INTERNAL_MODEL",
      rcaProvider: "INTERNAL_PROVIDER",
      rcaSource: "byok",
      alertConfig: { emailAddresses: ["staff@example.com"], alertWindow: "10m" },
      _count: { accessKeys: 7 },
      createTime: "2026-11-01",
      updateTime: "2026-11-01",
    };
  });
  db.detector.findMany.mockResolvedValue([internalDetector]);
  db.detector.findFirst.mockResolvedValue(internalDetector);
  db.detector.count.mockResolvedValue(1);
  const row = { id: "dashboard", name: "Example dashboard", createdBy: "staff", widgets: [] };
  db.dashboard.findMany.mockResolvedValue([row]);
  db.dashboard.findFirst.mockResolvedValue(row);
  db.user.findMany.mockResolvedValue([
    { id: "staff", name: "Staff Name", email: "staff@example.com" },
  ]);
});
afterEach(() => vi.unstubAllEnvs());

it("returns demo identity without working model, alert window or key metadata", async () => {
  const result = await call(project);
  expect(result.status).toBe(200);
  expect(result.data).toMatchObject({ id: "project", name: "Demo Project", alert_emails: [] });
  for (const key of [
    "rca_model",
    "rca_provider",
    "rca_source",
    "alert_window",
    "access_key_count",
  ]) {
    expect(result.data).not.toHaveProperty(key);
  }
});

it("publishes the same public template in detector list and detail, not working configuration", async () => {
  const list = (await call(detectors)).data.data as Record<string, unknown>[];
  const detail = (await call(detector)).data.detector;
  expect(list[0]).toEqual(detail);
  expect(list[0].prompt).toBe(getTemplate("failure")!.prompt);
  expect(list[0]).toMatchObject({
    id: "detector",
    name: "Example failures",
    trigger: null,
    detectionModel: null,
  });
  expect(JSON.stringify(list)).not.toContain("INTERNAL_");
  expect(JSON.stringify(list)).not.toContain("981");
  // Searching must not disclose the redacted prompt through result counts.
  const where = db.detector.count.mock.calls[0][0].where;
  expect(where.OR).toEqual([
    { name: { contains: "failures", mode: "insensitive" } },
    { template: { contains: "failures", mode: "insensitive" } },
  ]);
});

it("does not turn unknown custom templates into a disclosure path", async () => {
  db.detector.findFirst.mockResolvedValue({ ...internalDetector, template: "custom" });
  expect((await call(detector)).data.detector).toMatchObject({ prompt: "", outputSchema: [] });
});

it("uses a demo creator label in both dashboard reads without resolving staff identities", async () => {
  const list = (await call(dashboards)).data.data as Record<string, unknown>[];
  const detail = (await call(dashboard)).data.dashboard as Record<string, unknown>;
  for (const item of [list[0], detail]) {
    expect(item.creator).toBe("Demo");
    expect(item).not.toHaveProperty("createdBy");
  }
  expect(db.user.findMany).not.toHaveBeenCalled();
});

it.each([
  ["ADMIN", "demo"],
  ["VIEWER", "own"],
])("preserves configuration access for %s in %s", async (role, workspaceId) => {
  access.role = role;
  access.workspaceId = workspaceId;
  expect((await call(project)).data).toMatchObject({
    rca_model: "INTERNAL_MODEL",
    alert_window: "10m",
    access_key_count: 7,
  });
  expect((await call(detector)).data.detector).toMatchObject({ prompt: "INTERNAL_PROMPT" });
  const list = (await call(detectors)).data.data as Record<string, unknown>[];
  expect(list[0].prompt).toBe("INTERNAL_PROMPT");
  if (workspaceId !== "demo") {
    const list = (await call(dashboards)).data.data as Record<string, unknown>[];
    expect(list[0].creator).toBe("Staff Name");
    expect((await call(dashboard)).data.dashboard).toMatchObject({ createdBy: "staff" });
  }
});

it("keeps a missing detector a 404", async () => {
  db.detector.findFirst.mockResolvedValue(null);
  expect((await call(detector)).status).toBe(404);
});
