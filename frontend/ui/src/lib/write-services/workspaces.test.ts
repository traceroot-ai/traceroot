import { describe, it, expect, vi, beforeEach } from "vitest";

// The transaction client and the root client carry separate auditLog mocks so
// the tests can tell which one the audit row was written through.
const { tx, root } = vi.hoisted(() => ({
  tx: {
    workspace: { findFirst: vi.fn(), create: vi.fn() },
    workspaceMember: { create: vi.fn() },
    auditLog: { create: vi.fn() },
  },
  root: { workspace: { findFirst: vi.fn() }, auditLog: { create: vi.fn() } },
}));
vi.mock("@traceroot/core", () => ({
  prisma: {
    $transaction: (fn: (t: unknown) => unknown) => fn(tx),
    workspace: root.workspace,
    auditLog: root.auditLog,
  },
  Role: { VIEWER: "VIEWER", MEMBER: "MEMBER", ADMIN: "ADMIN" },
}));
import { createWorkspace } from "./workspaces";

beforeEach(() => {
  tx.workspace.findFirst.mockReset();
  tx.workspace.create.mockReset();
  tx.workspaceMember.create.mockReset();
  tx.auditLog.create.mockReset();
  tx.auditLog.create.mockResolvedValue({});
  root.workspace.findFirst.mockReset();
  root.auditLog.create.mockReset();
  root.auditLog.create.mockResolvedValue({});
});

/** A duck-typed Prisma unique-violation, as the P2002 handlers match it. */
const p2002 = () => Object.assign(new Error("Unique constraint failed"), { code: "P2002" });

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
    expect(root.auditLog.create).toHaveBeenCalled();
  });

  it("audits through the root client, not the transaction, so a failed audit cannot roll the workspace back", async () => {
    tx.workspace.findFirst.mockResolvedValue(null);
    tx.workspace.create.mockResolvedValue({ id: "w1", name: "Acme" });
    tx.workspaceMember.create.mockResolvedValue({});
    root.auditLog.create.mockRejectedValue(new Error("audit store down"));
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
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(root.auditLog.create).toHaveBeenCalled();
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
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("stamps the creator on the row so the unique key can back the idempotency", async () => {
    tx.workspace.findFirst.mockResolvedValue(null);
    tx.workspace.create.mockResolvedValue({ id: "w1", name: "Acme" });
    tx.workspaceMember.create.mockResolvedValue({});
    await createWorkspace({
      actorUserId: "u1",
      name: "Acme",
      provenance: { transport: "public-api" },
    });
    expect(tx.workspace.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ name: "Acme", createdBy: "u1" }),
    });
  });

  it("returns the raced workspace as created=false when the insert loses the unique race", async () => {
    tx.workspace.findFirst.mockResolvedValue(null);
    tx.workspace.create.mockRejectedValue(p2002());
    root.workspace.findFirst.mockResolvedValue({ id: "w9", name: "Acme" });
    const r = await createWorkspace({
      actorUserId: "u1",
      name: "Acme",
      provenance: { transport: "public-api" },
    });
    expect(r).toEqual({
      ok: true,
      created: false,
      data: { id: "w9", name: "Acme", role: "ADMIN" },
    });
    expect(root.auditLog.create).not.toHaveBeenCalled();
  });

  it("returns 409 when the name is held by a workspace the actor no longer administers", async () => {
    tx.workspace.findFirst.mockResolvedValue(null);
    tx.workspace.create.mockRejectedValue(p2002());
    root.workspace.findFirst.mockResolvedValue(null);
    const r = await createWorkspace({
      actorUserId: "u1",
      name: "Acme",
      provenance: { transport: "public-api" },
    });
    expect(r).toEqual({
      ok: false,
      status: 409,
      error: "A workspace with this name already exists",
    });
  });

  it("propagates non-P2002 transaction failures", async () => {
    tx.workspace.findFirst.mockResolvedValue(null);
    tx.workspace.create.mockRejectedValue(new Error("connection lost"));
    await expect(
      createWorkspace({
        actorUserId: "u1",
        name: "Acme",
        provenance: { transport: "public-api" },
      }),
    ).rejects.toThrow("connection lost");
    expect(root.workspace.findFirst).not.toHaveBeenCalled();
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
