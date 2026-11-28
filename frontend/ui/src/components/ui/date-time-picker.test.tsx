// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DateRangePicker } from "./date-time-picker";

afterEach(cleanup);

const applyButton = () => screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement;

const timeInput = (index: number) => ({
  year: screen.getAllByPlaceholderText("yyyy")[index] as HTMLInputElement,
  month: screen.getAllByPlaceholderText("mm")[index] as HTMLInputElement,
  day: screen.getAllByPlaceholderText("dd")[index] as HTMLInputElement,
  hour: screen.getAllByPlaceholderText("12")[index] as HTMLInputElement,
});

describe("DateRangePicker validation", () => {
  it("blocks Apply and shows an error while the start is after the end", () => {
    const onApply = vi.fn();
    render(
      <DateRangePicker
        startDate={new Date("2025-01-10T00:00:00Z")}
        endDate={new Date("2025-01-05T00:00:00Z")}
        onApply={onApply}
      />,
    );

    expect(applyButton().disabled).toBe(true);
    expect(screen.getByText("Start date must be before end date.")).toBeTruthy();

    fireEvent.change(timeInput(1).day, { target: { value: "12" } });
    expect(applyButton().disabled).toBe(false);
    expect(screen.queryByText("Start date must be before end date.")).toBeNull();
    fireEvent.click(applyButton());
    expect(onApply).toHaveBeenCalled();
  });

  it("blocks Apply when the start and end are the same", () => {
    render(
      <DateRangePicker
        startDate={new Date("2025-01-10T00:00:00Z")}
        endDate={new Date("2025-01-10T00:00:00Z")}
        onApply={vi.fn()}
      />,
    );

    expect(applyButton().disabled).toBe(true);
    expect(screen.getByText("Start date must be before end date.")).toBeTruthy();
  });

  it("rejects an impossible day instead of rolling it into the next month", () => {
    const onApply = vi.fn();
    render(
      <DateRangePicker
        startDate={new Date("2025-01-10T00:00:00Z")}
        endDate={new Date("2025-02-20T00:00:00Z")}
        onApply={onApply}
      />,
    );

    const start = timeInput(0);
    fireEvent.change(start.month, { target: { value: "02" } });
    fireEvent.change(start.day, { target: { value: "31" } });

    expect(start.day.value).toBe("31");
    expect(screen.getByText("Enter a valid date.")).toBeTruthy();
    expect(applyButton().disabled).toBe(true);

    fireEvent.blur(start.day);
    expect(start.day.value).toBe("31");
    expect(applyButton().disabled).toBe(true);
    fireEvent.click(applyButton());
    expect(onApply).not.toHaveBeenCalled();
  });

  it("clamps the day when a month change removes it", () => {
    const onApply = vi.fn();
    render(
      <DateRangePicker
        startDate={new Date("2024-01-31T00:00:00Z")}
        endDate={new Date("2024-03-01T00:00:00Z")}
        onApply={onApply}
      />,
    );

    const start = timeInput(0);
    fireEvent.change(start.month, { target: { value: "02" } });

    expect(start.day.value).toBe("29");
    expect(applyButton().disabled).toBe(false);
    fireEvent.click(applyButton());
    expect(onApply.mock.calls[0][0].toISOString()).toBe("2024-02-29T00:00:00.000Z");
  });

  it("clamps the day when a year change removes it", () => {
    const onApply = vi.fn();
    render(
      <DateRangePicker
        startDate={new Date("2024-02-29T00:00:00Z")}
        endDate={new Date("2025-03-01T00:00:00Z")}
        onApply={onApply}
      />,
    );

    const start = timeInput(0);
    fireEvent.change(start.year, { target: { value: "2025" } });

    expect(start.day.value).toBe("28");
    expect(applyButton().disabled).toBe(false);
    fireEvent.click(applyButton());
    expect(onApply.mock.calls[0][0].toISOString()).toBe("2025-02-28T00:00:00.000Z");
  });

  it("keeps Apply disabled while the range is incomplete", () => {
    const onApply = vi.fn();
    render(
      <DateRangePicker
        startDate={new Date("2025-01-10T00:00:00Z")}
        endDate={new Date("2025-02-20T00:00:00Z")}
        onApply={onApply}
      />,
    );

    const start = timeInput(0);
    fireEvent.change(start.day, { target: { value: "" } });
    expect(applyButton().disabled).toBe(true);
    fireEvent.click(applyButton());
    expect(onApply).not.toHaveBeenCalled();

    fireEvent.change(start.day, { target: { value: "15" } });
    expect(applyButton().disabled).toBe(false);

    fireEvent.change(start.hour, { target: { value: "" } });
    expect(applyButton().disabled).toBe(true);
    fireEvent.click(applyButton());
    expect(onApply).not.toHaveBeenCalled();
  });
});

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
