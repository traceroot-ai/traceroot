// @vitest-environment jsdom
import { afterEach, describe, it, expect } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

import { analyzeBreakdown, BreakdownChart } from "./breakdown-chart";

afterEach(cleanup);

// Drive the render tests through the real detection path (table text ->
// analyzeBreakdown -> BreakdownChart) instead of hand-authoring the parsed
// shape, so they exercise the same pipeline the app uses at runtime.
const DATA = analyzeBreakdown(
  ["Stage", "Duration", "Percentage", "Issue"],
  [
    ["Data loading", "33s", "27%", "Cold cache"],
    ["Model inference", "65s", "53%", "Serial calls"],
    ["Result write", "26s", "21%", ""],
  ],
)!;

describe("BreakdownChart", () => {
  it("renders a donut, per-stage labels and values, and preserves extras", () => {
    const { container } = render(
      <BreakdownChart data={DATA} rawTable={<div>RAW TABLE</div>} copyValue="x" />,
    );
    // Donut svg present
    expect(container.querySelector("svg")).not.toBeNull();
    // Stage labels + value labels rendered
    expect(screen.getByText("Model inference")).toBeTruthy();
    expect(screen.getByText("65s · 53%")).toBeTruthy();
    // Extra column (issue) preserved inline
    expect(screen.getByText("Cold cache")).toBeTruthy();
  });

  it("keeps the raw table behind a toggle", () => {
    render(<BreakdownChart data={DATA} rawTable={<div>RAW TABLE</div>} copyValue="x" />);
    expect(screen.queryByText("RAW TABLE")).toBeNull();
    fireEvent.click(screen.getByText("Show table"));
    expect(screen.getByText("RAW TABLE")).toBeTruthy();
  });
});
