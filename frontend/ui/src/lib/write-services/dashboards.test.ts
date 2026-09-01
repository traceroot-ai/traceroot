import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  DASHBOARD_DESCRIPTION_MAX,
  DASHBOARD_NAME_MAX,
  WIDGET_TITLE_MAX,
  WIDGET_TYPES,
} from "@/features/dashboards/types";

// The transaction client and the root client carry separate auditLog mocks so
// the tests can tell which one the audit row was written through.
const { tx, root } = vi.hoisted(() => ({
  tx: {
    project: { findUnique: vi.fn() },
    workspaceMember: { findUnique: vi.fn() },
    dashboard: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    widget: { create: vi.fn() },
    // The locking read of the layout column; see lib/dashboard-layout.
    $queryRaw: vi.fn(),
    auditLog: { create: vi.fn() },
  },
  root: { auditLog: { create: vi.fn() } },
}));
vi.mock("@traceroot/core", () => {
  const ROLE_ORDER = ["VIEWER", "MEMBER", "ADMIN"];
  return {
    prisma: {
      $transaction: (fn: (t: unknown) => unknown) => fn(tx),
      auditLog: root.auditLog,
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
  tx.dashboard.update.mockReset();
  tx.widget.create.mockReset();
  tx.$queryRaw.mockReset();
  tx.$queryRaw.mockResolvedValue([{ layout: [] }]);
  tx.auditLog.create.mockReset();
  tx.auditLog.create.mockResolvedValue({});
  root.auditLog.create.mockReset();
  root.auditLog.create.mockResolvedValue({});
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
    expect(root.auditLog.create).not.toHaveBeenCalled();
  });

  it("audits through the root client, not the transaction, so a failed audit cannot roll the dashboard back", async () => {
    mockAccess();
    tx.dashboard.findFirst.mockResolvedValue(null);
    tx.dashboard.create.mockResolvedValue(dashboardRow);
    root.auditLog.create.mockRejectedValue(new Error("audit store down"));
    const r = await runDashboard();
    expect(r).toEqual({ ok: true, created: true, data: dashboardRow });
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(root.auditLog.create).toHaveBeenCalled();
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
    expect(root.auditLog.create).toHaveBeenCalledWith({
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
    expect(root.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ transport: "agent", agentSessionId: "as1" }),
    });
  });
});

