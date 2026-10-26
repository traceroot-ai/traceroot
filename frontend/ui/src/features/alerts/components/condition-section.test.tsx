// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent, within } from "@testing-library/react";

// Radix Select opens on pointerdown and relies on pointer-capture APIs jsdom
// doesn't implement.
window.HTMLElement.prototype.hasPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();
window.HTMLElement.prototype.scrollIntoView = vi.fn();

import { ConditionSection } from "./condition-section";

const baseProps = () => ({
  view: "SPANS" as const,
  measureId: "count",
  aggregation: "count" as const,
  operator: ">" as const,
  threshold: "5",
  window: "10m" as const,
  onMeasureChange: vi.fn(),
  onAggregationChange: vi.fn(),
  onOperatorChange: vi.fn(),
  onThresholdChange: vi.fn(),
  onWindowChange: vi.fn(),
});

const renderSection = (overrides: Partial<Parameters<typeof ConditionSection>[0]> = {}) => {
  const props = { ...baseProps(), ...overrides };
  render(<ConditionSection {...props} />);
  return props;
};

const openSelect = (label: string) =>
  fireEvent.pointerDown(screen.getByLabelText(label), { button: 0, pointerType: "mouse" });

describe("ConditionSection", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("emits the chosen measure", () => {
    const props = renderSection();
    openSelect("measure");
    fireEvent.click(screen.getByRole("option", { name: "Latency" }));
    expect(props.onMeasureChange).toHaveBeenCalledWith("latency");
  });

  it("emits the chosen aggregation", () => {
    const props = renderSection({ measureId: "latency", aggregation: "avg" });
    openSelect("aggregation");
    fireEvent.click(screen.getByRole("option", { name: "p95" }));
    expect(props.onAggregationChange).toHaveBeenCalledWith("p95");
  });

  it("emits the chosen operator", () => {
    const props = renderSection();
    openSelect("operator");
    fireEvent.click(screen.getByRole("option", { name: "≥" }));
    expect(props.onOperatorChange).toHaveBeenCalledWith(">=");
  });

  it("passes threshold keystrokes through unparsed", () => {
    const props = renderSection();
    fireEvent.change(screen.getByLabelText("threshold"), { target: { value: "12.5" } });
    expect(props.onThresholdChange).toHaveBeenCalledWith("12.5");
  });

  it("takes a negative threshold", () => {
    const props = renderSection();
    fireEvent.change(screen.getByLabelText("threshold"), { target: { value: "-3" } });
    expect(props.onThresholdChange).toHaveBeenCalledWith("-3");
  });

  it("reads the window as a lookback and emits the bare token", () => {
    const props = renderSection();
    // The sentence supplies the words, so the option is the token alone.
    expect(screen.getByText("over the last")).toBeTruthy();
    openSelect("window");
    expect(screen.getByRole("option", { name: "10m" })).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: "30m" }));
    expect(props.onWindowChange).toHaveBeenCalledWith("30m");
  });
});

describe("ConditionSection threshold unit", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  /** The bordered field the threshold input and its unit share. */
  const thresholdField = () => screen.getByLabelText("threshold").parentElement!;

  it("states latency in milliseconds", () => {
    renderSection({ measureId: "latency", aggregation: "p95" });
    expect(within(thresholdField()).getByText("ms")).toBeTruthy();
  });

  it("states cost in dollars, ahead of the number", () => {
    renderSection({ measureId: "cost", aggregation: "sum" });
    const field = thresholdField();
    expect(field.firstElementChild?.textContent).toBe("$");
    expect(field.lastElementChild).toBe(screen.getByLabelText("threshold"));
  });

  it("states a token rate per second", () => {
    renderSection({ measureId: "total_tokens_per_second", aggregation: "avg" });
    expect(within(thresholdField()).getByText("tok/s")).toBeTruthy();
  });

  it("shows no unit where the measure names itself", () => {
    renderSection({ measureId: "total_tokens", aggregation: "sum" });
    expect(thresholdField().children).toHaveLength(1);
  });

  it("drops the unit under an aggregation that discards it", () => {
    // uniq of a latency column counts distinct values; that number is not milliseconds.
    renderSection({ measureId: "latency", aggregation: "uniq" });
    expect(thresholdField().children).toHaveLength(1);
  });
});

describe("ConditionSection measure documentation", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

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
    const { container } = render(<ConditionSection {...baseProps()} />);
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
