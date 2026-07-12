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
