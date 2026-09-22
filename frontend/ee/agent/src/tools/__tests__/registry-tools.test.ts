import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Executor } from "../../executors/interface.js";
import {
  formatAlertDetail,
  formatAlertList,
  formatDashboardDetail,
  formatDashboardList,
  formatDetectorDetail,
  formatDetectorList,
  formatFindingDetail,
  formatFindingList,
  formatSessionDetail,
  formatSessionList,
  formatTraceList,
} from "../formatters.js";
import { createTools } from "../index.js";
import { createRegistryReadTools } from "../registry-tools.js";

describe("createRegistryReadTools", () => {
  beforeEach(() => {
    process.env.BACKEND_INTERNAL_URL = "http://fastapi.test";
    process.env.INTERNAL_API_SECRET = "s3cret";
  });
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(body: unknown) {
    const impl = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal("fetch", impl);
    return impl;
  }

  it("exposes exactly the internally-bound read tools", () => {
    const names = createRegistryReadTools("p1", "u1").map((t) => t.name);
    expect(names).toEqual([
      "list_traces",
      "list_sessions",
      "get_session",
      "list_detectors",
      "get_detector",
      "list_findings",
      "get_finding",
      "get_finding_by_trace",
      "list_dashboards",
      "get_dashboard",
      "run_widget_query",
      "get_dashboard_data",
      "get_widget",
      "get_widget_data",
      "list_alerts",
      "get_alert",
      "get_evaluation_run",
      "list_datasets",
      "get_dataset",
      "list_dataset_versions",
      "get_dataset_version",
    ]);
  });

  it("get_widget GETs the internal widget route and renders the definition", async () => {
    const impl = stubFetch({
      id: "w1",
      dashboard_id: "d1",
      dashboard_name: "Latency",
      title: "p95",
      type: "query",
      spec: { view: "spans" },
      display_config: {},
      create_time: "2026-08-01T00:00:00Z",
      update_time: "2026-08-02T00:00:00Z",
    });
    const tool = createRegistryReadTools("p1", "u1").find((t) => t.name === "get_widget")!;
    const result = await tool.execute("id", { label: "x", widget_id: "w1" });
    const [url, init] = impl.mock.calls[0]!;
    expect(String(url)).toBe("http://fastapi.test/api/v1/internal/projects/p1/widgets/w1");
    expect((init as RequestInit).method ?? "GET").toBe("GET");
    expect((result.content[0] as { text: string }).text).toContain(
      "Widget: w1 | p95 | type: query\nDashboard: d1 | Latency",
    );
  });

  it("get_widget_data GETs the internal data route with the window as query params", async () => {
    const impl = stubFetch({ widget: {}, window: {}, status: "ok", columns: [], rows: [] });
    const tool = createRegistryReadTools("p1", "u1").find((t) => t.name === "get_widget_data")!;
    await tool.execute("id", { label: "x", widget_id: "w1", range: "7d" });
    expect(String(impl.mock.calls[0]![0])).toBe(
      "http://fastapi.test/api/v1/internal/projects/p1/widgets/w1/data?range=7d",
    );
  });

  it("get_widget_data defaults to the page's window, and a window the model names wins", async () => {
    const impl = stubFetch({ widget: {}, window: {}, status: "ok", columns: [], rows: [] });
    const tool = createRegistryReadTools("p1", "u1", { range: "30d" }).find(
      (t) => t.name === "get_widget_data",
    )!;
    await tool.execute("id", { label: "x", widget_id: "w1" });
    expect(String(impl.mock.calls[0]![0])).toBe(
      "http://fastapi.test/api/v1/internal/projects/p1/widgets/w1/data?range=30d",
    );
    await tool.execute("id", { label: "x", widget_id: "w1", range: "1h" });
    expect(String(impl.mock.calls[1]![0])).toBe(
      "http://fastapi.test/api/v1/internal/projects/p1/widgets/w1/data?range=1h",
    );
    expect(tool.description).toContain("the window the user is looking at on the page (30d)");
    expect(tool.description).not.toContain("site's default");
  });

  it("puts the widget's dashboard URL in a widget data read, on the browser-reachable origin", async () => {
    const before = { ...process.env };
    process.env.TRACEROOT_UI_URL = "http://web:3000";
    process.env.TRACEROOT_PUBLIC_UI_URL = "https://app.test";
    try {
      stubFetch({
        widget: { id: "w1", dashboard_id: "d1", title: "p95", type: "query" },
        window: {},
        status: "ok",
        columns: ["value"],
        rows: [[1]],
      });
      const tool = createRegistryReadTools("p1", "u1").find((t) => t.name === "get_widget_data")!;
      const result = await tool.execute("id", { label: "x", widget_id: "w1" });
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("URL: https://app.test/projects/p1/dashboard/d1");
      expect(text).not.toContain("web:3000");
    } finally {
      process.env.TRACEROOT_UI_URL = before.TRACEROOT_UI_URL;
      process.env.TRACEROOT_PUBLIC_UI_URL = before.TRACEROOT_PUBLIC_UI_URL;
      if (before.TRACEROOT_UI_URL === undefined) delete process.env.TRACEROOT_UI_URL;
      if (before.TRACEROOT_PUBLIC_UI_URL === undefined) delete process.env.TRACEROOT_PUBLIC_UI_URL;
    }
  });

  it("run_widget_query POSTs the spec and window to the internal query route", async () => {
    const impl = stubFetch({ columns: [], rows: [], meta: {}, window: {} });
    const tool = createRegistryReadTools("p1", "u1").find((t) => t.name === "run_widget_query")!;
    await tool.execute("id", { label: "x", spec: { view: "spans" }, range: "7d" });
    const [url, init] = impl.mock.calls[0]!;
    expect(String(url)).toBe("http://fastapi.test/api/v1/projects/p1/widgets/query");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      spec: { view: "spans" },
      range: "7d",
    });
    expect((init as RequestInit).headers).toMatchObject({
      "X-Internal-Secret": "s3cret",
      "x-user-id": "u1",
    });
  });

  it("get_dashboard_data GETs the internal data route with the window as query params", async () => {
    const impl = stubFetch({ dashboard: {}, window: {}, widgets: [] });
    const tool = createRegistryReadTools("p1", "u1").find((t) => t.name === "get_dashboard_data")!;
    await tool.execute("id", { label: "x", dashboard_id: "d1", range: "7d" });
    const [url] = impl.mock.calls[0]!;
    expect(String(url)).toBe(
      "http://fastapi.test/api/v1/internal/projects/p1/dashboards/d1/data?range=7d",
    );
  });

  it("puts the dashboard's page URL in a dashboard read, on the browser-reachable origin", async () => {
    // In a compose deployment the service reaches the web app as http://web:3000,
    // which a browser cannot; the link must use the public origin instead.
    const before = { ...process.env };
    process.env.TRACEROOT_UI_URL = "http://web:3000";
    process.env.TRACEROOT_PUBLIC_UI_URL = "https://app.test";
    try {
      stubFetch({ dashboard: { id: "d1", name: "Latency" }, window: {}, widgets: [] });
      const tool = createRegistryReadTools("p1", "u1").find(
        (t) => t.name === "get_dashboard_data",
      )!;
      const result = await tool.execute("id", { label: "x", dashboard_id: "d1" });
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("URL: https://app.test/projects/p1/dashboard/d1");
      expect(text).not.toContain("web:3000");
    } finally {
      process.env.TRACEROOT_UI_URL = before.TRACEROOT_UI_URL;
      process.env.TRACEROOT_PUBLIC_UI_URL = before.TRACEROOT_PUBLIC_UI_URL;
      if (before.TRACEROOT_UI_URL === undefined) delete process.env.TRACEROOT_UI_URL;
      if (before.TRACEROOT_PUBLIC_UI_URL === undefined) delete process.env.TRACEROOT_PUBLIC_UI_URL;
    }
  });

  it("defaults both data reads to the page's window when the model names none", async () => {
    const impl = stubFetch({ dashboard: {}, window: {}, widgets: [] });
    const tools = createRegistryReadTools("p1", "u1", { range: "30d" });
    await tools
      .find((t) => t.name === "get_dashboard_data")!
      .execute("id", { label: "x", dashboard_id: "d1" });
    expect(String(impl.mock.calls[0]![0])).toBe(
      "http://fastapi.test/api/v1/internal/projects/p1/dashboards/d1/data?range=30d",
    );
    await tools
      .find((t) => t.name === "run_widget_query")!
      .execute("id", { label: "x", spec: { view: "spans" } });
    expect(JSON.parse((impl.mock.calls[1]![1] as RequestInit).body as string)).toEqual({
      spec: { view: "spans" },
      range: "30d",
    });
  });

  it("a window the model names wins over the page's, even when the page's is custom bounds", async () => {
    const impl = stubFetch({ dashboard: {}, window: {}, widgets: [] });
    const tools = createRegistryReadTools("p1", "u1", {
      start_time: "2026-09-01T00:00:00Z",
      end_time: "2026-09-02T00:00:00Z",
    });
    await tools
      .find((t) => t.name === "get_dashboard_data")!
      .execute("id", { label: "x", dashboard_id: "d1", range: "1h" });
    // Only the model's range: merging the page's bounds under it would be a request the server rejects.
    expect(String(impl.mock.calls[0]![0])).toBe(
      "http://fastapi.test/api/v1/internal/projects/p1/dashboards/d1/data?range=1h",
    );
  });

  it("tells the model an omitted window means the page's, not the site default", () => {
    for (const name of ["run_widget_query", "get_dashboard_data"]) {
      const tool = createRegistryReadTools("p1", "u1").find((t) => t.name === name)!;
      expect(tool.description).toContain("the window the user is looking at on the page");
      expect(tool.description).not.toContain("site's default");
    }
  });

  it("names the page's actual range in that text, so the default is not invisible", () => {
    for (const name of ["run_widget_query", "get_dashboard_data"]) {
      const preset = createRegistryReadTools("p1", "u1", { range: "14d" }).find(
        (t) => t.name === name,
      )!;
      expect(preset.description).toContain("looking at on the page (14d)");
      expect(
        (preset.parameters.properties.range as { description?: string }).description,
      ).toContain("looking at on the page (14d)");

      const custom = createRegistryReadTools("p1", "u1", {
        start_time: "2026-08-25T00:00:00Z",
        end_time: "2026-09-08T00:00:00Z",
      }).find((t) => t.name === name)!;
      expect(custom.description).toContain(
        "on the page (2026-08-25T00:00:00Z → 2026-09-08T00:00:00Z)",
      );

      // No page window: the phrase stands alone, with no empty parentheses.
      const none = createRegistryReadTools("p1", "u1").find((t) => t.name === name)!;
      expect(none.description).toContain("looking at on the page");
      expect(none.description).not.toContain("page (");
    }
  });

  it("says the same on the range parameter itself, so the schema cannot contradict the description", () => {
    for (const name of ["run_widget_query", "get_dashboard_data"]) {
      const tool = createRegistryReadTools("p1", "u1").find((t) => t.name === name)!;
      const range = tool.parameters.properties.range as { description?: string };
      expect(range.description).toContain("the window the user is looking at");
      expect(range.description ?? "").not.toMatch(/site.s default/);
    }
  });

  it("sends no window at all when the page gave none and the model named none", async () => {
    const impl = stubFetch({ dashboard: {}, window: {}, widgets: [] });
    const tool = createRegistryReadTools("p1", "u1").find((t) => t.name === "get_dashboard_data")!;
    await tool.execute("id", { label: "x", dashboard_id: "d1" });
    expect(String(impl.mock.calls[0]![0])).toBe(
      "http://fastapi.test/api/v1/internal/projects/p1/dashboards/d1/data",
    );
  });

  it("hides the fixed project_id from every tool's model-facing schema", () => {
    for (const tool of createRegistryReadTools("p1", "u1")) {
      expect(tool.parameters.properties).not.toHaveProperty("project_id");
      expect(tool.parameters.properties).toHaveProperty("label");
    }
  });

  it("list_traces hits the internal project route with internal auth headers", async () => {
    const impl = stubFetch({ data: [], meta: {} });
    const tool = createRegistryReadTools("p1", "u1").find((t) => t.name === "list_traces")!;
    await tool.execute("id", { label: "x", search_query: "checkout" });
    const [url, init] = impl.mock.calls[0]!;
    expect(String(url)).toBe("http://fastapi.test/api/v1/projects/p1/traces?search_query=checkout");
    expect((init as RequestInit).headers).toMatchObject({
      "X-Internal-Secret": "s3cret",
      "x-user-id": "u1",
    });
  });

  it("get_session hits the internal session route with the model-supplied id", async () => {
    const impl = stubFetch({ session_id: "s1", trace_count: 0, traces: [] });
    const tool = createRegistryReadTools("p1", "u1").find((t) => t.name === "get_session")!;
    await tool.execute("id", { label: "x", session_id: "s1" });
    const [url] = impl.mock.calls[0]!;
    expect(String(url)).toBe("http://fastapi.test/api/v1/projects/p1/sessions/s1");
  });

  it("formats trace lists as the summary table text", async () => {
    stubFetch({
      data: [
        {
          trace_id: "t1",
          name: "checkout",
          trace_start_time: "2026-07-01T00:00:00Z",
          error_count: 2,
          span_count: 7,
          duration_ms: 123.4,
        },
      ],
      meta: { total: 41 },
    });
    const tool = createRegistryReadTools("p1", "u1").find((t) => t.name === "list_traces")!;
    const result = await tool.execute("id", { label: "x" });
    expect(result.content[0]!.text).toBe(
      "Found 1 traces (41 total, showing 1):\n" +
        "- t1 | checkout | 2026-07-01T00:00:00Z | 2 errors | 7 spans | 123ms",
    );
  });

  it("formats session lists as the per-session summary lines", async () => {
    stubFetch({
      data: [{ session_id: "s1", trace_count: 3, duration_ms: 4500.6, user_ids: ["u1", "u2"] }],
    });
    const tool = createRegistryReadTools("p1", "u1").find((t) => t.name === "list_sessions")!;
    const result = await tool.execute("id", { label: "x" });
    expect(result.content[0]!.text).toBe(
      "Found 1 sessions:\n- s1 | 3 traces | 4501ms | users: u1, u2",
    );
  });

  it("get_session formats the session detail with per-trace I/O", async () => {
    stubFetch({
      session_id: "s1",
      trace_count: 1,
      duration_ms: 5000,
      user_ids: ["u1"],
      traces: [
        {
          trace_id: "t1",
          name: "turn",
          status: "ok",
          duration_ms: 100,
          input: "hi",
          output: "yo",
        },
      ],
    });
    const tool = createRegistryReadTools("p1", "u1").find((t) => t.name === "get_session")!;
    const result = await tool.execute("id", { label: "x", session_id: "s1" });
    expect(result.content[0]!.text).toBe(
      "Session: s1\n" +
        "Traces: 1 | Duration: 5000ms | Users: u1\n" +
        "\n" +
        "#1 t1 — turn | ok | 100ms\n" +
        "   Input:  hi\n" +
        "   Output: yo",
    );
  });

  it("list_findings hits the internal detectors route with query filters", async () => {
    const impl = stubFetch({ data: [], meta: {} });
    const tool = createRegistryReadTools("p1", "u1").find((t) => t.name === "list_findings")!;
    await tool.execute("id", { label: "x", detector: "error-rate", trace_id: "t1" });
    const [url, init] = impl.mock.calls[0]!;
    expect(String(url)).toBe(
      "http://fastapi.test/api/v1/projects/p1/detectors/findings?detector=error-rate&trace_id=t1",
    );
    expect((init as RequestInit).headers).toMatchObject({
      "X-Internal-Secret": "s3cret",
      "x-user-id": "u1",
    });
  });

  it("get_finding_by_trace hits the internal trace-finding route", async () => {
    const impl = stubFetch({
      finding_id: "f1",
      trace_id: "t1",
      timestamp: "2026-08-11T09:00:00Z",
      detectors: [],
      summary: "s",
      results: [],
      rca: null,
    });
    const tool = createRegistryReadTools("p1", "u1").find(
      (t) => t.name === "get_finding_by_trace",
    )!;
    await tool.execute("id", { label: "x", trace_id: "t1" });
    const [url] = impl.mock.calls[0]!;
    expect(String(url)).toBe("http://fastapi.test/api/v1/projects/p1/detectors/traces/t1/finding");
  });

  it("get_finding hits the internal finding route and formats the detail with RCA", async () => {
    const impl = stubFetch({
      finding_id: "f1",
      trace_id: "t1",
      timestamp: "2026-08-11T09:00:00Z",
      detectors: ["Error spike"],
      summary: "Elevated error rate",
      results: [],
      rca: { status: "completed", result: "Root cause: bad deploy" },
    });
    const tool = createRegistryReadTools("p1", "u1").find((t) => t.name === "get_finding")!;
    const result = await tool.execute("id", { label: "x", finding_id: "f1" });
    const [url] = impl.mock.calls[0]!;
    expect(String(url)).toBe("http://fastapi.test/api/v1/projects/p1/detectors/findings/f1");
    expect(result.content[0]!.text).toContain("Finding: f1");
    expect(result.content[0]!.text).toContain("RCA (completed):");
    expect(result.content[0]!.text).toContain("Root cause: bad deploy");
  });

  it("list_detectors hits the internal detectors route and runs the catalog formatter", async () => {
    const impl = stubFetch({
      data: [{ detector_id: "det-1", name: "Error spike", template: "error-rate", enabled: true }],
      meta: { total: 1 },
    });
    const tool = createRegistryReadTools("p1", "u1").find((t) => t.name === "list_detectors")!;
    const result = await tool.execute("id", { label: "x" });
    const [url] = impl.mock.calls[0]!;
    expect(String(url)).toBe("http://fastapi.test/api/v1/projects/p1/detectors");
    // Exact rendering is owned by the formatter tests; this proves dispatch + formatter wiring.
    expect(result.content[0]!.text).toContain("Found 1 detectors");
    expect(result.content[0]!.text).toContain("det-1");
  });

  it("get_detector hits the internal detector route and renders the config", async () => {
    const impl = stubFetch({
      detector_id: "det-1",
      name: "Error spike",
      template: "failure",
      enabled: true,
      created_at: "2026-08-01T12:00:00Z",
      prompt: "Flag traces with elevated error rates",
      output_schema: { type: "object" },
      sample_rate: 25,
      enable_rca: true,
      detection_model: "claude-haiku-4-5",
      detection_source: "system",
      updated_at: "2026-08-02T09:00:00Z",
      trigger_conditions: [{ field: "root_span_finished", op: "=", value: true }],
    });
    const tool = createRegistryReadTools("p1", "u1").find((t) => t.name === "get_detector")!;
    const result = await tool.execute("id", { label: "x", detector_id: "det-1" });
    const [url] = impl.mock.calls[0]!;
    expect(String(url)).toBe("http://fastapi.test/api/v1/projects/p1/detectors/det-1");
    expect(result.content[0]!.text).toContain("Detector: det-1");
    expect(result.content[0]!.text).toContain("Flag traces with elevated error rates");
  });

  it("list_dashboards hits the internal dashboards route and runs the catalog formatter", async () => {
    const impl = stubFetch({
      data: [
        {
          id: "dash-1",
          name: "Overview",
          description: "Main overview.",
          is_default: true,
          creator: "Ada Lovelace",
          create_time: "2026-08-01T00:00:00Z",
          update_time: "2026-08-02T00:00:00Z",
          widget_count: 4,
        },
      ],
    });
    const tool = createRegistryReadTools("p1", "u1").find((t) => t.name === "list_dashboards")!;
    const result = await tool.execute("id", { label: "x" });
    const [url, init] = impl.mock.calls[0]!;
    expect(String(url)).toBe("http://fastapi.test/api/v1/internal/projects/p1/dashboards");
    expect((init as RequestInit).headers).toMatchObject({
      "X-Internal-Secret": "s3cret",
      "x-user-id": "u1",
    });
    // Exact rendering is owned by the formatter tests; this proves dispatch + formatter wiring.
    expect(result.content[0]!.text).toContain("Found 1 dashboards");
    expect(result.content[0]!.text).toContain("dash-1");
  });

  it("get_dashboard hits the internal dashboard route and renders the widgets", async () => {
    const impl = stubFetch({
      id: "dash-1",
      name: "Overview",
      description: "Main overview.",
      is_default: true,
      creator: "Ada Lovelace",
      create_time: "2026-08-01T00:00:00Z",
      update_time: "2026-08-02T00:00:00Z",
      widgets: [
        {
          id: "w-1",
          title: "Cost over time",
          type: "query",
          spec: { view: "spans" },
          create_time: "2026-08-01T00:00:00Z",
        },
      ],
    });
    const tool = createRegistryReadTools("p1", "u1").find((t) => t.name === "get_dashboard")!;
    const result = await tool.execute("id", { label: "x", dashboard_id: "dash-1" });
    const [url] = impl.mock.calls[0]!;
    expect(String(url)).toBe("http://fastapi.test/api/v1/internal/projects/p1/dashboards/dash-1");
    expect(result.content[0]!.text).toContain("Dashboard: dash-1");
    expect(result.content[0]!.text).toContain("Cost over time");
  });

  it("list_alerts hits the internal alerts route with paging and runs the formatter", async () => {
    const impl = stubFetch({
      data: [
        {
          id: "alr-1",
          name: "p95 latency",
          measure: "latency",
          aggregation: "p95",
          window: "10m",
          threshold_operator: ">",
          threshold: 2000,
          status: "ACTIVE",
          severity: "OK",
          creator: "Ada Lovelace",
        },
      ],
      meta: { page: 0, limit: 50, total: 1, capacity: { used: 1, max: 100 } },
    });
    const tool = createRegistryReadTools("p1", "u1").find((t) => t.name === "list_alerts")!;
    const result = await tool.execute("id", { label: "x", search_query: "latency", limit: 5 });
    const [url, init] = impl.mock.calls[0]!;
    expect(String(url)).toBe(
      "http://fastapi.test/api/v1/internal/projects/p1/alerts?limit=5&search_query=latency",
    );
    expect((init as RequestInit).headers).toMatchObject({
      "X-Internal-Secret": "s3cret",
      "x-user-id": "u1",
    });
    // Exact rendering is owned by the formatter tests; this proves dispatch + formatter wiring.
    expect(result.content[0]!.text).toContain("Found 1 alerts");
    expect(result.content[0]!.text).toContain("alr-1");
    // The panel's list card reads the compact projection, not the prose.
    expect(result.details).toMatchObject({
      kind: "alert_list",
      total: 1,
      capacity: { used: 1, max: 100 },
      alerts: [{ id: "alr-1", name: "p95 latency", measure: "latency", threshold: 2000 }],
    });
  });

  it("get_alert hits the internal alert route and renders the rule", async () => {
    const impl = stubFetch({
      id: "alr-1",
      name: "p95 latency",
      view: "SPANS",
      measure: "latency",
      aggregation: "p95",
      filters: [],
      window: "10m",
      threshold_operator: ">",
      threshold: 2000,
      renotify: { mode: "OFF" },
      no_data_mode: "HOLD",
      status: "ACTIVE",
      severity: "OK",
      creator: "Ada Lovelace",
    });
    const tool = createRegistryReadTools("p1", "u1").find((t) => t.name === "get_alert")!;
    const result = await tool.execute("id", { label: "x", alert_id: "alr-1" });
    const [url] = impl.mock.calls[0]!;
    expect(String(url)).toBe("http://fastapi.test/api/v1/internal/projects/p1/alerts/alr-1");
    expect(result.content[0]!.text).toContain("Alert: alr-1");
    expect(result.content[0]!.text).toContain("p95(latency) over 10m > 2000");
    expect(result.details).toMatchObject({
      kind: "alert_detail",
      alert: { id: "alr-1", name: "p95 latency", renotify: { mode: "OFF" }, no_data_mode: "HOLD" },
    });
  });

  it("carries no details on the reads that have no card", async () => {
    stubFetch({ data: [], meta: { page: 0, limit: 50, total: 0 } });
    const tool = createRegistryReadTools("p1", "u1").find((t) => t.name === "list_detectors")!;
    const result = await tool.execute("id", { label: "x" });
    expect(result.details).toBeUndefined();
  });

  it("get_evaluation_run hits the internal run route and runs the formatter", async () => {
    const impl = stubFetch({
      evaluation_run_id: "run_1",
      evaluation_name: "Billing routing",
      run_number: 14,
      status: "completed",
      scores: [],
      metrics: [],
    });
    const tool = createRegistryReadTools("p1", "u1").find((t) => t.name === "get_evaluation_run")!;
    const result = await tool.execute("id", { label: "x", run_id: "run_1" });
    const [url, init] = impl.mock.calls[0]!;
    expect(String(url)).toBe(
      "http://fastapi.test/api/v1/internal/projects/p1/evaluation-runs/run_1",
    );
    expect((init as RequestInit).headers).toMatchObject({
      "X-Internal-Secret": "s3cret",
      "x-user-id": "u1",
    });
    expect(result.content[0]!.text.startsWith("Standing: complete")).toBe(true);
    expect(result.content[0]!.text).toContain("run #14");
  });

  it("get_evaluation_run offers the model no baseline to pass", () => {
    const tool = createRegistryReadTools("p1", "u1").find((t) => t.name === "get_evaluation_run")!;
    const properties = (tool.parameters as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(properties).sort()).toEqual(["label", "run_id"]);
  });

  it.each([
    [
      "list_datasets",
      { name: "refunds" },
      { datasets: [{ dataset_id: "ds_1", name: "Refunds", current_dataset_version_id: "dv_3" }] },
      "http://fastapi.test/api/v1/internal/projects/p1/datasets?limit=200&name=refunds",
      '- "ds_1" | "Refunds" | current version: "dv_3"',
    ],
    [
      "get_dataset",
      { dataset_id: "ds_1" },
      { dataset_id: "ds_1", name: "Refunds", current_dataset_version_id: "dv_3" },
      "http://fastapi.test/api/v1/internal/projects/p1/datasets/ds_1",
      'Dataset: "ds_1" | "Refunds"',
    ],
    [
      "list_dataset_versions",
      { dataset_id: "ds_1" },
      { versions: [{ dataset_version_id: "dv_3", version_number: 3, is_current: true }] },
      "http://fastapi.test/api/v1/internal/projects/p1/datasets/ds_1/versions?limit=200",
      '- "dv_3" | v3 (current)',
    ],
    [
      "get_dataset_version",
      { version_id: "dv_1" },
      { dataset_version_id: "dv_1", dataset_id: "ds_1", version_number: 1, items: [] },
      "http://fastapi.test/api/v1/internal/projects/p1/dataset-versions/dv_1?limit=20",
      'Dataset version: "dv_1" | dataset "ds_1"',
    ],
  ])(
    "%s hits its internal dataset route and renders its own result",
    async (name, args, body, url, text) => {
      const impl = stubFetch(body);
      const tool = createRegistryReadTools("p1", "u1").find((t) => t.name === name)!;
      const result = await tool.execute("id", { label: "x", ...args });
      const [called, init] = impl.mock.calls[0]!;
      expect(String(called)).toBe(url);
      expect((init as RequestInit).headers).toMatchObject({
        "X-Internal-Secret": "s3cret",
        "x-user-id": "u1",
      });
      expect(result.content[0]!.text).toContain(text);
    },
  );

  it.each([
    ["list_datasets", "http://fastapi.test/api/v1/internal/projects/p1/datasets?limit=200"],
    [
      "list_dataset_versions",
      "http://fastapi.test/api/v1/internal/projects/p1/datasets/ds_1/versions?limit=200",
    ],
    [
      "get_dataset_version",
      "http://fastapi.test/api/v1/internal/projects/p1/dataset-versions/dv_1?limit=20",
    ],
  ])("%s pins its page, whatever the model sends", async (name, url) => {
    const impl = stubFetch({});
    const tool = createRegistryReadTools("p1", "u1").find((t) => t.name === name)!;
    await tool.execute("id", {
      label: "x",
      dataset_id: "ds_1",
      version_id: "dv_1",
      limit: 5,
      cursor: "guessed",
    });
    expect(String(impl.mock.calls[0]![0])).toBe(url);
  });

  it.each(["list_datasets", "list_dataset_versions", "get_dataset_version"])(
    "%s offers the model no cursor and no page size, so it reads the first page only",
    (name) => {
      const tool = createRegistryReadTools("p1", "u1").find((t) => t.name === name)!;
      const properties = (tool.parameters as { properties: Record<string, unknown> }).properties;
      expect(properties).not.toHaveProperty("cursor");
      expect(properties).not.toHaveProperty("limit");
    },
  );

  it("describes get_dataset_version by what it does, keeping the rest of the registry text", () => {
    const tool = createRegistryReadTools("p1", "u1").find((t) => t.name === "get_dataset_version")!;
    const properties = (tool.parameters as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(properties).sort()).toEqual(["label", "version_id"]);
    expect(tool.description).toContain("Read one immutable dataset version and its test cases");
    expect(tool.description).toContain("Returns the version's first 20 cases");
    // The registry's own paging advice names params this surface pins, so none of it survives.
    expect(tool.description).not.toMatch(/next_cursor|pass limit|whole version/);
  });

  it("returns HTTP failures as tool text instead of throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ detail: "Forbidden" }), { status: 403 })),
    );
    const tool = createRegistryReadTools("p1", "u1").find((t) => t.name === "list_traces")!;
    const result = await tool.execute("id", { label: "x" });
    expect(result.content[0]!.text).toContain("Error calling list_traces");
    expect(result.content[0]!.text).toContain("Forbidden");
  });
});

