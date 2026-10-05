import { describe, it, expect, vi, beforeEach } from "vitest";
import { DASHBOARD_NAME_MAX, WIDGET_TITLE_MAX } from "@/features/dashboards/types";
import { DELETE_REASON_MESSAGE, NO_FIELDS_MESSAGE } from "./update-support";

// The transaction client and the root client carry separate auditLog mocks so
// the tests can tell which one the audit row was written through.
const { tx, root, order } = vi.hoisted(() => ({
  tx: {
    project: { findUnique: vi.fn() },
    workspaceMember: { findUnique: vi.fn() },
    dashboard: { findFirst: vi.fn(), count: vi.fn(), update: vi.fn(), delete: vi.fn() },
    widget: { findFirst: vi.fn(), count: vi.fn(), update: vi.fn(), delete: vi.fn() },
    auditLog: { create: vi.fn() },
    // The locking read of the layout column; see lib/dashboard-layout.
    $queryRaw: vi.fn(),
  },
  root: { auditLog: { create: vi.fn() } },
  // Every mocked query appends here; "commit" marks the transaction resolving.
  order: [] as string[],
}));
vi.mock("@traceroot/core", () => {
  const ROLE_ORDER = ["VIEWER", "MEMBER", "ADMIN"];
  return {
    prisma: {
      $transaction: async (fn: (t: unknown) => unknown) => {
        const outcome = await fn(tx);
        order.push("commit");
        return outcome;
      },
      auditLog: root.auditLog,
    },
    Role: { VIEWER: "VIEWER", MEMBER: "MEMBER", ADMIN: "ADMIN" },
    hasMinRole: (userRole: string, minRole: string) =>
      ROLE_ORDER.indexOf(userRole) >= ROLE_ORDER.indexOf(minRole),
  };
});
import { deleteDashboard, deleteWidget, updateDashboard, updateWidget } from "./dashboards";

const nameMessage = `name must be a non-empty string (max ${DASHBOARD_NAME_MAX} chars)`;
const titleMessage = `title must be a non-empty string (max ${WIDGET_TITLE_MAX} chars)`;

// Matches the canonical WidgetSpecSchema, already in parsed shape.
const validSpec = {
  view: "traces",
  filters: [],
  metric: { measure: "count", agg: "count" },
  breakdown: null,
  display: { type: "number" },
};

const storedWidget = {
  id: "wid1",
  dashboardId: "dash1",
  title: "Cost by model",
  type: "query",
  // Stored key order differs from the parsed one: jsonb reorders keys.
  spec: {
    display: { type: "number" },
    metric: { agg: "count", measure: "count" },
    breakdown: null,
    filters: [],
    view: "traces",
  },
  displayConfig: { color: "blue" },
};

const storedDashboard = {
  id: "dash1",
  projectId: "p1",
  name: "Cost overview",
  description: null,
  layout: [{ i: "wid1", x: 0, y: 0, w: 6, h: 4 }],
  isDefault: false,
};

const provenance = { transport: "public-api" as const };

function mockAccess(role = "MEMBER") {
  tx.project.findUnique.mockResolvedValue({ workspaceId: "w1", deleteTime: null });
  tx.workspaceMember.findUnique.mockResolvedValue({ role });
}

function runWidgetUpdate(patch: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return updateWidget({
    actorUserId: "u1",
    projectId: "p1",
    widgetId: "wid1",
    patch,
    provenance,
    ...overrides,
  } as Parameters<typeof updateWidget>[0]);
}

function runWidgetDelete(overrides: Record<string, unknown> = {}) {
  return deleteWidget({
    actorUserId: "u1",
    projectId: "p1",
    widgetId: "wid1",
    reason: "superseded by the cost chart",
    provenance,
    ...overrides,
  } as Parameters<typeof deleteWidget>[0]);
}

function runDashboardUpdate(patch: Record<string, unknown>) {
  return updateDashboard({
    actorUserId: "u1",
    projectId: "p1",
    dashboardId: "dash1",
    patch,
    provenance,
  });
}

