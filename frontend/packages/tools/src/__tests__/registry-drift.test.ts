import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// Imported through the package entry point so the public surface is exercised.
import { generateRegistry, REGISTRY, type OpenApiDocument } from "../index.js";

const schemaPath = fileURLToPath(
  new URL("../../../../../backend/rest/openapi/public.json", import.meta.url),
);

describe("committed registry", () => {
  it("matches a fresh generation from the committed public schema (no drift)", () => {
    const doc = JSON.parse(readFileSync(schemaPath, "utf8")) as OpenApiDocument;
    expect(REGISTRY).toEqual(generateRegistry(doc));
  });

  it("pins the curated tool surface", () => {
    expect(REGISTRY.map((entry) => entry.name)).toEqual([
      "create_alert",
      "create_dashboard",
      "create_detector",
      "create_project",
      "create_widget",
      "create_workspace",
      "export_trace",
      "get_alert",
      "get_dashboard",
      "get_dashboard_data",
      "get_detector",
      "get_finding",
      "get_finding_by_trace",
      "get_session",
      "get_sql_schema",
      "get_trace",
      "get_widget",
      "get_widget_data",
      "list_alerts",
      "list_dashboards",
      "list_detectors",
      "list_findings",
      "list_projects",
      "list_sessions",
      "list_trace_filter_values",
      "list_traces",
      "list_workspaces",
      "run_sql",
      "run_widget_query",
      "whoami",
    ]);
  });

  it("generates the dashboard reads as pure GET tools", () => {
    const list = REGISTRY.find((entry) => entry.name === "list_dashboards")!;
    expect(list.method).toBe("get");
    expect(list.path).toBe("/api/v1/public/dashboards");
    expect(list.bodyParams).toBeUndefined();
    expect(list.policy).toBeUndefined();
    // The only parameter is the dual-credential project scope, optional so an
    // API key (which fixes its own project) can omit it.
    expect(Object.keys(list.inputSchema.properties)).toEqual(["project_id"]);
    expect(list.inputSchema.required).toEqual([]);

    const get = REGISTRY.find((entry) => entry.name === "get_dashboard")!;
    expect(get.method).toBe("get");
    expect(get.path).toBe("/api/v1/public/dashboards/{dashboard_id}");
    expect(get.bodyParams).toBeUndefined();
    expect(get.policy).toBeUndefined();
    expect(Object.keys(get.inputSchema.properties).sort()).toEqual(["dashboard_id", "project_id"]);
    expect(get.inputSchema.required).toEqual(["dashboard_id"]);
  });

  it("generates the widget reads as pure GET tools with the window params on the data read", () => {
    const get = REGISTRY.find((entry) => entry.name === "get_widget")!;
    expect(get.method).toBe("get");
    expect(get.path).toBe("/api/v1/public/widgets/{widget_id}");
    expect(get.bodyParams).toBeUndefined();
    expect(get.policy).toBeUndefined();
    expect(Object.keys(get.inputSchema.properties).sort()).toEqual(["project_id", "widget_id"]);
    expect(get.inputSchema.required).toEqual(["widget_id"]);

    const data = REGISTRY.find((entry) => entry.name === "get_widget_data")!;
    expect(data.method).toBe("get");
    expect(data.path).toBe("/api/v1/public/widgets/{widget_id}/data");
    expect(data.bodyParams).toBeUndefined();
    expect(data.policy).toBeUndefined();
    expect(Object.keys(data.inputSchema.properties).sort()).toEqual([
      "end_time",
      "project_id",
      "range",
      "start_time",
      "widget_id",
    ]);
    expect(data.inputSchema.required).toEqual(["widget_id"]);
    // The same window description run_widget_query takes, so the agent's
    // page-window default applies to it unchanged.
    const range = (data.inputSchema.properties as Record<string, { enum?: unknown[] }>).range!;
    expect(range.enum).toContain("7d");
  });

  it("generates the alert create with the stable enums and a full policy", () => {
    const create = REGISTRY.find((entry) => entry.name === "create_alert")!;
    expect(create.method).toBe("post");
    expect(create.path).toBe("/api/v1/public/alerts");
    expect(create.policy).toEqual({
      approvalClass: "confirm",
      minRole: "MEMBER",
      tenancy: "project",
    });
    expect(create.bodyParams).toEqual([
      "aggregation",
      "filters",
      "measure",
      "name",
      "no_data_mode",
      "project_id",
      "renotify",
      "threshold",
      "threshold_operator",
      "view",
      "window",
    ]);
    expect(create.inputSchema.required).toEqual([
      "project_id",
      "name",
      "view",
      "measure",
      "aggregation",
      "window",
      "threshold_operator",
      "threshold",
      "renotify",
    ]);
    const props = create.inputSchema.properties as Record<string, { enum?: unknown[] }>;
    expect(props.window!.enum).toEqual(["1m", "5m", "10m", "30m", "1h", "2h"]);
    expect(props.threshold_operator!.enum).toEqual([">", ">=", "<", "<=", "=", "!="]);
    expect(props.no_data_mode!.enum).toEqual(["HOLD", "ZERO", "NOTIFY"]);
  });

  it("generates the alert reads as pure GET tools with the paging params", () => {
    const list = REGISTRY.find((entry) => entry.name === "list_alerts")!;
    expect(list.method).toBe("get");
    expect(list.path).toBe("/api/v1/public/alerts");
    expect(list.bodyParams).toBeUndefined();
    expect(list.policy).toBeUndefined();
    expect(Object.keys(list.inputSchema.properties).sort()).toEqual([
      "limit",
      "page",
      "project_id",
      "search_query",
    ]);
    expect(list.inputSchema.required).toEqual([]);

    const get = REGISTRY.find((entry) => entry.name === "get_alert")!;
    expect(get.method).toBe("get");
    expect(get.path).toBe("/api/v1/public/alerts/{alert_id}");
    expect(get.bodyParams).toBeUndefined();
    expect(get.policy).toBeUndefined();
    expect(Object.keys(get.inputSchema.properties).sort()).toEqual(["alert_id", "project_id"]);
    expect(get.inputSchema.required).toEqual(["alert_id"]);
  });
});
