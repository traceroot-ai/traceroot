import { describe, it, expect } from "vitest";
import { formatTokenFlow, formatExactTokens } from "../utils";

describe("formatTokenFlow", () => {
  it("renders input → output (total) with compact formatting", () => {
    expect(formatTokenFlow(12300, 4100, 16400)).toBe("12.3K → 4.1K (16.4K)");
  });

  it("derives total from input + output when total is omitted", () => {
    expect(formatTokenFlow(1000, 500)).toBe("1K → 500 (1.5K)");
  });

  it("renders missing values as '-' rather than a misleading zero", () => {
    expect(formatTokenFlow(null, undefined)).toBe("- → - (-)");
    // A present side still shows; total derives from the present value(s).
    expect(formatTokenFlow(null, 500)).toBe("- → 500 (500)");
  });
});

describe("formatExactTokens", () => {
  it("formats exact counts with en-US grouping", () => {
    expect(formatExactTokens(4514)).toBe("4,514");
    expect(formatExactTokens(1000000)).toBe("1,000,000");
  });
  it("treats null/undefined as 0", () => {
    expect(formatExactTokens(null)).toBe("0");
    expect(formatExactTokens(undefined)).toBe("0");
  });
});
