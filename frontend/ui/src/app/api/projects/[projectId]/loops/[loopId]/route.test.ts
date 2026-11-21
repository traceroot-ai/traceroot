import { describe, it, expect, vi, beforeEach } from "vitest";
import { LOOP_RUN_PAUSED, LOOP_RUN_PLAN_BLOCKED } from "@traceroot/core/loops/pure";

vi.mock("@/lib/support/route-guard", () => ({
  withImpersonationPolicy: (handler: unknown) => handler,
}));
vi.mock("next/server", () => ({ NextRequest: class {} }));
const env = vi.hoisted(() => ({ LOOPS_ENABLED: "true" }));
vi.mock("@/env", () => ({ env }));

const requireAuthMock = vi.fn();
const requireProjectAccessMock = vi.fn();
vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
  requireProjectAccess: (...args: unknown[]) => requireProjectAccessMock(...args),
  errorResponse: (message: string, status: number) => Response.json({ error: message }, { status }),
  successResponse: (data: unknown, status = 200) => Response.json(data, { status }),
}));

const prismaMock = vi.hoisted(() => ({
  loop: { findFirst: vi.fn() },
}));
const getLoopSummaryMock = vi.fn();
const listLoopRunsMock = vi.fn();
const getLoopRunMock = vi.fn();
const listMemoryMock = vi.fn();
vi.mock("@traceroot/core", () => ({ prisma: prismaMock, Role: { MEMBER: "MEMBER" } }));
vi.mock("@traceroot/core/loops", () => ({
  listLoops: vi.fn(),
  getLoopSummary: (...a: unknown[]) => getLoopSummaryMock(...a),
  listLoopRuns: (...a: unknown[]) => listLoopRunsMock(...a),
  getLoopRun: (...a: unknown[]) => getLoopRunMock(...a),
  listMemory: (...a: unknown[]) => listMemoryMock(...a),
}));
const updateLoopMock = vi.fn();
const deleteLoopMock = vi.fn();
const setLoopStatusMock = vi.fn();
const requestLoopRunMock = vi.fn();
vi.mock("@/lib/write-services/loops", () => ({
  createLoop: vi.fn(),
  updateLoop: (...a: unknown[]) => updateLoopMock(...a),
  deleteLoop: (...a: unknown[]) => deleteLoopMock(...a),
  setLoopStatus: (...a: unknown[]) => setLoopStatusMock(...a),
  requestLoopRun: (...a: unknown[]) => requestLoopRunMock(...a),
}));

import * as listRoute from "../route";
import * as loopRoute from "./route";
import * as statusRoute from "./status/route";
import * as runRoute from "./run/route";
import * as runsRoute from "./runs/route";
import * as runOneRoute from "./runs/[runId]/route";
import * as memoryRoute from "../../loop-memory/route";

const params = { params: Promise.resolve({ projectId: "proj-1", loopId: "loop-1" }) };
const projectParams = { params: Promise.resolve({ projectId: "proj-1" }) };
const runParams = {
  params: Promise.resolve({ projectId: "proj-1", loopId: "loop-1", runId: "run-1" }),
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const req = (query = "", body?: unknown): any => ({
  nextUrl: new URL(`http://x/api${query}`),
  json: async () => body,
});

beforeEach(() => {
  vi.resetAllMocks();
  env.LOOPS_ENABLED = "true";
  requireAuthMock.mockResolvedValue({ user: { id: "user-1" } });
  requireProjectAccessMock.mockResolvedValue({
    project: { id: "proj-1", workspaceId: "ws-1", name: "P" },
  });
  prismaMock.loop.findFirst.mockResolvedValue({ id: "loop-1", detectorId: "det-1" });
});

describe("LOOPS_ENABLED off", () => {
  const handlers = [
    ["loops GET", () => listRoute.GET(req(), params)],
    ["loops POST", () => listRoute.POST(req("", { name: "x" }), params)],
    ["[loopId] GET", () => loopRoute.GET(req(), params)],
    ["[loopId] PATCH", () => loopRoute.PATCH(req("", { dryRun: true }), params)],
    ["[loopId] DELETE", () => loopRoute.DELETE(req("", { reason: "r" }), params)],
    ["status POST", () => statusRoute.POST(req("", { action: "pause" }), params)],
    ["run POST", () => runRoute.POST(req(), params)],
    ["runs GET", () => runsRoute.GET(req(), params)],
    ["runs/[runId] GET", () => runOneRoute.GET(req(), runParams)],
    ["loop-memory GET", () => memoryRoute.GET(req(), projectParams)],
  ] as const;

  it.each(handlers)("%s answers 404 before any auth", async (_name, call) => {
    env.LOOPS_ENABLED = "false";
    expect((await call()).status).toBe(404);
    expect(requireAuthMock).not.toHaveBeenCalled();
  });
});

describe("a Loop outside the project", () => {
  const handlers = [
    ["[loopId] GET", () => loopRoute.GET(req(), params)],
    ["[loopId] PATCH", () => loopRoute.PATCH(req("", { dryRun: true }), params)],
    ["[loopId] DELETE", () => loopRoute.DELETE(req("", { reason: "r" }), params)],
    ["status POST", () => statusRoute.POST(req("", { action: "pause" }), params)],
    ["run POST", () => runRoute.POST(req(), params)],
    ["runs GET", () => runsRoute.GET(req(), params)],
    ["runs/[runId] GET", () => runOneRoute.GET(req(), runParams)],
  ] as const;

  it.each(handlers)("%s answers 404 without reading or writing it", async (_name, call) => {
    prismaMock.loop.findFirst.mockResolvedValue(null);
    const res = await call();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Loop not found" });
    expect(prismaMock.loop.findFirst).toHaveBeenCalledWith({
      where: { id: "loop-1", projectId: "proj-1" },
      select: { id: true, detectorId: true },
    });
    for (const service of [
      getLoopSummaryMock,
      updateLoopMock,
      deleteLoopMock,
      setLoopStatusMock,
      requestLoopRunMock,
      listLoopRunsMock,
      getLoopRunMock,
    ]) {
      expect(service).not.toHaveBeenCalled();
    }
  });
});

describe("GET/PATCH/DELETE .../loops/[loopId]", () => {
  it("GET answers 404 for a Loop outside the project", async () => {
    getLoopSummaryMock.mockResolvedValue(null);
    expect((await loopRoute.GET(req(), params)).status).toBe(404);
    expect(getLoopSummaryMock).toHaveBeenCalledWith(prismaMock, "proj-1", "loop-1");
  });

  it("PATCH hands the patch to the service as a MEMBER ui write and reports what changed", async () => {
    updateLoopMock.mockResolvedValue({ ok: true, data: { id: "loop-1" }, changed: ["dry_run"] });
    const res = await loopRoute.PATCH(req("", { dryRun: true }), params);
    expect(requireProjectAccessMock).toHaveBeenCalledWith("user-1", "proj-1", "MEMBER");
    expect(await res.json()).toEqual({ loop: { id: "loop-1" }, changed: ["dry_run"] });
    expect(updateLoopMock).toHaveBeenCalledWith({
      actorUserId: "user-1",
      projectId: "proj-1",
      loopId: "loop-1",
      patch: { dryRun: true },
      provenance: { transport: "ui" },
    });
  });

  it("DELETE records the web app's default reason", async () => {
    deleteLoopMock.mockResolvedValue({ ok: true, data: { id: "loop-1", name: "x" }, reason: "r" });
    const res = await loopRoute.DELETE({ json: async () => ({}) } as never, params);
    expect(res.status).toBe(200);
    expect(deleteLoopMock).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "Deleted from the web app" }),
    );
  });
});

