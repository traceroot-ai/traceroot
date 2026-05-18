import { describe, expect, it } from "vitest";

import standardModelPrices from "../standard-model-prices.json";

type StandardEntry = (typeof standardModelPrices)[number];

function patternFor(id: string): string | undefined {
  return standardModelPrices.find((e) => e.id === id)?.matchPattern;
}

function pricingRegex(matchPattern: string): RegExp {
  return new RegExp(matchPattern.replace(/^\(\?i\)/, ""), "i");
}

describe("standard-model-prices.json Bedrock geo prefixes", () => {
  const claudeEntries = standardModelPrices.filter((e: StandardEntry) =>
    e.matchPattern.includes("anthropic\\.claude"),
  );

  it("includes au. and jp. in every Claude Bedrock-style matchPattern", () => {
    expect(claudeEntries.length).toBeGreaterThan(0);
    for (const e of claudeEntries) {
      expect(e.matchPattern, e.id).toContain("au\\.");
      expect(e.matchPattern, e.id).toContain("jp\\.");
    }
  });

  it("matches au. and jp. inference-style model IDs for Claude Sonnet 4.5", () => {
    const pattern = patternFor("tr-claude-sonnet-4-5");
    expect(pattern).toBeDefined();
    const re = pricingRegex(pattern!);
    const ids = [
      "au.anthropic.claude-sonnet-4-5-20250929-v1:0",
      "jp.anthropic.claude-sonnet-4-5-20250929-v1:0",
      "eu.anthropic.claude-sonnet-4-5-20250929-v1:0",
      "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    ];
    for (const id of ids) {
      expect(re.test(id), id).toBe(true);
    }
  });

  it("still matches unprefixed Bedrock IDs", () => {
    const pattern = patternFor("tr-claude-sonnet-4-5");
    expect(pattern).toBeDefined();
    const re = pricingRegex(pattern!);
    expect(re.test("anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe(true);
  });
});
