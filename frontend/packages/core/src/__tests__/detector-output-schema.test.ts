import { describe, it, expect } from "vitest";
import {
  OUTPUT_FIELD_TYPES,
  RESERVED_FIELD_NAMES,
  isUsableFieldName,
} from "../lib/detector-output-schema.ts";

describe("detector output-schema rules", () => {
  it("offers the three field types", () => {
    expect(OUTPUT_FIELD_TYPES).toEqual(["string", "number", "boolean"]);
  });

  it.each(["severity", "two words", " padded "])("accepts the name %j", (name) => {
    expect(isUsableFieldName(name)).toBe(true);
  });

  it.each(["", "   ", "\t\n", null, undefined, 5, {}, ["severity"]])(
    "refuses %j, which is blank or not a string",
    (name) => {
      expect(isUsableFieldName(name)).toBe(false);
    },
  );

  it.each([...RESERVED_FIELD_NAMES])("refuses the reserved name %s", (name) => {
    expect(isUsableFieldName(name)).toBe(false);
  });

  it("reserves the names that reach Object.prototype", () => {
    expect([...RESERVED_FIELD_NAMES].sort()).toEqual(["__proto__", "constructor", "prototype"]);
  });
});
