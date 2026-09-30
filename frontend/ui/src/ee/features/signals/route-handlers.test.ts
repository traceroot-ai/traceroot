import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({ NextRequest: class {} }));
vi.mock("@/env", () => ({ env: { INTERNAL_API_SECRET: "sec" } }));

const core = vi.hoisted(() => ({
  listSignals: vi.fn(),
  getSignal: vi.fn(),
  editSignalCriteria: vi.fn(),
  setSignalStatus: vi.fn(),
  mergeSignals: vi.fn(),
  moveHit: vi.fn(),
  signalsForTrace: vi.fn(),
  writeAudit: vi.fn(),
  requireAuth: vi.fn(),
  requireProjectAccess: vi.fn(),
}));
vi.mock("@traceroot/core", () => ({
  prisma: { tag: "prisma" },
  Role: { VIEWER: "VIEWER", MEMBER: "MEMBER", ADMIN: "ADMIN" },
}));
vi.mock("@traceroot/core/signals", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@traceroot/core/signals")>();
  return {
    SIGNAL_STATUSES: actual.SIGNAL_STATUSES,
    signalStatusChangeSchema: actual.signalStatusChangeSchema,
    signalCriteriaEditSchema: actual.signalCriteriaEditSchema,
    listSignals: core.listSignals,
    getSignal: core.getSignal,
    editSignalCriteria: core.editSignalCriteria,
    setSignalStatus: core.setSignalStatus,
    mergeSignals: core.mergeSignals,
    moveHit: core.moveHit,
    signalsForTrace: core.signalsForTrace,
  };
});
vi.mock("@/lib/write-services/audit", () => ({ writeAudit: core.writeAudit }));
vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: core.requireAuth,
  requireProjectAccess: core.requireProjectAccess,
  errorResponse: (error: string, status: number) => Response.json({ error }, { status }),
  successResponse: (data: unknown, status = 200) => Response.json(data, { status }),
}));

import {
  handleEditSignal,
  handleGetSignal,
  handleListDetectorSignals,
  handleMergeSignal,
  handleMoveHit,
  handleSetSignalStatus,
  handleTraceSignals,
} from "./route-handlers";

const mockFetch = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mockFetch);
  mockFetch.mockResolvedValue({ ok: true });
  core.requireAuth.mockResolvedValue({ user: { id: "u1" } });
  core.requireProjectAccess.mockResolvedValue({ project: { id: "p1" } });
});
afterEach(() => vi.unstubAllGlobals());

type Req = Parameters<typeof handleSetSignalStatus>[0];
const req = (body?: unknown, search = "") =>
  ({
    json: async () => {
      if (body === "bad-json") throw new Error("bad");
      return body;
    },
    nextUrl: new URL(`http://x/api${search}`),
  }) as unknown as Req;
const params = <T>(p: T) => ({ params: Promise.resolve(p) });
const signalParams = params({ projectId: "p1", signalId: "s1" });

describe("status changes", () => {
  it("records the change with the signed-in user as the actor", async () => {
    core.setSignalStatus.mockResolvedValue({ ok: true, changed: true, status: "resolved" });
    const res = await handleSetSignalStatus(
      req({
        change: { status: "resolved", reason: "fixed_by_pr", note: "PR 12" },
        expectedStatus: "open",
      }),
      signalParams,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "resolved", changed: true });
    expect(core.setSignalStatus).toHaveBeenCalledWith(
      { tag: "prisma" },
      {
        projectId: "p1",
        signalId: "s1",
        actorUserId: "u1",
        change: { status: "resolved", reason: "fixed_by_pr", note: "PR 12" },
        expectedStatus: "open",
      },
    );
    expect(core.requireProjectAccess).toHaveBeenCalledWith("u1", "p1", "MEMBER");
  });

  it("requires a reason, and a note for other", async () => {
    let res = await handleSetSignalStatus(req({ change: { status: "dismissed" } }), signalParams);
    expect(res.status).toBe(400);
    res = await handleSetSignalStatus(
      req({ change: { status: "dismissed", reason: "other" } }),
      signalParams,
    );
    expect((await res.json()).error).toContain("note is required");
    res = await handleSetSignalStatus(req({ change: {}, expectedStatus: "gone" }), signalParams);
    expect(res.status).toBe(400);
    res = await handleSetSignalStatus(req("bad-json"), signalParams);
    expect(res.status).toBe(400);
    expect(core.setSignalStatus).not.toHaveBeenCalled();
  });

  it("maps a missing signal, a merge and a conflicting change", async () => {
    const body = { change: { status: "open" } };
    core.setSignalStatus.mockResolvedValueOnce({ ok: false, code: "not_found" });
    expect((await handleSetSignalStatus(req(body), signalParams)).status).toBe(404);
    core.setSignalStatus.mockResolvedValueOnce({ ok: false, code: "merged", mergedIntoId: "s9" });
    let res = await handleSetSignalStatus(req(body), signalParams);
    expect([res.status, (await res.json()).mergedIntoId]).toEqual([409, "s9"]);
    core.setSignalStatus.mockResolvedValueOnce({
      ok: false,
      code: "conflict",
      status: "dismissed",
    });
    res = await handleSetSignalStatus(req(body), signalParams);
    expect([res.status, (await res.json()).status]).toEqual([409, "dismissed"]);
  });

  it("stops at authentication and project access", async () => {
    core.requireAuth.mockResolvedValueOnce({ error: Response.json({}, { status: 401 }) });
    expect((await handleSetSignalStatus(req({}), signalParams)).status).toBe(401);
    core.requireProjectAccess.mockResolvedValueOnce({ error: Response.json({}, { status: 403 }) });
    expect((await handleSetSignalStatus(req({}), signalParams)).status).toBe(403);
  });
});

