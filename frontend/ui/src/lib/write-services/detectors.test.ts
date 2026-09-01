import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_DETECTOR_SAMPLE_RATE } from "@/features/detectors/templates";

// The transaction client and the root client carry separate auditLog mocks so
// the tests can tell which one the audit row was written through.
const { tx, root } = vi.hoisted(() => ({
  tx: {
    project: { findUnique: vi.fn() },
    workspaceMember: { findUnique: vi.fn() },
    detector: { findFirst: vi.fn(), create: vi.fn() },
    auditLog: { create: vi.fn() },
  },
  root: { auditLog: { create: vi.fn() } },
}));
vi.mock("@traceroot/core", () => {
  const ROLE_ORDER = ["VIEWER", "MEMBER", "ADMIN"];
  return {
    prisma: {
      $transaction: (fn: (t: unknown) => unknown) => fn(tx),
      auditLog: root.auditLog,
    },
    Role: { VIEWER: "VIEWER", MEMBER: "MEMBER", ADMIN: "ADMIN" },
    hasMinRole: (userRole: string, minRole: string) =>
      ROLE_ORDER.indexOf(userRole) >= ROLE_ORDER.indexOf(minRole),
  };
});
import { createDetector } from "./detectors";

const baseInput = {
  actorUserId: "u1",
  projectId: "p1",
  name: "Latency spike",
  template: "custom",
  prompt: "Find traces with slow spans",
  provenance: { transport: "public-api" as const },
};

function run(overrides: Record<string, unknown> = {}) {
  return createDetector({
    ...baseInput,
    ...overrides,
  } as Parameters<typeof createDetector>[0]);
}

function mockAccess(role = "MEMBER") {
  tx.project.findUnique.mockResolvedValue({ workspaceId: "w1", deleteTime: null });
  tx.workspaceMember.findUnique.mockResolvedValue({ role });
}

const createdRow = {
  id: "d1",
  name: "Latency spike",
  projectId: "p1",
  enabled: true,
  sampleRate: DEFAULT_DETECTOR_SAMPLE_RATE,
};

beforeEach(() => {
  tx.project.findUnique.mockReset();
  tx.workspaceMember.findUnique.mockReset();
  tx.detector.findFirst.mockReset();
  tx.detector.create.mockReset();
  tx.auditLog.create.mockReset();
  tx.auditLog.create.mockResolvedValue({});
  root.auditLog.create.mockReset();
  root.auditLog.create.mockResolvedValue({});
});

