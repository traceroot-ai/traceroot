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
});
