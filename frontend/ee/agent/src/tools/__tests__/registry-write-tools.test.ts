import { describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError, REGISTRY } from "@traceroot-ai/tools";
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
  it("exposes exactly the three project-scoped write tools — no structural creates", () => {
    const names = makeTools(stubClient().client).map((t) => t.name);
    expect(names).toEqual(["create_detector", "create_dashboard", "create_widget"]);
  });

  it("keeps all five write tools in the registry — the agent trim must not leak into codegen", () => {
    const registryWrites = REGISTRY.filter((e) => e.name.startsWith("create_")).map((e) => e.name);
    expect(registryWrites.sort()).toEqual([
      "create_dashboard",
      "create_detector",
      "create_project",
      "create_widget",
      "create_workspace",
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

  it("create_detector does not require prompt and leaves an unset prompt out of the body", async () => {
    const { client, request } = stubClient({
      created: true,
      detector: { id: "d1", name: "latency", projectId: "p1", enabled: true, sampleRate: 25 },
    });
    const tool = makeTools(client).find((t) => t.name === "create_detector")!;
    expect(tool.parameters.required).toEqual(["label", "name", "template"]);
    await tool.execute("id", { label: "x", name: "latency", template: "failure" });
    expect(request).toHaveBeenCalledWith("post", "/api/internal/write/detectors", {
      body: {
        actorUserId: "u1",
        transport: "agent",
        agentSessionId: "as1",
        projectId: "p1",
        name: "latency",
        template: "failure",
      },
      signal: undefined,
    });
  });

  it("hides a registry-curated agent-hidden field from the model and drops it from the body", async () => {
    vi.resetModules();
    vi.doMock("@traceroot-ai/tools", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@traceroot-ai/tools")>();
      return {
        ...actual,
        REGISTRY: actual.REGISTRY.map((e) =>
          e.name === "create_dashboard" ? { ...e, agentHiddenParams: ["description"] } : e,
        ),
      };
    });
    const { createRegistryWriteTools: create } = await import("../registry-write-tools.js");
    const { client, request } = stubClient({
      created: true,
      dashboard: { id: "db1", name: "Spend", projectId: "p1" },
    });
    const tool = create({
      client,
      actorUserId: "u1",
      agentSessionId: "as1",
      projectId: "p1",
      workspaceId: "w1",
    }).find((t) => t.name === "create_dashboard")!;
    expect(tool.parameters.properties).not.toHaveProperty("description");
    expect(tool.parameters.required).not.toContain("description");
    // A hidden field the model passes anyway must never reach the body.
    await tool.execute("id", { label: "x", name: "Spend", description: "sneaky" });
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
    vi.doUnmock("@traceroot-ai/tools");
    vi.resetModules();
  });

  it("create_widget's model-visible spec schema carries per-view query dialects plus the feed", () => {
    const tool = makeTools(stubClient().client).find((t) => t.name === "create_widget")!;
    interface VariantSchema {
      properties: Record<
        string,
        {
          const?: string;
          enum?: (string | null)[];
          properties?: Record<string, { enum?: string[] }>;
        }
      >;
      required?: string[];
    }
    const spec = tool.parameters.properties.spec as { type?: string; anyOf?: VariantSchema[] };
    // The union of object dialects keeps an explicit type for providers that
    // reject untyped properties, plus one query variant per registry view and
    // the trace_feed variant for the model to compose.
    expect(spec.type).toBe("object");
    expect(spec.anyOf).toHaveLength(3);
    const queryVariants = spec.anyOf!.filter((variant) => "view" in variant.properties);
    const measures = (variant: VariantSchema) =>
      variant.properties.metric!.properties!.measure!.enum;
    expect(queryVariants.map((v) => v.properties.view!.const).sort()).toEqual(["spans", "traces"]);
    for (const query of queryVariants) {
      expect(Object.keys(query.properties).sort()).toEqual([
        "breakdown",
        "display",
        "filters",
        "metric",
        "view",
      ]);
      expect(query.required).toEqual(["view", "metric", "display"]);
      // The field vocabulary is enumerated per view, straight from the widget
      // field registry, so the model cannot invent measures or breakdowns.
      expect(measures(query)).toContain("cost");
      expect(query.properties.breakdown!.enum).toContain("environment");
    }
    const [spansQuery, tracesQuery] = [...queryVariants].sort((a, b) =>
      a.properties.view!.const!.localeCompare(b.properties.view!.const!),
    );
    expect(measures(tracesQuery)).toContain("error_count");
    expect(measures(spansQuery)).not.toContain("error_count");
    const feed = spec.anyOf!.find((variant) => "limit" in variant.properties)!;
    expect(Object.keys(feed.properties).sort()).toEqual(["filters", "limit"]);
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
      (t) => t.name === "create_dashboard",
    )!;
    const result = await tool.execute("id", { label: "x", name: "Spend" });
    expect(result.content[0]!.text).toBe("Error calling create_dashboard: fetch failed");
    expect(result.details).toBeUndefined();
  });

  it("leaves unset optional args out of the body entirely", async () => {
    const { client, request } = stubClient({
      created: true,
      dashboard: { id: "db1", name: "Spend", projectId: "p1" },
    });
    const tool = makeTools(client).find((t) => t.name === "create_dashboard")!;
    const result = await tool.execute("id", {
      label: "x",
      name: "Spend",
      description: undefined,
    });
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
    expect(result.content[0]!.text).toBe('Created dashboard "Spend" (id db1)');
    expect(result.details).toEqual({
      kind: "resource_created",
      resourceType: "dashboard",
      resourceId: "db1",
      created: true,
      projectId: "p1",
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
  it("throws at construction when the registry lacks one of the three write entries", async () => {
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
          e.name === "create_dashboard"
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
    ).toThrow("create_dashboard: unmapped registry field: color");
    vi.doUnmock("@traceroot-ai/tools");
    vi.resetModules();
  });
});
