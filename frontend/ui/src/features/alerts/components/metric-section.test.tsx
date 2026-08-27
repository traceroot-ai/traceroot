// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent, within } from "@testing-library/react";

// Radix Select opens on pointerdown and relies on pointer-capture APIs jsdom
// doesn't implement.
window.HTMLElement.prototype.hasPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();
window.HTMLElement.prototype.scrollIntoView = vi.fn();

vi.mock("@/features/dashboards/hooks/use-widget-data", () => ({
  // The filter field list comes from the widget engine's live schema; none here.
  useWidgetSchema: () => ({ data: undefined }),
  useWidgetFieldValues: () => ({ values: [], isLoading: false }),
}));

import { MetricSection } from "./metric-section";
import type { AlertAggregation } from "../rule-model";

describe("MetricSection measure documentation", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  const renderSection = (measureId = "count", aggregation: AlertAggregation = "count") =>
    render(
      <MetricSection
        projectId="proj-1"
        view="SPANS"
        measureId={measureId}
        aggregation={aggregation}
        filters={[]}
        onMeasureChange={vi.fn()}
        onAggregationChange={vi.fn()}
        onFiltersChange={vi.fn()}
      />,
    );

  function openMeasures() {
    fireEvent.pointerDown(screen.getByLabelText("measure"), { button: 0, pointerType: "mouse" });
  }

  async function hoverOption(name: string) {
    const option = await screen.findByRole("option", { name });
    fireEvent.pointerMove(option, { pointerType: "mouse" });
    return option;
  }

  /** The opened panel, scoped by role: Radix renders the tooltip child twice. */
  async function hoverPanelFor(name: string) {
    await hoverOption(name);
    return within(await screen.findByRole("tooltip"));
  }

  it("shows the unit, type and description when hovering a measure", async () => {
    renderSection();
    openMeasures();
    const panel = await hoverPanelFor("Latency");

    expect(panel.getByText("Unit: Milliseconds")).toBeTruthy();
    expect(panel.getByText("Type: Number")).toBeTruthy();
    expect(
      panel.getByText("Elapsed time of one span, from its start time to its end time."),
    ).toBeTruthy();
  });

  it("shows what Count counts, and types it as the integer it produces", async () => {
    renderSection();
    openMeasures();
    const panel = await hoverPanelFor("Count");

    expect(panel.getByText("Unit: Spans")).toBeTruthy();
    expect(panel.getByText("Type: Integer")).toBeTruthy();
    expect(panel.getByText("Number of spans in the window.")).toBeTruthy();
  });

  it("tells the user which aggregation makes an id measure meaningful", async () => {
    renderSection();
    openMeasures();
    const panel = await hoverPanelFor("Trace ID");

    expect(panel.getByText("Unit: Traces")).toBeTruthy();
    expect(panel.getByText("Type: String")).toBeTruthy();
    expect(
      panel.getByText(
        "Trace identifier recorded on every span; aggregate with uniq to count distinct traces.",
      ),
    ).toBeTruthy();
  });

  it("carries no availability caveat on the unique-id measures", async () => {
    // Both compute through the traces view now, so the panel must not claim data is missing.
    renderSection();
    openMeasures();
    const panel = await hoverPanelFor("Unique user ids");

    expect(
      panel.getByText(
        "Identifier of the user a trace belongs to; aggregate with uniq to count distinct users.",
      ),
    ).toBeTruthy();
    expect(panel.queryByText(/Not available yet/)).toBeNull();
  });

  it("renders the panel outside the form, so no scroll container can clip it", async () => {
    // The panel survives the page's scroll containers only because Radix portals it to the body.
    const { container } = renderSection();
    openMeasures();
    await hoverPanelFor("Cost");

    const panelRoot = screen.getByRole("tooltip").closest("[data-radix-popper-content-wrapper]");
    expect(panelRoot).not.toBeNull();
    expect(panelRoot?.parentElement).toBe(document.body);
    expect(container.contains(panelRoot)).toBe(false);
  });

  it("leaves the option label itself unchanged, so the dropdown stays scannable", async () => {
    renderSection();
    openMeasures();
    const option = await hoverOption("Total tokens per second");
    expect(option.textContent).toBe("Total tokens per second");
  });
});
