import { describe, expect, it } from "vitest";
import { generateRegistry, type OpenApiDocument } from "../generate.js";

/** Minimal fake of the public OpenAPI document, in the shapes FastAPI emits. */
function fakeDoc(): OpenApiDocument {
  return {
    paths: {
      "/api/v1/public/traces": {
        get: {
          "x-tool": {
            enabled: true,
            name: "list_traces",
            description: "List traces.",
          },
          parameters: [
            {
              name: "limit",
              in: "query",
              required: false,
              description: "Items per page",
              schema: {
                type: "integer",
                title: "Limit",
                default: 50,
                minimum: 1,
                maximum: 200,
                description: "Items per page",
              },
            },
            {
              name: "start_after",
              in: "query",
              required: false,
              description: "Only traces after this time",
              schema: {
                anyOf: [{ type: "string", format: "date-time" }, { type: "null" }],
                title: "Start After",
                description: "Only traces after this time",
              },
            },
            {
              name: "filters",
              in: "query",
              required: false,
              description: "JSON array of typed filter predicates",
              content: {
                "application/json": {
                  schema: {
                    type: "array",
                    items: {
                      anyOf: [
                        {
                          type: "object",
                          properties: {
                            field: { const: "model_name" },
                            op: { enum: ["eq", "in"] },
                            value: {},
                          },
                          required: ["field", "op", "value"],
                          additionalProperties: false,
                        },
                      ],
                    },
                  },
                },
              },
            },
          ],
        },
        post: {
          "x-tool": { enabled: false },
        },
      },
      "/api/v1/public/traces/{trace_id}": {
        get: {
          "x-tool": {
            enabled: true,
            name: "get_trace",
            description: "Fetch one trace.",
          },
          parameters: [
            {
              name: "trace_id",
              in: "path",
              required: true,
              schema: { type: "string", title: "Trace Id" },
            },
            {
              name: "ignored_header",
              in: "header",
              required: false,
              schema: { type: "string" },
            },
          ],
        },
      },
      "/api/v1/public/whoami": {
        get: {
          "x-tool": {
            enabled: true,
            name: "whoami",
            description: "Identify the project.",
          },
        },
      },
    },
  };
}

describe("generateRegistry", () => {
  it("emits one entry per enabled operation, sorted by name, skipping disabled ops", () => {
    const registry = generateRegistry(fakeDoc());
    expect(registry.map((entry) => entry.name)).toEqual(["get_trace", "list_traces", "whoami"]);
    expect(registry.map((entry) => entry.method)).toEqual(["get", "get", "get"]);
    const whoami = registry.find((entry) => entry.name === "whoami")!;
    expect(whoami.path).toBe("/api/v1/public/whoami");
    expect(whoami.inputSchema).toEqual({
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    });
  });

  it("flattens anyOf [T, null] plain params and strips titles", () => {
    const registry = generateRegistry(fakeDoc());
    const listTraces = registry.find((entry) => entry.name === "list_traces")!;
    expect(listTraces.inputSchema.properties.start_after).toEqual({
      type: "string",
      format: "date-time",
      description: "Only traces after this time",
    });
    expect(listTraces.inputSchema.properties.limit).toEqual({
      type: "integer",
      default: 50,
      minimum: 1,
      maximum: 200,
      description: "Items per page",
    });
  });

  it("marks path params required and skips non-query/path params", () => {
    const registry = generateRegistry(fakeDoc());
    const getTrace = registry.find((entry) => entry.name === "get_trace")!;
    expect(getTrace.inputSchema.required).toEqual(["trace_id"]);
    expect(getTrace.inputSchema.properties.trace_id).toEqual({ type: "string" });
    expect(getTrace.inputSchema.properties).not.toHaveProperty("ignored_header");
  });

  it("carries JSON-content params verbatim, merging the param description", () => {
    const registry = generateRegistry(fakeDoc());
    const listTraces = registry.find((entry) => entry.name === "list_traces")!;
    expect(listTraces.inputSchema.properties.filters).toEqual({
      type: "array",
      items: {
        anyOf: [
          {
            type: "object",
            properties: {
              field: { const: "model_name" },
              op: { enum: ["eq", "in"] },
              value: {},
            },
            required: ["field", "op", "value"],
            additionalProperties: false,
          },
        ],
      },
      description: "JSON array of typed filter predicates",
    });
    expect(listTraces.inputSchema.required).toEqual([]);
  });

  it("drops column-range (int64/uint64) maxima but keeps small bounds", () => {
    const doc = fakeDoc();
    doc.paths["/api/v1/public/whoami"].get.parameters = [
      {
        name: "min_tokens",
        in: "query",
        schema: { type: "integer", minimum: 0, maximum: 9223372036854776000 },
      },
      {
        name: "filters",
        in: "query",
        content: {
          "application/json": {
            schema: {
              type: "array",
              items: { properties: { value: { type: "integer", maximum: 18446744073709552000 } } },
            },
          },
        },
      },
    ];
    const whoami = generateRegistry(doc).find((entry) => entry.name === "whoami")!;
    expect(whoami.inputSchema.properties.min_tokens).toEqual({ type: "integer", minimum: 0 });
    expect(whoami.inputSchema.properties.filters).toEqual({
      type: "array",
      items: { properties: { value: { type: "integer" } } },
    });
  });

  it("normalizes multi-variant anyOf params (null variant and titles dropped) and tolerates schema-less params", () => {
    const doc = fakeDoc();
    doc.paths["/api/v1/public/whoami"].get.parameters = [
      {
        name: "cursor",
        in: "query",
        required: false,
        schema: {
          anyOf: [{ type: "string", title: "Cursor Token" }, { type: "integer" }, { type: "null" }],
          title: "Cursor",
        },
      },
      { name: "bare", in: "query", required: false },
    ];
    const registry = generateRegistry(doc);
    const whoami = registry.find((entry) => entry.name === "whoami")!;
    // Same treatment as single-variant unions: optionality lives in `required`,
    // so the null variant is dropped, and titles are stripped at every level.
    expect(whoami.inputSchema.properties.cursor).toEqual({
      anyOf: [{ type: "string" }, { type: "integer" }],
    });
    expect(whoami.inputSchema.properties.bare).toEqual({});
  });

  it("throws on an enabled operation missing its x-tool name or description", () => {
    const doc = fakeDoc();
    doc.paths["/api/v1/public/whoami"].get["x-tool"] = { enabled: true };
    expect(() => generateRegistry(doc)).toThrow(/missing an x-tool name or description/);
  });

  it("throws on an enabled operation with an unsupported method", () => {
    const doc = fakeDoc();
    doc.paths["/api/v1/public/traces"].put = {
      "x-tool": { enabled: true, name: "replace_traces", description: "Replace." },
    };
    expect(() => generateRegistry(doc)).toThrow(
      "Enabled tool on PUT /api/v1/public/traces: only GET and POST operations are supported",
    );
  });

  it("emits GET entries without write-only keys", () => {
    for (const entry of generateRegistry(fakeDoc())) {
      expect("bodyParams" in entry).toBe(false);
      expect("policy" in entry).toBe(false);
    }
  });
});

