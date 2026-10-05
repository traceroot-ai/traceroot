import { describe, it, expect, vi, beforeEach } from "vitest";

// The transaction client and the root client carry separate auditLog mocks so
// the tests can tell which one the audit row was written through.
const { tx, root, order } = vi.hoisted(() => ({
  tx: {
    project: { findUnique: vi.fn() },
    workspaceMember: { findUnique: vi.fn() },
    alert: { count: vi.fn(), create: vi.fn() },
    user: { findUnique: vi.fn() },
    auditLog: { create: vi.fn() },
  },
  root: { user: { findMany: vi.fn() }, auditLog: { create: vi.fn() } },
  // Every mocked query appends here; "commit" marks the transaction resolving,
  // so a test can prove nothing fallible runs between it and the answer.
  order: [] as string[],
}));
// The validator reads the alert vocabulary from core, so only the prisma
// client is replaced.
vi.mock("@traceroot/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@traceroot/core")>()),
  prisma: {
    $transaction: async (fn: (t: unknown) => unknown) => {
      const outcome = await fn(tx);
      order.push("commit");
      return outcome;
    },
    user: root.user,
    auditLog: root.auditLog,
  },
}));
import { MAX_ALERTS_PER_PROJECT } from "@/app/api/projects/[projectId]/alerts/schema";
import { ALERT_CAP_MESSAGE, createAlert, validateAlertCreate } from "./alerts";

const validRule = {
  name: "P99 latency",
  view: "SPANS",
  measure: "latency",
  aggregation: "p99",
  filters: [
    { field: "metadata", key: "tenant", op: "=", value: "acme" },
    { field: "environment", key: "tenant", op: "=", value: "prod" },
  ],
  window: "10m",
  thresholdOperator: ">",
  threshold: 900,
  renotify: { mode: "EVERY", intervalMinutes: 60 },
};

const CREATE_TIME = new Date("2026-08-01T00:00:00Z");

const createdRow = {
  id: "alert-1",
  name: "P99 latency",
  view: "SPANS",
  measure: "latency",
  aggregation: "p99",
  window: "10m",
  thresholdOperator: ">",
  threshold: { toNumber: () => 900 },
  status: "ACTIVE",
  severity: "UNKNOWN",
  severityChangedAt: null,
  alertedAt: null,
  lastEvaluatedAt: null,
  lastError: null,
  lastErrorAt: null,
  lastNotifyStatus: null,
  lastNotifyError: null,
  lastNotifyAt: null,
  createTime: CREATE_TIME,
  updateTime: CREATE_TIME,
  createdBy: "u1",
  filters: [
    { field: "environment", op: "=", value: "prod" },
    { field: "metadata", key: "tenant", op: "=", value: "acme" },
  ],
  renotify: { mode: "EVERY", intervalMinutes: 60 },
  noDataMode: "HOLD",
};

function run(rule: unknown = validRule, overrides: Record<string, unknown> = {}) {
  return createAlert({
    actorUserId: "u1",
    projectId: "p1",
    rule,
    provenance: { transport: "public-api" },
    ...overrides,
  } as Parameters<typeof createAlert>[0]);
}

function mockAccess(role = "MEMBER") {
  tx.project.findUnique.mockResolvedValue({ workspaceId: "w1", deleteTime: null });
  tx.workspaceMember.findUnique.mockResolvedValue({ role });
}

beforeEach(() => {
  order.length = 0;
  tx.project.findUnique.mockReset();
  tx.workspaceMember.findUnique.mockReset();
  tx.alert.count.mockReset();
  tx.alert.count.mockResolvedValue(0);
  tx.alert.create.mockReset();
  tx.alert.create.mockImplementation(async () => {
    order.push("create");
    return createdRow;
  });
  tx.user.findUnique.mockReset();
  tx.user.findUnique.mockImplementation(async () => {
    order.push("creator");
    return { name: "Ada", email: "ada@example.com" };
  });
  tx.auditLog.create.mockReset();
  root.user.findMany.mockReset();
  root.auditLog.create.mockReset();
  root.auditLog.create.mockImplementation(async () => {
    order.push("audit");
    return {};
  });
});

