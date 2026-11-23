import { describe, expect, it } from "vitest";
import { fixtureResult, fixtureRun, fixtureScore } from "./compare/__tests__/paired-fixture";
import { buildEvalTrace } from "./eval-trace";

const RUN = fixtureRun("run-1", 1, "baseline-v1", "2026-11-01T10:00:00.000Z");

describe("buildEvalTrace", () => {
  it("rebuilds a result with no telemetry as an evaluation item with a task and its scorers", () => {
    const result = fixtureResult(
      "run-1",
      "case-1",
      "Ticket 1",
      [fixtureScore("quality", 0.8), fixtureScore("route", null, "judge timed out")],
      { candidateOutput: "Refund issued.", expectedOutput: "Refund issued" },
    );

    const trace = buildEvalTrace(result, RUN);

    expect(trace.trace_id).toBe("eval-run-1-case-1");
    expect(trace.name).toBe("support-routing · case-1");
    expect(trace.input).toBe("Ticket 1");
    expect(trace.output).toBe("Refund issued.");
    expect(trace.spans.map((s) => [s.name, s.parent_span_id === null, s.status])).toEqual([
      ["support-routing · case-1", true, "OK"],
      ["task", false, "OK"],
      ["quality", false, "OK"],
      ["route", false, "ERROR"],
    ]);
    expect(trace.spans.find((s) => s.name === "quality")?.output).toBe("0.8");
    expect(trace.spans.find((s) => s.name === "route")?.status_message).toBe("judge timed out");
  });

  it("keeps a result's own trace id when it has one, and marks a failed task", () => {
    const result = fixtureResult("run-1", "case-6", "Ticket 6", [], {
      traceId: "trace-6",
      taskError: "Upstream timeout",
    });

    const trace = buildEvalTrace(result, RUN);

    expect(trace.trace_id).toBe("trace-6");
    expect(trace.spans.slice(0, 2).map((s) => [s.status, s.status_message])).toEqual([
      ["ERROR", "Upstream timeout"],
      ["ERROR", "Upstream timeout"],
    ]);
  });
});
