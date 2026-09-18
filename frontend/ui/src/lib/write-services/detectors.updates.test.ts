import { describe, it, expect, vi, beforeEach } from "vitest";
import { DELETE_REASON_MESSAGE, NO_FIELDS_MESSAGE } from "./update-support";

// The transaction client and the root client carry separate auditLog mocks so
// the tests can tell which one the audit row was written through.
const { tx, root, order } = vi.hoisted(() => ({
  tx: {
    project: { findUnique: vi.fn() },
    workspaceMember: { findUnique: vi.fn() },
    detector: { findFirst: vi.fn(), update: vi.fn(), delete: vi.fn() },
    auditLog: { create: vi.fn() },
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
import { deleteDetector, updateDetector } from "./detectors";

const storedDetector = {
  id: "d1",
  projectId: "p1",
  name: "Latency spike",
  template: "custom",
  prompt: "Find traces with slow spans",
  outputSchema: [{ name: "severity", type: "string" }],
  sampleRate: 25,
  enabled: true,
  enableRca: true,
  detectionModel: "claude-sonnet-5",
  detectionProvider: "anthropic",
  detectionSource: "system",
  trigger: {
    id: "t1",
    detectorId: "d1",
    conditions: [{ field: "environment", op: "=", value: "prod" }],
  },
};

const provenance = { transport: "public-api" as const };

function mockAccess(role = "MEMBER") {
  tx.project.findUnique.mockResolvedValue({ workspaceId: "w1", deleteTime: null });
  tx.workspaceMember.findUnique.mockResolvedValue({ role });
}

function runUpdate(patch: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return updateDetector({
    actorUserId: "u1",
    projectId: "p1",
    detectorId: "d1",
    patch,
    provenance,
    ...overrides,
  } as Parameters<typeof updateDetector>[0]);
}

function runDelete(overrides: Record<string, unknown> = {}) {
  return deleteDetector({
    actorUserId: "u1",
    projectId: "p1",
    detectorId: "d1",
    reason: "superseded by the timeout trigger",
    provenance,
    ...overrides,
  } as Parameters<typeof deleteDetector>[0]);
}

/** A duck-typed Prisma error naming the violated constraint, as the handlers match it. */
const prismaError = (code: string, target?: unknown) =>
  Object.assign(new Error(`prisma ${code}`), { code, meta: { target } });

beforeEach(() => {
  order.length = 0;
  for (const model of [tx.project, tx.workspaceMember, tx.detector, tx.auditLog]) {
    for (const fn of Object.values(model)) fn.mockReset();
  }
  tx.detector.findFirst.mockResolvedValue(storedDetector);
  tx.detector.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    order.push("update");
    const { trigger: _trigger, ...fields } = data;
    return { ...storedDetector, ...fields };
  });
  tx.detector.delete.mockImplementation(async () => {
    order.push("delete");
    return storedDetector;
  });
  root.auditLog.create.mockReset();
  root.auditLog.create.mockImplementation(async () => {
    order.push("audit");
    return {};
  });
});

describe("updateDetector", () => {
  it("returns 404 for a missing project, the same 404 for a non-member, and 403 for a VIEWER", async () => {
    tx.project.findUnique.mockResolvedValue(null);
    expect(await runUpdate({ name: "New" })).toEqual({
      ok: false,
      status: 404,
      error: "Project not found",
    });
    tx.project.findUnique.mockResolvedValue({ workspaceId: "w1", deleteTime: null });
    tx.workspaceMember.findUnique.mockResolvedValue(null);
    expect(await runUpdate({ name: "New" })).toEqual({
      ok: false,
      status: 404,
      error: "Project not found",
    });
    mockAccess("VIEWER");
    expect(await runUpdate({ name: "New" })).toEqual({
      ok: false,
      status: 403,
      error: "Requires MEMBER role or higher",
    });
    expect(tx.detector.findFirst).not.toHaveBeenCalled();
  });

  it("rejects an empty patch with 400 before reading the detector", async () => {
    mockAccess();
    expect(await runUpdate({})).toEqual({ ok: false, status: 400, error: NO_FIELDS_MESSAGE });
    expect(tx.detector.findFirst).not.toHaveBeenCalled();
  });

  it("drops template, which is immutable, and then treats the patch as empty", async () => {
    mockAccess();
    expect(await runUpdate({ template: "failure" })).toEqual({
      ok: false,
      status: 400,
      error: NO_FIELDS_MESSAGE,
    });
  });

  it("returns 404 for a detector outside the project", async () => {
    mockAccess();
    tx.detector.findFirst.mockResolvedValue(null);
    expect(await runUpdate({ name: "New" })).toEqual({
      ok: false,
      status: 404,
      error: "Detector not found",
    });
    expect(tx.detector.findFirst).toHaveBeenCalledWith({
      where: { id: "d1", projectId: "p1" },
      include: { trigger: true },
    });
  });

  it.each([
    [{ name: "" }, "name must be a non-empty string"],
    [{ name: "   " }, "name must be a non-empty string"],
    [{ name: null }, "name must be a non-empty string"],
    [{ prompt: "" }, "prompt must be a non-empty string"],
    [{ prompt: null }, "prompt must be a non-empty string"],
    [{ enabled: "false" }, "enabled must be a boolean"],
    [{ enabled: null }, "enabled must be a boolean"],
    [{ enableRca: 1 }, "enableRca must be a boolean"],
    [{ sampleRate: 101 }, "sampleRate must be an integer between 0 and 100"],
    [{ sampleRate: 2.5 }, "sampleRate must be an integer between 0 and 100"],
    [{ sampleRate: null }, "sampleRate must be an integer between 0 and 100"],
    [{ outputSchema: {} }, "outputSchema must be an array"],
    [{ outputSchema: null }, "outputSchema must be an array"],
    [{ detectionSource: "other" }, 'detectionSource must be "system" or "byok"'],
    [{ detectionModel: 5 }, "detectionModel must be a string"],
  ])("rejects %j with the cookie route's message", async (patch, error) => {
    mockAccess();
    expect(await runUpdate(patch)).toEqual({ ok: false, status: 400, error });
    expect(tx.detector.update).not.toHaveBeenCalled();
  });

  it("validates trigger conditions against the registry, naming the reason", async () => {
    mockAccess();
    const r = await runUpdate({
      triggerConditions: [{ field: "cost", op: "contains", value: "1" }],
    });
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect((r as { error: string }).error).not.toBe(NO_FIELDS_MESSAGE);
    expect(await runUpdate({ triggerConditions: "prod" })).toEqual({
      ok: false,
      status: 400,
      error: "triggerConditions must be an array",
    });
  });

  it("answers a patch equal to the stored row as a no-op: no write, no audit", async () => {
    mockAccess();
    const r = await runUpdate({
      name: "Latency spike",
      sampleRate: 25,
      outputSchema: [{ type: "string", name: "severity" }],
      triggerConditions: [{ field: "environment", op: "=", value: "prod" }],
      detectionSource: "system",
    });
    expect(r).toEqual({ ok: true, data: storedDetector, changed: [] });
    expect(tx.detector.update).not.toHaveBeenCalled();
    expect(root.auditLog.create).not.toHaveBeenCalled();
  });

  it("writes the differing fields, names them in public form, and audits after the commit", async () => {
    mockAccess();
    const r = await runUpdate(
      { name: "Latency spike", sampleRate: 50, enabled: false, enableRca: true },
      { provenance: { transport: "agent", agentSessionId: "as1" } },
    );
    expect(r).toEqual({
      ok: true,
      data: { ...storedDetector, sampleRate: 50, enabled: false },
      changed: ["sample_rate", "enabled"],
    });
    expect(tx.detector.update).toHaveBeenCalledWith({
      where: { id: "d1" },
      data: { sampleRate: 50, enabled: false },
      include: { trigger: true },
    });
    expect(order).toEqual(["update", "commit", "audit"]);
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(root.auditLog.create).toHaveBeenCalledWith({
      data: {
        actorUserId: "u1",
        operation: "update_detector",
        resourceType: "detector",
        resourceId: "d1",
        workspaceId: "w1",
        projectId: "p1",
        summary: { changed: ["sample_rate", "enabled"] },
        transport: "agent",
        agentSessionId: "as1",
      },
    });
  });

  it("clears the detection fields on null and on an empty string, matching the cookie route", async () => {
    mockAccess();
    const r = await runUpdate({ detectionModel: null, detectionProvider: "", detectionSource: "" });
    expect(r).toMatchObject({
      ok: true,
      changed: ["detection_model", "detection_provider", "detection_source"],
    });
    expect(tx.detector.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { detectionModel: null, detectionProvider: null, detectionSource: null },
      }),
    );
  });

  it("switches the detection source to byok", async () => {
    mockAccess();
    expect(await runUpdate({ detectionSource: "byok" })).toMatchObject({
      ok: true,
      changed: ["detection_source"],
    });
  });

  it("replaces the trigger through the nested relation and removes it on an empty array", async () => {
    mockAccess();
    const conditions = [{ field: "environment", op: "!=", value: "prod" }];
    expect(await runUpdate({ triggerConditions: conditions })).toMatchObject({
      ok: true,
      changed: ["trigger_conditions"],
    });
    expect(tx.detector.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { trigger: { upsert: { create: { conditions }, update: { conditions } } } },
      }),
    );

    expect(await runUpdate({ triggerConditions: [] })).toMatchObject({
      ok: true,
      changed: ["trigger_conditions"],
    });
    expect(tx.detector.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { trigger: { delete: true } } }),
    );
  });

  it("treats an empty array on a detector with no trigger as unchanged", async () => {
    mockAccess();
    tx.detector.findFirst.mockResolvedValue({ ...storedDetector, trigger: null });
    expect(await runUpdate({ triggerConditions: [] })).toMatchObject({ ok: true, changed: [] });
    expect(tx.detector.update).not.toHaveBeenCalled();
  });

  it("maps a rename collision on the name index to 409 and rethrows a P2002 on another constraint", async () => {
    mockAccess();
    tx.detector.update.mockRejectedValueOnce(prismaError("P2002", "uq_detector_project_name"));
    expect(await runUpdate({ name: "Taken" })).toEqual({
      ok: false,
      status: 409,
      error: "A detector with this name already exists",
    });
    tx.detector.update.mockRejectedValueOnce(prismaError("P2002", ["projectId", "name"]));
    expect(await runUpdate({ name: "Taken" })).toMatchObject({ status: 409 });
    tx.detector.update.mockRejectedValueOnce(
      prismaError("P2002", "detector_triggers_detector_id_key"),
    );
    await expect(runUpdate({ name: "Taken" })).rejects.toMatchObject({ code: "P2002" });
    expect(root.auditLog.create).not.toHaveBeenCalled();
  });

  it("maps a concurrent delete to 404 and propagates other failures", async () => {
    mockAccess();
    tx.detector.update.mockRejectedValueOnce(prismaError("P2025"));
    expect(await runUpdate({ name: "New" })).toEqual({
      ok: false,
      status: 404,
      error: "Detector not found",
    });
    tx.detector.update.mockRejectedValueOnce(new Error("connection lost"));
    await expect(runUpdate({ name: "New" })).rejects.toThrow("connection lost");
  });
});

