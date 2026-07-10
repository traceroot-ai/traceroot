// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardDetail, Widget } from "../types";
import { WidgetBuilderPage } from "./WidgetBuilderPage";

// Radix Select opens on pointerdown and relies on pointer-capture APIs jsdom
// doesn't implement.
window.HTMLElement.prototype.hasPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();
window.HTMLElement.prototype.scrollIntoView = vi.fn();

const push = vi.fn();
const replace = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace }) }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

const createWidget: { mutate: ReturnType<typeof vi.fn>; isPending: boolean; error: Error | null } =
  { mutate: vi.fn(), isPending: false, error: null };
const updateWidget: { mutate: ReturnType<typeof vi.fn>; isPending: boolean; error: Error | null } =
  { mutate: vi.fn(), isPending: false, error: null };
vi.mock("../hooks/use-dashboards", () => ({
  useDashboard: vi.fn(),
  useDashboardMutations: () => ({ createWidget, updateWidget }),
}));
vi.mock("../hooks/use-widget-data", () => ({
  useWidgetSchema: () => ({ data: SCHEMA }),
  useWidgetPreview: vi.fn(),
  useWidgetFieldValues: () => ({ values: [], isLoading: false }),
}));
import { useDashboard } from "../hooks/use-dashboards";
import { useWidgetPreview } from "../hooks/use-widget-data";

const SCHEMA = {
  spans: {
    fields: {
      model_name: {
        type: "string",
        label: "Model",
        filterOps: ["=", "!=", "contains"],
        groupable: true,
        aggs: [],
      },
      cost: {
        type: "number",
        label: "Cost",
        filterOps: [">", ">="],
        groupable: false,
        aggs: ["sum", "avg"],
      },
      count: {
        type: "number",
        label: "Count",
        filterOps: [],
        groupable: false,
        aggs: ["count"],
        histogrammable: false,
      },
    },
  },
  traces: {
    fields: {
      cost: {
        type: "number",
        label: "Cost",
        filterOps: [">", ">="],
        groupable: false,
        aggs: ["sum", "avg"],
      },
      error_count: {
        type: "number",
        label: "Errors",
        filterOps: [">"],
        groupable: false,
        aggs: ["sum"],
      },
    },
  },
};

const WIDGET: Widget = {
  id: "w1",
  dashboardId: "d1",
  title: "My cost widget",
  type: "query",
  spec: {
    view: "spans",
    filters: [],
    metric: { measure: "cost", agg: "sum" },
    breakdown: null,
    display: { type: "number" },
  },
  displayConfig: {},
};

// Non-default: the builder is only reachable for editable dashboards — the
// default one redirects away, which its dedicated test covers.
const DASHBOARD = {
  id: "d1",
  name: "Custom",
  description: null,
  isDefault: false,
  updateTime: "",
  layout: [],
  widgets: [WIDGET],
} as DashboardDetail;

function mockDashboard(data: DashboardDetail | undefined, error: unknown = null) {
  vi.mocked(useDashboard).mockReturnValue({ data, error } as ReturnType<typeof useDashboard>);
}

function mockPreview(state: { isPending?: boolean; error?: unknown; data?: unknown }) {
  vi.mocked(useWidgetPreview).mockReturnValue({
    isPending: false,
    error: null,
    data: undefined,
    ...state,
  } as ReturnType<typeof useWidgetPreview>);
}

