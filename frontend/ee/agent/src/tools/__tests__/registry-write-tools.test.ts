import { describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "@traceroot-ai/tools";
import { createRegistryWriteTools } from "../registry-write-tools.js";

function stubClient(response: unknown = {}) {
  const request = vi.fn(async () => response);
  return { client: { request } as unknown as ApiClient, request };
}

function makeTools(client: ApiClient) {
  return createRegistryWriteTools({
    client,
    actorUserId: "u1",
    agentSessionId: "as1",
    projectId: "p1",
    workspaceId: "w1",
  });
}

describe("createRegistryWriteTools", () => {
  it("exposes exactly the five internally-bound write tools", () => {
    const names = makeTools(stubClient().client).map((t) => t.name);
    expect(names).toEqual([
      "create_workspace",
      "create_project",
      "create_detector",
      "create_dashboard",
      "create_widget",
    ]);
  });

  it("create_detector hides the ambient project_id but keeps the model-supplied fields", () => {
    const tool = makeTools(stubClient().client).find((t) => t.name === "create_detector")!;
    expect(tool.parameters.properties).not.toHaveProperty("project_id");
    expect(tool.parameters.required).not.toContain("project_id");
    for (const field of ["name", "template", "prompt", "sample_rate", "output_schema"]) {
      expect(tool.parameters.properties).toHaveProperty(field);
    }
    // Same injected-label convention as the read tools.
    expect(tool.parameters.properties.label).toMatchObject({ type: "string" });
    expect(tool.parameters.required[0]).toBe("label");
  });

  it("create_project hides the ambient workspace_id from the model-facing schema", () => {
    const tool = makeTools(stubClient().client).find((t) => t.name === "create_project")!;
    expect(tool.parameters.properties).not.toHaveProperty("workspace_id");
    expect(tool.parameters.required).not.toContain("workspace_id");
  });

  it("create_project hides the registry's agent-hidden trace_ttl_days from the model", () => {
    const tool = makeTools(stubClient().client).find((t) => t.name === "create_project")!;
    expect(tool.parameters.properties).not.toHaveProperty("trace_ttl_days");
    expect(tool.parameters.required).not.toContain("trace_ttl_days");
    expect(Object.keys(tool.parameters.properties)).toEqual(["label", "name"]);
  });

  it("drops a model-supplied agent-hidden field instead of translating it to the body", async () => {
    const { client, request } = stubClient({
      created: true,
      project: { id: "p2", name: "api", workspaceId: "w1" },
    });
    const tool = makeTools(client).find((t) => t.name === "create_project")!;
    await tool.execute("id", { label: "x", name: "api", trace_ttl_days: 30 });
    expect(request).toHaveBeenCalledWith("post", "/api/internal/write/projects", {
      body: {
        actorUserId: "u1",
        transport: "agent",
        agentSessionId: "as1",
        workspaceId: "w1",
        name: "api",
      },
      signal: undefined,
    });
  });

  it("leaves tools without agent-hidden params untouched", () => {
    const tool = makeTools(stubClient().client).find((t) => t.name === "create_detector")!;
    expect(Object.keys(tool.parameters.properties).sort()).toEqual(
      [
        "detection_model",
        "detection_provider",
        "detection_source",
        "enable_rca",
        "enabled",
        "label",
        "name",
        "prompt",
        "output_schema",
        "sample_rate",
        "template",
        "trigger_conditions",
      ].sort(),
    );
  });

  it("create_detector POSTs the exact camelCase body with actor and provenance injected", async () => {
    const { client, request } = stubClient({
      created: true,
      detector: { id: "d1", name: "latency", projectId: "p1", enabled: true, sampleRate: 25 },
    });
    const tool = makeTools(client).find((t) => t.name === "create_detector")!;
    const result = await tool.execute("id", {
      label: "x",
      name: "latency",
      template: "custom",
      prompt: "Flag slow traces",
      sample_rate: 25,
      output_schema: [{ name: "reason", type: "string" }],
      trigger_conditions: [{ field: "root_span_finished", op: "=", value: true }],
      detection_source: "system",
      detection_model: "claude-haiku-4-5",
      detection_provider: "anthropic",
      enable_rca: true,
      enabled: true,
    });
    expect(request).toHaveBeenCalledWith("post", "/api/internal/write/detectors", {
      body: {
        actorUserId: "u1",
        transport: "agent",
        agentSessionId: "as1",
        projectId: "p1",
        name: "latency",
        template: "custom",
        prompt: "Flag slow traces",
        sampleRate: 25,
        outputSchema: [{ name: "reason", type: "string" }],
        triggerConditions: [{ field: "root_span_finished", op: "=", value: true }],
        detectionSource: "system",
        detectionModel: "claude-haiku-4-5",
        detectionProvider: "anthropic",
        enableRca: true,
        enabled: true,
      },
      signal: undefined,
    });
    expect(result.content[0]!.text).toBe('Created detector "latency" (id d1)');
    expect(result.details).toEqual({
      kind: "resource_created",
      resourceType: "detector",
      resourceId: "d1",
      created: true,
      projectId: "p1",
    });
  });

  it("create_workspace injects only actor and provenance and hides nothing but label", async () => {
    const { client, request } = stubClient({
      created: true,
      workspace: { id: "w9", name: "Analytics", role: "ADMIN" },
    });
    const tool = makeTools(client).find((t) => t.name === "create_workspace")!;
    expect(Object.keys(tool.parameters.properties)).toEqual(["label", "name"]);
    expect(tool.parameters.required).toEqual(["label", "name"]);
    const result = await tool.execute("id", { label: "x", name: "Analytics" });
    expect(request).toHaveBeenCalledWith("post", "/api/internal/write/workspaces", {
      body: {
        actorUserId: "u1",
        transport: "agent",
        agentSessionId: "as1",
        name: "Analytics",
      },
      signal: undefined,
    });
    expect(result.content[0]!.text).toBe('Created workspace "Analytics" (id w9)');
    expect(result.details).toEqual({
      kind: "resource_created",
      resourceType: "workspace",
      resourceId: "w9",
      created: true,
    });
  });

  it("create_widget maps dashboard_id and display_config and names the widget by title", async () => {
    const { client, request } = stubClient({
      created: true,
      widget: { id: "wg1", dashboardId: "db1", title: "Spend by model", type: "query" },
    });
    const tool = makeTools(client).find((t) => t.name === "create_widget")!;
    const result = await tool.execute("id", {
      label: "x",
      dashboard_id: "db1",
      title: "Spend by model",
      type: "query",
      spec: { metric: "cost" },
      display_config: { color: "blue" },
    });
    expect(request).toHaveBeenCalledWith("post", "/api/internal/write/widgets", {
      body: {
        actorUserId: "u1",
        transport: "agent",
        agentSessionId: "as1",
        projectId: "p1",
        dashboardId: "db1",
        title: "Spend by model",
        type: "query",
        spec: { metric: "cost" },
        displayConfig: { color: "blue" },
      },
      signal: undefined,
    });
    expect(result.content[0]!.text).toBe('Created widget "Spend by model" (id wg1)');
    expect(result.details).toEqual({
      kind: "resource_created",
      resourceType: "widget",
      resourceId: "wg1",
      created: true,
      projectId: "p1",
      dashboardId: "db1",
    });
  });

  it("reports an idempotent created:false result as already existing", async () => {
    const { client } = stubClient({
      created: false,
      detector: { id: "d1", name: "latency", projectId: "p1", enabled: true, sampleRate: 25 },
    });
    const tool = makeTools(client).find((t) => t.name === "create_detector")!;
    const result = await tool.execute("id", {
      label: "x",
      name: "latency",
      template: "custom",
      prompt: "p",
    });
    expect(result.content[0]!.text).toBe('Detector "latency" already exists (id d1) — reusing it');
    expect(result.details).toEqual({
      kind: "resource_created",
      resourceType: "detector",
      resourceId: "d1",
      created: false,
      projectId: "p1",
    });
  });

  it("returns the internal route's {error} message as tool text instead of throwing", async () => {
    const request = vi.fn(async () => {
      throw new ApiError(403, JSON.stringify({ error: "Requires MEMBER role or higher" }));
    });
    const tool = makeTools({ request } as unknown as ApiClient).find(
      (t) => t.name === "create_detector",
    )!;
    const result = await tool.execute("id", {
      label: "x",
      name: "latency",
      template: "custom",
      prompt: "p",
    });
    expect(result.content[0]!.text).toBe(
      "Error calling create_detector: API error 403: Requires MEMBER role or higher",
    );
    expect(result.details).toBeUndefined();
  });

  it("returns thrown fetch errors as tool text instead of throwing", async () => {
    const request = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const tool = makeTools({ request } as unknown as ApiClient).find(
      (t) => t.name === "create_workspace",
    )!;
    const result = await tool.execute("id", { label: "x", name: "Analytics" });
    expect(result.content[0]!.text).toBe("Error calling create_workspace: fetch failed");
    expect(result.details).toBeUndefined();
  });

  it("leaves unset optional args out of the body entirely", async () => {
    const { client, request } = stubClient({
      created: true,
      project: { id: "p2", name: "api", workspaceId: "w1" },
    });
    const tool = makeTools(client).find((t) => t.name === "create_project")!;
    const result = await tool.execute("id", {
      label: "x",
      name: "api",
      trace_ttl_days: undefined,
    });
    expect(request).toHaveBeenCalledWith("post", "/api/internal/write/projects", {
      body: {
        actorUserId: "u1",
        transport: "agent",
        agentSessionId: "as1",
        workspaceId: "w1",
        name: "api",
      },
      signal: undefined,
    });
    expect(result.content[0]!.text).toBe('Created project "api" (id p2)');
    expect(result.details).toEqual({
      kind: "resource_created",
      resourceType: "project",
      resourceId: "p2",
      created: true,
      workspaceId: "w1",
    });
  });

  it("stamps dashboard results with the ambient projectId for navigation", async () => {
    const { client } = stubClient({
      created: true,
      dashboard: { id: "db1", name: "Spend", projectId: "p1" },
    });
    const tool = makeTools(client).find((t) => t.name === "create_dashboard")!;
    const result = await tool.execute("id", { label: "x", name: "Spend" });
    expect(result.details).toEqual({
      kind: "resource_created",
      resourceType: "dashboard",
      resourceId: "db1",
      created: true,
      projectId: "p1",
    });
  });

  it("carries no details when the success payload has an unexpected shape", async () => {
    const { client } = stubClient({ ok: true });
    const tool = makeTools(client).find((t) => t.name === "create_dashboard")!;
    const result = await tool.execute("id", { label: "x", name: "Spend" });
    expect(result.content[0]!.text).toBe(JSON.stringify({ ok: true }, null, 2));
    expect(result.details).toBeUndefined();
  });

  it("drops explicit nulls the way the public route drops unset optionals", async () => {
    const { client, request } = stubClient({
      created: true,
      dashboard: { id: "db1", name: "Spend", projectId: "p1" },
    });
    const tool = makeTools(client).find((t) => t.name === "create_dashboard")!;
    await tool.execute("id", { label: "x", name: "Spend", description: null });
    expect(request).toHaveBeenCalledWith("post", "/api/internal/write/dashboards", {
      body: {
        actorUserId: "u1",
        transport: "agent",
        agentSessionId: "as1",
        projectId: "p1",
        name: "Spend",
      },
      signal: undefined,
    });
  });
});

describe("createRegistryWriteTools construction", () => {
  it("throws at construction when the registry lacks one of the five write entries", async () => {
    vi.resetModules();
    vi.doMock("@traceroot-ai/tools", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@traceroot-ai/tools")>();
      return {
        ...actual,
        REGISTRY: actual.REGISTRY.filter((e) => e.name !== "create_widget"),
      };
    });
    const { createRegistryWriteTools: create } = await import("../registry-write-tools.js");
    expect(() =>
      create({
        client: {} as ApiClient,
        actorUserId: "u1",
        agentSessionId: "as1",
        projectId: "p1",
        workspaceId: "w1",
      }),
    ).toThrow("registry entry missing: create_widget");
    vi.doUnmock("@traceroot-ai/tools");
    vi.resetModules();
  });

  it("throws at construction when a write entry lacks policy", async () => {
    vi.resetModules();
    vi.doMock("@traceroot-ai/tools", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@traceroot-ai/tools")>();
      return {
        ...actual,
        REGISTRY: actual.REGISTRY.map((e) =>
          e.name === "create_detector" ? { ...e, policy: undefined } : e,
        ),
      };
    });
    const { createRegistryWriteTools: create } = await import("../registry-write-tools.js");
    expect(() =>
      create({
        client: {} as ApiClient,
        actorUserId: "u1",
        agentSessionId: "as1",
        projectId: "p1",
        workspaceId: "w1",
      }),
    ).toThrow("registry entry missing policy: create_detector");
    vi.doUnmock("@traceroot-ai/tools");
    vi.resetModules();
  });

  it("throws at construction when the registry carries a field the body map does not", async () => {
    vi.resetModules();
    vi.doMock("@traceroot-ai/tools", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@traceroot-ai/tools")>();
      return {
        ...actual,
        REGISTRY: actual.REGISTRY.map((e) =>
          e.name === "create_workspace"
            ? {
                ...e,
                inputSchema: {
                  ...e.inputSchema,
                  properties: { ...e.inputSchema.properties, color: { type: "string" } },
                },
              }
            : e,
        ),
      };
    });
    const { createRegistryWriteTools: create } = await import("../registry-write-tools.js");
    expect(() =>
      create({
        client: {} as ApiClient,
        actorUserId: "u1",
        agentSessionId: "as1",
        projectId: "p1",
        workspaceId: "w1",
      }),
    ).toThrow("create_workspace: unmapped registry field: color");
    vi.doUnmock("@traceroot-ai/tools");
    vi.resetModules();
  });
});