describe("validateAlertCreate", () => {
  it("returns the rule with canonical filters, keys kept only on keyed fields", () => {
    const result = validateAlertCreate(validRule);
    expect(result).toEqual({
      ok: true,
      rule: {
        ...validRule,
        filters: [
          { field: "environment", op: "=", value: "prod" },
          { field: "metadata", key: "tenant", op: "=", value: "acme" },
        ],
      },
    });
  });

  it("reports the first zod issue for a malformed shape", () => {
    expect(validateAlertCreate({ ...validRule, name: "   " })).toEqual({
      ok: false,
      error: "name must be a non-empty string",
    });
    expect(validateAlertCreate({ ...validRule, window: "3m" })).toEqual({
      ok: false,
      error: "Invalid window",
    });
    expect(validateAlertCreate({ ...validRule, threshold: 1e40 })).toMatchObject({ ok: false });
    expect(
      validateAlertCreate({ ...validRule, renotify: { mode: "OFF", intervalMinutes: 5 } }),
    ).toMatchObject({ ok: false });
  });

  it("names the reason a filter cannot run", () => {
    expect(
      validateAlertCreate({ ...validRule, filters: [{ field: "metadata", op: "=", value: "x" }] }),
    ).toEqual({ ok: false, error: 'Filter on "metadata" requires a key' });
    expect(
      validateAlertCreate({
        ...validRule,
        filters: [{ field: "is_root", op: "contains", value: "true" }],
      }),
    ).toEqual({ ok: false, error: 'Operator "contains" is not valid for "is_root"' });
  });

  it("checks the measure against the view and the aggregation against the measure", () => {
    expect(validateAlertCreate({ ...validRule, measure: "not_a_measure" })).toEqual({
      ok: false,
      error: "Invalid measure for view",
    });
    expect(validateAlertCreate({ ...validRule, aggregation: "count" })).toEqual({
      ok: false,
      error: "Invalid aggregation for measure",
    });
  });
});

