// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TriggerEditor } from "./trigger-editor";

afterEach(() => cleanup());

describe("TriggerEditor", () => {
  it("prevents condition edits when rendered read-only", () => {
    const onChange = vi.fn();

    render(
      <TriggerEditor
        conditions={[{ field: "environment", op: "=", value: "production" }]}
        onChange={onChange}
        readOnly
      />,
    );

    expect(screen.queryByRole("button", { name: /add condition/i })).toBeNull();

    const valueInput = screen.getByDisplayValue("production") as HTMLInputElement;
    expect(valueInput.disabled).toBe(true);

    fireEvent.change(valueInput, { target: { value: "staging" } });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("hides card-mode add controls when read-only", () => {
    render(<TriggerEditor conditions={[]} readOnly asCard />);

    expect(screen.getByText("Runs on all completed traces.")).toBeDefined();
    expect(screen.queryByRole("button", { name: /add condition/i })).toBeNull();
  });
});
