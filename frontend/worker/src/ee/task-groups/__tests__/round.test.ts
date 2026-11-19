import { describe, expect, it, vi } from "vitest";
import type { TaskGroupBackend } from "../backend-client.js";
import { runDigestRound, type RoundDeps } from "../round.js";

// Unit tests with in-memory fakes. They check the round's decisions; the real
// end-to-end run (real ClickHouse, real model calls) is the corpus evaluation.

const NOW = Date.UTC(2026, 10, 8, 12, 0, 0);
const SPANS = JSON.stringify({ span_id: "s1", name: "run", span_input: "hello" });

function fakeBackend(over: Partial<TaskGroupBackend> = {}) {
  const written: { id: string }[] = [];
  const members: { traceId: string; groupId: string }[] = [];
  const backend: TaskGroupBackend = {
    candidates: vi.fn(async ({ sinceMs }) => ({
      rows:
        sinceMs === Date.UTC(2026, 10, 8)
          ? Array.from({ length: 5 }, (_, i) => ({
              traceId: `t${i}`,
              traceTimeMs: NOW - 1000 * i,
              key: String(i),
            }))
          : [],
      digested: 0,
    })),
    spansJsonl: vi.fn(async () => SPANS),
    writeDigests: vi.fn(async (_p: string, rows: { traceId: string }[]) => {
      written.push(...rows.map((r) => ({ id: r.traceId })));
    }),
    currentGroups: vi.fn(async () => ({ fitId: null, groups: [] })),
    unplaced: vi.fn(async () => []),
    writeMembers: vi.fn(
      async (_p: string, _f: string, _s: string, rows: { traceId: string; groupId: string }[]) => {
        members.push(...rows);
      },
    ),
    ...over,
  };
  return { backend, written, members };
}

function deps(backend: TaskGroupBackend, over: Partial<RoundDeps> = {}) {
  const summarize = vi.fn(async () => ({ summary: "Plan a trip.", costUsd: 0.0004 }));
  const embed = vi.fn(async (texts: string[]) => ({
    vectors: texts.map(() => [1, 0]),
    inputTokens: 10 * texts.length,
  }));
  const addSpend = vi.fn(async () => {});
  const d: RoundDeps = {
    backend,
    apiKeyConfigured: () => true,
    settings: async () => ({ enabled: true, dailyCostCapUsd: 1 }),
    spentToday: async () => 0,
    addSpend,
    summarize,
    embed,
    failures: { record: vi.fn(async () => 1), isSkipped: async () => false },
    now: () => NOW,
    ...over,
  };
  return { d, summarize, embed, addSpend };
}

