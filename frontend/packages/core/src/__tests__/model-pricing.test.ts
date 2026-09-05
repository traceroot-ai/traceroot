import { beforeEach, describe, expect, it, vi } from "vitest";

// lookup.ts imports prisma at module load (registerCacheClear); mock it so the
// pricing path is testable without a generated client or DB.
vi.mock("../lib/prisma", () => ({
  prisma: { standardModel: { findMany: vi.fn() } },
}));

// Import via the package index so the public re-exports are covered too.
import {
  calculateCost,
  calculateCostFromPricing,
  getModelPricing,
  type ModelPricing,
} from "../model-pricing/index.ts";
import { stripGatewayPrefixes } from "../model-pricing/lookup.ts";
import { prisma } from "../lib/prisma.ts";

// opus-4.x-shaped rates: cacheWrite is the 5-minute / default rate (1.25x input);
// cacheWrite1h = 2x input.
const CLAUDE: ModelPricing = {
  input: 0.000005,
  output: 0.000025,
  cacheRead: 0.0000005,
  cacheWrite: 0.00000625,
  cacheWrite1h: 0.00001,
};

describe("calculateCostFromPricing — cache-write 1-hour portion", () => {
  it("prices the 1-hour portion at its own rate", () => {
    // 900 write: 600 @1h, 300 remainder.
    const cost = calculateCostFromPricing(CLAUDE, 100, 0, 0, 900, 600);
    const expected = 100 * CLAUDE.input + 300 * 0.00000625 + 600 * 0.00001;
    expect(cost).toBeCloseTo(expected, 12);
  });

  it("prices the remainder at the combined cacheWrite rate", () => {
    // 1000 write: 200 @1h, 800 remainder.
    const cost = calculateCostFromPricing(CLAUDE, 0, 0, 0, 1000, 200);
    const expected = 200 * 0.00001 + 800 * 0.00000625;
    expect(cost).toBeCloseTo(expected, 12);
  });

  it("is identical to the combined rate when no 1-hour portion is supplied", () => {
    const cost = calculateCostFromPricing(CLAUDE, 100, 0, 0, 900);
    const expected = 100 * CLAUDE.input + 900 * 0.00000625;
    expect(cost).toBeCloseTo(expected, 12);
  });

  it("falls back to cacheWrite when the 1-hour rate is null", () => {
    const noTtl: ModelPricing = { ...CLAUDE, cacheWrite1h: null };
    const cost = calculateCostFromPricing(noTtl, 0, 0, 0, 500, 150);
    expect(cost).toBeCloseTo(500 * 0.00000625, 12); // whole write total at cacheWrite
  });

  it("falls back to cacheWrite when the 1-hour rate is 0 (|| parity with the worker)", () => {
    const zeroRate: ModelPricing = { ...CLAUDE, cacheWrite1h: 0 };
    const cost = calculateCostFromPricing(zeroRate, 0, 0, 0, 100, 40);
    expect(cost).toBeCloseTo(100 * 0.00000625, 12); // 40 @1h -> cacheWrite, 60 remainder
  });

  it("caps an over-reported 1-hour portion to the write total", () => {
    // 1h=180 > 100 -> capped to 100 @1h, 0 remainder.
    const cost = calculateCostFromPricing(CLAUDE, 0, 0, 0, 100, 180);
    const expected = 100 * 0.00001;
    expect(cost).toBeCloseTo(expected, 12);
  });

  it("matches the original formula for a plain (no-cache) span", () => {
    const cost = calculateCostFromPricing(CLAUDE, 1000, 500);
    expect(cost).toBeCloseTo(1000 * CLAUDE.input + 500 * CLAUDE.output, 12);
  });

  it("clamps negative counts to zero (mirrors the worker)", () => {
    const cost = calculateCostFromPricing(CLAUDE, -100, -50, -10, -900, -1);
    expect(cost).toBe(0);
  });
});

