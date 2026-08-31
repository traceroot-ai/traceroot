import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  DASHBOARD_DESCRIPTION_MAX,
  DASHBOARD_NAME_MAX,
  WIDGET_TITLE_MAX,
} from "@/features/dashboards/types";

const tx = {
  project: { findUnique: vi.fn() },
  workspaceMember: { findUnique: vi.fn() },
  dashboard: { findFirst: vi.fn(), create: vi.fn() },
  widget: { create: vi.fn() },
};
// Audit rows are written on the root client after the transaction commits, so
// the tx mock deliberately has no auditLog.
const auditLogCreate = vi.fn();
vi.mock("@traceroot/core", () => {
  const ROLE_ORDER = ["VIEWER", "MEMBER", "ADMIN"];
  return {
    prisma: {
      $transaction: (fn: (t: unknown) => unknown) => fn(tx),
      auditLog: { create: (args: unknown) => auditLogCreate(args) },
    },
    Role: { VIEWER: "VIEWER", MEMBER: "MEMBER", ADMIN: "ADMIN" },
    hasMinRole: (userRole: string, minRole: string) =>
      ROLE_ORDER.indexOf(userRole) >= ROLE_ORDER.indexOf(minRole),
  };
});
import { createDashboard, createWidget } from "./dashboards";

const nameMessage = `name must be a non-empty string (max ${DASHBOARD_NAME_MAX} chars)`;
const titleMessage = `title must be a non-empty string (max ${WIDGET_TITLE_MAX} chars)`;

const baseDashboardInput = {
  actorUserId: "u1",
  projectId: "p1",
  name: "Cost overview",
  provenance: { transport: "public-api" as const },
};

// Matches the canonical WidgetSpecSchema, already in parsed shape (defaults
// present) so stored-spec assertions can compare against it directly.
const validSpec = {
  view: "traces",
  filters: [],
  metric: { measure: "count", agg: "count" },
  breakdown: null,
  display: { type: "number" },
};

const baseWidgetInput = {
  actorUserId: "u1",
  projectId: "p1",
  dashboardId: "dash1",
  title: "Cost by model",
  type: "query" as const,
  spec: validSpec,
  provenance: { transport: "public-api" as const },
};

function runDashboard(overrides: Record<string, unknown> = {}) {
  return createDashboard({
    ...baseDashboardInput,
    ...overrides,
  } as Parameters<typeof createDashboard>[0]);
}

function runWidget(overrides: Record<string, unknown> = {}) {
  return createWidget({
    ...baseWidgetInput,
    ...overrides,
  } as Parameters<typeof createWidget>[0]);
}

function mockAccess(role = "MEMBER") {
  tx.project.findUnique.mockResolvedValue({ workspaceId: "w1", deleteTime: null });
  tx.workspaceMember.findUnique.mockResolvedValue({ role });
}

const dashboardRow = { id: "dash1", name: "Cost overview", projectId: "p1" };
const widgetRow = { id: "wid1", dashboardId: "dash1", title: "Cost by model", type: "query" };

beforeEach(() => {
  tx.project.findUnique.mockReset();
  tx.workspaceMember.findUnique.mockReset();
  tx.dashboard.findFirst.mockReset();
  tx.dashboard.create.mockReset();
  tx.widget.create.mockReset();
  auditLogCreate.mockReset();
  auditLogCreate.mockResolvedValue({});
});

