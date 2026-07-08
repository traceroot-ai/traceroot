import { describe, expect, it } from "vitest";
import { fmtNumber, pivotRows } from "./renderers";

describe("fmtNumber", () => {
  it("formats a numeric string (Decimal from ClickHouse) as a formatted number", () => {
    expect(fmtNumber("0.379846500")).toBe("0.3798");
  });

  it("returns non-numeric strings unchanged", () => {
    expect(fmtNumber("not-a-number")).toBe("not-a-number");
  });

  it("returns an em dash for null", () => {
    expect(fmtNumber(null)).toBe("—");
  });
});

describe("pivotRows", () => {
  it("pivots bucket+breakdown rows into one series per breakdown value, zero-filling missing combos", () => {
    const out = pivotRows(
      ["bucket", "model_name", "value"],
      [
        ["2026-06-01T00:00:00", "gpt-4o", 1],
        ["2026-06-01T00:00:00", "haiku", 2],
        ["2026-06-02T00:00:00", "gpt-4o", 3],
      ],
    );
    expect(out.seriesKeys).toEqual(["gpt-4o", "haiku"]);
    // haiku is missing from the second bucket — zero-filled to 0
    expect(out.data).toEqual([
      { bucket: "2026-06-01T00:00:00", "gpt-4o": 1, haiku: 2 },
      { bucket: "2026-06-02T00:00:00", "gpt-4o": 3, haiku: 0 },
    ]);
  });

  it("registers WITH FILL gap rows (empty dim, zero value) as buckets without creating a series", () => {
    const out = pivotRows(
      ["bucket", "model_name", "value"],
      [
        // Leading empty buckets synthesized by the query's WITH FILL.
        ["2026-06-01T00:00:00", "", 0],
        ["2026-06-02T00:00:00", "", "0"],
        ["2026-06-03T00:00:00", "gpt-4o", 3],
      ],
    );
    expect(out.seriesKeys).toEqual(["gpt-4o"]);
    // The empty buckets extend the x-axis domain, zero-filled for the series.
    expect(out.data).toEqual([
      { bucket: "2026-06-01T00:00:00", "gpt-4o": 0 },
      { bucket: "2026-06-02T00:00:00", "gpt-4o": 0 },
      { bucket: "2026-06-03T00:00:00", "gpt-4o": 3 },
    ]);
  });

  it("registers NULL gap rows as buckets too (a Nullable expr slipping the type pin)", () => {
    const out = pivotRows(
      ["bucket", "model_name", "value"],
      [
        ["2026-06-01T00:00:00", null, 0],
        ["2026-06-02T00:00:00", "gpt-4o", 3],
      ],
    );
    expect(out.seriesKeys).toEqual(["gpt-4o"]);
    expect(out.data).toEqual([
      { bucket: "2026-06-01T00:00:00", "gpt-4o": 0 },
      { bucket: "2026-06-02T00:00:00", "gpt-4o": 3 },
    ]);
  });

  it("keeps a genuine empty-string dim with a nonzero value as a real series", () => {
    const out = pivotRows(["bucket", "model_name", "value"], [["2026-06-01T00:00:00", "", 2]]);
    expect(out.seriesKeys).toEqual([""]);
    expect(out.data).toEqual([{ bucket: "2026-06-01T00:00:00", "": 2 }]);
  });

  it("handles no-breakdown shape (bucket+value)", () => {
    const out = pivotRows(["bucket", "value"], [["2026-06-01", 5]]);
    expect(out.seriesKeys).toEqual(["value"]);
    expect(out.data).toEqual([{ bucket: "2026-06-01", value: 5 }]);
  });

  it("handles categorical [dim, value] shape (no bucket)", () => {
    const out = pivotRows(
      ["service", "value"],
      [
        ["api", 10],
        ["worker", 20],
        ["frontend", 5],
      ],
    );
    expect(out.seriesKeys).toEqual(["api", "worker", "frontend"]);
    expect(out.data).toEqual([
      { name: "api", value: 10 },
      { name: "worker", value: 20 },
      { name: "frontend", value: 5 },
    ]);
  });

  it("treats null dim values as the string 'null' in the bucketed branch", () => {
    const out = pivotRows(
      ["bucket", "model_name", "value"],
      [
        ["2026-06-01T00:00:00", null, 7],
        ["2026-06-01T00:00:00", "haiku", 3],
      ],
    );
    expect(out.seriesKeys).toContain("null");
    expect(out.data[0]).toMatchObject({ null: 7, haiku: 3 });
  });

  it("prefixes dim values that collide with row shape keys (e.g. 'bucket')", () => {
    // A dimension value literally named "bucket" must be stored as "series:bucket"
    // so it does not overwrite the pivot row's own `bucket` timestamp key.
    const out = pivotRows(
      ["bucket", "model", "value"],
      [
        ["2026-06-01T00:00:00", "bucket", 10],
        ["2026-06-01T00:00:00", "gpt-4o", 20],
      ],
    );
    expect(out.seriesKeys).toContain("series:bucket");
    expect((out.data[0] as Record<string, unknown>)["bucket"]).toBe("2026-06-01T00:00:00");
  });

  it("zero-fills a series that only appears in the middle bucket for first and last buckets", () => {
    // "rare-model" only has data in the second of three buckets; the first and
    // last must be zero-filled so chart lines are continuous and honest.
    const out = pivotRows(
      ["bucket", "model", "value"],
      [
        ["2026-06-01T00:00:00", "gpt-4o", 1],
        ["2026-06-02T00:00:00", "gpt-4o", 2],
        ["2026-06-02T00:00:00", "rare-model", 5],
        ["2026-06-03T00:00:00", "gpt-4o", 3],
      ],
    );
    expect(out.seriesKeys).toContain("rare-model");
    const d = out.data as Record<string, unknown>[];
    expect(d[0]["rare-model"]).toBe(0); // first bucket: zero-filled
    expect(d[2]["rare-model"]).toBe(0); // last bucket: zero-filled
    expect(d[1]["rare-model"]).toBe(5); // middle bucket: real value
  });
});
