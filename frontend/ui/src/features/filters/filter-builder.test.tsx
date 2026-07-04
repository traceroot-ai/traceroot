// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import { FilterBuilder } from "./filter-builder";
import type { FilterFieldDef } from "./registry";

// Stub the distinct-values hook; keep it as a spy so we can assert the window bounds
// are threaded through to it for a distinct-query categorical field.
const mockUseFilterValues = vi.hoisted(() => vi.fn(() => ({ values: [], isLoading: false })));
vi.mock("./hooks", () => ({ useFilterValues: mockUseFilterValues }));

afterEach(cleanup);

const STATUS: FilterFieldDef = {
  field: "status",
  label: "Status",
  type: "categorical",
  level: "SPAN_MEMBERSHIP",
  operators: ["in"],
  value_source: "static_enum",
  enum_values: ["OK", "ERROR"],
};
const COST: FilterFieldDef = {
  field: "cost",
  label: "Cost",
  type: "numeric",
  level: "SPAN_AGGREGATE",
  operators: ["eq", "gt", "gte", "lt", "lte"],
  value_source: "range",
  enum_values: [],
};
const TOKENS: FilterFieldDef = {
  field: "total_tokens",
  label: "Tokens",
  type: "numeric",
  level: "SPAN_AGGREGATE",
  operators: ["eq", "gt", "gte", "lt", "lte"],
  value_source: "range",
  enum_values: [],
  integer: true,
};

const MODEL: FilterFieldDef = {
  field: "model_name",
  label: "Model",
  type: "categorical",
  level: "SPAN_MEMBERSHIP",
  operators: ["in"],
  value_source: "distinct_query",
  enum_values: [],
};

const TRACE_ID: FilterFieldDef = {
  field: "trace_id",
  label: "Trace ID",
  type: "text",
  level: "TRACE",
  operators: ["eq", "contains"],
  value_source: "free_text",
  enum_values: [],
};

function renderBuilder(fields: FilterFieldDef[], onSubmit = vi.fn()) {
  render(<FilterBuilder projectId="p1" fields={fields} onSubmit={onSubmit} />);
  return onSubmit;
}

const pickField = (label: string | RegExp) => {
  fireEvent.click(screen.getByRole("button", { name: "Field" }));
  fireEvent.click(screen.getByRole("option", { name: label }));
};

