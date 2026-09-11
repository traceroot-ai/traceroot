import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "../client.js";
import { INTERNAL_BINDINGS } from "../internal.js";
import { toPiAgentTool } from "../pi.js";
import type { RegistryEntry } from "../types.js";

function fakeFetch(status: number, body: unknown) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
}

const listTracesEntry: RegistryEntry = {
  name: "list_traces",
  description: "List traces.",
  method: "get",
  path: "/api/v1/public/traces",
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "integer", description: "Items per page" },
      filters: {
        type: "array",
        items: { anyOf: [{ type: "object" }] },
        description: "Typed filter predicates",
      },
    },
    required: [],
    additionalProperties: false,
  },
};

describe("toPiAgentTool", () => {
  const createProjectEntry: RegistryEntry = {
    name: "create_project",
    description: "Create a project.",
    method: "post",
    path: "/api/v1/public/projects",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: { type: "string" },
        name: { type: "string" },
        trace_ttl_days: { type: "integer" },
      },
      required: ["workspace_id", "name", "trace_ttl_days"],
      additionalProperties: false,
    },
    bodyParams: ["workspace_id", "name", "trace_ttl_days"],
    agentHiddenParams: ["trace_ttl_days"],
    policy: { approvalClass: "none", minRole: "MEMBER", tenancy: "workspace" },
  };

  it("hides agentHiddenParams from the model's schema", () => {
    const client = new ApiClient({
      baseUrl: "http://x",
      headers: {},
      fetchImpl: fakeFetch(200, {}),
    });
    const tool = toPiAgentTool(createProjectEntry, { client });
    expect(Object.keys(tool.parameters.properties)).not.toContain("trace_ttl_days");
    expect(tool.parameters.properties).toHaveProperty("name");
    expect(tool.parameters.required).not.toContain("trace_ttl_days");
    expect(tool.parameters.required).toContain("workspace_id");
  });

  it("drops an agentHiddenParam the model supplied anyway", async () => {
    const fetchImpl = fakeFetch(200, { id: "p1" });
    const client = new ApiClient({ baseUrl: "http://x", headers: {}, fetchImpl });
    const tool = toPiAgentTool(createProjectEntry, { client });
    await tool.execute("call-1", {
      label: "make it",
      workspace_id: "w1",
      name: "P1",
      trace_ttl_days: 365,
    });
    const [, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ workspace_id: "w1", name: "P1" });
  });

  it("injects a required label param and strips it before dispatch", async () => {
    const fetchImpl = fakeFetch(200, { data: [] });
    const client = new ApiClient({ baseUrl: "http://x", headers: {}, fetchImpl });
    const tool = toPiAgentTool(listTracesEntry, { client });

    expect(tool.name).toBe("list_traces");
    expect(tool.description).toBe("List traces.");
    expect(tool.parameters.properties).toHaveProperty("label");
    expect(tool.parameters.required).toContain("label");

    await tool.execute("call-1", { label: "Searching traces", limit: 3 });
    const [url] = fetchImpl.mock.calls[0]!;
    const parsed = new URL(String(url));
    expect(parsed.searchParams.get("limit")).toBe("3");
    expect(parsed.searchParams.has("label")).toBe(false);
  });

  it("passes structured param schemas through unchanged for the model", () => {
    const client = new ApiClient({
      baseUrl: "http://x",
      headers: {},
      fetchImpl: fakeFetch(200, {}),
    });
    const tool = toPiAgentTool(listTracesEntry, { client });
    expect(tool.parameters.properties.filters).toEqual(
      listTracesEntry.inputSchema.properties.filters,
    );
  });

  it("hides fixedArgs from the model schema but sends them, honoring pathOverride", async () => {
    const fetchImpl = fakeFetch(200, { data: [] });
    const client = new ApiClient({ baseUrl: "http://x", headers: {}, fetchImpl });
    const tool = toPiAgentTool(listTracesEntry, {
      client,
      pathOverride: "/api/v1/projects/{project_id}/traces",
      fixedArgs: { project_id: "p9", limit: 10 },
    });

    expect(tool.parameters.properties).not.toHaveProperty("project_id");
    expect(tool.parameters.properties).not.toHaveProperty("limit");

    await tool.execute("call-1", { label: "Searching" });
    const [url] = fetchImpl.mock.calls[0]!;
    const parsed = new URL(String(url));
    expect(parsed.pathname).toBe("/api/v1/projects/p9/traces");
    expect(parsed.searchParams.get("limit")).toBe("10");
  });

  it("formats results with formatResult, defaulting to pretty JSON", async () => {
    const client = new ApiClient({
      baseUrl: "http://x",
      headers: {},
      fetchImpl: fakeFetch(200, { data: [{ trace_id: "t1" }] }),
    });
    const formatted = toPiAgentTool(listTracesEntry, {
      client,
      formatResult: (result) => `rows: ${(result as { data: unknown[] }).data.length}`,
    });
    const formattedResult = await formatted.execute("call-1", { label: "x" });
    expect(formattedResult).toEqual({
      content: [{ type: "text", text: "rows: 1" }],
      details: undefined,
    });

    const plain = toPiAgentTool(listTracesEntry, {
      client: new ApiClient({
        baseUrl: "http://x",
        headers: {},
        fetchImpl: fakeFetch(200, { data: [] }),
      }),
    });
    const plainResult = await plain.execute("call-1", { label: "x" });
    expect(plainResult.content[0]!.text).toBe(JSON.stringify({ data: [] }, null, 2));
  });

  it("renders errors as text instead of throwing", async () => {
    const client = new ApiClient({
      baseUrl: "http://x",
      headers: {},
      fetchImpl: fakeFetch(403, { detail: "Forbidden" }),
    });
    const tool = toPiAgentTool(listTracesEntry, { client });
    const result = await tool.execute("call-1", { label: "x" });
    expect(result.details).toBeUndefined();
    expect(result.content[0]!.text).toContain("list_traces");
    expect(result.content[0]!.text).toContain("Forbidden");
  });
});

describe("INTERNAL_BINDINGS", () => {
  it("covers exactly the agent's current read set with project-scoped templates", () => {
    expect(INTERNAL_BINDINGS).toEqual({
      list_traces: "/api/v1/projects/{project_id}/traces",
      list_sessions: "/api/v1/projects/{project_id}/sessions",
      get_session: "/api/v1/projects/{project_id}/sessions/{session_id}",
      list_detectors: "/api/v1/projects/{project_id}/detectors",
      get_detector: "/api/v1/projects/{project_id}/detectors/{detector_id}",
      list_findings: "/api/v1/projects/{project_id}/detectors/findings",
      get_finding: "/api/v1/projects/{project_id}/detectors/findings/{finding_id}",
      get_finding_by_trace: "/api/v1/projects/{project_id}/detectors/traces/{trace_id}/finding",
      list_dashboards: "/api/v1/internal/projects/{project_id}/dashboards",
      get_dashboard: "/api/v1/internal/projects/{project_id}/dashboards/{dashboard_id}",
    });
  });
});
