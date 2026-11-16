// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
