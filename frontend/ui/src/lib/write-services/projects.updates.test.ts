import { describe, it, expect, vi, beforeEach } from "vitest";
import { DELETE_REASON_MESSAGE, NO_FIELDS_MESSAGE } from "./update-support";

// The transaction client and the root client carry separate auditLog mocks so
// the tests can tell which one the audit row was written through.
const { tx, root, order } = vi.hoisted(() => ({
  tx: {
    workspaceMember: { findUnique: vi.fn() },
    project: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    modelProvider: { findUnique: vi.fn() },
    auditLog: { create: vi.fn() },
  },
  root: { auditLog: { create: vi.fn() } },
  order: [] as string[],
}));
vi.mock("@traceroot/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@traceroot/core")>()),
  prisma: {
    $transaction: async (fn: (t: unknown) => unknown) => {
      const outcome = await fn(tx);
      order.push("commit");
      return outcome;
    },
    auditLog: root.auditLog,
  },
}));
import { deleteProject, updateProject } from "./projects";

const CREATE_TIME = new Date("2026-08-01T00:00:00Z");
const storedProject = {
  id: "p1",
  workspaceId: "w1",
  name: "Checkout",
  traceTtlDays: 30,
  deleteTime: null,
  createTime: CREATE_TIME,
  updateTime: CREATE_TIME,
  rcaModel: null,
  rcaProvider: null,
  rcaSource: null,
  alertConfig: null,
};

const provenance = { transport: "public-api" as const };

function mockAccess(role = "ADMIN") {
  tx.workspaceMember.findUnique.mockResolvedValue({ role });
}

function runUpdate(patch: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return updateProject({
    actorUserId: "u1",
    projectId: "p1",
    patch,
    provenance,
    ...overrides,
  } as Parameters<typeof updateProject>[0]);
}

function runDelete(overrides: Record<string, unknown> = {}) {
  return deleteProject({
    actorUserId: "u1",
    projectId: "p1",
    reason: "the service was decommissioned",
    provenance,
    ...overrides,
  } as Parameters<typeof deleteProject>[0]);
}

/** A duck-typed Prisma error naming the violated constraint, as the handlers match it. */
const prismaError = (code: string, target?: unknown) =>
  Object.assign(new Error(`prisma ${code}`), { code, meta: { target } });

beforeEach(() => {
  order.length = 0;
  for (const model of [tx.workspaceMember, tx.project, tx.modelProvider, tx.auditLog]) {
    for (const fn of Object.values(model)) fn.mockReset();
  }
  tx.project.findUnique.mockResolvedValue(storedProject);
  tx.project.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    order.push("update");
    const { alertConfig, ...columns } = data;
    const upsert = (alertConfig as { upsert?: { update: Record<string, unknown> } } | undefined)
      ?.upsert;
    return {
      ...storedProject,
      ...columns,
      alertConfig: upsert ? { emailAddresses: [], alertWindow: "10m", ...upsert.update } : null,
    };
  });
  tx.project.updateMany.mockImplementation(async () => {
    order.push("soft-delete");
    return { count: 1 };
  });
  root.auditLog.create.mockReset();
  root.auditLog.create.mockImplementation(async () => {
    order.push("audit");
    return {};
  });
});

