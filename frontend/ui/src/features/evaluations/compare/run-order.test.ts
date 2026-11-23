import { describe, expect, it } from "vitest";
import { newestRun, oldestFirst, previousRun } from "./run-order";

describe("oldestFirst", () => {
  const run = (id: string, runNumber: number, startedAt: string) => ({ id, runNumber, startedAt });

  it("orders by start time, then run number, then id", () => {
    const sorted = [
      run("c", 1, "2026-11-03T00:00:00Z"),
      run("b", 7, "2026-11-01T00:00:00Z"),
      run("a", 7, "2026-11-01T00:00:00Z"),
      run("d", 2, "2026-11-01T00:00:00Z"),
    ].sort(oldestFirst);
    expect(sorted.map((r) => r.id)).toEqual(["d", "a", "b", "c"]);
  });

  it("treats an unparseable start time as the epoch instead of breaking the order", () => {
    const sorted = [run("b", 2, "2026-11-01T00:00:00Z"), run("a", 9, "not a date")].sort(
      oldestFirst,
    );
    expect(sorted.map((r) => r.id)).toEqual(["a", "b"]);
  });
});

describe("previousRun", () => {
  const run = (id: string, startedAt: string, datasetId = "ds1") => ({
    id,
    runNumber: 1,
    startedAt,
    datasetId,
  });
  const anchor = run("now", "2026-11-05T00:00:00Z");

  it("is the newest run on the same dataset that started before the given one", () => {
    const runs = [
      run("older", "2026-11-01T00:00:00Z"),
      run("previous", "2026-11-04T00:00:00Z"),
      run("other-dataset", "2026-11-04T12:00:00Z", "ds2"),
      run("later", "2026-11-06T00:00:00Z"),
      anchor,
    ];
    expect(previousRun(runs, anchor, new Set([anchor.id]))?.id).toBe("previous");
  });

  it("skips runs already in the comparison", () => {
    const runs = [run("older", "2026-11-01T00:00:00Z"), run("previous", "2026-11-04T00:00:00Z")];
    expect(previousRun(runs, anchor, new Set(["now", "previous"]))?.id).toBe("older");
  });

  it("is null when no earlier run on the dataset is left", () => {
    const runs = [run("later", "2026-11-06T00:00:00Z"), run("x", "2026-11-01T00:00:00Z", "ds2")];
    expect(previousRun(runs, anchor, new Set())).toBeNull();
  });
});

describe("newestRun", () => {
  const bundle = (id: string, startedAt: string) => ({ run: { id, runNumber: 1, startedAt } });

  it("is the run that started last", () => {
    const runs = [
      bundle("a", "2026-11-01T00:00:00Z"),
      bundle("c", "2026-11-03T00:00:00Z"),
      bundle("b", "2026-11-02T00:00:00Z"),
    ];
    expect(newestRun(runs)?.run.id).toBe("c");
  });

  it("is nothing without runs", () => {
    expect(newestRun([])).toBeUndefined();
  });
});
