// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATE_FILTER_OPTIONS, formatDateRange } from "@/lib/date-filter";
import { DateFilterSelect } from "./date-filter-select";

// The real range picker is a calendar widget; the boundary under test here is
// DateFilterSelect's orchestration of the apply callback, so stub the picker
// with a button that applies a fixed range.
const APPLIED_START = new Date("2026-07-01T00:00:00Z");
const APPLIED_END = new Date("2026-07-04T00:00:00Z");
vi.mock("@/components/ui/date-time-picker", () => ({
  DateRangePicker: ({ onApply }: { onApply: (start: Date | null, end: Date | null) => void }) => (
    <button type="button" onClick={() => onApply(APPLIED_START, APPLIED_END)}>
      Apply stub range
    </button>
  ),
}));

const PRESET_7D = DATE_FILTER_OPTIONS.find((o) => o.id === "7d")!;
const CUSTOM = DATE_FILTER_OPTIONS.find((o) => o.isCustom)!;

describe("DateFilterSelect", () => {
  afterEach(cleanup);
  const onDateFilterChange = vi.fn();
  const onCustomRangeChange = vi.fn();
  beforeEach(() => {
    onDateFilterChange.mockReset();
    onCustomRangeChange.mockReset();
  });

  function renderSelect(
    dateFilter = PRESET_7D,
    start: Date | null = null,
    end: Date | null = null,
  ) {
    return render(
      <DateFilterSelect
        dateFilter={dateFilter}
        customStartDate={start}
        customEndDate={end}
        onDateFilterChange={onDateFilterChange}
        onCustomRangeChange={onCustomRangeChange}
      />,
    );
  }

  it("shows the active preset label and selects another preset from the popover", () => {
    renderSelect();
    const trigger = screen.getByRole("button", { name: /Last 7 days/ });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Last 1 hour" }));
    expect(onDateFilterChange).toHaveBeenCalledWith(DATE_FILTER_OPTIONS.find((o) => o.id === "1h"));
    expect(onCustomRangeChange).not.toHaveBeenCalled();
    // popover closed after picking a preset
    expect(screen.queryByRole("button", { name: "Last 30 minutes" })).toBeNull();
  });

  it("applies a custom range: custom option first, then the bounds", () => {
    renderSelect();
    fireEvent.click(screen.getByRole("button", { name: /Last 7 days/ }));
    fireEvent.click(screen.getByRole("button", { name: "Custom" }));
    // preset list swapped for the picker
    expect(screen.queryByRole("button", { name: "Last 1 hour" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Apply stub range" }));
    expect(onDateFilterChange).toHaveBeenCalledWith(CUSTOM);
    expect(onCustomRangeChange).toHaveBeenCalledWith(APPLIED_START, APPLIED_END);
  });

  it("labels an active custom filter with its formatted range", () => {
    renderSelect(CUSTOM, APPLIED_START, APPLIED_END);
    expect(
      screen.getByRole("button", { name: formatDateRange(APPLIED_START, APPLIED_END) }),
    ).toBeTruthy();
  });

  it("resets to the preset list when the popover reopens after visiting the custom picker", () => {
    renderSelect();
    const trigger = screen.getByRole("button", { name: /Last 7 days/ });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Custom" }));
    fireEvent.click(trigger); // close while the picker is showing
    fireEvent.click(trigger); // reopen
    expect(screen.getByRole("button", { name: "Last 1 hour" })).toBeTruthy();
  });
});
