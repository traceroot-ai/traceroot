import { describe, it, expect, vi, beforeEach } from "vitest";

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
    detector: { findFirst: vi.fn() },
  },
  listSignalsMock: vi.fn(),
  verifyMock: vi.fn(),
}));
vi.mock("@traceroot/core", () => ({ prisma: db }));
vi.mock("@traceroot/core/signals", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@traceroot/core/signals")>()),
  listSignals: (...args: unknown[]) => listSignalsMock(...args),
}));
vi.mock("@/lib/auth-helpers", () => ({
  verifyInternalSecret: (...args: unknown[]) => verifyMock(...args),
}));

import { handleInternalSignalRead } from "./internal-read";

const T0 = new Date("2026-10-14T10:00:00.000Z");
const request = (body: unknown) =>
  ({ json: async () => body }) as unknown as Parameters<typeof handleInternalSignalRead>[0];

beforeEach(() => {
  vi.clearAllMocks();
  verifyMock.mockReturnValue(true);
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

  it("answers 404 for a signal outside the project", async () => {
    db.signal.findFirst.mockResolvedValue(null);
    const res = await handleInternalSignalRead(request({ projectId: "p1", signalId: "sig-x" }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Signal not found" });
  });
});
