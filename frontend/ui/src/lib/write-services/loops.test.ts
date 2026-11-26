import { describe, it, expect, vi, beforeEach } from "vitest";

// One transaction client for the service's reads and writes; the root client
// carries only the audit row, written after the transaction commits.
const { tx, root, listWorkspaceModels, billing } = vi.hoisted(() => ({
  tx: {
    project: { findUnique: vi.fn() },
    workspaceMember: { findUnique: vi.fn() },
    loop: { findFirst: vi.fn(), count: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    loopRun: { findFirst: vi.fn(), aggregate: vi.fn(), create: vi.fn() },
    detector: { create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    $queryRaw: vi.fn(),
  },
  root: { auditLog: { create: vi.fn() }, loop: { findFirst: vi.fn() } },
  listWorkspaceModels: vi.fn(),
  billing: { enabled: true },
}));
vi.mock("@traceroot/core", async (importOriginal) => {
  const { detectorModelProblem } = await importOriginal<typeof import("@traceroot/core")>();
  return {
    prisma: {
      $transaction: (fn: (t: unknown) => unknown) => fn(tx),
      auditLog: root.auditLog,
      loop: root.loop,
    },
    Role: { VIEWER: "VIEWER", MEMBER: "MEMBER", ADMIN: "ADMIN" },
    hasMinRole: (userRole: string, minRole: string) =>
      ["VIEWER", "MEMBER", "ADMIN"].indexOf(userRole) >=
      ["VIEWER", "MEMBER", "ADMIN"].indexOf(minRole),
    PlanType: { FREE: "free", STARTER: "starter", PRO: "pro" },
    isBillingEnabled: () => billing.enabled,
    detectorModelProblem,
    listWorkspaceModels,
  };
});
import { createLoop, deleteLoop, requestLoopRun, setLoopStatus, updateLoop } from "./loops";
import {
  LOOP_INSTRUCTIONS_REQUIRED,
  LOOP_NAME_TAKEN,
  LOOP_NAME_TAKEN_BY_DETECTOR,
  LOOP_RUN_IN_PROGRESS,
  LOOP_RUN_PAUSED,
  LOOP_RUN_PLAN_BLOCKED,
} from "@traceroot/core/loops/pure";

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
    scheduleKind: "daily",
    intervalHours: null,
    weekday: null,
    hour: 9,
    timezone: "UTC",
    status: "active",
    dryRun: false,
    model: null,
    provider: null,
    source: null,
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

/** A duck-typed Prisma unique violation on `target`. */
const p2002 = (target: string | string[]) =>
  Object.assign(new Error("dup"), { code: "P2002", meta: { target } });

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
  billing.enabled = true;
  listWorkspaceModels.mockResolvedValue({ systemModels: [], byokProviders: [] });
});