function runDashboardDelete(overrides: Record<string, unknown> = {}) {
  return deleteDashboard({
    actorUserId: "u1",
    projectId: "p1",
    dashboardId: "dash1",
    reason: "cleaning up the test dashboards",
    provenance,
    ...overrides,
  } as Parameters<typeof deleteDashboard>[0]);
}

/** A duck-typed Prisma error, as the handlers match them. */
const prismaError = (code: string, target?: unknown) =>
  Object.assign(new Error(`prisma ${code}`), { code, meta: { target } });

beforeEach(() => {
  order.length = 0;
  for (const model of [tx.project, tx.workspaceMember, tx.dashboard, tx.widget, tx.auditLog]) {
    for (const fn of Object.values(model)) fn.mockReset();
  }
  tx.$queryRaw.mockReset();
  tx.$queryRaw.mockImplementation(async () => {
    order.push("lock");
    return [{ layout: storedDashboard.layout }];
  });
  tx.widget.findFirst.mockResolvedValue(storedWidget);
  tx.widget.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    order.push("update");
    return { ...storedWidget, ...data };
  });
  tx.widget.delete.mockImplementation(async () => {
    order.push("delete");
    return storedWidget;
  });
  tx.widget.count.mockResolvedValue(3);
  tx.dashboard.findFirst.mockResolvedValue(storedDashboard);
  tx.dashboard.count.mockResolvedValue(2);
  tx.dashboard.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    order.push("layout");
    return { ...storedDashboard, ...data };
  });
  tx.dashboard.delete.mockImplementation(async () => {
    order.push("delete");
    return storedDashboard;
  });
  root.auditLog.create.mockReset();
  root.auditLog.create.mockImplementation(async () => {
    order.push("audit");
    return {};
  });
});

