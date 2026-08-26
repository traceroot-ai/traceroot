import { describe, it, expect, vi, beforeEach } from "vitest";

const tx = {
  workspaceMember: { findUnique: vi.fn() },
  project: { findFirst: vi.fn(), create: vi.fn() },
  auditLog: { create: vi.fn().mockResolvedValue({}) },
};
vi.mock("@traceroot/core", () => {
  const ROLE_ORDER = ["VIEWER", "MEMBER", "ADMIN"];
  return {
    prisma: { $transaction: (fn: (t: unknown) => unknown) => fn(tx) },
    Role: { VIEWER: "VIEWER", MEMBER: "MEMBER", ADMIN: "ADMIN" },
    hasMinRole: (userRole: string, minRole: string) =>
      ROLE_ORDER.indexOf(userRole) >= ROLE_ORDER.indexOf(minRole),
  };
});
import { createProject } from "./projects";

beforeEach(() => {
  tx.workspaceMember.findUnique.mockReset();
  tx.project.findFirst.mockReset();
  tx.project.create.mockReset();
  tx.auditLog.create.mockReset();
  tx.auditLog.create.mockResolvedValue({});
});

describe("createProject", () => {
  it("creates the project and audits, created=true", async () => {
    tx.workspaceMember.findUnique.mockResolvedValue({ role: "MEMBER" });
    tx.project.findFirst.mockResolvedValue(null);
    tx.project.create.mockResolvedValue({
      id: "p1",
      name: "Checkout",
      workspaceId: "w1",
    });
    const r = await createProject({
      actorUserId: "u1",
      workspaceId: "w1",
      name: "Checkout",
      traceTtlDays: 30,
      provenance: { transport: "agent", agentSessionId: "as1" },
    });
    expect(r).toEqual({
      ok: true,
      created: true,
      data: { id: "p1", name: "Checkout", workspaceId: "w1" },
    });
    expect(tx.project.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "w1",
        name: "Checkout",
        traceTtlDays: 30,
      }),
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorUserId: "u1",
        operation: "create_project",
        resourceType: "project",
        resourceId: "p1",
        workspaceId: "w1",
        projectId: "p1",
        summary: { name: "Checkout" },
        transport: "agent",
        agentSessionId: "as1",
      }),
    });
  });

  it("stores null traceTtlDays when omitted", async () => {
    tx.workspaceMember.findUnique.mockResolvedValue({ role: "ADMIN" });
    tx.project.findFirst.mockResolvedValue(null);
    tx.project.create.mockResolvedValue({
      id: "p2",
      name: "Checkout",
      workspaceId: "w1",
    });
    const r = await createProject({
      actorUserId: "u1",
      workspaceId: "w1",
      name: "Checkout",
      provenance: { transport: "public-api" },
    });
    expect(r).toEqual({
      ok: true,
      created: true,
      data: { id: "p2", name: "Checkout", workspaceId: "w1" },
    });
    expect(tx.project.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ traceTtlDays: null }),
    });
  });

  it("returns the existing live project by name, created=false, no create, no audit", async () => {
    tx.workspaceMember.findUnique.mockResolvedValue({ role: "MEMBER" });
    tx.project.findFirst.mockResolvedValue({
      id: "p0",
      name: "Checkout",
      workspaceId: "w1",
    });
    const r = await createProject({
      actorUserId: "u1",
      workspaceId: "w1",
      name: "Checkout",
      provenance: { transport: "public-api" },
    });
    expect(r).toEqual({
      ok: true,
      created: false,
      data: { id: "p0", name: "Checkout", workspaceId: "w1" },
    });
    expect(tx.project.findFirst).toHaveBeenCalledWith({
      where: { workspaceId: "w1", name: "Checkout", deleteTime: null },
      select: { id: true, name: true, workspaceId: true },
    });
    expect(tx.project.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("rejects a non-member with 403", async () => {
    tx.workspaceMember.findUnique.mockResolvedValue(null);
    const r = await createProject({
      actorUserId: "u1",
      workspaceId: "w1",
      name: "Checkout",
      provenance: { transport: "public-api" },
    });
    expect(r).toEqual({
      ok: false,
      status: 403,
      error: "Not a member of this workspace",
    });
    expect(tx.project.create).not.toHaveBeenCalled();
  });

  it("rejects a VIEWER with 403", async () => {
    tx.workspaceMember.findUnique.mockResolvedValue({ role: "VIEWER" });
    const r = await createProject({
      actorUserId: "u1",
      workspaceId: "w1",
      name: "Checkout",
      provenance: { transport: "public-api" },
    });
    expect(r).toEqual({
      ok: false,
      status: 403,
      error: "Requires MEMBER role or higher",
    });
    expect(tx.project.create).not.toHaveBeenCalled();
  });

  it("rejects an empty name with 400", async () => {
    const r = await createProject({
      actorUserId: "u1",
      workspaceId: "w1",
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
    const r = await createProject({
      actorUserId: "u1",
      workspaceId: "w1",
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
    tx.workspaceMember.findUnique.mockResolvedValue({ role: "MEMBER" });
    tx.project.findFirst.mockResolvedValue(null);
    tx.project.create.mockResolvedValue({ id: "p3", name, workspaceId: "w1" });
    const r = await createProject({
      actorUserId: "u1",
      workspaceId: "w1",
      name,
      provenance: { transport: "public-api" },
    });
    expect(r).toEqual({
      ok: true,
      created: true,
      data: { id: "p3", name, workspaceId: "w1" },
    });
  });

  it.each([0, 366, 1.5])("rejects traceTtlDays=%s with 400", async (ttl) => {
    const r = await createProject({
      actorUserId: "u1",
      workspaceId: "w1",
      name: "Checkout",
      traceTtlDays: ttl,
      provenance: { transport: "public-api" },
    });
    expect(r).toEqual({
      ok: false,
      status: 400,
      error: "traceTtlDays must be an integer between 1 and 365",
    });
  });

  it.each([1, 365])("accepts boundary traceTtlDays=%s", async (ttl) => {
    tx.workspaceMember.findUnique.mockResolvedValue({ role: "MEMBER" });
    tx.project.findFirst.mockResolvedValue(null);
    tx.project.create.mockResolvedValue({
      id: "p4",
      name: "Checkout",
      workspaceId: "w1",
    });
    const r = await createProject({
      actorUserId: "u1",
      workspaceId: "w1",
      name: "Checkout",
      traceTtlDays: ttl,
      provenance: { transport: "public-api" },
    });
    expect(r).toEqual({
      ok: true,
      created: true,
      data: { id: "p4", name: "Checkout", workspaceId: "w1" },
    });
    expect(tx.project.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ traceTtlDays: ttl }),
    });
  });
});
