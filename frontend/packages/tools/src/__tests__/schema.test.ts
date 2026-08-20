import { describe, expect, it } from "vitest";
import { sanitizeSchemaForModel } from "../schema.js";

describe("sanitizeSchemaForModel", () => {
  it("preserves instance-valued metadata while sanitizing nested subschemas", () => {
    const unsafe = Number.MAX_SAFE_INTEGER + 1;
    const schema = {
      type: "object",
      properties: {
        payload: {
          type: "object",
          maximum: unsafe,
          default: { minimum: -unsafe, nested: [{ maximum: unsafe }] },
          example: [{ minimum: -unsafe }, { maximum: unsafe }],
          examples: [{ minimum: -unsafe }, [{ maximum: unsafe }]],
          enum: [{ minimum: -unsafe }, [{ maximum: unsafe }]],
          const: { maximum: unsafe, nested: [{ minimum: -unsafe }] },
          allOf: [
            { minimum: -unsafe },
            {
              items: {
                anyOf: [{ maximum: unsafe }, { properties: { deep: { minimum: -unsafe } } }],
              },
            },
          ],
        },
      },
    };
    const before = structuredClone(schema);

    const sanitized = sanitizeSchemaForModel(schema);
    const payload = sanitized.properties.payload;

    expect(payload).not.toHaveProperty("maximum");
    expect(payload.allOf).toEqual([
      {},
      {
        items: {
          anyOf: [{}, { properties: { deep: {} } }],
        },
      },
    ]);
    expect(payload.default).toEqual(before.properties.payload.default);
    expect(payload.example).toEqual(before.properties.payload.example);
    expect(payload.examples).toEqual(before.properties.payload.examples);
    expect(payload.enum).toEqual(before.properties.payload.enum);
    expect(payload.const).toEqual(before.properties.payload.const);
    expect(schema).toEqual(before);
    expect(payload.default).not.toBe(schema.properties.payload.default);
  });
});
