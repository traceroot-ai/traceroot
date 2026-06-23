import { prisma } from "../lib/prisma.ts";
import { registerCacheClear } from "./sync-standard-prices.ts";

export interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number | null;
  cacheWrite: number | null;
  // Optional Anthropic 1-hour cache-write rate (2.0x input, versus 1.25x for the
  // default 5-minute write). null when a model doesn't distinguish TTLs, in which
  // case the combined `cacheWrite` rate (which already equals the 5-minute rate) is
  // used. Only `cacheWrite1h` is populated in the price table today.
  cacheWrite1h: number | null;
}

interface CachedModel {
  modelName: string;
  matchPattern: string;
  prices: ModelPricing;
}

let cache: CachedModel[] | null = null;

function clearCache(): void {
  cache = null;
}

// Register with sync module so cache is invalidated after sync
registerCacheClear(clearCache);

async function loadCache(): Promise<CachedModel[]> {
  if (cache) return cache;

  const models = await prisma.standardModel.findMany({
    include: { prices: true },
  });

  cache = models.map((m) => {
    const priceMap: Record<string, number> = {};
    for (const p of m.prices) {
      priceMap[p.usageType] = Number(p.price);
    }
    return {
      modelName: m.modelName,
      matchPattern: m.matchPattern,
      prices: {
        input: priceMap["input"] ?? 0,
        output: priceMap["output"] ?? 0,
        cacheRead: priceMap["cacheRead"] ?? null,
        cacheWrite: priceMap["cacheWrite"] ?? null,
        cacheWrite1h: priceMap["cacheWrite1h"] ?? null,
      },
    };
  });

  return cache;
}

/**
 * Look up pricing for a model by name.
 * Tries exact match on modelName first, then regex matchPattern fallback.
 * Returns prices in USD per token, or null if not found.
 */
export async function getModelPricing(modelId: string): Promise<ModelPricing | null> {
  const models = await loadCache();

  // Exact match
  const exact = models.find((m) => m.modelName === modelId);
  if (exact) return exact.prices;

  // Regex fallback
  for (const m of models) {
    try {
      const re = new RegExp(m.matchPattern, "i");
      if (re.test(modelId)) return m.prices;
    } catch {
      // Invalid regex — skip
    }
  }

  return null;
}

/**
 * Price token counts against a known ModelPricing. Pure (no DB lookup), so it is
 * unit-testable without mocking Prisma, and mirrors the Python worker's cost formula.
 *
 * The 1-hour cache-write portion (cacheWrite1hTokens) is a sub-partition of
 * cacheWriteTokens: clamped non-negative and capped so `1h <= total`, with the
 * remainder priced at the combined `cacheWrite` rate (which already equals the
 * 5-minute / default rate) and the 1-hour portion at its own rate (falling back to
 * `cacheWrite`). When no 1-hour portion is supplied the remainder is the whole write
 * total, so the result is identical to the pre-split formula.
 */
export function calculateCostFromPricing(
  pricing: ModelPricing,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number = 0,
  cacheWriteTokens: number = 0,
  cacheWrite1hTokens: number = 0,
): number {
  // Clamp every count non-negative so malformed input can't produce a negative
  // cost, mirroring the worker's normalize_token_usage.
  const input = Math.max(inputTokens, 0);
  const output = Math.max(outputTokens, 0);
  const cacheRead = Math.max(cacheReadTokens, 0);
  const cacheWrite = Math.max(cacheWriteTokens, 0);
  const cacheWrite1h = Math.min(Math.max(cacheWrite1hTokens, 0), cacheWrite);
  const remainder = cacheWrite - cacheWrite1h;
  const cacheWriteRate = pricing.cacheWrite ?? 0;

  // `|| cacheWriteRate` (not `??`): a 0 rate is treated as unset and falls back to the
  // base cache-write rate, matching the Python worker's truthy `_rate` fallback so the
  // two cost formulas agree for every input (incl. an explicit cacheWrite1h of 0).
  return (
    input * pricing.input +
    output * pricing.output +
    cacheRead * (pricing.cacheRead ?? 0) +
    remainder * cacheWriteRate +
    cacheWrite1h * (pricing.cacheWrite1h || cacheWriteRate)
  );
}

/**
 * Calculate cost in USD given model ID and token counts.
 * Returns 0 if the model is not found in the pricing table.
 */
export async function calculateCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number = 0,
  cacheWriteTokens: number = 0,
  cacheWrite1hTokens: number = 0,
): Promise<number> {
  const pricing = await getModelPricing(modelId);
  if (!pricing) return 0;

  return calculateCostFromPricing(
    pricing,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cacheWrite1hTokens,
  );
}
