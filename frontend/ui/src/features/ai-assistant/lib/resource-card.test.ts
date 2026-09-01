import { describe, expect, it } from "vitest";
import { appendWidgetPlacement } from "@/features/dashboards/widget-placement";
import { DISPLAY_TYPES } from "@/features/dashboards/types";
import {
  createdWidgetsByDashboard,
  pendingCardModel,
  resourceCardModel,
  suppressedWidgetStepIds,
} from "./resource-card";
import type { MiniatureTile } from "./resource-card";
import type { AIMessage, ToolCallStep } from "../types";

function step(overrides: {
  toolName: string;
  args: unknown;
  details: unknown;
  toolCallId?: string;
}): ToolCallStep {
  return {
    toolCallId: overrides.toolCallId ?? "tc1",
    toolName: overrides.toolName,
    args: overrides.args as Record<string, unknown>,
    result: {
      content: [{ type: "text", text: "Created something" }],
      details: overrides.details,
    },
    isError: false,
    status: "done",
  };
}

function created(resourceType: string, resourceId: string, extra: Record<string, unknown> = {}) {
  return { kind: "resource_created", resourceType, resourceId, created: true, ...extra };
}

const WIDGET_SPEC = {
  view: "spans",
  metric: { measure: "total_tokens", agg: "sum" },
  breakdown: "model_name",
  display: { type: "bar" },
};

function widgetStep(args: Record<string, unknown> = {}, toolCallId = "tc1"): ToolCallStep {
  return step({
    toolCallId,
    toolName: "create_widget",
    args: {
      label: "adding the chart",
      dashboard_id: "db1",
      title: "Tokens by model",
      type: "query",
      spec: WIDGET_SPEC,
      ...args,
    },
    details: created("widget", "w1", { projectId: "p1", dashboardId: "db1" }),
  });
}

