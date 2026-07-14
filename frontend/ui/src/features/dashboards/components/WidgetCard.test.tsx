// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TimeRange, Widget } from "../types";
import { WidgetCard } from "./WidgetCard";

// Radix DropdownMenu opens on pointerdown and relies on pointer-capture APIs
// jsdom doesn't implement.
window.HTMLElement.prototype.hasPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();
window.HTMLElement.prototype.scrollIntoView = vi.fn();

const useWidgetData = vi.fn();
vi.mock("../hooks/use-widget-data", () => ({
  useWidgetData: (...args: unknown[]) => useWidgetData(...args),
}));

vi.mock("./TraceFeedWidget", () => ({
  TraceFeedWidget: (props: { projectId: string; spec: { limit?: number }; range: TimeRange }) => (
    <div data-testid="trace-feed-widget">
      {props.projectId}:{JSON.stringify(props.spec)}
    </div>
  ),
}));

const RANGE: TimeRange = {
  start: new Date("2026-06-01T00:00:00Z"),
  end: new Date("2026-06-02T00:00:00Z"),
};

const VALID_SPEC = {
  view: "spans",
  filters: [],
  metric: { measure: "count", agg: "count" },
  breakdown: null,
  display: { type: "number" },
};

function makeWidget(overrides: Partial<Widget> = {}): Widget {
  return {
    id: "w1",
    dashboardId: "d1",
    title: "My widget",
    type: "query",
    spec: VALID_SPEC,
    displayConfig: {},
    ...overrides,
  };
}

function renderCard(
  widget: Widget,
  callbacks: Partial<{ onEdit: () => void; onDelete: () => void }> = {},
) {
  const onEdit = callbacks.onEdit ?? vi.fn();
  const onDelete = callbacks.onDelete ?? vi.fn();
  render(
    <WidgetCard projectId="p1" widget={widget} range={RANGE} onEdit={onEdit} onDelete={onDelete} />,
  );
  return { onEdit, onDelete };
}

async function openMenu() {
  fireEvent.pointerDown(screen.getByRole("button", { name: "Widget options" }), {
    button: 0,
    pointerType: "mouse",
  });
  await screen.findByRole("menu");
}

describe("WidgetCard menu gating", () => {
  afterEach(cleanup);

  it("shows Edit for a query widget and wires it to onEdit", async () => {
    useWidgetData.mockReturnValue({ data: undefined, isPending: false, error: null });
    const { onEdit } = renderCard(makeWidget());

    await openMenu();
    const edit = screen.getByRole("menuitem", { name: "Edit" });
    fireEvent.click(edit);

    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it("hides Edit for a non-query widget", async () => {
    renderCard(makeWidget({ type: "trace_feed", spec: { limit: 5 } }));

    await openMenu();
    expect(screen.queryByRole("menuitem", { name: "Edit" })).toBeNull();
  });

  it("always shows Delete wired to its callback, and no Duplicate item", async () => {
    useWidgetData.mockReturnValue({ data: undefined, isPending: false, error: null });
    const { onDelete } = renderCard(makeWidget());

    await openMenu();
    expect(screen.queryByRole("menuitem", { name: "Duplicate" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("still shows Delete for a non-query widget", async () => {
    const { onDelete } = renderCard(makeWidget({ type: "trace_feed", spec: { limit: 5 } }));

    await openMenu();
    expect(screen.queryByRole("menuitem", { name: "Duplicate" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});

describe("WidgetCard body dispatch", () => {
  afterEach(cleanup);

  it("renders a query widget's data via useWidgetData", () => {
    useWidgetData.mockReturnValue({
      data: { columns: ["value"], rows: [[42]], meta: {} },
      isPending: false,
      error: null,
    });

    renderCard(makeWidget());

    expect(screen.getByText("42")).toBeTruthy();
  });

  it("shows a loading state while the query is in flight", () => {
    useWidgetData.mockReturnValue({ data: undefined, isPending: true, error: null });

    renderCard(makeWidget());

    expect(screen.getByText("Loading…")).toBeTruthy();
  });

  it("shows a query error message", () => {
    useWidgetData.mockReturnValue({ data: undefined, isPending: false, error: new Error("boom") });

    renderCard(makeWidget());

    expect(screen.getByText("Query failed: boom")).toBeTruthy();
  });

  it("shows an invalid-spec message and disables the query when the spec fails to parse", () => {
    useWidgetData.mockReturnValue({ data: undefined, isPending: false, error: null });

    renderCard(makeWidget({ spec: { view: "spans" } }));

    expect(screen.getByText("Invalid widget spec — edit to fix")).toBeTruthy();
    const [, , , , enabled] = useWidgetData.mock.calls[useWidgetData.mock.calls.length - 1];
    expect(enabled).toBe(false);
  });

  it("dispatches trace_feed widgets to TraceFeedWidget", () => {
    renderCard(makeWidget({ type: "trace_feed", spec: { limit: 5 } }));

    const body = screen.getByTestId("trace-feed-widget");
    expect(body.textContent).toBe('p1:{"limit":5}');
  });
});