describe("deleteDetector", () => {
  it("refuses a missing reason before reading anything", async () => {
    expect(await runDelete({ reason: "" })).toEqual({
      ok: false,
      status: 400,
      error: DELETE_REASON_MESSAGE,
    });
    expect(tx.project.findUnique).not.toHaveBeenCalled();
  });

  it("returns 404 for a missing project, the same 404 for a non-member, and 403 for a VIEWER", async () => {
    tx.project.findUnique.mockResolvedValue(null);
    expect(await runDelete()).toEqual({ ok: false, status: 404, error: "Project not found" });
    tx.project.findUnique.mockResolvedValue({ workspaceId: "w1", deleteTime: null });
    tx.workspaceMember.findUnique.mockResolvedValue(null);
    expect(await runDelete()).toEqual({ ok: false, status: 404, error: "Project not found" });
    mockAccess("VIEWER");
    expect(await runDelete()).toEqual({
      ok: false,
      status: 403,
      error: "Requires MEMBER role or higher",
    });
    expect(tx.detector.delete).not.toHaveBeenCalled();
  });

  it("returns 404 for a detector outside the project", async () => {
    mockAccess();
    tx.detector.findFirst.mockResolvedValue(null);
    expect(await runDelete()).toEqual({ ok: false, status: 404, error: "Detector not found" });
  });

  it("hard-deletes, echoes the reason, and audits it verbatim after the commit", async () => {
    mockAccess();
    expect(await runDelete()).toEqual({
      ok: true,
      data: { id: "d1", name: "Latency spike" },
      reason: "superseded by the timeout trigger",
    });
    expect(tx.detector.delete).toHaveBeenCalledWith({ where: { id: "d1" } });
    expect(order).toEqual(["delete", "commit", "audit"]);
    expect(root.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        operation: "delete_detector",
        resourceType: "detector",
        resourceId: "d1",
        summary: { name: "Latency spike", reason: "superseded by the timeout trigger" },
        transport: "public-api",
      }),
    });
  });

  it("maps a concurrent delete to 404", async () => {
    mockAccess();
    tx.detector.delete.mockRejectedValue(prismaError("P2025"));
    expect(await runDelete()).toEqual({ ok: false, status: 404, error: "Detector not found" });
  });
});
