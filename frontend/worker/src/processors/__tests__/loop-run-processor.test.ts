import { describe, it, expect } from "vitest";
import type { LoopAgentResult } from "@traceroot/core/loops";
import { LOOP_NO_SUMMARY, outcomeOf } from "../loop-run-processor.js";

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
    findings: [],
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
