import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockAdd, mockGetJob } = vi.hoisted(() => ({ mockAdd: vi.fn(), mockGetJob: vi.fn() }));
vi.mock("bullmq", () => ({
  Queue: class {
    add = mockAdd;
    getJob = mockGetJob;
  },
}));
vi.mock("../../../queues/detector-run-queue.js", () => ({
  DETECTOR_RCA_QUEUE: "detector-rca",
  createRedisConnection: () => ({}),
}));

import {
  enqueueSignalRca,
  hasUncoveredOpenings,
  closeEmptySignalRca,
  loadSignalRcaContext,
  sweepSignalRcas,
  rootCausesByOpening,
  RCA_SWEEP_TIMEOUT_RESULT,
} from "../rca.js";
import {
  RCA_SWEEP_EXAMINE_CAP,
  RCA_SWEEP_PAGE_SIZE,
  RCA_SWEEP_START_CAP,
  WAITING_LOOKBACK_MS,
} from "../config.js";

const T0 = Date.parse("2026-09-30T10:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  mockAdd.mockResolvedValue(undefined);
  mockGetJob.mockResolvedValue(undefined);
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
      coveredDetectors: { "s1:0": "d1", "s2:3": "d2" },
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

  it("does not claim analysis coverage for an opening whose hit is gone", async () => {
    const orphan = {
      signalId: "orphan",
      reopenSeq: 0,
      signal: { title: "Removed hit", detectorId: "removed" },
    };
    const db = fakeDb({ openings: [...openings, orphan], hits });
    const ctx = await loadSignalRcaContext(
      db as never,
      { traceFindings: vi.fn(async () => []) },
      "f1",
      "p1",
    );
    expect(ctx?.findings.map((f) => f.detectorId)).toEqual(["d1", "d2"]);
    expect(ctx?.covered).toEqual(["s1:0", "s2:3"]);
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

describe("rootCausesByOpening", () => {
  const ctx = (names: string[]) => ({
    findings: names.map((n, i) => ({
      detectorId: `d${i}`,
      detectorName: n,
      summary: "",
      signalTitle: "",
    })),
    covered: names.map((_, i) => `s${i}:0`),
    coveredDetectors: Object.fromEntries(names.map((_, i) => [`s${i}:0`, `d${i}`])),
  });
  const answer = (...causes: [string, string][]) =>
    "Overview first.\n\n" +
    causes
      .map(([n, c], i) => `### ${i + 1}. ${n}\n- Root cause: ${c}\n- Recommendation: x`)
      .join("\n\n");

  it("takes each hit's section by position, not by a name another name contains", () => {
    const r = answer(["Tool Failure", "parser drops the rate"], ["Failure", "retry loop"]);
    expect(rootCausesByOpening(r, ctx(["Tool Failure", "Failure"]))).toEqual([
      { opening: "s0:0", rootCause: "parser drops the rate" },
      { opening: "s1:0", rootCause: "retry loop" },
    ]);
  });

  it("tells apart two detectors that share a name", () => {
    const r = answer(["Failure", "first cause"], ["Failure", "second cause"]);
    expect(rootCausesByOpening(r, ctx(["Failure", "Failure"])).map((x) => x.rootCause)).toEqual([
      "first cause",
      "second cause",
    ]);
  });

  it("gives no root cause when the answer does not have one section per hit", () => {
    const r = answer(["Failure", "only one section"]);
    expect(rootCausesByOpening(r, ctx(["Failure", "Logic"])).map((x) => x.rootCause)).toEqual([
      null,
      null,
    ]);
  });

  it("reads a single hit's root cause from an answer without headings", () => {
    expect(rootCausesByOpening("- **Root cause:** the key expired", ctx(["Failure"]))).toEqual([
      { opening: "s0:0", rootCause: "the key expired" },
    ]);
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

describe("closeEmptySignalRca", () => {
  it.each([false, true])(
    "guards empty-context cleanup when a matching hit exists: %s",
    async (present) => {
      const tx = {
        $queryRaw: vi
          .fn()
          .mockResolvedValueOnce([{ id: "rca" }])
          .mockResolvedValueOnce(present ? [{ present: 1 }] : []),
        $executeRaw: vi.fn().mockResolvedValue(0),
        detectorRca: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      };
      const db = { $transaction: vi.fn(async (run) => run(tx)) };
      expect(await closeEmptySignalRca(db as never, "f1", "p1")).toBe(!present);
      expect(tx.$queryRaw.mock.calls[0][0].join("")).toContain("FOR NO KEY UPDATE");
      expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        tx.$executeRaw.mock.invocationCallOrder[0],
      );
      if (present) expect(tx.detectorRca.updateMany).not.toHaveBeenCalled();
      else
        expect(tx.detectorRca.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { findingId: "f1", projectId: "p1", status: "pending" },
            data: expect.objectContaining({ status: "failed" }),
          }),
        );
    },
  );
});

describe("sweepSignalRcas", () => {
  // One row per opening, shaped as the sweep selects it.
  const row = (
    findingId: string,
    signalId: string,
    createTime: number,
    reopenSeq = 0,
    projectId = "p1",
  ) => ({ findingId, signalId, reopenSeq, createTime: new Date(createTime), rca: { projectId } });

  function fakeDb(pages: ReturnType<typeof row>[][]) {
    const findMany = vi.fn();
    for (const page of pages) findMany.mockResolvedValueOnce(page);
    findMany.mockResolvedValue([]); // any call past the given pages: no more rows
    return {
      signalRca: { findMany },
      detectorRca: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
  }

  it("starts pending RCAs without a job, newest first, once a round that wrote them has ended", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const db = fakeDb([[row("f1", "s1", T0 - 100_000), row("f2", "s2", T0 - 100_000)]]);
    // f2's job is still waiting or running: left to it.
    mockGetJob.mockImplementation(async (id: string) => (id === "signal-rca-f2" ? {} : undefined));
    expect(await sweepSignalRcas(db as never, T0)).toBe(1);
    expect(db.signalRca.findMany).toHaveBeenCalledTimes(1);
    expect(db.signalRca.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          createTime: { lt: new Date(T0 - 75_000) },
          rca: { status: "pending" },
        },
        orderBy: [{ createTime: "desc" }, { signalId: "desc" }, { reopenSeq: "desc" }],
        take: RCA_SWEEP_PAGE_SIZE,
      }),
    );
    expect(mockAdd).toHaveBeenCalledTimes(1);
    expect(mockAdd).toHaveBeenCalledWith(
      "signal-rca-f1",
      expect.anything(),
      expect.objectContaining({ delay: 0 }),
    );
    expect(db.detectorRca.updateMany).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("pages past a full page of jobs already in flight to start an older, job-less request (S3)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    // A full first page, all with a job, newest first.
    const busy = Array.from({ length: RCA_SWEEP_PAGE_SIZE }, (_, i) =>
      row(`busy-${i}`, `s-${i}`, T0 - 100_000 - i),
    );
    // An older request two days in, within the lookback, with no job: must still be reached and started.
    const starved = row("old-f", "old-s", T0 - 2 * 24 * 3_600_000);
    const db = fakeDb([busy, [starved]]);
    mockGetJob.mockImplementation(async (id: string) =>
      id === "signal-rca-old-f" ? undefined : {},
    );
    expect(await sweepSignalRcas(db as never, T0)).toBe(1);
    expect(db.signalRca.findMany).toHaveBeenCalledTimes(2);
    // The second page's cursor picks up exactly where the first page's last row left off.
    const last = busy[busy.length - 1];
    expect(db.signalRca.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { createTime: { lt: last.createTime } },
            { createTime: last.createTime, signalId: { lt: last.signalId } },
            {
              createTime: last.createTime,
              signalId: last.signalId,
              reopenSeq: { lt: last.reopenSeq },
            },
          ],
        }),
      }),
    );
    expect(mockAdd).toHaveBeenCalledWith(
      "signal-rca-old-f",
      expect.anything(),
      expect.objectContaining({ delay: 0 }),
    );
    log.mockRestore();
  });

  it("gives a job-less request past the lookback an explicit failed end instead of leaving it pending (S2)", async () => {
    const old = row("old-f", "old-s", T0 - WAITING_LOOKBACK_MS - 60_000);
    const db = fakeDb([[old]]);
    mockGetJob.mockResolvedValue(undefined);
    expect(await sweepSignalRcas(db as never, T0)).toBe(0);
    expect(mockAdd).not.toHaveBeenCalled();
    expect(db.detectorRca.updateMany).toHaveBeenCalledWith({
      where: { findingId: "old-f", status: "pending" },
      data: expect.objectContaining({ status: "failed", result: RCA_SWEEP_TIMEOUT_RESULT }),
    });
  });

  it("leaves a request past the lookback alone when its job is still running (not overwritten)", async () => {
    const old = row("old-f", "old-s", T0 - WAITING_LOOKBACK_MS - 60_000);
    const db = fakeDb([[old]]);
    mockGetJob.mockResolvedValue({});
    expect(await sweepSignalRcas(db as never, T0)).toBe(0);
    expect(mockAdd).not.toHaveBeenCalled();
    expect(db.detectorRca.updateMany).not.toHaveBeenCalled();
  });

  it("handles a finding once when several of its openings are pending", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    // Two detector hits on one trace: two openings, one finding, one job.
    const db = fakeDb([[row("f1", "s1", T0 - 100_000), row("f1", "s2", T0 - 100_000)]]);
    expect(await sweepSignalRcas(db as never, T0)).toBe(1);
    expect(mockGetJob).toHaveBeenCalledTimes(1);
    expect(mockAdd).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });

  it("still ends stale requests once it has started as many RCAs as it may", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const fresh = Array.from({ length: RCA_SWEEP_START_CAP }, (_, i) =>
      row(`f${i}`, `s${i}`, T0 - 100_000),
    );
    const stale = row("old", "s-old", T0 - 8 * 24 * 3_600_000);
    const db = fakeDb([[...fresh, stale]]);
    expect(await sweepSignalRcas(db as never, T0)).toBe(RCA_SWEEP_START_CAP);
    expect(db.detectorRca.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { findingId: "old", status: "pending" } }),
    );
    log.mockRestore();
  });

  it("stops after a generously bounded number of examined rows and logs it", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const pageCount = RCA_SWEEP_EXAMINE_CAP / RCA_SWEEP_PAGE_SIZE;
    const pages = Array.from({ length: pageCount }, (_, p) =>
      Array.from({ length: RCA_SWEEP_PAGE_SIZE }, (_, i) =>
        row(`f-${p}-${i}`, `s-${p}-${i}`, T0 - 100_000 - p * RCA_SWEEP_PAGE_SIZE - i),
      ),
    );
    const db = fakeDb(pages);
    mockGetJob.mockResolvedValue({}); // every row already has a job: nothing to start
    expect(await sweepSignalRcas(db as never, T0)).toBe(0);
    expect(db.signalRca.findMany).toHaveBeenCalledTimes(pageCount);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("examining"));
    log.mockRestore();
  });
});
