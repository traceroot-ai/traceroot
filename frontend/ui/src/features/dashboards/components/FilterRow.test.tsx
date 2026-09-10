// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WidgetSchemaField } from "../types";
import { Dropdown, FilterControlSizeProvider } from "@/features/filters/filter-controls";
import { FilterRow } from "./FilterRow";

vi.mock("../hooks/use-widget-data", () => ({ useWidgetFieldValues: vi.fn() }));
import { useWidgetFieldValues } from "../hooks/use-widget-data";

// The key combobox suggests keys from the discovery endpoint; stubbed to test layout only.
vi.mock("@/features/filters/hooks", () => ({
  useMetadataKeys: () => ({ keys: [{ value: "tenant_id", count: 4 }], isLoading: false }),
}));

const stringField: WidgetSchemaField = {
  type: "string",
  label: "Model",
  filterOps: ["=", "contains"],
  groupable: true,
  aggs: [],
};
const numberField: WidgetSchemaField = {
  type: "number",
  label: "Cost",
  filterOps: [">", ">=", "<", "<=", "="],
  groupable: false,
  aggs: ["sum"],
};
const durationField: WidgetSchemaField = { ...numberField, label: "Duration" };
const keyedField: WidgetSchemaField = {
  type: "string",
  label: "Metadata",
  filterOps: ["=", "contains"],
  groupable: false,
  aggs: [],
  requiresKey: true,
};

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

  it("shows a saved row as text with a spinner while the field registry is still loading", () => {
    vi.mocked(useWidgetFieldValues).mockReturnValue({ values: [], isLoading: false });
    render(
      <FilterRow
        {...baseProps}
        filterableFields={[]}
        fieldsMap={{}}
        fieldsLoading
        filter={{ field: "metadata", key: "tenant", op: "=", value: "acme" }}
      />,
    );
    const row = screen.getByRole("status", { name: "Loading filter fields" });
    // the saved predicate is legible as-is: not an empty field dropdown
    expect(row.textContent).toContain("metadata[tenant] = acme");
    expect(row.textContent).toContain("Loading fields");
    expect(screen.queryByRole("button", { name: "Field" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove filter" })).toBeNull();
  });

  it("names a saved field the resolved registry does not know, and keeps it removable", () => {
    vi.mocked(useWidgetFieldValues).mockReturnValue({ values: [], isLoading: false });
    const onRemove = vi.fn();
    render(
      <FilterRow
        {...baseProps}
        onRemove={onRemove}
        filter={{ field: "retired_field", op: "=", value: "x" }}
      />,
    );
    const row = screen.getByRole("alert", { name: "Unknown filter field" });
    expect(row.textContent).toContain("retired_field = x");
    expect(row.textContent).toContain("Unknown field");
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove filter" }));
    expect(onRemove).toHaveBeenCalledWith(0);
  });

  it("says the registry is unavailable, and keeps the row removable, when its request failed", () => {
    vi.mocked(useWidgetFieldValues).mockReturnValue({ values: [], isLoading: false });
    const onRemove = vi.fn();
    render(
      <FilterRow
        {...baseProps}
        filterableFields={[]}
        fieldsMap={{}}
        fieldsUnavailable
        onRemove={onRemove}
        filter={{ field: "model_name", op: "=", value: "gpt-4o" }}
      />,
    );
    const row = screen.getByRole("alert", { name: "Filter fields unavailable" });
    expect(row.textContent).toContain("model_name = gpt-4o");
    expect(row.textContent).toContain("Fields unavailable");
    // not blamed on the field: the registry never answered
    expect(row.textContent).not.toContain("Unknown field");
    fireEvent.click(screen.getByRole("button", { name: "Remove filter" }));
    expect(onRemove).toHaveBeenCalledWith(0);
  });

  it("names an unknown field even when the resolved registry offers no fields at all", () => {
    vi.mocked(useWidgetFieldValues).mockReturnValue({ values: [], isLoading: false });
    render(
      <FilterRow
        {...baseProps}
        filterableFields={[]}
        fieldsMap={{}}
        filter={{ field: "retired_field", op: "=", value: "x" }}
      />,
    );
    expect(screen.getByRole("alert", { name: "Unknown filter field" })).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("renders the controls for an empty row even while the registry is loading", () => {
    vi.mocked(useWidgetFieldValues).mockReturnValue({ values: [], isLoading: false });
    render(
      <FilterRow
        {...baseProps}
        filterableFields={[]}
        fieldsMap={{}}
        fieldsLoading
        filter={{ field: "", op: "", value: "" }}
      />,
    );
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: "Field" })).toBeTruthy();
  });

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
    // the value control is the trace-list popover dropdown, not a free input
    expect(screen.queryByRole("textbox")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Enter value" }));
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
    expect(screen.getByRole("textbox")).toBeTruthy();
    // the hook is parked while the op is not enumerable
    expect(vi.mocked(useWidgetFieldValues).mock.lastCall?.[4]).toBe(false);
  });

  it("keeps the value dropdown for string equality when no stored values exist", () => {
    vi.mocked(useWidgetFieldValues).mockReturnValue({ values: [], isLoading: false });
    render(<FilterRow {...baseProps} filter={{ field: "model_name", op: "=", value: "" }} />);
    // an empty field must not offer a free input that a first keystroke would
    // then swap out from under the user
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Enter value" }));
    expect(screen.getByText("No options")).toBeTruthy();
  });

  it("keeps the number input for numeric fields", () => {
    vi.mocked(useWidgetFieldValues).mockReturnValue({ values: [], isLoading: false });
    render(<FilterRow {...baseProps} filter={{ field: "cost", op: ">", value: 5 }} />);
    const input = screen.getByRole("spinbutton");
    expect(input).toBeTruthy();
    // the widget builder hosts the shared controls at its compact 12px size
    expect(input.className).toContain("text-[12px]");
    expect(vi.mocked(useWidgetFieldValues).mock.lastCall?.[4]).toBe(false);
  });

  it("rejects negative numeric input like the trace-list builder", () => {
    vi.mocked(useWidgetFieldValues).mockReturnValue({ values: [], isLoading: false });
    const onChange = vi.fn();
    render(
      <FilterRow
        {...baseProps}
        onChange={onChange}
        filter={{ field: "cost", op: ">", value: "" }}
      />,
    );
    const input = screen.getByRole("spinbutton");
    // typed negative values are dropped instead of propagating into the spec
    fireEvent.change(input, { target: { value: "-5" } });
    expect(onChange).not.toHaveBeenCalled();
    // a non-negative value still propagates as a number
    fireEvent.change(input, { target: { value: "5" } });
    expect(onChange).toHaveBeenCalledWith(0, { value: 5 });
  });

  it("picking a field auto-selects its first operator, like the trace-list builder", () => {
    vi.mocked(useWidgetFieldValues).mockReturnValue({ values: [], isLoading: false });
    const onChange = vi.fn();
    render(
      <FilterRow {...baseProps} onChange={onChange} filter={{ field: "", op: "", value: "" }} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Field" }));
    fireEvent.click(screen.getByRole("option", { name: /Cost/ }));
    // The key clears with the value, to undefined rather than "": the schema rejects "".
    expect(onChange).toHaveBeenCalledWith(0, {
      field: "cost",
      op: ">",
      value: "",
      key: undefined,
    });
  });

  it("disables the op and value controls until a field is picked", () => {
    vi.mocked(useWidgetFieldValues).mockReturnValue({ values: [], isLoading: false });
    render(<FilterRow {...baseProps} filter={{ field: "", op: "", value: "" }} />);
    // op trigger shows the placeholder "is" and is disabled; value is a parked input
    expect(screen.getByRole("button", { name: "is" })).toHaveProperty("disabled", true);
    expect(screen.getByPlaceholderText("Enter value")).toHaveProperty("disabled", true);
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

  it("lists the field's ops in the operator dropdown with shared labels", () => {
    vi.mocked(useWidgetFieldValues).mockReturnValue({ values: [], isLoading: false });
    const onChange = vi.fn();
    render(
      <FilterRow
        {...baseProps}
        onChange={onChange}
        filter={{ field: "model_name", op: "=", value: "" }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "is" }));
    // same vocabulary as the trace-list filter: no "is not"
    expect(screen.queryByRole("option", { name: "is not" })).toBeNull();
    expect(screen.getByRole("option", { name: "contains" })).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: "contains" }));
    expect(onChange).toHaveBeenCalledWith(0, { op: "contains" });
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

describe("FilterRow keyed fields", () => {
  afterEach(cleanup);

  const keyedProps = {
    ...baseProps,
    filterableFields: [...baseProps.filterableFields, ["metadata", keyedField]] as [
      string,
      WidgetSchemaField,
    ][],
    fieldsMap: { ...baseProps.fieldsMap, metadata: keyedField },
  };

  it("renders the key control only for a keyed field", () => {
    vi.mocked(useWidgetFieldValues).mockReturnValue({ values: [], isLoading: false });
    const { unmount } = render(
      <FilterRow {...keyedProps} filter={{ field: "model_name", op: "=", value: "" }} />,
    );
    expect(screen.queryByLabelText("metadata key")).toBeNull();
    unmount();

    render(
      <FilterRow {...keyedProps} filter={{ field: "metadata", op: "=", value: "", key: "" }} />,
    );
    expect(screen.getByLabelText("metadata key")).toBeTruthy();
  });

  it("propagates a typed key through onChange", () => {
    vi.mocked(useWidgetFieldValues).mockReturnValue({ values: [], isLoading: false });
    const onChange = vi.fn();
    render(
      <FilterRow
        {...keyedProps}
        onChange={onChange}
        filter={{ field: "metadata", op: "=", value: "", key: "" }}
      />,
    );
    fireEvent.change(screen.getByLabelText("metadata key"), { target: { value: "tenant_id" } });
    expect(onChange).toHaveBeenCalledWith(0, { key: "tenant_id" });
  });

  it("keeps a keyed field's value free text — its values sit behind a key, not in a column", () => {
    vi.mocked(useWidgetFieldValues).mockReturnValue({
      values: [{ value: "should-not-appear", count: 1 }],
      isLoading: false,
    });
    render(
      <FilterRow {...keyedProps} filter={{ field: "metadata", op: "=", value: "", key: "k" }} />,
    );
    // Two text inputs: the key and the value. No stored-value dropdown, no distinct-values query.
    expect(screen.getAllByRole("textbox")).toHaveLength(2);
    expect(vi.mocked(useWidgetFieldValues).mock.calls.at(-1)?.[4]).toBe(false);
  });
});

describe("FilterRow field control", () => {
  afterEach(cleanup);

  // The field trigger is the shared FieldDropdown, which takes no styling from either caller.
  it("renders the field trigger with the shared chrome at the builder's compact size", () => {
    vi.mocked(useWidgetFieldValues).mockReturnValue({ values: [], isLoading: false });
    const { container } = render(
      <FilterRow {...baseProps} filter={{ field: "", op: "", value: "" }} />,
    );
    const trigger = within(container).getByRole("button", { name: "Field" });
    const className = trigger.className;

    expect(className).toContain("w-[8.5rem]");
    expect(className).toContain("shrink-0");
    expect(className).toContain("text-[12px]");

    const reference = render(
      <FilterControlSizeProvider size="sm">
        <Dropdown trigger={<span>ref</span>} triggerClassName="w-[8.5rem] shrink-0">
          {() => null}
        </Dropdown>
      </FilterControlSizeProvider>,
    );
    // Exactly the shared trigger chrome at that size plus the width.
    expect(className).toBe(
      within(reference.container).getByRole("button", { name: "ref" }).className,
    );
  });

  it("keeps the same trigger width once a field is picked", () => {
    vi.mocked(useWidgetFieldValues).mockReturnValue({ values: [], isLoading: false });
    const unset = render(<FilterRow {...baseProps} filter={{ field: "", op: "", value: "" }} />);
    const unsetClass = within(unset.container).getByRole("button", { name: "Field" }).className;
    cleanup();

    const picked = render(
      <FilterRow {...baseProps} filter={{ field: "cost", op: ">", value: 5 }} />,
    );

    expect(within(picked.container).getByRole("button", { name: /Cost/ }).className).toBe(
      unsetClass,
    );
  });
});
