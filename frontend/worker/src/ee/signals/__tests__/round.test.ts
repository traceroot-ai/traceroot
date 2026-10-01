import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockApply, mockCalculateCost } = vi.hoisted(() => ({
  mockApply: vi.fn(),
  mockCalculateCost: vi.fn(),
}));
vi.mock("../write.js", () => ({ applyAssignment: mockApply }));
vi.mock("@traceroot/core", () => ({ calculateCost: mockCalculateCost }));

import type { AssignmentRow, SignalsBackend, WaitingHitRow } from "../backend-client.js";
import { runAssignmentRound, type RoundDeps } from "../round.js";
import type { AssignmentModels, ModelUsage } from "../types.js";
import type { Placement, WaitingHit } from "../write.js";

const T0 = Date.parse("2026-09-30T10:00:00Z");
const ENABLED_AT = new Date(T0 - 3_600_000);

function row(i: number, over: Partial<WaitingHitRow> = {}): WaitingHitRow {
  return {
    run_id: `run${i}`,
    trace_id: `t${i}`,
    finding_id: `f${i}`,
    timestamp_ms: T0 - 60_000 + i,
    trace_start_ms: T0 - 120_000,
    summary: i % 2 ? "tool timed out and the agent carried on" : "wrong city booked",
    data: {},
    ...over,
  };
}

/** A fake backend over a list of waiting rows; written copies leave the list. */
function fakeBackend(rows: WaitingHitRow[], opts: { failWrites?: boolean } = {}) {
  const waiting = [...rows];
  const written: AssignmentRow[] = [];
  const backend: SignalsBackend & { calls: unknown[][] } = {
    calls: [],
    waitingHits: vi.fn(async (...args: unknown[]) => {
      backend.calls.push(args);
      return waiting.slice(0, args[3] as number);
    }),
    writeAssignments: vi.fn(async (batch: AssignmentRow[]) => {
      if (opts.failWrites) throw new Error("clickhouse down");
      written.push(...batch);
      for (const r of batch)
        waiting.splice(
          waiting.findIndex((w) => w.run_id === r.run_id),
          1,
        );
    }),
  };
  return { backend, written, waiting };
}

