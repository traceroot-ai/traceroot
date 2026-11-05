import { describe, expect, it } from "vitest";
import { formatWidgetData, formatWidgetDetail } from "../formatters.js";

const WINDOW = {
  start_time: "2026-08-31T18:04:00Z",
  end_time: "2026-09-07T18:04:00Z",
  range: "7d",
  clamped: false,
};

const REF = { id: "w1", dashboard_id: "d1", title: "p95 latency", type: "query" };

describe("formatWidgetDetail", () => {
  it("renders the definition with its dashboard, timestamps, spec and display config", () => {
    const out = formatWidgetDetail({
      id: "w1",
      dashboard_id: "d1",
      dashboard_name: "Latency overview",
      title: "p95 latency",
      type: "query",
      spec: { view: "spans", metric: { measure: "duration", agg: "p95" } },
      display_config: { color: "blue" },
      create_time: "2026-08-01T00:00:00Z",
      update_time: "2026-08-02T00:00:00Z",
    });
    expect(out.split("\n")).toEqual([
      "Widget: w1 | p95 latency | type: query",
      "Dashboard: d1 | Latency overview",
      "Created 2026-08-01T00:00:00Z | updated 2026-08-02T00:00:00Z",
      'Spec: {"view":"spans","metric":{"measure":"duration","agg":"p95"}}',
      'Display config: {"color":"blue"}',
    ]);
  });

  it("states missing pieces explicitly and truncates a long spec", () => {
    const out = formatWidgetDetail({ id: "w1", spec: { note: "x".repeat(2000) } });
    expect(out).toContain("Widget: w1 | (untitled) | type: unknown");
    expect(out).toContain("Dashboard: ? | (unnamed)");
    expect(out).toContain("Created unknown | updated unknown");
    expect(out).toContain("Display config: (none)");
    const specLine = out.split("\n").find((line) => line.startsWith("Spec: "))!;
    expect(specLine.length).toBe("Spec: ".length + 1000);
  });
});

describe("formatWidgetData", () => {
  it("leads with the widget, its dashboard and the window, then the rows", () => {
    const out = formatWidgetData({
      widget: REF,
      window: WINDOW,
      status: "ok",
      columns: ["bucket", "p95"],
      rows: [
        ["2026-09-01T00:00:00", 1.2],
        ["2026-09-02T00:00:00", 1.8],
      ],
      meta: { granularity: "1d" },
      truncated: false,
      error: null,
    });
    const lines = out.split("\n");
    expect(lines[0]).toBe("Widget: w1 | p95 latency | query | ok");
    expect(lines[1]).toBe("Dashboard: d1");
    expect(lines[2]).toMatch(/^Window: range 7d/);
    expect(out).toContain("min 1.2 | max 1.8 (2026-09-02T00:00:00) | latest 1.8");
  });

  it("puts the dashboard's URL after its line when the caller can build one", () => {
    const out = formatWidgetData(
      { widget: REF, window: WINDOW, status: "ok", columns: ["value"], rows: [[3]] },
      { dashboardUrl: (id) => `http://ui.test/projects/p1/dashboard/${id}` },
    );
    expect(out.split("\n")[2]).toBe("URL: http://ui.test/projects/p1/dashboard/d1");
    expect(out).toContain("value (whole window): 3");
  });

  it("says a feed is not summarized and points at list_traces", () => {
    const out = formatWidgetData({
      widget: { ...REF, type: "trace_feed" },
      window: WINDOW,
      status: "skipped",
    });
    expect(out).toContain("Widget: w1 | p95 latency | trace_feed | skipped");
    expect(out).toContain("feed — not summarized; read it with list_traces and the feed's filters");
  });

  it("carries the error reason for a broken widget", () => {
    const out = formatWidgetData({
      widget: REF,
      window: WINDOW,
      status: "error",
      error: "spec: metric: field required",
    });
    expect(out).toContain("Widget: w1 | p95 latency | query | error");
    expect(out).toContain("error: spec: metric: field required");
  });

  it("tolerates a missing payload", () => {
    const out = formatWidgetData(undefined);
    expect(out).toContain("Widget: ? | (untitled) | unknown | unknown");
    expect(out).toContain("No rows in this window.");
  });

  it("bounds the text with a visible marker when even a summarized answer is too long", () => {
    const rows = Array.from({ length: 25 }, (_, i) => [`k-${"x".repeat(900)}-${i}`, i]);
    const out = formatWidgetData({
      widget: REF,
      window: WINDOW,
      status: "ok",
      columns: ["k", "v"],
      rows,
    });
    expect(Buffer.byteLength(out, "utf-8")).toBeLessThan(16 * 1024 + 256);
    expect(out).toContain("output truncated at 16384 bytes");
  });
});

describe("formatWidgetData keeps every row", () => {
  it("shows all rows of a non-series display instead of the short-list cap", () => {
    const rows = Array.from({ length: 40 }, (_, i) => [`model-${i}`, i + 1]);
    const out = formatWidgetData(
      {
        widget: { id: "w1", dashboard_id: "d1", title: "Cost by model", type: "query" },
        window: WINDOW,
        status: "ok",
        columns: ["model_name", "value"],
        rows,
        meta: {},
        truncated: false,
      },
      {},
    );
    expect(out).toContain("40 rows (model_name, value)");
    expect(out).toContain("model-39");
    expect(out).not.toContain("more rows not shown");
  });
});
