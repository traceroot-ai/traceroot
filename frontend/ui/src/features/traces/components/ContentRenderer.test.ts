import { describe, it, expect } from "vitest";
import { STRING_TRUNCATE_AT, shouldTruncate, truncateString } from "./json-render-utils";

// These tests cover the pure truncation policy that backs the span I/O
// renderer. The renderer collapses nested objects/arrays by default and hides
// the tail of long strings behind a "show more" toggle so selecting a span
// with a large (~300 KB) blob doesn't render thousands of expanded DOM nodes
// up front. The vitest environment here is "node" (no DOM), so we assert the
// policy rather than the rendered output.

describe("shouldTruncate", () => {
  it("leaves short strings untouched", () => {
    expect(shouldTruncate("")).toBe(false);
    expect(shouldTruncate("hello world")).toBe(false);
    expect(shouldTruncate("x".repeat(STRING_TRUNCATE_AT))).toBe(false);
  });

  it("truncates strings longer than the threshold", () => {
    expect(shouldTruncate("x".repeat(STRING_TRUNCATE_AT + 1))).toBe(true);
    // A realistic large-blob field is well over the threshold.
    expect(shouldTruncate("a".repeat(300_000))).toBe(true);
  });
});

describe("truncateString", () => {
  it("returns short strings unchanged", () => {
    expect(truncateString("hello")).toBe("hello");
  });

  it("caps long strings at the threshold so the DOM payload stays bounded", () => {
    const huge = "a".repeat(300_000);
    const visible = truncateString(huge);
    expect(visible.length).toBe(STRING_TRUNCATE_AT);
    expect(huge.length).toBeGreaterThan(visible.length);
  });

  it("preserves the leading content that is shown while collapsed", () => {
    const value = "PREFIX-" + "x".repeat(STRING_TRUNCATE_AT);
    expect(truncateString(value).startsWith("PREFIX-")).toBe(true);
    expect(truncateString(value).length).toBe(STRING_TRUNCATE_AT);
  });
});