describe("reads", () => {
  it("lists a detector's signals, optionally by status", async () => {
    core.listSignals.mockResolvedValue([{ id: "s1" }]);
    const res = await handleListDetectorSignals(
      req(undefined, "?status=open"),
      params({ projectId: "p1", detectorId: "d1" }),
    );
    expect(await res.json()).toEqual({ signals: [{ id: "s1" }] });
    expect(core.listSignals).toHaveBeenCalledWith(
      { tag: "prisma" },
      { projectId: "p1", detectorId: "d1", status: "open" },
    );
    const bad = await handleListDetectorSignals(
      req(undefined, "?status=closed"),
      params({ projectId: "p1", detectorId: "d1" }),
    );
    expect(bad.status).toBe(400);
  });

  it("returns one signal, or 404", async () => {
    core.getSignal.mockResolvedValueOnce({ merged: false, signal: { id: "s1" } });
    expect(await (await handleGetSignal(req(), signalParams)).json()).toMatchObject({
      signal: { id: "s1" },
    });
    core.getSignal.mockResolvedValueOnce(null);
    expect((await handleGetSignal(req(), signalParams)).status).toBe(404);
  });

  it("returns a trace's signals", async () => {
    core.signalsForTrace.mockResolvedValue([{ runId: "r1" }]);
    const res = await handleTraceSignals(req(), params({ projectId: "p1", traceId: "t1" }));
    expect(await res.json()).toEqual({ hits: [{ runId: "r1" }] });
  });
});

describe("hand edits", () => {
  it("edits the criteria and audits it", async () => {
    core.editSignalCriteria.mockResolvedValue({ ok: true, criteriaVersion: 4 });
    const res = await handleEditSignal(
      req({ title: "T", covers: "C", excludes: "", expectedCriteriaVersion: 3 }),
      signalParams,
    );
    expect(await res.json()).toEqual({ criteriaVersion: 4 });
    expect(core.writeAudit).toHaveBeenCalledWith(
      { tag: "prisma" },
      expect.objectContaining({
        operation: "edit_signal_criteria",
        resourceId: "s1",
        actorUserId: "u1",
      }),
    );
    core.editSignalCriteria.mockResolvedValue({ ok: false, status: 409, error: "edited" });
    expect(
      (
        await handleEditSignal(
          req({ title: "T", covers: "C", excludes: "", expectedCriteriaVersion: 3 }),
          signalParams,
        )
      ).status,
    ).toBe(409);
    expect((await handleEditSignal(req({ title: "" }), signalParams)).status).toBe(400);
  });

  it("merges, rewrites the moved hits' ClickHouse copies in chunks, and audits it", async () => {
    const runIds = Array.from({ length: 1500 }, (_, i) => `r${i}`);
    core.mergeSignals.mockResolvedValue({
      ok: true,
      moved: { projectId: "p1", detectorId: "d1", signalId: "s2", runIds },
    });
    const res = await handleMergeSignal(req({ targetSignalId: "s2" }), signalParams);
    expect(await res.json()).toEqual({ mergedInto: "s2", movedHits: 1500 });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("http://localhost:8000/api/v1/internal/signals/reassign");
    expect(init.headers["X-Internal-Secret"]).toBe("sec");
    expect(JSON.parse(init.body).run_ids).toHaveLength(1000);
    expect(core.writeAudit).toHaveBeenCalledWith(
      { tag: "prisma" },
      expect.objectContaining({ operation: "merge_signal", summary: { into: "s2", hits: 1500 } }),
    );
  });

  it("keeps a merge when the ClickHouse rewrite fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mockFetch.mockResolvedValue({ ok: false, status: 503 });
    core.mergeSignals.mockResolvedValue({
      ok: true,
      moved: { projectId: "p1", detectorId: "d1", signalId: "s2", runIds: ["r1"] },
    });
    expect((await handleMergeSignal(req({ targetSignalId: "s2" }), signalParams)).status).toBe(200);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("rejects a merge without a target or refused by core", async () => {
    expect((await handleMergeSignal(req({}), signalParams)).status).toBe(400);
    core.mergeSignals.mockResolvedValue({ ok: false, status: 400, error: "same" });
    expect((await handleMergeSignal(req({ targetSignalId: "s1" }), signalParams)).status).toBe(400);
  });

  it("moves a hit, rewrites its copy, and audits only a real move", async () => {
    core.moveHit.mockResolvedValueOnce({
      ok: true,
      moved: { projectId: "p1", detectorId: "d1", signalId: "s2", runIds: ["r1"] },
    });
    const hitParams = params({ projectId: "p1", runId: "r1" });
    expect((await handleMoveHit(req({ signalId: "s2" }), hitParams)).status).toBe(200);
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(core.writeAudit).toHaveBeenCalledOnce();

    core.moveHit.mockResolvedValueOnce({
      ok: true,
      moved: { projectId: "p1", detectorId: "d1", signalId: "s2", runIds: [] },
    });
    await handleMoveHit(req({ signalId: "s2" }), hitParams);
    expect(core.writeAudit).toHaveBeenCalledOnce();
    expect((await handleMoveHit(req({}), hitParams)).status).toBe(400);
    core.moveHit.mockResolvedValueOnce({ ok: false, status: 404, error: "Hit not found" });
    expect((await handleMoveHit(req({ signalId: "s2" }), hitParams)).status).toBe(404);
  });
});
