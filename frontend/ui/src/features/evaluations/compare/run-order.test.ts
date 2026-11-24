import { describe, expect, it } from "vitest";
import { oldestFirst } from "./run-order";

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
