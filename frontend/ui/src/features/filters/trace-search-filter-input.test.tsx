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
    {
      field: "metadata",
      label: "Metadata",
      type: "text",
      operators: ["eq", "contains"],
      requires_key: true,
    },
  ],
}));

// Stub the builder: clicking it submits whatever predicate the test lined up, defaulting
// to a `cost` one, so the input's add/replace wiring is assertable without driving the
// whole builder. Held in a mutable box because the module mock is hoisted above it.
const COST_PREDICATE: Predicate = { field: "cost", op: "gt", value: 1 };
const submission = vi.hoisted(() => ({
  predicate: { field: "cost", op: "gt", value: 1 } as Predicate,
}));
vi.mock("./filter-builder", () => ({
  FilterBuilder: ({ onSubmit }: { onSubmit: (p: Predicate) => void }) => (
    <button onClick={() => onSubmit(submission.predicate)}>stub-add</button>
  ),
}));

afterEach(() => {
  cleanup();
  submission.predicate = COST_PREDICATE;
});

/** Open the builder and submit the predicate the test lined up. */
function submitFromBuilder(predicate: Predicate) {
  submission.predicate = predicate;
  fireEvent.focus(screen.getByRole("textbox"));
  fireEvent.click(screen.getByText("stub-add"));
}

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

  it("names a keyed predicate's key once on its chip, not twice", () => {
    // The chip is the only place the three parts of a metadata filter (key, operator,
    // value) are visible at once, so the key has to read as itself — `metadata.session_id`,
    // not `metadata.session_id.session_id`.
    renderInput({ filters: [{ field: "metadata", key: "session_id", op: "eq", value: "s-1" }] });
    expect(screen.getByText("metadata.session_id = s-1")).toBeTruthy();
    expect(screen.queryByText(/session_id\.session_id/)).toBeNull();
  });

  it("names the key once on a keyed chip whose field has a different display label", () => {
    // The display name and the key are two different strings; only the label is
    // substituted, and the key is still appended exactly once after it.
    renderInput({ filters: [{ field: "metadata", key: "tenant", op: "contains", value: "acme" }] });
    expect(screen.getByText("metadata.tenant contains acme")).toBeTruthy();
  });

  it("gives two metadata chips distinct labels and distinct remove buttons", () => {
    renderInput({
      filters: [
        { field: "metadata", key: "session_id", op: "eq", value: "s-1" },
        { field: "metadata", key: "tenant", op: "eq", value: "acme" },
      ],
    });
    expect(screen.getByText("metadata.session_id = s-1")).toBeTruthy();
    expect(screen.getByText("metadata.tenant = acme")).toBeTruthy();
    expect(screen.getByLabelText("Remove metadata.session_id filter")).toBeTruthy();
    expect(screen.getByLabelText("Remove metadata.tenant filter")).toBeTruthy();
  });

  it("removes the clicked metadata chip and leaves the other key filtered", () => {
    const onFiltersChange = vi.fn();
    const session: Predicate = { field: "metadata", key: "session_id", op: "eq", value: "s-1" };
    const tenant: Predicate = { field: "metadata", key: "tenant", op: "eq", value: "acme" };
    renderInput({ filters: [session, tenant], onFiltersChange });
    fireEvent.click(screen.getByLabelText("Remove metadata.tenant filter"));
    expect(onFiltersChange).toHaveBeenCalledWith([session]);
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
    expect(screen.queryByText("stub-add")).toBeNull();
    submitFromBuilder(COST_PREDICATE);
    // The new `gt` supersedes the existing `gte` on the same field (same lower-bound slot).
    expect(onFiltersChange).toHaveBeenCalledWith([{ field: "cost", op: "gt", value: 1 }]);
  });

  it("a second metadata filter on a DIFFERENT key stacks alongside the first", () => {
    // A keyed field behaves as one filterable field per key: `metadata.session_id` and
    // `metadata.tenant` are independent filters that have to coexist, or narrowing by a
    // second key would silently drop the first.
    const onFiltersChange = vi.fn();
    const session: Predicate = { field: "metadata", key: "session_id", op: "eq", value: "s-1" };
    const tenant: Predicate = { field: "metadata", key: "tenant", op: "eq", value: "acme" };
    renderInput({ filters: [session], onFiltersChange });
    submitFromBuilder(tenant);
    expect(onFiltersChange).toHaveBeenCalledWith([session, tenant]);
  });

  it("a second metadata filter on the SAME key replaces the first", () => {
    // Two filters on one key would AND into a contradiction the chips could not explain,
    // so re-filtering a key is a correction rather than an addition.
    const onFiltersChange = vi.fn();
    const first: Predicate = { field: "metadata", key: "session_id", op: "eq", value: "s-1" };
    const second: Predicate = { field: "metadata", key: "session_id", op: "contains", value: "s-" };
    renderInput({ filters: [first], onFiltersChange });
    submitFromBuilder(second);
    expect(onFiltersChange).toHaveBeenCalledWith([second]);
  });

  it("adding a metadata filter leaves filters on other fields untouched", () => {
    const onFiltersChange = vi.fn();
    const cost: Predicate = { field: "cost", op: "gte", value: 5 };
    const session: Predicate = { field: "metadata", key: "session_id", op: "eq", value: "s-1" };
    renderInput({ filters: [cost], onFiltersChange });
    submitFromBuilder(session);
    expect(onFiltersChange).toHaveBeenCalledWith([cost, session]);
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