describe("updateProject", () => {
  it("returns 404 for a missing or soft-deleted project, resolved through the caller's tenancy", async () => {
    tx.project.findUnique.mockResolvedValue(null);
    expect(await runUpdate({ name: "New" })).toEqual({
      ok: false,
      status: 404,
      error: "Project not found",
    });
    expect(tx.project.findUnique).toHaveBeenCalledWith({
      where: { id: "p1" },
      include: { alertConfig: true },
    });
    tx.project.findUnique.mockResolvedValue({ ...storedProject, deleteTime: new Date() });
    expect(await runUpdate({ name: "New" })).toEqual({
      ok: false,
      status: 404,
      error: "Project not found",
    });
    expect(tx.workspaceMember.findUnique).not.toHaveBeenCalled();
  });

  it("also scopes to the workspace when the caller names one, as the cookie route's path does", async () => {
    tx.project.findUnique.mockResolvedValue(null);
    await runUpdate({ name: "New" }, { workspaceId: "w1" });
    expect(tx.project.findUnique).toHaveBeenCalledWith({
      where: { id: "p1", workspaceId: "w1" },
      include: { alertConfig: true },
    });
  });

  it("returns the same 404 for a non-member, and 403 below ADMIN", async () => {
    tx.workspaceMember.findUnique.mockResolvedValue(null);
    expect(await runUpdate({ name: "New" })).toEqual({
      ok: false,
      status: 404,
      error: "Project not found",
    });
    expect(tx.workspaceMember.findUnique).toHaveBeenCalledWith({
      where: { workspaceId_userId: { workspaceId: "w1", userId: "u1" } },
      select: { role: true },
    });
    mockAccess("MEMBER");
    expect(await runUpdate({ name: "New" })).toEqual({
      ok: false,
      status: 403,
      error: "Requires ADMIN role or higher",
    });
    expect(tx.project.update).not.toHaveBeenCalled();
  });

  it("rejects an empty patch with 400", async () => {
    mockAccess();
    expect(await runUpdate({})).toEqual({ ok: false, status: 400, error: NO_FIELDS_MESSAGE });
    expect(await runUpdate({ name: undefined })).toEqual({
      ok: false,
      status: 400,
      error: NO_FIELDS_MESSAGE,
    });
  });

  it.each([
    [{ name: "" }, "name must be a non-empty string (max 100 chars)"],
    [{ name: null }, "name must be a non-empty string (max 100 chars)"],
    [{ name: "x".repeat(101) }, "name must be a non-empty string (max 100 chars)"],
    [{ traceTtlDays: 0 }, "traceTtlDays must be an integer between 1 and 365"],
    [{ traceTtlDays: 366 }, "traceTtlDays must be an integer between 1 and 365"],
    [{ traceTtlDays: 1.5 }, "traceTtlDays must be an integer between 1 and 365"],
    [{ traceTtlDays: "30" }, "traceTtlDays must be an integer between 1 and 365"],
    [{ rcaModel: "" }, "rcaModel must be a non-empty string (max 200 chars)"],
    [{ alertEmails: ["not-an-email"] }, "alertEmails must be a list of email addresses (max 50)"],
    [{ alertEmails: "a@example.com" }, "alertEmails must be a list of email addresses (max 50)"],
    [{ alertWindow: "24h" }, "Invalid alert window"],
    [{ alertWindow: null }, "Invalid alert window"],
  ])("rejects %j with 400", async (patch, error) => {
    mockAccess();
    expect(await runUpdate(patch)).toEqual({ ok: false, status: 400, error });
    expect(tx.project.update).not.toHaveBeenCalled();
  });

  it("rejects a decision model as the RCA model when saved, before RCA runs", async () => {
    mockAccess();
    expect(await runUpdate({ rcaModel: "jev-1.13.0", rcaSource: "byok" })).toEqual({
      ok: false,
      status: 400,
      error: "rcaModel cannot be a decision model, which only runs detectors",
    });
    expect(tx.project.update).not.toHaveBeenCalled();
  });

  it("rejects a TypeSafe provider as the RCA provider, looked up in the project's workspace", async () => {
    mockAccess();
    tx.modelProvider.findUnique.mockResolvedValue({ adapter: "typesafe" });
    expect(
      await runUpdate({ rcaModel: "gpt-4o", rcaProvider: "my-typesafe", rcaSource: "byok" }),
    ).toEqual({
      ok: false,
      status: 400,
      error:
        "rcaProvider cannot be a decision-model provider (TypeSafe), which only runs detectors",
    });
    expect(tx.modelProvider.findUnique).toHaveBeenCalledWith({
      where: { workspaceId_provider: { workspaceId: "w1", provider: "my-typesafe" } },
      select: { adapter: true },
    });
    expect(tx.project.update).not.toHaveBeenCalled();
  });

  it("checks the stored source when the patch leaves it out", async () => {
    mockAccess();
    tx.project.findUnique.mockResolvedValue({ ...storedProject, rcaSource: "byok" });
    tx.modelProvider.findUnique.mockResolvedValue({ adapter: "typesafe" });
    expect((await runUpdate({ rcaProvider: "my-typesafe" })).ok).toBe(false);
    expect(tx.project.update).not.toHaveBeenCalled();
  });

  it("does not look a system provider name up as a BYOK row", async () => {
    mockAccess();
    const r = await runUpdate({ rcaProvider: "Anthropic", rcaSource: "system" });
    expect(r.ok).toBe(true);
    expect(tx.modelProvider.findUnique).not.toHaveBeenCalled();
  });

  it("answers a patch equal to the stored row as a no-op: no write, no audit", async () => {
    mockAccess();
    const r = await runUpdate({
      name: "Checkout",
      traceTtlDays: 30,
      rcaModel: null,
      alertEmails: [],
      alertWindow: "10m",
    });
    expect(r).toEqual({
      ok: true,
      data: {
        id: "p1",
        name: "Checkout",
        workspaceId: "w1",
        traceTtlDays: 30,
        rcaModel: null,
        rcaProvider: null,
        rcaSource: null,
        alertEmails: [],
        alertWindow: "10m",
        createTime: CREATE_TIME,
        updateTime: CREATE_TIME,
      },
      changed: [],
    });
    expect(tx.project.update).not.toHaveBeenCalled();
    expect(root.auditLog.create).not.toHaveBeenCalled();
  });

  it("writes the differing columns with a fresh updateTime, names them in public form, and audits after the commit", async () => {
    mockAccess();
    const r = await runUpdate(
      { name: "  Checkout v2  ", traceTtlDays: null },
      { provenance: { transport: "agent", agentSessionId: "as1" } },
    );
    expect(r).toMatchObject({
      ok: true,
      data: { name: "Checkout v2", traceTtlDays: null },
      changed: ["name", "trace_ttl_days"],
    });
    expect(tx.project.update).toHaveBeenCalledWith({
      where: { id: "p1", deleteTime: null },
      data: { name: "Checkout v2", traceTtlDays: null, updateTime: expect.any(Date) },
      include: { alertConfig: true },
    });
    expect(order).toEqual(["update", "commit", "audit"]);
    expect(root.auditLog.create).toHaveBeenCalledWith({
      data: {
        actorUserId: "u1",
        operation: "update_project",
        resourceType: "project",
        resourceId: "p1",
        workspaceId: "w1",
        projectId: "p1",
        summary: { changed: ["name", "trace_ttl_days"] },
        transport: "agent",
        agentSessionId: "as1",
      },
    });
  });

  it("routes the alert settings through the alertConfig upsert, diffed against the stored config", async () => {
    mockAccess();
    tx.project.findUnique.mockResolvedValue({
      ...storedProject,
      alertConfig: { emailAddresses: ["a@example.com"], alertWindow: "1h" },
    });
    expect(await runUpdate({ alertEmails: ["a@example.com"], alertWindow: "1h" })).toMatchObject({
      ok: true,
      changed: [],
    });
    const r = await runUpdate({ alertWindow: "30m", rcaSource: "byok" });
    expect(r).toMatchObject({
      ok: true,
      changed: ["rca_source", "alert_window"],
      data: { alertWindow: "30m" },
    });
    expect(tx.project.update).toHaveBeenCalledWith({
      where: { id: "p1", deleteTime: null },
      data: {
        rcaSource: "byok",
        alertConfig: { upsert: { create: { alertWindow: "30m" }, update: { alertWindow: "30m" } } },
        updateTime: expect.any(Date),
      },
      include: { alertConfig: true },
    });
  });

  it("maps a rename collision on the live-name index to 409 and rethrows a P2002 on any other target", async () => {
    mockAccess();
    tx.project.update.mockRejectedValueOnce(prismaError("P2002", "uq_project_workspace_live_name"));
    expect(await runUpdate({ name: "Taken" })).toEqual({
      ok: false,
      status: 409,
      error: "A project with this name already exists",
    });
    tx.project.update.mockRejectedValueOnce(prismaError("P2002", ["projectId"]));
    await expect(
      runUpdate({ name: "Taken", alertEmails: ["a@example.com"] }),
    ).rejects.toMatchObject({ code: "P2002" });
    // A target that merely mentions "name" is some other constraint, not the
    // rename: the fields of a schema-level unique, say, or an index elsewhere.
    for (const target of [["workspaceId", "name"], "uq_project_workspace_hostname", undefined]) {
      tx.project.update.mockRejectedValueOnce(prismaError("P2002", target));
      await expect(runUpdate({ name: "Taken" })).rejects.toMatchObject({ code: "P2002" });
    }
    expect(root.auditLog.create).not.toHaveBeenCalled();
  });

  it("writes only a live row, so a project soft-deleted after the read is a 404, and propagates other failures", async () => {
    mockAccess();
    tx.project.update.mockRejectedValueOnce(prismaError("P2025"));
    expect(await runUpdate({ name: "New" })).toEqual({
      ok: false,
      status: 404,
      error: "Project not found",
    });
    expect(tx.project.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { id: "p1", deleteTime: null } }),
    );
    expect(root.auditLog.create).not.toHaveBeenCalled();
    tx.project.update.mockRejectedValueOnce(new Error("connection lost"));
    await expect(runUpdate({ name: "New" })).rejects.toThrow("connection lost");
  });
});

