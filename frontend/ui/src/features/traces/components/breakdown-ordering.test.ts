import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TokenUsageBreakdown } from "./TokenUsageBreakdown";
import { CostBreakdown } from "./CostBreakdown";

// Both panels split input into the same three categories; they must render
// them with the same labels in the same order (uncached, then cache read,
// then cache write) so the token and dollar views line up when read side by
// side.
function labelOrder(markup: string, labels: string[]): number[] {
  return labels.map((label) => markup.indexOf(`>${label}<`));
}

describe("breakdown row ordering", () => {
  it("orders token input rows uncached, cache read, cache write", () => {
    const markup = renderToStaticMarkup(
      createElement(TokenUsageBreakdown, {
        inputTokens: 1000,
        outputTokens: 200,
        totalTokens: 1200,
        cacheReadTokens: 300,
        cacheWriteTokens: 100,
      }),
    );
    const [uncached, read, write] = labelOrder(markup, ["uncached", "cache read", "cache write"]);
    expect(uncached).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(uncached);
    expect(write).toBeGreaterThan(read);
  });

  it("orders cost input rows uncached, cache read, cache write", () => {
    const markup = renderToStaticMarkup(
      createElement(CostBreakdown, {
        details: {
          input_uncached_cost: 0.01,
          cache_read_cost: 0.002,
          cache_write_cost: 0.003,
          output_cost: 0.05,
        },
      }),
    );
    const [uncached, read, write] = labelOrder(markup, ["uncached", "cache read", "cache write"]);
    expect(uncached).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(uncached);
    expect(write).toBeGreaterThan(read);
  });
});
