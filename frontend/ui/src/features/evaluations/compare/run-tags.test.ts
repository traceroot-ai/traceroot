import { describe, expect, it } from "vitest";
import { runLabeler, runTagger } from "./run-tags";

const run = (
  id: string,
  runNumber: number,
  evaluationId = "ev1",
  evaluationName = "support-routing",
) => ({
  run: {
    id,
    runNumber,
    evaluationId,
    evaluationName,
    startedAt: "2026-01-01T00:00:00Z",
    candidateVersion: `v${runNumber}`,
  },
});

describe("runTagger", () => {
  it("names a run by its number within one evaluation", () => {
    const tagOf = runTagger([run("a", 1), run("b", 2)]);
    expect(tagOf("b")).toBe("#2");
  });

  it("adds the evaluation's name when the runs span evaluations, since numbers restart", () => {
    const tagOf = runTagger([run("a", 1), run("b", 1, "ev2", "fast-routing")]);
    expect(tagOf("a")).toBe("support-routing #1");
    expect(tagOf("b")).toBe("fast-routing #1");
  });

  it("tells apart two evaluations that share a name", () => {
    const tagOf = runTagger([run("a", 1), run("b", 2), run("c", 1, "ev2")]);
    expect(tagOf("a")).toBe("support-routing #1");
    expect(tagOf("b")).toBe("support-routing #2");
    expect(tagOf("c")).toBe("support-routing (2) #1");
  });

  it("never numbers a same-named evaluation into another evaluation's name", () => {
    const tagOf = runTagger([
      run("a", 1, "ev1", "foo"),
      run("b", 1, "ev2", "foo"),
      run("c", 1, "ev3", "foo (2)"),
    ]);
    expect(tagOf("a")).toBe("foo #1");
    expect(tagOf("b")).toBe("foo (3) #1");
    expect(tagOf("c")).toBe("foo (2) #1");
  });

  it("names nothing for a run it doesn't have", () => {
    expect(runTagger([run("a", 1)])("gone")).toBe("");
  });
});

describe("runLabeler", () => {
  it("names a run by its tag and candidate version", () => {
    const runs = [run("a", 1), run("b", 2)];
    const labelOf = runLabeler(runs, runTagger(runs));
    expect(labelOf("b")).toBe("#2 v2");
    expect(labelOf("gone")).toBe("");
  });
});

describe("runTagger stability", () => {
  const at = (id: string, runNumber: number, evaluationId: string, startedAt: string) => ({
    run: { id, runNumber, evaluationId, evaluationName: "support-routing", startedAt },
  });

  it("numbers same-named evaluations by earliest start, not by the order shown", () => {
    const early = at("a", 1, "ev-early", "2026-01-01T00:00:00Z");
    const late = at("b", 1, "ev-late", "2026-02-01T00:00:00Z");
    expect(runTagger([early, late])("b")).toBe("support-routing (2) #1");
    expect(runTagger([late, early])("b")).toBe("support-routing (2) #1");
    expect(runTagger([late, early])("a")).toBe("support-routing #1");
  });

  it("breaks a start-time tie by evaluation id", () => {
    const x = at("a", 1, "ev-a", "2026-01-01T00:00:00Z");
    const y = at("b", 1, "ev-b", "2026-01-01T00:00:00Z");
    expect(runTagger([y, x])("b")).toBe("support-routing (2) #1");
  });
});