describe("resourceCardModel", () => {
  it("builds a widget card with its spec chips", () => {
    expect(resourceCardModel(widgetStep())).toEqual({
      resourceType: "widget",
      resourceId: "w1",
      created: true,
      title: "Tokens by model",
      meta: ["Widget", "Last 24 hours"],
      body: {
        kind: "widget",
        chips: ["view spans", "sum(total_tokens)", "by model_name", "bar"],
        chart: {
          projectId: "p1",
          spec: { ...WIDGET_SPEC, filters: [] },
        },
      },
    });
  });

  it("names a trace feed and its row limit, which carry no chart spec", () => {
    const model = resourceCardModel(
      widgetStep({ title: "Recent traces", type: "trace_feed", spec: { filters: [], limit: 10 } }),
    );
    expect(model?.body).toEqual({
      kind: "widget",
      chips: ["trace feed", "10 rows"],
      chart: null,
    });
    expect(model?.meta).toEqual(["Widget"]);
  });

  it("keeps the chips a partial widget spec supports and drops the rest", () => {
    const model = resourceCardModel(
      widgetStep({ spec: { view: "traces", display: { type: "number" } } }),
    );
    expect(model?.body).toEqual({
      kind: "widget",
      chips: ["view traces", "number"],
      chart: null,
    });
  });

  it("charts a widget whose spec leaves out the fields the schema defaults", () => {
    const model = resourceCardModel(
      widgetStep({
        spec: { view: "spans", metric: { measure: "cost", agg: "sum" }, display: { type: "line" } },
      }),
    );
    expect(model?.body).toEqual({
      kind: "widget",
      chips: ["view spans", "sum(cost)", "line"],
      chart: {
        projectId: "p1",
        spec: {
          view: "spans",
          filters: [],
          metric: { measure: "cost", agg: "sum" },
          breakdown: null,
          display: { type: "line" },
        },
      },
    });
  });

  it("gives a widget no chart when nothing says which project to query", () => {
    const noProject = step({
      toolName: "create_widget",
      args: { title: "Tokens by model", type: "query", spec: WIDGET_SPEC },
      details: created("widget", "w1", { dashboardId: "db1" }),
    });
    const model = resourceCardModel(noProject);
    expect((model?.body as { chart: unknown }).chart).toBeNull();
    expect(model?.meta).toEqual(["Widget"]);
  });

  it("builds a dashboard card counting the widgets created into it", () => {
    const dashboard = step({
      toolName: "create_dashboard",
      args: { name: "Latency overview" },
      details: created("dashboard", "db1", { projectId: "p1" }),
    });
    const second = step({
      toolCallId: "tc2",
      toolName: "create_widget",
      args: { title: "Cost", type: "query", spec: WIDGET_SPEC },
      details: created("widget", "w2", { projectId: "p1", dashboardId: "db1" }),
    });
    const widgets = new Map([["db1", [widgetStep(), second]]]);
    const chart = { projectId: "p1", spec: { ...WIDGET_SPEC, filters: [] } };
    expect(resourceCardModel(dashboard, widgets)).toEqual({
      resourceType: "dashboard",
      resourceId: "db1",
      created: true,
      title: "Latency overview",
      meta: ["Dashboard", "2 widgets", "Last 24 hours"],
      body: {
        kind: "dashboard",
        tiles: [
          { id: "w1", title: "Tokens by model", glyph: "bar", chart, x: 0, y: 0, w: 6, h: 4 },
          { id: "w2", title: "Cost", glyph: "bar", chart, x: 6, y: 0, w: 6, h: 4 },
        ],
      },
    });
  });

  it("singularizes one widget and omits the count when the dashboard has none", () => {
    const dashboard = step({
      toolName: "create_dashboard",
      args: { name: "Latency overview" },
      details: created("dashboard", "db1"),
    });
    expect(resourceCardModel(dashboard, new Map([["db1", [widgetStep()]]]))?.meta).toEqual([
      "Dashboard",
      "1 widget",
      "Last 24 hours",
    ]);
    expect(resourceCardModel(dashboard)?.meta).toEqual(["Dashboard"]);
  });

  it("receipts a project with the scope and id its details carry", () => {
    const project = step({
      toolName: "create_project",
      args: { name: "checkout-service" },
      details: created("project", "p9", { workspaceId: "ws1" }),
    });
    expect(resourceCardModel(project)).toEqual({
      resourceType: "project",
      resourceId: "p9",
      created: true,
      title: "checkout-service",
      meta: ["Project"],
      body: {
        kind: "receipt",
        rows: [
          { label: "workspace", value: "ws1" },
          { label: "id", value: "p9" },
        ],
      },
    });
  });

  it("receipts a workspace with its id alone, inventing no other row", () => {
    const workspace = step({
      toolName: "create_workspace",
      args: { name: "acme" },
      details: created("workspace", "ws1"),
    });
    expect(resourceCardModel(workspace)).toEqual({
      resourceType: "workspace",
      resourceId: "ws1",
      created: true,
      title: "acme",
      meta: ["Workspace"],
      body: { kind: "receipt", rows: [{ label: "id", value: "ws1" }] },
    });
  });

  it("builds a detector card from its template, settings and triggers", () => {
    const detector = step({
      toolName: "create_detector",
      args: {
        name: "Timeout failures",
        template: "failure",
        sample_rate: 25,
        enable_rca: true,
        trigger_conditions: [{ field: "duration_ms", op: ">=", value: 30000 }],
      },
      details: created("detector", "d1", { projectId: "p1" }),
    });
    expect(resourceCardModel(detector)).toEqual({
      resourceType: "detector",
      resourceId: "d1",
      created: true,
      title: "Timeout failures",
      meta: ["Detector", "Failure"],
      body: {
        kind: "detector",
        chips: ["template prompt", "sample 25%", "RCA on", "Latency ≥ 30000"],
      },
    });
  });

  it("marks a detector that was given its own prompt, and one that is off", () => {
    const detector = step({
      toolName: "create_detector",
      args: {
        name: "Timeout failures",
        template: "custom",
        prompt: "Only report a timeout past 30 seconds.",
        enable_rca: false,
        enabled: false,
      },
      details: created("detector", "d1"),
    });
    const model = resourceCardModel(detector);
    expect(model?.meta).toEqual(["Detector", "custom"]);
    expect(model?.body).toEqual({
      kind: "detector",
      chips: ["custom prompt", "RCA off", "disabled"],
    });
  });

  it("caps the trigger chips so a long condition list cannot flood the card", () => {
    const conditions = [
      { field: "duration_ms", op: ">=", value: 1 },
      { field: "cost", op: ">", value: 2 },
      { field: "total_tokens", op: "<", value: 3 },
      { field: "errors", op: ">=", value: 4 },
      { field: "model_name", op: "=", value: "gpt-4" },
    ];
    const detector = step({
      toolName: "create_detector",
      args: { name: "Noisy", template: "failure", trigger_conditions: conditions },
      details: created("detector", "d1"),
    });
    expect(resourceCardModel(detector)?.body).toEqual({
      kind: "detector",
      chips: ["template prompt", "Latency ≥ 1", "Cost > 2", "Tokens < 3", "+2 more"],
    });
  });

  it("skips a trigger condition whose value is not printable", () => {
    const detector = step({
      toolName: "create_detector",
      args: {
        name: "Noisy",
        template: "failure",
        trigger_conditions: [{ field: "duration_ms", op: ">=", value: { nested: true } }, "nope"],
      },
      details: created("detector", "d1"),
    });
    expect(resourceCardModel(detector)?.body).toEqual({
      kind: "detector",
      chips: ["template prompt"],
    });
  });

  it("marks a reused resource as not created", () => {
    const dashboard = step({
      toolName: "create_dashboard",
      args: { name: "Latency overview" },
      details: { ...created("dashboard", "db1"), created: false },
    });
    expect(resourceCardModel(dashboard)?.created).toBe(false);
  });

  it("gives a reused dashboard no miniature — transcript placements would lie", () => {
    // The real grid laid this dashboard out before the transcript existed, so
    // folding the transcript's widgets through an empty layout would draw
    // positions the grid never assigned. The card keeps the count and the
    // call's description instead.
    const reused = step({
      toolName: "create_dashboard",
      args: { name: "Latency overview", description: "Where the latency lives" },
      details: { ...created("dashboard", "db1", { projectId: "p1" }), created: false },
    });
    const model = resourceCardModel(reused, new Map([["db1", [widgetStep()]]]));
    expect(model?.created).toBe(false);
    expect(model?.body).toEqual({ kind: "dashboard", tiles: [] });
    expect(model?.meta).toEqual(["Dashboard", "1 widget"]);
    expect(model?.description).toBe("Where the latency lives");
  });

  it("falls back to the resource id when the call carries no usable name", () => {
    const model = resourceCardModel(widgetStep({ title: { oops: true } }));
    expect(model?.title).toBe("w1");
    expect(JSON.stringify(model)).not.toContain("[object Object]");
  });

  it("shortens an oversized value rather than letting it run off the card", () => {
    const model = resourceCardModel(
      widgetStep({
        title: "T".repeat(400),
        spec: { ...WIDGET_SPEC, breakdown: "b".repeat(400) },
      }),
    );
    expect(model!.title.length).toBeLessThan(140);
    expect(model!.title.endsWith("…")).toBe(true);
    const chips = (model!.body as { chips: string[] }).chips;
    expect(chips.every((chip) => chip.length < 80)).toBe(true);
    expect(chips.some((chip) => chip.endsWith("…"))).toBe(true);
  });

  it("still cards a call whose arguments did not survive as named fields", () => {
    const unreadable = step({
      toolName: "create_widget",
      args: "…9001 bytes elided…",
      details: created("widget", "w1", { dashboardId: "db1" }),
    });
    const model = resourceCardModel(unreadable);
    expect(model).toEqual({
      resourceType: "widget",
      resourceId: "w1",
      created: true,
      title: "w1",
      meta: ["Widget"],
      body: { kind: "widget", chips: [], chart: null },
    });
    expect(JSON.stringify(model)).not.toContain("[object Object]");
  });

  it("has no card for a resource type it does not know how to show", () => {
    const unknown = step({
      toolName: "create_thing",
      args: { name: "thing" },
      details: created("thing", "t1"),
    });
    expect(resourceCardModel(unknown)).toBeNull();
  });

  it("has no card for a step whose result carries no resource details", () => {
    expect(
      resourceCardModel(step({ toolName: "list_traces", args: {}, details: null })),
    ).toBeNull();
    expect(
      resourceCardModel(step({ toolName: "create_widget", args: {}, details: { kind: "other" } })),
    ).toBeNull();
    expect(
      resourceCardModel({
        toolCallId: "tc1",
        toolName: "create_widget",
        args: {},
        status: "running",
      }),
    ).toBeNull();
  });
});

