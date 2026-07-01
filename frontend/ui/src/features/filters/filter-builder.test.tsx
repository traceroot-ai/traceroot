// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import { FilterBuilder } from "./filter-builder";
import type { FilterFieldDef } from "./registry";

// Distinct-values hook is irrelevant here (status is a static enum); stub it.
vi.mock("./hooks", () => ({
  useFilterValues: () => ({ values: [], isLoading: false }),
}));

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
  operators: ["between"],
  value_source: "range",
  enum_values: [],
};
const TOKENS: FilterFieldDef = {
  field: "total_tokens",
  label: "Tokens",
  type: "numeric",
  level: "SPAN_AGGREGATE",
  operators: ["between"],
  value_source: "range",
  enum_values: [],
  integer: true,
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

  it("numeric `greater than` lowers to a between with an open upper bound", () => {
    const onSubmit = renderBuilder([COST]);
    pickField(/Cost/);
    fireEvent.click(screen.getByRole("button", { name: "equals" })); // operator dropdown
    fireEvent.click(screen.getByRole("option", { name: "greater than" }));
    fireEvent.change(screen.getByLabelText("value"), { target: { value: "0.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Add filter" }));
    expect(onSubmit).toHaveBeenCalledWith({ field: "cost", op: "between", value: [0.5, null] });
  });

  it("does not offer a `between` operator", () => {
    renderBuilder([COST]);
    pickField(/Cost/);
    fireEvent.click(screen.getByRole("button", { name: "equals" }));
    expect(screen.queryByRole("option", { name: "between" })).toBeNull();
    expect(screen.getByRole("option", { name: "greater than" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "less than" })).toBeTruthy();
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
    expect(onSubmit).toHaveBeenCalledWith({
      field: "total_tokens",
      op: "between",
      value: [100, 100],
    });
  });

  it("decimal field (Cost) still accepts a fractional value", () => {
    const onSubmit = renderBuilder([COST]);
    pickField(/Cost/);
    fireEvent.change(screen.getByLabelText("value"), { target: { value: "0.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Add filter" }));
    expect(onSubmit).toHaveBeenCalledWith({ field: "cost", op: "between", value: [0.5, 0.5] });
  });

  it("creates the filter when Enter is pressed in the value field", () => {
    const onSubmit = renderBuilder([COST]);
    pickField(/Cost/);
    fireEvent.change(screen.getByLabelText("value"), { target: { value: "5" } });
    fireEvent.keyDown(screen.getByLabelText("value"), { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith({ field: "cost", op: "between", value: [5, 5] });
  });

  it("shows the field's unit in the numeric value input ($ for cost)", () => {
    renderBuilder([COST]);
    pickField(/Cost/);
    expect(screen.getByText("$")).toBeTruthy();
  });
});
