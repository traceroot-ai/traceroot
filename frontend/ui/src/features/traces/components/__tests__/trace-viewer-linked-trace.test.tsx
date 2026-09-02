// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";

const USER_TRACE = "4d51e1b595c508e2e954c5d19e548926";
const RCA_TRACE = "f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1";

// Root metadata as the emitters write it: agent traces snake_case, the
// worker's detector-run self-trace camelCase.
const METADATA: Record<string, string> = {
  [RCA_TRACE]: JSON.stringify({
    kind: "rca",
    finding_id: "f1",
    attempt: 1,
    scanned_trace_id: USER_TRACE,
  }),
  followup1: JSON.stringify({ kind: "followup", finding_id: "f1", parent_trace_id: RCA_TRACE }),
  chat1: JSON.stringify({ kind: "chat", session_id: "s1" }),
  run1: JSON.stringify({ detectorId: "d1", detectorName: "Failure", scannedTraceId: USER_TRACE }),
  digest1: JSON.stringify({ kind: "digest", detectors: [] }),
  // A customer trace's metadata is opaque — even one that happens to carry a
  // key with the same name must never grow a chip.
  t1: JSON.stringify({ scanned_trace_id: "not-ours" }),
};

const mocks = vi.hoisted(() => ({
  lastQuery: undefined as { queryKey: unknown[]; queryFn: () => unknown } | undefined,
  getTrace: vi.fn(async () => undefined),
}));