describe("createWidget", () => {
  function mockDashboard(layout: unknown = []) {
    tx.dashboard.findFirst.mockResolvedValue({ id: "dash1" });
    tx.$queryRaw.mockResolvedValue([{ layout }]);
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

  it("rejects an unknown type with 400, naming every supported type", async () => {
    mockAccess();
    mockDashboard();
    const r = await runWidget({ type: "chart" });
    expect(r).toEqual({
      ok: false,
      status: 400,
      error: 'type must be "query" or "trace_feed"',
    });
    // The wording is the API's error contract, but the types in it come from
    // the shared list — a new kind can't leave this message stale.
    expect((r as { error: string }).error).toBe(
      `type must be ${WIDGET_TYPES.map((t) => `"${t}"`).join(" or ")}`,
    );
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
    expect(root.auditLog.create).not.toHaveBeenCalled();
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

  it("accepts a seed-shaped trace_feed spec and stores the parsed shape", async () => {
    mockAccess();
    mockDashboard();
    tx.widget.create.mockResolvedValue(widgetRow);
    const feedSpec = { filters: [{ field: "errors", op: "gt", value: 0 }] };
    const r = await runWidget({ type: "trace_feed", spec: feedSpec });
    expect(r).toEqual({ ok: true, created: true, data: widgetRow });
    expect(tx.widget.create).toHaveBeenCalledWith(
      expect.objectContaining({
        // Parsed shape: the renderer's default limit is filled in.
        data: expect.objectContaining({ spec: { ...feedSpec, limit: 10 } }),
      }),
    );
  });

  it("rejects a query-dialect spec under type trace_feed with 400, no create, no audit", async () => {
    mockAccess();
    mockDashboard();
    const r = await runWidget({ type: "trace_feed", spec: validSpec });
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect((r as { error: string }).error).toMatch(/^spec is not a valid trace_feed spec: /);
    expect(tx.widget.create).not.toHaveBeenCalled();
    expect(root.auditLog.create).not.toHaveBeenCalled();
  });

  it("rejects a trace_feed spec with an invalid predicate with 400", async () => {
    mockAccess();
    mockDashboard();
    const r = await runWidget({
      type: "trace_feed",
      spec: { filters: [{ field: "errors", op: "gt", value: "high" }], limit: 10 },
    });
    expect(r).toEqual({
      ok: false,
      status: 400,
      error:
        "spec is not a valid trace_feed spec: filters[0] is not a valid trace filter predicate",
    });
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

  it("audits through the root client, not the transaction, so a failed audit cannot roll the widget back", async () => {
    mockAccess();
    mockDashboard();
    tx.widget.create.mockResolvedValue(widgetRow);
    root.auditLog.create.mockRejectedValue(new Error("audit store down"));
    const r = await runWidget();
    expect(r).toEqual({ ok: true, created: true, data: widgetRow });
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(root.auditLog.create).toHaveBeenCalled();
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
    expect(root.auditLog.create).toHaveBeenCalledWith({
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
      spec: { filters: [], limit: 5 },
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
    expect(root.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ transport: "agent", agentSessionId: "as1" }),
    });
  });

  // Real-world agent-created specs that passed shape validation but could only
  // 422 at query time; the registry vocabulary now rejects them at create.
  it.each([
    {
      spec: {
        view: "spans",
        metric: { measure: "spans", agg: "count" },
        display: { type: "number" },
      },
      error: /^unknown measure "spans" for view "spans" — valid measures: .*count.*duration_ms/,
    },
    {
      spec: {
        view: "traces",
        metric: { measure: "traces", agg: "count" },
        display: { type: "number" },
      },
      error: /^unknown measure "traces" for view "traces" — valid measures: .*error_count/,
    },
    {
      spec: {
        view: "spans",
        metric: { measure: "count", agg: "count" },
        breakdown: "model",
        display: { type: "bar" },
      },
      error:
        /^unknown breakdown "model" for view "spans" — valid breakdowns: environment, model_name, name, span_kind$/,
    },
    {
      spec: {
        view: "traces",
        metric: { measure: "count", agg: "count" },
        filters: [{ field: "errors", op: ">", value: 0 }],
        display: { type: "number" },
      },
      error:
        /^unknown filter field "errors" for view "traces" — valid filter fields: .*error_count/,
    },
    {
      spec: {
        view: "spans",
        metric: { measure: "count", agg: "count" },
        breakdown: "model_name",
        display: { type: "number" },
      },
      error:
        /^display "number" does not support a breakdown dimension — displays that support a breakdown: line, area, bar, pie, table$/,
    },
    {
      spec: {
        view: "spans",
        metric: { measure: "duration_ms", agg: "p95" },
        breakdown: "model_name",
        display: { type: "histogram" },
      },
      error:
        /^display "histogram" does not support a breakdown dimension — displays that support a breakdown: line, area, bar, pie, table$/,
    },
  ])(
    "rejects an out-of-vocabulary query spec with 400 and the valid options ($error)",
    async ({ spec, error }) => {
      mockAccess();
      mockDashboard();
      const r = await runWidget({ spec });
      expect(r).toMatchObject({ ok: false, status: 400 });
      expect((r as { error: string }).error).toMatch(error);
      expect(tx.widget.create).not.toHaveBeenCalled();
      expect(root.auditLog.create).not.toHaveBeenCalled();
    },
  );

  it("places the new widget in the dashboard layout in the same transaction", async () => {
    mockAccess();
    mockDashboard();
    tx.widget.create.mockResolvedValue(widgetRow);
    const r = await runWidget();
    expect(r).toEqual({ ok: true, created: true, data: widgetRow });
    expect(tx.dashboard.update).toHaveBeenCalledWith({
      where: { id: "dash1" },
      data: { layout: [{ i: "wid1", x: 0, y: 0, w: 6, h: 4 }] },
    });
  });

  it("packs the new widget beside the tile already on the bottom row", async () => {
    mockAccess();
    mockDashboard([{ i: "other", x: 0, y: 4, w: 6, h: 4 }]);
    tx.widget.create.mockResolvedValue(widgetRow);
    await runWidget({ type: "trace_feed", spec: { filters: [], limit: 5 } });
    expect(tx.dashboard.update).toHaveBeenCalledWith({
      where: { id: "dash1" },
      data: {
        layout: [
          { i: "other", x: 0, y: 4, w: 6, h: 4 },
          { i: "wid1", x: 6, y: 4, w: 6, h: 6 },
        ],
      },
    });
  });

  it("locks the dashboard row before the widget insert and the layout read", async () => {
    mockAccess();
    mockDashboard();
    tx.widget.create.mockResolvedValue(widgetRow);
    await runWidget();
    const [strings, ...values] = tx.$queryRaw.mock.calls[0] as [string[], ...unknown[]];
    const sql = strings.join("?");
    expect(sql).toMatch(/SELECT layout FROM dashboards WHERE id = \? FOR UPDATE/);
    // The id is a bound parameter, never interpolated into the statement.
    expect(sql).not.toContain("dash1");
    expect(values).toEqual(["dash1"]);
    // Taking the lock after the insert would deadlock: the insert's foreign
    // key already holds a weaker lock on the same row.
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.widget.create.mock.invocationCallOrder[0],
    );
    expect(tx.widget.create.mock.invocationCallOrder[0]).toBeLessThan(
      tx.dashboard.update.mock.invocationCallOrder[0],
    );
  });

  it("leaves the layout untouched when the widget is rejected", async () => {
    mockAccess();
    mockDashboard();
    const r = await runWidget({ spec: { ...validSpec, view: "nope" } });
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(tx.dashboard.update).not.toHaveBeenCalled();
    // Nothing is written, so the dashboard row is never locked either.
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it("creates a spans widget broken down by model_name (the vocabulary for 'by model')", async () => {
    mockAccess();
    mockDashboard();
    tx.widget.create.mockResolvedValue(widgetRow);
    const spec = {
      view: "spans",
      filters: [],
      metric: { measure: "count", agg: "count" },
      breakdown: "model_name",
      display: { type: "bar" },
    };
    const r = await runWidget({ spec });
    expect(r).toEqual({ ok: true, created: true, data: widgetRow });
    expect(tx.widget.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ spec }) }),
    );
  });
});
