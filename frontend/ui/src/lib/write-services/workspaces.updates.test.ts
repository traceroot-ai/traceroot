import { describe, it, expect, vi, beforeEach } from "vitest";
import { DELETE_REASON_MESSAGE, NO_FIELDS_MESSAGE } from "./update-support";

// The transaction client and the root client carry separate auditLog mocks so
// the tests can tell which one the audit row was written through.
const { tx, root, order } = vi.hoisted(() => ({
  tx: {
    workspace: { findUnique: vi.fn(), update: vi.fn(), delete: vi.fn() },
    workspaceMember: { findUnique: vi.fn(), count: vi.fn() },
    project: { count: vi.fn() },
    auditLog: { create: vi.fn() },
    // The locking read of the caller's user row that serializes their deletes.
    $queryRaw: vi.fn(),
  },
  root: { auditLog: { create: vi.fn() } },
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
import { deleteWorkspace, updateWorkspace } from "./workspaces";

const T0 = new Date("2026-08-01T00:00:00Z");
const storedWorkspace = { id: "w1", name: "Acme", createdBy: "u1", createTime: T0, updateTime: T0 };
const provenance = { transport: "public-api" as const };

function mockAccess(role = "ADMIN") {
  tx.workspaceMember.findUnique.mockResolvedValue({ role });
}

const update = (patch: Record<string, unknown>, overrides: Record<string, unknown> = {}) =>
  updateWorkspace({
    actorUserId: "u1",
    workspaceId: "w1",
    patch,
    provenance,
    ...overrides,
  } as Parameters<typeof updateWorkspace>[0]);

const remove = (overrides: Record<string, unknown> = {}) =>
  deleteWorkspace({
    actorUserId: "u1",
    workspaceId: "w1",
    name: "Acme",
    reason: "the team moved to a new workspace",
    provenance,
    ...overrides,
  } as Parameters<typeof deleteWorkspace>[0]);

/** A duck-typed Prisma error, as the handlers match them. */
const prismaError = (code: string) => Object.assign(new Error(`prisma ${code}`), { code });

beforeEach(() => {
  order.length = 0;
  for (const model of [tx.workspace, tx.workspaceMember, tx.project, tx.auditLog]) {
    for (const fn of Object.values(model)) fn.mockReset();
  }
  tx.workspace.findUnique.mockResolvedValue(storedWorkspace);
  tx.workspace.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    order.push("update");
    return { ...storedWorkspace, ...data };
  });
  tx.workspace.delete.mockImplementation(async () => {
    order.push("delete");
    return storedWorkspace;
  });
  tx.workspaceMember.count.mockImplementation(async () => {
    order.push("count");
    return 2;
  });
  tx.project.count.mockResolvedValue(3);
  tx.$queryRaw.mockReset();
  tx.$queryRaw.mockImplementation(async () => {
    order.push("lock");
    return [{ id: "u1" }];
  });
  root.auditLog.create.mockReset();
  root.auditLog.create.mockImplementation(async () => {
    order.push("audit");
    return {};
  });
});

describe("updateWorkspace", () => {
  it("returns 403 for a non-member and 403 below ADMIN, reading nothing else", async () => {
    tx.workspaceMember.findUnique.mockResolvedValue(null);
    expect(await update({ name: "New" })).toEqual({
      ok: false,
      status: 403,
      error: "Not a member of this workspace",
    });
    expect(tx.workspaceMember.findUnique).toHaveBeenCalledWith({
      where: { workspaceId_userId: { workspaceId: "w1", userId: "u1" } },
      select: { role: true },
    });
    mockAccess("MEMBER");
    expect(await update({ name: "New" })).toEqual({
      ok: false,
      status: 403,
      error: "Requires ADMIN role or higher",
    });
    expect(tx.workspace.findUnique).not.toHaveBeenCalled();
  });

  it("rejects an empty patch and a bad name with 400", async () => {
    mockAccess();
    expect(await update({})).toEqual({ ok: false, status: 400, error: NO_FIELDS_MESSAGE });
    for (const name of ["", "  ", null, 42, "x".repeat(101)]) {
      expect(await update({ name })).toEqual({
        ok: false,
        status: 400,
        error: "name must be a non-empty string (max 100 chars)",
      });
    }
    expect(tx.workspace.update).not.toHaveBeenCalled();
  });

  it("returns 404 when the workspace row is gone", async () => {
    mockAccess();
    tx.workspace.findUnique.mockResolvedValue(null);
    expect(await update({ name: "New" })).toEqual({
      ok: false,
      status: 404,
      error: "Workspace not found",
    });
  });

  it("answers the current name as a no-op: no write, no audit", async () => {
    mockAccess();
    expect(await update({ name: "  Acme  " })).toEqual({
      ok: true,
      data: { id: "w1", name: "Acme", role: "ADMIN", createTime: T0, updateTime: T0 },
      changed: [],
    });
    expect(tx.workspace.update).not.toHaveBeenCalled();
    expect(root.auditLog.create).not.toHaveBeenCalled();
  });

  it("renames with a fresh updateTime and audits after the commit through the root client", async () => {
    mockAccess();
    const r = await update({ name: "Acme Corp" }, { provenance: { transport: "ui" } });
    expect(r).toMatchObject({ ok: true, data: { id: "w1", name: "Acme Corp" }, changed: ["name"] });
    expect(tx.workspace.update).toHaveBeenCalledWith({
      where: { id: "w1" },
      data: { name: "Acme Corp", updateTime: expect.any(Date) },
    });
    expect(order).toEqual(["update", "commit", "audit"]);
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(root.auditLog.create).toHaveBeenCalledWith({
      data: {
        actorUserId: "u1",
        operation: "update_workspace",
        resourceType: "workspace",
        resourceId: "w1",
        workspaceId: "w1",
        projectId: null,
        summary: { changed: ["name"] },
        transport: "ui",
        agentSessionId: null,
      },
    });
  });

  it("maps a rename collision to 409, a concurrent delete to 404, and propagates other failures", async () => {
    mockAccess();
    tx.workspace.update.mockRejectedValueOnce(prismaError("P2002"));
    expect(await update({ name: "Taken" })).toEqual({
      ok: false,
      status: 409,
      error: "A workspace with this name already exists",
    });
    tx.workspace.update.mockRejectedValueOnce(prismaError("P2025"));
    expect(await update({ name: "New" })).toEqual({
      ok: false,
      status: 404,
      error: "Workspace not found",
    });
    tx.workspace.update.mockRejectedValueOnce(new Error("connection lost"));
    await expect(update({ name: "New" })).rejects.toThrow("connection lost");
    expect(root.auditLog.create).not.toHaveBeenCalled();
  });
});

describe("deleteWorkspace", () => {
  it("refuses a missing reason before reading anything", async () => {
    expect(await remove({ reason: undefined })).toEqual({
      ok: false,
      status: 400,
      error: DELETE_REASON_MESSAGE,
    });
    expect(tx.workspaceMember.findUnique).not.toHaveBeenCalled();
  });

  it("returns 403 for a non-member and below ADMIN, and 404 when the row is gone", async () => {
    tx.workspaceMember.findUnique.mockResolvedValueOnce(null);
    expect(await remove()).toEqual({
      ok: false,
      status: 403,
      error: "Not a member of this workspace",
    });
    mockAccess("MEMBER");
    expect(await remove()).toEqual({
      ok: false,
      status: 403,
      error: "Requires ADMIN role or higher",
    });
    mockAccess();
    tx.workspace.findUnique.mockResolvedValueOnce(null);
    expect(await remove()).toEqual({ ok: false, status: 404, error: "Workspace not found" });
    expect(tx.workspace.delete).not.toHaveBeenCalled();
  });

  it("refuses a typed name that does not match the current one with 409 and deletes nothing", async () => {
    mockAccess();
    expect(await remove({ name: "acme" })).toEqual({
      ok: false,
      status: 409,
      error: "Workspace name does not match",
    });
    expect(tx.workspace.delete).not.toHaveBeenCalled();
    expect(root.auditLog.create).not.toHaveBeenCalled();
  });

  it("refuses the caller's only workspace with 409, counting under the lock on their user row", async () => {
    mockAccess();
    tx.workspaceMember.count.mockImplementation(async () => {
      order.push("count");
      return 1;
    });
    expect(await remove()).toEqual({
      ok: false,
      status: 409,
      error: "Cannot delete your only workspace",
    });
    expect(tx.workspaceMember.count).toHaveBeenCalledWith({ where: { userId: "u1" } });
    // Two concurrent deletes of the caller's last two workspaces would each
    // count two without the lock; serialized, the second counts what the
    // first left.
    expect(order).toEqual(["lock", "count", "commit"]);
    expect(tx.workspace.delete).not.toHaveBeenCalled();
  });

  it("hard-deletes, relying on the cascades, and reports the live projects that went with it", async () => {
    mockAccess();
    expect(await remove()).toEqual({
      ok: true,
      data: { id: "w1", name: "Acme" },
      reason: "the team moved to a new workspace",
      cascaded: { projects: 3 },
    });
    expect(tx.project.count).toHaveBeenCalledWith({
      where: { workspaceId: "w1", deleteTime: null },
    });
    expect(tx.workspace.delete).toHaveBeenCalledWith({ where: { id: "w1" } });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    const [sql, ...values] = tx.$queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    expect(sql.join("?")).toBe("SELECT id FROM users WHERE id = ? FOR UPDATE");
    expect(values).toEqual(["u1"]);
    expect(order).toEqual(["lock", "count", "delete", "commit", "audit"]);
    expect(root.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        operation: "delete_workspace",
        resourceType: "workspace",
        resourceId: "w1",
        workspaceId: "w1",
        summary: {
          name: "Acme",
          reason: "the team moved to a new workspace",
          cascaded: { projects: 3 },
        },
      }),
    });
  });

  it("maps a concurrent delete to 404", async () => {
    mockAccess();
    tx.workspace.delete.mockRejectedValue(prismaError("P2025"));
    expect(await remove()).toEqual({ ok: false, status: 404, error: "Workspace not found" });
  });
});
