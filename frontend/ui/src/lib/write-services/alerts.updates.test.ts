/**
 * The alert mock is a scoped store rather than a fixed stub: every read and
 * write goes through the `where` the service passed, so a write that dropped
 * `projectId` or the status guard would reach the wrong row here exactly as
 * it would in production.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";
import { DELETE_REASON_MESSAGE, NO_FIELDS_MESSAGE } from "./update-support";

type Where = Record<string, unknown>;

const { tx, root, order, store } = vi.hoisted(() => ({
  tx: {
    $queryRaw: vi.fn(),
    project: { findUnique: vi.fn() },
    workspaceMember: { findUnique: vi.fn() },
    alert: { findFirst: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
    user: { findUnique: vi.fn() },
    auditLog: { create: vi.fn() },
  },
  root: { auditLog: { create: vi.fn() } },
  order: [] as string[],
  store: new Map<string, Record<string, unknown>>(),
}));
vi.mock("@traceroot/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@traceroot/core")>()),
  prisma: {
    $transaction: async (fn: (t: unknown) => unknown) => {
      const outcome = await fn(tx);
      order.push("commit");
      return outcome;
    },
    auditLog: root.auditLog,
  },
}));
import { deleteAlert, setAlertStatus, updateAlert } from "./alerts";

const T0 = new Date("2026-08-12T10:00:00.000Z");
const baseRow = {
  id: "alert-1",
  projectId: "p1",
  name: "P95 latency",
  view: "SPANS",
  measure: "latency",
  aggregation: "p95",
  filters: [{ field: "model_name", op: "=", value: "gpt-4o" }],
  window: "10m",
  thresholdOperator: ">",
  threshold: 500,
  renotify: { mode: "EVERY", intervalMinutes: 60 },
  noDataMode: "HOLD",
  status: "ACTIVE",
  severity: "ALERT",
  severityChangedAt: T0 as Date | null,
  alertedAt: T0 as Date | null,
  lastEvaluatedAt: T0 as Date | null,
  lastError: null,
  lastErrorAt: null,
  lastNotifyStatus: null,
  lastNotifyError: null,
  lastNotifyAt: null,
  nextRunAt: new Date("2026-08-12T10:31:00.000Z") as Date | null,
  lastClaimedAt: T0 as Date | null,
  pendingClose: null as Record<string, unknown> | null,
  createTime: T0,
  updateTime: T0,
  createdBy: "u1",
};
type Row = typeof baseRow;
const row = (overrides: Partial<Row> = {}): Row => ({ ...baseRow, ...overrides });

function matches(candidate: Record<string, unknown>, where: Where): boolean {
  if (typeof where.id === "string" && candidate.id !== where.id) return false;
  if (typeof where.projectId === "string" && candidate.projectId !== where.projectId) return false;
  if (typeof where.status === "string" && candidate.status !== where.status) return false;
  const status = where.status as { in?: string[] } | undefined;
  if (Array.isArray(status?.in) && !status.in.includes(candidate.status as string)) return false;
  // The only marker guard the services write: "still empty".
  const marker = where.pendingClose as { equals?: unknown } | undefined;
  if (marker?.equals === Prisma.DbNull && candidate.pendingClose !== null) return false;
  return true;
}
const rowsMatching = (where: Where) => [...store.values()].filter((r) => matches(r, where));
const current = () => store.get("alert-1") as Row;
/** Every write but the close marker, which rides behind a reset that cleared a page. */
const ruleWrites = () =>
  tx.alert.updateMany.mock.calls.filter(([args]) => !("pendingClose" in args.data));

const provenance = { transport: "public-api" as const };

function mockAccess(role = "MEMBER") {
  tx.project.findUnique.mockResolvedValue({ workspaceId: "w1", deleteTime: null });
  tx.workspaceMember.findUnique.mockResolvedValue({ role });
}

const update = (patch: unknown, overrides: Record<string, unknown> = {}) =>
  updateAlert({
    actorUserId: "u1",
    projectId: "p1",
    alertId: "alert-1",
    patch,
    provenance,
    ...overrides,
  } as Parameters<typeof updateAlert>[0]);

