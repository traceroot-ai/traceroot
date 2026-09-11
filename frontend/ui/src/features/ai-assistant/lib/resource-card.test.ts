import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendWidgetPlacement } from "@/features/dashboards/widget-placement";
import { DATE_FILTER_OPTIONS, DEFAULT_DATE_FILTER } from "@/lib/date-filter";
import { dateFilterStorageKey } from "@/lib/date-filter-storage";
import {
  createdWidgetsByDashboard,
  pendingCardModel,
  pendingProposal,
  readCardModel,
  resourceCardModel,
  suppressedWidgetStepIds,
} from "./resource-card";
import type { PreviewTile, ResourceCardModel } from "./resource-card";
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

const preset = (id: string) => DATE_FILTER_OPTIONS.find((o) => o.id === id)!;

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
      href: "/projects/p1/dashboard/db1",
      meta: ["Widget", "Last 24 hours"],
      body: {
        kind: "widget",
        chips: ["view spans", "sum(total_tokens)", "by model_name", "bar"],
        chart: {
          projectId: "p1",
          spec: { ...WIDGET_SPEC, filters: [] },
          range: DEFAULT_DATE_FILTER,
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
        range: DEFAULT_DATE_FILTER,
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
    // The raw spec, not the parsed one: the preview's tile body parses it
    // itself, exactly as the dashboard's does.
    const widget = { type: "query", spec: WIDGET_SPEC };
    expect(resourceCardModel(dashboard, widgets)).toEqual({
      resourceType: "dashboard",
      resourceId: "db1",
      created: true,
      title: "Latency overview",
      href: "/projects/p1/dashboard/db1",
      meta: ["Dashboard", "2 widgets", "Last 24 hours"],
      body: {
        kind: "dashboard",
        tiles: [
          {
            id: "w1",
            title: "Tokens by model",
            projectId: "p1",
            widget,
            range: DEFAULT_DATE_FILTER,
            x: 0,
            y: 0,
            w: 6,
            h: 4,
          },
          {
            id: "w2",
            title: "Cost",
            projectId: "p1",
            widget,
            range: DEFAULT_DATE_FILTER,
            x: 6,
            y: 0,
            w: 6,
            h: 4,
          },
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
      href: null,
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
      href: null,
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
      href: "/projects/p1/detectors/d1",
      meta: ["Detector", "Failure"],
      body: {
        kind: "detector",
        chips: ["sample 25%", "RCA on", "Latency ≥ 30000"],
        // The prompt was omitted, so the detector runs the template's
        // canonical instructions — the card says so instead of staying mute.
        prompt: { kind: "standard", templateLabel: "Failure" },
      },
    });
  });

  it("shows the actual prompt of a detector that was given its own, and its RCA switch", () => {
    const detector = step({
      toolName: "create_detector",
      args: {
        name: "Timeout failures",
        template: "blank",
        prompt: "Only report a timeout past 30 seconds.",
        enable_rca: false,
        enabled: false,
      },
      details: created("detector", "d1"),
    });
    const model = resourceCardModel(detector);
    // A blank-template detector is a custom one — the meta says "Custom",
    // never the internal id "blank".
    expect(model?.meta).toEqual(["Detector", "Custom"]);
    expect(model?.body).toEqual({
      kind: "detector",
      chips: ["RCA off"],
      prompt: { kind: "custom", text: "Only report a timeout past 30 seconds." },
    });
  });

  it("keeps a custom prompt over the template default when both are present", () => {
    const detector = step({
      toolName: "create_detector",
      args: { name: "Picky failures", template: "failure", prompt: "Only tool errors count." },
      details: created("detector", "d1"),
    });
    const model = resourceCardModel(detector);
    expect(model?.meta).toEqual(["Detector", "Failure"]);
    expect(model?.body).toMatchObject({
      prompt: { kind: "custom", text: "Only tool errors count." },
    });
  });

  it("chips the detection model and never the enabled flag", () => {
    const detector = step({
      toolName: "create_detector",
      args: {
        name: "Failures",
        template: "failure",
        detection_model: "gpt-4o-mini",
        enabled: true,
      },
      details: created("detector", "d1"),
    });
    expect(resourceCardModel(detector)?.body).toMatchObject({
      chips: ["model gpt-4o-mini"],
    });
  });

  it("claims no prompt for a blank detector whose args carry none", () => {
    const detector = step({
      toolName: "create_detector",
      args: { name: "Mystery", template: "blank" },
      details: created("detector", "d1"),
    });
    expect(resourceCardModel(detector)?.body).toEqual({
      kind: "detector",
      chips: [],
      prompt: null,
    });
  });

  it("caps an oversized id wherever the card prints it", () => {
    // The ids come from the payload, so a card must cap them like any other
    // printed value — the identity it reports back stays whole.
    const longProject = "p".repeat(200);
    const longWorkspace = "w".repeat(200);
    const project = step({
      toolName: "create_project",
      args: {},
      details: created("project", longProject, { workspaceId: longWorkspace }),
    });
    const card = resourceCardModel(project);
    expect(card?.resourceId).toBe(longProject);
    expect(card?.title).toBe(`${"p".repeat(120)}\u2026`);
    expect(card?.body).toEqual({
      kind: "receipt",
      rows: [
        { label: "workspace", value: `${"w".repeat(64)}\u2026` },
        { label: "id", value: `${"p".repeat(64)}\u2026` },
      ],
    });
  });

  it("caps a runaway prompt so the card cannot flood the transcript", () => {
    const detector = step({
      toolName: "create_detector",
      args: { name: "Big", template: "blank", prompt: "x".repeat(5000) },
      details: created("detector", "d1"),
    });
    const body = resourceCardModel(detector)?.body;
    expect(body?.kind).toBe("detector");
    if (body?.kind !== "detector" || body.prompt?.kind !== "custom") throw new Error("no prompt");
    expect(body.prompt.text.length).toBeLessThanOrEqual(2001);
    expect(body.prompt.text.endsWith("…")).toBe(true);
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
    expect(resourceCardModel(detector)?.body).toMatchObject({
      kind: "detector",
      chips: ["Latency ≥ 1", "Cost > 2", "Tokens < 3", "+2 more"],
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
    expect(resourceCardModel(detector)?.body).toMatchObject({
      kind: "detector",
      chips: [],
    });
  });

  it("titles the receipt with the name the resource was actually created under", () => {
    // The args carry the name the model asked for; the details carry the one
    // the service used. When they differ (a suffixed dashboard) the card
    // must show the real one, or the reader would look for a dashboard that
    // does not exist.
    const renamed = step({
      toolName: "create_dashboard",
      args: { name: "Latency overview" },
      details: created("dashboard", "db2", {
        projectId: "p1",
        name: "Latency overview (2)",
        renamedFrom: "Latency overview",
      }),
    });
    const model = resourceCardModel(renamed);
    expect(model?.title).toBe("Latency overview (2)");
    expect(model?.created).toBe(true);
    expect(model?.description).toBe(
      'Renamed from "Latency overview": a dashboard with that name already existed.',
    );
    // Still a created dashboard: it keeps its preview and its link.
    expect(model?.body).toEqual({ kind: "dashboard", tiles: [] });
    expect(model?.href).toBe("/projects/p1/dashboard/db2");
  });

  it("prefers the details' name over the args' for every resource type", () => {
    const model = resourceCardModel(
      step({
        toolName: "create_widget",
        args: { title: "Tokens by model", type: "query", spec: WIDGET_SPEC },
        details: created("widget", "w1", { projectId: "p1", dashboardId: "db1", name: "Tokens" }),
      }),
    );
    expect(model?.title).toBe("Tokens");
  });

  it("falls back to the args' name when the details carry none or an unusable one", () => {
    expect(resourceCardModel(widgetStep())?.title).toBe("Tokens by model");
    const blank = step({
      toolName: "create_widget",
      args: { title: "Tokens by model" },
      details: created("widget", "w1", { name: "   " }),
    });
    expect(resourceCardModel(blank)?.title).toBe("Tokens by model");
    const wrongType = step({
      toolName: "create_widget",
      args: { title: "Tokens by model" },
      details: created("widget", "w1", { name: { oops: true } }),
    });
    expect(resourceCardModel(wrongType)?.title).toBe("Tokens by model");
  });

  it("adds no rename note when renamedFrom is missing or unusable", () => {
    const plain = step({
      toolName: "create_dashboard",
      args: { name: "Latency overview", description: "Where the time goes" },
      details: created("dashboard", "db1", { name: "Latency overview" }),
    });
    expect(resourceCardModel(plain)?.description).toBeUndefined();
    const junk = step({
      toolName: "create_dashboard",
      args: { name: "Latency overview" },
      details: created("dashboard", "db1", { renamedFrom: 7 }),
    });
    expect(resourceCardModel(junk)?.description).toBeUndefined();
  });

  it("marks a reused resource as not created", () => {
    const dashboard = step({
      toolName: "create_dashboard",
      args: { name: "Latency overview" },
      details: { ...created("dashboard", "db1"), created: false },
    });
    expect(resourceCardModel(dashboard)?.created).toBe(false);
  });

  it("gives a reused dashboard no preview — transcript placements would lie", () => {
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
      href: null,
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

describe("alert cards", () => {
  const RULE_ARGS = {
    label: "adding the alert",
    name: "p95 latency over 2s",
    view: "SPANS",
    measure: "latency",
    aggregation: "p95",
    window: "10m",
    threshold_operator: ">",
    threshold: 2000,
    renotify: { mode: "OFF" },
  };
  const RULE = {
    view: "SPANS",
    measure: "latency",
    aggregation: "p95",
    window: "10m",
    operator: ">",
    threshold: 2000,
    filters: [],
  };
  const FRESH_STATE = {
    status: "ACTIVE",
    severity: "UNKNOWN",
    lastEvaluatedAt: null,
    lastError: null,
    lastNotifyStatus: null,
    lastNotifyError: null,
  };

  function alertStep(args: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
    return step({
      toolName: "create_alert",
      args: { ...RULE_ARGS, ...args },
      details: created("alert", "al1", { projectId: "p1", alertState: FRESH_STATE, ...extra }),
    });
  }

  it("builds an alert receipt: the rule's chart over the site window, its chips, and its badge", () => {
    expect(resourceCardModel(alertStep())).toEqual({
      resourceType: "alert",
      resourceId: "al1",
      created: true,
      title: "p95 latency over 2s",
      href: "/projects/p1/alerts/al1",
      meta: ["Alert", "Last 24 hours"],
      description: "p95 latency over 10 minutes is above 2,000 ms",
      badge: {
        status: "ACTIVE",
        severity: "UNKNOWN",
        lastEvaluatedAt: null,
        lastError: null,
        lastNotifyStatus: null,
        lastNotifyError: null,
      },
      body: {
        kind: "alert",
        chips: ["view spans", "p95(latency)", "over 10m", "> 2,000 ms", "renotify off"],
        chart: { ...RULE, projectId: "p1", range: DEFAULT_DATE_FILTER },
      },
    });
  });

  it("chips every part of the rule in order, with the unit, the filters, renotify and no-data", () => {
    const model = resourceCardModel(
      alertStep({
        measure: "cost",
        aggregation: "sum",
        window: "1h",
        threshold_operator: ">=",
        threshold: 40,
        filters: [
          { field: "environment", op: "=", value: "production" },
          { field: "metadata", key: "tenant", op: "contains", value: "acme" },
          { field: "model_name", op: "=", value: "gpt-4o" },
          { field: "status", op: "=", value: "ERROR" },
          { field: "is_root", op: "=", value: "true" },
          "not a filter",
        ],
        renotify: { mode: "EVERY", interval_minutes: 60 },
        no_data_mode: "HOLD",
      }),
    );
    expect((model?.body as { chips: string[] }).chips).toEqual([
      "view spans",
      "sum(cost)",
      "over 1h",
      "≥ $40",
      "environment = production",
      "metadata[tenant] contains acme",
      "model_name = gpt-4o",
      "+2 more",
      "renotify every 60 min",
      "no data → HOLD",
    ]);
    // The chart carries only the filters that are really filters.
    expect((model?.body as { chart: { filters: unknown[] } }).chart.filters).toHaveLength(5);
    expect(model?.description).toBe("total cost over 1 hour is at or above $40");
  });

  it("keeps the chips it can read when the rule as a whole cannot be charted", () => {
    const model = resourceCardModel(
      alertStep({ window: "45m", threshold: "2000", renotify: { mode: "EVERY" } }),
    );
    expect(model?.body).toEqual({
      kind: "alert",
      chips: ["view spans", "p95(latency)", "over 45m", "renotify"],
      chart: null,
    });
    expect(model?.meta).toEqual(["Alert"]);
    // No whole rule, no sentence: the panel shows the chips it has.
    expect(model).not.toHaveProperty("description");
  });

  it("charts nothing when the details never said which project the alert landed in", () => {
    const model = resourceCardModel(
      step({ toolName: "create_alert", args: RULE_ARGS, details: created("alert", "al1") }),
    );
    expect((model?.body as { chart: unknown }).chart).toBeNull();
    expect(model?.href).toBeNull();
  });

  it("carries no badge when the details carry no readable state", () => {
    const none = resourceCardModel(
      step({
        toolName: "create_alert",
        args: RULE_ARGS,
        details: created("alert", "al1", { projectId: "p1" }),
      }),
    );
    expect(none).not.toHaveProperty("badge");
    const junk = resourceCardModel(
      alertStep({}, { alertState: { status: "ON", severity: "RED" } }),
    );
    expect(junk).not.toHaveProperty("badge");
  });

  it("still cards an alert whose arguments did not survive, with no chart and no chips", () => {
    const model = resourceCardModel(
      step({
        toolName: "create_alert",
        args: "lost",
        details: created("alert", "al1", { projectId: "p1" }),
      }),
    );
    expect(model?.body).toEqual({ kind: "alert", chips: [], chart: null });
    expect(model?.title).toBe("al1");
  });

  it("builds a pending alert card aimed at the panel's project, with nothing to open and no badge", () => {
    const pending: ToolCallStep = {
      toolCallId: "tcp9",
      toolName: "create_alert",
      args: { ...RULE_ARGS, filters: [{ field: "environment", op: "=", value: "production" }] },
      status: "running",
      pending: { decisionId: "dec-1" },
    };
    expect(pendingCardModel(pending, "p1")).toEqual({
      resourceType: "alert",
      resourceId: "tcp9",
      created: true,
      title: "p95 latency over 2s",
      href: null,
      meta: ["Alert", "Last 24 hours"],
      description: "p95 latency over 10 minutes is above 2,000 ms",
      body: {
        kind: "alert",
        chips: [
          "view spans",
          "p95(latency)",
          "over 10m",
          "> 2,000 ms",
          "environment = production",
          "renotify off",
        ],
        chart: {
          ...RULE,
          filters: [{ field: "environment", op: "=", value: "production" }],
          projectId: "p1",
          range: DEFAULT_DATE_FILTER,
        },
      },
    });
    expect(pendingCardModel(pending, undefined)?.body).toMatchObject({ chart: null });
    expect(pendingProposal(pending)).toEqual({
      resourceType: "alert",
      title: "p95 latency over 2s",
    });
  });

  it("links the alert receipt to its detail page and refuses an unsafe id", () => {
    expect(resourceCardModel(alertStep())?.href).toBe("/projects/p1/alerts/al1");
    const unsafe = step({
      toolName: "create_alert",
      args: RULE_ARGS,
      details: created("alert", "../admin", { projectId: "p1" }),
    });
    expect(resourceCardModel(unsafe)?.href).toBeNull();
  });
});

describe("readCardModel", () => {
  const NOW = new Date("2026-09-11T14:50:00Z");
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const row = (overrides: Record<string, unknown> = {}) => ({
    id: "al-1",
    name: "p95 latency over 2s",
    view: "SPANS",
    measure: "latency",
    aggregation: "p95",
    window: "10m",
    threshold_operator: ">",
    threshold: 2000,
    status: "ACTIVE",
    severity: "OK",
    alerted_at: null,
    last_evaluated_at: "2026-09-11T14:48:00Z",
    last_error: null,
    last_notify_status: null,
    last_notify_error: null,
    last_notify_at: null,
    ...overrides,
  });

  function readStep(toolName: string, details: unknown, overrides: Partial<ToolCallStep> = {}) {
    return {
      toolCallId: "tcr1",
      toolName,
      args: {},
      result: { content: [{ type: "text", text: "Found alerts" }], details },
      isError: false,
      status: "done",
      ...overrides,
    } as ToolCallStep;
  }

  const listDetails = (alerts: unknown[], extra: Record<string, unknown> = {}) => ({
    kind: "alert_list",
    alerts,
    total: alerts.length,
    capacity: { used: alerts.length, max: 100 },
    ...extra,
  });

  it("cards a list_alerts read: one row per alert with its rule, state, badge and link", () => {
    const model = readCardModel(
      readStep(
        "list_alerts",
        listDetails([
          row(),
          row({
            id: "al-2",
            name: "Error rate spike",
            measure: "count",
            aggregation: "count",
            window: "5m",
            threshold_operator: ">=",
            threshold: 25,
            severity: "ALERT",
            alerted_at: "2026-09-11T14:37:00Z",
            last_notify_status: "DELIVERED",
          }),
          row({
            id: "al-3",
            name: "Daily spend",
            measure: "cost",
            aggregation: "sum",
            window: "1h",
            threshold: 40,
            status: "PAUSED",
          }),
        ]),
      ),
      "p1",
    );
    expect(model).toEqual({
      kind: "alert_list",
      model: {
        total: 3,
        capacity: { used: 3, max: 100 },
        href: "/projects/p1/alerts",
        rows: [
          {
            id: "al-1",
            name: "p95 latency over 2s",
            summary: "p95 latency > 2,000 ms over 10m",
            state: "evaluated 2 minutes ago",
            badge: {
              status: "ACTIVE",
              severity: "OK",
              lastError: null,
              lastEvaluatedAt: "2026-09-11T14:48:00Z",
              lastNotifyStatus: null,
              lastNotifyError: null,
            },
            href: "/projects/p1/alerts/al-1",
          },
          expect.objectContaining({
            id: "al-2",
            summary: "count ≥ 25 over 5m",
            state: "alerted 13 minutes ago · notified",
            badge: expect.objectContaining({ severity: "ALERT", lastNotifyStatus: "DELIVERED" }),
          }),
          expect.objectContaining({
            id: "al-3",
            summary: "sum cost > $40 over 1h",
            state: "paused",
            badge: expect.objectContaining({ status: "PAUSED" }),
          }),
        ],
      },
    });
  });

  it("says a parked rule stopped evaluating, ahead of its breach and its last run", () => {
    const model = readCardModel(
      readStep(
        "list_alerts",
        listDetails([
          row({
            status: "PARKED",
            severity: "ALERT",
            alerted_at: "2026-09-11T14:37:00Z",
            last_error: "this rule's settings cannot be evaluated",
          }),
        ]),
      ),
      "p1",
    );
    expect(model).toMatchObject({
      kind: "alert_list",
      model: {
        rows: [
          expect.objectContaining({
            id: "al-1",
            state: "parked · evaluation stopped",
            badge: expect.objectContaining({ status: "PARKED" }),
          }),
        ],
      },
    });
  });

  it("words a row's state honestly: never run, a failed delivery, and a rule with no whole rule", () => {
    const model = readCardModel(
      readStep(
        "list_alerts",
        listDetails([
          row({ last_evaluated_at: null }),
          row({
            id: "al-2",
            alerted_at: "2026-09-11T13:50:00Z",
            last_notify_status: "COMPENSATED",
            last_notify_error: "no-channel",
          }),
          row({ id: "al-3", threshold: null, status: "LIVE", severity: "OK" }),
        ]),
      ),
      "p1",
    );
    const rows = (
      model as { model: { rows: { state: string; summary: string | null; badge: unknown }[] } }
    ).model.rows;
    expect(rows[0]!.state).toBe("not evaluated yet");
    expect(rows[1]!.state).toBe("alerted 1 hour ago · notify compensated");
    expect(rows[2]).toMatchObject({ summary: null, badge: null });
  });

  it("says how many the read covered when the card shows fewer than the project holds", () => {
    const model = readCardModel(
      readStep("list_alerts", listDetails([row()], { total: 42, capacity: null })),
      "p1",
    );
    expect(model).toMatchObject({ model: { total: 42, capacity: null, rows: [{ id: "al-1" }] } });
  });

  it("paths nothing when the panel has no project, and drops rows without an id", () => {
    const model = readCardModel(
      readStep("list_alerts", listDetails([row(), { name: "no id" }, "junk"])),
      undefined,
    );
    expect(model).toMatchObject({ model: { href: null, rows: [{ id: "al-1", href: null }] } });
    expect((model as { model: { rows: unknown[] } }).model.rows).toHaveLength(1);
  });

  it("cards a get_alert read as the alert's own card: chart, badge, chips, facts, panel open", () => {
    const model = readCardModel(
      readStep("get_alert", {
        kind: "alert_detail",
        alert: row({
          id: "al-2",
          name: "Error rate spike",
          measure: "count",
          aggregation: "count",
          window: "5m",
          threshold_operator: ">=",
          threshold: 25,
          severity: "ALERT",
          alerted_at: "2026-09-11T14:35:00Z",
          last_notify_status: "DELIVERED",
          last_notify_at: "2026-09-11T14:35:10Z",
          filters: [{ field: "environment", op: "=", value: "production" }],
          renotify: { mode: "OFF" },
          no_data_mode: "HOLD",
          severity_changed_at: "2026-09-11T14:35:00Z",
          creator: "Kai",
          create_time: "2026-09-04T09:00:00Z",
        }),
      }),
      "p1",
    );
    expect(model).toEqual({
      kind: "alert",
      model: {
        resourceType: "alert",
        resourceId: "al-2",
        created: true,
        title: "Error rate spike",
        href: "/projects/p1/alerts/al-2",
        meta: ["Alert", "Last 24 hours"],
        description: "span count over 5 minutes is at or above 25",
        badge: {
          status: "ACTIVE",
          severity: "ALERT",
          lastError: null,
          lastEvaluatedAt: "2026-09-11T14:48:00Z",
          lastNotifyStatus: "DELIVERED",
          lastNotifyError: null,
        },
        facts: [
          // formatDate renders local time, so only the seconds (and the shape)
          // are stable across timezones — half-hour offsets shift the minutes.
          {
            label: "alerting since",
            value: expect.stringMatching(/^\d{4}-\d\d-\d\d \d\d:\d\d:00$/),
          },
          {
            label: "last evaluated",
            value: expect.stringMatching(/^\d{4}-\d\d-\d\d \d\d:\d\d:00$/),
          },
          {
            label: "notified",
            value: expect.stringMatching(/^delivered · \d{4}-\d\d-\d\d \d\d:\d\d:10$/),
          },
          { label: "created by", value: expect.stringMatching(/^Kai · \d{4}-\d\d-\d\d$/) },
        ],
        definitionOpen: true,
        body: {
          kind: "alert",
          chips: [
            "view spans",
            "count(count)",
            "over 5m",
            "≥ 25",
            "environment = production",
            "renotify off",
            "no data → HOLD",
          ],
          chart: {
            view: "SPANS",
            measure: "count",
            aggregation: "count",
            window: "5m",
            operator: ">=",
            threshold: 25,
            filters: [{ field: "environment", op: "=", value: "production" }],
            projectId: "p1",
            range: DEFAULT_DATE_FILTER,
          },
        },
      },
    });
  });

  it("lists only the facts the detail carries, and says never for a rule that has not run", () => {
    const model = readCardModel(
      readStep("get_alert", { kind: "alert_detail", alert: row({ last_evaluated_at: null }) }),
      "p1",
    );
    expect((model as { model: ResourceCardModel }).model.facts).toEqual([
      { label: "last evaluated", value: "never" },
    ]);
  });

  it("has no card for an errored, unfinished or detail-less read, or a kind it does not know", () => {
    const list = listDetails([row()]);
    expect(readCardModel(readStep("list_alerts", list, { isError: true }), "p1")).toBeNull();
    expect(readCardModel(readStep("list_alerts", list, { status: "running" }), "p1")).toBeNull();
    expect(readCardModel(readStep("list_alerts", undefined), "p1")).toBeNull();
    expect(readCardModel(readStep("list_alerts", { kind: "trace_list" }), "p1")).toBeNull();
    expect(
      readCardModel(readStep("list_alerts", { kind: "alert_list", alerts: "x" }), "p1"),
    ).toBeNull();
    expect(
      readCardModel(readStep("get_alert", { kind: "alert_detail", alert: {} }), "p1"),
    ).toBeNull();
    // A truncated persisted value is a marker, not details.
    expect(
      readCardModel(readStep("list_alerts", { truncated: true, bytes: 40000 }), "p1"),
    ).toBeNull();
  });
});

describe("dashboard preview tiles", () => {
  function widget(
    id: string,
    args: Record<string, unknown> | string,
    extra: Record<string, unknown> = { projectId: "p1" },
  ): ToolCallStep {
    return step({
      toolCallId: `tc-${id}`,
      toolName: "create_widget",
      args,
      details: created("widget", id, { dashboardId: "db1", ...extra }),
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

  function tilesOf(widgets: ToolCallStep[]): PreviewTile[] {
    const body = dashboardModel(widgets)?.body;
    if (body?.kind !== "dashboard") throw new Error("expected a dashboard body");
    return body.tiles;
  }

  const query = (id: string, title: string, display = "line") =>
    widget(id, { title, type: "query", spec: { ...WIDGET_SPEC, display: { type: display } } });
  const feed = (id: string, title: string) =>
    widget(id, { title, type: "trace_feed", spec: { filters: [], limit: 10 } });

  it("caps an oversized id standing in for a missing tile title", () => {
    const longId = "w".repeat(200);
    const tiles = tilesOf([widget(longId, { type: "query", spec: WIDGET_SPEC })]);
    expect(tiles[0].title).toBe(`${"w".repeat(64)}\u2026`);
  });

  it("places tiles exactly as the service's placement function would", () => {
    const tiles = tilesOf([query("w1", "p95"), feed("w2", "Recent"), query("w3", "Errors")]);

    // The reference layout, folded through the real placement function the
    // widget create route uses — the preview must agree with it entry by
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

  it("hands each tile its widget as the real tile body takes it: type and raw spec", () => {
    const [chart] = tilesOf([query("w1", "p95", "bar")]);
    expect(chart).toMatchObject({
      projectId: "p1",
      widget: { type: "query", spec: { ...WIDGET_SPEC, display: { type: "bar" } } },
    });
    const [list] = tilesOf([feed("w2", "Recent")]);
    expect(list).toMatchObject({
      projectId: "p1",
      widget: { type: "trace_feed", spec: { filters: [], limit: 10 } },
    });
  });

  it("leaves a spec the schema would reject to the tile body, which shows the dashboard's own message", () => {
    const odd = widget("w1", {
      title: "t",
      type: "query",
      spec: { ...WIDGET_SPEC, display: { type: "sparkline" } },
    });
    expect(tilesOf([odd])[0].widget).toEqual({
      type: "query",
      spec: { ...WIDGET_SPEC, display: { type: "sparkline" } },
    });
  });

  it("shows a widget once even when its create call was replayed", () => {
    const tiles = tilesOf([query("w1", "p95"), query("w1", "p95 again")]);
    expect(tiles).toHaveLength(1);
    expect(tiles[0]).toMatchObject({ id: "w1", title: "p95" });
  });

  it("tiles a widget whose arguments did not survive, at a chart's size with an empty spec", () => {
    expect(tilesOf([widget("w1", "…elided…")])[0]).toEqual({
      id: "w1",
      title: "w1",
      projectId: "p1",
      widget: { type: "query", spec: {} },
      range: DEFAULT_DATE_FILTER,
      x: 0,
      y: 0,
      w: 6,
      h: 4,
    });
  });

  it("skips a widget whose details name no project, keeping the tiles after it in place", () => {
    // Nothing could be queried for it. The real grid still placed it, so
    // the next widget lands where it really did — not in the skipped slot.
    const tiles = tilesOf([widget("w1", { title: "Lost" }, {}), query("w2", "p95")]);
    expect(tiles).toHaveLength(1);
    expect(tiles[0]).toMatchObject({ id: "w2", x: 6, y: 0 });
  });

  it("labels the card's window whenever a tile will query it — a feed included", () => {
    expect(dashboardModel([query("w1", "p95")])?.meta).toContain("Last 24 hours");
    expect(dashboardModel([feed("w1", "Recent")])?.meta).toContain("Last 24 hours");
    expect(dashboardModel([])?.meta).not.toContain("Last 24 hours");
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

  it("suppresses every replay of a create the preview already draws", () => {
    const suppressed = suppressedWidgetStepIds([
      entry("tc0", dashboardStep()),
      entry("tc1", widgetStep({}, "tc1")),
      entry("tc2", widgetStep({}, "tc2")),
    ]);
    expect(suppressed).toEqual(new Set(["tc1", "tc2"]));
  });

  it("keeps a widget's card when its dashboard was reused, not created", () => {
    // A reused dashboard's card has no preview, so the widget cards are the
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
      href: null,
      meta: ["Widget", "Last 24 hours"],
      body: {
        kind: "widget",
        chips: ["view spans", "sum(total_tokens)", "by model_name", "bar"],
        chart: {
          projectId: "p1",
          spec: { ...WIDGET_SPEC, filters: [] },
          range: DEFAULT_DATE_FILTER,
        },
      },
    });
  });

  it("previews no chart for a trace-feed proposal, whatever its spec parses as", () => {
    // The guard keys on the declared type, not on whether the spec happens to
    // parse: a feed handed a perfectly valid query spec still charts nothing.
    const model = pendingCardModel(
      runningStep("create_widget", { title: "Recent", type: "trace_feed", spec: WIDGET_SPEC }),
      "p1",
    );
    expect(model?.body).toMatchObject({ kind: "widget", chart: null });
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
      href: null,
      description: "Where the time goes",
      meta: ["Dashboard"],
      body: { kind: "dashboard", tiles: [] },
    });
  });

  it("builds a pending detector card with the same body a receipt gets", () => {
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
      href: null,
      meta: ["Detector", "Failure"],
      body: {
        kind: "detector",
        chips: ["sample 25%", "RCA on"],
        prompt: { kind: "standard", templateLabel: "Failure" },
      },
    });
  });

  it("shows the pending detector's own prompt on the gate card", () => {
    const model = pendingCardModel(
      runningStep("create_detector", {
        name: "Slow spans",
        template: "blank",
        prompt: "Flag traces slower than 30s.",
      }),
      "p1",
    );
    expect(model?.meta).toEqual(["Detector", "Custom"]);
    expect(model?.body).toEqual({
      kind: "detector",
      chips: [],
      prompt: { kind: "custom", text: "Flag traces slower than 30s." },
    });
  });

  it("falls back to the resource label when the args carry no name", () => {
    const model = pendingCardModel(runningStep("create_dashboard", {}), "p1");
    expect(model?.title).toBe("Dashboard");
  });

  it("returns null for a tool this panel has no pending card for", () => {
    expect(pendingCardModel(runningStep("update_dashboard_layout", {}), "p1")).toBeNull();
  });

  it("has no pending card for the structural creates, which never park in chat", () => {
    // Project and workspace creation is CLI/API surface; only their receipts
    // (resourceCardModel) ever render in the transcript.
    expect(pendingCardModel(runningStep("create_project", { name: "checkout" }), "p1")).toBeNull();
    expect(pendingCardModel(runningStep("create_workspace", {}), "p1")).toBeNull();
  });
});

describe("resource links", () => {
  it("links a widget card to the dashboard page it was placed on", () => {
    expect(resourceCardModel(widgetStep())?.href).toBe("/projects/p1/dashboard/db1");
  });

  it("links a dashboard card to its own page", () => {
    const dashboard = step({
      toolName: "create_dashboard",
      args: { name: "Latency overview" },
      details: created("dashboard", "db1", { projectId: "p1" }),
    });
    expect(resourceCardModel(dashboard)?.href).toBe("/projects/p1/dashboard/db1");
  });

  it("links a detector card to its detail page", () => {
    const detector = step({
      toolName: "create_detector",
      args: { name: "Failures", template: "failure" },
      details: created("detector", "d1", { projectId: "p1" }),
    });
    expect(resourceCardModel(detector)?.href).toBe("/projects/p1/detectors/d1");
  });

  it("gives a project or workspace receipt no link — there is no page to open", () => {
    // Even when the details name a project scope, the receipt stays a receipt.
    const project = step({
      toolName: "create_project",
      args: { name: "checkout" },
      details: created("project", "p9", { workspaceId: "ws1", projectId: "p9" }),
    });
    const workspace = step({
      toolName: "create_workspace",
      args: { name: "acme" },
      details: created("workspace", "ws1", { projectId: "p1" }),
    });
    expect(resourceCardModel(project)?.href).toBeNull();
    expect(resourceCardModel(workspace)?.href).toBeNull();
  });

  it("gives no link when the details leave out the scope the page lives under", () => {
    const noProject = step({
      toolName: "create_widget",
      args: { title: "T", type: "query", spec: WIDGET_SPEC },
      details: created("widget", "w1", { dashboardId: "db1" }),
    });
    const noDashboard = step({
      toolName: "create_widget",
      args: { title: "T", type: "query", spec: WIDGET_SPEC },
      details: created("widget", "w1", { projectId: "p1" }),
    });
    const noProjectDetector = step({
      toolName: "create_detector",
      args: { name: "Failures" },
      details: created("detector", "d1"),
    });
    expect(resourceCardModel(noProject)?.href).toBeNull();
    expect(resourceCardModel(noDashboard)?.href).toBeNull();
    expect(resourceCardModel(noProjectDetector)?.href).toBeNull();
  });

  it("never builds a link out of an id that is not a plain path segment", () => {
    const hostile = step({
      toolName: "create_detector",
      args: { name: "Failures" },
      details: created("detector", "d1/../../admin", { projectId: "p1" }),
    });
    expect(resourceCardModel(hostile)?.href).toBeNull();
  });
});

describe("pendingProposal", () => {
  const parked = (toolName: string, args: Record<string, unknown>): ToolCallStep => ({
    toolCallId: "tc1",
    toolName,
    args,
    status: "running",
    pending: { decisionId: "d1" },
  });

  it("leaves the title null when the args name nothing — the caller picks the fallback", () => {
    expect(pendingProposal(parked("create_dashboard", {}))).toEqual({
      resourceType: "dashboard",
      title: null,
    });
  });

  it("names the resource a parked create would make, and its title", () => {
    expect(pendingProposal(parked("create_widget", { title: "Tokens by model" }))).toEqual({
      resourceType: "widget",
      title: "Tokens by model",
    });
    expect(pendingProposal(parked("create_dashboard", { name: "Latency overview" }))).toEqual({
      resourceType: "dashboard",
      title: "Latency overview",
    });
    expect(pendingProposal(parked("create_detector", { name: "Slow spans" }))).toEqual({
      resourceType: "detector",
      title: "Slow spans",
    });
  });

  it("treats a non-string name as no name", () => {
    expect(pendingProposal(parked("create_detector", { name: { oops: 1 } }))?.title).toBeNull();
  });

  it("is null for a tool that has no pending card", () => {
    expect(pendingProposal(parked("update_dashboard_layout", {}))).toBeNull();
    expect(pendingProposal(parked("create_project", { name: "checkout" }))).toBeNull();
  });
});

describe("meta window label follows the site's stored range", () => {
  // Node environment — no real window. A stubbed one with the site's storage
  // slot populated stands in for a browser where the user picked "Last 7 days"
  // on the trace list or a dashboard page.
  const stubStoredRange = (projectId: string, id: string) =>
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) =>
          key === dateFilterStorageKey(projectId) ? JSON.stringify({ id }) : null,
      },
    });

  afterEach(() => vi.unstubAllGlobals());

  it("labels a widget receipt with the stored range, not the default", () => {
    stubStoredRange("p1", "7d");
    expect(resourceCardModel(widgetStep())?.meta).toEqual(["Widget", "Last 7 days"]);
  });

  it("labels a dashboard preview with the stored range of its tiles' project", () => {
    stubStoredRange("p1", "7d");
    const dashboard = step({
      toolName: "create_dashboard",
      args: { name: "Latency overview" },
      details: created("dashboard", "db1", { projectId: "p1" }),
    });
    const model = resourceCardModel(dashboard, new Map([["db1", [widgetStep()]]]));
    expect(model?.meta).toEqual(["Dashboard", "1 widget", "Last 7 days"]);
  });

  it("labels a pending widget card with the stored range of the panel's project", () => {
    stubStoredRange("p1", "7d");
    const pending = pendingCardModel(
      {
        toolCallId: "tcp1",
        toolName: "create_widget",
        args: { title: "Tokens by model", type: "query", spec: WIDGET_SPEC },
        status: "running",
      },
      "p1",
    );
    expect(pending?.meta).toEqual(["Widget", "Last 7 days"]);
  });

  it("snapshots one range for the label and the chart the preview will draw", () => {
    // The label is built now; the plot freezes its window when the card first
    // scrolls into view. Both must read the SAME snapshot, or a range changed
    // in between leaves the card labeled one window and plotted with another.
    stubStoredRange("p1", "7d");
    const model = resourceCardModel(widgetStep());
    expect(model?.meta).toEqual(["Widget", "Last 7 days"]);
    expect((model?.body as { chart: { range: unknown } }).chart.range).toEqual(preset("7d"));
  });

  it("clamps a stored range past the plan's retention in both the label and the chart", () => {
    stubStoredRange("p1", "90d");
    const model = resourceCardModel(widgetStep(), undefined, 30);
    expect(model?.meta).toEqual(["Widget", "Last 30 days"]);
    expect((model?.body as { chart: { range: unknown } }).chart.range).toEqual(preset("30d"));
  });

  it("clamps a pending card's range the same way", () => {
    stubStoredRange("p1", "90d");
    const pending = pendingCardModel(
      {
        toolCallId: "tcp1",
        toolName: "create_widget",
        args: { title: "Tokens by model", type: "query", spec: WIDGET_SPEC },
        status: "running",
      },
      "p1",
      30,
    );
    expect(pending?.meta).toEqual(["Widget", "Last 30 days"]);
    expect((pending?.body as { chart: { range: unknown } }).chart.range).toEqual(preset("30d"));
  });

  it("keeps the default label for an unknown stored id", () => {
    stubStoredRange("p1", "eleventy");
    expect(resourceCardModel(widgetStep())?.meta).toEqual(["Widget", "Last 24 hours"]);
  });
});
