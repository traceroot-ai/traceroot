import { describe, it, expect } from "vitest";
import { traceFindingId } from "../detector-run-processor.js";

/**
 * The finding id (and therefore the RCA job id, `signal-rca-${findingId}`)
 * depends only on (projectId, traceId), so every detector that fires on a
 * trace maps to the SAME finding and the SAME RCA job.
 */

describe("traceFindingId: one finding (and one RCA job) per trace", () => {
  it("is deterministic for the same project + trace", () => {
    expect(traceFindingId("proj", "trace")).toBe(traceFindingId("proj", "trace"));
  });

  it("differs across traces and across projects", () => {
    expect(traceFindingId("proj", "traceA")).not.toBe(traceFindingId("proj", "traceB"));
    expect(traceFindingId("projA", "trace")).not.toBe(traceFindingId("projB", "trace"));
  });

  it("is formatted as a uuid-shaped string", () => {
    expect(traceFindingId("proj", "trace")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("is order-sensitive: swapping project and trace yields a different id", () => {
    expect(traceFindingId("a", "b")).not.toBe(traceFindingId("b", "a"));
  });

  it("stays uuid-shaped and deterministic even for empty inputs", () => {
    const uuidShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    expect(traceFindingId("", "")).toMatch(uuidShape);
    expect(traceFindingId("", "")).toBe(traceFindingId("", ""));
  });
});
