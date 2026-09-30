import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockAdd } = vi.hoisted(() => ({ mockAdd: vi.fn() }));
vi.mock("bullmq", () => ({
  Queue: class {
    add = mockAdd;
  },
}));
vi.mock("../../../queues/detector-run-queue.js", () => ({
  DETECTOR_RCA_QUEUE: "detector-rca",
  createRedisConnection: () => ({}),
}));

import {
  enqueueSignalRca,
  hasUncoveredOpenings,
  loadSignalRcaContext,
  sweepSignalRcas,
} from "../rca.js";

const T0 = Date.parse("2026-09-30T10:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  mockAdd.mockResolvedValue(undefined);
});

describe("enqueueSignalRca", () => {
  it("adds one delayed RCA job per finding that is removed when done", async () => {
    await enqueueSignalRca("f1", "p1");
    expect(mockAdd).toHaveBeenCalledWith(
      "signal-rca-f1",
      { kind: "signals", findingId: "f1", projectId: "p1" },
      expect.objectContaining({
        jobId: "signal-rca-f1",
        delay: 60_000,
        removeOnComplete: true,
        removeOnFail: true,
        attempts: 3,
        backoff: { type: "exponential", delay: 10_000 },
      }),
    );
  });
});

function fakeDb(opts: {
  openings?: {
    signalId: string;
    reopenSeq: number;
    signal: { title: string; detectorId: string };
  }[];
  hits?: { detectorId: string; traceId: string; seenAt: Date }[];
  project?: { workspaceId: string } | null;
  detectors?: { id: string; name: string }[];
}) {
  return {
    signalRca: { findMany: vi.fn(async () => opts.openings ?? []) },
    signalHit: { findMany: vi.fn(async () => opts.hits ?? []) },
    project: {
      findUnique: vi.fn(async () =>
        opts.project === undefined ? { workspaceId: "ws" } : opts.project,
      ),
    },
    detector: { findMany: vi.fn(async () => opts.detectors ?? []) },
  };
}

describe("loadSignalRcaContext", () => {
  const openings = [
    { signalId: "s1", reopenSeq: 0, signal: { title: "Timeout swallowed", detectorId: "d1" } },
    { signalId: "s2", reopenSeq: 3, signal: { title: "Wrong city", detectorId: "d2" } },
  ];
  // Hits carry no signal: openings pair with them by detector.
  const hits = [
    { detectorId: "d1", traceId: "t1", seenAt: new Date(T0 + 5) },
    { detectorId: "d2", traceId: "t1", seenAt: new Date(T0) },
  ];
  const payload = JSON.stringify([
    { detectorId: "d1", summary: "the tool timed out" },
    { detectorId: "d3", summary: "not a signal hit" },
  ]);

  it("lists each hit that opened a signal, with its detector's summary and the signal title", async () => {
    const db = fakeDb({ openings, hits, detectors: [{ id: "d1", name: "Failure" }] });
    const backend = {
      traceFindings: vi.fn(async () => [
        { finding_id: "f1", payload },
        { finding_id: "other", payload: "[]" },
      ]),
    };
    const ctx = await loadSignalRcaContext(db as never, backend, "f1", "p1");
    expect(ctx).toEqual({
      traceId: "t1",
      workspaceId: "ws",
      findingTimestamp: T0,
      findings: [
        {
          detectorId: "d1",
          detectorName: "Failure",
          summary: "the tool timed out",
          signalTitle: "Timeout swallowed",
        },
        // A deleted detector and a missing payload entry still get a section.
        {
          detectorId: "d2",
          detectorName: "deleted detector",
          summary: "Wrong city",
          signalTitle: "Wrong city",
        },
      ],
      covered: ["s1:0", "s2:3"],
    });
    expect(db.signalRca.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { findingId: "f1", signal: { projectId: "p1" } } }),
    );
    expect(db.signalHit.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { findingId: "f1", projectId: "p1" } }),
    );
    expect(backend.traceFindings).toHaveBeenCalledWith("p1", "t1");
  });

  it("is null when no signal of the finding needs an RCA, or its hits or project are gone", async () => {
    const backend = { traceFindings: vi.fn(async () => []) };
    expect(await loadSignalRcaContext(fakeDb({}) as never, backend, "f1", "p1")).toBe(null);
    expect(await loadSignalRcaContext(fakeDb({ openings }) as never, backend, "f1", "p1")).toBe(
      null,
    );
    expect(
      await loadSignalRcaContext(
        fakeDb({ openings, hits, project: null }) as never,
        backend,
        "f1",
        "p1",
      ),
    ).toBe(null);
  });

  it("analyses a hit once, even when a merge left two openings for its detector", async () => {
    const merged = [
      ...openings,
      { signalId: "s9", reopenSeq: -1, signal: { title: "Merged in", detectorId: "d1" } },
    ];
    const backend = { traceFindings: vi.fn(async () => []) };
    const ctx = await loadSignalRcaContext(
      fakeDb({ openings: merged, hits }) as never,
      backend,
      "f1",
      "p1",
    );
    expect(ctx?.findings.map((f) => f.detectorId)).toEqual(["d1", "d2"]);
    expect(ctx?.covered).toEqual(["s1:0", "s2:3", "s9:-1"]);
  });

  it("falls back to signal titles when the finding payload is malformed", async () => {
    const backend = { traceFindings: vi.fn(async () => [{ finding_id: "f1", payload: "{oops" }]) };
    const ctx = await loadSignalRcaContext(
      fakeDb({ openings, hits }) as never,
      backend,
      "f1",
      "p1",
    );
    expect(ctx?.findings.map((f) => f.summary)).toEqual(["Timeout swallowed", "Wrong city"]);
  });
});

describe("hasUncoveredOpenings", () => {
  it("reports openings a run did not cover", async () => {
    const db = {
      signalRca: {
        findMany: vi.fn(async () => [
          { signalId: "s1", reopenSeq: 0 },
          { signalId: "s2", reopenSeq: 1 },
        ]),
      },
    };
    expect(await hasUncoveredOpenings(db as never, "f1", ["s1:0", "s2:1"])).toBe(false);
    expect(await hasUncoveredOpenings(db as never, "f1", ["s1:0"])).toBe(true);
    expect(db.signalRca.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { findingId: "f1" } }),
    );
  });
});

describe("sweepSignalRcas", () => {
  it("re-enqueues RCAs pending for more than ten minutes, within the lookback", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const db = {
      signalRca: { findMany: vi.fn(async () => [{ findingId: "f1", rca: { projectId: "p1" } }]) },
    };
    expect(await sweepSignalRcas(db as never, T0)).toBe(1);
    expect(db.signalRca.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          createTime: { gt: new Date(T0 - 7 * 24 * 3_600_000), lt: new Date(T0 - 600_000) },
          rca: { status: "pending" },
        },
        distinct: ["findingId"],
      }),
    );
    expect(mockAdd).toHaveBeenCalledWith(
      "signal-rca-f1",
      expect.anything(),
      expect.objectContaining({ delay: 0 }),
    );
    log.mockRestore();
  });
});