describe("POST .../status", () => {
  it("passes pause and resume through and refuses anything else", async () => {
    setLoopStatusMock.mockResolvedValue({ ok: true, data: { id: "loop-1" }, changed: ["status"] });
    expect((await statusRoute.POST(req("", { action: "pause" }), params)).status).toBe(200);
    expect(setLoopStatusMock).toHaveBeenCalledWith(expect.objectContaining({ action: "pause" }));
    const bad = await statusRoute.POST(req("", { action: "delete" }), params);
    expect(bad.status).toBe(400);
    expect(setLoopStatusMock).toHaveBeenCalledTimes(1);
  });
});

describe("POST .../run", () => {
  it("answers 201 with the queued run, or the service's 409 while one is running", async () => {
    requestLoopRunMock.mockResolvedValueOnce({
      ok: true,
      created: true,
      data: { id: "r1", status: "pending" },
    });
    const ok = await runRoute.POST(req(), params);
    expect(ok.status).toBe(201);
    expect(await ok.json()).toEqual({ run: { id: "r1", status: "pending" } });
    requestLoopRunMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      error: "This loop already has a run in progress",
    });
    expect((await runRoute.POST(req(), params)).status).toBe(409);
  });

  it("passes a paused or plan-blocked refusal through with its reason", async () => {
    for (const error of [LOOP_RUN_PAUSED, LOOP_RUN_PLAN_BLOCKED]) {
      requestLoopRunMock.mockResolvedValueOnce({ ok: false, status: 409, error });
      const res = await runRoute.POST(req(), params);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error });
    }
  });
});

describe("GET .../runs", () => {
  it("lists with a status filter and refuses an unknown one", async () => {
    listLoopRunsMock.mockResolvedValue({ data: [], meta: { page: 0, limit: 50, total: 0 } });
    await runsRoute.GET(req("?status=failed&limit=5"), params);
    expect(listLoopRunsMock).toHaveBeenCalledWith(prismaMock, {
      projectId: "proj-1",
      loop: { id: "loop-1", detectorId: "det-1" },
      page: 0,
      limit: 5,
      status: "failed",
      signalId: null,
    });
    expect((await runsRoute.GET(req("?status=exploded"), params)).status).toBe(400);
  });

  it("hands a signal_id to the read, which narrows to that signal's runs", async () => {
    listLoopRunsMock.mockResolvedValue({ data: [], meta: { page: 0, limit: 50, total: 0 } });
    await runsRoute.GET(req("?signal_id=sig-1"), params);
    expect(listLoopRunsMock).toHaveBeenCalledWith(
      prismaMock,
      expect.objectContaining({ signalId: "sig-1" }),
    );
  });
});

describe("GET .../runs/[runId]", () => {
  it("answers 404 for a run of another Loop", async () => {
    getLoopRunMock.mockResolvedValue(null);
    expect((await runOneRoute.GET(req(), runParams)).status).toBe(404);
    expect(getLoopRunMock).toHaveBeenCalledWith(prismaMock, "loop-1", "run-1");
  });
});

describe("GET .../loop-memory", () => {
  it("reads the project's shared memory, hiding expired notes unless asked", async () => {
    listMemoryMock.mockResolvedValue([]);
    await memoryRoute.GET(req(), projectParams);
    expect(prismaMock.loop.findFirst).not.toHaveBeenCalled();
    expect(listMemoryMock).toHaveBeenCalledWith(
      prismaMock,
      expect.objectContaining({ projectId: "proj-1", includeExpired: false }),
    );
    await memoryRoute.GET(req("?include_expired=true"), projectParams);
    expect(listMemoryMock).toHaveBeenLastCalledWith(
      prismaMock,
      expect.objectContaining({ includeExpired: true }),
    );
  });
});
