// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";

// A stand-in for the real TraceViewerPanel that surfaces the props the sheet
// is responsible for. What `embedded` does inside the viewer (no AI-slot
// claim, no nested assistant, no AI button) is covered on the real panel in
// traces/components/__tests__/trace-viewer-agent-header.test.tsx.
vi.mock("@/features/traces/components/TraceViewerPanel", () => ({
  TraceViewerPanel: (props: { source?: string; embedded?: boolean; initialSpanId?: string }) => (
    <div
      data-testid="trace-panel"
      data-source={props.source}
      data-embedded={String(!!props.embedded)}
      data-initial-span={props.initialSpanId ?? ""}
    />
  ),
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

  it("renders the viewer embedded, under the agent scope", () => {
    // TraceViewerPanel is otherwise a fixed 70%-viewport overlay, which would
    // ignore the drawer's bounds and paint over the page; and a chat or RCA
    // run's trace lives under source=agent, never in the customer scope.
    render(<AgentTraceSheet projectId="p1" traceId={"a".repeat(32)} onClose={() => {}} />);
    const panel = screen.getByTestId("trace-panel");
    expect(panel.getAttribute("data-embedded")).toBe("true");
    expect(panel.getAttribute("data-source")).toBe("agent");
    expect(panel.getAttribute("data-initial-span")).toBe("");
  });

  it("hands a tool step's span to the viewer as its deep link", () => {
    render(
      <AgentTraceSheet projectId="p1" traceId={"a".repeat(32)} spanId="s2" onClose={() => {}} />,
    );
    expect(screen.getByTestId("trace-panel").getAttribute("data-initial-span")).toBe("s2");
  });
});
