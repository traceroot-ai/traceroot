// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MessageList } from "../components/message-list";
import { DEMO_EXAMPLES } from "./demo-agent-example";

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

it.each(DEMO_EXAMPLES)(
  "renders the recorded $session.title without fetching live data",
  ({ messages }) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<MessageList messages={messages} projectId="demo" />);
    expect(screen.getByText(messages[0].content)).toBeTruthy();
    expect(screen.getAllByRole("heading").length).toBeGreaterThan(0);
    expect(fetchMock).not.toHaveBeenCalled();
  },
);