describe("updateWidget", () => {
  it("returns 404 when the project does not exist", async () => {
    tx.project.findUnique.mockResolvedValue(null);
    expect(await runWidgetUpdate({ title: "New" })).toEqual({
      ok: false,
      status: 404,
      error: "Project not found",
    });
    expect(tx.widget.update).not.toHaveBeenCalled();
  });

  it("returns the same 404 as a missing project for a non-member", async () => {
    tx.project.findUnique.mockResolvedValue({ workspaceId: "w1", deleteTime: null });
    tx.workspaceMember.findUnique.mockResolvedValue(null);
    expect(await runWidgetUpdate({ title: "New" })).toEqual({
      ok: false,
      status: 404,
      error: "Project not found",
    });
  });

  it("rejects a VIEWER with 403 before reading the widget", async () => {
    mockAccess("VIEWER");
    expect(await runWidgetUpdate({ title: "New" })).toEqual({
      ok: false,
      status: 403,
      error: "Requires MEMBER role or higher",
    });
    expect(tx.widget.findFirst).not.toHaveBeenCalled();
  });

  it("rejects an empty patch with 400 before reading the widget", async () => {
    mockAccess();
    expect(await runWidgetUpdate({})).toEqual({ ok: false, status: 400, error: NO_FIELDS_MESSAGE });
    expect(await runWidgetUpdate({ title: undefined })).toEqual({
      ok: false,
      status: 400,
      error: NO_FIELDS_MESSAGE,
    });
    expect(tx.widget.findFirst).not.toHaveBeenCalled();
  });

  it("returns 404 for a widget outside the project, resolved through the dashboard", async () => {
    mockAccess();
    tx.widget.findFirst.mockResolvedValue(null);
    expect(await runWidgetUpdate({ title: "New" })).toEqual({
      ok: false,
      status: 404,
      error: "Widget not found",
    });
    expect(tx.widget.findFirst).toHaveBeenCalledWith({
      where: { id: "wid1", dashboard: { projectId: "p1" } },
    });
  });

  it("also scopes to the dashboard when the caller names one, as the nested cookie route does", async () => {
    mockAccess();
    tx.widget.findFirst.mockResolvedValue(null);
    await runWidgetUpdate({ title: "New" }, { dashboardId: "dash1" });
    expect(tx.widget.findFirst).toHaveBeenCalledWith({
      where: { id: "wid1", dashboardId: "dash1", dashboard: { projectId: "p1" } },
    });
  });

  it.each(["", "   ", 42, "x".repeat(WIDGET_TITLE_MAX + 1)])(
    "rejects title=%j with 400",
    async (title) => {
      mockAccess();
      expect(await runWidgetUpdate({ title })).toEqual({
        ok: false,
        status: 400,
        error: titleMessage,
      });
      expect(tx.widget.update).not.toHaveBeenCalled();
    },
  );

  it("rejects a null title: the field is not nullable", async () => {
    mockAccess();
    expect(await runWidgetUpdate({ title: null })).toEqual({
      ok: false,
      status: 400,
      error: titleMessage,
    });
  });

  it.each([null, ["a"], "text"])("rejects spec=%j with 400", async (spec) => {
    mockAccess();
    expect(await runWidgetUpdate({ spec })).toEqual({
      ok: false,
      status: 400,
      error: "spec must be a JSON object",
    });
  });

  it("validates the spec against the stored type: a foreign dialect on a query widget is a 400 naming the widget-spec dialect", async () => {
    mockAccess();
    const r = await runWidgetUpdate({
      spec: { filters: [{ field: "errors", op: "gt", value: 0 }] },
    });
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect((r as { error: string }).error).toMatch(/^spec is not a valid widget spec: /);
    expect(tx.widget.update).not.toHaveBeenCalled();
    expect(root.auditLog.create).not.toHaveBeenCalled();
  });

  it("validates the spec against the stored type: a query spec on a trace_feed widget is a 400 naming the trace_feed dialect", async () => {
    mockAccess();
    tx.widget.findFirst.mockResolvedValue({
      ...storedWidget,
      type: "trace_feed",
      spec: { filters: [], limit: 10 },
    });
    const r = await runWidgetUpdate({ spec: validSpec });
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect((r as { error: string }).error).toMatch(/^spec is not a valid trace_feed spec: /);
  });

  it("rejects a query spec whose field is outside the registry vocabulary", async () => {
    mockAccess();
    const r = await runWidgetUpdate({
      spec: { ...validSpec, filters: [{ field: "no_such_field", op: "=", value: "x" }] },
    });
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(tx.widget.update).not.toHaveBeenCalled();
  });

  it("stores the parsed spec shape and reports it changed", async () => {
    mockAccess();
    const spec = { ...validSpec, view: "spans", extraneous: "x" };
    const r = await runWidgetUpdate({ spec });
    expect(r).toMatchObject({ ok: true, changed: ["spec"] });
    expect(tx.widget.update).toHaveBeenCalledWith({
      where: { id: "wid1" },
      data: { spec: { ...validSpec, view: "spans" } },
    });
  });

  it("stores a parsed trace_feed spec on a trace_feed widget", async () => {
    mockAccess();
    tx.widget.findFirst.mockResolvedValue({
      ...storedWidget,
      type: "trace_feed",
      spec: { filters: [], limit: 10 },
    });
    const feedSpec = { filters: [{ field: "errors", op: "gt", value: 0 }] };
    expect(await runWidgetUpdate({ spec: feedSpec })).toMatchObject({
      ok: true,
      changed: ["spec"],
    });
    expect(tx.widget.update).toHaveBeenCalledWith({
      where: { id: "wid1" },
      data: { spec: { ...feedSpec, limit: 10 } },
    });
  });

  it("answers an unchanged spec as a no-op even though jsonb reordered the stored keys", async () => {
    mockAccess();
    expect(await runWidgetUpdate({ spec: validSpec })).toEqual({
      ok: true,
      data: storedWidget,
      changed: [],
    });
    expect(tx.widget.update).not.toHaveBeenCalled();
    expect(root.auditLog.create).not.toHaveBeenCalled();
  });

  it("resets displayConfig to {} on an explicit null and rejects a non-object", async () => {
    mockAccess();
    expect(await runWidgetUpdate({ displayConfig: null })).toMatchObject({
      ok: true,
      changed: ["display_config"],
    });
    expect(tx.widget.update).toHaveBeenCalledWith({
      where: { id: "wid1" },
      data: { displayConfig: {} },
    });
    expect(await runWidgetUpdate({ displayConfig: [1, 2] })).toEqual({
      ok: false,
      status: 400,
      error: "displayConfig must be a JSON object",
    });
  });

  it("writes only the fields that differ, names them in public form, and audits after the commit through the root client", async () => {
    mockAccess();
    const r = await runWidgetUpdate(
      { title: "  Cost by model  ", displayConfig: { color: "red" } },
      { provenance: { transport: "agent", agentSessionId: "as1" } },
    );
    expect(r).toEqual({
      ok: true,
      data: { ...storedWidget, displayConfig: { color: "red" } },
      changed: ["display_config"],
    });
    expect(tx.widget.update).toHaveBeenCalledWith({
      where: { id: "wid1" },
      data: { displayConfig: { color: "red" } },
    });
    expect(order).toEqual(["update", "commit", "audit"]);
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(root.auditLog.create).toHaveBeenCalledWith({
      data: {
        actorUserId: "u1",
        operation: "update_widget",
        resourceType: "widget",
        resourceId: "wid1",
        workspaceId: "w1",
        projectId: "p1",
        summary: { changed: ["display_config"] },
        transport: "agent",
        agentSessionId: "as1",
      },
    });
  });

  it("maps a concurrent delete between the read and the write to 404", async () => {
    mockAccess();
    tx.widget.update.mockRejectedValue(prismaError("P2025"));
    expect(await runWidgetUpdate({ title: "New" })).toEqual({
      ok: false,
      status: 404,
      error: "Widget not found",
    });
    expect(root.auditLog.create).not.toHaveBeenCalled();
  });

  it("propagates other write failures", async () => {
    mockAccess();
    tx.widget.update.mockRejectedValue(new Error("connection lost"));
    await expect(runWidgetUpdate({ title: "New" })).rejects.toThrow("connection lost");
  });
});