describe("createTools", () => {
  const READ_TOOL_NAMES = [
    "list_traces",
    "list_sessions",
    "get_session",
    "list_detectors",
    "get_detector",
    "list_findings",
    "get_finding",
    "get_finding_by_trace",
    "list_dashboards",
    "get_dashboard",
    "run_widget_query",
    "get_dashboard_data",
    "get_widget",
    "get_widget_data",
    "list_alerts",
    "get_alert",
    "get_evaluation_run",
    "list_datasets",
    "get_dataset",
    "list_dataset_versions",
    "get_dataset_version",
  ];
  const WRITE_TOOL_NAMES = [
    "create_detector",
    "create_dashboard",
    "create_widget",
    "create_alert",
    "update_detector",
    "update_dashboard",
    "update_widget",
    "update_alert",
    "set_alert_status",
    "delete_detector",
    "delete_dashboard",
    "delete_widget",
    "delete_alert",
  ];
  const OTHER_TOOL_NAMES = [
    "list_detector_models",
    "download_traces",
    "download_session",
    "check_github_access",
    "git_clone",
    "bash",
    "read",
    "write",
  ];

  it("wires read, write, download, github, and sandbox tools for a user session", () => {
    const tools = createTools({
      projectId: "p1",
      userId: "u1",
      workspaceId: "w1",
      agentSessionId: "s1",
      executor: {} as Executor,
    });
    expect(tools.map((t) => t.name)).toEqual([
      ...READ_TOOL_NAMES,
      ...WRITE_TOOL_NAMES,
      ...OTHER_TOOL_NAMES,
    ]);
  });

  it("omits the write tools when there is no acting user (system/RCA sessions)", () => {
    const tools = createTools({
      projectId: "p1",
      userId: "",
      workspaceId: "w1",
      agentSessionId: "s1",
      executor: {} as Executor,
    });
    expect(tools.map((t) => t.name)).toEqual([...READ_TOOL_NAMES, ...OTHER_TOOL_NAMES]);
  });

  it("omits the write tools when session provenance is missing", () => {
    const tools = createTools({
      projectId: "p1",
      userId: "u1",
      workspaceId: "w1",
      agentSessionId: "",
      executor: {} as Executor,
    });
    expect(tools.map((t) => t.name)).toEqual([...READ_TOOL_NAMES, ...OTHER_TOOL_NAMES]);
  });
});

