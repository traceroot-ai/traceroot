import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("next/server", () => ({
  NextRequest: class {},
  NextResponse: {
    json: (data: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => data,
    }),
  },
}));

const { db, listSignalsMock, verifyMock } = vi.hoisted(() => ({
  db: {
    signal: { findFirst: vi.fn() },
    signalHit: { findMany: vi.fn() },
    detector: { findFirst: vi.fn() },
    project: { findUnique: vi.fn() },
  },
  listSignalsMock: vi.fn(),
  verifyMock: vi.fn(),
}));
// Spread from the real module so the plan table and its retention days are the shipped ones.
vi.mock("@traceroot/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@traceroot/core")>()),
  prisma: db,
}));
vi.mock("@traceroot/core/signals", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@traceroot/core/signals")>()),
  listSignals: (...args: unknown[]) => listSignalsMock(...args),
}));
vi.mock("@/lib/auth-helpers", () => ({
  verifyInternalSecret: (...args: unknown[]) => verifyMock(...args),
}));

import { handleInternalSignalRead } from "./internal-read";

const T0 = new Date("2026-10-14T10:00:00.000Z");
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const request = (body: unknown) =>
  ({ json: async () => body }) as unknown as Parameters<typeof handleInternalSignalRead>[0];

const SIGNAL_ROW = {
  id: "sig-1",
  detectorId: "det-1",
  title: "t",
  status: "open",
  hitCount: 3,
  reopenSeq: 0,
  firstSeenAt: T0,
  lastSeenAt: T0,
  createTime: T0,
  resolvedAt: null,
  mergedIntoId: null,
  rcas: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  verifyMock.mockReturnValue(true);
  db.project.findUnique.mockResolvedValue({ workspace: { billingPlan: "free" } });
  db.signalHit.findMany.mockResolvedValue([]);
});

