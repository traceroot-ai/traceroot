import { describe, expect, it } from "vitest";
import { placeInGroup } from "../assign.js";

const groups = [
  { groupId: "a", center: [1, 0, 0], reach: 0.2 },
  { groupId: "b", center: [0, 1, 0], reach: 0.2 },
];

describe("placeInGroup", () => {
  it("puts a vector near a center in that group", () => {
    const p = placeInGroup([0.95, 0.1, 0], groups);
    expect(p.groupId).toBe("a");
    expect(p.distance).toBeLessThan(0.2);
  });
  it("leaves a vector outside every reach in no group", () => {
    const p = placeInGroup([0, 0, 1], groups);
    expect(p.groupId).toBe("");
    expect(p.distance).toBeCloseTo(1, 5);
  });
  it("does not fall back to a farther group when the nearest is out of reach", () => {
    const p = placeInGroup(
      [0.6, 0.8, 0],
      [
        { ...groups[0], reach: 0.1 },
        { ...groups[1], reach: 0.01 },
      ],
    );
    expect(p.groupId).toBe("");
  });
  it("returns no group when there are none", () => {
    expect(placeInGroup([1, 0, 0], []).groupId).toBe("");
  });
  it("is deterministic on ties: the earlier group wins", () => {
    const tie = [
      { groupId: "x", center: [1, 1, 0], reach: 1 },
      { groupId: "y", center: [1, 1, 0], reach: 1 },
    ];
    expect(placeInGroup([1, 1, 0], tie).groupId).toBe("x");
  });
});