describe("WidgetBuilderPage", () => {
  afterEach(cleanup);
  beforeEach(() => {
    push.mockReset();
    replace.mockReset();
    createWidget.mutate.mockReset();
    createWidget.isPending = false;
    createWidget.error = null;
    updateWidget.mutate.mockReset();
    updateWidget.isPending = false;
    updateWidget.error = null;
    mockDashboard(DASHBOARD);
    mockPreview({});
  });

  it("renders the two config sections with save disabled on a fresh draft", () => {
    render(<WidgetBuilderPage projectId="p1" dashboardId="d1" />);
    expect(screen.getByText("Data selection")).toBeTruthy();
    expect(screen.getByText("Visualization")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save widget" })).toHaveProperty("disabled", true);
  });

  it("links back to the dashboard by name", () => {
    render(<WidgetBuilderPage projectId="p1" dashboardId="d1" />);
    const back = screen.getByRole("link", { name: /Custom/ });
    expect(back.getAttribute("href")).toBe("/projects/p1/dashboard/d1");
  });

  it("hydrates the form from the widget in edit mode and saves via update", () => {
    render(<WidgetBuilderPage projectId="p1" dashboardId="d1" widgetId="w1" />);
    const name = screen.getByPlaceholderText("Widget name") as HTMLInputElement;
    expect(name.value).toBe("My cost widget");

    const save = screen.getByRole("button", { name: "Save widget" });
    expect(save).toHaveProperty("disabled", false);
    fireEvent.click(save);

    expect(updateWidget.mutate).toHaveBeenCalledTimes(1);
    const [payload, options] = updateWidget.mutate.mock.calls[0];
    expect(payload).toMatchObject({ widgetId: "w1", title: "My cost widget" });
    options.onSuccess();
    expect(push).toHaveBeenCalledWith("/projects/p1/dashboard/d1");
  });

  it("keeps a manually edited name (lock) in edit mode", () => {
    render(<WidgetBuilderPage projectId="p1" dashboardId="d1" widgetId="w1" />);
    const name = screen.getByPlaceholderText("Widget name") as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Renamed" } });
    expect(name.value).toBe("Renamed");
    fireEvent.click(screen.getByRole("button", { name: "Save widget" }));
    expect(updateWidget.mutate.mock.calls[0][0]).toMatchObject({ title: "Renamed" });
  });

  it("redirects to the dashboard when the widget is missing or not a query widget", () => {
    render(<WidgetBuilderPage projectId="p1" dashboardId="d1" widgetId="nope" />);
    expect(replace).toHaveBeenCalledWith("/projects/p1/dashboard/d1");
  });

  it("redirects to the dashboard index when the dashboard failed to load", () => {
    mockDashboard(undefined, new Error("404"));
    render(<WidgetBuilderPage projectId="p1" dashboardId="d1" />);
    expect(replace).toHaveBeenCalledWith("/projects/p1/dashboard");
  });

  it("redirects back to the read-only default dashboard instead of opening the builder", () => {
    mockDashboard({ ...DASHBOARD, isDefault: true });
    render(<WidgetBuilderPage projectId="p1" dashboardId="d1" />);
    expect(replace).toHaveBeenCalledWith("/projects/p1/dashboard/d1");
  });

  function openSelect(currentText: string) {
    const trigger = screen.getByText(currentText).closest("button") as HTMLElement;
    fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
    return trigger;
  }

  it("offers Model from the traces view and switches to spans keeping a compatible measure", async () => {
    render(<WidgetBuilderPage projectId="p1" dashboardId="d1" />);

    openSelect("Select view");
    fireEvent.click(await screen.findByRole("option", { name: "Traces" }));
    openSelect("Measure");
    fireEvent.click(await screen.findByRole("option", { name: "Cost" }));

    openSelect("None");
    fireEvent.click(await screen.findByRole("option", { name: /Model/ }));

    // The view flipped to Spans and the measure survived (cost exists there).
    expect(screen.getByText("Spans")).toBeTruthy();
    expect(screen.getByText("Cost")).toBeTruthy();
    expect(screen.getByText("Model")).toBeTruthy();
  });

  it("clears a traces-only measure when Model switches the view to spans", async () => {
    render(<WidgetBuilderPage projectId="p1" dashboardId="d1" />);

    openSelect("Select view");
    fireEvent.click(await screen.findByRole("option", { name: "Traces" }));
    openSelect("Measure");
    fireEvent.click(await screen.findByRole("option", { name: "Errors" }));

    openSelect("None");
    fireEvent.click(await screen.findByRole("option", { name: /Model/ }));

    expect(screen.getByText("Spans")).toBeTruthy();
    // error_count doesn't exist on spans — the measure select resets.
    expect(screen.queryByText("Errors")).toBeNull();
    expect(screen.getByText("Measure")).toBeTruthy();
  });

  it("blocks the histogram display for a non-histogrammable measure", async () => {
    render(<WidgetBuilderPage projectId="p1" dashboardId="d1" />);

    openSelect("Select view");
    fireEvent.click(await screen.findByRole("option", { name: "Spans" }));

    // Measure picked first: the histogram button itself is disabled.
    openSelect("Measure");
    fireEvent.click(await screen.findByRole("option", { name: "Count" }));
    expect(screen.getByRole("button", { name: "histogram" })).toHaveProperty("disabled", true);

    // Reached the other way (display first, then the measure): warn + block save.
    openSelect("Count");
    fireEvent.click(await screen.findByRole("option", { name: "Cost" }));
    fireEvent.click(screen.getByRole("button", { name: "histogram" }));
    openSelect("Cost");
    fireEvent.click(await screen.findByRole("option", { name: "Count" }));

    expect(screen.getByText(/can't be histogrammed/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save widget" })).toHaveProperty("disabled", true);
  });

  it("warns and blocks save when pie/bar is picked without a breakdown", async () => {
    render(<WidgetBuilderPage projectId="p1" dashboardId="d1" />);

    openSelect("Select view");
    fireEvent.click(await screen.findByRole("option", { name: "Spans" }));
    openSelect("Measure");
    fireEvent.click(await screen.findByRole("option", { name: "Cost" }));
    fireEvent.click(screen.getByRole("button", { name: "pie" }));

    expect(screen.getByText("A pie chart needs a breakdown dimension")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save widget" })).toHaveProperty("disabled", true);

    // Picking a breakdown clears the warning and unblocks save.
    openSelect("None");
    fireEvent.click(await screen.findByRole("option", { name: "Model" }));
    expect(screen.queryByText("A pie chart needs a breakdown dimension")).toBeNull();
    expect(screen.getByRole("button", { name: "Save widget" })).toHaveProperty("disabled", false);
  });

  it("drives the form through view, measure, agg and display in create mode, then saves via create", async () => {
    render(<WidgetBuilderPage projectId="p1" dashboardId="d1" />);
    expect(screen.getByRole("button", { name: "Save widget" })).toHaveProperty("disabled", true);

    openSelect("Select view");
    fireEvent.click(await screen.findByRole("option", { name: "Spans" }));

    openSelect("Measure");
    fireEvent.click(await screen.findByRole("option", { name: "Cost" }));

    // Measure auto-picks the field's first aggregation (sum); pick a different
    // one explicitly to exercise the Agg select.
    openSelect("sum");
    fireEvent.click(await screen.findByRole("option", { name: "avg" }));

    fireEvent.click(screen.getByRole("button", { name: "number" }));

    const save = screen.getByRole("button", { name: "Save widget" });
    expect(save).toHaveProperty("disabled", false);
    fireEvent.click(save);

    expect(createWidget.mutate).toHaveBeenCalledTimes(1);
    const [payload, options] = createWidget.mutate.mock.calls[0];
    expect(payload).toEqual({
      title: "Avg Cost",
      type: "query",
      spec: {
        view: "spans",
        filters: [],
        metric: { measure: "cost", agg: "avg" },
        breakdown: null,
        display: { type: "number" },
      },
    });

    options.onSuccess();
    expect(push).toHaveBeenCalledWith("/projects/p1/dashboard/d1");
  });

  it("switches the selected display type and gates breakdown for number and histogram", () => {
    render(<WidgetBuilderPage projectId="p1" dashboardId="d1" widgetId="w1" />);
    const numberBtn = screen.getByRole("button", { name: "number" });
    const histogramBtn = screen.getByRole("button", { name: "histogram" });
    const barBtn = screen.getByRole("button", { name: "bar" });
    // the fixture widget is a number tile, so the gate notice shows immediately
    expect(numberBtn.className).toContain("bg-primary");
    expect(screen.getByText("Not available for this display type")).toBeTruthy();

    fireEvent.click(barBtn);
    expect(barBtn.className).toContain("bg-primary");
    expect(screen.queryByText("Not available for this display type")).toBeNull();

    fireEvent.click(histogramBtn);
    expect(histogramBtn.className).toContain("bg-primary");
    expect(numberBtn.className).not.toContain("bg-primary");
    expect(screen.getByText("Not available for this display type")).toBeTruthy();
  });

  it("clears an existing breakdown when number is selected", () => {
    render(<WidgetBuilderPage projectId="p1" dashboardId="d1" widgetId="w1" />);
    fireEvent.click(screen.getByRole("button", { name: "bar" }));
    openSelect("None");
    fireEvent.click(screen.getByRole("option", { name: "Model" }));
    fireEvent.click(screen.getByRole("button", { name: "number" }));
    fireEvent.click(screen.getByRole("button", { name: "Save widget" }));
    const [payload] = updateWidget.mutate.mock.calls.at(-1)!;
    expect(payload.spec.breakdown).toBeNull();
  });

  it("adds a filter row with '+ Add filter' and removes it via the row's remove button", () => {
    render(<WidgetBuilderPage projectId="p1" dashboardId="d1" widgetId="w1" />);
    expect(screen.queryByText("Field")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "＋ Add filter" }));
    expect(screen.getByText("Field")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove filter" }));
    expect(screen.queryByText("Field")).toBeNull();
  });

  it("changes the breakdown field and can reset it back to none", async () => {
    render(<WidgetBuilderPage projectId="p1" dashboardId="d1" widgetId="w1" />);

    // line allows a breakdown but doesn't require one, so both saves are valid.
    fireEvent.click(screen.getByRole("button", { name: "line" }));
    openSelect("None");
    fireEvent.click(await screen.findByRole("option", { name: "Model" }));

    fireEvent.click(screen.getByRole("button", { name: "Save widget" }));
    expect(updateWidget.mutate).toHaveBeenCalledTimes(1);
    expect(updateWidget.mutate.mock.calls[0][0]).toMatchObject({
      spec: expect.objectContaining({ breakdown: "model_name" }),
    });

    openSelect("Model");
    fireEvent.click(await screen.findByRole("option", { name: "None" }));

    fireEvent.click(screen.getByRole("button", { name: "Save widget" }));
    expect(updateWidget.mutate).toHaveBeenCalledTimes(2);
    expect(updateWidget.mutate.mock.calls[1][0]).toMatchObject({
      spec: expect.objectContaining({ breakdown: null }),
    });
  });

  it("does not fall through to create when editing and the widget disappears from the dashboard", () => {
    render(<WidgetBuilderPage projectId="p1" dashboardId="d1" widgetId="nope" />);
    const save = screen.getByRole("button", { name: "Save widget" });
    fireEvent.click(save);
    expect(createWidget.mutate).not.toHaveBeenCalled();
    expect(updateWidget.mutate).not.toHaveBeenCalled();
  });

  it("clears an existing breakdown when switching to histogram display before saving", async () => {
    render(<WidgetBuilderPage projectId="p1" dashboardId="d1" widgetId="w1" />);

    fireEvent.click(screen.getByRole("button", { name: "bar" }));
    openSelect("None");
    fireEvent.click(await screen.findByRole("option", { name: "Model" }));

    fireEvent.click(screen.getByRole("button", { name: "histogram" }));

    fireEvent.click(screen.getByRole("button", { name: "Save widget" }));
    expect(updateWidget.mutate).toHaveBeenCalledTimes(1);
    expect(updateWidget.mutate.mock.calls[0][0]).toMatchObject({
      spec: expect.objectContaining({ breakdown: null }),
    });
  });

  it("shows an inline error when the save mutation fails", () => {
    updateWidget.error = new Error("boom");
    render(<WidgetBuilderPage projectId="p1" dashboardId="d1" widgetId="w1" />);
    expect(screen.getByText("Failed to save widget: boom")).toBeTruthy();
  });

  it("shows a pending state while the preview query is in flight", () => {
    mockPreview({ isPending: true });
    render(<WidgetBuilderPage projectId="p1" dashboardId="d1" widgetId="w1" />);
    expect(screen.getByText("Running…")).toBeTruthy();
  });

  it("surfaces the preview query error message", () => {
    mockPreview({ error: new Error("bad query") });
    render(<WidgetBuilderPage projectId="p1" dashboardId="d1" widgetId="w1" />);
    expect(screen.getByText("bad query")).toBeTruthy();
  });

  it("renders the query result once preview data resolves", () => {
    vi.useFakeTimers();
    try {
      mockPreview({ data: { columns: ["value"], rows: [[42]], meta: {} } });
      render(<WidgetBuilderPage projectId="p1" dashboardId="d1" widgetId="w1" />);
      // The preview draft is debounced 400ms before the renderer picks it up.
      act(() => {
        vi.advanceTimersByTime(400);
      });
      // cost measure carries its $ unit through the preview renderer
      expect(screen.getByText("$42")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
