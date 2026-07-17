// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { cloneElement, isValidElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WidgetQueryResult } from "../types";
import {
  ChartTip,
  QueryWidgetRenderer,
  bucketLabel,
  fmtStatNumber,
  seriesNameFormatter,
} from "./renderers";

// jsdom reports 0x0 for the container recharts measures against, so
// ResponsiveContainer renders nothing. Stub it with a fixed-size div and, like
// the real ResponsiveContainer, clone the chart child with explicit
// width/height props so it actually mounts and produces SVG output.
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

function makeResult(
  columns: string[],
  rows: WidgetQueryResult["rows"],
  meta: WidgetQueryResult["meta"] = {},
): WidgetQueryResult {
  return { columns, rows, meta };
}

describe("QueryWidgetRenderer", () => {
  afterEach(cleanup);

  describe("number display", () => {
    it("renders the formatted stat, coercing a Decimal string from the query engine", () => {
      const result = makeResult(["value"], [["12.3456"]]);
      render(<QueryWidgetRenderer display="number" result={result} />);
      expect(screen.getByText("12.3456")).toBeTruthy();
    });

    it("shows the empty state instead of a stat when there are no rows", () => {
      const result = makeResult(["value"], []);
      render(<QueryWidgetRenderer display="number" result={result} />);
      expect(screen.getByText("No data in range")).toBeTruthy();
    });
  });

  describe("table display", () => {
    it("renders a header per column and a formatted cell per row value", () => {
      const result = makeResult(
        ["model_name", "count"],
        [
          ["gpt-4o", 10],
          ["haiku", "5.5000"],
        ],
      );
      render(<QueryWidgetRenderer display="table" result={result} />);
      expect(screen.getByText("model_name")).toBeTruthy();
      expect(screen.getByText("count")).toBeTruthy();
      expect(screen.getByText("gpt-4o")).toBeTruthy();
      expect(screen.getByText("haiku")).toBeTruthy();
      expect(screen.getByText("10")).toBeTruthy();
      // Decimal string cell is formatted like fmtNumber would format it.
      expect(screen.getByText("5.5")).toBeTruthy();
    });

    it("renders dimension cells verbatim and only formats the metric column", () => {
      const result = makeResult(
        ["user_id", "value"],
        [
          // Numeric-looking identifiers must not be reformatted: past 2^53
          // Number() loses the final digits, and "0123" would drop its zero.
          ["9007199254740993", "5.5000"],
          ["0123", 10],
        ],
      );
      render(<QueryWidgetRenderer display="table" result={result} />);
      expect(screen.getByText("9007199254740993")).toBeTruthy();
      expect(screen.getByText("0123")).toBeTruthy();
      // The metric column keeps fmtNumber formatting.
      expect(screen.getByText("5.5")).toBeTruthy();
      expect(screen.getByText("10")).toBeTruthy();
    });

    it("shows the empty state instead of a table when there are no rows", () => {
      const result = makeResult(["model_name", "count"], []);
      render(<QueryWidgetRenderer display="table" result={result} />);
      expect(screen.getByText("No data in range")).toBeTruthy();
      expect(screen.queryByRole("table")).toBeNull();
    });
  });

  describe("line/area (timeseries) display", () => {
    const bucketedRows: WidgetQueryResult["rows"] = [
      ["2026-06-01T00:00:00", "gpt-4o", 1],
      ["2026-06-01T00:00:00", "haiku", 2],
      ["2026-06-02T00:00:00", "gpt-4o", 3],
    ];

    it("renders a line chart with one series per breakdown value (hour granularity)", () => {
      const result = makeResult(["bucket", "model_name", "value"], bucketedRows, {
        granularity: "hour",
      });
      const { container } = render(<QueryWidgetRenderer display="line" result={result} />);
      // Two breakdown series -> two <path class="recharts-line-curve">.
      const lines = container.querySelectorAll(".recharts-line-curve");
      expect(lines.length).toBe(2);
      // Hour granularity keeps the "T" separator swapped for a space.
      const ticks = Array.from(container.querySelectorAll(".recharts-cartesian-axis-tick-value"));
      expect(ticks.some((t) => t.textContent?.includes(" ") && !t.textContent?.includes("T"))).toBe(
        true,
      );
    });

    it("renders an area chart for a plain (no-breakdown) bucketed series (day granularity)", () => {
      const result = makeResult(
        ["bucket", "value"],
        [
          ["2026-06-01T00:00:00", 5],
          ["2026-06-02T00:00:00", 8],
        ],
        { granularity: "day" },
      );
      const { container } = render(<QueryWidgetRenderer display="area" result={result} />);
      const areas = container.querySelectorAll(".recharts-area-area");
      expect(areas.length).toBe(1);
      // Day granularity ticks are sliced to MM-DD (5 chars), no time component.
      const ticks = Array.from(container.querySelectorAll(".recharts-cartesian-axis-tick-value"));
      expect(ticks.some((t) => t.textContent === "06-01")).toBe(true);
    });

    it("shows the empty state instead of a chart when there are no rows", () => {
      const result = makeResult(["bucket", "value"], [], { granularity: "hour" });
      const { container } = render(<QueryWidgetRenderer display="line" result={result} />);
      expect(screen.getByText("No data in range")).toBeTruthy();
      expect(container.querySelectorAll(".recharts-line-curve").length).toBe(0);
    });

    it("draws a non-additive series through NULL gap buckets instead of dropping to 0", () => {
      // p95 over a window with an empty middle bucket: the backend's Nullable
      // WITH FILL row carries null, and the line must bridge it (connectNulls)
      // rather than chart a false collapse. Both flanking points survive.
      const result = makeResult(
        ["bucket", "value"],
        [
          ["2026-06-01T00:00:00", 120],
          ["2026-06-02T00:00:00", null],
          ["2026-06-03T00:00:00", 90],
        ],
        { granularity: "day" },
      );
      const { container } = render(
        <QueryWidgetRenderer display="line" result={result} agg="p95" />,
      );
      const [curve] = Array.from(container.querySelectorAll(".recharts-line-curve"));
      expect(curve).toBeTruthy();
      // One unbroken path: a broken (per-segment) render or a dip to the
      // 0-baseline would betray the gap handling. The path must span from the
      // first bucket to the last.
      const d = curve.getAttribute("d") ?? "";
      expect(d.length).toBeGreaterThan(0);
      expect((d.match(/M/g) ?? []).length).toBe(1);
    });

    it("keeps a non-additive AREA off the zero baseline over gap buckets", () => {
      // Stacked areas are the trap: recharts' stack accessor coerces null to
      // 0 BEFORE connectNulls is consulted, redrawing the false collapse. A
      // non-additive area therefore renders unstacked — its bridged curve has
      // exactly two points (M + one L); a baseline dip would add a third.
      const result = makeResult(
        ["bucket", "value"],
        [
          ["2026-06-01T00:00:00", 120],
          ["2026-06-02T00:00:00", null],
          ["2026-06-03T00:00:00", 90],
        ],
        { granularity: "day" },
      );
      const { container } = render(
        <QueryWidgetRenderer display="area" result={result} agg="p95" />,
      );
      const [curve] = Array.from(container.querySelectorAll(".recharts-area-curve"));
      expect(curve).toBeTruthy();
      const d = curve.getAttribute("d") ?? "";
      expect((d.match(/M/g) ?? []).length).toBe(1);
      expect((d.match(/L/g) ?? []).length).toBe(1);
    });
  });

  describe("line/area empty-breakdown fallback", () => {
    it("shows the empty state when every row is a WITH FILL gap row", () => {
      const result = makeResult(
        ["bucket", "model_name", "value"],
        [
          ["2026-06-01T00:00:00", "", 0],
          ["2026-06-02T00:00:00", "", 0],
        ],
        { granularity: "day" },
      );
      const { container } = render(<QueryWidgetRenderer display="line" result={result} />);
      expect(screen.getByText("No data in range")).toBeTruthy();
      expect(container.querySelectorAll(".recharts-line-curve").length).toBe(0);
    });

    it("keeps the flat zero line for a no-breakdown window of gap rows", () => {
      const result = makeResult(
        ["bucket", "value"],
        [
          ["2026-06-01T00:00:00", 0],
          ["2026-06-02T00:00:00", 0],
        ],
        { granularity: "day" },
      );
      const { container } = render(<QueryWidgetRenderer display="line" result={result} />);
      expect(screen.queryByText("No data in range")).toBeNull();
      expect(container.querySelectorAll(".recharts-line-curve").length).toBe(1);
    });
  });

  describe("bar display", () => {
    it("renders one bar cell per categorical group", () => {
      const result = makeResult(
        ["service", "value"],
        [
          ["api", 10],
          ["worker", 20],
          ["frontend", 5],
        ],
      );
      const { container } = render(<QueryWidgetRenderer display="bar" result={result} />);
      const cells = container.querySelectorAll(".recharts-bar-rectangle");
      expect(cells.length).toBe(3);
      // each category shows exactly twice: on the axis AND in the legend row
      for (const name of ["api", "worker", "frontend"]) {
        expect(screen.getAllByText(name)).toHaveLength(2);
      }
    });
  });

  describe("pie display", () => {
    // recharts v3's Pie derives its sectors from an internal store selector
    // keyed off a measured chart offset; under jsdom (no real layout/
    // ResizeObserver) that selector never resolves, so no <path> sectors
    // materialize even with the ResponsiveContainer stub above (verified with
    // a ResizeObserver polyfill and a getBoundingClientRect stub — neither
    // unblocks it). What is verifiable is that the pie mounts without
    // crashing and produces its chart surface and layer group.
    it("mounts the pie chart surface for a categorical result without crashing", () => {
      const result = makeResult(
        ["service", "value"],
        [
          ["api", 10],
          ["worker", 20],
        ],
      );
      const { container } = render(<QueryWidgetRenderer display="pie" result={result} />);
      expect(container.querySelector(".recharts-surface")).toBeTruthy();
      expect(container.querySelector(".recharts-pie")).toBeTruthy();
    });
  });

  describe("histogram display", () => {
    it("renders bucket-range labels from lo/hi/height row tuples", () => {
      const result = makeResult(
        ["lo", "hi", "height"],
        [
          [0, 10, 3],
          [10, 20, 7],
        ],
      );
      const { container } = render(<QueryWidgetRenderer display="histogram" result={result} />);
      const bars = container.querySelectorAll(".recharts-bar-rectangle");
      expect(bars.length).toBe(2);
      // Scoped to the container: recharts also parks a hidden text-measurement
      // span with the same content directly on document.body.
      expect(within(container).getByText("0–10")).toBeTruthy();
      expect(within(container).getByText("10–20")).toBeTruthy();
    });

    it("shows the empty state instead of a chart when there are no rows", () => {
      const result = makeResult(["lo", "hi", "height"], []);
      render(<QueryWidgetRenderer display="histogram" result={result} />);
      expect(screen.getByText("No data in range")).toBeTruthy();
    });
  });
});