const setStatus = (status: unknown, alertId = "alert-1") =>
  setAlertStatus({ actorUserId: "u1", projectId: "p1", alertId, status, provenance });

const remove = (overrides: Record<string, unknown> = {}) =>
  deleteAlert({
    actorUserId: "u1",
    projectId: "p1",
    alertId: "alert-1",
    reason: "the rule was replaced by a detector",
    provenance,
    ...overrides,
  } as Parameters<typeof deleteAlert>[0]);

beforeEach(() => {
  order.length = 0;
  store.clear();
  store.set("alert-1", row());
  store.set("other-1", row({ id: "other-1", projectId: "p-other", name: "Elsewhere" }));
  for (const model of [tx.project, tx.workspaceMember, tx.alert, tx.user, tx.auditLog]) {
    for (const fn of Object.values(model)) fn.mockReset();
  }
  tx.$queryRaw.mockReset();
  tx.$queryRaw.mockImplementation(async () => {
    order.push("lock");
    return [];
  });
  tx.alert.findFirst.mockImplementation(async ({ where }: { where: Where }) => {
    const [found] = rowsMatching(where);
    return found === undefined ? null : { ...found };
  });
  tx.alert.updateMany.mockImplementation(async ({ where, data }: { where: Where; data: Where }) => {
    order.push("write");
    const rows = rowsMatching(where);
    for (const r of rows) store.set(r.id as string, { ...r, ...data });
    return { count: rows.length };
  });
  tx.alert.deleteMany.mockImplementation(async ({ where }: { where: Where }) => {
    order.push("delete");
    const rows = rowsMatching(where);
    for (const r of rows) store.delete(r.id as string);
    return { count: rows.length };
  });
  tx.user.findUnique.mockResolvedValue({ name: "Ada", email: "ada@example.com" });
  root.auditLog.create.mockReset();
  root.auditLog.create.mockImplementation(async () => {
    order.push("audit");
    return {};
  });
});

