import { describe, it, expect, vi, beforeEach } from "vitest";

// One transaction client for the service's reads and writes; the root client
// carries only the audit row, written after the transaction commits.
const { tx, root, listWorkspaceModels } = vi.hoisted(() => ({
  tx: {
    project: { findUnique: vi.fn() },
    workspaceMember: { findUnique: vi.fn() },
    loop: { findFirst: vi.fn(), count: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    loopRun: { findFirst: vi.fn(), aggregate: vi.fn(), create: vi.fn() },
    detector: { create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    $queryRaw: vi.fn(),
  },
  root: { auditLog: { create: vi.fn() } },
  listWorkspaceModels: vi.fn(),
}));
vi.mock("@traceroot/core", async (importOriginal) => {
  const { detectorModelProblem } = await importOriginal<typeof import("@traceroot/core")>();
  return {
    prisma: { $transaction: (fn: (t: unknown) => unknown) => fn(tx), auditLog: root.auditLog },
    Role: { VIEWER: "VIEWER", MEMBER: "MEMBER", ADMIN: "ADMIN" },
    hasMinRole: (userRole: string, minRole: string) =>
      ["VIEWER", "MEMBER", "ADMIN"].indexOf(userRole) >=
      ["VIEWER", "MEMBER", "ADMIN"].indexOf(minRole),
    detectorModelProblem,
    listWorkspaceModels,
  };
});
import { createLoop, deleteLoop, requestLoopRun, setLoopStatus, updateLoop } from "./loops";

const provenance = { transport: "ui" as const };
const base = { actorUserId: "u1", projectId: "p1", provenance };
const at = new Date("2026-11-11T10:00:00Z");

function loopRow(over: Record<string, unknown> = {}) {
  return {
    id: "l1",
    projectId: "p1",
    detectorId: "d1",
    name: "Daily review",
    template: null,
    instructions: "look for timeouts",
    templateVersion: null,
    scheduleKind: "daily",
    intervalHours: null,
    weekday: null,
    hour: 9,
    timezone: "UTC",
    status: "active",
    pauseReason: null,
    statusChangedAt: at,
    statusChangedBy: null,
    dryRun: false,
    precheckSql: null,
    lastPrecheckAt: null,
    lastPrecheckOutcome: null,
    model: null,
    provider: null,
    source: null,
    maxFindingsPerRun: 2,
    lookbackHours: 24,
    nextRunAt: at,
    lastRunAt: null,
    failureStreak: 3,
    createdBy: "u1",
    createTime: at,
    updateTime: at,
    ...over,
  };
}

function mockAccess(role = "MEMBER") {
  tx.project.findUnique.mockResolvedValue({ workspaceId: "w1", deleteTime: null });
  tx.workspaceMember.findUnique.mockResolvedValue({ role });
}

const newLoop = {
  name: "Daily review",
  instructions: "look for timeouts",
  schedule: { kind: "daily" as const, hour: 9, timezone: "UTC" },
};

beforeEach(() => {
  vi.resetAllMocks();
  mockAccess();
  tx.loop.count.mockResolvedValue(0);
  tx.detector.create.mockResolvedValue({ id: "d1" });
  tx.loop.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
    loopRow({ ...data, id: "l1" }),
  );
  root.auditLog.create.mockResolvedValue({});
  listWorkspaceModels.mockResolvedValue({ systemModels: [], byokProviders: [] });
});

describe("createLoop", () => {
  it("creates the Loop and its hidden detector together and audits once", async () => {
    const result = await createLoop({ ...base, ...newLoop });
    expect(result).toMatchObject({
      ok: true,
      created: true,
      data: { id: "l1", name: "Daily review" },
    });
    expect(tx.detector.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: "loop:Daily review",
        template: "loop",
        enabled: false,
        enableSignals: true,
        projectId: "p1",
      }),
      select: { id: true },
    });
    expect(tx.loop.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        detectorId: "d1",
        scheduleKind: "daily",
        hour: 9,
        timezone: "UTC",
        dryRun: false,
      }),
    });
    expect(root.auditLog.create).toHaveBeenCalledTimes(1);
    expect(root.auditLog.create.mock.calls[0][0].data).toMatchObject({
      operation: "create_loop",
      resourceType: "loop",
      resourceId: "l1",
      transport: "ui",
    });
  });

  it("takes the template's version and lookback when a template is chosen", async () => {
    await createLoop({ ...base, name: "T", template: "coding-agents", schedule: newLoop.schedule });
    expect(tx.loop.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        template: "coding-agents",
        templateVersion: 1,
        instructions: "",
        lookbackHours: 24,
      }),
    });
  });

  it("hides a project the actor cannot see and refuses a viewer", async () => {
    tx.workspaceMember.findUnique.mockResolvedValueOnce(null);
    expect(await createLoop({ ...base, ...newLoop })).toEqual({
      ok: false,
      status: 404,
      error: "Project not found",
    });
    mockAccess("VIEWER");
    expect(await createLoop({ ...base, ...newLoop })).toMatchObject({ ok: false, status: 403 });
    expect(tx.loop.create).not.toHaveBeenCalled();
  });

  it("answers 400 with the first problem of an invalid body", async () => {
    const result = await createLoop({ ...base, name: "x", schedule: newLoop.schedule });
    expect(result).toEqual({
      ok: false,
      status: 400,
      error: "instructions are required unless a template is chosen",
    });
    expect(tx.loop.create).not.toHaveBeenCalled();
  });

  it("refuses a sixth Loop in the project", async () => {
    tx.loop.count.mockResolvedValue(5);
    expect(await createLoop({ ...base, ...newLoop })).toEqual({
      ok: false,
      status: 409,
      error: "A project can have at most 5 Loops",
    });
  });

  it("checks a BYOK provider against the workspace's models", async () => {
    const result = await createLoop({
      ...base,
      ...newLoop,
      source: "byok",
      provider: "gone",
      model: "m",
    });
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(listWorkspaceModels).toHaveBeenCalledWith("w1", { db: tx });
    expect(tx.loop.create).not.toHaveBeenCalled();
  });

  it("does not read the workspace's models for the default model choice", async () => {
    await createLoop({ ...base, ...newLoop });
    expect(listWorkspaceModels).not.toHaveBeenCalled();
  });

  it("answers 409 when the name is taken", async () => {
    tx.loop.create.mockRejectedValueOnce(
      Object.assign(new Error("dup"), { code: "P2002", name: "PrismaClientKnownRequestError" }),
    );
    const result = await createLoop({ ...base, ...newLoop });
    expect(result).toEqual({
      ok: false,
      status: 409,
      error: "A Loop with this name already exists",
    });
  });
});

