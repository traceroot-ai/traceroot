// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SearchFilterBar } from "./search-filter-bar";
import { DATE_FILTER_OPTIONS } from "@/lib/date-filter";

afterEach(cleanup);

describe("SearchFilterBar", () => {
  function renderBar() {
    return render(
      <SearchFilterBar
        searchValue=""
        onSearchChange={vi.fn()}
        searchPlaceholder="Search..."
        dateFilter={DATE_FILTER_OPTIONS[0]}
        customStartDate={null}
        customEndDate={null}
        onDateFilterChange={vi.fn()}
        onCustomRangeChange={vi.fn()}
      >
        <button type="button">Live</button>
      </SearchFilterBar>,
    );
  }

  it("renders the search input, children, and date filter trigger", () => {
    renderBar();

    expect(screen.getByPlaceholderText("Search...")).toBeTruthy();
    expect(screen.getByText("Live")).toBeTruthy();
    expect(screen.getByText(DATE_FILTER_OPTIONS[0].label)).toBeTruthy();
  });

  it("reflects the current search value", () => {
    render(
      <SearchFilterBar
        searchValue="checkout"
        onSearchChange={vi.fn()}
        dateFilter={DATE_FILTER_OPTIONS[0]}
        customStartDate={null}
        customEndDate={null}
        onDateFilterChange={vi.fn()}
        onCustomRangeChange={vi.fn()}
      />,
    );

    const input = screen.getByPlaceholderText("Search...") as HTMLInputElement;
    expect(input.value).toBe("checkout");
  });
});