describe("createLoop", () => {
  it("creates the Loop and its hidden detector together and audits once", async () => {
    const result = await createLoop({ ...base, body: newLoop });
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
        enableRca: false,
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

  it("takes the template's lookback when a template is chosen", async () => {
    await createLoop({
      ...base,
      body: {
        name: "T",
        template: "coding-agents",
        instructions: "the template's prompt",
        schedule: newLoop.schedule,
      },
    });
    expect(tx.loop.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        template: "coding-agents",
        instructions: "the template's prompt",
        lookbackHours: 24,
      }),
    });
  });

  it("hides a project the actor cannot see and refuses a viewer", async () => {
    tx.workspaceMember.findUnique.mockResolvedValueOnce(null);
    expect(await createLoop({ ...base, body: newLoop })).toEqual({
      ok: false,
      status: 404,
      error: "Project not found",
    });
    mockAccess("VIEWER");
    expect(await createLoop({ ...base, body: newLoop })).toMatchObject({ ok: false, status: 403 });
    expect(tx.loop.create).not.toHaveBeenCalled();
  });

  it("answers 400 with the first problem of an invalid body", async () => {
    // A route body is untyped JSON: one may leave the instructions out.
    const result = await createLoop({ ...base, body: { name: "x", schedule: newLoop.schedule } });
    expect(result).toEqual({ ok: false, status: 400, error: LOOP_INSTRUCTIONS_REQUIRED });
    expect(tx.loop.create).not.toHaveBeenCalled();
  });

  it("refuses a templated Loop with blank instructions", async () => {
    const result = await createLoop({
      ...base,
      body: {
        name: "T",
        template: "coding-agents",
        instructions: "  ",
        schedule: newLoop.schedule,
      },
    });
    expect(result).toEqual({ ok: false, status: 400, error: LOOP_INSTRUCTIONS_REQUIRED });
    expect(tx.loop.create).not.toHaveBeenCalled();
  });

  it("refuses a sixth Loop in the project", async () => {
    tx.loop.count.mockResolvedValue(5);
    expect(await createLoop({ ...base, body: newLoop })).toEqual({
      ok: false,
      status: 409,
      error: "A project can have at most 5 loops",
    });
  });

  it("checks a BYOK provider against the workspace's models", async () => {
    const result = await createLoop({
      ...base,
      body: { ...newLoop, source: "byok", provider: "gone", model: "m" },
    });
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(listWorkspaceModels).toHaveBeenCalledWith("w1", { db: tx });
    expect(tx.loop.create).not.toHaveBeenCalled();
  });

  it("does not read the workspace's models for the default model choice", async () => {
    await createLoop({ ...base, body: newLoop });
    expect(listWorkspaceModels).not.toHaveBeenCalled();
  });

  it("answers 409 when the name is taken, whichever name index tripped", async () => {
    // The hidden detector is created first, so a taken Loop name usually trips its index.
    tx.detector.create.mockRejectedValueOnce(p2002(["project_id", "name"]));
    root.loop.findFirst.mockResolvedValueOnce({ id: "l0" });
    expect(await createLoop({ ...base, body: newLoop })).toEqual({
      ok: false,
      status: 409,
      error: LOOP_NAME_TAKEN,
    });
    expect(root.loop.findFirst).toHaveBeenCalledWith({
      where: { projectId: "p1", name: "Daily review" },
      select: { id: true },
    });
  });

  it("names the user detector holding the hidden detector's name, not a taken Loop name", async () => {
    tx.detector.create.mockRejectedValueOnce(p2002("uq_detector_project_name"));
    root.loop.findFirst.mockResolvedValueOnce(null);
    expect(await createLoop({ ...base, body: newLoop })).toEqual({
      ok: false,
      status: 409,
      error: LOOP_NAME_TAKEN_BY_DETECTOR,
    });
  });

  it("rethrows a P2002 on an index other than a name", async () => {
    tx.loop.create.mockRejectedValueOnce(p2002("uq_loop_detector"));
    await expect(createLoop({ ...base, body: newLoop })).rejects.toThrow("dup");
    expect(root.loop.findFirst).not.toHaveBeenCalled();
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

  it("answers a rename onto a taken name with 409", async () => {
    tx.loop.update.mockRejectedValueOnce(p2002("uq_loop_project_name"));
    root.loop.findFirst.mockResolvedValueOnce({ id: "l2" });
    expect(
      await updateLoop({ ...base, loopId: "l1", patch: { name: "Weekly review" }, provenance }),
    ).toEqual({ ok: false, status: 409, error: LOOP_NAME_TAKEN });
    expect(root.loop.findFirst).toHaveBeenCalledWith({
      where: { projectId: "p1", name: "Weekly review" },
      select: { id: true },
    });
  });

  it("renames the hidden detector with the Loop", async () => {
    tx.loop.update.mockResolvedValueOnce(loopRow({ name: "Weekly review" }));
    await updateLoop({ ...base, loopId: "l1", patch: { name: "Weekly review" }, provenance });
    expect(tx.detector.update).toHaveBeenCalledWith({
      where: { id: "d1" },
      data: { name: "loop:Weekly review" },
    });
  });

  it("will not blank a templated Loop's instructions", async () => {
    tx.loop.findFirst.mockResolvedValue(loopRow({ template: "coding-agents" }));
    expect(
      await updateLoop({ ...base, loopId: "l1", patch: { instructions: "" }, provenance }),
    ).toEqual({ ok: false, status: 400, error: LOOP_INSTRUCTIONS_REQUIRED });
    expect(tx.loop.update).not.toHaveBeenCalled();
  });

  it("checks a provider-only change against the workspace's models", async () => {
    tx.loop.findFirst.mockResolvedValue(loopRow({ model: "m", provider: "mine", source: "byok" }));
    listWorkspaceModels.mockResolvedValue({
      systemModels: [],
      byokProviders: [{ provider: "mine", models: [{ id: "m" }] }],
    });
    expect(
      await updateLoop({ ...base, loopId: "l1", patch: { provider: "gone" }, provenance }),
    ).toMatchObject({ ok: false, status: 400, error: expect.stringContaining('"gone"') });
    expect(tx.loop.update).not.toHaveBeenCalled();
  });

  it("refuses moving a BYOK model to the system source", async () => {
    tx.loop.findFirst.mockResolvedValue(loopRow({ model: "m", provider: "mine", source: "byok" }));
    expect(
      await updateLoop({ ...base, loopId: "l1", patch: { source: "system" }, provenance }),
    ).toMatchObject({
      ok: false,
      status: 400,
      error: expect.stringContaining("not a system model"),
    });
    expect(tx.loop.update).not.toHaveBeenCalled();
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
  it("pauses an active Loop, audits who paused it, and leaves the schedule alone", async () => {
    tx.loop.findFirst.mockResolvedValue(loopRow());
    tx.loop.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      loopRow(data),
    );
    const result = await setLoopStatus({ ...base, loopId: "l1", action: "pause" });
    expect(result).toMatchObject({
      ok: true,
      changed: ["status"],
      data: { status: "paused" },
    });
    expect(tx.loop.update.mock.calls[0][0].data).not.toHaveProperty("nextRunAt");
    expect(root.auditLog.create.mock.calls[0][0].data).toMatchObject({
      actorUserId: "u1",
      operation: "pause_loop",
    });
  });

  it("resumes: clears the streak and counts the next run from now", async () => {
    tx.loop.findFirst.mockResolvedValue(loopRow({ status: "paused_by_system", failureStreak: 5 }));
    tx.loop.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      loopRow(data),
    );
    const result = await setLoopStatus({ ...base, loopId: "l1", action: "resume" });
    expect(result).toMatchObject({
      ok: true,
      data: { status: "active", failureStreak: 0 },
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

  it("deletes the Loop, keeps its detector under a name of its own, then audits", async () => {
    tx.loop.findFirst.mockResolvedValue(loopRow());
    const result = await deleteLoop({ ...base, loopId: "l1", reason: "No longer needed" });
    expect(result).toMatchObject({ ok: true, data: { id: "l1", name: "Daily review" } });
    expect(tx.loop.delete).toHaveBeenCalledWith({ where: { id: "l1" } });
    expect(tx.detector.delete).not.toHaveBeenCalled();
    expect(tx.detector.update).toHaveBeenCalledWith({
      where: { id: "d1" },
      data: { name: "loop:deleted:d1" },
    });
    expect(root.auditLog.create.mock.calls[0][0].data).toMatchObject({ operation: "delete_loop" });
  });
});

describe("requestLoopRun", () => {
  beforeEach(() => {
    tx.project.findUnique.mockResolvedValue({
      workspaceId: "w1",
      deleteTime: null,
      workspace: { loopBlocked: false, billingPlan: "free" },
    });
    tx.$queryRaw.mockResolvedValue([{ id: "l1", name: "Daily review", status: "active" }]);
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
      error: LOOP_RUN_IN_PROGRESS,
    });
    expect(tx.loopRun.create).not.toHaveBeenCalled();
  });

  it("refuses a paused Loop, by a person or by the system", async () => {
    for (const status of ["paused", "paused_by_system"]) {
      tx.$queryRaw.mockResolvedValue([{ id: "l1", name: "Daily review", status }]);
      expect(await requestLoopRun({ ...base, loopId: "l1" })).toEqual({
        ok: false,
        status: 409,
        error: LOOP_RUN_PAUSED,
      });
    }
    expect(tx.loopRun.create).not.toHaveBeenCalled();
    expect(root.auditLog.create).not.toHaveBeenCalled();
  });

  const blockedOn = (billingPlan: string) =>
    tx.project.findUnique.mockResolvedValue({
      workspaceId: "w1",
      deleteTime: null,
      workspace: { loopBlocked: true, billingPlan },
    });

  it("refuses when a Free workspace has used its plan's loop runs", async () => {
    blockedOn("free");
    expect(await requestLoopRun({ ...base, loopId: "l1" })).toEqual({
      ok: false,
      status: 409,
      error: LOOP_RUN_PLAN_BLOCKED,
    });
    expect(tx.project.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        include: { workspace: { select: { loopBlocked: true, billingPlan: true } } },
      }),
    );
    expect(tx.loopRun.create).not.toHaveBeenCalled();
  });

  it.each(["starter", "pro"])("runs on a %s plan even with the flag still set", async (plan) => {
    blockedOn(plan);
    tx.loopRun.findFirst.mockResolvedValue(null);
    expect(await requestLoopRun({ ...base, loopId: "l1" })).toMatchObject({
      ok: true,
      data: { status: "pending", trigger: "manual" },
    });
  });

  it("runs on Free with the flag set when billing is off", async () => {
    billing.enabled = false;
    blockedOn("free");
    tx.loopRun.findFirst.mockResolvedValue(null);
    expect(await requestLoopRun({ ...base, loopId: "l1" })).toMatchObject({ ok: true });
  });

  it("answers 404 for another project's Loop, or one deleted before the lock", async () => {
    tx.$queryRaw.mockResolvedValue([]);
    expect(await requestLoopRun({ ...base, loopId: "l9" })).toMatchObject({
      ok: false,
      status: 404,
    });
    expect(tx.loopRun.create).not.toHaveBeenCalled();
  });
});

/** A duck-typed Prisma "record to update/delete not found". */
const p2025 = () => Object.assign(new Error("gone"), { code: "P2025" });
const LOOP_NOT_FOUND = { ok: false, status: 404, error: "Loop not found" };

describe("a Loop deleted mid-write, and other write failures", () => {
  beforeEach(() => {
    tx.loop.findFirst.mockResolvedValue(loopRow());
  });

  it("updateLoop answers 404 when the row is gone, and rethrows anything else", async () => {
    const call = () => updateLoop({ ...base, loopId: "l1", patch: { dryRun: true }, provenance });
    tx.loop.update.mockRejectedValueOnce(p2025());
    expect(await call()).toEqual(LOOP_NOT_FOUND);
    tx.loop.update.mockRejectedValueOnce(new Error("connection lost"));
    await expect(call()).rejects.toThrow("connection lost");
    // A name collision without a rename is not a 409.
    tx.loop.update.mockRejectedValueOnce(p2002("uq_loop_project_name"));
    await expect(call()).rejects.toThrow("dup");
    expect(root.auditLog.create).not.toHaveBeenCalled();
  });

  it("setLoopStatus answers 404 when the row is gone, and rethrows anything else", async () => {
    tx.loop.update.mockRejectedValueOnce(p2025());
    expect(await setLoopStatus({ ...base, loopId: "l1", action: "pause" })).toEqual(LOOP_NOT_FOUND);
    tx.loop.update.mockRejectedValueOnce(new Error("connection lost"));
    await expect(setLoopStatus({ ...base, loopId: "l1", action: "pause" })).rejects.toThrow(
      "connection lost",
    );
    expect(root.auditLog.create).not.toHaveBeenCalled();
  });

  it("deleteLoop answers 404 when the row is gone, and rethrows anything else", async () => {
    const call = () => deleteLoop({ ...base, loopId: "l1", reason: "No longer needed" });
    tx.loop.delete.mockRejectedValueOnce(p2025());
    expect(await call()).toEqual(LOOP_NOT_FOUND);
    tx.loop.delete.mockRejectedValueOnce(new Error("connection lost"));
    await expect(call()).rejects.toThrow("connection lost");
    expect(root.auditLog.create).not.toHaveBeenCalled();
  });

  it("requestLoopRun answers 404 when the row is gone, and rethrows anything else", async () => {
    tx.project.findUnique.mockResolvedValue({
      workspaceId: "w1",
      deleteTime: null,
      workspace: { loopBlocked: false, billingPlan: "free" },
    });
    tx.$queryRaw.mockResolvedValue([{ id: "l1", name: "Daily review", status: "active" }]);
    tx.loopRun.findFirst.mockResolvedValue(null);
    tx.loopRun.aggregate.mockResolvedValue({ _max: { seq: 2 } });
    tx.loopRun.create.mockRejectedValueOnce(p2025());
    expect(await requestLoopRun({ ...base, loopId: "l1" })).toEqual(LOOP_NOT_FOUND);
    tx.loopRun.create.mockRejectedValueOnce(new Error("connection lost"));
    await expect(requestLoopRun({ ...base, loopId: "l1" })).rejects.toThrow("connection lost");
    expect(root.auditLog.create).not.toHaveBeenCalled();
  });
});

describe("updateLoop's template and model fields", () => {
  beforeEach(() => {
    tx.loop.findFirst.mockResolvedValue(loopRow());
    tx.loop.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      loopRow(data),
    );
  });

  it("sets and clears the template", async () => {
    const template = "coding-agents";
    expect(
      await updateLoop({ ...base, loopId: "l1", patch: { template }, provenance }),
    ).toMatchObject({ ok: true, changed: ["template"] });
    expect(tx.loop.update.mock.calls[0][0].data).toMatchObject({ template });

    tx.loop.findFirst.mockResolvedValue(loopRow({ template }));
    await updateLoop({ ...base, loopId: "l1", patch: { template: null }, provenance });
    expect(tx.loop.update.mock.calls[1][0].data).toMatchObject({ template: null });
  });

  it("takes the system source with the default model", async () => {
    expect(
      await updateLoop({ ...base, loopId: "l1", patch: { source: "system" }, provenance }),
    ).toMatchObject({ ok: true, changed: ["source"] });
    expect(tx.loop.update.mock.calls[0][0].data).toMatchObject({ source: "system" });
  });
});