describe("dashboard miniature tiles", () => {
  function widget(id: string, args: Record<string, unknown>): ToolCallStep {
    return step({
      toolCallId: `tc-${id}`,
      toolName: "create_widget",
      args,
      details: created("widget", id, { projectId: "p1", dashboardId: "db1" }),
    });
  }

  function dashboardModel(widgets: ToolCallStep[]) {
    const dashboard = step({
      toolName: "create_dashboard",
      args: { name: "Latency overview" },
      details: created("dashboard", "db1", { projectId: "p1" }),
    });
    return resourceCardModel(dashboard, new Map([["db1", widgets]]));
  }

  function tilesOf(widgets: ToolCallStep[]): MiniatureTile[] {
    const body = dashboardModel(widgets)?.body;
    if (body?.kind !== "dashboard") throw new Error("expected a dashboard body");
    return body.tiles;
  }

  const query = (id: string, title: string, display = "line") =>
    widget(id, { title, type: "query", spec: { ...WIDGET_SPEC, display: { type: display } } });
  const feed = (id: string, title: string) =>
    widget(id, { title, type: "trace_feed", spec: { filters: [], limit: 10 } });

  it("places tiles exactly as the service's placement function would", () => {
    const tiles = tilesOf([query("w1", "p95"), feed("w2", "Recent"), query("w3", "Errors")]);

    // The reference layout, folded through the real placement function the
    // widget create route uses — the miniature must agree with it entry by
    // entry, id and geometry both.
    let layout: unknown = [];
    for (const w of [
      { id: "w1", type: "query" as const },
      { id: "w2", type: "trace_feed" as const },
      { id: "w3", type: "query" as const },
    ]) {
      layout = appendWidgetPlacement(layout, w);
    }
    expect(tiles.map(({ id, x, y, w, h }) => ({ i: id, x, y, w, h }))).toEqual(layout);

    // And concretely: charts sit half-width at 6x4, feeds at 6x6.
    expect(tiles[0]).toMatchObject({ x: 0, y: 0, w: 6, h: 4 });
    expect(tiles[1]).toMatchObject({ x: 6, y: 0, w: 6, h: 6 });
    expect(tiles[2]).toMatchObject({ x: 0, y: 6, w: 6, h: 4 });
  });

  it("gives every display type its own glyph and a feed its list glyph", () => {
    for (const display of DISPLAY_TYPES) {
      expect(tilesOf([query("w1", "t", display)])[0].glyph).toBe(display);
    }
    expect(tilesOf([feed("w1", "Recent")])[0].glyph).toBe("trace_feed");
  });

  it("falls back to a neutral tile for a display it does not know", () => {
    const odd = widget("w1", {
      title: "t",
      type: "query",
      spec: { ...WIDGET_SPEC, display: { type: "sparkline" } },
    });
    expect(tilesOf([odd])[0].glyph).toBe("unknown");
  });

  it("shows a widget once even when its create call was replayed", () => {
    const tiles = tilesOf([query("w1", "p95"), query("w1", "p95 again")]);
    expect(tiles).toHaveLength(1);
    expect(tiles[0]).toMatchObject({ id: "w1", title: "p95" });
  });

  it("tiles a widget whose arguments did not survive, at a chart's size", () => {
    const unreadable = step({
      toolName: "create_widget",
      args: "…elided…",
      details: created("widget", "w1", { dashboardId: "db1" }),
    });
    expect(tilesOf([unreadable])[0]).toEqual({
      id: "w1",
      title: "w1",
      glyph: "unknown",
      chart: null,
      x: 0,
      y: 0,
      w: 6,
      h: 4,
    });
  });

  it("carries the live query behind a chart tile — project and parsed spec", () => {
    const [tileOf] = tilesOf([query("w1", "p95")]);
    expect(tileOf.chart).toEqual({
      projectId: "p1",
      spec: { ...WIDGET_SPEC, filters: [], display: { type: "line" } },
    });
  });

  it("gives a feed tile and an unparseable spec no query to run", () => {
    expect(tilesOf([feed("w1", "Recent")])[0].chart).toBeNull();
    const odd = widget("w2", {
      title: "t",
      type: "query",
      spec: { ...WIDGET_SPEC, display: { type: "sparkline" } },
    });
    expect(tilesOf([odd])[0].chart).toBeNull();
  });

  it("labels the card's window only when a tile will chart live data", () => {
    expect(dashboardModel([query("w1", "p95")])?.meta).toContain("Last 24 hours");
    expect(dashboardModel([feed("w1", "Recent")])?.meta).not.toContain("Last 24 hours");
  });

  it("has no tiles when the transcript created no widgets in the dashboard", () => {
    expect(tilesOf([])).toEqual([]);
    const body = resourceCardModel(
      step({
        toolName: "create_dashboard",
        args: { name: "Empty" },
        details: created("dashboard", "db9"),
      }),
    )?.body;
    expect(body).toEqual({ kind: "dashboard", tiles: [] });
  });
});

