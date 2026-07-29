// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DateRangePicker } from "./date-time-picker";

afterEach(cleanup);

describe("DateRangePicker retention clamp", () => {
  it("applies the entered range unchanged when no minDate is set", () => {
    const onApply = vi.fn();
    const start = new Date("2020-01-01T00:00:00Z");
    const end = new Date("2020-02-01T00:00:00Z");
    render(<DateRangePicker startDate={start} endDate={end} onApply={onApply} />);
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledWith(start, end);
  });

  it("snaps an out-of-window start up to the cutoff on apply", () => {
    const onApply = vi.fn();
    const minDate = new Date(Date.now() - 15 * 86_400_000);
    render(
      <DateRangePicker
        startDate={new Date("2020-01-01T00:00:00Z")} // far before the cutoff
        endDate={new Date()}
        onApply={onApply}
        minDate={minDate}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    const [appliedStart] = onApply.mock.calls[0];
    expect(appliedStart).toBe(minDate); // pulled forward to the retention cutoff
  });

  it("collapses a fully out-of-window range to [cutoff, now]", () => {
    const onApply = vi.fn();
    const minDate = new Date(Date.now() - 15 * 86_400_000);
    render(
      <DateRangePicker
        startDate={new Date("2020-01-01T00:00:00Z")}
        endDate={new Date("2020-02-01T00:00:00Z")} // also before the cutoff
        onApply={onApply}
        minDate={minDate}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    const [appliedStart, appliedEnd] = onApply.mock.calls[0];
    expect(appliedStart).toBe(minDate);
    // end was before the cutoff, so it resets to ~now rather than inverting
    expect(appliedEnd.getTime()).toBeGreaterThan(minDate.getTime());
  });

  it("leaves an in-window start untouched", () => {
    const onApply = vi.fn();
    const minDate = new Date(Date.now() - 15 * 86_400_000);
    const recentStart = new Date(Date.now() - 5 * 86_400_000); // inside the window
    render(
      <DateRangePicker
        startDate={recentStart}
        endDate={new Date()}
        onApply={onApply}
        minDate={minDate}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    const [appliedStart] = onApply.mock.calls[0];
    expect(appliedStart).toBe(recentStart);
  });
});
