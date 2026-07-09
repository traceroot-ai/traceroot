// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import { TraceSearchFilterInput } from "./trace-search-filter-input";
import type { Predicate } from "@/types/api";

// Field registry drives the chip display name (registry label, lowercased).
vi.mock("./hooks", () => ({
  useFilterFields: () => [
    { field: "cost", label: "Cost", type: "numeric", operators: ["eq", "gt", "gte", "lt", "lte"] },
    {
      field: "duration_ms",
      label: "Latency",
      type: "numeric",
      operators: ["eq", "gt", "gte", "lt", "lte"],
    },
  ],
}));

// Stub the builder: clicking it submits a `cost` predicate, so we can assert the
// input's add/replace wiring without driving the whole builder.
vi.mock("./filter-builder", () => ({
  FilterBuilder: ({ onSubmit }: { onSubmit: (p: Predicate) => void }) => (
    <button onClick={() => onSubmit({ field: "cost", op: "gt", value: 1 })}>stub-add-cost</button>
  ),
}));

afterEach(cleanup);

function renderInput(props: Partial<React.ComponentProps<typeof TraceSearchFilterInput>> = {}) {
  return render(
    <TraceSearchFilterInput projectId="p1" filters={[]} onFiltersChange={vi.fn()} {...props} />,
  );
}

describe("TraceSearchFilterInput", () => {
  it("renders a labeled chip inside the box per active filter", () => {
    renderInput({ filters: [{ field: "cost", op: "gte", value: 0.5 }] });
    expect(screen.getByText("cost ≥ 0.5")).toBeTruthy();
  });

  it("labels a chip with the field's lowercased display name (latency, not duration_ms)", () => {
    renderInput({ filters: [{ field: "duration_ms", op: "gte", value: 5 }] });
    expect(screen.getByText("latency ≥ 5")).toBeTruthy();
    expect(screen.queryByText(/duration_ms/)).toBeNull();
  });

  it("removes a filter when its chip ✕ is clicked", () => {
    const onFiltersChange = vi.fn();
    renderInput({
      filters: [
        { field: "status", op: "in", value: ["ERROR"] },
        { field: "cost", op: "gte", value: 0.5 },
      ],
      onFiltersChange,
    });
    fireEvent.click(screen.getByLabelText("Remove cost filter"));
    expect(onFiltersChange).toHaveBeenCalledWith([{ field: "status", op: "in", value: ["ERROR"] }]);
  });

  it("opens the builder on input focus and a submitted predicate replaces same-field", () => {
    const onFiltersChange = vi.fn();
    renderInput({ filters: [{ field: "cost", op: "gte", value: 5 }], onFiltersChange });
    // Builder is closed until the box is focused.
    expect(screen.queryByText("stub-add-cost")).toBeNull();
    fireEvent.focus(screen.getByRole("textbox"));
    fireEvent.click(screen.getByText("stub-add-cost"));
    // The new `gt` supersedes the existing `gte` on the same field (same lower-bound slot).
    expect(onFiltersChange).toHaveBeenCalledWith([{ field: "cost", op: "gt", value: 1 }]);
  });

  it("backspace removes the last filter (the box is filter-only, no keyword text)", () => {
    const onFiltersChange = vi.fn();
    renderInput({
      filters: [
        { field: "status", op: "in", value: ["ERROR"] },
        { field: "cost", op: "gte", value: 0.5 },
      ],
      onFiltersChange,
    });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Backspace" });
    expect(onFiltersChange).toHaveBeenCalledWith([{ field: "status", op: "in", value: ["ERROR"] }]);
  });
});