describe("updateAlert", () => {
  it("returns 404 for a missing project, the same 404 for a non-member, and 403 for a VIEWER", async () => {
    tx.project.findUnique.mockResolvedValue(null);
    expect(await update({ name: "New" })).toEqual({
      ok: false,
      status: 404,
      error: "Project not found",
    });
    tx.project.findUnique.mockResolvedValue({ workspaceId: "w1", deleteTime: null });
    tx.workspaceMember.findUnique.mockResolvedValue(null);
    expect(await update({ name: "New" })).toEqual({
      ok: false,
      status: 404,
      error: "Project not found",
    });
    mockAccess("VIEWER");
    expect(await update({ name: "New" })).toEqual({
      ok: false,
      status: 403,
      error: "Requires MEMBER role or higher",
    });
    expect(tx.alert.findFirst).not.toHaveBeenCalled();
  });

  it("rejects an empty patch, a malformed field and an undeclared filter with 400 before reading the alert", async () => {
    mockAccess();
    expect(await update({})).toEqual({ ok: false, status: 400, error: NO_FIELDS_MESSAGE });
    expect(await update({ window: "3m" })).toEqual({
      ok: false,
      status: 400,
      error: "Invalid window",
    });
    expect(await update({ name: null })).toMatchObject({ ok: false, status: 400 });
    expect(await update({ filters: [{ field: "service_name", op: "=", value: "api" }] })).toEqual({
      ok: false,
      status: 400,
      error: 'Alerts cannot filter on "service_name"',
    });
    expect(tx.alert.findFirst).not.toHaveBeenCalled();
  });

  it("returns 404 for an alert in another project, identical to an unknown id, leaving the row as it was", async () => {
    mockAccess();
    expect(await update({ name: "Renamed" }, { alertId: "other-1" })).toEqual({
      ok: false,
      status: 404,
      error: "Alert not found",
    });
    expect(await update({ name: "Renamed" }, { alertId: "missing" })).toEqual({
      ok: false,
      status: 404,
      error: "Alert not found",
    });
    expect(store.get("other-1")?.name).toBe("Elsewhere");
    expect(tx.alert.updateMany).not.toHaveBeenCalled();
  });

  it("answers a patch equal to the stored rule as a no-op: no write, no audit, the record as read", async () => {
    mockAccess();
    const r = await update({
      name: "P95 latency",
      threshold: 500,
      filters: [{ field: "model_name", op: "=", value: "gpt-4o" }],
      renotify: { mode: "EVERY", intervalMinutes: 60 },
    });
    expect(r).toEqual({
      ok: true,
      changed: [],
      stateReset: false,
      pageCleared: false,
      data: expect.objectContaining({
        id: "alert-1",
        name: "P95 latency",
        creator: "Ada",
        threshold: 500,
      }),
    });
    expect(tx.alert.updateMany).not.toHaveBeenCalled();
    expect(root.auditLog.create).not.toHaveBeenCalled();
  });

  it("applies a rename through a project-scoped write, leaving the evaluation state and the page alone", async () => {
    mockAccess();
    const r = await update(
      { name: "Renamed" },
      { provenance: { transport: "agent", agentSessionId: "as1" } },
    );
    expect(r).toMatchObject({ ok: true, changed: ["name"], stateReset: false, pageCleared: false });
    expect(current().name).toBe("Renamed");
    expect(current().severity).toBe("ALERT");
    expect(current().lastClaimedAt).not.toBeNull();
    expect(tx.alert.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.alert.updateMany.mock.calls[0][0]).toEqual({
      where: { id: "alert-1", projectId: "p1" },
      data: { name: "Renamed" },
    });
    expect(order).toEqual(["lock", "write", "commit", "audit"]);
    expect(root.auditLog.create).toHaveBeenCalledWith({
      data: {
        actorUserId: "u1",
        operation: "update_alert",
        resourceType: "alert",
        resourceId: "alert-1",
        workspaceId: "w1",
        projectId: "p1",
        summary: { changed: ["name"] },
        transport: "agent",
        agentSessionId: "as1",
      },
    });
  });

  it("resets the alert to a cold start on a rule change and reports the page it cleared", async () => {
    mockAccess();
    const r = await update({ threshold: 999 });
    expect(r).toMatchObject({
      ok: true,
      changed: ["threshold"],
      stateReset: true,
      pageCleared: true,
    });
    const stored = current();
    expect(stored.threshold).toBe(999);
    expect(stored.severity).toBe("UNKNOWN");
    expect(stored.severityChangedAt).toBeNull();
    expect(stored.alertedAt).toBeNull();
    // Nulling the claim token stops an in-flight worker writing back, and the
    // reset reschedules rather than unscheduling.
    expect(stored.lastClaimedAt).toBeNull();
    expect(stored.nextRunAt).toBeInstanceOf(Date);
  });

  describe("the close it leaves for the page it cleared", () => {
    it("names the edit and who made it, inside the transaction that voided the page", async () => {
      mockAccess();
      await update({ threshold: 999 }, { actorUserId: "u7" });

      expect(current().pendingClose).toEqual({
        reason: "edited",
        actorUserId: "u7",
        at: expect.any(String),
      });
      // The marker is the last write before the commit: neither lands without the other.
      expect(order.slice(-3)).toEqual(["write", "commit", "audit"]);
      // And the row was locked before anything read or wrote it. Whether a page
      // is being discarded is decided from that read, so a tick must not be able
      // to raise one between the read and the reset.
      expect(order[0]).toBe("lock");
      const [strings, ...values] = tx.$queryRaw.mock.calls[0] as [string[], ...unknown[]];
      expect(strings.join("?")).toBe(
        "SELECT id FROM alerts WHERE id = ? AND project_id = ? FOR UPDATE",
      );
      expect(values).toEqual(["alert-1", "p1"]);
      expect(tx.alert.updateMany.mock.calls.at(-1)?.[0].where).toEqual({
        id: "alert-1",
        projectId: "p1",
        pendingClose: { equals: Prisma.DbNull },
      });
    });

    it("leaves none when the edit cleared no page, or changed nothing that is evaluated", async () => {
      mockAccess();
      await update({ name: "Renamed" });
      expect(current().pendingClose).toBeNull();

      store.set("alert-1", row({ severity: "OK", alertedAt: null }));
      await update({ threshold: 999 });
      expect(current().pendingClose).toBeNull();
    });

    it("keeps the first marker when the rule is edited again before the close goes out", async () => {
      mockAccess();
      await update({ threshold: 999 }, { actorUserId: "u7" });
      const first = current().pendingClose;

      // The second edit finds no page to clear, the first having reset the state.
      expect(await update({ threshold: 1200 }, { actorUserId: "u8" })).toMatchObject({
        stateReset: true,
        pageCleared: false,
      });
      expect(current().pendingClose).toEqual(first);
    });

    it("does not overwrite a marker still standing beside a page raised since", async () => {
      mockAccess();
      const waiting = { reason: "resumed", actorUserId: "u3", at: "2026-08-12T09:00:00.000Z" };
      store.set("alert-1", row({ pendingClose: waiting }));

      expect(await update({ threshold: 999 })).toMatchObject({ pageCleared: true });
      expect(current().pendingClose).toEqual(waiting);
    });
  });

  it("reports no cleared page when the state it voided held none", async () => {
    mockAccess();
    store.set("alert-1", row({ severity: "OK", alertedAt: null }));
    expect(await update({ noDataMode: "ZERO" })).toMatchObject({
      changed: ["no_data_mode"],
      stateReset: true,
      pageCleared: false,
    });
    store.set("alert-1", row({ severity: "NO_DATA" }));
    expect(await update({ window: "30m" })).toMatchObject({ stateReset: true, pageCleared: true });
  });

  it("names every changed field in public form and canonicalizes the filters it stores", async () => {
    mockAccess();
    const r = await update({
      thresholdOperator: "<",
      filters: [
        { field: "metadata", key: "tenant", op: "=", value: "acme" },
        { field: "environment", key: "tenant", op: "=", value: "prod" },
      ],
    });
    expect(r).toMatchObject({ changed: ["filters", "threshold_operator"] });
    expect(current().filters).toEqual([
      { field: "environment", op: "=", value: "prod" },
      { field: "metadata", key: "tenant", op: "=", value: "acme" },
    ]);
  });

  describe("the merged rule, not the patch alone, is what must be evaluable", () => {
    const spanFilter = [{ field: "span_kind", op: "=", value: "LLM" }];

    it("refuses a filters-only edit that the stored measure cannot carry", async () => {
      mockAccess();
      store.set("alert-1", row({ measure: "unique_user_ids", aggregation: "uniq", filters: [] }));
      expect(await update({ filters: spanFilter })).toEqual({
        ok: false,
        status: 400,
        error: "Invalid aggregation for measure",
      });
      expect(current().filters).toEqual([]);
    });

    it("refuses an aggregation-only edit invalid against the stored measure, and a measure outside the view", async () => {
      mockAccess();
      expect(await update({ aggregation: "count" })).toEqual({
        ok: false,
        status: 400,
        error: "Invalid aggregation for measure",
      });
      expect(await update({ measure: "not_a_measure" })).toEqual({
        ok: false,
        status: 400,
        error: "Invalid measure for view",
      });
      expect(tx.alert.updateMany).not.toHaveBeenCalled();
    });

    it("accepts the same measure edit once the filters are cleared in the same patch", async () => {
      mockAccess();
      expect(
        await update({ measure: "unique_user_ids", aggregation: "uniq", filters: [] }),
      ).toMatchObject({
        ok: true,
        changed: ["measure", "aggregation", "filters"],
      });
      expect(current().measure).toBe("unique_user_ids");
    });
  });

  describe("a parked rule re-arms on the edit that replaces what it was parked on", () => {
    beforeEach(() => {
      mockAccess();
      store.set("alert-1", row({ status: "PARKED" }));
    });

    it("starts the rule again, cold, through the status compare-and-set when the edit rewrites the rule", async () => {
      expect(await update({ threshold: 999 })).toMatchObject({ ok: true, stateReset: true });
      expect(current().status).toBe("ACTIVE");
      expect(current().severity).toBe("UNKNOWN");
      expect(current().lastClaimedAt).toBeNull();
      expect(tx.alert.updateMany.mock.calls[0][0].where).toEqual({
        id: "alert-1",
        projectId: "p1",
        status: "PARKED",
      });
      expect(ruleWrites()).toHaveLength(1);
    });

    it("counts a renotify edit, which the evaluated rule does not include, and reports the reset it applied", async () => {
      expect(await update({ renotify: { mode: "OFF" } })).toMatchObject({
        changed: ["renotify"],
        stateReset: true,
      });
      expect(current().status).toBe("ACTIVE");
    });

    it("leaves it parked on a rename, which changes nothing the evaluator refused", async () => {
      expect(await update({ name: "Renamed" })).toMatchObject({
        changed: ["name"],
        stateReset: false,
      });
      expect(current().status).toBe("PARKED");
      expect(current().name).toBe("Renamed");
    });

    it("leaves it parked on a renotify equal to the stored one: nothing was edited", async () => {
      expect(await update({ renotify: { mode: "EVERY", intervalMinutes: 60 } })).toMatchObject({
        changed: [],
      });
      expect(current().status).toBe("PARKED");
    });

    it("voids a claim still in flight on an active rule, so a delayed park cannot re-park a renotify repair", async () => {
      store.set("alert-1", row({ status: "ACTIVE" }));
      const r = await update({ renotify: { mode: "OFF" } });
      expect(r).toMatchObject({ changed: ["renotify"], stateReset: false });
      const stored = current();
      expect(stored.status).toBe("ACTIVE");
      expect(stored.lastClaimedAt).toBeNull();
      expect(stored.nextRunAt!.getTime()).toBeGreaterThan(baseRow.nextRunAt!.getTime());
      // Renotify is not the evaluated rule: the severity it stood at is kept.
      expect(stored.severity).toBe("ALERT");
      expect(stored.alertedAt).toEqual(baseRow.alertedAt);
    });

    it("re-arms on the current status, not the one read before a concurrent tick parked it", async () => {
      store.set("alert-1", row({ status: "ACTIVE" }));
      tx.alert.findFirst.mockImplementationOnce(async () => {
        const stale = { ...current() };
        store.set("alert-1", { ...stale, status: "PARKED" });
        return stale;
      });
      expect(await update({ threshold: 999 })).toMatchObject({ ok: true, stateReset: true });
      expect(current().status).toBe("ACTIVE");
      expect(current().threshold).toBe(999);
    });

    it("retries the CAS once when a tick parks the rule between the check and the fallback write", async () => {
      store.set("alert-1", row({ status: "ACTIVE" }));
      // The first updateMany is the CAS check; it finds the row ACTIVE, and a
      // tick lands its park right after.
      tx.alert.updateMany.mockImplementationOnce(
        async ({ where, data }: { where: Where; data: Where }) => {
          const rows = rowsMatching(where);
          for (const r of rows) store.set(r.id as string, { ...r, ...data });
          store.set("alert-1", { ...current(), status: "PARKED" });
          return { count: rows.length };
        },
      );
      expect(await update({ threshold: 999 })).toMatchObject({ ok: true });
      expect(current().status).toBe("ACTIVE");
      expect(current().threshold).toBe(999);
      expect(ruleWrites()).toHaveLength(3);
    });
  });

  it("returns 404 when the row vanishes between the read and the write", async () => {
    mockAccess();
    tx.alert.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await update({ name: "Renamed" })).toEqual({
      ok: false,
      status: 404,
      error: "Alert not found",
    });
    expect(root.auditLog.create).not.toHaveBeenCalled();
  });
});

