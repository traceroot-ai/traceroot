// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DemoAgentExamples } from "./demo-agent-examples";

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("opens and closes the recorded investigation without requesting a model or a session", () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  render(<DemoAgentExamples projectId="demo" />);
  fireEvent.click(screen.getByRole("button", { name: "View investigation" }));
  expect(screen.getByText(/This appears to be a false positive/)).toBeTruthy();
  expect(screen.getByText(/Recorded demo investigation/)).toBeTruthy();
  expect(screen.queryByRole("textbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Back to examples" }));
  expect(screen.getByText("Example investigations")).toBeTruthy();
  expect(fetchMock).not.toHaveBeenCalled();
});
