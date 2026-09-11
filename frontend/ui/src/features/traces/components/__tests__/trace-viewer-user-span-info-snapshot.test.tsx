// @vitest-environment jsdom
//
// Companion to trace-viewer-user-snapshot.test.tsx, which pins the viewer's
// own chrome but mocks SpanInfoPanel away — and SpanInfoPanel's chip row is
// the one place the agent-trace work touched the customer path. This
// snapshot renders the REAL SpanInfoPanel for a customer trace that carries a
// user and a session and has no RCA, so the User:/Session: chips are pinned
// with nothing new beside them. Never re-generate it (`-u`) once agent-trace
// changes land.
//
// Scope, stated plainly: "byte-identical" holds for EVERY customer trace. The
// linked-trace chip in this row is derived from an internal trace's own
// metadata, so a customer trace — with or without an analysis — never gains
// one; the way into an analysis is the finding, not the trace.
process.env.TZ = "UTC";

import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

const trace = {
  trace_id: "t1",
  project_id: "p1",
  name: "agent_turn",
  source: "user",
  user_id: "user-42",
  session_id: "sess-7",
  trace_start_time: "2026-01-01T00:00:00Z",
  trace_end_time: "2026-01-01T00:00:01Z",
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

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: trace, isLoading: false, error: null }),
}));
vi.mock("@/lib/api", () => ({ getTrace: vi.fn() }));
vi.mock("../../hooks/use-trace-stream", () => ({ useTraceStream: vi.fn() }));
// SpanInfoPanel lazily fetches the selection's I/O; nothing to fetch here.
vi.mock("../../hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks")>()),
  useSpanIO: () => ({ data: undefined, isLoading: false, error: null }),
}));
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
// Everything but SpanInfoPanel is a stand-in, as in the chrome snapshot.
vi.mock("../SpanTreeView", () => ({ SpanTreeView: () => <div data-testid="tree" /> }));
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

describe("user-trace span panel (real SpanInfoPanel) is unchanged by agent-trace work", () => {
  it("matches the committed snapshot for a trace with a user and session and no RCA", async () => {
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
    // The chip row is on screen, with exactly the two customer chips.
    await findByText("user-42");
    await findByText("sess-7");
    expect(container.querySelector('[title*="RCA agent run"]')).toBeNull();
    expect(container.querySelector('[title*="Back to the trace"]')).toBeNull();
    expect(container.innerHTML).toMatchSnapshot();
  });
});