describe("setAlertStatus", () => {
  it("returns 404 for a missing project and 403 for a VIEWER", async () => {
    tx.project.findUnique.mockResolvedValue(null);
    expect(await setStatus("PAUSED")).toEqual({
      ok: false,
      status: 404,
      error: "Project not found",
    });
    mockAccess("VIEWER");
    expect(await setStatus("PAUSED")).toEqual({
      ok: false,
      status: 403,
      error: "Requires MEMBER role or higher",
    });
  });

  it("rejects a status outside the settable pair, PARKED included", async () => {
    mockAccess();
    expect(await setStatus("PARKED")).toMatchObject({ ok: false, status: 400 });
    expect(await setStatus("DELETED")).toMatchObject({ ok: false, status: 400 });
    expect(await setStatus(undefined)).toMatchObject({ ok: false, status: 400 });
    expect(tx.alert.updateMany).not.toHaveBeenCalled();
  });

  it("404s an id that is missing or in another project", async () => {
    mockAccess();
    expect(await setStatus("PAUSED", "missing")).toEqual({
      ok: false,
      status: 404,
      error: "Alert not found",
    });
    expect(await setStatus("PAUSED", "other-1")).toEqual({
      ok: false,
      status: 404,
      error: "Alert not found",
    });
    expect(store.get("other-1")?.status).toBe("ACTIVE");
  });

  it("pauses through a project-scoped write, keeping the severity it stopped at, and audits", async () => {
    mockAccess();
    const r = await setStatus("PAUSED");
    expect(r).toMatchObject({
      ok: true,
      changed: ["status"],
      stateReset: false,
      pageCleared: false,
      data: expect.objectContaining({ status: "PAUSED", severity: "ALERT" }),
    });
    expect(tx.alert.updateMany.mock.calls[0][0]).toEqual({
      where: { id: "alert-1", projectId: "p1", status: "ACTIVE" },
      data: { status: "PAUSED" },
    });
    expect(root.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        operation: "set_alert_status",
        resourceId: "alert-1",
        summary: { changed: ["status"], status: "PAUSED" },
      }),
    });
  });

  it("resumes as a cold start, because the paused gap was never evaluated, and reports the page it cleared", async () => {
    mockAccess();
    store.set("alert-1", row({ status: "PAUSED" }));
    const r = await setStatus("ACTIVE");
    expect(r).toMatchObject({ ok: true, changed: ["status"], stateReset: true, pageCleared: true });
    const stored = current();
    expect(stored.status).toBe("ACTIVE");
    expect(stored.severity).toBe("UNKNOWN");
    expect(stored.alertedAt).toBeNull();
    expect(stored.lastClaimedAt).toBeNull();
    expect(tx.alert.updateMany.mock.calls[0][0].where).toEqual({
      id: "alert-1",
      projectId: "p1",
      status: { in: ["PAUSED", "PARKED"] },
    });
    // The page it cleared is closed by the worker, off this marker.
    expect(stored.pendingClose).toMatchObject({ reason: "resumed", actorUserId: "u1" });
    // Read under the same row lock an edit takes, for the same reason.
    expect(order[0]).toBe("lock");
  });

  it("leaves no close when it pauses, or resumes a rule that held no page", async () => {
    mockAccess();
    await setStatus("PAUSED");
    expect(current().pendingClose).toBeNull();

    store.set("alert-1", row({ status: "PAUSED", severity: "OK", alertedAt: null }));
    await setStatus("ACTIVE");
    expect(current().pendingClose).toBeNull();
  });

  it("resumes a parked rule the same way, as the operator's retry of it", async () => {
    mockAccess();
    store.set("alert-1", row({ status: "PARKED", severity: "OK", alertedAt: null }));
    expect(await setStatus("ACTIVE")).toMatchObject({
      ok: true,
      stateReset: true,
      pageCleared: false,
    });
    expect(current().status).toBe("ACTIVE");
    expect(current().severity).toBe("UNKNOWN");
  });

  it("answers the status it already has with 200 and an empty changed, writing nothing", async () => {
    mockAccess();
    expect(await setStatus("ACTIVE")).toMatchObject({ ok: true, changed: [], stateReset: false });
    expect(current()).toEqual(baseRow);
    store.set("alert-1", row({ status: "PAUSED" }));
    expect(await setStatus("PAUSED")).toMatchObject({ ok: true, changed: [] });
    expect(tx.alert.updateMany).not.toHaveBeenCalled();
    expect(root.auditLog.create).not.toHaveBeenCalled();
  });

  it("refuses to pause a parked rule, keeping PARKED the evaluator's verdict", async () => {
    mockAccess();
    store.set("alert-1", row({ status: "PARKED" }));
    expect(await setStatus("PAUSED")).toEqual({
      ok: false,
      status: 409,
      error: "This alert was parked by the evaluator; resume it to run it again.",
    });
    expect(current().status).toBe("PARKED");
  });

  it("answers a resume that raced another resume to ACTIVE as the no-op, not as parked", async () => {
    mockAccess();
    store.set("alert-1", row({ status: "PAUSED" }));
    tx.alert.findFirst.mockImplementationOnce(async () => {
      const stale = { ...current() };
      store.set("alert-1", { ...stale, status: "ACTIVE" });
      return stale;
    });
    expect(await setStatus("ACTIVE")).toMatchObject({ ok: true, changed: [], stateReset: false });
    expect(current().status).toBe("ACTIVE");
    expect(root.auditLog.create).not.toHaveBeenCalled();
  });

  it("answers a pause that raced another pause to PAUSED as the no-op, auditing nothing", async () => {
    mockAccess();
    tx.alert.findFirst.mockImplementationOnce(async () => {
      const stale = { ...current() };
      store.set("alert-1", { ...stale, status: "PAUSED" });
      return stale;
    });
    expect(await setStatus("PAUSED")).toMatchObject({
      ok: true,
      changed: [],
      stateReset: false,
      pageCleared: false,
    });
    expect(tx.alert.updateMany).toHaveBeenCalledTimes(1);
    expect(current().status).toBe("PAUSED");
    expect(root.auditLog.create).not.toHaveBeenCalled();
  });

  it("refuses the pause with the same 409 when a tick parks the rule between the read and the write", async () => {
    mockAccess();
    tx.alert.findFirst.mockImplementationOnce(async () => {
      const stale = { ...current() };
      store.set("alert-1", { ...stale, status: "PARKED" });
      return stale;
    });
    expect(await setStatus("PAUSED")).toMatchObject({ ok: false, status: 409 });
    expect(current().status).toBe("PARKED");
  });
});

