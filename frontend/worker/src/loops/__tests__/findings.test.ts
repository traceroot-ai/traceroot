import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  writeDetectorFinding: vi.fn(),
  writeDetectorRun: vi.fn(),
  enqueueSignalHits: vi.fn(),
}));
vi.mock("../../detection/clickhouse-writer.js", () => ({
  writeDetectorFinding: mocks.writeDetectorFinding,
  writeDetectorRun: mocks.writeDetectorRun,
}));
vi.mock("../../ee/signals/queue.js", () => ({ enqueueSignalHits: mocks.enqueueSignalHits }));

import { hash32, hashToUuid } from "../../detection/ids.js";
import { traceFindingId } from "../../processors/detector-run-processor.js";
import type { LoopFinding } from "@traceroot/core/loops";
import {
  HIT_WRITE_CONCURRENCY,
  loopFindingId,
  loopFindingRunId,
  recordLoopFindings,
} from "../findings.js";

const loop = { name: "Coding agents", detectorId: "det-loop" };
const finding = (key: string, traceIds: string[]): LoopFinding => ({
  key,
  title: `Title ${key}`,
  covers: `Covers ${key}`,
  summary: `Summary ${key}`,
  traceIds,
});

beforeEach(() => {
  mocks.writeDetectorFinding.mockReset().mockResolvedValue(undefined);
  mocks.writeDetectorRun.mockReset().mockResolvedValue(undefined);
  mocks.enqueueSignalHits.mockReset().mockResolvedValue(1);
});

describe("loop finding ids", () => {
  it("are stable and never the trace's detector finding or run id", () => {
    const id = loopFindingId("p", "t", "det-loop", "tool-timeouts");
    expect(id).toBe(loopFindingId("p", "t", "det-loop", "tool-timeouts"));
    expect(id).toBe(hashToUuid("p:t:loop:det-loop:tool-timeouts"));
    expect(id).not.toBe(traceFindingId("p", "t"));
    expect(id).not.toBe(loopFindingId("p", "t", "det-loop", "wrong-city"));

    const runId = loopFindingRunId("p", "t", "det-loop", "tool-timeouts");
    expect(runId).toBe(hash32("p:t:det-loop:tool-timeouts"));
    // The detector worker's run id for (project, trace, detector).
    expect(runId).not.toBe(hash32("p:t:det-loop"));
  });
});

