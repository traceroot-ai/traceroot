// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ListPagination } from "./list-pagination";

afterEach(cleanup);

describe("ListPagination", () => {
  it("allows the page input to be cleared while editing", () => {
    const onPageChange = vi.fn();
    const onLimitChange = vi.fn();

    render(
      <ListPagination
        page={7}
        limit={50}
        total={12450}
        onPageChange={onPageChange}
        onLimitChange={onLimitChange}
      />,
    );

    const input = screen.getByRole("spinbutton") as HTMLInputElement;

    expect(input.value).toBe("8");

    fireEvent.change(input, { target: { value: "" } });
    expect(input.value).toBe("");

    fireEvent.change(input, { target: { value: "150" } });
    fireEvent.blur(input);

    expect(onPageChange).toHaveBeenCalledWith(149);
    expect(input.value).toBe("150");
  });

  it("restores the current page when an empty input is blurred", () => {
    const onPageChange = vi.fn();
    const onLimitChange = vi.fn();

    render(
      <ListPagination
        page={7}
        limit={50}
        total={12450}
        onPageChange={onPageChange}
        onLimitChange={onLimitChange}
      />,
    );

    const input = screen.getByRole("spinbutton") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);

    expect(onPageChange).not.toHaveBeenCalled();
    expect(input.value).toBe("8");
  });

  it("clamps an out-of-range page number on blur", () => {
    const onPageChange = vi.fn();
    render(
      <ListPagination
        page={0}
        limit={50}
        total={500}
        onPageChange={onPageChange}
        onLimitChange={vi.fn()}
      />,
    ); // 500 / 50 = 10 total pages

    const input = screen.getByRole("spinbutton") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "9999" } });
    fireEvent.blur(input);

    expect(onPageChange).toHaveBeenCalledWith(9); // clamped to last page (0-indexed: page 10 → index 9)
    expect(input.value).toBe("10"); // input reflects the clamped value, not 9999
  });

  it("prefetches prev and next pages on hover, respecting bounds", () => {
    const onPrefetchPage = vi.fn();
    render(
      <ListPagination
        page={3}
        limit={50}
        total={500} // 10 pages
        onPageChange={vi.fn()}
        onLimitChange={vi.fn()}
        onPrefetchPage={onPrefetchPage}
      />,
    );

    const prev = screen.getByRole("button", { name: /previous page/i });
    const next = screen.getByRole("button", { name: /next page/i });

    fireEvent.mouseEnter(next);
    expect(onPrefetchPage).toHaveBeenCalledWith(4);

    fireEvent.mouseEnter(prev);
    expect(onPrefetchPage).toHaveBeenCalledWith(2);
  });

  it("does not prefetch past the first or last page", () => {
    const onPrefetchPage = vi.fn();
    render(
      <ListPagination
        page={0}
        limit={50}
        total={50} // 1 page → both disabled
        onPageChange={vi.fn()}
        onLimitChange={vi.fn()}
        onPrefetchPage={onPrefetchPage}
      />,
    );
    fireEvent.mouseEnter(screen.getByRole("button", { name: /previous page/i }));
    fireEvent.mouseEnter(screen.getByRole("button", { name: /next page/i }));
    expect(onPrefetchPage).not.toHaveBeenCalled();
  });

  it("renders the Showing X–Y of N readout", () => {
    render(
      <ListPagination
        page={2}
        limit={50}
        total={124}
        onPageChange={vi.fn()}
        onLimitChange={vi.fn()}
      />,
    );
    expect(screen.getByText("Showing 101–124 of 124")).toBeDefined();
  });

  it("navigates using first, prev, next, and last page buttons", () => {
    const onPageChange = vi.fn();
    const { container } = render(
      <ListPagination
        page={2}
        limit={50}
        total={500} // 10 pages: 0-9
        onPageChange={onPageChange}
        onLimitChange={vi.fn()}
      />,
    );

    // Prev button
    fireEvent.click(screen.getByRole("button", { name: /previous page/i }));
    expect(onPageChange).toHaveBeenCalledWith(1);

    // Next button
    fireEvent.click(screen.getByRole("button", { name: /next page/i }));
    expect(onPageChange).toHaveBeenCalledWith(3);

    // First and last buttons (the small icon buttons without aria-label)
    const buttons = container.querySelectorAll("button");
    // Button order in the button group: [First, Prev, Next, Last]
    // The first one in the group (disabled when page 0):
    const navButtons = Array.from(buttons).filter(
      (b) => b.classList.contains("h-7") && b.classList.contains("w-7"),
    );
    // navButtons: [first, prev, next, last]
    fireEvent.click(navButtons[0]);
    expect(onPageChange).toHaveBeenCalledWith(0);

    fireEvent.click(navButtons[3]);
    expect(onPageChange).toHaveBeenCalledWith(9);
  });

  it("allows selecting a limit from the items-per-page popover", () => {
    const onLimitChange = vi.fn();
    render(
      <ListPagination
        page={0}
        limit={50}
        total={500}
        onPageChange={vi.fn()}
        onLimitChange={onLimitChange}
      />,
    );

    // Click limit button to open popover
    fireEvent.click(screen.getByRole("button", { name: "50" }));
    // Click option "100"
    fireEvent.click(screen.getByRole("button", { name: "100" }));
    expect(onLimitChange).toHaveBeenCalledWith(100);
  });

  it("blurs input on Enter key", () => {
    render(
      <ListPagination
        page={0}
        limit={50}
        total={500}
        onPageChange={vi.fn()}
        onLimitChange={vi.fn()}
      />,
    );

    const input = screen.getByRole("spinbutton") as HTMLInputElement;
    const blurSpy = vi.spyOn(input, "blur");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(blurSpy).toHaveBeenCalled();
  });
});
