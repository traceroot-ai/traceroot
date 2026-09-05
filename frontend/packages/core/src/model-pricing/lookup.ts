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
  // Compiled at cache-load time, or null when the catalogue pattern cannot compile.
  matcher: RegExp | null;
  prices: ModelPricing;
}

// `matchPattern` values are authored for the Python worker, which accepts the PCRE
// inline flag `(?i)`. JavaScript's RegExp does not — it throws "Invalid group" — and
// every catalogue pattern carries that prefix. Case-insensitivity is already supplied
// by the "i" flag below, so the inline flag is redundant here and is stripped.
const INLINE_IGNORECASE_PREFIX = /^\(\?i\)/;

/**
 * Compile a catalogue match pattern for the JS path, or null if it cannot compile.
 *
 * Called once per cache load rather than per lookup, so an uncompilable pattern is
 * reported once instead of on every pricing call.
 */
function compileMatchPattern(matchPattern: string, modelName: string): RegExp | null {
  try {
    return new RegExp(matchPattern.replace(INLINE_IGNORECASE_PREFIX, ""), "i");
  } catch (err) {
    // A pattern that cannot compile is a catalogue defect. Swallowing it silently is
    // what hid the fallback being dead: pricing just returned null and looked free.
    console.warn(
      `[model-pricing] Ignoring uncompilable matchPattern for "${modelName}": ${matchPattern}`,
      err,
    );
    return null;
  }
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
      matcher: compileMatchPattern(m.matchPattern, m.modelName),
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
 * Gateway / router prefixes stripped before the second matching pass.
 *
 * Every catalogue pattern hand-encodes which prefixes it tolerates, so coverage
 * drifts between siblings and no entry accepts the router prefixes real
 * deployments emit. Normalizing once here fixes every row at the same time.
 *
 * Keep in sync with GATEWAY_PREFIXES in backend/worker/tokens/pricing.py — the two
 * lookups must agree on what a model id means. The Python test
 * tests/worker/tokens/test_gateway_prefix_parity.py fails if they drift.
 */
export const GATEWAY_PREFIXES = new Set([
  "amazon_bedrock",
  "anthropic",
  "azure",
  "azure_ai",
  "bedrock",
  "deepseek",
  "fireworks_ai",
  "google",
  "googleai",
  "groq",
  "litellm",
  "mistral",
  "models",
  "moonshot",
  "openai",
  "openrouter",
  "portkey",
  "together_ai",
  "vertex_ai",
  "vertexai",
  "xai",
  "zai",
]);

// Chained prefixes in the wild are at most two deep ("openrouter/anthropic/…").
const MAX_PREFIX_DEPTH = 3;

/**
 * Drop leading gateway/router segments from a model id.
 *
 * `openrouter/anthropic/claude-opus-4-8` -> `claude-opus-4-8`.
 *
 * Only segments in GATEWAY_PREFIXES are removed, so an id whose first segment is
 * part of the model's real name is returned untouched. Bedrock's
 * `us.anthropic.claude-…` and Vertex's `model@date` forms are distinct id shapes
 * rather than slash prefixes and pass through unchanged.
 */
export function stripGatewayPrefixes(modelId: string): string {
  let current = modelId;
  for (let depth = 0; depth < MAX_PREFIX_DEPTH; depth++) {
    const separator = current.indexOf("/");
    if (separator === -1) break;
    const head = current.slice(0, separator);
    const tail = current.slice(separator + 1);
    if (!tail || !GATEWAY_PREFIXES.has(head.toLowerCase())) break;
    current = tail;
  }
  return current;
}

function matchPricing(models: CachedModel[], modelId: string): ModelPricing | null {
  // Exact match
  const exact = models.find((m) => m.modelName === modelId);
  if (exact) return exact.prices;

  // Regex fallback — catches provider-prefixed and Bedrock/Vertex-style aliases
  // (e.g. "anthropic/claude-opus-5", "us.anthropic.claude-opus-5-v1:0").
  for (const m of models) {
    if (m.matcher?.test(modelId)) return m.prices;
  }

  return null;
}

/**
 * Look up pricing for a model by name.
 * Tries exact match on modelName first, then regex matchPattern fallback.
 * Returns prices in USD per token, or null if not found.
 *
 * The id is matched as given first, so any pattern that deliberately recognises a
 * prefixed form keeps winning exactly as before. Only when nothing matches are
 * gateway prefixes stripped and the passes retried — the fallback is additive, so
 * it can turn a null into a price but never change a price that already resolved.
 */
export async function getModelPricing(modelId: string): Promise<ModelPricing | null> {
  const models = await loadCache();

  const direct = matchPricing(models, modelId);
  if (direct) return direct;

  const bare = stripGatewayPrefixes(modelId);
  return bare === modelId ? null : matchPricing(models, bare);
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