describe("updateLoop", () => {
  beforeEach(() => {
    tx.loop.findFirst.mockResolvedValue(loopRow());
    tx.loop.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      loopRow(data),
    );
  });

  it("writes nothing and audits nothing when the patch changes nothing", async () => {
    const result = await updateLoop({
      ...base,
      loopId: "l1",
      patch: { dryRun: false, name: "Daily review" },
      provenance,
    });
    expect(result).toMatchObject({ ok: true, changed: [] });
    expect(tx.loop.update).not.toHaveBeenCalled();
    expect(root.auditLog.create).not.toHaveBeenCalled();
  });

  it("rejects an empty patch and a missing Loop", async () => {
    expect(await updateLoop({ ...base, loopId: "l1", patch: {}, provenance })).toMatchObject({
      ok: false,
      status: 400,
    });
    tx.loop.findFirst.mockResolvedValueOnce(null);
    expect(
      await updateLoop({ ...base, loopId: "nope", patch: { dryRun: true }, provenance }),
    ).toEqual({
      ok: false,
      status: 404,
      error: "Loop not found",
    });
  });

  it("recomputes the next run when the schedule changes", async () => {
    const result = await updateLoop({
      ...base,
      loopId: "l1",
      patch: { schedule: { kind: "interval", intervalHours: 6 } },
      provenance,
    });
    expect(result).toMatchObject({ ok: true, changed: ["schedule"] });
    const data = tx.loop.update.mock.calls[0][0].data;
    expect(data).toMatchObject({
      scheduleKind: "interval",
      intervalHours: 6,
      hour: null,
      timezone: null,
    });
    expect(data.nextRunAt).toBeInstanceOf(Date);
  });

  it("renames the hidden detector with the Loop", async () => {
    tx.loop.update.mockResolvedValueOnce(loopRow({ name: "Weekly review" }));
    await updateLoop({ ...base, loopId: "l1", patch: { name: "Weekly review" }, provenance });
    expect(tx.detector.update).toHaveBeenCalledWith({
      where: { id: "d1" },
      data: { name: "loop:Weekly review" },
    });
  });

  it("will not clear the template of a Loop that has no instructions of its own", async () => {
    tx.loop.findFirst.mockResolvedValue(loopRow({ template: "coding-agents", instructions: "" }));
    expect(
      await updateLoop({ ...base, loopId: "l1", patch: { template: null }, provenance }),
    ).toEqual({
      ok: false,
      status: 400,
      error: "instructions are required unless a template is chosen",
    });
  });

  it("clears the model fields when the patch sends them empty", async () => {
    tx.loop.findFirst.mockResolvedValue(loopRow({ model: "m", provider: "p", source: "byok" }));
    await updateLoop({
      ...base,
      loopId: "l1",
      patch: { model: "", provider: null, source: null },
      provenance,
    });
    expect(tx.loop.update.mock.calls[0][0].data).toMatchObject({
      model: null,
      provider: null,
      source: null,
    });
  });
});

