// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";

const trace = {
  trace_id: "f".repeat(32),
  name: "rca: Failure Detector",
  source: "agent",
  trace_start_time: "2026-01-01T00:00:00Z",
  metadata: JSON.stringify({
    kind: "rca",
    finding_id: "3817f98c-1876-6de9-30a2-66452c8e1e9f",
    attempt: 1,
  }),
  spans: [
    {
      span_id: "s1",
      parent_span_id: null,
      name: "rca: Failure Detector",
      span_kind: "AGENT",
      status: "OK",
      span_start_time: "2026-01-01T00:00:00Z",
      span_end_time: "2026-01-01T00:00:01Z",
    },
  ],
};

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: trace, isLoading: false, error: null }),
}));
vi.mock("@/lib/api", () => ({ getTrace: vi.fn() }));
vi.mock("../../hooks/use-trace-stream", () => ({ useTraceStream: vi.fn() }));
vi.mock("@/features/detectors/hooks/use-findings", () => ({
  useTraceFindings: () => ({ data: { findings: [] } }),
  useRca: () => ({ data: { rca: null } }),
}));
const layoutMocks = vi.hoisted(() => ({ registerAiHost: vi.fn(() => () => {}) }));
vi.mock("@/components/layout/app-layout", () => ({
  useLayout: () => ({
    // Deliberately true: the state a real host page is in while the sheet is open.
    aiPanelOpen: true,
    setAiPanelOpen: vi.fn(),
    setAiContext: vi.fn(),
    setAiInitialSessionId: vi.fn(),
    registerAiHost: layoutMocks.registerAiHost,
    sidebarCollapsed: false,
  }),
}));
vi.mock("../SpanTreeView", () => ({ SpanTreeView: () => null }));
vi.mock("../SpanInfoPanel", () => ({ SpanInfoPanel: () => <div data-testid="span-info" /> }));
vi.mock("../SpanTimelineView", () => ({ SpanTimelineView: () => <div data-testid="timeline" /> }));
vi.mock("../TraceDetectorsTab", () => ({
  TraceDetectorsTab: () => <div data-testid="detectors-tab" />,
}));
vi.mock("@/features/ai-assistant/components/ai-assistant-panel", () => ({
  AiAssistantPanel: () => <div data-testid="ai-panel" />,
}));
vi.mock("@/components/RetentionGateBanner", () => ({
  RetentionGateBanner: () => <div data-testid="retention-banner" />,
}));
vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizablePanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizableHandle: () => null,
}));

import { TraceViewerPanel } from "../TraceViewerPanel";

it("shows the Agent badge and the finding back-link for an agent trace", async () => {
  const { findByText } = render(
    <TraceViewerPanel
      projectId="p1"
      traceId={"f".repeat(32)}
      onClose={() => {}}
      onNavigate={() => {}}
      canNavigateUp={false}
      canNavigateDown={false}
      source="agent"
    />,
  );
  expect(await findByText("Agent")).toBeTruthy();
  expect(await findByText(/Analysis for finding 3817f98c1876/)).toBeTruthy();
});

it("embedded: never claims the AI slot, never mounts a nested assistant, hides the AI button", async () => {
  cleanup();
  layoutMocks.registerAiHost.mockClear();
  const { findByText, queryByTestId, queryByTitle } = render(
    <TraceViewerPanel
      projectId="p1"
      traceId={"f".repeat(32)}
      onClose={() => {}}
      onNavigate={() => {}}
      canNavigateUp={false}
      canNavigateDown={false}
      source="agent"
      embedded
    />,
  );
  await findByText("Agent");
  expect(layoutMocks.registerAiHost).not.toHaveBeenCalled();
  expect(queryByTestId("ai-panel")).toBeNull();
  expect(queryByTitle("AI Assistant")).toBeNull();
});
