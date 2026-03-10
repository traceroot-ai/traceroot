import { prisma } from "../lib/prisma";
import standardModels from "../standard-model-prices.json";

interface StandardModelEntry {
  id: string;
  modelName: string;
  matchPattern: string;
  provider: string;
  prices: {
    input: number;
    output: number;
    cacheRead: number | null;
    cacheWrite: number | null;
  };
}

/**
 * Upsert all models from standard-model-prices.json into the database.
 * Idempotent — safe to call on every startup.
 *
 * Requires `prisma generate` after schema changes and `prisma migrate deploy`
 * to create the standard_models / standard_model_prices tables.
 */
export async function syncStandardPrices(): Promise<void> {
  if (!prisma.standardModel) {
    throw new Error(
      "prisma.standardModel is undefined — run `prisma generate` to regenerate the client after schema changes",
    );
  }

  const entries = standardModels as StandardModelEntry[];

  for (const entry of entries) {
    // Build price rows for non-null prices
    const priceRows: { usageType: string; price: number }[] = [];
    for (const [usageType, price] of Object.entries(entry.prices)) {
      if (price !== null) {
        priceRows.push({ usageType, price });
      }
    }

    await prisma.standardModel.upsert({
      where: { modelName: entry.modelName },
      create: {
        id: entry.id,
        modelName: entry.modelName,
        matchPattern: entry.matchPattern,
        provider: entry.provider,
        prices: {
          create: priceRows.map((r) => ({
            usageType: r.usageType,
            price: r.price,
          })),
        },
      },
      update: {
        matchPattern: entry.matchPattern,
        provider: entry.provider,
        prices: {
          // Delete all existing prices and recreate — simplest way to handle changes
          deleteMany: {},
        },
      },
    });

    // After update, recreate prices (deleteMany above only runs on update path)
    // Check if prices exist; if not, create them
    const existing = await prisma.standardModelPrice.count({
      where: { modelId: entry.id },
    });
    if (existing === 0) {
      await prisma.standardModelPrice.createMany({
        data: priceRows.map((r) => ({
          modelId: entry.id,
          usageType: r.usageType,
          price: r.price,
        })),
      });
    }
  }

  // Invalidate in-memory cache
  clearPricingCache();

  console.log(`[ModelPricing] Synced ${entries.length} standard models to database`);
}

// Re-export cache invalidation for use by lookup module
let _clearCache: (() => void) | null = null;

export function registerCacheClear(fn: () => void): void {
  _clearCache = fn;
}

function clearPricingCache(): void {
  _clearCache?.();
}