describe("setLoopStatus", () => {
  it("pauses an active Loop as the actor and leaves the schedule alone", async () => {
    tx.loop.findFirst.mockResolvedValue(loopRow());
    tx.loop.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      loopRow(data),
    );
    const result = await setLoopStatus({ ...base, loopId: "l1", action: "pause" });
    expect(result).toMatchObject({
      ok: true,
      changed: ["status"],
      data: { status: "paused", statusChangedBy: "u1" },
    });
    expect(tx.loop.update.mock.calls[0][0].data).not.toHaveProperty("nextRunAt");
  });

  it("resumes: clears the streak and the system's reason, and counts the next run from now", async () => {
    tx.loop.findFirst.mockResolvedValue(
      loopRow({ status: "paused_by_system", pauseReason: "failures", failureStreak: 5 }),
    );
    tx.loop.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      loopRow(data),
    );
    const result = await setLoopStatus({ ...base, loopId: "l1", action: "resume" });
    expect(result).toMatchObject({
      ok: true,
      data: { status: "active", pauseReason: null, failureStreak: 0 },
    });
    expect(tx.loop.update.mock.calls[0][0].data.nextRunAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("is a no-op when the Loop is already in the target state", async () => {
    tx.loop.findFirst.mockResolvedValue(loopRow({ status: "paused" }));
    expect(await setLoopStatus({ ...base, loopId: "l1", action: "pause" })).toMatchObject({
      ok: true,
      changed: [],
    });
    expect(tx.loop.update).not.toHaveBeenCalled();
  });
});

describe("deleteLoop", () => {
  it("requires a reason", async () => {
    expect(await deleteLoop({ ...base, loopId: "l1", reason: "x" })).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(tx.loop.delete).not.toHaveBeenCalled();
  });

  it("deletes the Loop before its detector, then audits", async () => {
    tx.loop.findFirst.mockResolvedValue(loopRow());
    const order: string[] = [];
    tx.loop.delete.mockImplementation(async () => order.push("loop"));
    tx.detector.delete.mockImplementation(async () => order.push("detector"));
    const result = await deleteLoop({ ...base, loopId: "l1", reason: "No longer needed" });
    expect(result).toMatchObject({ ok: true, data: { id: "l1", name: "Daily review" } });
    expect(order).toEqual(["loop", "detector"]);
    expect(root.auditLog.create.mock.calls[0][0].data).toMatchObject({ operation: "delete_loop" });
  });
});

describe("requestLoopRun", () => {
  beforeEach(() => {
    tx.loop.findFirst.mockResolvedValue({ id: "l1", name: "Daily review" });
    tx.loopRun.aggregate.mockResolvedValue({ _max: { seq: 2 } });
    tx.loopRun.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "r3",
      ...data,
      createTime: at,
      attempts: 1,
      findingKeys: [],
      tracesRead: 0,
      costUsd: null,
    }));
  });

  it("inserts a pending manual run with the next sequence number", async () => {
    tx.loopRun.findFirst.mockResolvedValue(null);
    const result = await requestLoopRun({ ...base, loopId: "l1" });
    expect(result).toMatchObject({
      ok: true,
      data: { id: "r3", seq: 3, status: "pending", trigger: "manual" },
    });
    expect(root.auditLog.create.mock.calls[0][0].data).toMatchObject({ operation: "run_loop" });
  });

  it("refuses while a run is pending or running", async () => {
    tx.loopRun.findFirst.mockResolvedValue({ id: "r2" });
    expect(await requestLoopRun({ ...base, loopId: "l1" })).toEqual({
      ok: false,
      status: 409,
      error: "This Loop already has a run in progress",
    });
    expect(tx.loopRun.create).not.toHaveBeenCalled();
  });

  it("answers 404 for another project's Loop", async () => {
    tx.loop.findFirst.mockResolvedValue(null);
    expect(await requestLoopRun({ ...base, loopId: "l9" })).toMatchObject({
      ok: false,
      status: 404,
    });
  });
});
