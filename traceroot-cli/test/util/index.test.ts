import { describe, it, expect } from "vitest";
import { formatTimestamp, truncate, plural, formatDuration } from "../../src/util/index.js";

describe("truncate", () => {
  it("returns the string unchanged when it fits within maxLen", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("returns the string unchanged when length equals maxLen", () => {
    expect(truncate("hello", 5)).toBe("hello");
  });

  it("truncates long strings and appends an ellipsis character", () => {
    const result = truncate("hello world", 8);
    expect(result).toHaveLength(8);
    expect(result.endsWith("…")).toBe(true);
  });
});

describe("plural", () => {
  it("returns the singular form for count = 1", () => {
    expect(plural(1, "trace")).toBe("trace");
  });

  it("returns the auto-pluralised form for count != 1", () => {
    expect(plural(0, "trace")).toBe("traces");
    expect(plural(2, "trace")).toBe("traces");
  });

  it("uses the explicit plural form when provided", () => {
    expect(plural(2, "query", "queries")).toBe("queries");
    expect(plural(1, "query", "queries")).toBe("query");
  });
});

describe("formatDuration", () => {
  it("shows milliseconds for values < 1 000ms", () => {
    expect(formatDuration(42)).toBe("42ms");
    expect(formatDuration(999)).toBe("999ms");
  });

  it("shows seconds (2 decimal places) for values >= 1 000ms", () => {
    expect(formatDuration(1000)).toBe("1.00s");
    expect(formatDuration(1500)).toBe("1.50s");
    expect(formatDuration(12345)).toBe("12.35s");
  });
});

describe("formatTimestamp", () => {
  it("returns the original string for an invalid date", () => {
    expect(formatTimestamp("not-a-date")).toBe("not-a-date");
  });

  it("returns a non-empty, formatted string for a valid ISO date", () => {
    const result = formatTimestamp("2024-01-15T10:30:00Z");
    expect(result).toBeTruthy();
    // Should not return the raw ISO string unchanged.
    expect(result).not.toBe("2024-01-15T10:30:00Z");
  });
});