describe("deleteAlert", () => {
  it("refuses a missing reason before reading anything", async () => {
    expect(await remove({ reason: "  " })).toEqual({
      ok: false,
      status: 400,
      error: DELETE_REASON_MESSAGE,
    });
    expect(tx.project.findUnique).not.toHaveBeenCalled();
  });

  it("returns 404 for a missing project, 403 for a VIEWER, and 404 for an alert in another project", async () => {
    tx.project.findUnique.mockResolvedValue(null);
    expect(await remove()).toEqual({ ok: false, status: 404, error: "Project not found" });
    mockAccess("VIEWER");
    expect(await remove()).toEqual({
      ok: false,
      status: 403,
      error: "Requires MEMBER role or higher",
    });
    mockAccess();
    expect(await remove({ alertId: "other-1" })).toEqual({
      ok: false,
      status: 404,
      error: "Alert not found",
    });
    expect(store.has("other-1")).toBe(true);
  });

  it("deletes through a project-scoped statement, reports the open page, and audits the reason", async () => {
    mockAccess();
    expect(await remove()).toEqual({
      ok: true,
      data: { id: "alert-1", name: "P95 latency" },
      reason: "the rule was replaced by a detector",
      pageCleared: true,
    });
    expect(store.has("alert-1")).toBe(false);
    expect(tx.alert.deleteMany).toHaveBeenCalledWith({ where: { id: "alert-1", projectId: "p1" } });
    expect(order).toEqual(["delete", "commit", "audit"]);
    expect(root.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        operation: "delete_alert",
        resourceType: "alert",
        resourceId: "alert-1",
        summary: {
          name: "P95 latency",
          reason: "the rule was replaced by a detector",
          pageCleared: true,
        },
      }),
    });
  });

  it("reports no page when none was open, and 404s a second delete of the same id", async () => {
    mockAccess();
    store.set("alert-1", row({ severity: "OK", alertedAt: null }));
    expect(await remove()).toMatchObject({ ok: true, pageCleared: false });
    expect(await remove()).toEqual({ ok: false, status: 404, error: "Alert not found" });
  });

  it("404s when the row vanishes between the read and the delete", async () => {
    mockAccess();
    tx.alert.deleteMany.mockResolvedValueOnce({ count: 0 });
    expect(await remove()).toEqual({ ok: false, status: 404, error: "Alert not found" });
    expect(root.auditLog.create).not.toHaveBeenCalled();
  });
});
