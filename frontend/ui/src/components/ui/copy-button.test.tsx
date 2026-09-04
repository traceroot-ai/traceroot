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

  it("shows a distinct failed-state icon on a rejected write, not the idle Copy icon", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("denied");
    });
    Object.assign(navigator, { clipboard: { writeText } });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = render(<CopyButton value="hello" />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button"));
    });

    expect(container.querySelector(".text-destructive")).not.toBeNull();
    errorSpy.mockRestore();
  });

  it("reverts the failed icon to idle after the reset delay", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async () => {
      throw new Error("denied");
    });
    Object.assign(navigator, { clipboard: { writeText } });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = render(<CopyButton value="hello" />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button"));
    });
    expect(container.querySelector(".text-destructive")).not.toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(container.querySelector(".text-destructive")).toBeNull();

    errorSpy.mockRestore();
    vi.useRealTimers();
  });

  it("a second click before the reset cancels the first click's pending reset", async () => {
    // Regression guard for the timeout-leak fix: copy, fail, copy again
    // inside the 2s window. Without clearing the first timeout, its
    // setState("idle") would fire mid-way through and wipe out the second
    // click's "copied" state early.
    vi.useFakeTimers();
    const writeText = vi
      .fn()
      .mockRejectedValueOnce(new Error("denied"))
      .mockResolvedValueOnce(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = render(<CopyButton value="hello" />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button"));
    });
    expect(container.querySelector(".text-destructive")).not.toBeNull();

    // Advance partway through the first reset window, then click again.
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button"));
    });
    expect(container.querySelector(".text-green-600")).not.toBeNull();

    // The remainder of the first (canceled) timeout elapsing must not
    // revert the second click's "copied" state early.
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(container.querySelector(".text-green-600")).not.toBeNull();

    errorSpy.mockRestore();
    vi.useRealTimers();
  });

  it("clears the pending reset timeout on unmount", async () => {
    const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    const { unmount } = render(<CopyButton value="hello" />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button"));
    });
    const callsBeforeUnmount = clearTimeoutSpy.mock.calls.length;

    unmount();

    expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThan(callsBeforeUnmount);
    clearTimeoutSpy.mockRestore();
  });

  it("a stale (older) click's late failure must not override a newer click's success", async () => {
    // Two overlapping writes can settle out of order — e.g. the older one is
    // still waiting on a permission prompt when a newer one completes first.
    // Only the latest click's result may ever apply.
    let rejectFirst: ((err: Error) => void) | undefined;
    let resolveSecond: (() => void) | undefined;
    const writeText = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveSecond = resolve;
          }),
      );
    Object.assign(navigator, { clipboard: { writeText } });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = render(<CopyButton value="hello" />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button")); // click 1: will fail, but later
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button")); // click 2: will succeed, sooner
    });

    // The newer click settles first, with success.
    await act(async () => {
      resolveSecond?.();
    });
    expect(container.querySelector(".text-green-600")).not.toBeNull();
    expect(container.querySelector(".text-destructive")).toBeNull();

    // The older (stale) click settles after, with a failure — it must be ignored.
    await act(async () => {
      rejectFirst?.(new Error("denied"));
    });
    expect(container.querySelector(".text-green-600")).not.toBeNull();
    expect(container.querySelector(".text-destructive")).toBeNull();

    errorSpy.mockRestore();
  });

  it("clears the pending reset the moment a new click starts, even before it resolves", async () => {
    vi.useFakeTimers();
    let resolveSecond: (() => void) | undefined;
    const writeText = vi
      .fn()
      .mockResolvedValueOnce(undefined) // click 1 succeeds immediately, schedules a 2s reset
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveSecond = resolve;
          }),
      ); // click 2 stays pending
    Object.assign(navigator, { clipboard: { writeText } });
    const { container } = render(<CopyButton value="hello" />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button"));
    });
    expect(container.querySelector(".text-green-600")).not.toBeNull();

    // Partway through click 1's reset window.
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });

    // Click 2 starts, still unresolved — must cancel click 1's reset now,
    // not wait for click 2 to settle.
    await act(async () => {
      fireEvent.click(screen.getByRole("button"));
    });

    // Advance past click 1's original reset time (1000 + 1500 > 2000) while
    // click 2 is STILL unresolved. If click 1's timer weren't canceled at
    // the start of click 2, it would fire here and revert to idle.
    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    expect(container.querySelector(".text-green-600")).not.toBeNull();

    await act(async () => {
      resolveSecond?.();
    });
    expect(container.querySelector(".text-green-600")).not.toBeNull();

    vi.useRealTimers();
  });
});
