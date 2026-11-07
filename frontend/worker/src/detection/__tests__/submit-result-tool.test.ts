import { describe, it, expect } from "vitest";
import { buildSubmitResultTool } from "../submit-result-tool.js";

// TypeBox produces JSON-schema-shaped objects at runtime; tests inspect via this loose shape.
interface JsonSchemaLike {
  type?: string;
  properties?: Record<string, JsonSchemaLike>;
  required?: string[];
  description?: string;
}

function asSchema(value: unknown): JsonSchemaLike {
  return value as JsonSchemaLike;
}

describe("buildSubmitResultTool", () => {
  it("returns tool with name submit_result", () => {
    const tool = buildSubmitResultTool([]);
    expect(tool.name).toBe("submit_result");
  });

  it("always requires identified and summary (data only when identified=true)", () => {
    const tool = buildSubmitResultTool([]);
    expect(asSchema(tool.parameters).required).toEqual(["identified", "summary"]);
  });

  it("identified property is boolean type", () => {
    const tool = buildSubmitResultTool([]);
    const props = asSchema(tool.parameters).properties;
    expect(props?.identified?.type).toBe("boolean");
  });

  it("adds user-defined outputSchema fields to data properties", () => {
    const tool = buildSubmitResultTool([
      { name: "category", type: "string" },
      { name: "severity", type: "string" },
    ]);
    const dataProps = asSchema(tool.parameters).properties?.data?.properties;
    expect(dataProps).toHaveProperty("category");
    expect(dataProps).toHaveProperty("severity");
    expect(dataProps?.category?.type).toBe("string");
  });

  it("works with empty outputSchema", () => {
    const tool = buildSubmitResultTool([]);
    expect(asSchema(tool.parameters).properties?.data?.properties).toEqual({});
  });

  it("works with multiple field types", () => {
    const tool = buildSubmitResultTool([
      { name: "count", type: "number" },
      { name: "flagged", type: "boolean" },
    ]);
    const dataProps = asSchema(tool.parameters).properties?.data?.properties;
    expect(dataProps?.count?.type).toBe("number");
    expect(dataProps?.flagged?.type).toBe("boolean");
  });

  it("rejects unsafe field names that would mutate Object.prototype", () => {
    const tool = buildSubmitResultTool([
      { name: "__proto__", type: "string" },
      { name: "constructor", type: "string" },
      { name: "prototype", type: "string" },
      { name: "ok", type: "string" },
    ]);
    const dataProps = asSchema(tool.parameters).properties?.data?.properties ?? {};
    expect(Object.keys(dataProps)).toEqual(["ok"]);
  });

  it("skips stored entries with no usable name instead of throwing", () => {
    // A stored schema can predate the write path's validation; it is JSON, not the declared type.
    const stored = [
      null,
      "severity",
      5,
      ["category", "string"],
      { type: "number" },
      { name: null, type: "string" },
      { name: "ok", type: "string" },
    ];
    const tool = buildSubmitResultTool(stored);
    const dataProps = asSchema(tool.parameters).properties?.data?.properties ?? {};
    expect(Object.keys(dataProps)).toEqual(["ok"]);
  });

  it("skips a stored entry whose name is blank, as the write path rejects it", () => {
    const tool = buildSubmitResultTool([
      { name: "", type: "string" },
      { name: "   ", type: "string" },
      { name: "\t\n", type: "number" },
      { name: "ok", type: "string" },
    ]);
    const dataProps = asSchema(tool.parameters).properties?.data?.properties ?? {};
    expect(Object.keys(dataProps)).toEqual(["ok"]);
  });

  it("still screens an unknown or missing type as a string", () => {
    const tool = buildSubmitResultTool([{ name: "kind", type: "banana" }, { name: "note" }]);
    const dataProps = asSchema(tool.parameters).properties?.data?.properties;
    expect(dataProps?.kind?.type).toBe("string");
    expect(dataProps?.note?.type).toBe("string");
  });
});
