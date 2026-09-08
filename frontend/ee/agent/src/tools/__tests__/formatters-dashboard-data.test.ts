import { describe, expect, it } from "vitest";
import {
  formatDashboardData,
  formatRows,
  formatWidgetQueryResult,
  formatWindow,
} from "../formatters.js";

const WINDOW = {
  start_time: "2026-08-31T18:04:00Z",
  end_time: "2026-09-07T18:04:00Z",
  range: "7d",
  clamped: false,
};

describe("formatWindow", () => {
  it("names the preset and bounds, and says when retention clamped the start", () => {
    expect(formatWindow(WINDOW)).toBe(
      "Window: range 7d (2026-08-31T18:04:00Z → 2026-09-07T18:04:00Z)",
    );
    expect(formatWindow({ ...WINDOW, range: null, clamped: true })).toBe(
      "Window: explicit bounds (2026-08-31T18:04:00Z → 2026-09-07T18:04:00Z) — start clamped to the plan's retention cutoff",
    );
  });
});

describe("formatRows", () => {
  it("says so for an empty result instead of inventing a figure", () => {
    expect(formatRows(["model_name", "value"], [])).toBe("No rows in this window.");
  });

  it("renders a single number display as one labelled value", () => {
    expect(formatRows(["value"], [[1204311]])).toBe("value: 1,204,311");
  });

  it("renders a breakdown as a capped table with the overflow counted", () => {
    const rows = Array.from({ length: 30 }, (_, i) => [`m${i}`, i * 1.5]);
    const out = formatRows(["model_name", "value"], rows);
    expect(out.split("\n")[0]).toBe("30 rows (model_name, value)");
    expect(out).toContain("  m0  |  0");
    expect(out).toContain("  m24  |  36");
    expect(out).not.toContain("  m25  |");
    expect(out).toContain("… 5 more rows not shown");
  });

  it("summarizes a time series by shape: first, last, min/max/latest, granularity", () => {
    const rows = Array.from({ length: 12 }, (_, i) => [
      `2026-09-0${(i % 9) + 1}T00:00:00`,
      100 + i,
    ]);
    const out = formatRows(["bucket", "p95"], rows, { granularity: "1d" });
    expect(out).toContain("12 buckets (bucket, p95) | granularity 1d");
    expect(out).toContain("min 100 | max 111 | latest 111");
    expect(out).toContain("… 4 more buckets …");
    expect(out.split("\n").filter((l) => l.startsWith("  2026-")).length).toBe(8);
  });

  it("formats decimal strings like numbers", () => {
    expect(formatRows(["model_name", "cost"], [["gpt-5", "184.2034"]])).toContain(
      "gpt-5  |  184.2",
    );
  });
});

describe("formatWidgetQueryResult", () => {
  it("leads with the window and then the rows", () => {
    const out = formatWidgetQueryResult({
      columns: ["model_name", "value"],
      rows: [["gpt-5", 3]],
      meta: {},
      window: WINDOW,
    });
    expect(out.split("\n")[0]).toMatch(/^Window: range 7d/);
    expect(out).toContain("1 rows (model_name, value)");
  });
});

describe("formatDashboardData", () => {
  const data = {
    dashboard: { id: "d1", name: "Latency overview", is_default: false },
    window: WINDOW,
    widgets: [
      {
        id: "w1",
        title: "p95 latency",
        type: "query",
        status: "ok",
        columns: ["bucket", "p95"],
        rows: [
          ["2026-09-01T00:00:00", 1.2],
          ["2026-09-02T00:00:00", 1.8],
        ],
        meta: { granularity: "1d" },
      },
      { id: "w2", title: "Recent errors", type: "trace_feed", status: "skipped" },
      {
        id: "w3",
        title: "Cost by model",
        type: "query",
        status: "error",
        error: "breakdown: field is not groupable",
      },
      {
        id: "w4",
        title: "Errors",
        type: "query",
        status: "ok",
        columns: ["value"],
        rows: [[412]],
        truncated: true,
      },
    ],
    queried: 2,
    skipped: 1,
    failed: 1,
  };

  it("keeps the dashboard's order and gives every widget a status line", () => {
    const out = formatDashboardData(data);
    const lines = out.split("\n");
    expect(lines[0]).toBe("Dashboard: d1 | Latency overview");
    expect(lines[1]).toMatch(/^Window: range 7d/);
    expect(out).toContain("#1 p95 latency | query | ok");
    expect(out).toContain("min 1.2 | max 1.8 | latest 1.8");
    expect(out).toContain(
      "#2 Recent errors | trace_feed | skipped\n  feed — not summarized; read it with list_traces",
    );
    expect(out).toContain(
      "#3 Cost by model | query | error\n  error: breakdown: field is not groupable",
    );
    expect(out).toContain("#4 Errors | query | ok\nvalue: 412\n  (rows capped by the server)");
    expect(out.trim().endsWith("2 widgets queried, 1 feeds skipped, 1 failed")).toBe(true);
  });

  it("stays under its byte budget and says how to drill in when it cuts", () => {
    const rows = Array.from({ length: 25 }, (_, i) => [`series-${"x".repeat(200)}-${i}`, i]);
    const widgets = Array.from({ length: 40 }, (_, i) => ({
      id: `w${i}`,
      title: `Widget ${i}`,
      type: "query",
      status: "ok",
      columns: ["k", "v"],
      rows,
    }));
    const out = formatDashboardData({ ...data, widgets, queried: 40, skipped: 0, failed: 0 });
    expect(Buffer.byteLength(out, "utf-8")).toBeLessThan(16 * 1024 + 256);
    expect(out).toContain(
      "output truncated at 16384 bytes; ask about one widget with run_widget_query",
    );
  });
});
