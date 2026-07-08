// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WidgetSchemaField } from "../types";
import { FilterRow } from "./FilterRow";

vi.mock("../hooks/use-widget-data", () => ({ useWidgetFieldValues: vi.fn() }));
import { useWidgetFieldValues } from "../hooks/use-widget-data";

const stringField: WidgetSchemaField = {
  type: "string",
  label: "Model",
  filterOps: ["=", "!=", "contains"],
  groupable: true,
  aggs: [],
};
const numberField: WidgetSchemaField = {
  type: "number",
  label: "Cost",
  filterOps: [">", ">=", "<", "<=", "=", "!="],
  groupable: false,
  aggs: ["sum"],
};
const durationField: WidgetSchemaField = { ...numberField, label: "Duration" };

const baseProps = {
  index: 0,
  filterableFields: [
    ["model_name", stringField],
    ["cost", numberField],
    ["duration_ms", durationField],
  ] as [string, WidgetSchemaField][],
  fieldsMap: { model_name: stringField, cost: numberField, duration_ms: durationField },
  onChange: vi.fn(),
  onRemove: vi.fn(),
  projectId: "p1",
  view: "spans" as const,
  range: { start: new Date("2026-06-01T00:00:00Z"), end: new Date("2026-06-02T00:00:00Z") },
};

describe("FilterRow value input", () => {
  // RTL auto-cleanup needs vitest globals, which this config doesn't enable.
  afterEach(cleanup);

  it("offers stored values with counts for string equality, and selecting one propagates", () => {
    vi.mocked(useWidgetFieldValues).mockReturnValue({
      values: [{ value: "gpt-4o", count: 3 }],
      isLoading: false,
    });
    const onChange = vi.fn();
    render(
      <FilterRow
        {...baseProps}
        onChange={onChange}
        filter={{ field: "model_name", op: "=", value: "" }}
      />,
    );
    // field + op selects; the value control is the trace-list popover dropdown
    expect(screen.getAllByRole("combobox")).toHaveLength(2);
    expect(screen.queryByRole("textbox")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Value" }));
    const option = screen.getByRole("option", { name: /gpt-4o/ });
    // the stored value's occurrence count is shown alongside it
    expect(option.textContent).toContain("3");
    fireEvent.click(option);
    expect(onChange).toHaveBeenCalledWith(0, { value: "gpt-4o" });
  });

  it("keeps free text for contains", () => {
    vi.mocked(useWidgetFieldValues).mockReturnValue({ values: [], isLoading: false });
    render(
      <FilterRow {...baseProps} filter={{ field: "model_name", op: "contains", value: "gp" }} />,
    );
    expect(screen.getAllByRole("combobox")).toHaveLength(2);
    expect(screen.getByRole("textbox")).toBeTruthy();
    // the hook is parked while the op is not enumerable
    expect(vi.mocked(useWidgetFieldValues).mock.lastCall?.[4]).toBe(false);
  });

  it("falls back to free text when no stored values exist", () => {
    vi.mocked(useWidgetFieldValues).mockReturnValue({ values: [], isLoading: false });
    render(<FilterRow {...baseProps} filter={{ field: "model_name", op: "=", value: "" }} />);
    expect(screen.getAllByRole("combobox")).toHaveLength(2);
    expect(screen.getByRole("textbox")).toBeTruthy();
  });

  it("keeps the number input for numeric fields", () => {
    vi.mocked(useWidgetFieldValues).mockReturnValue({ values: [], isLoading: false });
    render(<FilterRow {...baseProps} filter={{ field: "cost", op: ">", value: 5 }} />);
    expect(screen.getByRole("spinbutton")).toBeTruthy();
    expect(vi.mocked(useWidgetFieldValues).mock.lastCall?.[4]).toBe(false);
  });

  it("shows trace-list wording for string ops and symbols for numeric ops", () => {
    vi.mocked(useWidgetFieldValues).mockReturnValue({ values: [], isLoading: false });
    const { unmount } = render(
      <FilterRow {...baseProps} filter={{ field: "model_name", op: "=", value: "" }} />,
    );
    expect(screen.getByText("is")).toBeTruthy();
    unmount();

    render(<FilterRow {...baseProps} filter={{ field: "cost", op: ">=", value: 5 }} />);
    expect(screen.getByText("≥")).toBeTruthy();
  });

  it("adorns cost and duration values with their unit like the trace-list builder", () => {
    vi.mocked(useWidgetFieldValues).mockReturnValue({ values: [], isLoading: false });
    const { unmount } = render(
      <FilterRow {...baseProps} filter={{ field: "cost", op: ">", value: 1 }} />,
    );
    expect(screen.getByText("$")).toBeTruthy();
    unmount();

    render(<FilterRow {...baseProps} filter={{ field: "duration_ms", op: ">", value: 100 }} />);
    expect(screen.getByText("ms")).toBeTruthy();
  });

  it("free-text edits still propagate through onChange", () => {
    vi.mocked(useWidgetFieldValues).mockReturnValue({ values: [], isLoading: false });
    const onChange = vi.fn();
    render(
      <FilterRow
        {...baseProps}
        onChange={onChange}
        filter={{ field: "model_name", op: "contains", value: "" }}
      />,
    );
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "claude" } });
    expect(onChange).toHaveBeenCalledWith(0, { value: "claude" });
  });
});