describe("createdWidgetsByDashboard", () => {
  function entry(id: string, toolStep: ToolCallStep | undefined, role = "tool_step"): AIMessage {
    return {
      id,
      role: role as AIMessage["role"],
      content: "",
      timestamp: "2026-01-02T03:04:05.000Z",
      toolStep,
    };
  }

  it("groups created widgets by the dashboard they were added to", () => {
    const first = widgetStep({}, "tc1");
    const second = step({
      toolName: "create_widget",
      toolCallId: "tc2",
      args: { title: "Errors by model" },
      details: created("widget", "w2", { projectId: "p1", dashboardId: "db1" }),
    });
    const other = step({
      toolName: "create_widget",
      toolCallId: "tc3",
      args: { title: "Elsewhere" },
      details: created("widget", "w3", { dashboardId: "db2" }),
    });
    const grouped = createdWidgetsByDashboard([
      entry("u1", undefined, "user"),
      entry("tc1", first),
      entry("tc2", second),
      entry("tc3", other),
    ]);
    expect(grouped.get("db1")).toEqual([first, second]);
    expect(grouped.get("db2")).toEqual([other]);
  });

  it("ignores steps that are not widgets and widgets with no dashboard", () => {
    const dashboard = step({
      toolName: "create_dashboard",
      args: { name: "Latency overview" },
      details: created("dashboard", "db1"),
    });
    const orphan = step({
      toolName: "create_widget",
      args: { title: "Orphan" },
      details: created("widget", "w9"),
    });
    const grouped = createdWidgetsByDashboard([entry("tc1", dashboard), entry("tc2", orphan)]);
    expect(grouped.size).toBe(0);
  });

  it("keeps only the first step of a replayed create (same widget id twice)", () => {
    const first = widgetStep({}, "tc1");
    const replay = widgetStep({}, "tc2");
    const grouped = createdWidgetsByDashboard([entry("tc1", first), entry("tc2", replay)]);
    expect(grouped.get("db1")).toEqual([first]);
  });
});

