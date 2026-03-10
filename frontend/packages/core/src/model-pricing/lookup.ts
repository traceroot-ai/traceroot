import { prisma } from "../lib/prisma";
import { registerCacheClear } from "./sync-standard-prices";

export interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number | null;
  cacheWrite: number | null;
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
 * Calculate cost in USD given model ID and token counts.
 * Returns 0 if the model is not found in the pricing table.
 */
export async function calculateCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number = 0,
  cacheWriteTokens: number = 0,
): Promise<number> {
  const pricing = await getModelPricing(modelId);
  if (!pricing) return 0;

  return (
    inputTokens * pricing.input +
    outputTokens * pricing.output +
    cacheReadTokens * (pricing.cacheRead ?? 0) +
    cacheWriteTokens * (pricing.cacheWrite ?? 0)
  );
}
