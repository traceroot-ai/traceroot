// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { TriggerEditor } from "./trigger-editor";

afterEach(() => {
  cleanup();
});

describe("TriggerEditor", () => {
  it("round-trips nullable environment values", () => {
    const onChange = vi.fn();

    render(
      <TriggerEditor
        conditions={[{ field: "environment", op: "=", value: null }]}
        onChange={onChange}
      />,
    );

    const valueInput = screen.getByPlaceholderText("Enter value...") as HTMLInputElement;
    const unsetCheckbox = screen.getByRole("checkbox", {
      name: "Value is null",
    }) as HTMLInputElement;

    expect(valueInput.disabled).toBe(true);
    expect(valueInput.value).toBe("");
    expect(unsetCheckbox.checked).toBe(true);

    fireEvent.click(unsetCheckbox);

    expect(onChange).toHaveBeenLastCalledWith([{ field: "environment", op: "=", value: "" }]);
  });

  it("restores the prior text value when null mode is toggled off", () => {
    const onChange = vi.fn();

    render(
      <TriggerEditor
        conditions={[{ field: "environment", op: "=", value: "production" }]}
        onChange={onChange}
      />,
    );

    const valueInput = screen.getByPlaceholderText("Enter value...") as HTMLInputElement;
    const nullCheckbox = screen.getByRole("checkbox", {
      name: "Value is null",
    }) as HTMLInputElement;

    fireEvent.change(valueInput, { target: { value: "staging" } });
    fireEvent.click(nullCheckbox);
    fireEvent.click(nullCheckbox);

    expect(onChange).toHaveBeenLastCalledWith([
      { field: "environment", op: "=", value: "staging" },
    ]);
  });

  it("keeps null restore values with their row after removing another condition", () => {
    const onChange = vi.fn();

    render(
      <TriggerEditor
        conditions={[
          { field: "environment", op: "=", value: "production" },
          { field: "environment", op: "!=", value: "staging" },
        ]}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getAllByRole("checkbox", { name: "Value is null" })[1]);
    fireEvent.click(screen.getAllByRole("button", { name: "Remove condition" })[0]);
    fireEvent.click(screen.getByRole("checkbox", { name: "Value is null" }));

    expect(onChange).toHaveBeenLastCalledWith([
      { field: "environment", op: "!=", value: "staging" },
    ]);
  });

  it("does not restore a cached value after conditions are externally replaced", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <TriggerEditor
        conditions={[{ field: "environment", op: "=", value: "production" }]}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "Value is null" }));

    rerender(
      <TriggerEditor
        conditions={[{ field: "environment", op: "=", value: null }]}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Value is null" }));

    expect(onChange).toHaveBeenLastCalledWith([{ field: "environment", op: "=", value: "" }]);
  });
});
