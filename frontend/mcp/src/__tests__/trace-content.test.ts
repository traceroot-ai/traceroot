import { describe, expect, it } from "vitest";
import { traceReadDefaults, withholdTraceContent } from "../trace-content.js";

const trace = { trace_id: "t1", input: "in", output: "out", metadata: { k: 1 }, spans: [] };

describe("withholdTraceContent", () => {
  it("defaults a trace read to the skeleton projection", () => {
    expect(traceReadDefaults()).toEqual({ fields: "skeleton" });
  });

  it("drops trace-level content under the skeleton projection", () => {
    expect(withholdTraceContent(trace, { fields: "skeleton" })).toEqual({
      trace_id: "t1",
      spans: [],
    });
  });

  it("keeps everything under full", () => {
    expect(withholdTraceContent(trace, { fields: "full" })).toEqual(trace);
  });

  it("keeps only the groups asked for", () => {
    expect(withholdTraceContent(trace, { fields: "core, io" })).toEqual({
      trace_id: "t1",
      input: "in",
      output: "out",
      spans: [],
    });
    expect(withholdTraceContent(trace, { fields: "metadata" })).toEqual({
      trace_id: "t1",
      metadata: { k: 1 },
      spans: [],
    });
  });

  it("leaves a non-object result alone", () => {
    expect(withholdTraceContent(null, {})).toBeNull();
    expect(withholdTraceContent([1], {})).toEqual([1]);
  });
});
