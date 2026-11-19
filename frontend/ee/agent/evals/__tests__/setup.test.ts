import { describe, expect, it, vi, type Mock } from "vitest";
import {
  createEvalProject,
  EvalConfigError,
  type EvalSeeder,
  requireEvalUserEmail,
  resolveEvalUser,
  teardownEvalProject,
} from "../setup.js";
import type { EvalPrisma } from "../types.js";

/** A seeder that records what it was asked to do, writing nothing. */
function makeSeeder(overrides: Partial<EvalSeeder> = {}): EvalSeeder {
  return {
    seed: vi.fn().mockResolvedValue(undefined),
    unseed: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

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

describe("requireEvalUserEmail", () => {
  it("returns the configured address, trimmed", () => {
    expect(requireEvalUserEmail({ EVAL_USER_EMAIL: "  eval@example.com  " })).toBe(
      "eval@example.com",
    );
  });

  it.each([{}, { EVAL_USER_EMAIL: "" }, { EVAL_USER_EMAIL: "   " }])(
    "refuses to run with no address configured (%j)",
    (env) => {
      // No default: whatever address were baked in would be a real person's
      // account on whichever stack the eval happens to point at.
      expect(() => requireEvalUserEmail(env)).toThrow(EvalConfigError);
      expect(() => requireEvalUserEmail(env)).toThrow(/EVAL_USER_EMAIL/);
    },
  );
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

  it("deletes the project when the dashboard it needs cannot be created", async () => {
    // A half-built fixture is worse than none: the run aborts, teardown never
    // runs, and the orphan project outlives it on a shared stack.
    const prisma = makePrisma({
      dashboard: {
        create: vi.fn().mockRejectedValue(new Error("dashboard insert failed")),
        findMany: vi.fn().mockResolvedValue([]),
      },
    });

    await expect(createEvalProject(prisma, { user, runId: "abc123" })).rejects.toThrow(
      /dashboard insert failed/,
    );
    const created = createdData(prisma.project.create);
    expect(prisma.project.delete).toHaveBeenCalledWith({ where: { id: created.id } });
  });

  it("reports the original failure even when the rollback delete also fails", async () => {
    const prisma = makePrisma({
      dashboard: {
        create: vi.fn().mockRejectedValue(new Error("dashboard insert failed")),
        findMany: vi.fn().mockResolvedValue([]),
      },
      project: {
        create: vi.fn(async (args: { data: { id: string; name: string } }) => ({
          id: args.data.id,
          name: args.data.name,
        })),
        delete: vi.fn().mockRejectedValue(new Error("delete failed")),
      },
    });

    await expect(createEvalProject(prisma, { user, runId: "abc123" })).rejects.toThrow(
      /dashboard insert failed/,
    );
  });

  it("seeds the ClickHouse dataset with the anchor it was given", async () => {
    const prisma = makePrisma();
    const seeder = makeSeeder();
    const anchor = new Date("2026-09-08T16:30:00Z");

    const fixture = await createEvalProject(prisma, { user, runId: "abc123", anchor, seeder });

    expect(seeder.seed).toHaveBeenCalledWith(fixture.projectId, anchor);
    expect(seeder.unseed).not.toHaveBeenCalled();
  });

  it("creates the project unseeded when no seeder is supplied", async () => {
    const prisma = makePrisma();
    await expect(createEvalProject(prisma, { user, runId: "abc123" })).resolves.toMatchObject({
      runId: "abc123",
    });
  });

  it("removes the rows it did write when seeding fails, then the project", async () => {
    // A half-seeded project is the worst outcome: the run aborts before
    // teardown, and its spans outlive the project row that cascades away.
    const prisma = makePrisma();
    const seeder = makeSeeder({ seed: vi.fn().mockRejectedValue(new Error("clickhouse down")) });

    await expect(createEvalProject(prisma, { user, runId: "abc123", seeder })).rejects.toThrow(
      /clickhouse down/,
    );

    const created = createdData(prisma.project.create);
    expect(seeder.unseed).toHaveBeenCalledWith(created.id);
    expect(prisma.project.delete).toHaveBeenCalledWith({ where: { id: created.id } });
  });

  it("reports the seed failure even when the rollback unseed also fails", async () => {
    const prisma = makePrisma();
    const seeder = makeSeeder({
      seed: vi.fn().mockRejectedValue(new Error("clickhouse down")),
      unseed: vi.fn().mockRejectedValue(new Error("unseed failed")),
    });

    await expect(createEvalProject(prisma, { user, runId: "abc123", seeder })).rejects.toThrow(
      /clickhouse down/,
    );
    expect(prisma.project.delete).toHaveBeenCalled();
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

  it("clears the ClickHouse rows first: no cascade reaches another database", async () => {
    const prisma = makePrisma();
    const order: string[] = [];
    const seeder = makeSeeder({
      unseed: vi.fn(async () => {
        order.push("unseed");
      }),
    });
    asMock(prisma.project.delete).mockImplementation(async () => {
      order.push("project");
      return {};
    });

    await teardownEvalProject(prisma, "proj-1", seeder);

    expect(seeder.unseed).toHaveBeenCalledWith("proj-1");
    expect(order).toEqual(["unseed", "project"]);
  });

  it("still deletes the project when the unseed fails, then reports it", async () => {
    // Orphan spans are inert; an orphan project on a shared stack is not.
    const prisma = makePrisma();
    const seeder = makeSeeder({ unseed: vi.fn().mockRejectedValue(new Error("mutation failed")) });

    await expect(teardownEvalProject(prisma, "proj-1", seeder)).rejects.toThrow(/mutation failed/);
    expect(prisma.project.delete).toHaveBeenCalledWith({ where: { id: "proj-1" } });
  });
});
