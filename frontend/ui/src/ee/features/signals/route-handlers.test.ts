import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({ NextRequest: class {} }));
vi.mock("@/env", () => ({ env: { INTERNAL_API_SECRET: "sec" } }));

const core = vi.hoisted(() => ({
  listSignals: vi.fn(),
  workspace: vi.fn(),
  getSignal: vi.fn(),
  editSignalCriteria: vi.fn(),
  setSignalStatus: vi.fn(),
  mergeSignals: vi.fn(),
  moveHit: vi.fn(),
  requestSignalRca: vi.fn(),
  signalsForTrace: vi.fn(),
  detectorSignalSettings: vi.fn(),
  signalSetup: vi.fn(),
  signalsKeyConfigured: vi.fn(),
  writeAudit: vi.fn(),
  requireAuth: vi.fn(),
  requireProjectAccess: vi.fn(),
}));
vi.mock("@traceroot/core", () => ({
  prisma: { tag: "prisma", workspace: { findUnique: core.workspace } },
  PlanType: { FREE: "free" },
  getRetentionDays: (plan: string) => (plan === "enterprise" ? null : 15),
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
    requestSignalRca: core.requestSignalRca,
    signalsForTrace: core.signalsForTrace,
    detectorSignalSettings: core.detectorSignalSettings,
    signalSetup: core.signalSetup,
    signalsKeyConfigured: core.signalsKeyConfigured,
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
  handleListSignals,
  handleMergeSignal,
  handleMoveHit,
  handleRequestSignalRca,
  handleSetSignalStatus,
  handleSignalSetup,
  handleTraceSignals,
} from "./route-handlers";

const mockFetch = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  core.workspace.mockResolvedValue({ billingPlan: "enterprise" });
  vi.stubGlobal("fetch", mockFetch);
  mockFetch.mockResolvedValue({ ok: true });
  core.requireAuth.mockResolvedValue({ user: { id: "u1" } });
  core.requireProjectAccess.mockResolvedValue({ project: { id: "p1", workspaceId: "w1" } });
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
    expect(core.setSignalStatus).toHaveBeenCalledWith(expect.objectContaining({ tag: "prisma" }), {
      projectId: "p1",
      signalId: "s1",
      actorUserId: "u1",
      change: { status: "resolved", reason: "fixed_by_pr", note: "PR 12" },
      expectedStatus: "open",
    });
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

it("rejects an oversized chart window consistently in list and detail", async () => {
  const query = "?start_after=1970-01-01T00:00:00Z&end_before=2026-10-01T00:00:00Z";
  expect((await handleListSignals(req(undefined, query), params({ projectId: "p1" }))).status).toBe(
    400,
  );
  expect((await handleGetSignal(req(undefined, query), signalParams)).status).toBe(400);
  expect(core.listSignals).not.toHaveBeenCalled();
  expect(core.getSignal).not.toHaveBeenCalled();
});

it("uses an empty retained window instead of counting expired traces", async () => {
  core.workspace.mockResolvedValue({ billingPlan: "free" });
  core.listSignals.mockResolvedValue({ signals: [], total: 0 });
  await handleListSignals(
    req(undefined, "?start_after=2020-01-01T00:00:00Z&end_before=2020-01-02T00:00:00Z"),
    params({ projectId: "p1" }),
  );
  expect(core.listSignals.mock.calls[0][1].hitsIn).toEqual({
    from: new Date("2020-01-02T00:00:00Z"),
    to: new Date("2020-01-02T00:00:00Z"),
  });
});

describe("reads", () => {
  it("lists one page of a detector's signals, optionally by status", async () => {
    core.listSignals.mockResolvedValue({ signals: [{ id: "s1" }], total: 51 });
    const res = await handleListDetectorSignals(
      req(undefined, "?status=open&page=1&limit=50"),
      params({ projectId: "p1", detectorId: "d1" }),
    );
    expect(await res.json()).toEqual({
      data: [{ id: "s1" }],
      meta: { page: 1, limit: 50, total: 51 },
    });
    expect(core.listSignals).toHaveBeenCalledWith(expect.objectContaining({ tag: "prisma" }), {
      projectId: "p1",
      detectorIds: ["d1"],
      statuses: ["open"],
      page: 1,
      limit: 50,
    });
    await handleListDetectorSignals(req(), params({ projectId: "p1", detectorId: "d1" }));
    expect(core.listSignals).toHaveBeenLastCalledWith(expect.objectContaining({ tag: "prisma" }), {
      projectId: "p1",
      detectorIds: ["d1"],
      page: 0,
      limit: 50,
    });
    await handleListDetectorSignals(
      req(undefined, "?page=99999999999999999999&limit=1000"),
      params({ projectId: "p1", detectorId: "d1" }),
    );
    expect(core.listSignals).toHaveBeenLastCalledWith(expect.objectContaining({ tag: "prisma" }), {
      projectId: "p1",
      detectorIds: ["d1"],
      page: 10_000,
      limit: 200,
    });
    const bad = await handleListDetectorSignals(
      req(undefined, "?status=closed"),
      params({ projectId: "p1", detectorId: "d1" }),
    );
    expect(bad.status).toBe(400);
  });

  it("lists a project's signals by the page's filter chips", async () => {
    core.listSignals.mockResolvedValue({ signals: [], total: 0 });
    const filters = encodeURIComponent(
      JSON.stringify([
        { field: "status", op: "in", value: ["open", "resolved"] },
        { field: "detector", op: "in", value: ["Failure"] },
        { field: "title", op: "contains", value: " timeout " },
        { field: "signal_id", op: "eq", value: "s9" },
      ]),
    );
    const res = await handleListSignals(
      req(undefined, `?filters=${filters}`),
      params({ projectId: "p1" }),
    );
    expect(res.status).toBe(200);
    expect(core.listSignals).toHaveBeenCalledWith(expect.objectContaining({ tag: "prisma" }), {
      projectId: "p1",
      detectorNames: ["Failure"],
      statuses: ["open", "resolved"],
      title: "timeout",
      signalId: "s9",
      page: 0,
      limit: 50,
    });
    for (const bad of [
      "?filters=not-json",
      `?filters=${encodeURIComponent(JSON.stringify([{ field: "cost", op: "gt", value: 1 }]))}`,
      `?filters=${encodeURIComponent(JSON.stringify([{ field: "status", op: "in", value: ["closed"] }]))}`,
    ]) {
      expect(
        (await handleListSignals(req(undefined, bad), params({ projectId: "p1" }))).status,
      ).toBe(400);
    }
    core.requireProjectAccess.mockResolvedValueOnce({ error: Response.json({}, { status: 403 }) });
    expect((await handleListSignals(req(), params({ projectId: "p1" }))).status).toBe(403);
  });

  it("counts each listed signal's hits in the page's window, and rejects a bad window", async () => {
    core.listSignals.mockResolvedValue({ signals: [], total: 0 });
    await handleListSignals(
      req(undefined, "?start_after=2026-09-24T00:00:00.000Z&end_before=2026-10-01T00:00:00.000Z"),
      params({ projectId: "p1" }),
    );
    expect(core.listSignals).toHaveBeenLastCalledWith(expect.objectContaining({ tag: "prisma" }), {
      projectId: "p1",
      hitsIn: {
        from: new Date("2026-09-24T00:00:00.000Z"),
        to: new Date("2026-10-01T00:00:00.000Z"),
      },
      page: 0,
      limit: 50,
    });
    for (const bad of [
      "?start_after=yesterday",
      "?start_after=2026-10-01T00:00:00Z&end_before=2026-09-01T00:00:00Z",
      // 2026-02-30 does not exist; a lenient parser would roll it into March.
      "?start_after=2026-02-30T00:00:00Z&end_before=2026-10-01T00:00:00Z",
    ]) {
      expect(
        (await handleListSignals(req(undefined, bad), params({ projectId: "p1" }))).status,
      ).toBe(400);
    }
  });

  it("defaults a missing start to seven days before the given end", async () => {
    core.listSignals.mockResolvedValue({ signals: [], total: 0 });
    await handleListSignals(
      req(undefined, "?end_before=2026-10-01T00:00:00.000Z"),
      params({ projectId: "p1" }),
    );
    expect(core.listSignals).toHaveBeenLastCalledWith(expect.objectContaining({ tag: "prisma" }), {
      projectId: "p1",
      hitsIn: {
        from: new Date("2026-09-24T00:00:00.000Z"),
        to: new Date("2026-10-01T00:00:00.000Z"),
      },
      page: 0,
      limit: 50,
    });
  });

  it("returns one signal with its traces and the detector's other traces per bucket, or 404", async () => {
    const window = {
      from: new Date("2026-09-29T00:00:00.000Z"),
      to: new Date("2026-10-01T00:00:00.000Z"),
      granularity: "hour",
    };
    core.getSignal.mockResolvedValueOnce({
      merged: false,
      signal: { id: "s1", detectorId: "d1" },
      window,
      hitSeries: [
        { bucket: "2026-09-29T08:00", hits: 2 },
        { bucket: "2026-09-29T09:00", hits: 5 },
      ],
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ bucket: "2026-09-29T08:00", count: 10 }] }),
    });
    core.signalsKeyConfigured.mockReturnValue(false);
    const res = await handleGetSignal(
      req(
        undefined,
        "?start_after=2026-09-29T00:00:00.000Z&end_before=2026-10-01T00:00:00.000Z&tz=Asia%2FShanghai",
      ),
      signalParams,
    );
    expect(await res.json()).toMatchObject({
      signal: { id: "s1" },
      // Without the key the panel offers no RCA.
      grouping: false,
      // A bucket without traces counts none; a hit counted before its run row cannot go negative.
      hitSeries: [
        { bucket: "2026-09-29T08:00", hits: 2, unaffected: 8 },
        { bucket: "2026-09-29T09:00", hits: 5, unaffected: 0 },
      ],
    });
    expect(core.getSignal).toHaveBeenCalledWith(expect.objectContaining({ tag: "prisma" }), {
      projectId: "p1",
      signalId: "s1",
      from: window.from,
      to: window.to,
      tz: "Asia/Shanghai",
    });
    const [url, init] = mockFetch.mock.calls[0];
    const sent = new URL(url);
    expect(sent.pathname).toBe("/api/v1/internal/trace-counts");
    expect(Object.fromEntries(sent.searchParams)).toEqual({
      project_id: "p1",
      detector_id: "d1",
      start_after: "2026-09-29T00:00:00.000Z",
      end_before: "2026-10-01T00:00:00.000Z",
      granularity: "hour",
      tz: "Asia/Shanghai",
    });
    expect(init.headers["X-Internal-Secret"]).toBe("sec");

    core.getSignal.mockResolvedValueOnce(null);
    expect((await handleGetSignal(req(), signalParams)).status).toBe(404);
    for (const bad of ["?tz=Mars%2FBase", "?start_after=soon"]) {
      expect((await handleGetSignal(req(undefined, bad), signalParams)).status).toBe(400);
    }
  });

  it("joins the two real hours of a DST fall-back night to their own counts, not each other's", async () => {
    // core's hitSeries (Postgres) and the backend's trace-counts (ClickHouse) both key
    // an hour bucket with its local hour's UTC offset; the join below is a plain
    // Map.get(b.bucket), so this only passes if both sides format that suffix the
    // same way for the SAME ambiguous hour.
    core.getSignal.mockResolvedValueOnce({
      merged: false,
      signal: { id: "s1", detectorId: "d1" },
      window: {
        from: new Date("2026-11-01T05:00:00.000Z"),
        to: new Date("2026-11-01T07:00:00.000Z"),
        granularity: "hour",
      },
      hitSeries: [
        { bucket: "2026-11-01T01:00-04:00", hits: 2 },
        { bucket: "2026-11-01T01:00-05:00", hits: 1 },
      ],
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { bucket: "2026-11-01T01:00-04:00", count: 9 },
          { bucket: "2026-11-01T01:00-05:00", count: 4 },
        ],
      }),
    });
    const res = await handleGetSignal(
      req(
        undefined,
        "?start_after=2026-11-01T05:00:00.000Z&end_before=2026-11-01T07:00:00.000Z&tz=America%2FNew_York",
      ),
      signalParams,
    );
    expect(await res.json()).toMatchObject({
      hitSeries: [
        { bucket: "2026-11-01T01:00-04:00", hits: 2, unaffected: 7 },
        { bucket: "2026-11-01T01:00-05:00", hits: 1, unaffected: 3 },
      ],
    });
  });

  it("still returns the signal's own traces per bucket when the backend is down", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    core.getSignal.mockResolvedValueOnce({
      merged: false,
      signal: { id: "s1", detectorId: "d1" },
      window: { from: new Date(0), to: new Date(86_400_000 * 7), granularity: "day" },
      hitSeries: [{ bucket: "2026-09-30", hits: 3 }],
    });
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });
    const res = await handleGetSignal(req(), signalParams);
    expect(await res.json()).toMatchObject({
      hitSeries: [{ bucket: "2026-09-30", hits: 3, unaffected: null }],
    });
    expect(core.getSignal).toHaveBeenCalledWith(
      expect.objectContaining({ tag: "prisma" }),
      expect.objectContaining({ tz: "UTC" }),
    );
    error.mockRestore();
  });

  it("returns a trace's signals and the named detectors' signals settings", async () => {
    core.signalsForTrace.mockResolvedValue([{ runId: "r1" }]);
    core.detectorSignalSettings.mockResolvedValue([{ id: "d1", enableSignals: true }]);
    core.signalsKeyConfigured.mockReturnValue(true);
    const res = await handleTraceSignals(
      req(undefined, "?detector_ids=d1,d2,d1,"),
      params({ projectId: "p1", traceId: "t1" }),
    );
    expect(await res.json()).toEqual({
      hits: [{ runId: "r1" }],
      detectors: [{ id: "d1", enableSignals: true }],
      grouping: true,
    });
    expect(core.signalsForTrace).toHaveBeenCalledWith(expect.anything(), {
      projectId: "p1",
      traceId: "t1",
    });
    expect(core.detectorSignalSettings).toHaveBeenCalledWith(expect.anything(), {
      projectId: "p1",
      detectorIds: ["d1", "d2"],
    });
  });

  it("refuses too many detector ids", async () => {
    const ids = Array.from({ length: 201 }, (_, i) => `d${i}`).join(",");
    const res = await handleTraceSignals(
      req(undefined, `?detector_ids=${ids}`),
      params({ projectId: "p1", traceId: "t1" }),
    );
    expect(res.status).toBe(400);
    expect(core.signalsForTrace).not.toHaveBeenCalled();
  });

  it("returns the project's signal setup", async () => {
    const setup = {
      signalCount: 0,
      detectorCount: 2,
      signalDetectorCount: 1,
      sampledSignalDetectorCount: 0,
    };
    core.signalSetup.mockResolvedValue(setup);
    core.signalsKeyConfigured.mockReturnValue(false);
    const res = await handleSignalSetup(req(), params({ projectId: "p1" }));
    expect(await res.json()).toEqual({ ...setup, grouping: false });
    expect(core.signalSetup).toHaveBeenCalledWith(expect.anything(), "p1");
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
      expect.objectContaining({ tag: "prisma" }),
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
    const assignedAt = new Date("2026-09-30T10:00:00.123Z");
    core.mergeSignals.mockResolvedValue({
      ok: true,
      moved: { projectId: "p1", detectorId: "d1", signalId: "s2", assignedAt, runIds },
    });
    const res = await handleMergeSignal(req({ targetSignalId: "s2" }), signalParams);
    expect(await res.json()).toEqual({ mergedInto: "s2", movedHits: 1500 });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("http://localhost:8000/api/v1/internal/signals/reassign");
    expect(init.headers["X-Internal-Secret"]).toBe("sec");
    const body = JSON.parse(init.body);
    expect(body.run_ids).toHaveLength(1000);
    // The placement time orders the rewrites of concurrent edits.
    expect(body).toMatchObject({ signal_id: "s2", assigned_at_ms: assignedAt.getTime() });
    expect(core.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ tag: "prisma" }),
      expect.objectContaining({ operation: "merge_signal", summary: { into: "s2", hits: 1500 } }),
    );
  });

  it("keeps a merge when the ClickHouse rewrite fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mockFetch.mockResolvedValue({ ok: false, status: 503 });
    core.mergeSignals.mockResolvedValue({
      ok: true,
      moved: {
        projectId: "p1",
        detectorId: "d1",
        signalId: "s2",
        assignedAt: new Date(),
        runIds: ["r1"],
      },
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
      moved: {
        projectId: "p1",
        detectorId: "d1",
        signalId: "s2",
        assignedAt: new Date(),
        runIds: ["r1"],
      },
    });
    const hitParams = params({ projectId: "p1", runId: "r1" });
    expect((await handleMoveHit(req({ signalId: "s2" }), hitParams)).status).toBe(200);
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(core.writeAudit).toHaveBeenCalledOnce();

    core.moveHit.mockResolvedValueOnce({
      ok: true,
      moved: {
        projectId: "p1",
        detectorId: "d1",
        signalId: "s2",
        assignedAt: new Date(),
        runIds: [],
      },
    });
    await handleMoveHit(req({ signalId: "s2" }), hitParams);
    expect(core.writeAudit).toHaveBeenCalledOnce();
    expect((await handleMoveHit(req({}), hitParams)).status).toBe(400);
    core.moveHit.mockResolvedValueOnce({ ok: false, status: 404, error: "Hit not found" });
    expect((await handleMoveHit(req({ signalId: "s2" }), hitParams)).status).toBe(404);
  });
});

