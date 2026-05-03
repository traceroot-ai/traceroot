import { describe, it, expect } from "vitest";
import { buildSubmitResultTool } from "../submit-result-tool";

describe("buildSubmitResultTool", () => {
  it("returns tool with name submit_result", () => {
    const tool = buildSubmitResultTool([]);
    expect(tool.name).toBe("submit_result");
  });

  it("always requires identified and summary (data only when identified=true)", () => {
    const tool = buildSubmitResultTool([]);
    expect(tool.input_schema.required).toEqual(["identified", "summary"]);
  });

  it("identified property is boolean type", () => {
    const tool = buildSubmitResultTool([]);
    expect(tool.input_schema.properties.identified.type).toBe("boolean");
  });

  it("adds user-defined outputSchema fields to data properties", () => {
    const tool = buildSubmitResultTool([
      { name: "category", type: "string" },
      { name: "severity", type: "string" },
    ]);
    const dataProps = tool.input_schema.properties.data.properties;
    expect(dataProps).toHaveProperty("category");
    expect(dataProps).toHaveProperty("severity");
    expect(dataProps.category.type).toBe("string");
  });

  it("works with empty outputSchema", () => {
    const tool = buildSubmitResultTool([]);
    expect(tool.input_schema.properties.data.properties).toEqual({});
  });

  it("works with multiple field types", () => {
    const tool = buildSubmitResultTool([
      { name: "count", type: "number" },
      { name: "flagged", type: "boolean" },
    ]);
    const dataProps = tool.input_schema.properties.data.properties;
    expect(dataProps.count.type).toBe("number");
    expect(dataProps.flagged.type).toBe("boolean");
  });

  it("ignores prototype-polluting field names", () => {
    const tool = buildSubmitResultTool([
      { name: "__proto__", type: "string" },
      { name: "safe", type: "string" },
    ]);
    const dataProps = tool.input_schema.properties.data.properties;
    expect(dataProps).not.toHaveProperty("__proto__");
    expect(dataProps).toHaveProperty("safe");
  });
});
