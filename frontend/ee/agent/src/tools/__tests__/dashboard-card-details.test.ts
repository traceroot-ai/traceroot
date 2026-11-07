import { describe, expect, it } from "vitest";
import {
  DASHBOARD_CARD_DETAILS_MAX_BYTES,
  dashboardDataCardDetails,
  dashboardDetailCardDetails,
  widgetDataCardDetails,
  widgetDetailCardDetails,
} from "../dashboard-card-details.js";

const SPEC = {
  view: "spans",
  filters: [],
  metric: { measure: "cost", agg: "sum" },
  breakdown: "model_name",
  display: { type: "bar" },
};

const ANSWERED = {
  start_time: "2026-09-01T00:00:00Z",
  end_time: "2026-09-08T00:00:00Z",
  range: "7d",
  clamped: false,
};

const dashboardDetail = (overrides: Record<string, unknown> = {}) => ({
  id: "dash-1",
  name: "Overview",
  description: null,
  is_default: true,
  creator: "Ada",
  create_time: "2026-08-01T00:00:00Z",
  update_time: "2026-08-02T00:00:00Z",
  widgets: [
    { id: "w-1", title: "Cost", type: "query", spec: SPEC, create_time: "2026-08-01T00:00:00Z" },
    {
      id: "w-2",
      title: "Errors",
      type: "trace_feed",
      spec: { filters: [] },
      create_time: "2026-08-01T00:00:00Z",
    },
  ],
  layout: [
    { i: "w-1", x: 0, y: 0, w: 6, h: 4 },
    { i: "w-2", x: 6, y: 0, w: 6, h: 6 },
  ],
  ...overrides,
});

describe("dashboardDetailCardDetails", () => {
  it("projects the definition and placement, drawn over the page's preset", () => {
    expect(dashboardDetailCardDetails(dashboardDetail(), { range: "1d" })).toEqual({
      kind: "dashboard_read",
      dashboard: { id: "dash-1", name: "Overview" },
      window: { range: "1d", start_time: null, end_time: null, clamped: false },
      widgets: [
        { id: "w-1", title: "Cost", type: "query", spec: SPEC, status: null, error: null },
        {
          id: "w-2",
          title: "Errors",
          type: "trace_feed",
          spec: { filters: [] },
          status: null,
          error: null,
        },
      ],
      layout: [
        { i: "w-1", x: 0, y: 0, w: 6, h: 4 },
        { i: "w-2", x: 6, y: 0, w: 6, h: 6 },
      ],
    });
  });

  it("carries the page's explicit bounds, and no window when the page gave none", () => {
    const bounds = { start_time: "2026-09-01T00:00:00Z", end_time: "2026-09-02T00:00:00Z" };
    expect(dashboardDetailCardDetails(dashboardDetail(), bounds)!.window).toEqual({
      range: null,
      ...bounds,
      clamped: false,
    });
    expect(dashboardDetailCardDetails(dashboardDetail(), undefined)!.window).toBeNull();
    expect(dashboardDetailCardDetails(dashboardDetail(), {})!.window).toBeNull();
  });

  it("drops placements that are not placements, and reads a missing layout as null", () => {
    const details = dashboardDetailCardDetails(
      dashboardDetail({
        layout: [{ i: "w-1", x: 0, y: 0, w: 6, h: 4 }, { i: "w-2", x: 1.5 }, "junk", { x: 0 }],
      }),
      undefined,
    );
    expect(details!.layout).toEqual([{ i: "w-1", x: 0, y: 0, w: 6, h: 4 }]);
    expect(
      dashboardDetailCardDetails(dashboardDetail({ layout: undefined }), undefined)!.layout,
    ).toBeNull();
  });

  it("is undefined when a widget cannot be read, rather than carding a different dashboard", () => {
    const widgets = [...dashboardDetail().widgets, { title: "no id" }];
    expect(dashboardDetailCardDetails(dashboardDetail({ widgets }), undefined)).toBeUndefined();
  });

  it("is undefined past the byte ceiling a persisted step can carry", () => {
    const widgets = Array.from({ length: 60 }, (_, i) => ({
      id: `w-${i}`,
      title: `Widget ${i}`,
      type: "query",
      spec: SPEC,
    }));
    expect(Buffer.byteLength(JSON.stringify(widgets)) > DASHBOARD_CARD_DETAILS_MAX_BYTES).toBe(
      true,
    );
    expect(dashboardDetailCardDetails(dashboardDetail({ widgets }), undefined)).toBeUndefined();
  });

  it("is undefined when the payload is not a dashboard", () => {
    expect(
      dashboardDetailCardDetails({ detail: "Dashboard not found" }, undefined),
    ).toBeUndefined();
    expect(dashboardDetailCardDetails({ id: "d", widgets: "none" }, undefined)).toBeUndefined();
    expect(dashboardDetailCardDetails("Error calling get_dashboard", undefined)).toBeUndefined();
  });
});

