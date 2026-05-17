import { prisma } from "../lib/prisma.js";
import standardModels from "../standard-model-prices.json" with { type: "json" };

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

    // Wrap in transaction to avoid a race window where prices are deleted but not yet recreated
    await prisma.$transaction(async (tx) => {
      const model = await tx.standardModel.upsert({
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
            deleteMany: {},
          },
        },
      });

      // Recreate prices after update (deleteMany above only runs on update path)
      const existing = await tx.standardModelPrice.count({
        where: { modelId: model.id },
      });
      if (existing === 0) {
        await tx.standardModelPrice.createMany({
          data: priceRows.map((r) => ({
            modelId: model.id,
            usageType: r.usageType,
            price: r.price,
          })),
        });
      }
    });
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