describe("deleteWidget", () => {
  it.each([undefined, "", "ab", 7])("refuses reason=%j before reading anything", async (reason) => {
    expect(await runWidgetDelete({ reason })).toEqual({
      ok: false,
      status: 400,
      error: DELETE_REASON_MESSAGE,
    });
    expect(tx.project.findUnique).not.toHaveBeenCalled();
  });

  it("returns 404 for a missing project and the same 404 for a non-member", async () => {
    tx.project.findUnique.mockResolvedValue(null);
    expect(await runWidgetDelete()).toEqual({ ok: false, status: 404, error: "Project not found" });
    tx.project.findUnique.mockResolvedValue({ workspaceId: "w1", deleteTime: null });
    tx.workspaceMember.findUnique.mockResolvedValue(null);
    expect(await runWidgetDelete()).toEqual({ ok: false, status: 404, error: "Project not found" });
    expect(tx.widget.delete).not.toHaveBeenCalled();
  });

  it("rejects a VIEWER with 403", async () => {
    mockAccess("VIEWER");
    expect(await runWidgetDelete()).toEqual({
      ok: false,
      status: 403,
      error: "Requires MEMBER role or higher",
    });
  });

  it("returns 404 for a widget outside the project", async () => {
    mockAccess();
    tx.widget.findFirst.mockResolvedValue(null);
    expect(await runWidgetDelete()).toEqual({ ok: false, status: 404, error: "Widget not found" });
    expect(tx.widget.delete).not.toHaveBeenCalled();
  });

  it("locks the dashboard row, deletes the widget, prunes its layout entry in the same transaction, then audits", async () => {
    mockAccess();
    tx.$queryRaw.mockImplementation(async () => {
      order.push("lock");
      return [
        {
          layout: [
            { i: "wid1", x: 0, y: 0, w: 6, h: 4 },
            { i: "w2", x: 6, y: 0, w: 6, h: 4 },
          ],
        },
      ];
    });
    const r = await runWidgetDelete();
    expect(r).toEqual({
      ok: true,
      data: { id: "wid1", name: "Cost by model" },
      reason: "superseded by the cost chart",
    });
    expect(tx.widget.delete).toHaveBeenCalledWith({ where: { id: "wid1" } });
    expect(tx.dashboard.update).toHaveBeenCalledWith({
      where: { id: "dash1" },
      data: { layout: [{ i: "w2", x: 6, y: 0, w: 6, h: 4 }] },
    });
    expect(order).toEqual(["lock", "delete", "layout", "commit", "audit"]);
    // Scoped to the caller's project, like the create and update locks.
    const [lockSql, ...lockValues] = tx.$queryRaw.mock.calls[0] as [
      TemplateStringsArray,
      ...unknown[],
    ];
    expect(lockSql.join("?")).toBe(
      "SELECT layout FROM dashboards WHERE id = ? AND project_id = ? FOR UPDATE",
    );
    expect(lockValues).toEqual(["dash1", "p1"]);
    expect(root.auditLog.create).toHaveBeenCalledWith({
      data: {
        actorUserId: "u1",
        operation: "delete_widget",
        resourceType: "widget",
        resourceId: "wid1",
        workspaceId: "w1",
        projectId: "p1",
        summary: { name: "Cost by model", reason: "superseded by the cost chart" },
        transport: "public-api",
        agentSessionId: null,
      },
    });
  });

  it("leaves the layout alone when the widget had no entry in it", async () => {
    mockAccess();
    tx.$queryRaw.mockResolvedValue([{ layout: [{ i: "w2", x: 0, y: 0, w: 6, h: 4 }] }]);
    expect(await runWidgetDelete()).toMatchObject({ ok: true });
    expect(tx.dashboard.update).not.toHaveBeenCalled();
  });

  it("maps a concurrent delete to 404 and audits nothing", async () => {
    mockAccess();
    tx.widget.delete.mockRejectedValue(prismaError("P2025"));
    expect(await runWidgetDelete()).toEqual({ ok: false, status: 404, error: "Widget not found" });
    expect(root.auditLog.create).not.toHaveBeenCalled();
  });
});