describe("suppressedWidgetStepIds", () => {
  function entry(id: string, toolStep: ToolCallStep | undefined, role = "tool_step"): AIMessage {
    return {
      id,
      role: role as AIMessage["role"],
      content: "",
      timestamp: "2026-01-02T03:04:05.000Z",
      toolStep,
    };
  }

  const dashboardStep = (resourceId = "db1") =>
    step({
      toolName: "create_dashboard",
      args: { name: "Latency overview" },
      details: created("dashboard", resourceId),
    });

  it("suppresses a widget whose dashboard has its own card earlier in the transcript", () => {
    const suppressed = suppressedWidgetStepIds([
      entry("tc0", dashboardStep()),
      entry("tc1", widgetStep({}, "tc1")),
    ]);
    expect(suppressed).toEqual(new Set(["tc1"]));
  });

  it("suppresses every replay of a create the miniature already draws", () => {
    const suppressed = suppressedWidgetStepIds([
      entry("tc0", dashboardStep()),
      entry("tc1", widgetStep({}, "tc1")),
      entry("tc2", widgetStep({}, "tc2")),
    ]);
    expect(suppressed).toEqual(new Set(["tc1", "tc2"]));
  });

  it("keeps a widget's card when its dashboard was reused, not created", () => {
    // A reused dashboard's card has no miniature, so the widget cards are the
    // only true receipt for the writes and must not be suppressed under it.
    const reused = step({
      toolName: "create_dashboard",
      args: { name: "Latency overview" },
      details: { ...created("dashboard", "db1"), created: false },
    });
    const suppressed = suppressedWidgetStepIds([
      entry("tc0", reused),
      entry("tc1", widgetStep({}, "tc1")),
    ]);
    expect(suppressed.size).toBe(0);
  });

  it("keeps a widget added to a dashboard with no card in the transcript", () => {
    const suppressed = suppressedWidgetStepIds([
      entry("tc0", dashboardStep("db-other")),
      entry("tc1", widgetStep({}, "tc1")),
    ]);
    expect(suppressed.size).toBe(0);
  });

  it("keeps a widget whose step precedes its dashboard's card", () => {
    const suppressed = suppressedWidgetStepIds([
      entry("tc1", widgetStep({}, "tc1")),
      entry("tc0", dashboardStep()),
    ]);
    expect(suppressed.size).toBe(0);
  });

  it("never suppresses non-widget steps or widgets with no dashboard id", () => {
    const orphan = step({
      toolName: "create_widget",
      toolCallId: "tc2",
      args: { title: "Orphan" },
      details: created("widget", "w9"),
    });
    const suppressed = suppressedWidgetStepIds([
      entry("tc0", dashboardStep()),
      entry("tc2", orphan),
      entry("u1", undefined, "user"),
    ]);
    expect(suppressed.size).toBe(0);
  });
});

