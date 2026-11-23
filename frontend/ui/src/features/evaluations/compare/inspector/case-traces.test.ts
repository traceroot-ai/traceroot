import { describe, expect, it } from "vitest";
import type { TraceDetail } from "@/types/api";
import { fixtureResult, fixtureRun } from "../__tests__/paired-fixture";
import { caseTrace } from "./case-traces";

const RUN = fixtureRun("run-1", 1, "baseline-v1", "2026-11-01T10:00:00.000Z");
const TRACE = { trace_id: "trace-1", spans: [] } as unknown as TraceDetail;
const idle = { data: undefined, isError: false };

describe("caseTrace", () => {
  it("says a run with no result for the case has nothing to show", () => {
    expect(caseTrace(undefined, RUN, idle)).toEqual({ kind: "no_result" });
  });

  it("rebuilds a result that reported no trace, as run detail does", () => {
    const result = fixtureResult("run-1", "case-1", "Ticket 1", []);
    const side = caseTrace(result, RUN, idle);
    expect(side.kind).toBe("reconstructed");
    expect(side.kind === "reconstructed" && side.trace.trace_id).toBe("eval-run-1-case-1");
  });

  it("shows a reported trace, loading or loaded", () => {
    const result = fixtureResult("run-1", "case-1", "Ticket 1", [], { traceId: "trace-1" });
    expect(caseTrace(result, RUN, idle)).toEqual({
      kind: "reported",
      traceId: "trace-1",
      trace: undefined,
    });
    expect(caseTrace(result, RUN, { data: TRACE, isError: false })).toEqual({
      kind: "reported",
      traceId: "trace-1",
      trace: TRACE,
    });
  });

  it("waits for a reported trace whose fetch fails before it ever loads", () => {
    const result = fixtureResult("run-1", "case-1", "Ticket 1", [], { traceId: "trace-1" });
    expect(caseTrace(result, RUN, { data: undefined, isError: true })).toEqual({
      kind: "pending",
      traceId: "trace-1",
    });
    // A failed refetch of a trace already loaded keeps what it had.
    expect(caseTrace(result, RUN, { data: TRACE, isError: true }).kind).toBe("reported");
  });
});
