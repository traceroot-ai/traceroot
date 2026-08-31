import { describe, expect, it } from "vitest";
import { ApiClient } from "../client.js";
import { toPiAgentTool } from "../pi.js";
import { REGISTRY } from "../registry.generated.js";
import { stripOversizedNumericBounds } from "../sanitize.js";

// int64 / uint64 maxima as JSON renders them (already rounded past 2^53).
const INT64_MAX = 9223372036854776000;
const UINT64_MAX = 18446744073709552000;

type Props = { properties: Record<string, unknown> };

describe("stripOversizedNumericBounds", () => {
  it("drops int64/uint64-sized bounds while keeping small ones", () => {
    const cleaned = stripOversizedNumericBounds({
      type: "object",
      properties: {
        big: { type: "integer", minimum: 0, maximum: INT64_MAX },
        huge: { type: "integer", minimum: 0, maximum: UINT64_MAX },
        page: { type: "integer", minimum: 1, maximum: 200 },
        okBig: { type: "integer", maximum: 999999999 },
      },
    }) as Props;

    expect(cleaned.properties.big).toEqual({ type: "integer", minimum: 0 });
    expect(cleaned.properties.huge).toEqual({ type: "integer", minimum: 0 });
    // legitimate small bounds are preserved untouched
    expect(cleaned.properties.page).toEqual({ type: "integer", minimum: 1, maximum: 200 });
    expect(cleaned.properties.okBig).toEqual({ type: "integer", maximum: 999999999 });
  });

  it("strips bounds nested deep inside anyOf/array/object variants", () => {
    const cleaned = stripOversizedNumericBounds({
      anyOf: [
        {
          type: "object",
          properties: { value: { type: "integer", minimum: 0, maximum: INT64_MAX } },
        },
      ],
    }) as { anyOf: Props[] };
    expect(cleaned.anyOf[0]!.properties.value).toEqual({ type: "integer", minimum: 0 });
  });

  it("leaves instance values (default/const/enum/examples) untouched", () => {
    // A data value may legitimately contain a field named like a bound keyword.
    const data = { maximum: INT64_MAX, minimum: -INT64_MAX };
    const cleaned = stripOversizedNumericBounds({
      type: "object",
      maximum: INT64_MAX,
      default: data,
      const: data,
      enum: [data, 1],
      examples: [data],
      properties: { n: { type: "integer", maximum: INT64_MAX } },
    }) as Record<string, unknown>;
    expect(cleaned).not.toHaveProperty("maximum");
    expect(cleaned.default).toEqual(data);
    expect(cleaned.const).toEqual(data);
    expect(cleaned.enum).toEqual([data, 1]);
    expect(cleaned.examples).toEqual([data]);
    expect((cleaned.properties as Record<string, unknown>).n).toEqual({ type: "integer" });
  });

  it("does not mutate the input", () => {
    const input = { maximum: INT64_MAX, type: "integer" };
    stripOversizedNumericBounds(input);
    expect(input.maximum).toBe(INT64_MAX);
  });
});

describe("toPiAgentTool never emits an oversized numeric bound (OpenAI-safe)", () => {
  const client = new ApiClient({ baseUrl: "http://localhost:8000", headers: {} });

  const BOUND_KEYS = ["maximum", "minimum", "exclusiveMaximum", "exclusiveMinimum", "multipleOf"];

  function hasOversizedBound(value: unknown): boolean {
    if (Array.isArray(value)) return value.some(hasOversizedBound);
    if (value !== null && typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (
          BOUND_KEYS.includes(k) &&
          typeof v === "number" &&
          Math.abs(v) > Number.MAX_SAFE_INTEGER
        ) {
          return true;
        }
        if (hasOversizedBound(v)) return true;
      }
    }
    return false;
  }

  it("holds for every tool in the registry", () => {
    for (const entry of REGISTRY) {
      const tool = toPiAgentTool(entry, { client });
      expect(
        hasOversizedBound(tool.parameters),
        `tool ${entry.name} carries an oversized bound`,
      ).toBe(false);
    }
  });

  it("strips oversized bounds from a hand-authored entry at the model boundary", () => {
    const tool = toPiAgentTool(
      {
        name: "t",
        description: "t",
        method: "get",
        path: "/t",
        inputSchema: {
          type: "object",
          properties: { n: { type: "integer", minimum: 0, maximum: INT64_MAX } },
          required: [],
          additionalProperties: false,
        },
      },
      { client },
    );
    expect(tool.parameters.properties.n).toEqual({ type: "integer", minimum: 0 });
  });
});