describe("hand-run RCA", () => {
  it("records the request as a member and audits it", async () => {
    core.signalsKeyConfigured.mockReturnValue(true);
    core.requestSignalRca.mockResolvedValue({ ok: true, findingId: "f1" });
    const res = await handleRequestSignalRca(req(), signalParams);
    expect(await res.json()).toEqual({ status: "pending" });
    expect(core.requireProjectAccess).toHaveBeenCalledWith("u1", "p1", "MEMBER");
    expect(core.requestSignalRca).toHaveBeenCalledWith(expect.anything(), {
      projectId: "p1",
      signalId: "s1",
    });
    expect(core.writeAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ operation: "request_signal_rca", resourceId: "s1" }),
    );
  });

  it("refuses when the deployment cannot run signal RCAs", async () => {
    core.signalsKeyConfigured.mockReturnValue(false);
    const res = await handleRequestSignalRca(req(), signalParams);
    expect(res.status).toBe(409);
    expect(core.requestSignalRca).not.toHaveBeenCalled();
  });

  it("passes a refusal through without auditing", async () => {
    core.signalsKeyConfigured.mockReturnValue(true);
    core.requestSignalRca.mockResolvedValue({ ok: false, status: 409, error: "no hits" });
    const res = await handleRequestSignalRca(req(), signalParams);
    expect(res.status).toBe(409);
    expect(core.writeAudit).not.toHaveBeenCalled();
  });
});