function fakeDb(opts: { recorded?: string[]; detector?: unknown } = {}) {
  const aiRows: Record<string, unknown>[] = [];
  const db = {
    detector: {
      findFirst: vi.fn(async () =>
        opts.detector === undefined
          ? {
              name: "Failure",
              enableSignals: true,
              signalsEnabledAt: ENABLED_AT,
              project: { workspaceId: "ws" },
            }
          : opts.detector,
      ),
    },
    signalHit: {
      findMany: vi.fn(async ({ where }: { where: { copyPending?: boolean } }) =>
        where.copyPending
          ? []
          : (opts.recorded ?? []).map((runId) => ({ runId, embedding: [1, 0] })),
      ),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    signal: { findMany: vi.fn(async () => []) },
    aIMessage: {
      createMany: vi.fn(async ({ data }: { data: Record<string, unknown>[] }) =>
        aiRows.push(...data),
      ),
    },
    $transaction: vi.fn(),
  };
  return { db, aiRows };
}

/** Embeds by topic so the shortlist puts same-topic hits together. */
const embed = vi.fn(async (texts: string[]) => ({
  vectors: texts.map((t) => (t.includes("tool") ? [1, 0] : [0, 1])),
  inputTokens: texts.length * 10,
}));

/** Chat model that attaches to a same-topic candidate, else writes a new signal. */
function chatModels(usage: ModelUsage[]): AssignmentModels {
  const u = () =>
    usage.push({
      model: "gpt-5.6-luna",
      provider: "openai",
      isByok: false,
      inputTokens: 100,
      outputTokens: 10,
      cost: 0.001,
    });
  const topic = (m: string) => (m.includes("tool") ? "Tool" : "City");
  return {
    chat: {
      assign: async (material, candidates) => {
        u();
        const match = candidates.find((c) => c.title === topic(material));
        return {
          choice: match?.label ?? "none",
          reason: "",
          newSignal: match
            ? null
            : { title: topic(material), covers: topic(material), excludes: "" },
        };
      },
      write: async (material) => {
        u();
        return { title: topic(material), covers: topic(material), excludes: "" };
      },
      validate: async (_c, _e, texts) => {
        u();
        return texts.map((_, i) => i === 0);
      },
    },
    jev: null,
  };
}

/** In-memory failure records: count and first failure time per run. */
function fakeFailures(seed: Record<string, { count: number; firstAt: number }> = {}) {
  const records = { ...seed };
  return {
    records,
    record: vi.fn(async (runId: string, now: number) => {
      const r = (records[runId] ??= { count: 0, firstAt: now });
      r.count++;
      return { ...r };
    }),
  };
}

function deps(
  db: unknown,
  backend: SignalsBackend,
  now: () => number = () => T0,
  failures = fakeFailures(),
): RoundDeps {
  return {
    db: db as RoundDeps["db"],
    backend,
    failures,
    embed,
    models: async (_ws, usage) => chatModels(usage),
    now,
  };
}

const ASSIGNED_AT = new Date(T0 + 1_000);

/** The Postgres write, simulated: first placement per topic creates, later ones attach. */
function simulateWrites() {
  let n = 0;
  mockApply.mockImplementation(async (_db: unknown, _hit: WaitingHit, placement: Placement) => {
    const base = { reopenSeq: 0, score: null, criteriaVersion: 1, assignedAt: ASSIGNED_AT };
    if (placement.kind === "attach" && placement.signalId === "") {
      return { ...base, outcome: "duplicate", signalId: "sigOld", score: 0.8 };
    }
    if (placement.kind === "attach") {
      return { ...base, outcome: "attached", signalId: placement.signalId, score: placement.score };
    }
    n++;
    return { ...base, outcome: "created", signalId: `sig${n}` };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("OPENAI_API_KEY", "sk-test");
  mockCalculateCost.mockResolvedValue(0.5);
  simulateWrites();
});
afterEach(() => vi.unstubAllEnvs());

describe("runAssignmentRound", () => {
  it("assigns waiting hits in time order, and a signal created by one hit is a candidate for the next", async () => {
    const { backend, written } = fakeBackend([1, 2, 3, 4].map((i) => row(i)));
    const { db } = fakeDb();
    const stats = await runAssignmentRound(deps(db, backend), "p", "d");
    expect(mockApply.mock.calls.map((c) => c[1].runId)).toEqual(["run1", "run2", "run3", "run4"]);
    expect(mockApply.mock.calls.map((c) => c[2].kind)).toEqual([
      "create",
      "create",
      "attach",
      "attach",
    ]);
    expect(mockApply.mock.calls[2][2]).toMatchObject({ signalId: "sig1", score: null });
    expect(stats).toMatchObject({
      waiting: 4,
      created: 2,
      attached: 2,
      lagMs: 59_999,
      remaining: false,
    });
    // The new signal's anchor is the hit's material and embedding.
    expect(mockApply.mock.calls[0][2]).toMatchObject({
      anchorText: expect.stringContaining("detector: Failure"),
      anchorEmbedding: [1, 0],
    });
    // Each hit's ClickHouse copy carries its signal, embedding and Postgres values.
    expect(written.map((w) => [w.run_id, w.signal_id])).toEqual([
      ["run1", "sig1"],
      ["run2", "sig2"],
      ["run3", "sig1"],
      ["run4", "sig2"],
    ]);
    expect(written[0]).toEqual({
      project_id: "p",
      detector_id: "d",
      run_id: "run1",
      trace_id: "t1",
      signal_id: "sig1",
      embedding: [1, 0],
      score: null,
      criteria_version: 1,
      assigned_at_ms: ASSIGNED_AT.getTime(),
    });
  });

  it("reads hits only from after the switch was turned on, and within the lookback", async () => {
    const { backend } = fakeBackend([]);
    await runAssignmentRound(deps(fakeDb().db, backend), "p", "d");
    expect(backend.waitingHits).toHaveBeenCalledWith("p", "d", ENABLED_AT.getTime(), 200);

    const old = fakeDb({
      detector: {
        name: "D",
        enableSignals: true,
        signalsEnabledAt: new Date(0),
        project: { workspaceId: "ws" },
      },
    });
    await runAssignmentRound(deps(old.db, backend), "p", "d");
    expect(vi.mocked(backend.waitingHits).mock.calls[1][2]).toBe(T0 - 7 * 24 * 3_600_000);
  });

  it("uses the trace start for the reopen rule, and the detection time when the trace is gone", async () => {
    const { backend } = fakeBackend([row(1), row(2, { trace_start_ms: null })]);
    await runAssignmentRound(deps(fakeDb().db, backend), "p", "d");
    expect(mockApply.mock.calls[0][1].traceStartTime).toEqual(new Date(T0 - 120_000));
    expect(mockApply.mock.calls[1][1].traceStartTime).toEqual(new Date(T0 - 60_000 + 2));
  });

  it("rewrites the copy of a hit already recorded in Postgres without asking a model", async () => {
    const { backend, written } = fakeBackend([row(1)]);
    const models = vi.fn(async (_ws: string, usage: ModelUsage[]) => chatModels(usage));
    const stats = await runAssignmentRound(
      { ...deps(fakeDb({ recorded: ["run1"] }).db, backend), models },
      "p",
      "d",
    );
    expect(stats.duplicate).toBe(1);
    expect(models).not.toHaveBeenCalled();
    expect(written[0]).toMatchObject({
      run_id: "run1",
      signal_id: "sigOld",
      score: 0.8,
      embedding: [1, 0],
    });
  });

  it("groups Jev-path hits by category without embedding them", async () => {
    const jevData = {
      category: "fabrication",
      probabilities: { fabrication: 0.9 },
      confidence: 0.9,
      gate: 0.95,
    };
    const { backend, written } = fakeBackend([row(1, { data: jevData })]);
    await runAssignmentRound(deps(fakeDb().db, backend), "p", "d");
    expect(embed).not.toHaveBeenCalled();
    expect(mockApply.mock.calls[0][2]).toMatchObject({
      kind: "group",
      groupKey: "fabrication",
      signal: { title: "Fabrication" },
    });
    expect(written[0].embedding).toEqual([]);
  });

  it("embeds in chunks as the round reaches them", async () => {
    const { backend } = fakeBackend(Array.from({ length: 30 }, (_, i) => row(i + 1)));
    await runAssignmentRound(deps(fakeDb().db, backend), "p", "d");
    expect(embed.mock.calls.map((c) => c[0].length)).toEqual([25, 5]);
    // 30 copies go out in two writes.
    expect(vi.mocked(backend.writeAssignments).mock.calls.map((c) => c[0].length)).toEqual([25, 5]);
  });

  it("stops after the time budget and reports that hits remain", async () => {
    let now = T0;
    const { backend } = fakeBackend([1, 2, 3].map((i) => row(i)));
    const stats = await runAssignmentRound(
      deps(fakeDb().db, backend, () => (now += 70_000)),
      "p",
      "d",
    );
    expect(mockApply).toHaveBeenCalledTimes(1);
    expect(stats.remaining).toBe(true);
  });

  it("reports that hits remain when it read a full round", async () => {
    const { backend } = fakeBackend(
      Array.from({ length: 200 }, (_, i) =>
        row(i + 1, { data: { category: "x", probabilities: {}, confidence: 1, gate: 1 } }),
      ),
    );
    const stats = await runAssignmentRound(deps(fakeDb().db, backend), "p", "d");
    expect(stats).toMatchObject({ waiting: 200, remaining: true });
  });

  it("records one usage row per model, priced when the provider reported no cost", async () => {
    const { backend } = fakeBackend([row(1), row(2)]);
    const { db, aiRows } = fakeDb();
    await runAssignmentRound(deps(db, backend), "p", "d");
    expect(aiRows).toHaveLength(2);
    const chat = aiRows.find((r) => r.model === "gpt-5.6-luna")!;
    const emb = aiRows.find((r) => r.model === "text-embedding-3-small")!;
    expect(chat).toMatchObject({
      workspaceId: "ws",
      kind: "signal-assignment",
      turnKind: "detector",
      isByok: false,
    });
    expect(chat.cost).toBeCloseTo(0.004);
    expect(emb).toMatchObject({ inputTokens: 20, cost: 0.5 });
  });

  it("fails the job when the ClickHouse copy cannot be written, after assigning in Postgres", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { backend } = fakeBackend([row(1)], { failWrites: true });
    const { db, aiRows } = fakeDb();
    await expect(runAssignmentRound(deps(db, backend), "p", "d")).rejects.toThrow(
      "clickhouse down",
    );
    expect(mockApply).toHaveBeenCalledOnce();
    expect(aiRows.length).toBeGreaterThan(0);
    error.mockRestore();
  });

  it("moves past a hit that fails, so the rest of the detector is still assigned", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { backend, written } = fakeBackend([row(1), row(2), row(3)]);
    const failures = fakeFailures();
    mockApply.mockImplementationOnce(async () => {
      throw new Error("bad hit");
    });
    const stats = await runAssignmentRound(
      deps(fakeDb().db, backend, () => T0, failures),
      "p",
      "d",
    );
    expect(stats).toMatchObject({ failed: 1, gaveUp: 0, created: 2 });
    expect(written.map((w) => w.run_id)).toEqual(["run2", "run3"]);
    expect(failures.record).toHaveBeenCalledWith("run1", T0);
    error.mockRestore();
  });

  it("stops the round at two failures in a row and backs off when nothing moved", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { backend } = fakeBackend([row(1), row(2), row(3)]);
    mockApply.mockRejectedValue(new Error("postgres down"));
    await expect(runAssignmentRound(deps(fakeDb().db, backend), "p", "d")).rejects.toThrow(
      "postgres down",
    );
    expect(mockApply).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });

  it("gives up on a hit that failed three times over six hours, and marks it so it stops waiting", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { backend, written } = fakeBackend([row(1)]);
    const failures = fakeFailures({ run1: { count: 2, firstAt: T0 - 7 * 3_600_000 } });
    mockApply.mockRejectedValueOnce(new Error("bad hit"));
    const stats = await runAssignmentRound(
      deps(fakeDb().db, backend, () => T0, failures),
      "p",
      "d",
    );
    expect(stats).toMatchObject({ failed: 1, gaveUp: 1 });
    expect(written).toEqual([
      expect.objectContaining({ run_id: "run1", signal_id: "", gave_up: true, embedding: [] }),
    ]);
    error.mockRestore();
  });

  it("keeps retrying a hit that failed often but only recently, as in an outage", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { backend, written } = fakeBackend([row(1)]);
    const failures = fakeFailures({ run1: { count: 9, firstAt: T0 - 3_600_000 } });
    mockApply.mockRejectedValueOnce(new Error("provider down"));
    await expect(
      runAssignmentRound(
        deps(fakeDb().db, backend, () => T0, failures),
        "p",
        "d",
      ),
    ).rejects.toThrow("provider down");
    expect(written).toEqual([]);
    error.mockRestore();
  });

  it("writes the copies it has and keeps usage findable when a model call fails part-way", async () => {
    // run1 starts the first signal (no assignment call); run3 needs one, which fails.
    const { backend, written } = fakeBackend([row(1), row(3)]);
    const { db, aiRows } = fakeDb();
    const failing: RoundDeps = {
      ...deps(db, backend),
      models: async (_ws, usage) => {
        const m = chatModels(usage);
        m.chat.assign = async () => {
          usage.push({
            model: "gpt-5.6-luna",
            provider: "openai",
            isByok: false,
            inputTokens: 1,
            outputTokens: 1,
            cost: 0.01,
          });
          throw new Error("provider down");
        };
        return m;
      },
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    // run1 succeeded, so the round reports run3's failure instead of throwing.
    const stats = await runAssignmentRound(failing, "p", "d");
    expect(stats).toMatchObject({ failed: 1, created: 1 });
    expect(written.map((w) => w.run_id)).toEqual(["run1"]);
    error.mockRestore();
    expect(aiRows.map((r) => r.model).sort()).toEqual(["gpt-5.6-luna", "text-embedding-3-small"]);
  });

  it("skips a partition whose detector is gone, switched off, or without a key", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { backend } = fakeBackend([row(1)]);
    expect(
      (await runAssignmentRound(deps(fakeDb({ detector: null }).db, backend), "p", "d")).skipped,
    ).toBe("detector-deleted");
    const off = fakeDb({
      detector: {
        name: "D",
        enableSignals: false,
        signalsEnabledAt: ENABLED_AT,
        project: { workspaceId: "ws" },
      },
    });
    expect((await runAssignmentRound(deps(off.db, backend), "p", "d")).skipped).toBe("signals-off");
    vi.stubEnv("OPENAI_API_KEY", "");
    expect((await runAssignmentRound(deps(fakeDb().db, backend), "p", "d")).skipped).toBe("no-key");
    expect(backend.waitingHits).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("returns early with nothing waiting", async () => {
    const { backend } = fakeBackend([]);
    let now = T0;
    expect(
      await runAssignmentRound(
        deps(fakeDb().db, backend, () => (now += 5)),
        "p",
        "d",
      ),
    ).toMatchObject({
      waiting: 0,
      remaining: false,
      readAt: T0 + 10,
      durationMs: 10,
    });
    expect(backend.writeAssignments).not.toHaveBeenCalled();
  });
});
