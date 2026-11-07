import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { OUTPUT_FIELD_TYPES, RESERVED_FIELD_NAMES, validateOutputSchema } from "./output-schema";
import { DETECTOR_TEMPLATES } from "./templates";

/**
 * The output schema becomes the detection worker's submit_result tool. An
 * entry the worker cannot type has to be refused here, at save time, rather
 * than stored and then screened as a string or dropped at evaluation time.
 */

const TYPE_MESSAGE = "type must be one of: string, number, boolean";

describe("validateOutputSchema — what the write path accepts", () => {
  it("accepts every template's schema", () => {
    for (const template of DETECTOR_TEMPLATES) {
      expect(validateOutputSchema(template.outputSchema)).toBeNull();
    }
  });

  it("accepts an empty schema and one field of every type", () => {
    expect(validateOutputSchema([])).toBeNull();
    expect(
      validateOutputSchema([
        { name: "category", type: "string" },
        { name: "count", type: "number" },
        { name: "flagged", type: "boolean" },
      ]),
    ).toBeNull();
  });

  it("offers exactly the types the worker's submit_result tool builds", () => {
    // The worker cannot be imported from here: read the types it branches on.
    // Every other type falls through to a string, which is listed explicitly.
    const toolPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../../worker/src/detection/submit-result-tool.ts",
    );
    const branched = [...readFileSync(toolPath, "utf8").matchAll(/\btype === "(\w+)"/g)].map(
      (m) => m[1],
    );
    expect(branched.length).toBeGreaterThan(0);
    expect([...OUTPUT_FIELD_TYPES].sort()).toEqual(["string", ...branched].sort());
  });

  it("reserves exactly the names the worker's submit_result tool drops", () => {
    const toolPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../../worker/src/detection/submit-result-tool.ts",
    );
    const literal = readFileSync(toolPath, "utf8").match(
      /UNSAFE_FIELD_NAMES\s*=\s*new Set\(\[([^\]]*)\]\)/,
    );
    expect(literal).not.toBeNull();
    const dropped = [...literal![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(dropped.length).toBeGreaterThan(0);
    expect([...RESERVED_FIELD_NAMES].sort()).toEqual(dropped.sort());
  });
});

describe("validateOutputSchema — entries the worker cannot use", () => {
  it("refuses a payload that is not an array", () => {
    expect(validateOutputSchema({ name: "x", type: "string" })).toBe(
      "outputSchema must be an array",
    );
    expect(validateOutputSchema(null)).toBe("outputSchema must be an array");
  });

  it("refuses an entry that is not an object", () => {
    expect(validateOutputSchema([null])).toBe("output field 1 must be an object");
    expect(validateOutputSchema(["severity"])).toBe("output field 1 must be an object");
    expect(validateOutputSchema([["severity", "string"]])).toBe("output field 1 must be an object");
  });

  it("refuses a missing, non-string or blank name", () => {
    const message = "output field 1 requires a non-empty name";
    expect(validateOutputSchema([{ type: "string" }])).toBe(message);
    expect(validateOutputSchema([{ name: 5, type: "string" }])).toBe(message);
    expect(validateOutputSchema([{ name: "", type: "string" }])).toBe(message);
    expect(validateOutputSchema([{ name: "   ", type: "string" }])).toBe(message);
  });

  it.each(["__proto__", "prototype", "constructor"])(
    "refuses the reserved name %s, which the worker drops",
    (name) => {
      expect(validateOutputSchema([{ name, type: "string" }])).toBe(
        `output field 1 name "${name}" is reserved`,
      );
    },
  );

  it("refuses a type the worker would screen as a string", () => {
    expect(validateOutputSchema([{ name: "x", type: "banana" }])).toBe(
      `output field 1 ${TYPE_MESSAGE}`,
    );
    expect(validateOutputSchema([{ name: "x" }])).toBe(`output field 1 ${TYPE_MESSAGE}`);
  });

  it("refuses a repeated name, which the worker would collapse to the last declaration", () => {
    expect(
      validateOutputSchema([
        { name: "x", type: "string" },
        { name: "x", type: "number" },
      ]),
    ).toBe('output field 2 repeats the name "x"');
  });

  it("escapes a quote or newline in the name it echoes, which the CLI prints verbatim", () => {
    expect(
      validateOutputSchema([
        { name: 'a"b\nc', type: "string" },
        { name: 'a"b\nc', type: "number" },
      ]),
    ).toBe('output field 2 repeats the name "a\\"b\\nc"');
  });

  it("names the first offending entry by its position", () => {
    expect(validateOutputSchema([{ name: "ok", type: "string" }, { type: "number" }])).toBe(
      "output field 2 requires a non-empty name",
    );
    // When two entries are invalid, the first entry's type is the problem named.
    expect(
      validateOutputSchema([
        { name: "x", type: "banana" },
        { name: "x", type: "number" },
      ]),
    ).toBe(`output field 1 ${TYPE_MESSAGE}`);
  });
});
