import { describe, it, expect } from "vitest";
import { shouldRunRca, traceFindingId, buildRcaFindings } from "../detector-run-processor.js";

/**
 * RCA is decided ONCE per trace (one aggregated finding per trace), not per
 * detector. These tests lock in three properties:
 *
 *  1. shouldRunRca — run the RCA iff at least one detector that ACTUALLY FIRED
 *     on the trace has its toggle on. Detectors that are merely configured/
 *     enabled but did not fire never influence the decision.
 *  2. traceFindingId — the finding id (and therefore the RCA job id) depends
 *     only on (projectId, traceId), so every detector that fires on a trace
 *     maps to the SAME finding and the SAME single RCA job.
 *  3. buildRcaFindings — that single RCA job carries every fired detector's
 *     summary, so one agent analyzes the whole trace.
 */

// ---- helpers ---------------------------------------------------------------

const fired = (...ids: string[]) => ids.map((detectorId) => ({ detectorId }));
const det = (id: string, enableRca: boolean) => ({ id, enableRca });

// ---- 1. shouldRunRca -------------------------------------------------------

describe("shouldRunRca: only detectors that FIRED count", () => {
  it("runs when the single fired detector has RCA on", () => {
    expect(shouldRunRca(fired("a"), [det("a", true)])).toBe(true);
  });

  it("skips when the single fired detector has RCA off", () => {
    expect(shouldRunRca(fired("a"), [det("a", false)])).toBe(false);
  });

  it("scenario: 3 detectors all RCA-on and all fired -> runs (one agent, see other tests)", () => {
    const detectors = [det("a", true), det("b", true), det("c", true)];
    expect(shouldRunRca(fired("a", "b", "c"), detectors)).toBe(true);
  });

  it("scenario: 2 off fired while the 1 on detector did NOT fire -> skips", () => {
    // The RCA-on detector ("c") is configured & enabled but never produced a
    // finding, so it is absent from `fired`. Only the two RCA-off detectors
    // fired -> no RCA.
    const detectors = [det("a", false), det("b", false), det("c", true)];
    expect(shouldRunRca(fired("a", "b"), detectors)).toBe(false);
  });

  it("mixed fired (one on, one off) -> runs", () => {
    expect(shouldRunRca(fired("a", "b"), [det("a", false), det("b", true)])).toBe(true);
  });

  it("all fired detectors off -> skips", () => {
    const detectors = [det("a", false), det("b", false), det("c", false)];
    expect(shouldRunRca(fired("a", "b", "c"), detectors)).toBe(false);
  });

  it("a configured RCA-on detector that did not fire never flips the decision", () => {
    // Many RCA-on detectors exist, but only an RCA-off one fired.
    const detectors = [det("on1", true), det("on2", true), det("off1", false)];
    expect(shouldRunRca(fired("off1"), detectors)).toBe(false);
  });

  it("nothing fired -> skips even when on detectors are configured", () => {
    expect(shouldRunRca([], [det("a", true), det("b", true)])).toBe(false);
  });

  it("empty inputs -> skips", () => {
    expect(shouldRunRca([], [])).toBe(false);
  });
});

describe("shouldRunRca: fail-open and robustness", () => {
  it("fails open when a fired detector is missing from the detectors list", () => {
    // Defensive: an unexpected gap must not silently suppress analysis.
    expect(shouldRunRca(fired("ghost"), [])).toBe(true);
  });

  it("a missing (fail-open) fired detector forces RCA even alongside an off one", () => {
    expect(shouldRunRca(fired("off1", "ghost"), [det("off1", false)])).toBe(true);
  });

  it("treats a malformed detector row with undefined enableRca as on (default-on)", () => {
    const malformed = [{ id: "a" }] as unknown as { id: string; enableRca: boolean }[];
    expect(shouldRunRca(fired("a"), malformed)).toBe(true);
  });

  it("is order-independent", () => {
    const detectors = [det("a", false), det("b", false), det("c", true)];
    expect(shouldRunRca(fired("a", "b", "c"), detectors)).toBe(true);
    expect(shouldRunRca(fired("c", "b", "a"), detectors)).toBe(true);
  });

  it("duplicate fired ids do not change the outcome", () => {
    expect(shouldRunRca(fired("a", "a"), [det("a", false)])).toBe(false);
    expect(shouldRunRca(fired("b", "b"), [det("b", true)])).toBe(true);
  });

  it("ignores enableRca of detectors that did not fire", () => {
    // `b` is on but absent from `fired`; only off `a` fired.
    expect(shouldRunRca(fired("a"), [det("a", false), det("b", true)])).toBe(false);
  });

  it("scales: 50 off + 1 on, only the on fired -> runs; only offs fired -> skips", () => {
    const offs = Array.from({ length: 50 }, (_, i) => det(`off${i}`, false));
    const detectors = [...offs, det("on", true)];
    expect(shouldRunRca(fired("on"), detectors)).toBe(true);
    expect(
      shouldRunRca(
        offs.slice(0, 50).map((d) => ({ detectorId: d.id })),
        detectors,
      ),
    ).toBe(false);
  });
});

// ---- 2. traceFindingId -----------------------------------------------------

describe("traceFindingId: one finding (and one RCA job) per trace", () => {
  it("is deterministic for the same project + trace", () => {
    expect(traceFindingId("proj", "trace")).toBe(traceFindingId("proj", "trace"));
  });

  it("does not depend on which/how many detectors fired -> same single RCA job per trace", () => {
    // The processor enqueues the RCA job as `rca-${traceFindingId(p, t)}`. Since
    // the id ignores the detector set, 3 detectors firing on a trace and 1
    // detector firing on the same trace produce the SAME job id -> exactly one
    // RCA agent per trace (BullMQ dedups by job id on retries too).
    const jobForThreeDetectors = `rca-${traceFindingId("proj", "trace")}`;
    const jobForOneDetector = `rca-${traceFindingId("proj", "trace")}`;
    expect(jobForThreeDetectors).toBe(jobForOneDetector);
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
});

// ---- 3. buildRcaFindings ---------------------------------------------------

describe("buildRcaFindings: one RCA payload aggregates every fired detector", () => {
  const triggered = [
    { detectorId: "a", detectorName: "Failure", summary: "tool errored", data: { x: 1 } },
    { detectorId: "b", detectorName: "Hallucination", summary: "ungrounded claim", data: null },
    { detectorId: "c", detectorName: "Safety", summary: "PII leak", data: 42 },
  ];

  it("includes one entry per fired detector (3 detectors -> one job, 3 findings)", () => {
    const findings = buildRcaFindings(triggered);
    expect(findings).toHaveLength(3);
    expect(findings.map((f) => f.detectorName)).toEqual(["Failure", "Hallucination", "Safety"]);
  });

  it("carries detectorId, detectorName and summary and drops other fields", () => {
    expect(buildRcaFindings(triggered)[0]).toEqual({
      detectorId: "a",
      detectorName: "Failure",
      summary: "tool errored",
    });
  });

  it("preserves order", () => {
    expect(buildRcaFindings(triggered).map((f) => f.detectorId)).toEqual(["a", "b", "c"]);
  });

  it("returns an empty payload for no fired detectors", () => {
    expect(buildRcaFindings([])).toEqual([]);
  });
});