describe("getModelPricing + calculateCost (prisma-backed)", () => {
  beforeEach(() => {
    (prisma.standardModel.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        modelName: "claude-opus-4-7",
        matchPattern: "^claude-opus-4-7$",
        prices: [
          { usageType: "input", price: 0.000005 },
          { usageType: "output", price: 0.000025 },
          { usageType: "cacheRead", price: 0.0000005 },
          { usageType: "cacheWrite", price: 0.00000625 },
          { usageType: "cacheWrite1h", price: 0.00001 },
        ],
      },
    ]);
  });

  it("loads the 1h cache rate from the price table", async () => {
    const pricing = await getModelPricing("claude-opus-4-7");
    expect(pricing).not.toBeNull();
    expect(pricing!.cacheWrite).toBe(0.00000625);
    expect(pricing!.cacheWrite1h).toBe(0.00001);
  });

  it("prices the 1-hour portion end-to-end via the async calculateCost", async () => {
    // 900 write: 600 @1h (-> cacheWrite1h), 300 remainder (-> cacheWrite).
    const cost = await calculateCost("claude-opus-4-7", 100, 0, 0, 900, 600);
    const expected = 100 * 0.000005 + 300 * 0.00000625 + 600 * 0.00001;
    expect(cost).toBeCloseTo(expected, 12);
  });

  it("returns 0 when the model is not in the pricing table", async () => {
    const cost = await calculateCost("totally-unknown-model-2099", 100, 50);
    expect(cost).toBe(0);
  });
});

// lookup.ts caches the price table in module scope for the process lifetime, so a
// fresh catalogue needs a fresh module instance — otherwise these fixtures are
// shadowed by whichever describe loaded the cache first.
async function loadWithCatalogue(rows: unknown[]) {
  vi.resetModules();
  vi.doMock("../lib/prisma", () => ({
    prisma: { standardModel: { findMany: vi.fn().mockResolvedValue(rows) } },
  }));
  return import("../model-pricing/lookup.ts");
}

// The catalogue authors matchPattern for the Python worker, so every one of the 92
// entries in standard-model-prices.json begins with the PCRE inline flag `(?i)`.
// JavaScript's RegExp rejects that prefix, so these fixtures use the real catalogue
// shape — an `(?i)`-less fixture passes even when the fallback is entirely dead.
describe("getModelPricing — regex fallback over catalogue-shaped patterns", () => {
  const CANONICAL = "claude-opus-4-7";
  // Verbatim catalogue shape: leading (?i), optional provider prefix, optional
  // Bedrock region/version decoration.
  const CATALOGUE_ROW = {
    modelName: CANONICAL,
    matchPattern: "(?i)^(anthropic\\/|us\\.anthropic\\.)?claude-opus-4-7(-v\\d+:\\d+)?$",
    prices: [
      { usageType: "input", price: 0.000005 },
      { usageType: "output", price: 0.000025 },
      { usageType: "cacheRead", price: 0.0000005 },
      { usageType: "cacheWrite", price: 0.00000625 },
      { usageType: "cacheWrite1h", price: 0.00001 },
    ],
  };

  it("resolves a provider-prefixed alias to the canonical price", async () => {
    const { getModelPricing: lookup } = await loadWithCatalogue([CATALOGUE_ROW]);
    const canonical = await lookup(CANONICAL);
    const aliased = await lookup("anthropic/claude-opus-4-7");
    expect(aliased).not.toBeNull();
    expect(aliased).toEqual(canonical);
  });

  it("resolves a Bedrock-style alias to the canonical price", async () => {
    const { getModelPricing: lookup } = await loadWithCatalogue([CATALOGUE_ROW]);
    const canonical = await lookup(CANONICAL);
    const aliased = await lookup("us.anthropic.claude-opus-4-7-v1:0");
    expect(aliased).not.toBeNull();
    expect(aliased).toEqual(canonical);
  });

  it("matches case-insensitively, the behaviour the inline (?i) intended", async () => {
    const { getModelPricing: lookup } = await loadWithCatalogue([CATALOGUE_ROW]);
    expect(await lookup("Anthropic/Claude-Opus-4-7")).not.toBeNull();
  });

  it("still returns null for a model the pattern genuinely does not cover", async () => {
    const { getModelPricing: lookup } = await loadWithCatalogue([CATALOGUE_ROW]);
    expect(await lookup("anthropic/claude-sonnet-9")).toBeNull();
  });
});

