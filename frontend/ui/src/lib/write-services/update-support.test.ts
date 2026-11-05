import { describe, it, expect } from "vitest";
import {
  DELETE_REASON_MAX,
  DELETE_REASON_MESSAGE,
  diffPatch,
  definedKeys,
  jsonEqual,
  toPublicField,
  validateDeleteReason,
} from "./update-support";

describe("validateDeleteReason", () => {
  it.each([undefined, null, 42, "", "  ", "ab", "  ab  ", "x".repeat(DELETE_REASON_MAX + 1)])(
    "refuses %j with the bounds message",
    (reason) => {
      expect(validateDeleteReason(reason)).toEqual({
        ok: false,
        status: 400,
        error: DELETE_REASON_MESSAGE,
      });
    },
  );

  it("keeps an accepted reason verbatim, bounds measured on the trimmed text", () => {
    expect(validateDeleteReason("  superseded  ")).toEqual({ ok: true, reason: "  superseded  " });
    expect(validateDeleteReason("x".repeat(DELETE_REASON_MAX))).toMatchObject({ ok: true });
  });
});

describe("definedKeys", () => {
  it("treats undefined as absent and null as a value", () => {
    expect(definedKeys({ a: undefined, b: null, c: 0 })).toEqual(["b", "c"]);
  });
});

describe("toPublicField", () => {
  it("snake-cases the camelCase field name", () => {
    expect(toPublicField("sampleRate")).toBe("sample_rate");
    expect(toPublicField("thresholdOperator")).toBe("threshold_operator");
    expect(toPublicField("name")).toBe("name");
  });
});

describe("jsonEqual", () => {
  it("ignores object key order, as jsonb storage does", () => {
    expect(jsonEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
  });

  it("distinguishes values, lengths, missing keys and null", () => {
    expect(jsonEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(jsonEqual([1], [1, 2])).toBe(false);
    expect(jsonEqual({ a: 1 }, { b: 1 })).toBe(false);
    expect(jsonEqual(null, {})).toBe(false);
    expect(jsonEqual({}, null)).toBe(false);
    expect(jsonEqual([], {})).toBe(false);
    expect(jsonEqual("1", 1)).toBe(false);
  });
});

describe("diffPatch", () => {
  it("keeps only the carried fields whose value differs and names them in public form", () => {
    const patch = { name: "Same", sampleRate: 50, outputSchema: [{ k: 1 }], enabled: undefined };
    const current = { name: "Same", sampleRate: 25, outputSchema: [{ k: 1 }], enabled: true };
    expect(diffPatch(patch, current)).toEqual({
      changed: ["sample_rate"],
      data: { sampleRate: 50 },
    });
  });

  it("reads an explicit null as a value that can differ", () => {
    expect(diffPatch({ detectionModel: null }, { detectionModel: "gpt" })).toEqual({
      changed: ["detection_model"],
      data: { detectionModel: null },
    });
    expect(diffPatch({ detectionModel: null }, { detectionModel: null })).toEqual({
      changed: [],
      data: {},
    });
  });
});