describe("createAlert", () => {
  it("rejects an invalid rule with 400 before touching the database", async () => {
    const r = await run({ ...validRule, thresholdOperator: "~" });
    expect(r).toEqual({ ok: false, status: 400, error: "Invalid thresholdOperator" });
    expect(tx.project.findUnique).not.toHaveBeenCalled();
    expect(tx.alert.create).not.toHaveBeenCalled();
  });

  it("returns 404 when the project does not exist", async () => {
    tx.project.findUnique.mockResolvedValue(null);
    const r = await run();
    expect(r).toEqual({ ok: false, status: 404, error: "Project not found" });
    expect(tx.alert.create).not.toHaveBeenCalled();
  });

  it("returns the same 404 as a missing project for a non-member, so foreign project ids are not confirmed to exist", async () => {
    tx.project.findUnique.mockResolvedValue({ workspaceId: "w1", deleteTime: null });
    tx.workspaceMember.findUnique.mockResolvedValue(null);
    const r = await run();
    expect(r).toEqual({ ok: false, status: 404, error: "Project not found" });
  });

  it("rejects a VIEWER with 403", async () => {
    mockAccess("VIEWER");
    const r = await run();
    expect(r).toEqual({ ok: false, status: 403, error: "Requires MEMBER role or higher" });
    expect(tx.alert.create).not.toHaveBeenCalled();
  });

  it("refuses the alert past the cap with the cap message, storing nothing", async () => {
    mockAccess();
    tx.alert.count.mockResolvedValue(MAX_ALERTS_PER_PROJECT);
    const r = await run();
    expect(r).toEqual({ ok: false, status: 409, error: ALERT_CAP_MESSAGE });
    expect(ALERT_CAP_MESSAGE).toBe(
      `This project has reached its limit of ${MAX_ALERTS_PER_PROJECT} alerts`,
    );
    expect(tx.alert.count).toHaveBeenCalledWith({ where: { projectId: "p1" } });
    expect(tx.alert.create).not.toHaveBeenCalled();
    expect(root.auditLog.create).not.toHaveBeenCalled();
  });

  it("resolves the creator inside the transaction and runs no query between commit and the answer", async () => {
    mockAccess();
    const r = await run();
    expect(r).toMatchObject({ ok: true, created: true, data: { creator: "Ada" } });
    expect(tx.user.findUnique).toHaveBeenCalledWith({
      where: { id: "u1" },
      select: { name: true, email: true },
    });
    // Only the best-effort audit write follows the commit: the answer is
    // built from what the transaction already fetched, so a failed lookup can
    // never leave a stored alert reported as an error (and then duplicated by
    // a retry of this strict create).
    expect(order).toEqual(["creator", "create", "commit", "audit"]);
    expect(root.user.findMany).not.toHaveBeenCalled();
  });

  it("falls back to the creator's email when the name is empty, and to null when the account is gone", async () => {
    mockAccess();
    tx.user.findUnique.mockResolvedValueOnce({ name: "", email: "ada@example.com" });
    expect(await run()).toMatchObject({ data: { creator: "ada@example.com" } });
    tx.user.findUnique.mockResolvedValueOnce(null);
    expect(await run()).toMatchObject({ data: { creator: null } });
  });

  it("still answers success when the audit write fails after the commit", async () => {
    mockAccess();
    root.auditLog.create.mockRejectedValueOnce(new Error("audit store down"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await run()).toMatchObject({ ok: true, created: true });
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("creates the alert with canonical filters, due now, and writes the audit row through the root client", async () => {
    mockAccess();
    // The last slot under the cap is still storable.
    tx.alert.count.mockResolvedValue(MAX_ALERTS_PER_PROJECT - 1);
    const createdAt = new Date("2026-03-04T05:06:07.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(createdAt);
    let r: Awaited<ReturnType<typeof createAlert>>;
    try {
      r = await run(validRule, { provenance: { transport: "agent", agentSessionId: "as1" } });
    } finally {
      vi.useRealTimers();
    }

    expect(tx.alert.create.mock.calls[0][0].data).toEqual({
      projectId: "p1",
      name: "P99 latency",
      view: "SPANS",
      measure: "latency",
      aggregation: "p99",
      filters: [
        { field: "environment", op: "=", value: "prod" },
        { field: "metadata", key: "tenant", op: "=", value: "acme" },
      ],
      window: "10m",
      thresholdOperator: ">",
      threshold: 900,
      renotify: { mode: "EVERY", intervalMinutes: 60 },
      noDataMode: undefined,
      createdBy: "u1",
      nextRunAt: createdAt,
    });
    expect(r).toEqual({
      ok: true,
      created: true,
      data: {
        id: "alert-1",
        name: "P99 latency",
        view: "SPANS",
        measure: "latency",
        aggregation: "p99",
        window: "10m",
        thresholdOperator: ">",
        threshold: 900,
        status: "ACTIVE",
        severity: "UNKNOWN",
        severityChangedAt: null,
        alertedAt: null,
        lastEvaluatedAt: null,
        lastError: null,
        lastErrorAt: null,
        lastNotifyStatus: null,
        lastNotifyError: null,
        lastNotifyAt: null,
        createTime: CREATE_TIME,
        updateTime: CREATE_TIME,
        creator: "Ada",
        filters: createdRow.filters,
        renotify: { mode: "EVERY", intervalMinutes: 60 },
        noDataMode: "HOLD",
      },
    });
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(root.auditLog.create).toHaveBeenCalledWith({
      data: {
        actorUserId: "u1",
        operation: "create_alert",
        resourceType: "alert",
        resourceId: "alert-1",
        workspaceId: "w1",
        projectId: "p1",
        summary: {
          name: "P99 latency",
          view: "SPANS",
          measure: "latency",
          aggregation: "p99",
          window: "10m",
        },
        transport: "agent",
        agentSessionId: "as1",
      },
    });
  });

  it("stores a no-data mode the caller names", async () => {
    mockAccess();
    await run({ ...validRule, noDataMode: "ZERO" });
    expect(tx.alert.create.mock.calls[0][0].data.noDataMode).toBe("ZERO");
  });
});
