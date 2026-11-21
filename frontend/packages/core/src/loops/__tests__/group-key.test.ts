import { describe, expect, it } from "vitest";
import { findingKeyOfGroupKey, loopSignalGroupKey } from "../pure.ts";

describe("a Loop signal's group key", () => {
  it("round-trips the finding key a run records", () => {
    expect(loopSignalGroupKey("timeout-in-search-tool")).toBe("loop:timeout-in-search-tool");
    expect(findingKeyOfGroupKey(loopSignalGroupKey("timeout-in-search-tool"))).toBe(
      "timeout-in-search-tool",
    );
  });

  it("finds no finding key in a detector signal's group key", () => {
    expect(findingKeyOfGroupKey(null)).toBeNull();
    expect(findingKeyOfGroupKey("tool_error")).toBeNull();
    expect(findingKeyOfGroupKey("loop:")).toBeNull();
  });
});