describe("getModelPricing — uncompilable pattern", () => {
  it("reports the catalogue defect instead of failing silently", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { getModelPricing: lookup } = await loadWithCatalogue([
      {
        modelName: "broken-entry",
        matchPattern: "^(unclosed", // genuinely invalid in any flavour
        prices: [{ usageType: "input", price: 0.000005 }],
      },
    ]);

    // Does not throw; the bad entry is skipped and the defect is surfaced.
    expect(await lookup("anything")).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("broken-entry"), expect.anything());
    warn.mockRestore();
  });
});

// Every catalogue pattern hand-encodes the gateway prefixes it tolerates, so
// coverage drifted between siblings and no entry accepted the router prefixes real
// deployments emit — cost silently resolved to $0 (#1556). The fixture below keeps
// the catalogue shape: it accepts `anthropic/` in-pattern and nothing else.
describe("getModelPricing — gateway/router prefixes", () => {
  const CANONICAL = "claude-opus-4-7";
  const CATALOGUE_ROW = {
    modelName: CANONICAL,
    matchPattern: "(?i)^(anthropic\\/|us\\.anthropic\\.)?claude-opus-4-7(-v\\d+:\\d+)?$",
    prices: [
      { usageType: "input", price: 0.000005 },
      { usageType: "output", price: 0.000025 },
    ],
  };

  it.each([
    "openrouter/anthropic/claude-opus-4-7",
    "litellm/anthropic/claude-opus-4-7",
    "vertex_ai/claude-opus-4-7",
    "bedrock/us.anthropic.claude-opus-4-7",
    "portkey/claude-opus-4-7",
  ])("prices %s like the bare model", async (modelId) => {
    const { getModelPricing: lookup } = await loadWithCatalogue([CATALOGUE_ROW]);
    const canonical = await lookup(CANONICAL);
    expect(await lookup(modelId)).toEqual(canonical);
  });

  it("leaves an id that already matched in-pattern untouched", async () => {
    const { getModelPricing: lookup } = await loadWithCatalogue([CATALOGUE_ROW]);
    const canonical = await lookup(CANONICAL);
    expect(await lookup("anthropic/claude-opus-4-7")).toEqual(canonical);
  });

  it("does not manufacture a match for an unknown model behind a gateway", async () => {
    const { getModelPricing: lookup } = await loadWithCatalogue([CATALOGUE_ROW]);
    expect(await lookup("openrouter/acme/not-a-real-model")).toBeNull();
  });
});

describe("stripGatewayPrefixes", () => {
  it.each([
    ["openrouter/anthropic/claude-opus-4-8", "claude-opus-4-8"],
    ["litellm/openai/gpt-5", "gpt-5"],
    ["VERTEX_AI/gemini-2.5-pro", "gemini-2.5-pro"],
    ["azure/gpt-5.4", "gpt-5.4"],
  ])("strips %s", (modelId, expected) => {
    expect(stripGatewayPrefixes(modelId)).toBe(expected);
  });

  it.each([
    "gpt-5",
    "my-org/gpt-5",
    "ft:gpt-4o:acme/custom",
    "us.anthropic.claude-opus-4-8-v1:0",
    "openai/", // a bare prefix is not a model id; leave it rather than empty it
  ])("leaves %s alone", (modelId) => {
    expect(stripGatewayPrefixes(modelId)).toBe(modelId);
  });

  it("terminates on a pathological id instead of walking every segment", () => {
    expect(stripGatewayPrefixes("openai/".repeat(50) + "gpt-5")).toBe(
      "openai/".repeat(47) + "gpt-5",
    );
  });
});