describe("updateDashboard", () => {
  it("returns 404 for a missing project, the same 404 for a non-member, and 403 for a VIEWER", async () => {
    tx.project.findUnique.mockResolvedValue(null);
    expect(await runDashboardUpdate({ name: "New" })).toEqual({
      ok: false,
      status: 404,
      error: "Project not found",
    });
    tx.project.findUnique.mockResolvedValue({ workspaceId: "w1", deleteTime: null });
    tx.workspaceMember.findUnique.mockResolvedValue(null);
    expect(await runDashboardUpdate({ name: "New" })).toEqual({
      ok: false,
      status: 404,
      error: "Project not found",
    });
    mockAccess("VIEWER");
    expect(await runDashboardUpdate({ name: "New" })).toEqual({
      ok: false,
      status: 403,
      error: "Requires MEMBER role or higher",
    });
    expect(tx.dashboard.findFirst).not.toHaveBeenCalled();
  });

  it("rejects an empty patch with 400", async () => {
    mockAccess();
    expect(await runDashboardUpdate({})).toEqual({
      ok: false,
      status: 400,
      error: NO_FIELDS_MESSAGE,
    });
  });

  it("returns 404 for a dashboard outside the project", async () => {
    mockAccess();
    tx.dashboard.findFirst.mockResolvedValue(null);
    expect(await runDashboardUpdate({ name: "New" })).toEqual({
      ok: false,
      status: 404,
      error: "Dashboard not found",
    });
    expect(tx.dashboard.findFirst).toHaveBeenCalledWith({
      where: { id: "dash1", projectId: "p1" },
    });
  });

  it.each(["", "  ", 42, null, "x".repeat(DASHBOARD_NAME_MAX + 1)])(
    "rejects name=%j with 400",
    async (name) => {
      mockAccess();
      expect(await runDashboardUpdate({ name })).toEqual({
        ok: false,
        status: 400,
        error: nameMessage,
      });
    },
  );

  it("trims the name, clears the description on null, and names the changed fields", async () => {
    mockAccess();
    tx.dashboard.findFirst.mockResolvedValue({ ...storedDashboard, description: "old" });
    const r = await runDashboardUpdate({ name: "  Costs  ", description: null });
    expect(r).toMatchObject({ ok: true, changed: ["name", "description"] });
    expect(tx.dashboard.update).toHaveBeenCalledWith({
      where: { id: "dash1" },
      data: { name: "Costs", description: null },
    });
  });

  it("rejects a description over the cap and a non-string description", async () => {
    mockAccess();
    expect(await runDashboardUpdate({ description: "x".repeat(501) })).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(await runDashboardUpdate({ description: 5 })).toEqual({
      ok: false,
      status: 400,
      error: "description must be a string",
    });
  });

  it("validates and whitelists layout entries, which only the web app sends", async () => {
    mockAccess();
    for (const bad of [
      { i: "w1" },
      [null],
      [{ i: "w1", x: -1, y: 0, w: 1, h: 1 }],
      [{ x: 0, y: 0, w: 1, h: 1 }],
    ]) {
      expect(await runDashboardUpdate({ layout: bad })).toMatchObject({ ok: false, status: 400 });
    }
    expect(tx.dashboard.update).not.toHaveBeenCalled();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    const r = await runDashboardUpdate({
      layout: [{ i: "w1", x: 0, y: 0, w: 4, h: 4, static: true }],
    });
    expect(r).toMatchObject({ ok: true, changed: ["layout"] });
    expect(tx.dashboard.update).toHaveBeenCalledWith({
      where: { id: "dash1" },
      data: { layout: [{ i: "w1", x: 0, y: 0, w: 4, h: 4 }] },
    });
  });

  it("locks the dashboard row before reading it when the patch carries a layout", async () => {
    mockAccess();
    tx.dashboard.findFirst.mockImplementation(async () => {
      order.push("read");
      return storedDashboard;
    });
    // The same lock the widget create and delete take: a drag committed
    // against a stale read would otherwise put a deleted widget's placement
    // back, or drop a created one's.
    await runDashboardUpdate({ layout: [{ i: "w2", x: 0, y: 0, w: 4, h: 4 }] });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["lock", "read", "layout", "commit", "audit"]);
    // Scoped to the caller's project: a dashboard id from elsewhere locks
    // nothing instead of contending with that project's writes.
    const [strings, ...values] = tx.$queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    expect(strings.join("?")).toBe(
      "SELECT layout FROM dashboards WHERE id = ? AND project_id = ? FOR UPDATE",
    );
    expect(values).toEqual(["dash1", "p1"]);
  });

  it("answers a no-op rename without writing or auditing", async () => {
    mockAccess();
    expect(await runDashboardUpdate({ name: "Cost overview", description: null })).toEqual({
      ok: true,
      data: storedDashboard,
      changed: [],
    });
    expect(tx.dashboard.update).not.toHaveBeenCalled();
    expect(root.auditLog.create).not.toHaveBeenCalled();
  });

  it("audits a rename after the commit with operation update_dashboard, taking no layout lock", async () => {
    mockAccess();
    await runDashboardUpdate({ name: "Costs" });
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(order).toEqual(["layout", "commit", "audit"]);
    expect(root.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        operation: "update_dashboard",
        resourceType: "dashboard",
        resourceId: "dash1",
        summary: { changed: ["name"] },
        transport: "public-api",
      }),
    });
  });

  it("maps a rename collision to 409, including one that appears between the read and the write", async () => {
    mockAccess();
    tx.dashboard.update.mockRejectedValue(prismaError("P2002", ["projectId", "name"]));
    expect(await runDashboardUpdate({ name: "Taken" })).toEqual({
      ok: false,
      status: 409,
      error: "A dashboard with this name already exists",
    });
    expect(root.auditLog.create).not.toHaveBeenCalled();
  });

  it("maps a concurrent delete to 404 and propagates other failures", async () => {
    mockAccess();
    tx.dashboard.update.mockRejectedValueOnce(prismaError("P2025"));
    expect(await runDashboardUpdate({ name: "New" })).toEqual({
      ok: false,
      status: 404,
      error: "Dashboard not found",
    });
    tx.dashboard.update.mockRejectedValueOnce(new Error("connection lost"));
    await expect(runDashboardUpdate({ name: "New" })).rejects.toThrow("connection lost");
  });
});

