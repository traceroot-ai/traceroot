// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { cloneElement, isValidElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGGS, type WidgetQueryResult } from "../types";
import { QueryWidgetRenderer, isAdditiveAgg } from "./renderers";

// jsdom reports 0x0 for the container recharts measures against, so
// ResponsiveContainer renders nothing. Stub it with a fixed size and, like the real
// one, clone the chart child with explicit width/height props so it mounts.
vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>();
  return {
    ...actual,
    ResponsiveContainer: ({
      children,
    }: {
      children:
        | React.ReactElement
        | ((size: { width: number; height: number }) => React.ReactElement);
    }) => {
      const size = { width: 800, height: 400 };
      const chart = typeof children === "function" ? children(size) : children;
      return (
        <div style={{ width: size.width, height: size.height }}>
          {isValidElement(chart) ? cloneElement(chart, size) : chart}
        </div>
      );
    },
  };
});

// The backend's _NON_ADDITIVE_AGGS (widget_query.py) spelled out independently.
const BACKEND_NON_ADDITIVE = ["avg", "min", "max", "p50", "p75", "p90", "p95", "p99"];

describe("isAdditiveAgg", () => {
  it("calls exactly the aggregations the backend treats as non-additive a gap", () => {
    const nonAdditive = AGGS.filter((agg) => !isAdditiveAgg(agg));
    expect([...nonAdditive].sort()).toEqual([...BACKEND_NON_ADDITIVE].sort());
  });

  it("counts sums, counts and unique counts as additive", () => {
    expect(isAdditiveAgg("sum")).toBe(true);
    expect(isAdditiveAgg("count")).toBe(true);
    expect(isAdditiveAgg("uniq")).toBe(true);
  });

  it("treats an aggregation it has never heard of, and a missing one, as additive", () => {
    // An agg the engine grows and nobody adds here must land on the same side for every consumer.
    expect(isAdditiveAgg("stddev")).toBe(true);
    expect(isAdditiveAgg(undefined)).toBe(true);
  });
});

function makeResult(rows: WidgetQueryResult["rows"]): WidgetQueryResult {
  return {
    columns: ["bucket", "model_name", "value"],
    rows,
    meta: { granularity: "day" },
  };
}

const GAPPY_ROWS: WidgetQueryResult["rows"] = [
  ["2026-06-01T00:00:00", "gpt", 120],
  ["2026-06-02T00:00:00", "claude", 5],
  ["2026-06-03T00:00:00", "gpt", 90],
];

function curves(agg: string): string[] {
  const { container, unmount } = render(
    <QueryWidgetRenderer
      display="line"
      result={makeResult(GAPPY_ROWS)}
      agg={agg as (typeof AGGS)[number]}
    />,
  );
  const paths = Array.from(container.querySelectorAll(".recharts-line-curve")).map(
    (c) => c.getAttribute("d") ?? "",
  );
  unmount();
  return paths;
}

describe("QueryWidgetRenderer gap fill by aggregation", () => {
  afterEach(cleanup);

  it("draws an unknown aggregation exactly like an additive one, not like a percentile", () => {
    const additive = curves("sum");
    // Three plotted points per series: the hole is a real zero.
    expect(additive.every((d) => (d.match(/L/g) ?? []).length === 2)).toBe(true);

    expect(curves("stddev")).toEqual(additive);
    expect(curves("uniq")).toEqual(additive);
    expect(curves("count")).toEqual(additive);

    // The percentile treatment really is different, so the assertions are not a tautology.
    expect(curves("p95")).not.toEqual(additive);
  });
});