describe("runDigestRound", () => {
  it("does nothing when the feature is off", async () => {
    const { backend } = fakeBackend();
    const { d, summarize } = deps(backend, {
      settings: async () => ({ enabled: false, dailyCostCapUsd: 1 }),
    });
    const stats = await runDigestRound(d, "p");
    expect(stats.skipped).toBe("off");
    expect(summarize).not.toHaveBeenCalled();
    expect(backend.candidates).not.toHaveBeenCalled();
  });

  it("does nothing, with a reason, when there is no model key", async () => {
    const { backend } = fakeBackend();
    const { d, summarize } = deps(backend, { apiKeyConfigured: () => false });
    const stats = await runDigestRound(d, "p");
    expect(stats.skipped).toBe("no-key");
    expect(summarize).not.toHaveBeenCalled();
  });

  it("stops at once when the cap is already spent", async () => {
    const { backend } = fakeBackend();
    const { d, summarize } = deps(backend, { spentToday: async () => 1 });
    const stats = await runDigestRound(d, "p");
    expect(stats.skipped).toBe("capped");
    expect(summarize).not.toHaveBeenCalled();
  });

  it("stops cleanly mid-round when the cap cannot pay for another chunk", async () => {
    const { backend, written } = fakeBackend();
    const { d, summarize } = deps(backend, {
      settings: async () => ({ enabled: true, dailyCostCapUsd: 0.002 }),
    });
    const stats = await runDigestRound(d, "p");
    expect(stats.skipped).toBe("capped");
    expect(summarize.mock.calls.length).toBeLessThan(5);
    expect(written.length).toBe(stats.digested);
  });

  it("summarizes only as many traces as the remaining budget pays for", async () => {
    const { backend, written } = fakeBackend();
    // Room for exactly three summaries at the estimate (0.0005 each).
    const { d, summarize } = deps(backend, {
      settings: async () => ({ enabled: true, dailyCostCapUsd: 0.0016 }),
    });
    const stats = await runDigestRound(d, "p");
    expect(summarize).toHaveBeenCalledTimes(3);
    expect(written).toHaveLength(3);
    expect(stats.skipped).toBe("capped");
  });

  it("summarizes, embeds, stores and records spend", async () => {
    const { backend, written } = fakeBackend();
    const { d, summarize, embed, addSpend } = deps(backend);
    const stats = await runDigestRound(d, "p");
    expect(stats.digested).toBe(5);
    expect(summarize).toHaveBeenCalledTimes(5);
    expect(embed).toHaveBeenCalledTimes(1);
    expect(written).toHaveLength(5);
    expect(addSpend).toHaveBeenCalledWith("p", NOW, expect.objectContaining({ summaries: 5 }));
  });

  it("counts a trace with no task as a failure and does not store it", async () => {
    const { backend, written } = fakeBackend();
    const { d } = deps(backend, {
      summarize: vi.fn(async () => ({ summary: null, costUsd: 0.0001 })),
    });
    const stats = await runDigestRound(d, "p");
    expect(stats.failed).toBe(5);
    expect(written).toHaveLength(0);
  });

  it("steps past traces that failed too often", async () => {
    const { backend, written } = fakeBackend();
    const { d } = deps(backend, {
      failures: { record: async () => 3, isSkipped: async (_p, id) => id === "t0" },
    });
    await runDigestRound(d, "p");
    expect(written.map((w) => w.id)).not.toContain("t0");
  });

  it("places unplaced summaries with no model call", async () => {
    const { backend, members } = fakeBackend({
      candidates: vi.fn(async () => ({ rows: [], digested: 0 })),
      currentGroups: vi.fn(async () => ({
        fitId: "fit1",
        groups: [{ groupId: "g1", name: "n", center: [1, 0], reach: 0.1, size: 3 }],
      })),
      unplaced: vi
        .fn()
        .mockResolvedValueOnce([
          { traceId: "near", traceTimeMs: 1, embedding: [0.99, 0.01] },
          { traceId: "far", traceTimeMs: 2, embedding: [0, 1] },
        ])
        .mockResolvedValue([]),
    });
    const { d, summarize, embed } = deps(backend);
    const stats = await runDigestRound(d, "p");
    expect(stats.placed).toBe(2);
    expect(members).toEqual([
      expect.objectContaining({ traceId: "near", groupId: "g1" }),
      expect.objectContaining({ traceId: "far", groupId: "" }),
    ]);
    expect(summarize).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
  });

  it("still places traces while capped (placement costs nothing)", async () => {
    const { backend, members } = fakeBackend({
      currentGroups: vi.fn(async () => ({
        fitId: "fit1",
        groups: [{ groupId: "g1", name: "n", center: [1, 0], reach: 0.5, size: 3 }],
      })),
      unplaced: vi
        .fn()
        .mockResolvedValueOnce([{ traceId: "x", traceTimeMs: 1, embedding: [1, 0] }])
        .mockResolvedValue([]),
    });
    const { d } = deps(backend, { spentToday: async () => 5 });
    const stats = await runDigestRound(d, "p");
    expect(stats.skipped).toBe("capped");
    expect(members).toHaveLength(1);
  });
});
