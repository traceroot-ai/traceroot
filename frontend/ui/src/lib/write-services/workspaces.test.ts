import { describe, it, expect, vi, beforeEach } from "vitest";

const tx = {
  workspace: { findFirst: vi.fn(), create: vi.fn() },
  workspaceMember: { create: vi.fn() },
};
// Audit rows are written on the root client after the transaction commits, so
// the tx mock deliberately has no auditLog.
const auditLogCreate = vi.fn();
vi.mock("@traceroot/core", () => ({
  prisma: {
    $transaction: (fn: (t: unknown) => unknown) => fn(tx),
    auditLog: { create: (args: unknown) => auditLogCreate(args) },
  },
  Role: { VIEWER: "VIEWER", MEMBER: "MEMBER", ADMIN: "ADMIN" },
}));
import { createWorkspace } from "./workspaces";

beforeEach(() => {
  tx.workspace.findFirst.mockReset();
  tx.workspace.create.mockReset();
  tx.workspaceMember.create.mockReset();
  auditLogCreate.mockReset();
  auditLogCreate.mockResolvedValue({});
});

describe("createWorkspace", () => {
  it("creates workspace + ADMIN membership and audits, created=true", async () => {
    tx.workspace.findFirst.mockResolvedValue(null);
    tx.workspace.create.mockResolvedValue({ id: "w1", name: "Acme" });
    tx.workspaceMember.create.mockResolvedValue({});
    const r = await createWorkspace({
      actorUserId: "u1",
      name: "Acme",
      provenance: { transport: "public-api" },
    });
    expect(r).toEqual({
      ok: true,
      created: true,
      data: { id: "w1", name: "Acme", role: "ADMIN" },
    });
    expect(tx.workspaceMember.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: "u1", role: "ADMIN" }),
    });
    expect(auditLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorUserId: "u1",
        operation: "create_workspace",
        resourceType: "workspace",
        resourceId: "w1",
        workspaceId: "w1",
        summary: { name: "Acme" },
        transport: "public-api",
        agentSessionId: null,
      }),
    });
  });

  it("still returns created=true when the audit write fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    tx.workspace.findFirst.mockResolvedValue(null);
    tx.workspace.create.mockResolvedValue({ id: "w1", name: "Acme" });
    tx.workspaceMember.create.mockResolvedValue({});
    auditLogCreate.mockRejectedValue(new Error("audit store down"));
    const r = await createWorkspace({
      actorUserId: "u1",
      name: "Acme",
      provenance: { transport: "public-api" },
    });
    expect(r).toEqual({
      ok: true,
      created: true,
      data: { id: "w1", name: "Acme", role: "ADMIN" },
    });
    expect(auditLogCreate).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("returns the existing workspace when the actor already admins one by that name, created=false", async () => {
    tx.workspace.findFirst.mockResolvedValue({ id: "w0", name: "Acme" });
    const r = await createWorkspace({
      actorUserId: "u1",
      name: "Acme",
      provenance: { transport: "agent", agentSessionId: "as1" },
    });
    expect(r).toEqual({
      ok: true,
      created: false,
      data: { id: "w0", name: "Acme", role: "ADMIN" },
    });
    expect(tx.workspace.create).not.toHaveBeenCalled();
    expect(auditLogCreate).not.toHaveBeenCalled();
  });

  it("rejects an empty name with 400", async () => {
    const r = await createWorkspace({
      actorUserId: "u1",
      name: "  ",
      provenance: { transport: "public-api" },
    });
    expect(r).toEqual({
      ok: false,
      status: 400,
      error: "name must be a non-empty string (max 100 chars)",
    });
  });

  it("rejects a 101-char name with 400", async () => {
    const r = await createWorkspace({
      actorUserId: "u1",
      name: "a".repeat(101),
      provenance: { transport: "public-api" },
    });
    expect(r).toEqual({
      ok: false,
      status: 400,
      error: "name must be a non-empty string (max 100 chars)",
    });
  });

  it("accepts a name of exactly 100 chars", async () => {
    const name = "a".repeat(100);
    tx.workspace.findFirst.mockResolvedValue(null);
    tx.workspace.create.mockResolvedValue({ id: "w2", name });
    tx.workspaceMember.create.mockResolvedValue({});
    const r = await createWorkspace({
      actorUserId: "u1",
      name,
      provenance: { transport: "public-api" },
    });
    expect(r).toEqual({
      ok: true,
      created: true,
      data: { id: "w2", name, role: "ADMIN" },
    });
  });
});
