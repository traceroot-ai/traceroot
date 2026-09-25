// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { CostBreakdown } from "./CostBreakdown";

afterEach(() => cleanup());

describe("CostBreakdown baseline handling", () => {
  it("shows no delta when the baseline is null (no cost breakdown recorded), instead of treating it as an all-zero baseline", () => {
    render(<CostBreakdown details={{ output_cost: 0.5 }} baselineDetails={null} />);
    // The candidate cost is shown (Output cost / output / Total cost rows all read $0.5000)...
    expect(screen.getAllByText("$0.5000").length).toBeGreaterThan(0);
    // ...but no ± delta, since there is no real baseline to compare against.
    expect(screen.queryByText(/^\+\$/)).toBeNull();
    expect(screen.queryByText(/^−\$/)).toBeNull();
  });

  it("shows no delta when the baseline is undefined (diff mode inactive)", () => {
    render(<CostBreakdown details={{ output_cost: 0.5 }} />);
    expect(screen.queryByText(/^\+\$/)).toBeNull();
  });

  it("still shows a delta for a genuine all-zero baseline object", () => {
    render(<CostBreakdown details={{ output_cost: 0.5 }} baselineDetails={{}} />);
    expect(screen.getAllByText("+$0.5000").length).toBeGreaterThan(0);
  });
});