describe("FilterBuilder (Basic row)", () => {
  it("Add filter is disabled until a field and value are chosen", () => {
    renderBuilder([STATUS]);
    expect(screen.getByRole("button", { name: "Add filter" })).toHaveProperty("disabled", true);
  });

  it("categorical: pick field + value, emit a single-value `in` predicate", () => {
    const onSubmit = renderBuilder([STATUS]);
    pickField(/Status/);
    fireEvent.click(screen.getByRole("button", { name: /Enter value/ }));
    fireEvent.click(screen.getByRole("option", { name: /ERROR/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add filter" }));
    expect(onSubmit).toHaveBeenCalledWith({ field: "status", op: "in", value: ["ERROR"] });
  });

  it("numeric `≥` emits an inclusive `gte` predicate", () => {
    const onSubmit = renderBuilder([COST]);
    pickField(/Cost/);
    fireEvent.click(screen.getByRole("button", { name: "=" })); // operator dropdown
    fireEvent.click(screen.getByRole("option", { name: "≥" }));
    fireEvent.change(screen.getByLabelText("value"), { target: { value: "0.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Add filter" }));
    expect(onSubmit).toHaveBeenCalledWith({ field: "cost", op: "gte", value: 0.5 });
  });

  it("numeric `≤` emits an inclusive `lte` predicate", () => {
    const onSubmit = renderBuilder([COST]);
    pickField(/Cost/);
    fireEvent.click(screen.getByRole("button", { name: "=" }));
    fireEvent.click(screen.getByRole("option", { name: "≤" }));
    fireEvent.change(screen.getByLabelText("value"), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Add filter" }));
    expect(onSubmit).toHaveBeenCalledWith({ field: "cost", op: "lte", value: 10 });
  });

  it("numeric `>` emits a strict `gt` predicate", () => {
    const onSubmit = renderBuilder([COST]);
    pickField(/Cost/);
    fireEvent.click(screen.getByRole("button", { name: "=" }));
    fireEvent.click(screen.getByRole("option", { name: ">" }));
    fireEvent.change(screen.getByLabelText("value"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Add filter" }));
    expect(onSubmit).toHaveBeenCalledWith({ field: "cost", op: "gt", value: 5 });
  });

  it("numeric `<` emits a strict `lt` predicate", () => {
    const onSubmit = renderBuilder([COST]);
    pickField(/Cost/);
    fireEvent.click(screen.getByRole("button", { name: "=" }));
    fireEvent.click(screen.getByRole("option", { name: "<" }));
    fireEvent.change(screen.getByLabelText("value"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Add filter" }));
    expect(onSubmit).toHaveBeenCalledWith({ field: "cost", op: "lt", value: 5 });
  });

  it("does not offer a `between` operator (a range is two one-sided filters)", () => {
    renderBuilder([COST]);
    pickField(/Cost/);
    fireEvent.click(screen.getByRole("button", { name: "=" }));
    expect(screen.queryByRole("option", { name: "between" })).toBeNull();
    expect(screen.getByRole("option", { name: "≥" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "≤" })).toBeTruthy();
  });

  it("resets the row after adding so another filter can be entered", () => {
    renderBuilder([COST]);
    pickField(/Cost/);
    fireEvent.change(screen.getByLabelText("value"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Add filter" }));
    // Field is back to the unset placeholder, ready for the next filter.
    expect(screen.getByRole("button", { name: "Field" })).toBeTruthy();
  });

  it("rejects negative numeric input", () => {
    renderBuilder([COST]);
    pickField(/Cost/);
    fireEvent.change(screen.getByLabelText("value"), { target: { value: "-5" } });
    // Negative is dropped → no value set → Add filter stays disabled.
    expect(screen.getByRole("button", { name: "Add filter" })).toHaveProperty("disabled", true);
  });

  it("integer field (Tokens) drops a fractional value", () => {
    renderBuilder([TOKENS]);
    pickField(/Tokens/);
    fireEvent.change(screen.getByLabelText("value"), { target: { value: "1.5" } });
    // Fractional is dropped for an Int64 field → no value → Add stays disabled.
    expect(screen.getByRole("button", { name: "Add filter" })).toHaveProperty("disabled", true);
  });

  it("integer field (Tokens) rejects a fractional value in scientific notation", () => {
    renderBuilder([TOKENS]);
    pickField(/Tokens/);
    // "1e-1" (=0.1) has no decimal point, so it slips past the input guard — the
    // predicate builder must still reject it for an integer field.
    fireEvent.change(screen.getByLabelText("value"), { target: { value: "1e-1" } });
    expect(screen.getByRole("button", { name: "Add filter" })).toHaveProperty("disabled", true);
  });

  it("integer field (Tokens) accepts a whole number", () => {
    const onSubmit = renderBuilder([TOKENS]);
    pickField(/Tokens/);
    fireEvent.change(screen.getByLabelText("value"), { target: { value: "100" } });
    fireEvent.click(screen.getByRole("button", { name: "Add filter" }));
    expect(onSubmit).toHaveBeenCalledWith({ field: "total_tokens", op: "eq", value: 100 });
  });

  it("decimal field (Cost) still accepts a fractional value", () => {
    const onSubmit = renderBuilder([COST]);
    pickField(/Cost/);
    fireEvent.change(screen.getByLabelText("value"), { target: { value: "0.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Add filter" }));
    expect(onSubmit).toHaveBeenCalledWith({ field: "cost", op: "eq", value: 0.5 });
  });

  it("creates the filter when Enter is pressed in the value field", () => {
    const onSubmit = renderBuilder([COST]);
    pickField(/Cost/);
    fireEvent.change(screen.getByLabelText("value"), { target: { value: "5" } });
    fireEvent.keyDown(screen.getByLabelText("value"), { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith({ field: "cost", op: "eq", value: 5 });
  });

  it("shows the field's unit in the numeric value input ($ for cost)", () => {
    renderBuilder([COST]);
    pickField(/Cost/);
    expect(screen.getByText("$")).toBeTruthy();
  });

  it("derives the operator set from the field's `operators` (numeric → = > ≥ < ≤, not `is`)", () => {
    renderBuilder([COST]);
    pickField(/Cost/);
    fireEvent.click(screen.getByRole("button", { name: "=" })); // open operator dropdown
    for (const sym of ["=", ">", "≥", "<", "≤"]) {
      expect(screen.getByRole("option", { name: sym })).toBeTruthy();
    }
    expect(screen.queryByRole("option", { name: "is" })).toBeNull();
  });

  it("a text field (Trace ID) offers `=` and `contains`, emitting string predicates", () => {
    // `contains` -> a case-insensitive substring predicate.
    const onContains = renderBuilder([TRACE_ID]);
    pickField(/Trace ID/);
    fireEvent.click(screen.getByRole("button", { name: "=" })); // operator dropdown (default `=`)
    expect(screen.getByRole("option", { name: "contains" })).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: "contains" }));
    fireEvent.change(screen.getByLabelText("value"), { target: { value: "abc" } });
    fireEvent.click(screen.getByRole("button", { name: "Add filter" }));
    expect(onContains).toHaveBeenCalledWith({ field: "trace_id", op: "contains", value: "abc" });

    cleanup();
    // `=` -> an exact string match (a string value, not a number).
    const onEq = renderBuilder([TRACE_ID]);
    pickField(/Trace ID/);
    fireEvent.change(screen.getByLabelText("value"), { target: { value: "abc123" } });
    fireEvent.click(screen.getByRole("button", { name: "Add filter" }));
    expect(onEq).toHaveBeenCalledWith({ field: "trace_id", op: "eq", value: "abc123" });
  });

  it("derives the operator set from the field's `operators` (categorical `in` → `is`)", () => {
    renderBuilder([STATUS]);
    pickField(/Status/);
    // The lone `is` operator is shown on the disabled-until-picked operator trigger.
    expect(screen.getByRole("button", { name: "is" })).toBeTruthy();
  });

  it("yields no operators for an unknown op in `operators` (defensive)", () => {
    // A field whose registry op isn't in the UI map contributes no UI operators,
    // so the operator dropdown offers nothing to choose.
    const UNKNOWN: FilterFieldDef = {
      field: "mystery",
      label: "Mystery",
      type: "numeric",
      level: "SPAN_AGGREGATE",
      operators: ["not_a_real_op"],
      value_source: "range",
      enum_values: [],
    };
    renderBuilder([UNKNOWN]);
    pickField(/Mystery/);
    // DOM order of buttons: [field, operator, Add filter] — open the operator dropdown.
    fireEvent.click(screen.getAllByRole("button")[1]);
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    // With no operator selected, entering a value must still build nothing — "Add filter"
    // stays disabled rather than silently falling through to a bound.
    fireEvent.change(screen.getByLabelText("value"), { target: { value: "5" } });
    expect(screen.getByRole("button", { name: "Add filter" })).toHaveProperty("disabled", true);
  });

  it("threads both window bounds into the distinct-values query for a categorical field", () => {
    mockUseFilterValues.mockClear();
    render(
      <FilterBuilder
        projectId="p1"
        fields={[MODEL]}
        startAfter="2026-06-01T00:00:00Z"
        endBefore="2026-06-02T00:00:00Z"
        onSubmit={vi.fn()}
      />,
    );
    pickField(/Model/);
    // The distinct-query field enables the lazy fetch, bounded on BOTH ends.
    expect(mockUseFilterValues).toHaveBeenCalledWith(
      "p1",
      "model_name",
      "2026-06-01T00:00:00Z",
      "2026-06-02T00:00:00Z",
      true,
    );
  });
});
