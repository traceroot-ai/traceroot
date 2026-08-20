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

  it("removes unsafe numeric bounds recursively while preserving safe bounds", () => {
    const doc = fakeDoc();
    doc.paths["/api/v1/public/whoami"].get.parameters = [
      {
        name: "filters",
        in: "query",
        content: {
          "application/json": {
            schema: {
              type: "array",
              items: {
                anyOf: [
                  {
                    type: "object",
                    properties: {
                      too_large: {
                        type: "integer",
                        minimum: 0,
                        maximum: Number.MAX_SAFE_INTEGER + 1,
                      },
                      too_small: {
                        type: "integer",
                        minimum: Number.MIN_SAFE_INTEGER - 1,
                        maximum: 200,
                      },
                      safe_integer: {
                        type: "integer",
                        minimum: Number.MIN_SAFE_INTEGER,
                        maximum: Number.MAX_SAFE_INTEGER,
                      },
                      safe_decimal: {
                        type: "number",
                        minimum: -0.25,
                        maximum: 3.5,
                      },
                    },
                  },
                ],
              },
            },
          },
        },
      },
    ];

    const registry = generateRegistry(doc);
    const whoami = registry.find((entry) => entry.name === "whoami")!;
    const filters = whoami.inputSchema.properties.filters as {
      items: { anyOf: Array<{ properties: Record<string, unknown> }> };
    };

    expect(filters.items.anyOf[0]!.properties).toEqual({
      too_large: { type: "integer", minimum: 0 },
      too_small: { type: "integer", maximum: 200 },
      safe_integer: {
        type: "integer",
        minimum: Number.MIN_SAFE_INTEGER,
        maximum: Number.MAX_SAFE_INTEGER,
      },
      safe_decimal: { type: "number", minimum: -0.25, maximum: 3.5 },
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

  it("throws on an enabled non-GET operation", () => {
    const doc = fakeDoc();
    doc.paths["/api/v1/public/traces"].post = {
      "x-tool": { enabled: true, name: "ingest_traces", description: "Ingest." },
    };
    expect(() => generateRegistry(doc)).toThrow(/GET/);
  });
});
