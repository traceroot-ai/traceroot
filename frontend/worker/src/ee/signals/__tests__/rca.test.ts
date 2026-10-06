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
  closeEmptySignalRca,
  loadSignalRcaContext,
  settledFindings,
  startSettledRcas,
  sweepSignalRcas,
  rootCausesByOpening,
} from "../rca.js";
import type { UnsettledRunRow } from "../backend-client.js";

const T0 = Date.parse("2026-09-30T10:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  mockAdd.mockResolvedValue(undefined);
});

describe("enqueueSignalRca", () => {
  it("adds one RCA job per finding, without delay, that is removed when done", async () => {
    await enqueueSignalRca("f1", "p1");
    expect(mockAdd).toHaveBeenCalledWith(
      "signal-rca-f1",
      { kind: "signals", findingId: "f1", projectId: "p1" },
      expect.objectContaining({
        jobId: "signal-rca-f1",
        delay: 0,
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

const ON = { enableSignals: true, enableRca: true, signalsEnabledAt: new Date(T0 - 86_400_000) };

function unsettled(findingId: string, runId: string, detectorId = "d1"): UnsettledRunRow {
  return {
    finding_id: findingId,
    run_id: runId,
    detector_id: detectorId,
    timestamp_ms: T0 - 60_000,
  };
}

/** Postgres for the settled check: hits recorded by run id, detectors by id. */
function settleDb(opts: {
  recorded?: string[];
  detectors?: Record<string, typeof ON | undefined>;
  pending?: string[];
}) {
  return {
    signalHit: {
      findMany: vi.fn(async ({ where }: { where: { runId: { in: string[] } } }) =>
        where.runId.in.filter((r) => opts.recorded?.includes(r)).map((runId) => ({ runId })),
      ),
    },
    detector: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.flatMap((id) => {
          const d = (opts.detectors ?? { d1: ON })[id];
          return d ? [{ id, ...d }] : [];
        }),
      ),
    },
    detectorRca: {
      findMany: vi.fn(async ({ where }: { where: { findingId: { in: string[] } } }) =>
        where.findingId.in
          .filter((f) => opts.pending?.includes(f))
          .map((findingId) => ({ findingId })),
      ),
    },
  };
}

describe("settledFindings", () => {
  it("settles a finding with no run left unassigned, and asks only within the lookback", async () => {
    const backend = { unsettledRuns: vi.fn(async () => [unsettled("f2", "r2")]) };
    const settled = await settledFindings(settleDb({}) as never, backend, "p1", ["f1", "f2"], T0);
    expect([...settled]).toEqual(["f1"]);
    expect(backend.unsettledRuns).toHaveBeenCalledWith("p1", ["f1", "f2"], T0 - 7 * 86_400_000);
  });

  it("counts a hit assigned in Postgres whose ClickHouse copy has not landed", async () => {
    const backend = { unsettledRuns: vi.fn(async () => [unsettled("f1", "r1")]) };
    const db = settleDb({ recorded: ["r1"] });
    expect(await settledFindings(db as never, backend, "p1", ["f1"], T0)).toEqual(new Set(["f1"]));
  });

  it("does not wait for a detector deleted, switched off, with RCA off, or enabled after the hit", async () => {
    const backend = {
      unsettledRuns: vi.fn(async () => [
        unsettled("f1", "r-gone", "gone"),
        unsettled("f1", "r-off", "off"),
        unsettled("f1", "r-manual", "manual"),
        unsettled("f1", "r-late", "late"),
        unsettled("f2", "r-on", "d1"),
      ]),
    };
    const db = settleDb({
      detectors: {
        off: { ...ON, enableSignals: false },
        manual: { ...ON, enableRca: false },
        late: { ...ON, signalsEnabledAt: new Date(T0) },
        d1: ON,
      },
    });
    const settled = await settledFindings(db as never, backend, "p1", ["f1", "f2"], T0);
    expect([...settled]).toEqual(["f1"]);
  });
});

describe("startSettledRcas", () => {
  it("starts only findings with a pending RCA whose hits are settled", async () => {
    const backend = { unsettledRuns: vi.fn(async () => [unsettled("f2", "r2")]) };
    const db = settleDb({ pending: ["f1", "f2"] });
    const enqueue = vi.fn(async () => {});
    expect(await startSettledRcas(db as never, backend, "p1", ["f1", "f2", "f3"], enqueue)).toBe(1);
    expect(enqueue).toHaveBeenCalledWith("f1", "p1");
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(db.detectorRca.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          projectId: "p1",
          status: "pending",
          signalRcas: { some: {} },
        }),
      }),
    );
  });

  it("asks ClickHouse nothing when no finding has a pending RCA", async () => {
    const backend = { unsettledRuns: vi.fn(async () => []) };
    expect(await startSettledRcas(settleDb({}) as never, backend, "p1", ["f1"], vi.fn())).toBe(0);
    expect(backend.unsettledRuns).not.toHaveBeenCalled();
  });
});

describe("sweepSignalRcas", () => {
  it("re-enqueues RCAs pending for more than ten minutes, within the lookback, once settled", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const db = {
      ...settleDb({ pending: ["f1", "f2"] }),
      signalRca: {
        findMany: vi.fn(async () => [
          { findingId: "f1", rca: { projectId: "p1" } },
          { findingId: "f2", rca: { projectId: "p1" } },
        ]),
      },
    };
    const backend = { unsettledRuns: vi.fn(async () => [unsettled("f2", "r2")]) };
    expect(await sweepSignalRcas(db as never, backend, T0)).toBe(1);
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
    // f2's trace still has a hit being assigned: the round that settles it starts it.
    expect(mockAdd).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });
});
