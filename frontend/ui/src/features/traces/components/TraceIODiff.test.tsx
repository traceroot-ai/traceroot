// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { TraceIODiffSection } from "./TraceIODiff";

afterEach(() => cleanup());

describe("TraceIODiffSection", () => {
  it("shows a spinner instead of a diff while loading, so an unresolved fetch isn't rendered as an all-added/all-removed diff", () => {
    render(<TraceIODiffSection title="Input" baseline={null} candidate="hello" loading />);
    expect(screen.getByText("Loading…")).toBeDefined();
    expect(screen.queryByText("hello")).toBeNull();
    expect(screen.queryByText("+ candidate")).toBeNull();
  });

  it("renders the real diff once loading finishes", () => {
    render(<TraceIODiffSection title="Input" baseline="a" candidate="b" />);
    expect(screen.queryByText("Loading…")).toBeNull();
    expect(screen.getByText("a")).toBeDefined();
    expect(screen.getByText("b")).toBeDefined();
  });

  it("falls back to a flat diff with a truncation note when the alignment would be too large", () => {
    // Past MAX_DIFF_CELLS the diff bails out to all-remove/all-add instead of an
    // O(m*n) LCS table; each side here is 2000 lines, well over the threshold
    // relative to a normal small eval value but still fast for a unit test since
    // the fallback skips the DP table entirely.
    const baseline = Array.from({ length: 2000 }, (_, i) => `old-${i}`).join("\n");
    const candidate = Array.from({ length: 2000 }, (_, i) => `new-${i}`).join("\n");
    render(<TraceIODiffSection title="Output" baseline={baseline} candidate={candidate} />);
    expect(screen.getByText(/Too large to diff line-by-line/)).toBeDefined();
  });
});