describe("createDashboard", () => {
  it("returns 404 when the project does not exist", async () => {
    tx.project.findUnique.mockResolvedValue(null);
    const r = await runDashboard();
    expect(r).toEqual({ ok: false, status: 404, error: "Project not found" });
    expect(tx.dashboard.create).not.toHaveBeenCalled();
  });

  it("returns 404 when the project is soft-deleted", async () => {
    tx.project.findUnique.mockResolvedValue({
      workspaceId: "w1",
      deleteTime: new Date(),
    });
    const r = await runDashboard();
    expect(r).toEqual({ ok: false, status: 404, error: "Project not found" });
    expect(tx.workspaceMember.findUnique).not.toHaveBeenCalled();
  });

  it("rejects a non-member with 403", async () => {
    tx.project.findUnique.mockResolvedValue({ workspaceId: "w1", deleteTime: null });
    tx.workspaceMember.findUnique.mockResolvedValue(null);
    const r = await runDashboard();
    expect(r).toEqual({
      ok: false,
      status: 403,
      error: "Not a member of this workspace",
    });
    expect(tx.dashboard.create).not.toHaveBeenCalled();
  });

  it("rejects a VIEWER with 403", async () => {
    mockAccess("VIEWER");
    const r = await runDashboard();
    expect(r).toEqual({
      ok: false,
      status: 403,
      error: "Requires MEMBER role or higher",
    });
    expect(tx.dashboard.create).not.toHaveBeenCalled();
  });

  it("rejects a whitespace-only name with 400", async () => {
    mockAccess();
    const r = await runDashboard({ name: "   " });
    expect(r).toEqual({ ok: false, status: 400, error: nameMessage });
  });

  it("rejects a name over the length cap with 400", async () => {
    mockAccess();
    const r = await runDashboard({ name: "x".repeat(DASHBOARD_NAME_MAX + 1) });
    expect(r).toEqual({ ok: false, status: 400, error: nameMessage });
  });

  it("rejects a non-string description with 400", async () => {
    mockAccess();
    const r = await runDashboard({ description: 42 });
    expect(r).toEqual({
      ok: false,
      status: 400,
      error: "description must be a string",
    });
  });

  it("rejects a description over the length cap with 400", async () => {
    mockAccess();
    const r = await runDashboard({
      description: "x".repeat(DASHBOARD_DESCRIPTION_MAX + 1),
    });
    expect(r).toEqual({
      ok: false,
      status: 400,
      error: `description must be at most ${DASHBOARD_DESCRIPTION_MAX} chars`,
    });
  });

  it("returns the existing dashboard by name, created=false, no create, no audit", async () => {
    mockAccess();
    tx.dashboard.findFirst.mockResolvedValue(dashboardRow);
    const r = await runDashboard({ name: "  Cost overview  " });
    expect(r).toEqual({ ok: true, created: false, data: dashboardRow });
    expect(tx.dashboard.findFirst).toHaveBeenCalledWith({
      where: { projectId: "p1", name: "Cost overview" },
      select: { id: true, name: true, projectId: true },
    });
    expect(tx.dashboard.create).not.toHaveBeenCalled();
    expect(auditLogCreate).not.toHaveBeenCalled();
  });

  it("creates the dashboard with a null description and writes the audit row", async () => {
    mockAccess();
    tx.dashboard.findFirst.mockResolvedValue(null);
    tx.dashboard.create.mockResolvedValue(dashboardRow);
    const r = await runDashboard();
    expect(r).toEqual({ ok: true, created: true, data: dashboardRow });
    const createArg = tx.dashboard.create.mock.calls[0][0];
    expect(createArg.data).not.toHaveProperty("id");
    expect(createArg).toEqual({
      data: {
        projectId: "p1",
        name: "Cost overview",
        description: null,
        createdBy: "u1",
      },
      select: { id: true, name: true, projectId: true },
    });
    expect(auditLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorUserId: "u1",
        operation: "create_dashboard",
        resourceType: "dashboard",
        resourceId: "dash1",
        workspaceId: "w1",
        projectId: "p1",
        summary: { name: "Cost overview" },
        transport: "public-api",
        agentSessionId: null,
      }),
    });
  });

  it("stores the description and forwards agent provenance", async () => {
    mockAccess();
    tx.dashboard.findFirst.mockResolvedValue(null);
    tx.dashboard.create.mockResolvedValue(dashboardRow);
    const r = await runDashboard({
      description: "Spend at a glance",
      provenance: { transport: "agent", agentSessionId: "as1" },
    });
    expect(r).toEqual({ ok: true, created: true, data: dashboardRow });
    expect(tx.dashboard.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ description: "Spend at a glance" }),
      }),
    );
    expect(auditLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ transport: "agent", agentSessionId: "as1" }),
    });
  });
});