describe("createDetector", () => {
  it("returns 404 when the project does not exist", async () => {
    tx.project.findUnique.mockResolvedValue(null);
    const r = await run();
    expect(r).toEqual({ ok: false, status: 404, error: "Project not found" });
    expect(tx.detector.create).not.toHaveBeenCalled();
  });

  it("returns 404 when the project is soft-deleted", async () => {
    tx.project.findUnique.mockResolvedValue({
      workspaceId: "w1",
      deleteTime: new Date(),
    });
    const r = await run();
    expect(r).toEqual({ ok: false, status: 404, error: "Project not found" });
    expect(tx.workspaceMember.findUnique).not.toHaveBeenCalled();
  });

  it("rejects a non-member with 403", async () => {
    tx.project.findUnique.mockResolvedValue({ workspaceId: "w1", deleteTime: null });
    tx.workspaceMember.findUnique.mockResolvedValue(null);
    const r = await run();
    expect(r).toEqual({
      ok: false,
      status: 403,
      error: "Not a member of this workspace",
    });
    expect(tx.detector.create).not.toHaveBeenCalled();
  });

  it("rejects a VIEWER with 403", async () => {
    mockAccess("VIEWER");
    const r = await run();
    expect(r).toEqual({
      ok: false,
      status: 403,
      error: "Requires MEMBER role or higher",
    });
    expect(tx.detector.create).not.toHaveBeenCalled();
  });

  it("rejects a whitespace-only name with 400", async () => {
    mockAccess();
    const r = await run({ name: "   " });
    expect(r).toEqual({
      ok: false,
      status: 400,
      error: "name must be a non-empty string",
    });
  });

  it("rejects an empty template with 400", async () => {
    mockAccess();
    const r = await run({ template: "" });
    expect(r).toEqual({
      ok: false,
      status: 400,
      error: "template must be a non-empty string",
    });
  });

  it("rejects a whitespace-only prompt with 400", async () => {
    mockAccess();
    const r = await run({ prompt: "  " });
    expect(r).toEqual({
      ok: false,
      status: 400,
      error: "prompt must be a non-empty string",
    });
  });

  it.each([-1, 101, 2.5, "50"])("rejects sampleRate=%s with 400", async (rate) => {
    mockAccess();
    const r = await run({ sampleRate: rate });
    expect(r).toEqual({
      ok: false,
      status: 400,
      error: "sampleRate must be an integer between 0 and 100",
    });
  });

  it("rejects a non-array outputSchema with 400", async () => {
    mockAccess();
    const r = await run({ outputSchema: { type: "object" } });
    expect(r).toEqual({
      ok: false,
      status: 400,
      error: "outputSchema must be an array",
    });
  });

  it("surfaces the trigger validator's message for a non-array payload", async () => {
    mockAccess();
    const r = await run({ triggerConditions: "cost > 5" });
    expect(r).toEqual({
      ok: false,
      status: 400,
      error: "triggerConditions must be an array",
    });
  });

  it("surfaces the trigger validator's message for an unknown field", async () => {
    mockAccess();
    const r = await run({
      triggerConditions: [{ field: "nope", op: "=", value: "x" }],
    });
    expect(r).toEqual({
      ok: false,
      status: 400,
      error: "condition 1 has an unknown field",
    });
  });

  it("rejects an invalid detectionSource with 400", async () => {
    mockAccess();
    const r = await run({ detectionSource: "syetm" });
    expect(r).toEqual({
      ok: false,
      status: 400,
      error: 'detectionSource must be "system" or "byok"',
    });
  });

  it("rejects a non-boolean enableRca with 400", async () => {
    mockAccess();
    const r = await run({ enableRca: "yes" });
    expect(r).toEqual({
      ok: false,
      status: 400,
      error: "enableRca must be a boolean",
    });
  });

  it("rejects a non-boolean enabled with 400", async () => {
    mockAccess();
    const r = await run({ enabled: 1 });
    expect(r).toEqual({
      ok: false,
      status: 400,
      error: "enabled must be a boolean",
    });
  });

  it("creates a paused detector when sampleRate is 0 and enabled is omitted", async () => {
    mockAccess();
    tx.detector.findFirst.mockResolvedValue(null);
    tx.detector.create.mockResolvedValue({ ...createdRow, enabled: false, sampleRate: 0 });
    const r = await run({ sampleRate: 0 });
    expect(r.ok).toBe(true);
    expect(tx.detector.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ sampleRate: 0, enabled: false }),
      }),
    );
  });

  it("applies the default sample rate when sampleRate is omitted", async () => {
    mockAccess();
    tx.detector.findFirst.mockResolvedValue(null);
    tx.detector.create.mockResolvedValue(createdRow);
    const r = await run();
    expect(r.ok).toBe(true);
    expect(tx.detector.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sampleRate: DEFAULT_DETECTOR_SAMPLE_RATE,
          enabled: true,
        }),
      }),
    );
  });

  it("returns the existing detector by name, created=false, no create, no audit", async () => {
    mockAccess();
    tx.detector.findFirst.mockResolvedValue(createdRow);
    const r = await run();
    expect(r).toEqual({ ok: true, created: false, data: createdRow });
    expect(tx.detector.findFirst).toHaveBeenCalledWith({
      where: { projectId: "p1", name: "Latency spike" },
      select: { id: true, name: true, projectId: true, enabled: true, sampleRate: true },
    });
    expect(tx.detector.create).not.toHaveBeenCalled();
    expect(root.auditLog.create).not.toHaveBeenCalled();
  });

  it("audits through the root client, not the transaction, so a failed audit cannot roll the detector back", async () => {
    mockAccess();
    tx.detector.findFirst.mockResolvedValue(null);
    tx.detector.create.mockResolvedValue(createdRow);
    root.auditLog.create.mockRejectedValue(new Error("audit store down"));
    const r = await run();
    expect(r).toEqual({ ok: true, created: true, data: createdRow });
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(root.auditLog.create).toHaveBeenCalled();
  });

  it("creates the detector without a nested trigger when conditions are absent", async () => {
    mockAccess();
    tx.detector.findFirst.mockResolvedValue(null);
    tx.detector.create.mockResolvedValue(createdRow);
    const r = await run({ detectionModel: "", detectionProvider: "" });
    expect(r).toEqual({ ok: true, created: true, data: createdRow });
    const createArg = tx.detector.create.mock.calls[0][0];
    expect(createArg.data).not.toHaveProperty("id");
    expect(createArg.data).not.toHaveProperty("trigger");
    expect(createArg.data).toMatchObject({
      projectId: "p1",
      name: "Latency spike",
      template: "custom",
      prompt: "Find traces with slow spans",
      outputSchema: [],
      sampleRate: DEFAULT_DETECTOR_SAMPLE_RATE,
      enabled: true,
      enableRca: true,
      detectionModel: null,
      detectionProvider: null,
      detectionSource: null,
    });
    expect(root.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorUserId: "u1",
        operation: "create_detector",
        resourceType: "detector",
        resourceId: "d1",
        workspaceId: "w1",
        projectId: "p1",
        summary: {
          name: "Latency spike",
          template: "custom",
          sampleRate: DEFAULT_DETECTOR_SAMPLE_RATE,
          enabled: true,
        },
        transport: "public-api",
        agentSessionId: null,
      }),
    });
  });

  it("nests the trigger create when conditions are present and forwards agent provenance", async () => {
    mockAccess();
    tx.detector.findFirst.mockResolvedValue(null);
    tx.detector.create.mockResolvedValue(createdRow);
    const conditions = [{ field: "cost", op: ">", value: 5 }];
    const r = await run({
      triggerConditions: conditions,
      detectionSource: "byok",
      detectionModel: "gpt-x",
      detectionProvider: "openai",
      enableRca: false,
      provenance: { transport: "agent", agentSessionId: "as1" },
    });
    expect(r).toEqual({ ok: true, created: true, data: createdRow });
    expect(tx.detector.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          trigger: { create: { conditions } },
          detectionSource: "byok",
          detectionModel: "gpt-x",
          detectionProvider: "openai",
          enableRca: false,
        }),
      }),
    );
    expect(root.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ transport: "agent", agentSessionId: "as1" }),
    });
  });
});