describe("deleteProject", () => {
  it("refuses a missing reason before reading anything", async () => {
    expect(await runDelete({ reason: "no" })).toEqual({
      ok: false,
      status: 400,
      error: DELETE_REASON_MESSAGE,
    });
    expect(tx.project.findUnique).not.toHaveBeenCalled();
  });

  it("returns 404 for a missing or already-deleted project, the same 404 for a non-member, and 403 below ADMIN", async () => {
    tx.project.findUnique.mockResolvedValueOnce(null);
    expect(await runDelete()).toEqual({ ok: false, status: 404, error: "Project not found" });
    tx.workspaceMember.findUnique.mockResolvedValueOnce(null);
    expect(await runDelete()).toEqual({ ok: false, status: 404, error: "Project not found" });
    mockAccess("MEMBER");
    expect(await runDelete()).toEqual({
      ok: false,
      status: 403,
      error: "Requires ADMIN role or higher",
    });
    expect(tx.project.updateMany).not.toHaveBeenCalled();
  });

  it("soft-deletes through a live-only statement, so a second delete is a 404", async () => {
    mockAccess();
    expect(await runDelete()).toEqual({
      ok: true,
      data: { id: "p1", name: "Checkout" },
      reason: "the service was decommissioned",
    });
    expect(tx.project.updateMany).toHaveBeenCalledWith({
      where: { id: "p1", deleteTime: null },
      data: { deleteTime: expect.any(Date), updateTime: expect.any(Date) },
    });
    expect(order).toEqual(["soft-delete", "commit", "audit"]);
    expect(root.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        operation: "delete_project",
        resourceType: "project",
        resourceId: "p1",
        workspaceId: "w1",
        projectId: "p1",
        summary: { name: "Checkout", reason: "the service was decommissioned" },
      }),
    });

    tx.project.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await runDelete()).toEqual({ ok: false, status: 404, error: "Project not found" });
  });
});
