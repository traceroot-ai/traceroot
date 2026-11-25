import { describe, it, expect, vi } from "vitest";
import type { LoopAgentResult } from "@traceroot/core/loops";

const { WorkerMock } = vi.hoisted(() => ({
  WorkerMock: vi.fn(function (this: { on: ReturnType<typeof vi.fn> }) {
    this.on = vi.fn();
  }),
}));
vi.mock("bullmq", () => ({ Worker: WorkerMock }));
vi.mock("../../queues/loop-run-queue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../queues/loop-run-queue.js")>()),
  createRedisConnection: vi.fn(() => ({ redis: true })),
}));

import {
  LOOP_NO_SUMMARY,
  outcomeOf,
  processLoopRun,
  startLoopRunWorker,
} from "../loop-run-processor.js";

const TIMEOUT_MS = 20 * 60_000;

function answer(result: Partial<LoopAgentResult>): LoopAgentResult {
  return {
    status: "submitted",
    summary: "Nothing recurring in the last 24 hours.",
    tracesRead: 7,
    toolCalls: 12,
    costUsd: 0.42,
    error: null,
    modelUsed: null,
    ...result,
  };
}

describe("outcomeOf: what the agent's answer means for the run", () => {
  it("finishes a submitted summary quiet, with its usage", () => {
    expect(outcomeOf(answer({}), TIMEOUT_MS)).toEqual({
      status: "quiet",
      summary: "Nothing recurring in the last 24 hours.",
      tracesRead: 7,
      costUsd: 0.42,
      metadata: { toolCalls: 12, agentStatus: "submitted" },
    });
  });

  it("finishes quiet when the budget ran out after a summary", () => {
    expect(outcomeOf(answer({ status: "budget_exhausted" }), TIMEOUT_MS).status).toBe("quiet");
  });

  it("fails a submitted or budget-stopped run whose summary is blank", () => {
    for (const status of ["submitted", "budget_exhausted"] as const) {
      expect(outcomeOf(answer({ status, summary: "  " }), TIMEOUT_MS)).toMatchObject({
        status: "failed",
        summary: null,
        error: LOOP_NO_SUMMARY,
      });
    }
  });

  it("finishes timed_out when the agent reports the deadline", () => {
    expect(outcomeOf(answer({ status: "timed_out", summary: null }), TIMEOUT_MS)).toMatchObject({
      status: "timed_out",
      error: "The run did not finish within 20 minutes.",
    });
  });

  it("fails a run that ended without a summary", () => {
    expect(outcomeOf(answer({ status: "no_summary", summary: null }), TIMEOUT_MS)).toMatchObject({
      status: "failed",
      error: LOOP_NO_SUMMARY,
    });
  });

  it("fails on an agent error, keeping the first line of its message", () => {
    expect(
      outcomeOf(
        answer({ status: "error", summary: null, error: "Provider refused\nstack..." }),
        TIMEOUT_MS,
      ),
    ).toMatchObject({ status: "failed", error: "Provider refused" });
  });
});

describe("outcomeOf: an answer missing its counts", () => {
  it("counts no traces, no tool calls and no cost", () => {
    const outcome = outcomeOf(
      { status: "submitted", summary: "ok" } as unknown as LoopAgentResult,
      TIMEOUT_MS,
    );
    expect(outcome).toMatchObject({
      status: "quiet",
      tracesRead: 0,
      costUsd: null,
      metadata: { toolCalls: 0, agentStatus: "submitted" },
    });
  });

  it("fails an agent error that gave no message with a generic one", () => {
    expect(
      outcomeOf(answer({ status: "error", summary: null, error: null }), TIMEOUT_MS),
    ).toMatchObject({ status: "failed", error: "The agent failed to run this loop." });
  });
});

describe("startLoopRunWorker", () => {
  it("consumes the loop run queue at the configured concurrency and logs a failed job", () => {
    vi.stubEnv("LOOP_RUN_CONCURRENCY", "3");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const worker = startLoopRunWorker() as unknown as { on: ReturnType<typeof vi.fn> };
    expect(WorkerMock).toHaveBeenCalledWith("loop-run", processLoopRun, {
      connection: { redis: true },
      concurrency: 3,
    });
    const [event, onFailed] = worker.on.mock.calls[0]!;
    expect(event).toBe("failed");
    onFailed({ id: "loop-run-r1" }, new Error("boom"));
    onFailed(undefined, new Error("lost"));
    expect(errors.mock.calls).toEqual([
      ["[Loops] Job loop-run-r1 failed:", "boom"],
      ["[Loops] Job undefined failed:", "lost"],
    ]);
    errors.mockRestore();
    vi.unstubAllEnvs();
  });
});
