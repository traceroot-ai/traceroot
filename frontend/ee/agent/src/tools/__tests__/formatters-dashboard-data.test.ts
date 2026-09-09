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

  it("says a number tile is empty in words, since an aggregate over nothing is one NULL row", () => {
    // A dash alone is ambiguous: formatNumber prints the same glyph for a null
    // cell inside a table, and "0" and "no data" are different answers.
    expect(formatRows(["value"], [[null]])).toBe("value: — (no rows in this window)");
    expect(formatRows(["total_tokens"], [[undefined]])).toBe(
      "total_tokens: — (no rows in this window)",
    );
    // A real zero still reads as a measurement.
    expect(formatRows(["value"], [[0]])).toBe("value: 0");
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
    expect(out).toContain("min 100 | max 111 (2026-09-03T00:00:00) | latest 111");
    expect(out).toContain(
      "… 4 more buckets 2026-09-04T00:00:00 → 2026-09-07T00:00:00, min 103 | max 106 …",
    );
    expect(out.split("\n").filter((l) => l.startsWith("  2026-")).length).toBe(8);
  });

  it("keeps a long dense series' largest buckets, so a mid-window spike is never elided", () => {
    // 15 day-buckets flat at 3,000 with one spike in the middle: head and tail
    // alone would hide the only bucket a "when did it spike" answer needs.
    const days = Array.from({ length: 15 }, (_, i) =>
      new Date(Date.UTC(2026, 7, 25) + i * 86_400_000).toISOString().slice(0, 10),
    );
    const rows: Array<[string, number]> = days.map((day) => [
      day,
      day === "2026-09-01" ? 219292 : 3000,
    ]);

    const out = formatRows(["bucket", "value"], rows, { granularity: "1d" });
    const spike = "  2026-09-01  219,292";
    expect(out).toContain(spike);
    // The spike is its own line, not swallowed into an elision note.
    const spikeLine = out.split("\n").find((l) => l.startsWith("  2026-09-01"));
    expect(spikeLine).toBe(spike);
    expect(out).toContain("max 219,292 (2026-09-01)");
    // Head and tail are still shown, and the skipped stretches are counted.
    expect(out).toContain("  2026-08-25  3,000");
    expect(out).toContain("  2026-09-08  3,000");
    expect(out.match(/… \d+ more buckets .+ …/g)).toHaveLength(2);
    // Each elision says which dates it swallowed and what was inside them, so
    // a flat hidden stretch is distinguishable from one hiding a second bump.
    expect(out).toContain("… 4 more buckets 2026-08-28 → 2026-08-31, all 3,000 …");
    expect(out).toContain("… 2 more buckets 2026-09-02 → 2026-09-03, all 3,000 …");
  });

  it("bounds a non-uniform elided stretch and calls an all-empty one empty", () => {
    // 20 day-buckets: a rising middle the sample elides, a kept spike, then a
    // run of NULL gaps. The reader must be able to tell those two hidden
    // stretches apart — and date them — without re-querying the window.
    const day = (i: number) =>
      new Date(Date.UTC(2026, 6, 1) + i * 86_400_000).toISOString().slice(0, 19);
    const values: Array<number | null> = Array.from({ length: 20 }, (_, i) => {
      if (i >= 3 && i <= 8) return 8 + i; // rising, non-uniform
      if (i === 9) return 999; // kept as an outlier, splitting the two runs
      if (i >= 10 && i <= 14) return null; // a gap, not a zero
      return 10;
    });
    const rows = values.map((v, i) => [day(i), v]);
    const out = formatRows(["bucket", "value"], rows, { granularity: "1d" });

    expect(out).toContain(
      "… 4 more buckets 2026-07-04T00:00:00 → 2026-07-07T00:00:00, min 11 | max 14 …",
    );
    expect(out).toContain(
      "… 5 more buckets 2026-07-11T00:00:00 → 2026-07-15T00:00:00, all empty …",
    );
    // No elision is left as a bare count.
    expect(out).not.toMatch(/… \d+ more buckets …/);
  });

  it("treats NULL gap buckets as gaps, never as zero", () => {
    // Averages and percentiles come back with real NULLs for empty buckets;
    // a filled 0 would be a false collapse.
    const rows = [
      ["2026-09-01T00:00:00", null],
      ["2026-09-02T00:00:00", 1.8],
      ["2026-09-03T00:00:00", null],
    ];
    const out = formatRows(["bucket", "p95"], rows, { granularity: "day" });
    expect(out).toContain(
      "min 1.8 | max 1.8 (2026-09-02T00:00:00) | latest bucket empty (last value 1.8)",
    );
    expect(out).not.toMatch(/min 0|latest 0/);
    expect(out).toContain("  2026-09-01T00:00:00  —");
  });

  it("summarizes a breakdown over time as one line per series, ignoring the filled rows", () => {
    // [bucket, model_name, value] with the engine's '' fill rows.
    const rows = [
      ["2026-09-01T00:00:00", "gpt-5", 12.5],
      ["2026-09-01T00:00:00", "other", 3],
      ["2026-09-02T00:00:00", "", 0],
      ["2026-09-03T00:00:00", "gpt-5", 20],
      ["2026-09-03T00:00:00", "other", 1],
    ];
    const out = formatRows(["bucket", "model_name", "value"], rows, { granularity: "day" });
    const lines = out.split("\n");
    expect(lines[0]).toBe(
      "3 buckets × 2 series (bucket, model_name, value) | granularity day, 2026-09-01T00:00:00 → 2026-09-03T00:00:00",
    );
    expect(lines[1]).toBe("  gpt-5: min 12.5 | max 20 (2026-09-03T00:00:00) | latest 20");
    expect(lines[2]).toBe("  other: min 1 | max 3 (2026-09-01T00:00:00) | latest 1");
    expect(out).not.toContain("min 0");
    expect(lines).toHaveLength(3);
  });

  it("keys a breakdown series by bucket, so a series absent from the last bucket reads as empty there", () => {
    const rows = [
      ["2026-09-01T00:00:00", "gpt-5", 12.5],
      ["2026-09-01T00:00:00", "haiku", 3],
      ["2026-09-02T00:00:00", "gpt-5", 20],
      ["2026-09-02T00:00:00", "haiku", 1],
      ["2026-09-03T00:00:00", "gpt-5", 8],
    ];
    const out = formatRows(["bucket", "model_name", "value"], rows, { granularity: "day" });
    expect(out).toContain("gpt-5: min 8 | max 20 (2026-09-02T00:00:00) | latest 8");
    expect(out).toContain(
      "haiku: min 1 | max 3 (2026-09-01T00:00:00) | latest bucket empty (last value 1)",
    );
  });

  it("marks a server-capped series as partial and never names a latest value for it", () => {
    const rows = Array.from({ length: 25 }, (_, i) => [
      `2026-08-${String(1 + i).padStart(2, "0")}T00:00:00`,
      i,
    ]);
    const out = formatRows(["bucket", "count"], rows, { granularity: "day" }, { truncated: true });
    expect(out).toMatch(/partial/);
    expect(out).not.toMatch(/latest/);
    expect(out).toContain("min 0 | max 24");
  });

  it("lists the buckets that carry values when a series is sparse, instead of a blind head and tail", () => {
    // 90 days with one spike: the head and tail are all zero, and a reader
    // (or a model) needs the spike's date, not eight zeros.
    const rows = Array.from({ length: 91 }, (_, i) => {
      const day = new Date(Date.UTC(2026, 5, 10 + i)).toISOString().slice(0, 10);
      return [`${day}T00:00:00`, day === "2026-08-31" ? 219292 : 0];
    });
    const out = formatRows(["bucket", "value"], rows, { granularity: "day" });
    expect(out).toContain("min 0 | max 219,292 (2026-08-31T00:00:00) | latest 0");
    expect(out).toContain("  2026-08-31T00:00:00  219,292");
    expect(out).toContain("… 90 buckets at 0 not shown");
    expect(out).not.toContain("  2026-06-10T00:00:00  0");
  });

  it("shows every bucket of a short series, zeros included, and tells empty from zero when sparse", () => {
    // Seven days with two quiet days: room for all seven, so nothing is hidden.
    const week = Array.from({ length: 7 }, (_, i) => [
      `2026-09-0${i + 1}T00:00:00`,
      i % 3 === 0 ? 0 : 5,
    ]);
    const short = formatRows(["bucket", "value"], week, { granularity: "day" });
    expect(short).toContain("  2026-09-01T00:00:00  0");
    expect(short).not.toContain("not shown");

    // A long p95 series: the 0 days are measurements, the null days are gaps.
    const long = Array.from({ length: 30 }, (_, i) => [
      `2026-08-${String(i + 1).padStart(2, "0")}T00:00:00`,
      i === 10 ? 1.8 : i < 5 ? null : 0,
    ]);
    const out = formatRows(["bucket", "p95"], long, { granularity: "day" });
    expect(out).toContain("  2026-08-11T00:00:00  1.8");
    expect(out).toContain("… 24 buckets at 0 and 5 empty not shown");
  });

  it("marks the last bucket partial when the window ends inside it", () => {
    // A daily series read at 16:00: today's bucket is still filling. The model
    // must not read a low last bucket as a drop.
    const rows = Array.from({ length: 9 }, (_, i) => [`2026-09-0${i + 1}T00:00:00`, 3000]);
    rows[8][1] = 900;
    const window = { start_time: "2026-09-01T00:00:00Z", end_time: "2026-09-09T16:00:00Z" };
    const out = formatRows(["bucket", "value"], rows, { granularity: "day" }, { window });
    expect(out).toContain("latest 900 (partial: bucket still in progress)");
    expect(out).toContain("  2026-09-09T00:00:00  900 (partial)");
    // Read exactly at the bucket boundary, nothing is partial.
    const closed = formatRows(
      ["bucket", "value"],
      rows,
      { granularity: "day" },
      {
        window: { start_time: "2026-09-01T00:00:00Z", end_time: "2026-09-10T00:00:00Z" },
      },
    );
    expect(closed).not.toContain("partial");
  });

  it("labels a number tile as the whole window's value", () => {
    const out = formatRows(["total_tokens"], [[18000]], undefined, {
      window: { start_time: "2026-09-02T17:00:00Z", end_time: "2026-09-09T17:00:00Z" },
    });
    expect(out).toBe("total_tokens (whole window): 18,000");
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
    expect(out).toContain("min 1.2 | max 1.8 (2026-09-02T00:00:00) | latest 1.8");
    expect(out).toContain(
      "#2 Recent errors | trace_feed | skipped\n  feed — not summarized; read it with list_traces",
    );
    expect(out).toContain(
      "#3 Cost by model | query | error\n  error: breakdown: field is not groupable",
    );
    expect(out).toContain(
      "#4 Errors | query | ok\nvalue (whole window): 412\n  (rows capped by the server — run",
    );
    // The counts lead, so they survive any cut at the tail.
    expect(lines[2]).toBe("2 widgets queried, 1 feeds skipped, 1 failed");
  });

  it("renders a capped series widget as partial rather than a complete trend", () => {
    const capped = {
      ...data,
      widgets: [
        {
          id: "w1",
          title: "p95 latency",
          type: "query",
          status: "ok",
          columns: ["bucket", "p95"],
          rows: Array.from({ length: 25 }, (_, i) => [
            `2026-08-${String(1 + i).padStart(2, "0")}T00:00:00`,
            1 + i,
          ]),
          meta: { granularity: "1d" },
          truncated: true,
        },
      ],
    };
    const out = formatDashboardData(capped);
    expect(out).toMatch(/partial/);
    expect(out).not.toMatch(/latest/);
  });

  it("tells the model how to get the rest of a capped widget", () => {
    const out = formatDashboardData(data);
    expect(out).toContain(
      "(rows capped by the server — run this widget's spec with run_widget_query for every row)",
    );
  });

  it("puts the dashboard's URL in the header when the caller can build one", () => {
    const out = formatDashboardData(data, {
      dashboardUrl: (id) => `http://ui.test/projects/p1/dashboard/${id}`,
    });
    expect(out.split("\n")[1]).toBe("URL: http://ui.test/projects/p1/dashboard/d1");
  });

  it("keeps every widget's identity when the read is over budget, dropping rows first", () => {
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
    // The counts survive at the top, every widget keeps its title line, the
    // early widgets keep their rows and the late ones say how to get theirs.
    expect(out.split("\n").slice(0, 4).join("\n")).toContain("40 widgets queried");
    for (let i = 0; i < 40; i += 1) expect(out).toContain(`#${i + 1} Widget ${i} | query | ok`);
    expect(out).toContain("#1 Widget 0 | query | ok\n25 rows (k, v)");
    expect(out).toContain("rows not included: the dashboard read is over its text budget");
    expect(out).not.toContain("output truncated at");
  });

  it("cuts with a visible marker only when even the widget list does not fit", () => {
    const widgets = Array.from({ length: 900 }, (_, i) => ({
      id: `w${i}`,
      title: `Widget ${i} ${"y".repeat(40)}`,
      type: "query",
      status: "error",
      error: "spec: broken",
    }));
    const out = formatDashboardData({ ...data, widgets, queried: 0, skipped: 0, failed: 900 });
    expect(Buffer.byteLength(out, "utf-8")).toBeLessThan(16 * 1024 + 256);
    expect(out).toContain("output truncated at 16384 bytes");
  });
});
