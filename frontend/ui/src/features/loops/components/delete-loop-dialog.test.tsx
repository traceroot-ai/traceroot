// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import { DeleteLoopDialog } from "./delete-loop-dialog";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function setup(props: Partial<React.ComponentProps<typeof DeleteLoopDialog>> = {}) {
  const onConfirm = vi.fn();
  render(
    <DeleteLoopDialog
      loopName="Coding agents"
      isOpen
      onClose={() => {}}
      onConfirm={onConfirm}
      {...props}
    />,
  );
  return onConfirm;
}

describe("DeleteLoopDialog", () => {
  it("describes what deleting removes, as the dialog's accessible description", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setup();
    const dialog = screen.getByRole("dialog", { name: "Delete loop" });
    const description = document.getElementById(dialog.getAttribute("aria-describedby")!);
    expect(description?.textContent).toBe(
      "This removes the loop and its runs. Signals it created and the memory notes it wrote stay. This action cannot be undone. Type Coding agents to confirm.",
    );
    // Radix warns when a dialog has no description.
    expect(warn.mock.calls.flat().join(" ")).not.toMatch(/Missing `Description`/);
  });

  it("deletes only once the loop's name is typed", () => {
    const onConfirm = setup();
    const del = screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement;
    expect(del.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText("Coding agents"), {
      target: { value: "Coding agents" },
    });
    expect(del.disabled).toBe(false);
    fireEvent.click(del);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("clears the typed name on Cancel, so reopening starts disabled", () => {
    const props = { loopName: "Coding agents", onClose: () => {}, onConfirm: () => {} };
    const { rerender } = render(<DeleteLoopDialog {...props} isOpen />);
    fireEvent.change(screen.getByLabelText("confirm loop name"), {
      target: { value: "Coding agents" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    rerender(<DeleteLoopDialog {...props} isOpen={false} />);
    rerender(<DeleteLoopDialog {...props} isOpen />);
    expect((screen.getByLabelText("confirm loop name") as HTMLInputElement).value).toBe("");
    expect((screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
