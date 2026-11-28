import { describe, expect, it } from "vitest";
import type { InputSchema } from "../types.js";
import { checkArguments, describeShape } from "../validate.js";

const schema: InputSchema = {
  type: "object",
  properties: {
    trace_id: { type: "string", minLength: 1 },
    limit: { type: "integer", minimum: 1, maximum: 100 },
    fields: { type: "string", enum: ["skeleton", "io", "metadata", "full"] },
    tags: { type: "array", items: { type: "string" }, maxItems: 2 },
    filters: {
      type: "array",
      items: {
        anyOf: [
          {
            type: "object",
            properties: {
              field: { const: "status" },
              value: { type: "string", enum: ["OK", "ERROR"] },
            },
            required: ["field", "value"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              field: { const: "duration_ms" },
              value: { type: "number" },
            },
            required: ["field", "value"],
            additionalProperties: false,
          },
        ],
      },
    },
  },
  required: ["trace_id"],
  additionalProperties: false,
};

const fail = (raw: unknown, hidden?: string[]) => {
  const result = checkArguments("get_trace", schema, raw, {
    hidden: hidden ? new Set(hidden) : undefined,
  });
  if (result.ok) throw new Error("expected a failure");
  return result.message;
};

describe("checkArguments", () => {
  it("accepts valid arguments as they are", () => {
    const args = {
      trace_id: "t1",
      limit: 5,
      fields: "io",
      filters: [{ field: "status", value: "OK" }],
    };
    expect(checkArguments("get_trace", schema, args)).toEqual({ ok: true, args });
  });

  it("treats missing arguments as an empty object", () => {
    const loose = { ...schema, required: [] };
    expect(checkArguments("get_trace", loose, undefined)).toEqual({ ok: true, args: {} });
  });

  it("names the tool, the bad path, the expected type and the value sent", () => {
    const message = fail({ trace_id: "t1", limit: "abc" });
    expect(message).toContain("Invalid arguments for get_trace:");
    expect(message).toContain('- limit: expected integer, got string "abc"');
  });

  it("names an unknown key and the one probably meant", () => {
    const message = fail({ trace_id: "t1", limitt: 5 });
    expect(message).toContain('- unknown argument "limitt" (did you mean "limit"?)');
    expect(fail({ traceId: "t1" })).toContain(
      'unknown argument "traceId" (did you mean "trace_id"?)',
    );
  });

  it("lists the accepted values of an enum", () => {
    expect(fail({ trace_id: "t1", fields: "everything" })).toContain(
      '- fields: expected one of "skeleton", "io", "metadata", "full", got string "everything"',
    );
  });

  it("reports every problem at once, and the missing required argument", () => {
    const message = fail({ limit: 0, tags: ["a", "b", 3] });
    expect(message).toContain('- missing required argument "trace_id"');
    expect(message).toContain("- limit: must be at least 1, got 0");
    expect(message).toContain("- tags: takes at most 2 item(s), got 3");
    expect(message).toContain("- tags[2]: expected string, got number 3");
  });

  it("ends with the accepted top-level shape", () => {
    const message = fail({ limit: 5 });
    expect(message).toContain(
      'get_trace takes one flat JSON object: {"trace_id": string (required), "limit": integer, ' +
        '"fields": "skeleton" | "io" | "metadata" | "full", "tags": array of string, ' +
        '"filters": array of object (one of several shapes; see the schema)}',
    );
  });

  it("explains a union by the branch the value claims to be", () => {
    const message = fail({
      trace_id: "t1",
      filters: [{ field: "status", value: "BROKEN", extra: 1 }],
    });
    expect(message).toContain(
      '- filters[0].value: expected one of "OK", "ERROR", got string "BROKEN"',
    );
    expect(message).toContain('- filters[0]: unknown field "extra"');
  });

  it("unwraps arguments sent inside a single wrapper object", () => {
    for (const key of ["arguments", "params", "input", "args"]) {
      expect(checkArguments("get_trace", schema, { [key]: { trace_id: "t1" } })).toEqual({
        ok: true,
        args: { trace_id: "t1" },
        unwrappedFrom: key,
      });
    }
  });

  it("explains a wrapped call whose inner arguments are wrong, from the inner object", () => {
    const message = fail({ arguments: { trace_id: "t1", limit: "x" } });
    expect(message).toContain('- limit: expected integer, got string "x"');
    expect(message).toContain('read from inside "arguments"; send them at the top level');
  });

  it("does not unwrap a wrapper key next to other keys", () => {
    expect(fail({ arguments: { trace_id: "t1" }, limit: 2 })).toContain(
      'unknown argument "arguments"',
    );
  });

  it("explains a hidden param instead of calling it unknown", () => {
    expect(fail({ trace_id: "t1", project_id: "p" }, ["project_id"])).toContain(
      'argument "project_id" is not accepted here',
    );
  });

  it("refuses arguments that are not an object", () => {
    expect(fail(["t1"])).toContain("the arguments must be a JSON object, got an array");
  });

  it("describes a shape with no params as an empty object", () => {
    expect(
      describeShape({ type: "object", properties: {}, required: [], additionalProperties: false }),
    ).toBe("{}");
  });
});
