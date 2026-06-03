import { describe, it, expect } from "vitest";
import { formatTokenFlow } from "../utils";

describe("formatTokenFlow", () => {
  it("renders input → output (total) with compact formatting", () => {
    expect(formatTokenFlow(12300, 4100, 16400)).toBe("12.3K → 4.1K (16.4K)");
  });

  it("derives total from input + output when total is omitted", () => {
    expect(formatTokenFlow(1000, 500)).toBe("1K → 500 (1.5K)");
  });

  it("treats null/undefined inputs as zero", () => {
    expect(formatTokenFlow(null, undefined)).toBe("0 → 0 (0)");
  });
});
