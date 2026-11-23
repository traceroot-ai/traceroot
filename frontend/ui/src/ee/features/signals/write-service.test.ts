import { describe, it, expect, vi, beforeEach } from "vitest";

const { tx, root, setSignalStatusMock } = vi.hoisted(() => ({
  tx: {
    project: { findUnique: vi.fn() },
    workspaceMember: { findUnique: vi.fn() },
  },
  root: {
    signal: { findFirst: vi.fn() },
    auditLog: { create: vi.fn() },
  },
  setSignalStatusMock: vi.fn(),
}));

vi.mock("@traceroot/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@traceroot/core")>()),
  prisma: {
    $transaction: async (fn: (t: unknown) => unknown) => fn(tx),
    signal: root.signal,
    auditLog: root.auditLog,
  },
}));
vi.mock("@traceroot/core/signals", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@traceroot/core/signals")>()),
  setSignalStatus: (...args: unknown[]) => setSignalStatusMock(...args),
}));

import {
  changeSignalStatus,
  DISMISS_NOT_ALLOWED_MESSAGE,
  SIGNAL_NOT_FOUND_MESSAGE,
} from "./write-service";

const RESOLVED_AT = new Date("2026-10-14T10:00:00.000Z");
const record = {
  id: "sig-1",
  projectId: "p1",
  detectorId: "det-1",
  title: "Invokes a tool with an invalid date input",
  status: "resolved",
  resolvedAt: RESOLVED_AT,
  reopenSeq: 2,
};
const provenance = { transport: "public-api" as const, agentSessionId: null };
const resolve = { status: "resolved", reason: "fixed_by_pr", note: "Fixed in abc123" };

function call(overrides: Partial<Parameters<typeof changeSignalStatus>[0]> = {}) {
  return changeSignalStatus({
    actorUserId: "u1",
    projectId: "p1",
    signalId: "sig-1",
    change: resolve,
    provenance,
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  tx.project.findUnique.mockResolvedValue({ workspaceId: "ws-1", deleteTime: null });
  tx.workspaceMember.findUnique.mockResolvedValue({ role: "MEMBER" });
  setSignalStatusMock.mockResolvedValue({
    ok: true,
    changed: true,
    status: "resolved",
    signal: record,
  });
});

describe("changeSignalStatus — access", () => {
  it("refuses a viewer before any write", async () => {
    tx.workspaceMember.findUnique.mockResolvedValue({ role: "VIEWER" });
    const result = await call();
    expect(result).toEqual({ ok: false, status: 403, error: "Requires MEMBER role or higher" });
    expect(setSignalStatusMock).not.toHaveBeenCalled();
  });

  it("answers a non-member with the same 404 as a missing project", async () => {
    tx.workspaceMember.findUnique.mockResolvedValue(null);
    const result = await call();
    expect(result).toEqual({ ok: false, status: 404, error: "Project not found" });
    expect(setSignalStatusMock).not.toHaveBeenCalled();
  });
});

describe("changeSignalStatus — validation", () => {
  it('refuses "dismissed": a dismissed signal never reopens', async () => {
    const result = await call({ change: { status: "dismissed", reason: "expected_behavior" } });
    expect(result).toEqual({ ok: false, status: 400, error: DISMISS_NOT_ALLOWED_MESSAGE });
    expect(setSignalStatusMock).not.toHaveBeenCalled();
  });

  it("requires a reason to resolve", async () => {
    const result = await call({ change: { status: "resolved" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
    expect(setSignalStatusMock).not.toHaveBeenCalled();
  });

  it('requires a note when the reason is "other"', async () => {
    const result = await call({ change: { status: "resolved", reason: "other" } });
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(!result.ok && result.error).toContain("note");
    expect(setSignalStatusMock).not.toHaveBeenCalled();
  });

  it("refuses an unknown reason", async () => {
    const result = await call({ change: { status: "resolved", reason: "because" } });
    expect(result).toMatchObject({ ok: false, status: 400 });
  });

  it("refuses an expectedStatus that is not a signal status", async () => {
    const result = await call({ expectedStatus: "closed" });
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(!result.ok && result.error).toMatch(/^expectedStatus: /);
    expect(setSignalStatusMock).not.toHaveBeenCalled();
  });
});

describe("changeSignalStatus — the write", () => {
  it("resolves through core setSignalStatus and audits the public-api write", async () => {
    const result = await call({ expectedStatus: "open" });
    expect(setSignalStatusMock).toHaveBeenCalledWith(expect.anything(), {
      projectId: "p1",
      signalId: "sig-1",
      actorUserId: "u1",
      change: resolve,
      expectedStatus: "open",
    });
    expect(root.signal.findFirst).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      changed: ["status"],
      data: {
        id: "sig-1",
        projectId: "p1",
        detectorId: "det-1",
        title: "Invokes a tool with an invalid date input",
        status: "resolved",
        resolvedAt: RESOLVED_AT.toISOString(),
        reopenCount: 2,
      },
    });
    expect(root.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorUserId: "u1",
        operation: "set_signal_status",
        resourceType: "signal",
        resourceId: "sig-1",
        workspaceId: "ws-1",
        projectId: "p1",
        transport: "public-api",
        summary: { changed: ["status"], status: "resolved", reason: "fixed_by_pr" },
      }),
    });
  });

  it("reopens with no reason", async () => {
    setSignalStatusMock.mockResolvedValue({
      ok: true,
      changed: true,
      status: "open",
      signal: { ...record, status: "open", resolvedAt: null },
    });
    const result = await call({ change: { status: "open" } });
    expect(result).toMatchObject({ ok: true, changed: ["status"] });
    expect(setSignalStatusMock.mock.calls[0][1].change).toEqual({ status: "open", note: null });
  });

  it("preserves a note when reopening", async () => {
    await call({ change: { status: "open", note: "Needs more work" } });
    expect(setSignalStatusMock.mock.calls[0][1].change).toEqual({
      status: "open",
      note: "Needs more work",
    });
  });

  it("writes no audit row when the status is already the one asked for", async () => {
    setSignalStatusMock.mockResolvedValue({
      ok: true,
      changed: false,
      status: "resolved",
      signal: record,
    });
    const result = await call();
    expect(result).toMatchObject({ ok: true, changed: [] });
    expect(root.auditLog.create).not.toHaveBeenCalled();
  });

  it("maps a missing signal to 404", async () => {
    setSignalStatusMock.mockResolvedValue({ ok: false, code: "not_found" });
    expect(await call()).toEqual({ ok: false, status: 404, error: SIGNAL_NOT_FOUND_MESSAGE });
  });

  it("maps an expectedStatus mismatch to 409 with the current status", async () => {
    setSignalStatusMock.mockResolvedValue({ ok: false, code: "conflict", status: "dismissed" });
    expect(await call({ expectedStatus: "open" })).toEqual({
      ok: false,
      status: 409,
      error: 'The signal\'s status changed: it is now "dismissed"',
    });
    expect(root.auditLog.create).not.toHaveBeenCalled();
  });

  it("maps a merged signal to 409 naming the target", async () => {
    setSignalStatusMock.mockResolvedValue({ ok: false, code: "merged", mergedIntoId: "sig-2" });
    const result = await call();
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(!result.ok && result.error).toContain("sig-2");
  });
});
