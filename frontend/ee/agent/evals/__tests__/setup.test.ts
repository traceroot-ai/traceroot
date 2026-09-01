import { describe, expect, it, vi, type Mock } from "vitest";
import { createEvalProject, resolveEvalUser, teardownEvalProject } from "../setup.js";
import type { EvalPrisma } from "../types.js";

/** The delegate as the mock it really is, for call inspection and re-stubbing. */
const asMock = (delegate: unknown): Mock => delegate as Mock;

/** The `data` payload a create delegate was called with. */
const createdData = (delegate: unknown): Record<string, unknown> =>
  asMock(delegate).mock.calls[0][0].data;

function makePrisma(overrides: Partial<Record<string, unknown>> = {}): EvalPrisma {
  return {
    user: { findUnique: vi.fn().mockResolvedValue({ id: "u-1", email: "eval@example.com" }) },
    workspaceMember: { findFirst: vi.fn().mockResolvedValue({ workspaceId: "ws-1" }) },
    project: {
      create: vi.fn(async (args: { data: { id: string; name: string } }) => ({
        id: args.data.id,
        name: args.data.name,
      })),
      delete: vi.fn().mockResolvedValue({}),
    },
    dashboard: {
      create: vi.fn().mockResolvedValue({ id: "dash-1" }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    detector: { findMany: vi.fn().mockResolvedValue([]) },
    auditLog: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    ...overrides,
  } as unknown as EvalPrisma;
}

describe("resolveEvalUser", () => {
  it("resolves the user and a workspace they belong to", async () => {
    const prisma = makePrisma();
    await expect(resolveEvalUser(prisma, "eval@example.com")).resolves.toEqual({
      id: "u-1",
      email: "eval@example.com",
      workspaceId: "ws-1",
    });
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { email: "eval@example.com" },
      select: { id: true, email: true },
    });
  });

  it("looks the membership up by the resolved user id", async () => {
    const prisma = makePrisma();
    await resolveEvalUser(prisma, "eval@example.com");
    expect(prisma.workspaceMember.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "u-1" } }),
    );
  });

  it("names the missing address when no such user exists", async () => {
    const prisma = makePrisma({
      user: { findUnique: vi.fn().mockResolvedValue(null) },
    });
    await expect(resolveEvalUser(prisma, "ghost@example.com")).rejects.toThrow(/ghost@example.com/);
  });

  it("fails clearly when the user belongs to no workspace", async () => {
    const prisma = makePrisma({
      workspaceMember: { findFirst: vi.fn().mockResolvedValue(null) },
    });
    await expect(resolveEvalUser(prisma, "eval@example.com")).rejects.toThrow(/workspace/i);
  });
});

describe("createEvalProject", () => {
  const user = { id: "u-1", email: "eval@example.com", workspaceId: "ws-1" };

  it("creates a run-scoped project in the user's workspace", async () => {
    const prisma = makePrisma();
    const fixture = await createEvalProject(prisma, { user, runId: "abc123" });

    expect(fixture.projectName).toBe("agent-eval-abc123");
    expect(fixture.runId).toBe("abc123");
    expect(fixture.user).toEqual(user);
    expect(prisma.project.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ workspaceId: "ws-1", name: "agent-eval-abc123" }),
    });
  });

  it("generates the project id itself, since the column has no default", async () => {
    const prisma = makePrisma();
    const fixture = await createEvalProject(prisma, { user, runId: "abc123" });

    const created = createdData(prisma.project.create);
    expect(created.id).toEqual(expect.any(String));
    expect(String(created.id).length).toBeGreaterThan(0);
    expect(fixture.projectId).toBe(created.id);
  });

  it("seeds an empty default dashboard so widgets have a target", async () => {
    const prisma = makePrisma();
    const fixture = await createEvalProject(prisma, { user, runId: "abc123" });

    expect(prisma.dashboard.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        projectId: fixture.projectId,
        name: "Default",
        isDefault: true,
        createdBy: "u-1",
        layout: [],
      }),
    });
  });

  it("seeds no starter widgets, so every widget row is agent-authored", async () => {
    const prisma = makePrisma();
    await createEvalProject(prisma, { user, runId: "abc123" });

    expect(createdData(prisma.dashboard.create).widgets).toBeUndefined();
  });
});

describe("teardownEvalProject", () => {
  it("deletes the relation-less audit rows before the project row", async () => {
    const prisma = makePrisma();
    const order: string[] = [];
    asMock(prisma.auditLog.deleteMany).mockImplementation(async () => {
      order.push("audit");
      return { count: 2 };
    });
    asMock(prisma.project.delete).mockImplementation(async () => {
      order.push("project");
      return {};
    });

    await teardownEvalProject(prisma, "proj-1");

    expect(order).toEqual(["audit", "project"]);
    expect(prisma.auditLog.deleteMany).toHaveBeenCalledWith({ where: { projectId: "proj-1" } });
    expect(prisma.project.delete).toHaveBeenCalledWith({ where: { id: "proj-1" } });
  });
});