describe("deleteDashboard", () => {
  it("refuses a missing reason before reading anything", async () => {
    expect(await runDashboardDelete({ reason: undefined })).toEqual({
      ok: false,
      status: 400,
      error: DELETE_REASON_MESSAGE,
    });
    expect(tx.project.findUnique).not.toHaveBeenCalled();
  });

  it("returns 404 for a dashboard outside the project", async () => {
    mockAccess();
    tx.dashboard.findFirst.mockResolvedValue(null);
    expect(await runDashboardDelete()).toEqual({
      ok: false,
      status: 404,
      error: "Dashboard not found",
    });
  });

  it("refuses the project's last dashboard with 409, counting within the project", async () => {
    mockAccess();
    tx.dashboard.count.mockResolvedValue(1);
    expect(await runDashboardDelete()).toEqual({
      ok: false,
      status: 409,
      error: "Cannot delete a project's last dashboard",
    });
    expect(tx.dashboard.count).toHaveBeenCalledWith({ where: { projectId: "p1" } });
    expect(tx.dashboard.delete).not.toHaveBeenCalled();
  });

  it("answers a dashboard deleted while it waited for the project lock with 404, not the last-dashboard 409", async () => {
    mockAccess();
    tx.dashboard.count.mockResolvedValue(1);
    tx.dashboard.findFirst.mockImplementation(async () => {
      order.push("read");
      return null;
    });
    expect(await runDashboardDelete()).toEqual({
      ok: false,
      status: 404,
      error: "Dashboard not found",
    });
    expect(order).toEqual(["lock", "read", "commit"]);
    expect(tx.dashboard.count).not.toHaveBeenCalled();
    expect(tx.dashboard.delete).not.toHaveBeenCalled();
  });

  it("locks the project row before reading and counting, deletes, reports the cascaded widget count, and audits with the reason", async () => {
    mockAccess();
    tx.dashboard.findFirst.mockImplementation(async () => {
      order.push("read");
      return storedDashboard;
    });
    tx.dashboard.count.mockImplementation(async () => {
      order.push("count");
      return 2;
    });
    const r = await runDashboardDelete();
    expect(r).toEqual({
      ok: true,
      data: { id: "dash1", name: "Cost overview" },
      reason: "cleaning up the test dashboards",
      cascaded: { widgets: 3 },
    });
    expect(tx.widget.count).toHaveBeenCalledWith({ where: { dashboardId: "dash1" } });
    expect(tx.dashboard.delete).toHaveBeenCalledWith({ where: { id: "dash1" } });
    // The lock serializes concurrent deletes of a project's last dashboards,
    // so the count each one reads includes the other's delete.
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["lock", "read", "count", "delete", "commit", "audit"]);
    expect(root.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        operation: "delete_dashboard",
        resourceType: "dashboard",
        resourceId: "dash1",
        summary: {
          name: "Cost overview",
          reason: "cleaning up the test dashboards",
          cascaded: { widgets: 3 },
        },
      }),
    });
  });

  it("maps a concurrent delete to 404", async () => {
    mockAccess();
    tx.dashboard.delete.mockRejectedValue(prismaError("P2025"));
    expect(await runDashboardDelete()).toEqual({
      ok: false,
      status: 404,
      error: "Dashboard not found",
    });
  });
});
