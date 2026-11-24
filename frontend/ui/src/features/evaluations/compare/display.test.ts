import { describe, expect, it } from "vitest";
import {
  columnChoices,
  DEFAULT_DISPLAY,
  displayStorageKey,
  isShown,
  metricColumn,
  normalizeDisplay,
  shownColumnCount,
  toggleColumn,
  type DisplayPrefs,
} from "./display";

describe("displayStorageKey", () => {
  it("keeps one layout per project", () => {
    expect(displayStorageKey("p1")).toBe("traceroot:compare-display:p1");
    expect(displayStorageKey("p2")).not.toBe(displayStorageKey("p1"));
  });
});

describe("normalizeDisplay", () => {
  it("starts from today's layout: compact rows, long text clipped, every column shown, outputs diffed against the baseline", () => {
    expect(DEFAULT_DISPLAY).toEqual({
      density: "compact",
      text: "clip",
      hidden: [],
      diff: "baseline",
    });
  });

  it("reads back a stored layout", () => {
    expect(
      normalizeDisplay({
        density: "comfortable",
        text: "wrap",
        hidden: ["output", "metric:q"],
        diff: "expected",
      }),
    ).toEqual({
      density: "comfortable",
      text: "wrap",
      hidden: ["output", "metric:q"],
      diff: "expected",
    });
    expect(normalizeDisplay({ diff: "off" }).diff).toBe("off");
  });

  it("reads anything that isn't a layout as the default", () => {
    for (const stored of [null, undefined, "wrap", 3, [], ["wrap"]]) {
      expect(normalizeDisplay(stored)).toEqual(DEFAULT_DISPLAY);
    }
  });

  it("keeps each setting it recognises and defaults the rest", () => {
    expect(normalizeDisplay({ density: "comfortable", text: "huge", diff: "nonsense" })).toEqual({
      density: "comfortable",
      text: "clip",
      hidden: [],
      diff: "baseline",
    });
    expect(normalizeDisplay({ density: 1, text: "wrap", hidden: "output", extra: true })).toEqual({
      density: "compact",
      text: "wrap",
      hidden: [],
      diff: "baseline",
    });
  });

  it("keeps only columns it knows, once each, and never Input", () => {
    expect(
      normalizeDisplay({
        hidden: ["cost", "input", "cost", 7, "metric:", "metric:quality", "nonsense", null],
      }).hidden,
    ).toEqual(["cost", "metric:quality"]);
  });
});

describe("columns", () => {
  const scorers = [{ name: "quality" }, { name: "route" }];

  it("offers Output, Expected, each metric by name, Latency and Cost, in the table's order", () => {
    expect(columnChoices(scorers)).toEqual([
      { id: "output", label: "Output" },
      { id: "expected", label: "Expected" },
      { id: "metric:quality", label: "quality" },
      { id: "metric:route", label: "route" },
      { id: "latency", label: "Latency" },
      { id: "cost", label: "Cost" },
    ]);
  });

  it("hides a column and shows it again, keeping the others as they are", () => {
    const hidden = toggleColumn(
      { ...DEFAULT_DISPLAY, hidden: ["metric:gone"] },
      metricColumn("quality"),
    );
    expect(hidden.hidden).toEqual(["metric:gone", "metric:quality"]);
    expect(isShown(hidden, metricColumn("quality"))).toBe(false);
    expect(isShown(hidden, "output")).toBe(true);

    const shown = toggleColumn(hidden, metricColumn("quality"));
    expect(shown.hidden).toEqual(["metric:gone"]);
    expect(isShown(shown, metricColumn("quality"))).toBe(true);
  });

  it("counts Input, Run and the columns shown, not a hidden metric this comparison lacks", () => {
    expect(shownColumnCount(DEFAULT_DISPLAY, scorers)).toBe(8);
    const display: DisplayPrefs = {
      ...DEFAULT_DISPLAY,
      hidden: ["cost", "metric:route", "metric:gone"],
    };
    expect(shownColumnCount(display, scorers)).toBe(6);
  });
});
