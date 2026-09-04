import { describe, it, expect } from "vitest";
import { appendWidgetPlacement } from "./widget-placement";

const query = { id: "w-new", type: "query" as const };
const feed = { id: "w-new", type: "trace_feed" as const };

// The placement appended by the call under test.
const appended = (layout: unknown, widget: { id: string; type: "query" | "trace_feed" }) => {
  const next = appendWidgetPlacement(layout, widget);
  return next === null ? null : next[next.length - 1];
};

describe("appendWidgetPlacement", () => {
  it("places the first widget of an empty dashboard in the top-left slot", () => {
    expect(appendWidgetPlacement([], query)).toEqual([{ i: "w-new", x: 0, y: 0, w: 6, h: 4 }]);
  });

  it("gives a trace feed a taller tile than a query widget", () => {
    expect(appended([], feed)).toEqual({ i: "w-new", x: 0, y: 0, w: 6, h: 6 });
  });

  it("packs the second widget beside the first on the same row", () => {
    const layout = [{ i: "w1", x: 0, y: 0, w: 6, h: 4 }];
    expect(appended(layout, query)).toEqual({ i: "w-new", x: 6, y: 0, w: 6, h: 4 });
  });

  it("starts a new row once both slots of the bottom row are taken", () => {
    const layout = [
      { i: "w1", x: 0, y: 0, w: 6, h: 4 },
      { i: "w2", x: 6, y: 0, w: 6, h: 4 },
    ];
    expect(appended(layout, query)).toEqual({ i: "w-new", x: 0, y: 4, w: 6, h: 4 });
  });

  it("starts a new row when a full-width entry occupies the bottom row", () => {
    const layout = [{ i: "w1", x: 0, y: 0, w: 12, h: 3 }];
    expect(appended(layout, query)).toEqual({ i: "w-new", x: 0, y: 3, w: 6, h: 4 });
  });

  it("starts a new row when a hand-dragged entry straddles both slots", () => {
    const layout = [{ i: "w1", x: 3, y: 2, w: 6, h: 4 }];
    expect(appended(layout, query)).toEqual({ i: "w-new", x: 0, y: 6, w: 6, h: 4 });
  });

  it("lands below the tallest entry of a seeded mixed-size layout", () => {
    const layout = [
      { i: "s0", x: 0, y: 0, w: 3, h: 2 },
      { i: "s1", x: 3, y: 0, w: 3, h: 2 },
      { i: "s2", x: 6, y: 0, w: 3, h: 2 },
      { i: "s3", x: 9, y: 0, w: 3, h: 2 },
      { i: "s4", x: 0, y: 2, w: 8, h: 6 },
      { i: "s5", x: 8, y: 2, w: 4, h: 6 },
      { i: "s6", x: 0, y: 8, w: 6, h: 4 },
      { i: "s7", x: 6, y: 8, w: 6, h: 4 },
    ];
    expect(appended(layout, feed)).toEqual({ i: "w-new", x: 0, y: 12, w: 6, h: 6 });
  });

  it("keeps the existing entries ahead of the new one", () => {
    const layout = [{ i: "w1", x: 0, y: 0, w: 6, h: 4 }];
    expect(appendWidgetPlacement(layout, query)).toEqual([
      { i: "w1", x: 0, y: 0, w: 6, h: 4 },
      { i: "w-new", x: 6, y: 0, w: 6, h: 4 },
    ]);
  });

  it("returns null when the widget already has a placement", () => {
    const layout = [{ i: "w-new", x: 6, y: 4, w: 3, h: 2 }];
    expect(appendWidgetPlacement(layout, query)).toBeNull();
  });

  it("drops unrenderable entries rather than carrying them forward", () => {
    // A malformed entry crashes the grid for every member on the next read, so
    // the rewrite is also a repair; only real placements survive.
    const layout = [null, "x", { i: "w1", x: 0, y: 0, w: 6, h: 4 }, { i: "w2", x: -1, y: 0 }];
    expect(appendWidgetPlacement(layout, query)).toEqual([
      { i: "w1", x: 0, y: 0, w: 6, h: 4 },
      { i: "w-new", x: 6, y: 0, w: 6, h: 4 },
    ]);
  });

  it("treats a layout that is not an array as empty", () => {
    expect(appendWidgetPlacement(null, query)).toEqual([{ i: "w-new", x: 0, y: 0, w: 6, h: 4 }]);
    expect(appendWidgetPlacement({ i: "w1" }, query)).toEqual([
      { i: "w-new", x: 0, y: 0, w: 6, h: 4 },
    ]);
  });
});
