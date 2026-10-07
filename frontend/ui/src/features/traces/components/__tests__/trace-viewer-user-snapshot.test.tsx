// @vitest-environment jsdom
//
// Guard for the Global Constraint: "The Traces section and the trace viewer
// for source='user' traces must be byte-identical before and after [the
// agent-trace work]." This snapshot is captured against the UNMODIFIED
// viewer (before Task 18's badge/back-link changes) and must never be
// re-generated (`-u`) once agent-trace changes land — a diff here means an
// agent-only element leaked into the user path.
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

const trace = {
  trace_id: "t1",
  name: "agent_turn",
  source: "user",
  trace_start_time: "2026-01-01T00:00:00Z",
  spans: [
    {
      span_id: "s1",
      parent_span_id: null,
      name: "agent_turn",
      span_kind: "AGENT",
      status: "OK",
      span_start_time: "2026-01-01T00:00:00Z",
      span_end_time: "2026-01-01T00:00:01Z",
    },
  ],
};

// The panel calls useQuery directly (no QueryClientProvider in this render),
// so react-query itself is mocked — mirroring the pattern already used in
// TraceViewerPanel.test.tsx in this repo.
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: trace, isLoading: false, error: null }),
}));
vi.mock("@/lib/api", () => ({ getTrace: vi.fn() }));
vi.mock("../../hooks/use-trace-stream", () => ({ useTraceStream: vi.fn() }));
vi.mock("@/features/detectors/hooks/use-findings", () => ({
  useTraceFindings: () => ({ data: { findings: [] } }),
  useRca: () => ({ data: { rca: null } }),
}));
vi.mock("@/components/layout/app-layout", () => ({
  useLayout: () => ({
    aiPanelOpen: false,
    setAiPanelOpen: vi.fn(),
    setAiContext: vi.fn(),
    setAiInitialSessionId: vi.fn(),
    registerAiHost: () => () => {},
    sidebarCollapsed: false,
  }),
}));
// Heavy children — replaced with lightweight stand-ins so the snapshot
// exercises this panel's own markup (header, sub-header, chrome) without
// coupling to their internals.
vi.mock("../SpanTreeView", () => ({ SpanTreeView: () => <div data-testid="tree" /> }));
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

describe("user-trace viewer is unchanged by agent-trace work", () => {
  it("matches the committed snapshot", async () => {
    const { container, findByText } = render(
      <TraceViewerPanel
        projectId="p1"
        traceId="t1"
        onClose={() => {}}
        onNavigate={() => {}}
        canNavigateUp={false}
        canNavigateDown={false}
        source="user"
      />,
    );
    await findByText("Trace Tree");
    expect(container.innerHTML).toMatchSnapshot();
  });
});
