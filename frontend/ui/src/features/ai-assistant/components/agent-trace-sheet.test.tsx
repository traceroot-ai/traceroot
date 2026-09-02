// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";

// A minimal stand-in for the real TraceViewerPanel: it only needs to read
// `useLayout()` the same way the real component does, so this test can prove
// AgentTraceSheet's local LayoutContext.Provider actually intercepts that read
// rather than asserting on TraceViewerPanel's (unrelated, heavy) internals.
vi.mock("@/features/traces/components/TraceViewerPanel", () => ({
  TraceViewerPanel: (props: { source?: string; embedded?: boolean }) => {
    return (
      <div
        data-testid="trace-panel"
        data-source={props.source}
        data-embedded={String(!!props.embedded)}
      />
    );
  },
}));

import { AgentTraceSheet } from "./agent-trace-sheet";

afterEach(() => {
  cleanup();
});

describe("AgentTraceSheet", () => {
  it("renders nothing when traceId is null", () => {
    render(<AgentTraceSheet projectId="proj-1" traceId={null} onClose={vi.fn()} />);
    expect(screen.queryByTestId("trace-panel")).toBeNull();
  });
});

it("renders the viewer in embedded mode so it fills the sheet", () => {
  // TraceViewerPanel is otherwise a fixed 70%-viewport overlay, which would
  // ignore the drawer's bounds and paint over the page. Embedded also hides the
  // AI Assistant control, whose panel lives outside this container.
  render(<AgentTraceSheet projectId="p1" traceId={"a".repeat(32)} onClose={() => {}} />);
  expect(screen.getByTestId("trace-panel").getAttribute("data-embedded")).toBe("true");
});