describe("recordLoopFindings", () => {
  it("writes at most HIT_WRITE_CONCURRENCY hits at once", async () => {
    let inFlight = 0;
    let most = 0;
    mocks.writeDetectorFinding.mockImplementation(async () => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
    });
    const traces = Array.from({ length: 20 }, (_, i) => `t${i}`);
    const result = await recordLoopFindings({
      projectId: "p",
      loop,
      findings: [finding("a-key", traces), finding("b-key", traces)],
    });
    expect(result).toEqual({ keys: ["a-key", "b-key"], failed: 0 });
    expect(mocks.writeDetectorFinding).toHaveBeenCalledTimes(40);
    expect(most).toBe(HIT_WRITE_CONCURRENCY);
  });

  it("writes a finding and a completed run per trace, one timestamp per finding", async () => {
    let clock = 1_000;
    const { keys } = await recordLoopFindings({
      projectId: "p",
      loop,
      findings: [finding("tool-timeouts", ["t1", "t2"])],
      now: () => clock++,
    });
    expect(keys).toEqual(["tool-timeouts"]);
    expect(mocks.writeDetectorFinding).toHaveBeenCalledTimes(2);
    expect(mocks.writeDetectorFinding).toHaveBeenCalledWith({
      findingId: loopFindingId("p", "t1", "det-loop", "tool-timeouts"),
      projectId: "p",
      traceId: "t1",
      summary: "Summary tool-timeouts",
      payload: JSON.stringify([
        {
          detectorId: "det-loop",
          detectorName: "loop:Coding agents",
          summary: "Summary tool-timeouts",
          data: {
            loopFindingKey: "tool-timeouts",
            title: "Title tool-timeouts",
            covers: "Covers tool-timeouts",
          },
        },
      ]),
      source: "loop",
      timestampMs: 1_000,
    });
    expect(mocks.writeDetectorRun).toHaveBeenCalledWith({
      runId: loopFindingRunId("p", "t2", "det-loop", "tool-timeouts"),
      detectorId: "det-loop",
      projectId: "p",
      traceId: "t2",
      findingId: loopFindingId("p", "t2", "det-loop", "tool-timeouts"),
      status: "completed",
      usedInference: false,
      source: "loop",
      timestampMs: 1_000,
    });
  });

  it("gives a trace in two findings two runs, and enqueues the round once", async () => {
    const { keys } = await recordLoopFindings({
      projectId: "p",
      loop,
      findings: [finding("a-key", ["t1"]), finding("b-key", ["t1", "t2"])],
    });
    expect(keys).toEqual(["a-key", "b-key"]);
    const runIds = mocks.writeDetectorRun.mock.calls.map((c) => c[0].runId);
    expect(new Set(runIds).size).toBe(3);
    const t1Runs = mocks.writeDetectorRun.mock.calls.filter((c) => c[0].traceId === "t1");
    expect(t1Runs).toHaveLength(2);
    expect(mocks.enqueueSignalHits).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueSignalHits).toHaveBeenCalledWith({
      projectId: "p",
      detectors: [{ id: "det-loop", enableSignals: true }],
      triggered: [{ detectorId: "det-loop" }],
    });
  });

  it("lists a repeated key once, writing its first finding", async () => {
    const { keys } = await recordLoopFindings({
      projectId: "p",
      loop,
      findings: [finding("a-key", ["t1"]), finding("a-key", ["t2"])],
    });
    expect(keys).toEqual(["a-key"]);
    expect(mocks.writeDetectorRun).toHaveBeenCalledTimes(1);
  });

  it("keeps the hits that were written when others fail, and enqueues them", async () => {
    // a-key: t1 lands, t2's run fails. b-key: its only finding row fails.
    mocks.writeDetectorRun.mockImplementation(async (row: { traceId: string }) => {
      if (row.traceId === "t2") throw new Error("Backend API error 500");
    });
    mocks.writeDetectorFinding.mockImplementation(async (row: { findingId: string }) => {
      if (row.findingId === loopFindingId("p", "t3", "det-loop", "b-key")) {
        throw new Error("Backend API error 500");
      }
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await recordLoopFindings({
      projectId: "p",
      loop,
      findings: [finding("a-key", ["t1", "t2"]), finding("b-key", ["t3"])],
    });
    expect(result).toEqual({ keys: ["a-key"], failed: 2 });
    // Every write was attempted: one failure does not abort the others.
    expect(mocks.writeDetectorFinding).toHaveBeenCalledTimes(3);
    expect(errors.mock.calls.map((c) => c[0])).toEqual([
      "[Loops] detector=det-loop key=a-key trace=t2: hit not written:",
      "[Loops] detector=det-loop key=b-key trace=t3: hit not written:",
    ]);
    errors.mockRestore();
    expect(mocks.enqueueSignalHits).toHaveBeenCalledTimes(1);
  });

  it("throws when no hit was written, and enqueues nothing", async () => {
    mocks.writeDetectorRun.mockRejectedValue(new Error("Backend API error 500"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      recordLoopFindings({ projectId: "p", loop, findings: [finding("a-key", ["t1", "t2"])] }),
    ).rejects.toThrow("none of 2 finding hits of detector det-loop were written");
    errors.mockRestore();
    expect(mocks.enqueueSignalHits).not.toHaveBeenCalled();
  });

  it("keeps the findings when the enqueue fails: the sweeper picks the hits up", async () => {
    mocks.enqueueSignalHits.mockRejectedValueOnce(new Error("redis down"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { keys } = await recordLoopFindings({
      projectId: "p",
      loop,
      findings: [finding("a-key", ["t1"])],
    });
    expect(keys).toEqual(["a-key"]);
    errors.mockRestore();
  });
});
