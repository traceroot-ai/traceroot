// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
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
      expect(screen.getByText("api")).toBeTruthy();
      expect(screen.getByText("worker")).toBeTruthy();
      expect(screen.getByText("frontend")).toBeTruthy();
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
