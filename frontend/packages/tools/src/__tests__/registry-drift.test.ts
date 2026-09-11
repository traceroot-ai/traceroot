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
      "create_dashboard",
      "create_detector",
      "create_project",
      "create_widget",
      "create_workspace",
      "export_trace",
      "get_dashboard",
      "get_detector",
      "get_finding",
      "get_finding_by_trace",
      "get_session",
      "get_trace",
      "list_dashboards",
      "list_detectors",
      "list_findings",
      "list_projects",
      "list_sessions",
      "list_trace_filter_values",
      "list_traces",
      "list_workspaces",
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
});
