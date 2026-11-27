import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/support/route-guard", () => ({
  withImpersonationPolicy: (handler: unknown) => handler,
}));
vi.mock("@/lib/posthog-server", () => ({ captureServerEvent: vi.fn() }));
vi.mock("@/env", () => ({ env: { INTERNAL_API_SECRET: "test-internal-secret" } }));

const state = vi.hoisted(() => ({
  role: "VIEWER",
  workspaceId: "workspace",
  authenticated: true,
  member: true,
}));
const db = vi.hoisted(() => ({
  workspace: vi.fn(),
  billingWorkspace: vi.fn(),
  project: vi.fn(),
  projectAccess: vi.fn(),
  membership: vi.fn(),
  keys: vi.fn(),
  stripe: vi.fn(),
}));

vi.mock("@/lib/request-session", () => ({
  getRequestSession: async () => (state.authenticated ? { user: { id: "reader" } } : null),
}));
vi.mock("@traceroot/core", async (original) => ({
  ...(await original<typeof import("@traceroot/core")>()),
  getStripeOrThrow: db.stripe,
  prisma: {
    workspace: { findUnique: db.workspace, findFirst: db.billingWorkspace },
    workspaceMember: { findUnique: db.membership },
    project: { findFirst: db.project, findUnique: db.projectAccess },
    accessKey: { findMany: db.keys },
  },
}));

import { GET as workspaceGET } from "./workspaces/[workspaceId]/route";
import { GET as nestedProjectGET } from "./workspaces/[workspaceId]/projects/[projectId]/route";
import { GET as projectGET } from "./projects/[projectId]/route";
import { GET as keysGET } from "./projects/[projectId]/api-keys/route";
import { GET as subscriptionGET } from "./billing/subscription-info/route";

const key = {
  id: "key-id",
  keyHint: "tr-test-abcd",
  name: "Production integration",
  expireTime: null,
  lastUseTime: "2026-11-26T12:00:00.000Z",
  createTime: "2026-11-01T12:00:00.000Z",
  secretHash: "must-not-be-returned",
};
const billing = {
  billingPlan: "pro",
  billingCustomerId: "cus_test",
  billingSubscriptionId: "sub_test",
  billingStatus: "active",
  currentUsage: { traces: 42, ai: { byModel: [{ model: "test-model", cost: 12 }] } },
};
const project = {
  id: "project",
  workspaceId: "workspace",
  name: "Checkout",
  traceTtlDays: null,
  rcaModel: null,
  rcaProvider: null,
  rcaSource: null,
  alertConfig: { emailAddresses: ["private@example.test"], alertWindow: "10m" },
  accessKeys: [key],
  _count: { accessKeys: 1 },
  createTime: "2026-11-01T00:00:00.000Z",
  updateTime: "2026-11-26T00:00:00.000Z",
  internalColumn: "must-not-be-returned",
};
const request = () => new NextRequest("https://example.test/api?workspaceId=" + state.workspaceId);
const workspaceParams = () => ({ params: Promise.resolve({ workspaceId: state.workspaceId }) });
const projectParams = () => ({ params: Promise.resolve({ projectId: "project" }) });
const nestedParams = () => ({
  params: Promise.resolve({ workspaceId: state.workspaceId, projectId: "project" }),
});
const reads = [
  ["workspace", () => workspaceGET(request(), workspaceParams())],
  ["nested project", () => nestedProjectGET(request(), nestedParams())],
  ["project", () => projectGET(request(), projectParams())],
  ["API keys", () => keysGET(request(), projectParams())],
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DEMO_WORKSPACE_ID", "demo");
  Object.assign(state, {
    role: "VIEWER",
    workspaceId: "workspace",
    authenticated: true,
    member: true,
  });
  db.membership.mockImplementation(async () =>
    state.member ? { workspaceId: state.workspaceId, userId: "reader", role: state.role } : null,
  );
  db.project.mockImplementation(async () => ({ ...project, workspaceId: state.workspaceId }));
  db.projectAccess.mockImplementation(async () => ({ ...project, workspaceId: state.workspaceId }));
  db.workspace.mockImplementation(async () => ({
    id: state.workspaceId,
    name: "Workspace",
    createTime: project.createTime,
    projects: [{ ...project, lastIngestedAt: null }],
    _count: { members: 2 },
    internalColumn: "must-not-be-returned",
    ...billing,
  }));
  db.billingWorkspace.mockImplementation(async () =>
    state.member
      ? { id: state.workspaceId, billingSubscriptionId: null, members: [{ role: state.role }] }
      : null,
  );
  db.keys.mockResolvedValue([key]);
  db.stripe.mockReturnValue({
    subscriptions: {
      retrieve: vi.fn().mockResolvedValue({ current_period_start: 0, current_period_end: 60 }),
    },
  });
});
afterEach(() => vi.unstubAllEnvs());

