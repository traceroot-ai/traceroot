import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TokenUsageBreakdown, buildExtraRows } from "./TokenUsageBreakdown";
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

  it("renders extra/unrecognized usage keys in Other usage section", () => {
    const markup = renderToStaticMarkup(
      createElement(TokenUsageBreakdown, {
        inputTokens: 1000,
        outputTokens: 200,
        totalTokens: 1200,
        cacheReadTokens: 300,
        cacheWriteTokens: 100,
        usageDetails: {
          "extra:audio_tokens": 150,
          "extra:image_tokens": 75,
        },
      }),
    );
    expect(markup).toContain("Other usage");
    expect(markup).toContain("audio tokens");
    expect(markup).toContain("image tokens");
    expect(markup).toContain("150");
    expect(markup).toContain("75");
  });

  it("disambiguates extra keys whose humanized labels collide", () => {
    // Distinct keys that humanize to the same label must keep unique identities
    // and distinct labels — otherwise React sees duplicate keys and row
    // reconciliation breaks on live-trace updates.
    const rows = buildExtraRows({
      "extra:some_key": 1,
      "extra:some key": 2,
      "extra:audio_tokens": 3,
    });
    const keys = rows.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    const labels = rows.map((r) => r.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toContain("some key (extra:some_key)");
    expect(labels).toContain("some key (extra:some key)");
    expect(labels).toContain("audio tokens");
  });

  it("renders colliding extra keys as distinct rows", () => {
    const markup = renderToStaticMarkup(
      createElement(TokenUsageBreakdown, {
        inputTokens: 100,
        outputTokens: 0,
        totalTokens: 100,
        usageDetails: {
          "extra:some_key": 1,
          "extra:some key": 2,
        },
      }),
    );
    expect(markup).toContain("some key (extra:some_key)");
    expect(markup).toContain("some key (extra:some key)");
  });
});