describe("POST /api/internal/project-signals", () => {
  it("rejects a caller without the internal secret", async () => {
    verifyMock.mockReturnValue(false);
    const res = await handleInternalSignalRead(request({ projectId: "p1" }));
    expect(res.status).toBe(401);
    expect(listSignalsMock).not.toHaveBeenCalled();
  });

  it.each([{}, { projectId: "" }])("rejects missing project scope %j", async (body) => {
    expect((await handleInternalSignalRead(request(body))).status).toBe(400);
  });

  it("rejects invalid JSON", async () => {
    const req = request({});
    req.json = async () => {
      throw new SyntaxError("invalid");
    };
    expect((await handleInternalSignalRead(req)).status).toBe(400);
  });

  it("defaults the limit and clamps the upper page bound", async () => {
    listSignalsMock.mockResolvedValue({ signals: [], total: 0 });
    await handleInternalSignalRead(request({ projectId: "p1", page: 99999 }));
    expect(listSignalsMock).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ limit: 50, page: 10000 }),
    );
  });

  it("refuses an unknown status filter", async () => {
    const res = await handleInternalSignalRead(request({ projectId: "p1", status: "closed" }));
    expect(res.status).toBe(400);
  });

  it("lists with the filters, clamped paging, and camelCase rows", async () => {
    listSignalsMock.mockResolvedValue({
      total: 1,
      signals: [
        {
          id: "sig-1",
          detectorId: "det-1",
          detectorName: "Tool failures",
          title: "Invokes a tool with an invalid date input",
          status: "open",
          hitCount: 4,
          reopenSeq: 1,
          firstSeenAt: T0,
          lastSeenAt: T0,
          createTime: T0,
          criteriaVersion: 1,
          groupKey: null,
          rca: { currentState: "done", canonicalFindingId: "f1" },
        },
      ],
    });
    const res = await handleInternalSignalRead(
      request({ projectId: "p1", status: "open", detectorId: "det-1", limit: 999, page: -1 }),
    );
    expect(listSignalsMock).toHaveBeenCalledWith(db, {
      projectId: "p1",
      detectorIds: ["det-1"],
      statuses: ["open"],
      page: 0,
      limit: 200,
    });
    expect(await res.json()).toEqual({
      signals: [
        {
          id: "sig-1",
          detectorId: "det-1",
          detectorName: "Tool failures",
          title: "Invokes a tool with an invalid date input",
          status: "open",
          hitCount: 4,
          reopenCount: 1,
          firstSeenAt: T0.toISOString(),
          lastSeenAt: T0.toISOString(),
          createTime: T0.toISOString(),
          rcaState: "done",
        },
      ],
      meta: { page: 0, limit: 200, total: 1 },
    });
  });

  it("fetches one signal scoped to the project, merged ones included", async () => {
    db.signal.findFirst.mockResolvedValue({
      id: "sig-1",
      detectorId: "det-1",
      title: "t",
      status: "resolved",
      hitCount: 3,
      reopenSeq: 0,
      firstSeenAt: T0,
      lastSeenAt: T0,
      createTime: T0,
      resolvedAt: T0,
      mergedIntoId: "sig-2",
      rcas: [
        { reopenSeq: 0, rca: { status: "done" } },
        { reopenSeq: 1, rca: { status: "queued" } },
      ],
    });
    db.detector.findFirst.mockResolvedValue(null);
    const res = await handleInternalSignalRead(request({ projectId: "p1", signalId: "sig-1" }));
    expect(db.signal.findFirst.mock.calls[0][0].where).toEqual({ id: "sig-1", projectId: "p1" });
    expect(res.status).toBe(200);
    expect((await res.json()).signal).toMatchObject({
      id: "sig-1",
      detectorName: null,
      status: "resolved",
      resolvedAt: T0.toISOString(),
      mergedIntoId: "sig-2",
      rcaState: "done",
    });
  });

  describe("recent hits", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(T0);
      db.signal.findFirst.mockResolvedValue(SIGNAL_ROW);
      db.detector.findFirst.mockResolvedValue({ name: "Tool failures" });
    });
    afterEach(() => vi.useRealTimers());

    /** Read sig-1 and return the hit query's trace start filter and the response body. */
    async function readHits() {
      const res = await handleInternalSignalRead(request({ projectId: "p1", signalId: "sig-1" }));
      expect(res.status).toBe(200);
      const [args] = db.signalHit.findMany.mock.calls[0];
      return { args, signal: (await res.json()).signal };
    }

    it("returns the 20 latest hits by trace start, each with its trace and finding", async () => {
      db.signalHit.findMany.mockResolvedValue([
        { runId: "r2", traceId: "t2", findingId: "f2", traceStartTime: T0 },
        { runId: "r1", traceId: "t1", findingId: "f1", traceStartTime: new Date(0) },
      ]);
      const { args, signal } = await readHits();
      expect(args).toMatchObject({
        where: { signalId: "sig-1" },
        orderBy: [{ traceStartTime: "desc" }, { runId: "asc" }],
        take: 20,
      });
      expect(signal.recentHits).toEqual([
        { traceId: "t2", findingId: "f2", traceStartTime: T0.toISOString() },
        { traceId: "t1", findingId: "f1", traceStartTime: "1970-01-01T00:00:00.000Z" },
      ]);
    });

    it.each([
      ["free", 15],
      ["starter", 30],
      ["pro", 90],
    ])("bounds a %s workspace's hits by its %i-day retention cutoff", async (plan, days) => {
      db.project.findUnique.mockResolvedValue({ workspace: { billingPlan: plan } });
      const { args } = await readHits();
      expect(db.project.findUnique).toHaveBeenCalledWith({
        where: { id: "p1" },
        select: { workspace: { select: { billingPlan: true } } },
      });
      expect(args.where.traceStartTime).toEqual({
        not: null,
        gte: new Date(T0.getTime() - days * DAY_MS - HOUR_MS),
      });
    });

    it("reads an unlimited plan's hits with no lower bound", async () => {
      db.project.findUnique.mockResolvedValue({ workspace: { billingPlan: "enterprise" } });
      const { args } = await readHits();
      expect(args.where.traceStartTime).toEqual({ not: null });
    });

    it.each([null, { workspace: null }, { workspace: { billingPlan: "" } }])(
      "falls back to the most restrictive plan when the workspace can't be read (%j)",
      async (project) => {
        db.project.findUnique.mockResolvedValue(project);
        const { args } = await readHits();
        expect(args.where.traceStartTime).toEqual({
          not: null,
          gte: new Date(T0.getTime() - 15 * DAY_MS - HOUR_MS),
        });
      },
    );
  });

  it("answers 404 for a signal outside the project", async () => {
    db.signal.findFirst.mockResolvedValue(null);
    const res = await handleInternalSignalRead(request({ projectId: "p1", signalId: "sig-x" }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Signal not found" });
  });
});
