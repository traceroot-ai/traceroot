import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

// lookup.ts imports prisma at module load (registerCacheClear); mock it so these
// pure-function tests run without a generated client or DB (mirrors
// model-pricing.test.ts). resolveModelPricing/stripGatewayPrefix never touch it.
vi.mock("../lib/prisma", () => ({
  prisma: { standardModel: { findMany: vi.fn() } },
}));

import {
  compileMatchPattern,
  resolveModelPricing,
  stripGatewayPrefix,
} from "../model-pricing/lookup.ts";

// The shipped catalog synced into the standard_models / standard_model_prices
// tables. We resolve against it directly (pure, no Prisma) so these invariants
// guard the DATA that both the TS and Python resolvers share — turning the
// recurring "$0 / mispriced model" class (#1545, #1556, #1558, #1560) into a
// failing CI check instead of a customer report. See #1597.
interface CatalogEntry {
  modelName: string;
  matchPattern: string;
  prices: Record<string, number>;
}

const CATALOG: CatalogEntry[] = JSON.parse(
  readFileSync(new URL("../standard-model-prices.json", import.meta.url), "utf8"),
);

const GATEWAY_PREFIXES = ["openai", "openrouter", "litellm", "vertex_ai", "anthropic"];

describe("standard-model-prices.json — catalog invariants (#1597)", () => {
  it("is non-empty and well-formed", () => {
    expect(CATALOG.length).toBeGreaterThan(0);
    for (const e of CATALOG) {
      expect(typeof e.modelName).toBe("string");
      expect(e.modelName.length).toBeGreaterThan(0);
      expect(typeof e.matchPattern).toBe("string");
    }
  });

  it("every matchPattern compiles through the resolver's compiler", () => {
    // The catalog authors patterns with a leading Python inline flag `(?i)`, which
    // a raw JS `new RegExp` rejects ("Invalid group") — so the resolver must
    // normalize them. Guarding this here means the TS regex fallback can never be
    // silently dead again (#1597).
    const bad: string[] = [];
    for (const e of CATALOG) {
      if (compileMatchPattern(e.matchPattern) === null) bad.push(e.modelName);
    }
    expect(bad, `patterns the resolver cannot compile: ${bad.join(", ")}`).toEqual([]);
  });

  it("documents that raw JS RegExp rejects these patterns (why compile is needed)", () => {
    // Regression anchor: the whole catalog uses `(?i)`, which raw JS RegExp throws on.
    // If this ever stops being true, the compiler's inline-flag handling can be revisited.
    const rawRejected = CATALOG.filter((e) => {
      try {
        new RegExp(e.matchPattern, "i");
        return false;
      } catch {
        return true;
      }
    });
    expect(rawRejected.length).toBeGreaterThan(0);
  });

  it("every model resolves to ITS OWN prices (no pattern/id drift — catches #1558)", () => {
    // A model whose own matchPattern does not match its own modelName is unpriced
    // (returns $0), which is exactly how gemini-3-flash shipped broken in #1558.
    const drifted: string[] = [];
    for (const e of CATALOG) {
      const resolved = resolveModelPricing(CATALOG, e.modelName);
      if (resolved !== e.prices) drifted.push(e.modelName);
    }
    expect(drifted, `models that don't resolve to themselves: ${drifted.join(", ")}`).toEqual([]);
  });

  it("no model is silently mispriced by a different entry's pattern", () => {
    // resolveModelPricing must never return a DIFFERENT entry's prices for a
    // shipped model id. (Same-price overlaps are harmless and allowed.)
    const mispriced: string[] = [];
    for (const e of CATALOG) {
      const resolved = resolveModelPricing(CATALOG, e.modelName);
      if (resolved && resolved !== e.prices) mispriced.push(e.modelName);
    }
    expect(mispriced, `models resolving to another entry's price: ${mispriced.join(", ")}`).toEqual(
      [],
    );
  });

  it("gateway/router-prefixed ids resolve to the same price as the bare id (#1556)", () => {
    const broken: string[] = [];
    for (const e of CATALOG) {
      for (const prefix of GATEWAY_PREFIXES) {
        const resolved = resolveModelPricing(CATALOG, `${prefix}/${e.modelName}`);
        if (resolved !== e.prices) broken.push(`${prefix}/${e.modelName}`);
      }
    }
    expect(broken, `prefixed ids that don't match the bare price: ${broken.join(", ")}`).toEqual(
      [],
    );
  });

  it("resolution is independent of catalog order (deterministic)", () => {
    const reversed = [...CATALOG].reverse();
    const sample = CATALOG.slice(0, 40).map((e) => e.modelName);
    for (const name of sample) {
      expect(resolveModelPricing(reversed, name)).toBe(resolveModelPricing(CATALOG, name));
    }
  });
});

describe("stripGatewayPrefix", () => {
  it("leaves a bare model id unchanged", () => {
    expect(stripGatewayPrefix("gpt-5")).toBe("gpt-5");
    expect(stripGatewayPrefix("claude-opus-4-8")).toBe("claude-opus-4-8");
  });

  it("strips a single known prefix", () => {
    expect(stripGatewayPrefix("openrouter/gpt-5")).toBe("gpt-5");
    expect(stripGatewayPrefix("vertex_ai/gemini-2.5-pro")).toBe("gemini-2.5-pro");
  });

  it("strips chained prefixes", () => {
    expect(stripGatewayPrefix("openrouter/anthropic/claude-opus-4-8")).toBe("claude-opus-4-8");
    expect(stripGatewayPrefix("litellm/openai/gpt-5")).toBe("gpt-5");
  });

  it("stops at the first non-gateway segment (leaves org/name paths intact)", () => {
    expect(stripGatewayPrefix("someorg/custom-model")).toBe("someorg/custom-model");
    // Bedrock dot-format is not slash-prefixed, so it is untouched.
    expect(stripGatewayPrefix("us.anthropic.claude-sonnet-4")).toBe("us.anthropic.claude-sonnet-4");
  });
});

describe("resolveModelPricing — specificity & determinism", () => {
  const P_GENERIC = { input: 1 };
  const P_SPECIFIC = { input: 2 };

  // A shorter entry whose pattern subsumes a longer sibling, ordered so the
  // generic one comes first — the old first-match-wins loop returned it.
  const OVERLAP = [
    { modelName: "foo-4", matchPattern: "^foo-4(-.+)?$", prices: P_GENERIC },
    { modelName: "foo-4-turbo", matchPattern: "^foo-4-turbo(-\\d+)?$", prices: P_SPECIFIC },
  ];

  it("returns the MOST specific match, not the first in order", () => {
    // "foo-4-turbo-2099" is matched by BOTH patterns; the longer modelName must win.
    expect(resolveModelPricing(OVERLAP, "foo-4-turbo-2099")).toBe(P_SPECIFIC);
  });

  it("exact match always wins over a broader pattern", () => {
    expect(resolveModelPricing(OVERLAP, "foo-4-turbo")).toBe(P_SPECIFIC);
    expect(resolveModelPricing(OVERLAP, "foo-4")).toBe(P_GENERIC);
  });

  it("returns null when nothing matches", () => {
    expect(resolveModelPricing(OVERLAP, "totally-unknown-2099")).toBeNull();
  });
});