describe("pendingCardModel", () => {
  const runningStep = (
    toolName: string,
    args: Record<string, unknown>,
    toolCallId = "tcp1",
  ): ToolCallStep => ({
    toolCallId,
    toolName,
    args,
    status: "running",
  });

  it("builds a pending widget card with the real chart, keyed by the tool call", () => {
    const model = pendingCardModel(
      runningStep("create_widget", {
        dashboard_id: "db1",
        title: "Tokens by model",
        type: "query",
        spec: WIDGET_SPEC,
      }),
      "p1",
    );
    expect(model).toEqual({
      resourceType: "widget",
      resourceId: "tcp1",
      created: true,
      title: "Tokens by model",
      meta: ["Widget", "Last 24 hours"],
      body: {
        kind: "widget",
        chips: ["view spans", "sum(total_tokens)", "by model_name", "bar"],
        chart: {
          projectId: "p1",
          spec: { ...WIDGET_SPEC, filters: [] },
        },
      },
    });
  });

  it("keeps the chips but drops the chart when the spec fails the schema", () => {
    const model = pendingCardModel(
      runningStep("create_widget", { title: "Broken", type: "query", spec: { view: "spans" } }),
      "p1",
    );
    expect(model?.body).toEqual({ kind: "widget", chips: ["view spans"], chart: null });
    expect(model?.meta).toEqual(["Widget"]);
  });

  it("drops the chart when the panel has no project to aim the query at", () => {
    const model = pendingCardModel(
      runningStep("create_widget", { title: "T", type: "query", spec: WIDGET_SPEC }),
      undefined,
    );
    expect(model?.body).toMatchObject({ kind: "widget", chart: null });
  });

  it("builds a pending dashboard card from name and description alone", () => {
    const model = pendingCardModel(
      runningStep("create_dashboard", {
        name: "Latency overview",
        description: "Where the time goes",
      }),
      "p1",
    );
    expect(model).toEqual({
      resourceType: "dashboard",
      resourceId: "tcp1",
      created: true,
      title: "Latency overview",
      description: "Where the time goes",
      meta: ["Dashboard"],
      body: { kind: "dashboard", tiles: [] },
    });
  });

  it("builds a pending detector card with its template and chips", () => {
    const model = pendingCardModel(
      runningStep("create_detector", {
        name: "Slow spans",
        template: "failure",
        sample_rate: 25,
        enable_rca: true,
      }),
      "p1",
    );
    expect(model).toEqual({
      resourceType: "detector",
      resourceId: "tcp1",
      created: true,
      title: "Slow spans",
      meta: ["Detector", "Failure"],
      body: { kind: "detector", chips: ["template prompt", "sample 25%", "RCA on"] },
    });
  });

  it("builds a header-only pending card for a project", () => {
    const model = pendingCardModel(runningStep("create_project", { name: "checkout" }), "p1");
    expect(model).toEqual({
      resourceType: "project",
      resourceId: "tcp1",
      created: true,
      title: "checkout",
      meta: ["Project"],
      body: { kind: "receipt", rows: [] },
    });
  });

  it("falls back to the resource label when the args carry no name", () => {
    const model = pendingCardModel(runningStep("create_workspace", {}), "p1");
    expect(model?.title).toBe("Workspace");
  });

  it("returns null for a tool this panel has no pending card for", () => {
    expect(pendingCardModel(runningStep("update_dashboard_layout", {}), "p1")).toBeNull();
  });
});