/** Minimal fake of the public document's write-operation shapes. */
function fakeWriteDoc(): OpenApiDocument {
  return {
    paths: {
      "/api/v1/public/workspaces": {
        post: {
          "x-tool": {
            enabled: true,
            name: "create_workspace",
            description: "Create a workspace.",
            policy: { approvalClass: "approval", minRole: "VIEWER", tenancy: "account" },
          },
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CreateWorkspaceRequest" },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        CreateWorkspaceRequest: {
          type: "object",
          title: "CreateWorkspaceRequest",
          properties: {
            name: { type: "string", title: "Name" },
            plan: { anyOf: [{ type: "string" }, { type: "null" }], title: "Plan" },
          },
          required: ["name"],
        },
      },
    },
  };
}

describe("generateRegistry write operations", () => {
  it("emits a post entry with flattened body properties, bodyParams, and verbatim policy", () => {
    const registry = generateRegistry(fakeWriteDoc());
    expect(registry).toHaveLength(1);
    const entry = registry[0]!;
    expect(entry.method).toBe("post");
    expect(entry.path).toBe("/api/v1/public/workspaces");
    expect(entry.inputSchema.properties.name).toEqual({ type: "string" });
    expect(entry.inputSchema.properties.plan).toEqual({ type: "string" });
    expect(entry.inputSchema.required).toEqual(["name"]);
    expect(entry.bodyParams).toEqual(["name", "plan"]);
    expect(entry.policy).toEqual({
      approvalClass: "approval",
      minRole: "VIEWER",
      tenancy: "account",
    });
  });

  it("declares a type on every body-derived property schema", () => {
    const entry = generateRegistry(fakeWriteDoc())[0]!;
    for (const name of entry.bodyParams!) {
      expect(entry.inputSchema.properties[name]!.type).toBeTypeOf("string");
    }
  });

  it("merges path params alongside body properties; bodyParams holds only body names", () => {
    const doc = fakeWriteDoc();
    doc.paths["/api/v1/public/workspaces"].post!.parameters = [
      {
        name: "workspace_id",
        in: "path",
        required: true,
        schema: { type: "string", title: "Workspace Id" },
      },
    ];
    const entry = generateRegistry(doc)[0]!;
    expect(entry.inputSchema.properties.workspace_id).toEqual({ type: "string" });
    expect(entry.inputSchema.properties.name).toEqual({ type: "string" });
    expect(entry.inputSchema.required).toEqual(["workspace_id", "name"]);
    expect(entry.bodyParams).toEqual(["name", "plan"]);
  });

  it("resolves property-level $refs one level before flattening", () => {
    const doc = fakeWriteDoc();
    doc.components!.schemas!.CreateWorkspaceRequest!.properties = {
      settings: { $ref: "#/components/schemas/WorkspaceSettings" },
    };
    doc.components!.schemas!.WorkspaceSettings = {
      type: "object",
      title: "WorkspaceSettings",
      properties: { retention_days: { type: "integer", title: "Retention Days" } },
    };
    const entry = generateRegistry(doc)[0]!;
    expect(entry.inputSchema.properties.settings).toEqual({
      type: "object",
      properties: { retention_days: { type: "integer", title: "Retention Days" } },
    });
    expect(entry.bodyParams).toEqual(["settings"]);
  });

  const policyError =
    "Enabled write tool on POST /api/v1/public/workspaces: " +
    "x-tool policy {approvalClass, minRole, tenancy} is required and must be complete";

  it("throws on an enabled POST without a policy", () => {
    const doc = fakeWriteDoc();
    delete doc.paths["/api/v1/public/workspaces"].post!["x-tool"]!.policy;
    expect(() => generateRegistry(doc)).toThrow(policyError);
  });

  it("throws on a policy with an illegal value", () => {
    const doc = fakeWriteDoc();
    doc.paths["/api/v1/public/workspaces"].post!["x-tool"]!.policy = {
      approvalClass: "sometimes",
      minRole: "VIEWER",
      tenancy: "account",
    };
    expect(() => generateRegistry(doc)).toThrow(policyError);
  });

  it("throws on a policy with an extra key", () => {
    const doc = fakeWriteDoc();
    doc.paths["/api/v1/public/workspaces"].post!["x-tool"]!.policy = {
      approvalClass: "approval",
      minRole: "VIEWER",
      tenancy: "account",
      audited: true,
    };
    expect(() => generateRegistry(doc)).toThrow(policyError);
  });

  it("still skips disabled non-GET operations", () => {
    const doc = fakeWriteDoc();
    doc.paths["/api/v1/public/workspaces"].post!["x-tool"] = { enabled: false };
    expect(generateRegistry(doc)).toEqual([]);
  });

  it("throws on an unresolvable requestBody $ref", () => {
    const doc = fakeWriteDoc();
    delete doc.components!.schemas!.CreateWorkspaceRequest;
    expect(() => generateRegistry(doc)).toThrow(
      "Enabled tool on POST /api/v1/public/workspaces: " +
        "unresolvable requestBody $ref #/components/schemas/CreateWorkspaceRequest",
    );
  });

  it("throws on a $ref outside #/components/schemas/", () => {
    const doc = fakeWriteDoc();
    doc.paths["/api/v1/public/workspaces"].post!.requestBody!.content!["application/json"]!.schema =
      { $ref: "#/definitions/CreateWorkspaceRequest" };
    expect(() => generateRegistry(doc)).toThrow(
      "Enabled tool on POST /api/v1/public/workspaces: " +
        "unresolvable requestBody $ref #/definitions/CreateWorkspaceRequest",
    );
  });

  it("throws on a body property whose emitted schema still contains a nested $ref", () => {
    const doc = fakeWriteDoc();
    doc.components!.schemas!.CreateWorkspaceRequest!.properties = {
      scorers: {
        type: "array",
        title: "Scorers",
        items: { $ref: "#/components/schemas/ScorerRef" },
      },
    };
    doc.components!.schemas!.ScorerRef = { type: "object", properties: {} };
    expect(() => generateRegistry(doc)).toThrow(
      'Enabled tool on POST /api/v1/public/workspaces: body property "scorers" contains an ' +
        "unresolved $ref — extend the generator before enabling this operation",
    );
  });

  it("does not flag ref-free nested body schemas (create-request shapes)", () => {
    const doc = fakeWriteDoc();
    doc.components!.schemas!.CreateWorkspaceRequest = {
      type: "object",
      title: "CreateDetectorLikeRequest",
      properties: {
        name: { title: "Name", type: "string" },
        cursor: { anyOf: [{ type: "string" }, { type: "integer" }], title: "Cursor" },
        sample_rate: { anyOf: [{ type: "integer" }, { type: "null" }], title: "Sample Rate" },
        output_schema: {
          anyOf: [{ items: {}, type: "array" }, { type: "null" }],
          title: "Output Schema",
        },
        trigger_conditions: {
          anyOf: [{ items: { type: "object" }, type: "array" }, { type: "null" }],
          title: "Trigger Conditions",
        },
      },
      required: ["name"],
    };
    const entry = generateRegistry(doc)[0]!;
    expect(entry.bodyParams).toEqual([
      "cursor",
      "name",
      "output_schema",
      "sample_rate",
      "trigger_conditions",
    ]);
    expect(entry.inputSchema.properties.cursor).toEqual({
      anyOf: [{ type: "string" }, { type: "integer" }],
    });
  });

  it("emits empty bodyParams for an enabled POST without a JSON request body", () => {
    const doc = fakeWriteDoc();
    delete doc.paths["/api/v1/public/workspaces"].post!.requestBody;
    const entry = generateRegistry(doc)[0]!;
    expect(entry.bodyParams).toEqual([]);
    expect(entry.inputSchema.properties).toEqual({});
    expect(entry.inputSchema.required).toEqual([]);
  });
});