describe("formatters", () => {
  it("formatTraceList reports the empty state and tolerates missing fields", () => {
    expect(formatTraceList({})).toBe("No traces found matching the given filters.");
    expect(formatTraceList({ data: [], meta: {} })).toBe(
      "No traces found matching the given filters.",
    );
    expect(formatTraceList({ data: [{ trace_id: "t1", span_count: 1 }], meta: {} })).toBe(
      "Found 1 traces:\n- t1 | (unnamed) | undefined | 0 errors | 1 spans | ?",
    );
  });

  it("formatSessionList reports the empty state and missing-field fallbacks", () => {
    expect(formatSessionList({})).toBe("No sessions found.");
    expect(formatSessionList({ data: [{ session_id: "s1", trace_count: 0 }] })).toBe(
      "Found 1 sessions:\n- s1 | 0 traces | ? | users: none",
    );
  });

  it("formatSessionDetail reports the traceless state and missing-field fallbacks", () => {
    expect(formatSessionDetail({ session_id: "s9", traces: [] })).toBe("Session s9 has no traces.");
    expect(
      formatSessionDetail({
        session_id: "s9",
        trace_count: 1,
        traces: [{ trace_id: "t1", status: "error" }],
      }),
    ).toBe(
      "Session: s9\n" +
        "Traces: 1 | Duration: unknown | Users: none\n" +
        "\n" +
        "#1 t1 — (unnamed) | error | ?\n" +
        "   Input:  (none)\n" +
        "   Output: (none)",
    );
  });

  it("formatSessionDetail truncates long trace input and output to 200 chars", () => {
    const long = "x".repeat(250);
    const text = formatSessionDetail({
      session_id: "s1",
      trace_count: 1,
      traces: [{ trace_id: "t1", status: "ok", input: long, output: long }],
    });
    expect(text).toContain(`Input:  ${"x".repeat(200)}\n`);
    expect(text).not.toContain("x".repeat(201));
  });

  it("formatSessionDetail does not split a surrogate pair at the truncation boundary", () => {
    // "😀" is one code point but two UTF-16 units; placing it across the
    // 200-unit boundary would leave a lone high surrogate under plain slice.
    const input = "x".repeat(199) + "😀" + "tail";
    const text = formatSessionDetail({
      session_id: "s1",
      trace_count: 1,
      traces: [{ trace_id: "t1", status: "ok", input, output: "y" }],
    });
    const line = text.split("\n").find((l) => l.startsWith("   Input:"))!;
    expect(line).toBe(`   Input:  ${"x".repeat(199)}`);
    expect(text).not.toContain("\ud83d");
  });

  it("formatDashboardList renders rows and reports the empty state", () => {
    expect(formatDashboardList({})).toBe("No dashboards found in this project.");
    expect(
      formatDashboardList({
        data: [
          {
            id: "dash-1",
            name: "Overview",
            description: "Main overview.",
            is_default: true,
            creator: "Ada Lovelace",
            widget_count: 4,
          },
          {
            id: "dash-2",
            name: "Latency",
            description: null,
            is_default: false,
            creator: null,
            widget_count: 0,
          },
        ],
      }),
    ).toBe(
      "Found 2 dashboards:\n" +
        "- dash-1 | Overview (default) | 4 widgets | by Ada Lovelace — Main overview.\n" +
        "- dash-2 | Latency | 0 widgets | by unknown",
    );
  });

  it("formatDashboardDetail renders the overview and per-widget spec lines", () => {
    expect(
      formatDashboardDetail({
        id: "dash-1",
        name: "Overview",
        description: "Main overview.",
        is_default: true,
        creator: "Ada Lovelace",
        create_time: "2026-08-01T00:00:00Z",
        update_time: "2026-08-02T00:00:00Z",
        widgets: [
          {
            id: "w-1",
            title: "Cost over time",
            type: "query",
            spec: { view: "spans" },
            create_time: "2026-08-01T00:00:00Z",
          },
        ],
      }),
    ).toBe(
      "Dashboard: dash-1 | Overview (default)\n" +
        "Created by Ada Lovelace | created 2026-08-01T00:00:00Z | updated 2026-08-02T00:00:00Z\n" +
        "Description: Main overview.\n" +
        "\n" +
        "Widgets (1):\n" +
        '#1 w-1 | Cost over time | type: query\n   Spec: {"view":"spans"}',
    );
  });

  it("formatDashboardDetail states the empty widget list explicitly", () => {
    const text = formatDashboardDetail({
      id: "dash-2",
      name: "Latency",
      description: null,
      is_default: false,
      creator: null,
      widgets: [],
    });
    expect(text).toContain("Description: (none)");
    expect(text).toContain("Widgets: (none — add one with create_widget)");
  });

  it("formatAlertList renders rule lines, capacity, and the empty state", () => {
    expect(formatAlertList({})).toBe("No alerts found in this project.");
    // A search that matched nothing still reports how full the project is.
    expect(formatAlertList({ data: [], meta: { capacity: { used: 3, max: 100 } } })).toBe(
      "No alerts found in this project.\nCapacity: 3/100 alerts used",
    );
    expect(
      formatAlertList({
        data: [
          {
            id: "alr-1",
            name: "p95 latency",
            measure: "latency",
            aggregation: "p95",
            window: "10m",
            threshold_operator: ">",
            threshold: 2000,
            status: "ACTIVE",
            severity: "OK",
            creator: "Ada Lovelace",
            last_evaluated_at: "2026-09-11T20:10:00Z",
            last_notify_status: "SENT",
            last_notify_at: "2026-09-11T20:00:00Z",
            last_error: null,
          },
          {
            id: "alr-2",
            name: "",
            measure: "error_count",
            aggregation: "sum",
            window: "1h",
            threshold_operator: ">=",
            threshold: 5,
            status: "PAUSED",
            severity: "ALERT",
            creator: null,
            last_error: "e".repeat(250),
          },
        ],
        meta: { total: 7, capacity: { used: 7, max: 100 } },
      }),
    ).toBe(
      "Found 2 alerts (7 total, showing 2):\n" +
        "- alr-1 | p95 latency | p95(latency) over 10m > 2000 | ACTIVE/OK | evaluated 2026-09-11T20:10:00Z | notify: SENT at 2026-09-11T20:00:00Z | by Ada Lovelace\n" +
        `- alr-2 | (unnamed) | sum(error_count) over 1h >= 5 | PAUSED/ALERT | evaluated never | by unknown | last error: ${"e".repeat(200)}\n` +
        "Capacity: 7/100 alerts used",
    );
  });

  it("formatAlertDetail renders the rule, filters, state, and error lines", () => {
    expect(
      formatAlertDetail({
        id: "alr-1",
        name: "p95 latency",
        view: "SPANS",
        measure: "latency",
        aggregation: "p95",
        filters: [{ field: "model_name", op: "=", value: "gpt-5" }],
        window: "10m",
        threshold_operator: ">",
        threshold: 2000,
        renotify: { mode: "EVERY", interval_minutes: 60 },
        no_data_mode: "HOLD",
        status: "ACTIVE",
        severity: "ALERT",
        severity_changed_at: "2026-09-11T20:00:00Z",
        alerted_at: "2026-09-11T20:00:00Z",
        last_evaluated_at: "2026-09-11T20:10:00Z",
        last_error: "query timed out",
        last_error_at: "2026-09-11T19:00:00Z",
        last_notify_status: "FAILED",
        last_notify_error: "channel missing",
        last_notify_at: "2026-09-11T20:00:00Z",
        creator: "Ada Lovelace",
        create_time: "2026-08-01T00:00:00Z",
        update_time: "2026-08-02T00:00:00Z",
      }),
    ).toBe(
      "Alert: alr-1 | p95 latency\n" +
        "Rule: p95(latency) over 10m > 2000 on SPANS | no-data: HOLD | renotify: every 60 min\n" +
        'Filters: [{"field":"model_name","op":"=","value":"gpt-5"}]\n' +
        "State: ACTIVE | severity: ALERT (since 2026-09-11T20:00:00Z) | alerted 2026-09-11T20:00:00Z | last evaluated 2026-09-11T20:10:00Z\n" +
        "Created by Ada Lovelace | created 2026-08-01T00:00:00Z | updated 2026-08-02T00:00:00Z\n" +
        "Last error: query timed out (2026-09-11T19:00:00Z)\n" +
        "Last notification: FAILED at 2026-09-11T20:00:00Z — channel missing",
    );
  });

  it("formatAlertDetail states missing pieces explicitly", () => {
    const text = formatAlertDetail({
      id: "alr-2",
      name: "",
      filters: [],
      renotify: { mode: "OFF" },
      status: "PAUSED",
      severity: "UNKNOWN",
    });
    expect(text).toContain("Alert: alr-2 | (unnamed)");
    expect(text).toContain("renotify: off");
    expect(text).toContain("Filters: (none)");
    expect(text).toContain("alerted never | last evaluated never");
    expect(text).toContain("Created by unknown");
    expect(text).not.toContain("Last error");
    expect(text).not.toContain("Last notification");
  });

  it("formatDetectorList renders rows and reports the empty state", () => {
    expect(formatDetectorList({})).toBe("No detectors found.");
    expect(
      formatDetectorList({
        data: [
          {
            detector_id: "det-1",
            name: "Error spike",
            template: "error-rate",
            enabled: true,
            created_at: "2026-08-01T12:00:00Z",
          },
          { detector_id: "det-2", name: "Latency", template: "latency", enabled: false },
        ],
        meta: { total: 9 },
      }),
    ).toBe(
      "Found 2 detectors (9 total, showing 2):\n" +
        "- det-1 | Error spike | template: error-rate | enabled | created 2026-08-01T12:00:00Z\n" +
        "- det-2 | Latency | template: latency | disabled | created unknown",
    );
  });

  it("formatDetectorDetail renders the full config", () => {
    expect(
      formatDetectorDetail({
        detector_id: "det-1",
        name: "Error spike",
        template: "failure",
        enabled: true,
        created_at: "2026-08-01T12:00:00Z",
        prompt: "Flag traces with elevated error rates",
        output_schema: { type: "object" },
        sample_rate: 25,
        enable_rca: true,
        detection_model: "claude-haiku-4-5",
        detection_provider: "anthropic",
        detection_source: "system",
        updated_at: "2026-08-02T09:00:00Z",
        trigger_conditions: [{ field: "root_span_finished", op: "=", value: true }],
      }),
    ).toBe(
      "Detector: det-1 | Error spike\n" +
        "Template: failure | enabled | sample rate: 25% | RCA: on\n" +
        "Detection: claude-haiku-4-5 via anthropic (system) | created 2026-08-01T12:00:00Z | updated 2026-08-02T09:00:00Z\n" +
        "\n" +
        "Prompt: Flag traces with elevated error rates\n" +
        'Output schema: {"type":"object"}\n' +
        'Trigger conditions: [{"field":"root_span_finished","op":"=","value":true}]',
    );
  });

  it("formatDetectorDetail states missing config pieces explicitly", () => {
    const text = formatDetectorDetail({
      detector_id: "det-2",
      name: "Latency",
      template: "blank",
      enabled: false,
      prompt: "",
      sample_rate: 100,
      enable_rca: false,
    });
    expect(text).toContain("disabled");
    expect(text).toContain("RCA: off");
    expect(text).toContain("Detection: default (unknown)");
    expect(text).toContain("Prompt: (none)");
    expect(text).toContain("Output schema: (none)");
    expect(text).toContain("Trigger conditions: (none — runs on every sampled trace)");
  });

  it("formatDetectorDetail truncates a long prompt to 1000 chars", () => {
    const text = formatDetectorDetail({
      detector_id: "det-3",
      name: "n",
      prompt: "p".repeat(1200),
      sample_rate: 50,
    });
    expect(text).toContain("p".repeat(1000));
    expect(text).not.toContain("p".repeat(1001));
  });

  it("formatFindingList renders rows with truncated summaries and the empty state", () => {
    expect(formatFindingList({})).toBe("No detector findings found matching the given filters.");
    const text = formatFindingList({
      data: [
        {
          finding_id: "f-1",
          trace_id: "t-1",
          timestamp: "2026-08-11T09:00:00Z",
          detectors: ["Error spike", "Latency"],
          summary: "y".repeat(250),
        },
      ],
      meta: { total: 3 },
    });
    expect(text).toContain("Found 1 findings (3 total, showing 1):");
    expect(text).toContain(
      "- f-1 | trace t-1 | 2026-08-11T09:00:00Z | detectors: Error spike, Latency",
    );
    expect(text).toContain("y".repeat(200));
    expect(text).not.toContain("y".repeat(201));
  });

  it("formatFindingDetail renders header, per-detector results, and RCA text", () => {
    expect(
      formatFindingDetail({
        finding_id: "f-1",
        trace_id: "t-1",
        timestamp: "2026-08-11T09:00:00Z",
        detectors: ["Error spike"],
        summary: "Elevated error rate",
        results: [
          {
            detector_id: "det-1",
            detector_name: "Error spike",
            template: "error-rate",
            summary: "errors spiked",
            identified: true,
            data: { count: 3 },
          },
        ],
        rca: { status: "completed", result: "Root cause: bad deploy" },
      }),
    ).toBe(
      "Finding: f-1\n" +
        "Trace: t-1 | Time: 2026-08-11T09:00:00Z | Detectors: Error spike\n" +
        "Summary: Elevated error rate\n" +
        "\n" +
        "Per-detector results:\n" +
        "#1 Error spike (template: error-rate)\n" +
        "   errors spiked\n" +
        '   Data: {"count":3}\n' +
        "\n" +
        "RCA (completed):\n" +
        "Root cause: bad deploy",
    );
  });

  it("formatFindingDetail states missing results and RCA explicitly", () => {
    const text = formatFindingDetail({
      finding_id: "f-2",
      trace_id: "t-2",
      timestamp: "2026-08-11T09:00:00Z",
      detectors: [],
      summary: "",
    });
    expect(text).toContain("Detectors: unknown");
    expect(text).toContain("Summary: (no summary)");
    expect(text).toContain("Per-detector results: (none)");
    expect(text).toContain("RCA: none recorded for this finding.");
  });

  it("formatFindingDetail marks a pending RCA with empty text", () => {
    const text = formatFindingDetail({
      finding_id: "f-3",
      trace_id: "t-3",
      timestamp: "2026-08-11T09:00:00Z",
      detectors: ["Error spike"],
      summary: "s",
      results: [],
      rca: { status: "pending", result: null },
    });
    expect(text).toContain("RCA (pending):");
    expect(text).toContain("(no RCA text yet)");
  });

  it("formatFindingDetail does not say 'yet' for a failed RCA with empty text", () => {
    const text = formatFindingDetail({
      finding_id: "f-4",
      trace_id: "t-4",
      timestamp: "2026-08-11T09:00:00Z",
      detectors: ["Error spike"],
      summary: "s",
      results: [],
      rca: { status: "failed", result: null },
    });
    expect(text).toContain("RCA (failed):");
    expect(text).toContain("(no RCA text)");
    expect(text).not.toContain("(no RCA text yet)");
  });
});
