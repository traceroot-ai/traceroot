// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CopyButton } from "./copy-button";

const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");

afterEach(() => {
  cleanup();
  if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
  else Reflect.deleteProperty(navigator, "clipboard");
  vi.restoreAllMocks();
});

it("reports a rejected copy without claiming success, then allows retry", async () => {
  const writeText = vi
    .fn()
    .mockRejectedValueOnce(new DOMException("Permission denied", "NotAllowedError"))
    .mockResolvedValueOnce(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const onCopy = vi.fn();
  render(<CopyButton aria-label="Copy" value="example" onCopy={onCopy} />);
  const button = screen.getByRole("button", { name: "Copy" });
  button.focus();
  fireEvent.click(button);
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Could not copy to clipboard. Try again.",
  );
  expect(onCopy).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(button);
  expect(button.querySelector(".lucide-check")).toBeNull();
  fireEvent.click(button);
  await waitFor(() => expect(onCopy).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(writeText).toHaveBeenNthCalledWith(2, "example");
  expect(button.querySelector(".lucide-check")).toBeTruthy();
});

it("reports unavailable clipboard access and lets the message be dismissed", async () => {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
  render(<CopyButton aria-label="Copy" value="example" />);
  fireEvent.click(screen.getByRole("button", { name: "Copy" }));
  await screen.findByRole("alert");
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});

it("ignores an older failure after a newer copy succeeds", async () => {
  let rejectFirst!: (reason: Error) => void;
  const firstCopy = new Promise<void>((_, reject) => {
    rejectFirst = reject;
  });
  const writeText = vi.fn().mockReturnValueOnce(firstCopy).mockResolvedValueOnce(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const onCopy = vi.fn();
  render(<CopyButton aria-label="Copy" value="example" onCopy={onCopy} />);
  const button = screen.getByRole("button", { name: "Copy" });

  fireEvent.click(button);
  fireEvent.click(button);
  await waitFor(() => expect(onCopy).toHaveBeenCalledTimes(1));
  await act(async () => rejectFirst(new Error("Permission denied")));

  expect(screen.queryByRole("alert")).toBeNull();
  expect(button.querySelector(".lucide-check")).toBeTruthy();
  expect(onCopy).toHaveBeenCalledTimes(1);
});

it("ignores an older success after a newer copy fails", async () => {
  let resolveFirst!: () => void;
  const firstCopy = new Promise<void>((resolve) => {
    resolveFirst = resolve;
  });
  const writeText = vi
    .fn()
    .mockReturnValueOnce(firstCopy)
    .mockRejectedValueOnce(new Error("Permission denied"));
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const onCopy = vi.fn();
  render(<CopyButton aria-label="Copy" value="example" onCopy={onCopy} />);
  const button = screen.getByRole("button", { name: "Copy" });

  fireEvent.click(button);
  fireEvent.click(button);
  await screen.findByRole("alert");
  await act(async () => resolveFirst());

  expect(screen.getByRole("alert").textContent).toBe("Could not copy to clipboard. Try again.");
  expect(button.querySelector(".lucide-check")).toBeNull();
  expect(onCopy).not.toHaveBeenCalled();
});

it("ignores a pending copy after the button unmounts", async () => {
  let resolveCopy!: () => void;
  const writeText = vi.fn().mockReturnValue(
    new Promise<void>((resolve) => {
      resolveCopy = resolve;
    }),
  );
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const onCopy = vi.fn();
  const { unmount } = render(<CopyButton aria-label="Copy" value="example" onCopy={onCopy} />);
  fireEvent.click(screen.getByRole("button", { name: "Copy" }));
  unmount();
  await act(async () => resolveCopy());
  expect(onCopy).not.toHaveBeenCalled();
});