describe("createWidget", () => {
  function mockDashboard() {
    tx.dashboard.findFirst.mockResolvedValue({ id: "dash1" });
  }

  it("returns 404 when the project does not exist", async () => {
    tx.project.findUnique.mockResolvedValue(null);
    const r = await runWidget();
    expect(r).toEqual({ ok: false, status: 404, error: "Project not found" });
    expect(tx.widget.create).not.toHaveBeenCalled();
  });

  it("rejects a non-member with 403", async () => {
    tx.project.findUnique.mockResolvedValue({ workspaceId: "w1", deleteTime: null });
    tx.workspaceMember.findUnique.mockResolvedValue(null);
    const r = await runWidget();
    expect(r).toEqual({
      ok: false,
      status: 403,
      error: "Not a member of this workspace",
    });
  });

  it("rejects a VIEWER with 403", async () => {
    mockAccess("VIEWER");
    const r = await runWidget();
    expect(r).toEqual({
      ok: false,
      status: 403,
      error: "Requires MEMBER role or higher",
    });
  });

  it("returns 404 when the dashboard is not in the project", async () => {
    mockAccess();
    tx.dashboard.findFirst.mockResolvedValue(null);
    const r = await runWidget();
    expect(r).toEqual({ ok: false, status: 404, error: "Dashboard not found" });
    expect(tx.dashboard.findFirst).toHaveBeenCalledWith({
      where: { id: "dash1", projectId: "p1" },
      select: { id: true },
    });
    expect(tx.widget.create).not.toHaveBeenCalled();
  });

  it("rejects a whitespace-only title with 400", async () => {
    mockAccess();
    mockDashboard();
    const r = await runWidget({ title: "   " });
    expect(r).toEqual({ ok: false, status: 400, error: titleMessage });
  });

  it("rejects a title over the length cap with 400", async () => {
    mockAccess();
    mockDashboard();
    const r = await runWidget({ title: "x".repeat(WIDGET_TITLE_MAX + 1) });
    expect(r).toEqual({ ok: false, status: 400, error: titleMessage });
  });

  it("rejects an unknown type with 400", async () => {
    mockAccess();
    mockDashboard();
    const r = await runWidget({ type: "chart" });
    expect(r).toEqual({
      ok: false,
      status: 400,
      error: 'type must be "query" or "trace_feed"',
    });
  });

  it.each([null, ["a"], "text"])("rejects spec=%j with 400", async (spec) => {
    mockAccess();
    mockDashboard();
    const r = await runWidget({ spec });
    expect(r).toEqual({ ok: false, status: 400, error: "spec must be a JSON object" });
  });

  it("rejects a query spec with a hallucinated vocabulary with 400, no create, no audit", async () => {
    mockAccess();
    mockDashboard();
    const r = await runWidget({
      spec: {
        metric: "input_tokens",
        source: "observations",
        group_by: "model",
        aggregation: "sum",
      },
    });
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect((r as { error: string }).error).toMatch(/^spec is not a valid widget spec: /);
    expect(tx.widget.create).not.toHaveBeenCalled();
    expect(auditLogCreate).not.toHaveBeenCalled();
  });

  it("strips unknown keys from a query spec and stores the parsed shape", async () => {
    mockAccess();
    mockDashboard();
    tx.widget.create.mockResolvedValue(widgetRow);
    const r = await runWidget({ spec: { ...validSpec, extraneous: "x" } });
    expect(r).toEqual({ ok: true, created: true, data: widgetRow });
    expect(tx.widget.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ spec: validSpec }) }),
    );
  });

  it("does not apply the query spec schema to trace_feed specs", async () => {
    mockAccess();
    mockDashboard();
    tx.widget.create.mockResolvedValue(widgetRow);
    const feedSpec = { filters: [{ field: "errors", op: "gt", value: 0 }], limit: 10 };
    const r = await runWidget({ type: "trace_feed", spec: feedSpec });
    expect(r).toEqual({ ok: true, created: true, data: widgetRow });
    expect(tx.widget.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ spec: feedSpec }) }),
    );
  });

  it("rejects an array displayConfig with 400", async () => {
    mockAccess();
    mockDashboard();
    const r = await runWidget({ displayConfig: [] });
    expect(r).toEqual({
      ok: false,
      status: 400,
      error: "displayConfig must be a JSON object",
    });
  });

  it("creates the widget with a defaulted displayConfig and writes the audit row", async () => {
    mockAccess();
    mockDashboard();
    tx.widget.create.mockResolvedValue(widgetRow);
    const r = await runWidget({ title: "  Cost by model  " });
    expect(r).toEqual({ ok: true, created: true, data: widgetRow });
    const createArg = tx.widget.create.mock.calls[0][0];
    expect(createArg.data).not.toHaveProperty("id");
    expect(createArg).toEqual({
      data: {
        dashboardId: "dash1",
        title: "Cost by model",
        type: "query",
        spec: validSpec,
        displayConfig: {},
      },
      select: { id: true, dashboardId: true, title: true, type: true },
    });
    expect(auditLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorUserId: "u1",
        operation: "create_widget",
        resourceType: "widget",
        resourceId: "wid1",
        workspaceId: "w1",
        projectId: "p1",
        summary: { title: "Cost by model", type: "query", dashboardId: "dash1" },
        transport: "public-api",
        agentSessionId: null,
      }),
    });
  });

  it("always creates even when a same-title widget exists and forwards agent provenance", async () => {
    mockAccess();
    mockDashboard();
    tx.widget.create.mockResolvedValue(widgetRow);
    const r = await runWidget({
      type: "trace_feed",
      displayConfig: { compact: true },
      provenance: { transport: "agent", agentSessionId: "as1" },
    });
    expect(r).toEqual({ ok: true, created: true, data: widgetRow });
    expect(tx.widget.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "trace_feed",
          displayConfig: { compact: true },
        }),
      }),
    );
    expect(auditLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ transport: "agent", agentSessionId: "as1" }),
    });
  });
});