describe.each(["workspace", "demo"])("workspace reads in %s", (workspaceId) => {
  it.each(["VIEWER", "MEMBER", "ADMIN", "UNKNOWN"])(
    "projects billing fields for %s",
    async (role) => {
      state.workspaceId = workspaceId;
      state.role = role;
      const response = await workspaceGET(request(), workspaceParams());
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        id: workspaceId,
        name: "Workspace",
        role,
        projects: [{ id: "project" }],
      });
      expect(body).not.toHaveProperty("internalColumn");
      if (role === "ADMIN") {
        expect(body).toMatchObject(billing);
      } else {
        for (const field of Object.keys(billing)) expect(body).not.toHaveProperty(field);
        expect(body).toHaveProperty("retention_days");
      }
    },
  );
});

describe.each(["VIEWER", "MEMBER", "ADMIN", "UNKNOWN"])("project reads for %s", (role) => {
  it.each(["nested", "direct"])("uses the same safe fields on the %s route", async (route) => {
    state.role = role;
    const response =
      route === "nested"
        ? await nestedProjectGET(request(), nestedParams())
        : await projectGET(request(), projectParams());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: "project",
      name: "Checkout",
      trace_ttl_days: null,
      rca_model: null,
      rca_provider: null,
      rca_source: null,
      alert_window: "10m",
      create_time: project.createTime,
      update_time: project.updateTime,
      ...(role === "ADMIN" ? { alert_emails: ["private@example.test"] } : {}),
      ...(route === "direct"
        ? { workspace_id: "workspace", access_key_count: 1, read_at: expect.any(String) }
        : {}),
    });
  });
});

describe("credential inventory", () => {
  it.each(["VIEWER", "MEMBER", "UNKNOWN"])("refuses %s before querying keys", async (role) => {
    state.role = role;
    const response = await keysGET(request(), projectParams());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Requires ADMIN role or higher" });
    expect(db.keys).not.toHaveBeenCalled();
  });

  it("keeps the administrator list masked", async () => {
    state.role = "ADMIN";
    const response = await keysGET(request(), projectParams());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      access_keys: [
        {
          id: "key-id",
          key_hint: "tr-test-abcd",
          name: "Production integration",
          expire_time: null,
          last_use_time: key.lastUseTime,
          create_time: key.createTime,
        },
      ],
    });
  });
});

describe("subscription reads", () => {
  it.each(["VIEWER", "MEMBER", "UNKNOWN"])(
    "refuses %s before contacting the billing provider",
    async (role) => {
      state.role = role;
      db.billingWorkspace.mockResolvedValue({
        billingSubscriptionId: "sub_test",
        members: [{ role }],
      });
      const response = await subscriptionGET(request());
      expect(response.status).toBe(403);
      expect(db.stripe).not.toHaveBeenCalled();
    },
  );

  it("preserves the administrator's no-subscription response", async () => {
    state.role = "ADMIN";
    const response = await subscriptionGET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      cancellation: null,
      scheduledChange: null,
      billingPeriod: null,
    });
  });
});

describe("read authorization", () => {
  it.each(reads)("refuses unauthenticated %s requests", async (_name, read) => {
    state.authenticated = false;
    const response = await read();
    expect(response.status).toBe(401);
  });

  it.each(reads)("refuses non-member %s requests", async (_name, read) => {
    state.member = false;
    const response = await read();
    expect(response.status).toBe(403);
  });

  it("keeps nested project lookup scoped to the workspace", async () => {
    db.project.mockResolvedValue(null);
    const response = await nestedProjectGET(request(), nestedParams());
    expect(response.status).toBe(404);
    expect(db.project).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "project", workspaceId: "workspace", deleteTime: null },
      }),
    );
  });

  it("re-projects the same resource after an administrator is downgraded", async () => {
    state.role = "ADMIN";
    expect(await (await workspaceGET(request(), workspaceParams())).json()).toHaveProperty(
      "currentUsage",
    );
    state.role = "VIEWER";
    expect(await (await workspaceGET(request(), workspaceParams())).json()).not.toHaveProperty(
      "currentUsage",
    );
  });
});
