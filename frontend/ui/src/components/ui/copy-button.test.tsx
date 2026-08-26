// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CopyButton } from "./copy-button";

afterEach(() => cleanup());

describe("CopyButton", () => {
  it("copies the value and notifies onCopy on a successful write", async () => {
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    const onCopy = vi.fn();
    render(<CopyButton value="hello" onCopy={onCopy} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button"));
    });

    expect(writeText).toHaveBeenCalledWith("hello");
    expect(onCopy).toHaveBeenCalled();
  });

  it("handles a rejected write instead of throwing an unhandled rejection", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("denied");
    });
    Object.assign(navigator, { clipboard: { writeText } });
    const onCopy = vi.fn();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = render(<CopyButton value="hello" onCopy={onCopy} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button"));
    });

    // Nothing was actually copied, so onCopy must not fire — the failure
    // is logged (caught), not silently treated as a success.
    expect(onCopy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    // The button must not flip to its "copied" (check icon) state on failure.
    expect(container.querySelector(".text-green-600")).toBeNull();
    errorSpy.mockRestore();
  });
});
