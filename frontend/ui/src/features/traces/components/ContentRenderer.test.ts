import { describe, it, expect } from "vitest";
import {
  AUTO_EXPAND_MAX_DEPTH,
  AUTO_EXPAND_MAX_ITEMS,
  AUTO_EXPAND_MAX_ITEMS_ROOT,
  STRING_TRUNCATE_AT,
  shouldAutoExpand,
  shouldTruncate,
  truncateString,
} from "./json-render-utils";

// These tests cover the pure policy that backs the span I/O renderer. The
// renderer expands shallow/small objects by default but collapses deep or large
// ones, and hides the tail of long strings behind a "show more" toggle, so
// selecting a span with a large (~300 KB) blob doesn't render thousands of
// expanded DOM nodes up front while a normal span stays readable on first
// paint. The vitest environment here is "node" (no DOM), so we assert the
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

  it("leaves a string of exactly the threshold length untouched (boundary)", () => {
    const exact = "x".repeat(STRING_TRUNCATE_AT);
    expect(truncateString(exact)).toBe(exact);
    // One char over is where truncation kicks in.
    expect(truncateString(exact + "y").length).toBe(STRING_TRUNCATE_AT);
  });

  it("never returns more than the threshold for any input", () => {
    for (const len of [
      STRING_TRUNCATE_AT - 1,
      STRING_TRUNCATE_AT,
      STRING_TRUNCATE_AT + 1,
      10_000,
    ]) {
      expect(truncateString("z".repeat(len)).length).toBeLessThanOrEqual(STRING_TRUNCATE_AT);
    }
  });
});

describe("shouldAutoExpand", () => {
  it("expands the root and other shallow, small nodes so a normal span reads on first paint", () => {
    expect(shouldAutoExpand(0, 1)).toBe(true);
    expect(shouldAutoExpand(0, AUTO_EXPAND_MAX_ITEMS_ROOT)).toBe(true);
    expect(shouldAutoExpand(1, AUTO_EXPAND_MAX_ITEMS)).toBe(true);
  });

  it("collapses large nodes so a big blob doesn't flood the DOM up front", () => {
    expect(shouldAutoExpand(0, AUTO_EXPAND_MAX_ITEMS_ROOT + 1)).toBe(false);
    expect(shouldAutoExpand(1, AUTO_EXPAND_MAX_ITEMS + 1)).toBe(false);
    // A 5k-item array stays collapsed regardless of depth.
    expect(shouldAutoExpand(0, 5000)).toBe(false);
  });

  it("collapses deeply nested nodes even when small", () => {
    expect(shouldAutoExpand(AUTO_EXPAND_MAX_DEPTH, 1)).toBe(true);
    expect(shouldAutoExpand(AUTO_EXPAND_MAX_DEPTH + 1, 1)).toBe(false);
  });

  it("gives the root a larger entry budget than nested nodes", () => {
    const between = AUTO_EXPAND_MAX_ITEMS + 1;
    expect(shouldAutoExpand(0, between)).toBe(true);
    expect(shouldAutoExpand(1, between)).toBe(false);
  });

  it("applies the depth and size guards together, not just one", () => {
    // A node at the deepest allowed level still collapses if it is also large,
    // so a deep-and-wide blob can't slip past on depth alone.
    expect(shouldAutoExpand(AUTO_EXPAND_MAX_DEPTH, AUTO_EXPAND_MAX_ITEMS)).toBe(true);
    expect(shouldAutoExpand(AUTO_EXPAND_MAX_DEPTH, AUTO_EXPAND_MAX_ITEMS + 1)).toBe(false);
  });

  it("treats empty nodes as expandable (the renderer short-circuits them anyway)", () => {
    expect(shouldAutoExpand(0, 0)).toBe(true);
    expect(shouldAutoExpand(5, 0)).toBe(true);
  });
});
