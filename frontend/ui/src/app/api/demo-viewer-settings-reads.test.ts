// The settings reads that a demo viewer (a member of the demo workspace below
// ADMIN) must not get, checked route by route. The settings UI shows these
// users an "Access denied" card; these routes are the real check. Admins of the
// demo workspace and members of any other workspace see no change.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/support/route-guard", () => ({
  withImpersonationPolicy: (handler: unknown) => handler,
}));

vi.mock("next/server", () => ({
  NextRequest: class {},
  NextResponse: {
    json: (data: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, data }),
  },
}));

const db = vi.hoisted(() => ({
  workspaceFindUnique: vi.fn(),
  workspaceFindFirst: vi.fn(),
  modelProviderFindMany: vi.fn(),
  gitHubInstallationFindMany: vi.fn(),
  accessKeyFindMany: vi.fn(),
  projectFindFirst: vi.fn(),
}));

vi.mock("@traceroot/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@traceroot/core")>()),
  prisma: {
    workspace: { findUnique: db.workspaceFindUnique, findFirst: db.workspaceFindFirst },
    modelProvider: { findMany: db.modelProviderFindMany },
    gitHubInstallation: { findMany: db.gitHubInstallationFindMany },
    accessKey: { findMany: db.accessKeyFindMany },
    project: { findFirst: db.projectFindFirst },
  },
}));

const auth = vi.hoisted(() => ({ role: "VIEWER", workspaceId: "ws-demo" }));

vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: async () => ({ user: { id: "user-1" } }),
  requireWorkspaceMembership: async (_userId: string, workspaceId: string) => ({
    membership: { workspaceId, role: auth.role },
  }),
  requireProjectAccess: async () => ({
    project: { id: "proj-1", workspaceId: auth.workspaceId, name: "Demo Project" },
    membership: { workspaceId: auth.workspaceId, role: auth.role },
  }),
  errorResponse: (error: string, status: number) => ({ status, data: { error } }),
  successResponse: (data: unknown, status = 200) => ({ status, data }),
}));

vi.mock("@/lib/request-session", () => ({
  getRequestSession: async () => ({ user: { id: "user-1" } }),
}));

import { GET as getModelProviders } from "./workspaces/[workspaceId]/model-providers/route";
import { GET as getGitHubStatus } from "./github/status/route";
import { GET as getSubscriptionInfo } from "./billing/subscription-info/route";
import { GET as getApiKeys, POST as createApiKey } from "./projects/[projectId]/api-keys/route";
import { GET as getWorkspace } from "./workspaces/[workspaceId]/route";
import { GET as getProject } from "./projects/[projectId]/route";

type Result = { status: number; data: Record<string, unknown> };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (handler: unknown, ...args: unknown[]) => (handler as any)(...args) as Promise<Result>;
const workspaceParams = () => ({ params: Promise.resolve({ workspaceId: auth.workspaceId }) });
const projectParams = { params: Promise.resolve({ projectId: "proj-1" }) };
const query = () => ({
  url: `http://localhost/api/billing/subscription-info?workspaceId=${auth.workspaceId}`,
  nextUrl: new URL(`http://localhost/api/github/status?workspaceId=${auth.workspaceId}`),
});

const DENIED_READS: [string, () => Promise<Result>][] = [
  ["model providers", () => call(getModelProviders, {}, workspaceParams())],
  ["GitHub status", () => call(getGitHubStatus, query())],
  ["billing subscription info", () => call(getSubscriptionInfo, query())],
  ["project API keys", () => call(getApiKeys, {}, projectParams)],
];

beforeEach(() => {
  vi.stubEnv("DEMO_WORKSPACE_ID", "ws-demo");
  for (const fn of Object.values(db)) fn.mockReset();
  db.workspaceFindUnique.mockImplementation(async () => ({
    id: auth.workspaceId,
    name: "Workspace",
    createTime: "2026-10-01",
    projects: [],
    _count: { members: 3 },
    billingPlan: "enterprise",
    billingCustomerId: "cus_1",
    billingSubscriptionId: null,
    billingStatus: null,
    currentUsage: { traces: 10 },
  }));
  db.workspaceFindFirst.mockImplementation(async () => ({
    id: auth.workspaceId,
    billingSubscriptionId: null,
    members: [{ role: auth.role }],
  }));
  db.modelProviderFindMany.mockResolvedValue([]);
  db.gitHubInstallationFindMany.mockResolvedValue([]);
  db.accessKeyFindMany.mockResolvedValue([]);
  db.projectFindFirst.mockImplementation(async () => ({
    id: "proj-1",
    workspaceId: auth.workspaceId,
    name: "Demo Project",
    traceTtlDays: null,
    rcaModel: null,
    rcaProvider: null,
    rcaSource: null,
    alertConfig: { emailAddresses: ["oncall@traceroot.ai"], alertWindow: "1h" },
    _count: { accessKeys: 1 },
    createTime: "2026-10-01",
    updateTime: "2026-10-01",
  }));
});

afterEach(() => vi.unstubAllEnvs());

describe("a demo viewer", () => {
  beforeEach(() => {
    auth.role = "VIEWER";
    auth.workspaceId = "ws-demo";
  });

  it.each(DENIED_READS)("gets 403 for %s", async (_name, read) => {
    const res = await read();
    expect(res.status).toBe(403);
    expect(db.modelProviderFindMany).not.toHaveBeenCalled();
    expect(db.gitHubInstallationFindMany).not.toHaveBeenCalled();
    expect(db.accessKeyFindMany).not.toHaveBeenCalled();
  });

  it("reads the workspace for the General page, without its billing state", async () => {
    const res = await call(getWorkspace, {}, workspaceParams());
    expect(res.status).toBe(200);
    expect(res.data.name).toBe("Workspace");
    expect(res.data.retention_days).toBeNull();
    for (const field of [
      "billingPlan",
      "billingCustomerId",
      "billingSubscriptionId",
      "billingStatus",
      "currentUsage",
    ]) {
      expect(res.data).not.toHaveProperty(field);
    }
  });

  it.each(["VIEWER", "MEMBER"])("refuses API key creation by a demo %s", async (role) => {
    auth.role = role;
    expect((await call(createApiKey, {}, projectParams)).status).toBe(403);
  });

  it("reads the project without its alert email addresses", async () => {
    const res = await call(getProject, {}, projectParams);
    expect(res.status).toBe(200);
    expect(res.data.alert_emails).toEqual([]);
  });
});

describe.each([
  ["an admin of the demo workspace", "ADMIN", "ws-demo"],
  ["a viewer of another workspace", "VIEWER", "ws-own"],
])("%s", (_who, role, workspaceId) => {
  beforeEach(() => {
    auth.role = role;
    auth.workspaceId = workspaceId;
  });

  it.each(DENIED_READS)("still reads %s", async (_name, read) => {
    expect((await read()).status).toBe(200);
  });

  it("still gets the billing state and the alert emails", async () => {
    const workspace = await call(getWorkspace, {}, workspaceParams());
    expect(workspace.data.billingPlan).toBe("enterprise");
    expect(workspace.data.currentUsage).toEqual({ traces: 10 });
    const project = await call(getProject, {}, projectParams);
    expect(project.data.alert_emails).toEqual(["oncall@traceroot.ai"]);
  });
});