describe("dashboardDataCardDetails", () => {
  it("carries each widget's status and reason with the answered window, never the rows", () => {
    const details = dashboardDataCardDetails({
      dashboard: { id: "dash-1", name: "Overview" },
      window: ANSWERED,
      widgets: [
        {
          id: "w-1",
          title: "Cost",
          type: "query",
          status: "ok",
          spec: SPEC,
          columns: ["model_name", "value"],
          rows: [["gpt", 1]],
          meta: {},
        },
        { id: "w-2", title: "Errors", type: "trace_feed", status: "skipped", spec: {} },
        { id: "w-3", title: "Broken", type: "query", status: "error", error: "x".repeat(400) },
      ],
      layout: [{ i: "w-1", x: 0, y: 0, w: 6, h: 4 }],
      queried: 1,
      skipped: 1,
      failed: 1,
    });
    expect(details!.window).toEqual(ANSWERED);
    expect(details!.widgets.map((w) => w.status)).toEqual(["ok", "skipped", "error"]);
    expect(details!.widgets[0]).not.toHaveProperty("rows");
    expect(details!.widgets[2].spec).toBeNull();
    expect(details!.widgets[2].error).toHaveLength(301);
    expect(details!.layout).toEqual([{ i: "w-1", x: 0, y: 0, w: 6, h: 4 }]);
  });

  it("reads a window without bounds as none", () => {
    const details = dashboardDataCardDetails({
      dashboard: { id: "dash-1", name: "Overview" },
      window: { range: "7d" },
      widgets: [],
    });
    expect(details!.window).toBeNull();
    expect(dashboardDataCardDetails(null)).toBeUndefined();
  });
});

describe("widgetDetailCardDetails", () => {
  it("projects the widget with its dashboard, drawn over the page's window", () => {
    expect(
      widgetDetailCardDetails(
        {
          id: "w-1",
          title: "Cost",
          type: "query",
          spec: SPEC,
          dashboard_id: "dash-1",
          dashboard_name: "Overview",
          display_config: {},
        },
        { range: "30d" },
      ),
    ).toEqual({
      kind: "widget_read",
      widget: {
        id: "w-1",
        title: "Cost",
        type: "query",
        spec: SPEC,
        status: null,
        error: null,
        dashboard_id: "dash-1",
        dashboard_name: "Overview",
      },
      window: { range: "30d", start_time: null, end_time: null, clamped: false },
    });
  });

  it("is undefined without a widget id or a dashboard id", () => {
    expect(widgetDetailCardDetails({ id: "w-1", title: "x" }, undefined)).toBeUndefined();
    expect(widgetDetailCardDetails({ dashboard_id: "d" }, undefined)).toBeUndefined();
    expect(widgetDetailCardDetails(null, undefined)).toBeUndefined();
  });
});

describe("widgetDataCardDetails", () => {
  it("joins the answer's status to the widget's identity, leaving the rows out", () => {
    const details = widgetDataCardDetails({
      widget: {
        id: "w-1",
        dashboard_id: "dash-1",
        title: "Cost",
        type: "query",
        dashboard_name: "Overview",
        spec: SPEC,
      },
      window: { ...ANSWERED, range: null },
      status: "ok",
      columns: ["model_name", "value"],
      rows: [["gpt", 1]],
    });
    expect(details).toEqual({
      kind: "widget_read",
      widget: {
        id: "w-1",
        title: "Cost",
        type: "query",
        spec: SPEC,
        status: "ok",
        error: null,
        dashboard_id: "dash-1",
        dashboard_name: "Overview",
      },
      window: { ...ANSWERED, range: null },
    });
  });

  it("carries an error's reason, and reads an older server's widget without spec or name", () => {
    const details = widgetDataCardDetails({
      widget: { id: "w-1", dashboard_id: "dash-1", title: "Cost", type: "query" },
      window: ANSWERED,
      status: "error",
      error: "spec: metric: field required",
    });
    expect(details!.widget).toMatchObject({
      status: "error",
      error: "spec: metric: field required",
      spec: null,
      dashboard_name: null,
    });
    expect(widgetDataCardDetails({ widget: "w-1" })).toBeUndefined();
    expect(widgetDataCardDetails(undefined)).toBeUndefined();
  });
});
