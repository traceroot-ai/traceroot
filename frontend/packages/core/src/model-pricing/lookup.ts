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

/**
 * Gateway / router prefixes that SDKs prepend to the bare model id
 * (LiteLLM, OpenRouter, Vercel AI Gateway, cloud provider SDKs), e.g.
 * `openrouter/anthropic/claude-opus-4-8`, `vertex_ai/gemini-2.5-pro`,
 * `litellm/openai/gpt-5`.
 *
 * Kept in sync with the Python worker's `_GATEWAY_PREFIXES`
 * (`backend/worker/tokens/pricing.py`, added in #1566) so the two price
 * resolvers agree on prefixed ids instead of one returning a price and the
 * other `null` → `$0` (issue #1597).
 */
const GATEWAY_PREFIXES: ReadonlySet<string> = new Set([
  "openai",
  "azure",
  "google",
  "googleai",
  "vertex_ai",
  "anthropic",
  "bedrock",
  "openrouter",
  "litellm",
  "models",
  "deepseek",
  "xai",
  "moonshot",
  "zai",
]);

/**
 * Strip one or more leading gateway/router prefixes separated by `/`.
 *
 * Iterates so chained prefixes (`openrouter/anthropic/claude-opus-4-8`) are
 * fully reduced, and stops at the first segment that is not a recognised
 * gateway name — so Bedrock dot-format (`us.anthropic.claude-...`) and Vertex
 * `@date` variants are left untouched. Mirrors the worker's
 * `_strip_gateway_prefix`.
 */
export function stripGatewayPrefix(modelId: string): string {
  let id = modelId;
  for (;;) {
    const slash = id.indexOf("/");
    if (slash === -1) break;
    if (!GATEWAY_PREFIXES.has(id.slice(0, slash).toLowerCase())) break;
    id = id.slice(slash + 1);
  }
  return id;
}

/**
 * Compile a stored `matchPattern` into a JavaScript `RegExp`.
 *
 * The catalog patterns are authored with a leading Python-style inline flag
 * `(?i)` (see standard-model-prices.json). JavaScript's `RegExp` does NOT support
 * inline flags and throws "Invalid group" on them — so a raw
 * `new RegExp(matchPattern, "i")` fails for EVERY catalog entry. The previous
 * resolver swallowed that in a `try/catch`, which meant its regex fallback never
 * fired at all: only exact `modelName` matches resolved, and any non-exact id
 * (dated snapshot, gateway-prefixed, version variant) fell through to `null` →
 * `$0`. The Python worker's `re` accepts `(?i)`, so it matched these fine — this
 * is a concrete driver of the Python/TS divergence in #1597.
 *
 * Strip a leading inline-flag group and apply the native `i` flag (the catalog
 * only uses `(?i)`; case-insensitive is the intent everywhere). Returns `null`
 * for a pattern that still won't compile, so a single bad entry can't throw.
 */
export function compileMatchPattern(matchPattern: string): RegExp | null {
  const body = matchPattern.replace(/^\(\?[a-z]+\)/, "");
  try {
    return new RegExp(body, "i");
  } catch {
    return null;
  }
}

/**
 * Pure price resolution over an in-memory catalog — no DB, so it is unit-testable
 * against the shipped `standard-model-prices.json` directly (mirrors how
 * `calculateCostFromPricing` is pure).
 *
 * Resolution order:
 *   1. gateway-prefix normalisation, then exact match (raw id first, then stripped),
 *   2. regex fallback that returns the MOST SPECIFIC match — the entry with the
 *      longest `modelName` — with an alphabetical tiebreak.
 *
 * The specificity ranking (vs. the previous first-match-wins) fixes two things at
 * once (issue #1597): a shorter entry whose pattern subsumes a longer sibling
 * (e.g. `claude-sonnet-4` matching `claude-sonnet-4-5`) no longer wins, and the
 * result no longer depends on catalog row order — the old loop returned whatever
 * `findMany` happened to yield first.
 */
export function resolveModelPricing<P>(
  models: ReadonlyArray<{ modelName: string; matchPattern: string; prices: P }>,
  modelId: string,
): P | null {
  const stripped = stripGatewayPrefix(modelId);

  // Exact match — raw id first, then the prefix-stripped form.
  for (const candidate of stripped === modelId ? [modelId] : [modelId, stripped]) {
    const exact = models.find((m) => m.modelName === candidate);
    if (exact) return exact.prices;
  }

  // Most-specific regex match. Longest modelName wins; alphabetical tiebreak keeps
  // it deterministic regardless of the catalog's iteration order.
  let best: { modelName: string; prices: P } | null = null;
  for (const m of models) {
    const re = compileMatchPattern(m.matchPattern);
    if (re === null) continue; // uncompilable pattern — skip
    if (!re.test(modelId) && !re.test(stripped)) continue;
    if (
      best === null ||
      m.modelName.length > best.modelName.length ||
      (m.modelName.length === best.modelName.length && m.modelName < best.modelName)
    ) {
      best = m;
    }
  }
  return best ? best.prices : null;
}

async function loadCache(): Promise<CachedModel[]> {
  if (cache) return cache;

  const models = await prisma.standardModel.findMany({
    include: { prices: true },
    // Deterministic order so results never depend on DB row order. The
    // specificity ranking in resolveModelPricing makes this redundant for
    // correctness, but a stable order keeps the cache reproducible.
    orderBy: { modelName: "asc" },
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
  return resolveModelPricing(models, modelId);
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
