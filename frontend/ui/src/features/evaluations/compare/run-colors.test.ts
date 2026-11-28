import { describe, expect, it } from "vitest";
import { assignColorSlots, RUN_DOTS } from "./run-colors";

const slots = (m: Map<string, number>) => Object.fromEntries(m);

describe("assignColorSlots", () => {
  it("colours runs in the order they were selected", () => {
    expect(slots(assignColorSlots(new Map(), ["c", "a", "b"]))).toEqual({ c: 0, a: 1, b: 2 });
  });

  it("keeps every remaining run's colour when another run is removed", () => {
    const before = assignColorSlots(new Map(), ["a", "b", "c"]);
    expect(slots(assignColorSlots(before, ["a", "c"]))).toEqual({ a: 0, c: 2 });
  });

  it("gives an added run the first colour no selected run is using", () => {
    const afterRemoval = assignColorSlots(assignColorSlots(new Map(), ["a", "b", "c"]), ["a", "c"]);
    expect(slots(assignColorSlots(afterRemoval, ["a", "c", "d", "e"]))).toEqual({
      a: 0,
      c: 2,
      d: 1,
      e: 3,
    });
  });
});

describe("RUN_DOTS", () => {
  it("leaves the colours close to an earlier one (teal, orange) until a seventh run", () => {
    expect(RUN_DOTS.slice(0, 6)).not.toContain("bg-teal-500");
    expect(RUN_DOTS.slice(0, 6)).not.toContain("bg-orange-500");
    expect(new Set(RUN_DOTS).size).toBe(RUN_DOTS.length);
  });
});