describe("NumberView units", () => {
  afterEach(cleanup);
  const result = { columns: ["value"], rows: [["12.5"]], meta: {} };

  it("prefixes cost values with the dollar sign", () => {
    render(<QueryWidgetRenderer display="number" result={result} unit={{ prefix: "$" }} />);
    expect(screen.getByText("$12.5")).toBeTruthy();
  });

  it("suffixes latency values with ms", () => {
    render(<QueryWidgetRenderer display="number" result={result} unit={{ suffix: "ms" }} />);
    expect(screen.getByText("12.5")).toBeTruthy();
    expect(screen.getByText("ms")).toBeTruthy();
  });

  it("renders bare numbers when the measure has no unit", () => {
    render(<QueryWidgetRenderer display="number" result={result} />);
    expect(screen.getByText("12.5")).toBeTruthy();
    expect(screen.queryByText("$12.5")).toBeNull();
    expect(screen.queryByText("ms")).toBeNull();
  });
});

describe("ChartTip", () => {
  afterEach(cleanup);

  it("renders nothing when inactive or when the payload is empty", () => {
    const { container: inactive } = render(
      <ChartTip active={false} payload={[{ name: "a", value: 1 }]} />,
    );
    expect(inactive.firstChild).toBeNull();

    const { container: empty } = render(<ChartTip active payload={[]} />);
    expect(empty.firstChild).toBeNull();
  });

  it("applies the measure unit to every value row", () => {
    render(
      <ChartTip
        active
        payload={[
          { name: "gpt-4o", value: "0.0034", color: "#a78bfa" },
          { name: "haiku", value: null, color: "#60a5fa" },
        ]}
        unit={{ prefix: "$" }}
      />,
    );
    expect(screen.getByText("$0.0034")).toBeTruthy();
    // A gap bucket stays a bare dash — no unit on nothing.
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("renders the label header and one swatch+name+value row per series", () => {
    const { container } = render(
      <ChartTip
        active
        label="2026-06-01T00:00:00"
        labelFormatter={bucketLabel}
        payload={[
          { name: "gpt-4o", value: 10, color: "#a78bfa" },
          { name: "haiku", value: "5.5000", payload: { fill: "#60a5fa" } },
        ]}
      />,
    );

    // Bucket label header with the "T" separator swapped for a space.
    expect(screen.getByText("2026-06-01 00:00:00")).toBeTruthy();

    expect(screen.getByText("gpt-4o")).toBeTruthy();
    expect(screen.getByText("10")).toBeTruthy();
    expect(screen.getByText("haiku")).toBeTruthy();
    // Decimal strings from the query engine format like fmtNumber.
    expect(screen.getByText("5.5")).toBeTruthy();

    // Swatch color: the row's data fill wins over the series color.
    const swatches = Array.from(container.querySelectorAll("div[style]")).map(
      (el) => (el as HTMLElement).style.backgroundColor,
    );
    expect(swatches).toContain("rgb(167, 139, 250)");
    expect(swatches).toContain("rgb(96, 165, 250)");
  });

  it("maps the synthetic single-series name to the spec's measure via the name formatter", () => {
    render(
      <ChartTip
        active
        payload={[{ name: "value", value: 3 }]}
        nameFormatter={seriesNameFormatter("cost")}
      />,
    );
    expect(screen.getByText("cost")).toBeTruthy();
    expect(screen.queryByText("value")).toBeNull();
  });

  it("keeps breakdown names untouched and shows the raw name without a measure label", () => {
    expect(seriesNameFormatter("cost")("gpt-4o")).toBe("gpt-4o");
    expect(seriesNameFormatter(undefined)("value")).toBe("value");
  });
});

describe("fmtStatNumber", () => {
  it("compacts large magnitudes so tiles stay bounded", () => {
    expect(fmtStatNumber(705877)).toBe("705.9K");
    expect(fmtStatNumber("12345678")).toBe("12.3M");
    expect(fmtStatNumber(-250000)).toBe("-250K");
  });
  it("keeps small values in full precision", () => {
    expect(fmtStatNumber("12.5")).toBe("12.5");
    expect(fmtStatNumber(99999)).toBe("99,999");
    expect(fmtStatNumber(0.0004)).toBe("0.0004");
  });
});

describe("unit formatting on charts and tables", () => {
  afterEach(cleanup);

  it("applies the measure unit to the table's metric column", () => {
    const result = makeResult(["model_name", "value"], [["gpt-4o", "0.0034"]]);
    render(<QueryWidgetRenderer display="table" result={result} unit={{ prefix: "$" }} />);
    expect(screen.getByText("$0.0034")).toBeTruthy();
    // Dimension cells stay verbatim — no unit, no numeric reformatting.
    expect(screen.getByText("gpt-4o")).toBeTruthy();
  });

  it("applies the measure unit to time-series axis ticks", () => {
    const result = makeResult(
      ["bucket", "value"],
      [
        ["2026-06-01T00:00:00", 100],
        ["2026-06-02T00:00:00", 200],
      ],
      { granularity: "day" },
    );
    const { container } = render(
      <QueryWidgetRenderer display="line" result={result} unit={{ suffix: "ms" }} />,
    );
    const ticks = Array.from(container.querySelectorAll(".recharts-cartesian-axis-tick-value"));
    expect(ticks.some((t) => t.textContent?.includes("ms"))).toBe(true);
  });
});

describe("chart legend", () => {
  // RTL auto-cleanup needs vitest globals, which this config doesn't enable.
  afterEach(cleanup);

  it("multi-series line: legend lists series sorted with a window Total, no-breakdown gets none", () => {
    const multi = makeResult(
      ["bucket", "model_name", "value"],
      [
        ["2026-06-01T00:00:00", "gpt", 10],
        ["2026-06-01T00:00:00", "claude", 30],
        ["2026-06-01T01:00:00", "gpt", 5],
      ],
    );
    const { unmount } = render(<QueryWidgetRenderer display="line" result={multi} agg="sum" />);
    const legend = screen.getByRole("list", { name: "Chart legend" });
    expect(legend).toBeTruthy();
    const rows = screen.getAllByRole("listitem").map((r) => r.textContent);
    // Total 45 leads, then series sorted descending: claude 30, gpt 15
    expect(rows[0]).toContain("Total");
    expect(rows[0]).toContain("45");
    expect(rows[1]).toContain("claude");
    expect(rows[1]).toContain("30");
    expect(rows[2]).toContain("gpt");
    expect(rows[2]).toContain("15");
    unmount();

    const single = makeResult(["bucket", "value"], [["2026-06-01T00:00:00", 10]]);
    render(<QueryWidgetRenderer display="line" result={single} agg="sum" />);
    expect(screen.queryByRole("list", { name: "Chart legend" })).toBeNull();
  });

  it("non-additive series legend shows per-series bucket averages and no Total", () => {
    const multi = makeResult(
      ["bucket", "model_name", "value"],
      [
        ["2026-06-01T00:00:00", "gpt", 100],
        ["2026-06-01T01:00:00", "gpt", 200],
        ["2026-06-01T00:00:00", "claude", 50],
      ],
    );
    render(<QueryWidgetRenderer display="line" result={multi} agg="p95" />);
    const legend = screen.getByRole("list", { name: "Chart legend" });
    // gpt averages its two buckets (150); claude's gap bucket stays out of its average
    expect(legend.textContent).toContain("150");
    expect(legend.textContent).not.toContain("Total");
  });
  it("labels a single-series breakdown timeseries via the legend", () => {
    // With one breakdown group the chart is a bare line — the legend is the
    // only place the group's name (e.g. which model) can appear.
    const single = makeResult(
      ["bucket", "model_name", "value"],
      [
        ["2026-06-01T00:00:00", "gpt-4o-mini", 1],
        ["2026-06-02T00:00:00", "gpt-4o-mini", 3],
      ],
    );
    render(<QueryWidgetRenderer display="line" result={single} agg="sum" />);
    const legend = screen.getByRole("list", { name: "Chart legend" });
    expect(within(legend).getByText("gpt-4o-mini")).toBeTruthy();
  });

  it("labels a single-category pie via the legend", () => {
    // A one-slice pie renders a full unlabeled circle without it.
    const single = makeResult(["service", "value"], [["api", 10]]);
    render(<QueryWidgetRenderer display="pie" result={single} agg="count" />);
    const legend = screen.getByRole("list", { name: "Chart legend" });
    expect(within(legend).getByText("api")).toBeTruthy();
  });

  it("builds no legend from a stale bucketed result on a categorical display", () => {
    // keepPreviousData hands the pie/bar renderer the previous line query's
    // bucketed rows for a beat after a display switch; those rows have no
    // `name`, which used to render literal "undefined" legend labels.
    const bucketed = makeResult(
      ["bucket", "model_name", "value"],
      [
        ["2026-06-01T00:00:00", "gpt", 10],
        ["2026-06-01T00:00:00", "claude", 30],
        ["2026-06-01T01:00:00", "gpt", 5],
      ],
    );
    const { unmount } = render(<QueryWidgetRenderer display="pie" result={bucketed} agg="sum" />);
    expect(screen.queryByText("undefined")).toBeNull();
    expect(screen.queryByRole("list", { name: "Chart legend" })).toBeNull();
    unmount();

    // Same for a no-breakdown bucketed shape ([bucket, value]).
    const single = makeResult(["bucket", "value"], [["2026-06-01T00:00:00", 10]]);
    render(<QueryWidgetRenderer display="bar" result={single} agg="sum" />);
    expect(screen.queryByText("undefined")).toBeNull();
    expect(screen.queryByRole("list", { name: "Chart legend" })).toBeNull();
  });

  it("builds no legend from a stale categorical result on a timeseries display", () => {
    const categorical = makeResult(
      ["service", "value"],
      [
        ["api", 10],
        ["worker", 20],
      ],
    );
    render(<QueryWidgetRenderer display="line" result={categorical} agg="sum" />);
    expect(screen.queryByRole("list", { name: "Chart legend" })).toBeNull();
  });

  it("bar legend hover dims the other categories", () => {
    const result = makeResult(
      ["service", "value"],
      [
        ["api", 10],
        ["worker", 20],
      ],
    );
    const { container } = render(<QueryWidgetRenderer display="bar" result={result} />);
    const rows = screen.getAllByRole("listitem");
    // rows[0] is the Total row; rows[1] is "worker" (sorted first at 20)
    fireEvent.mouseEnter(rows[1]);
    const dimmed = container.querySelectorAll('.recharts-bar-rectangle path[fill-opacity="0.14"]');
    expect(dimmed.length).toBe(1); // "api" dimmed (0.7 * 0.2)
    fireEvent.mouseLeave(rows[1]);
    expect(
      container.querySelectorAll('.recharts-bar-rectangle path[fill-opacity="0.14"]').length,
    ).toBe(0);
  });
});