// The panel calls useQuery directly (no QueryClientProvider in this render):
// serve a minimal loaded trace whose metadata depends on the id asked for.
vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: { queryKey: unknown[]; queryFn: () => unknown }) => {
    mocks.lastQuery = opts;
    const traceId = String(opts.queryKey[2]);
    return {
      data: {
        trace_id: traceId,
        name: "root",
        trace_start_time: "2026-09-01T00:00:00Z",
        metadata: METADATA[traceId] ?? null,
        spans: [],
      },
      isLoading: false,
      error: null,
    };
  },
}));
vi.mock("@/lib/api", () => ({ getTrace: mocks.getTrace }));
vi.mock("../../hooks/use-trace-stream", () => ({ useTraceStream: vi.fn() }));
// The customer trace has a finding with a completed, exported analysis — the
// case that USED to grow a forward chip on the customer trace.
vi.mock("@/features/detectors/hooks/use-findings", () => ({
  useTraceFindings: () => ({ data: { findings: [{ finding_id: "f1" }] } }),
  useRca: () => ({
    data: {
      rca: { sessionId: "s1", status: "done", traceId: RCA_TRACE, traceStatus: "available" },
    },
  }),
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
vi.mock("../SpanTreeView", () => ({ SpanTreeView: () => null }));
vi.mock("../SpanInfoPanel", () => ({
  // Surface the chip as a real button so the test clicks the same entry point
  // the panel exposes, without rendering the full panel.
  SpanInfoPanel: (props: {
    linkedTrace?: {
      label: string;
      traceId: string;
      source: string;
      onOpen?: (t: { traceId: string; source: string }) => void;
    };
  }) => (
    <div data-testid="span-info">
      {props.linkedTrace && (
        <button
          type="button"
          onClick={() =>
            props.linkedTrace!.onOpen?.({
              traceId: props.linkedTrace!.traceId,
              source: props.linkedTrace!.source,
            })
          }
        >
          {props.linkedTrace.label}: {props.linkedTrace.traceId.slice(0, 8)}
        </button>
      )}
    </div>
  ),
}));
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

afterEach(() => {
  cleanup();
  mocks.getTrace.mockClear();
});

const base = {
  projectId: "p1",
  onClose: () => {},
  onNavigate: () => {},
  canNavigateUp: false,
  canNavigateDown: false,
};

describe("Linked-trace chip on internal traces", () => {
  it("an RCA agent trace links to the customer trace it analyzed, from its own metadata", async () => {
    const onOpen = vi.fn();
    render(
      <TraceViewerPanel {...base} traceId={RCA_TRACE} source="agent" onOpenLinkedTrace={onOpen} />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /analyzed trace: 4d51e1b5/i }));
    expect(onOpen).toHaveBeenCalledWith({ traceId: USER_TRACE, source: "user" });
    // The header still identifies the analysis.
    expect(screen.getByText("Agent")).toBeTruthy();
    expect(screen.getByText(/Analysis for finding f1/)).toBeTruthy();
  });

  it("a detector-run self-trace links to the trace it scanned", async () => {
    const onOpen = vi.fn();
    render(
      <TraceViewerPanel {...base} traceId="run1" source="detector" onOpenLinkedTrace={onOpen} />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /analyzed trace: 4d51e1b5/i }));
    expect(onOpen).toHaveBeenCalledWith({ traceId: USER_TRACE, source: "user" });
  });

  it("a follow-up links to the analysis it continues, under the agent scope", async () => {
    const onOpen = vi.fn();
    render(
      <TraceViewerPanel {...base} traceId="followup1" source="agent" onOpenLinkedTrace={onOpen} />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /analysis: f1f1f1f1/i }));
    expect(onOpen).toHaveBeenCalledWith({ traceId: RCA_TRACE, source: "agent" });
  });

  it("a chat turn and a digest summary have nothing to link to", async () => {
    const { rerender } = render(<TraceViewerPanel {...base} traceId="chat1" source="agent" />);
    expect(await screen.findByTestId("span-info")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /analy/i })).toBeNull();

    rerender(<TraceViewerPanel {...base} traceId="digest1" source="detector" />);
    expect(screen.queryByRole("button", { name: /analy/i })).toBeNull();
  });

  it("a customer trace never grows a chip, even with an available analysis or a look-alike metadata key", async () => {
    render(<TraceViewerPanel {...base} traceId="t1" source="user" />);
    expect(await screen.findByTestId("span-info")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /analy/i })).toBeNull();
    // The analysis is still reachable from the finding: the Alert button is there.
    expect(screen.getByRole("button", { name: /alert/i })).toBeTruthy();
    // And the viewer fetches the customer trace under the customer scope only.
    expect(mocks.lastQuery!.queryKey).toEqual(["trace", "p1", "t1", "user"]);
  });

  it("hides the Detectors tab on internal traces — detectors never target those", async () => {
    const { rerender } = render(<TraceViewerPanel {...base} traceId="t1" source="user" />);
    expect(await screen.findByRole("button", { name: /detectors/i })).toBeTruthy();

    rerender(<TraceViewerPanel {...base} traceId={RCA_TRACE} source="agent" />);
    expect(screen.queryByRole("button", { name: /detectors/i })).toBeNull();

    rerender(<TraceViewerPanel {...base} traceId="run1" source="detector" />);
    expect(screen.queryByRole("button", { name: /detectors/i })).toBeNull();
  });

  it("falls back to the tree view when the Detectors tab disappears while active", async () => {
    // The detectors page keeps one panel mounted and re-points it from an
    // original trace to a self-trace or a Finding cell's agent trace.
    const { rerender } = render(<TraceViewerPanel {...base} traceId="t1" source="user" />);
    fireEvent.click(await screen.findByRole("button", { name: /detectors/i }));
    expect(screen.getByTestId("detectors-tab")).toBeTruthy();
    expect(screen.queryByTestId("span-info")).toBeNull();

    rerender(<TraceViewerPanel {...base} traceId={RCA_TRACE} source="agent" />);

    expect(screen.queryByRole("button", { name: /detectors/i })).toBeNull();
    expect(screen.queryByTestId("detectors-tab")).toBeNull();
    expect(await screen.findByTestId("span-info")).toBeTruthy();
  });

  it("pops an internal trace out under its own id and scope, so the new tab does not 404", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<TraceViewerPanel {...base} traceId={RCA_TRACE} source="agent" />);
    fireEvent.click(await screen.findByTitle("Open in new tab"));

    expect(open).toHaveBeenCalledTimes(1);
    const url = new URL(open.mock.calls[0][0] as string, "http://localhost");
    expect(url.pathname).toBe("/projects/p1/traces");
    expect(url.searchParams.get("traceId")).toBe(RCA_TRACE);
    expect(url.searchParams.get("source")).toBe("agent");
    open.mockRestore();
  });
});
