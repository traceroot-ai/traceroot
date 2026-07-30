// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Hash } from "lucide-react";
import {
  FieldDropdown,
  FilterControlSizeProvider,
  NumberField,
  TextField,
  ValueDropdown,
} from "./filter-controls";

afterEach(cleanup);

describe("NumberField", () => {
  it("drops typed negative values and keeps non-negative ones", () => {
    const onChange = vi.fn();
    render(
      <NumberField ariaLabel="value" placeholder="Enter value" value="" onChange={onChange} />,
    );
    const input = screen.getByLabelText("value");
    fireEvent.change(input, { target: { value: "-5" } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "5" } });
    expect(onChange).toHaveBeenCalledWith("5");
  });

  it("blocks the minus key, and the decimal point on integer fields", () => {
    const onChange = vi.fn();
    render(
      <NumberField
        ariaLabel="value"
        placeholder="Enter value"
        value=""
        onChange={onChange}
        integer
      />,
    );
    const input = screen.getByLabelText("value");
    const minus = fireEvent.keyDown(input, { key: "-" });
    const dot = fireEvent.keyDown(input, { key: "." });
    // fireEvent returns false when preventDefault was called
    expect(minus).toBe(false);
    expect(dot).toBe(false);
    fireEvent.change(input, { target: { value: "1.5" } });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("submits on Enter when a handler is wired, and tolerates its absence", () => {
    const onEnter = vi.fn();
    const { unmount } = render(
      <NumberField
        ariaLabel="value"
        placeholder="Enter value"
        value="5"
        onChange={vi.fn()}
        onEnter={onEnter}
      />,
    );
    fireEvent.keyDown(screen.getByLabelText("value"), { key: "Enter" });
    expect(onEnter).toHaveBeenCalled();
    unmount();

    // without onEnter (the widget builder's rows) Enter must not throw
    render(
      <NumberField ariaLabel="value" placeholder="Enter value" value="5" onChange={vi.fn()} />,
    );
    fireEvent.keyDown(screen.getByLabelText("value"), { key: "Enter" });
  });

  it("renders the unit prefix and suffix around the input", () => {
    render(
      <NumberField
        ariaLabel="value"
        placeholder="Enter value"
        value=""
        onChange={vi.fn()}
        unit={{ prefix: "$", suffix: "ms" }}
      />,
    );
    expect(screen.getByText("$")).toBeTruthy();
    expect(screen.getByText("ms")).toBeTruthy();
  });
});

describe("TextField", () => {
  it("propagates edits and tolerates Enter without a handler", () => {
    const onChange = vi.fn();
    render(<TextField ariaLabel="value" placeholder="Enter value" value="" onChange={onChange} />);
    const input = screen.getByLabelText("value");
    fireEvent.change(input, { target: { value: "abc" } });
    expect(onChange).toHaveBeenCalledWith("abc");
    fireEvent.keyDown(input, { key: "Enter" });
  });
});

describe("ValueDropdown", () => {
  it("shows an empty state when there are no options", () => {
    render(<ValueDropdown value="" options={[]} onValue={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Enter value" }));
    expect(screen.getByText("No options")).toBeTruthy();
  });
});

describe("FieldDropdown", () => {
  const options = [
    { key: "trace_id", label: "Trace ID", icon: Hash },
    { key: "mystery", label: "Mystery" }, // no icon → generic fallback
  ];

  it("shows the placeholder until a field is picked, then the field's label", () => {
    const onPick = vi.fn();
    const { rerender } = render(
      <FieldDropdown options={options} valueKey={null} onPick={onPick} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Field" }));
    fireEvent.click(screen.getByRole("option", { name: /Mystery/ }));
    expect(onPick).toHaveBeenCalledWith("mystery");

    rerender(<FieldDropdown options={options} valueKey="trace_id" onPick={onPick} />);
    expect(screen.getByRole("button", { name: /Trace ID/ })).toBeTruthy();
  });
});

describe("FilterControlSizeProvider", () => {
  it("renders controls at 13px by default and 12px inside a compact host", () => {
    const { unmount } = render(
      <TextField ariaLabel="value" placeholder="Enter value" value="" onChange={vi.fn()} />,
    );
    expect(screen.getByLabelText("value").className).toContain("text-[13px]");
    unmount();

    render(
      <FilterControlSizeProvider size="sm">
        <TextField ariaLabel="value" placeholder="Enter value" value="" onChange={vi.fn()} />
      </FilterControlSizeProvider>,
    );
    expect(screen.getByLabelText("value").className).toContain("text-[12px]");
  });
});
