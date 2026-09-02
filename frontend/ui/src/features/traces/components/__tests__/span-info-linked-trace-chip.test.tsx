// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { TraceDetail } from "@/types/api";
import { SpanInfoPanel } from "../SpanInfoPanel";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("../../hooks", () => ({ useSpanIO: () => ({ data: undefined, isLoading: false }) }));

afterEach(() => {
  cleanup();
  push.mockClear();
});

const trace = {
  trace_id: "t1",
  project_id: "p1",
  name: "rca: 2 detectors",
  trace_start_time: "2026-09-01T00:00:00Z",
  user_id: null,
  session_id: null,
  spans: [],
} as unknown as TraceDetail;

describe("SpanInfoPanel linked-trace chip", () => {
  it("renders the label and shortened id, and hands the click to the host when one is given", () => {
    const onOpen = vi.fn();
    render(
      <SpanInfoPanel
        projectId="p1"
        trace={trace}
        selection={{ type: "trace" }}
        linkedTrace={{
          label: "Analyzed trace",
          traceId: "6fe16353eb854df6756b27b8b5a45dbb",
          source: "user",
          onOpen,
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /analyzed trace:\s*6fe16353/i }));
    expect(onOpen).toHaveBeenCalledWith({
      traceId: "6fe16353eb854df6756b27b8b5a45dbb",
      source: "user",
    });
    expect(push).not.toHaveBeenCalled();
  });

  it("without a host handler, closes and deep-links the target on the traces page", () => {
    const onClose = vi.fn();
    render(
      <SpanInfoPanel
        projectId="p1"
        trace={trace}
        selection={{ type: "trace" }}
        onClose={onClose}
        linkedTrace={{
          label: "Analyzed trace",
          traceId: "6fe16353eb854df6756b27b8b5a45dbb",
          source: "user",
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /analyzed trace:/i }));

    expect(onClose).toHaveBeenCalledTimes(1);
    const url = new URL(push.mock.calls[0][0] as string, "http://localhost");
    expect(url.pathname).toBe("/projects/p1/traces");
    expect(url.searchParams.get("traceId")).toBe("6fe16353eb854df6756b27b8b5a45dbb");
    // A customer trace needs no scope; the page opens it as one of its rows.
    expect(url.searchParams.get("source")).toBeNull();
  });

  it("carries the scope for an internal target (a follow-up's Analysis chip)", () => {
    render(
      <SpanInfoPanel
        projectId="p1"
        trace={trace}
        selection={{ type: "trace" }}
        linkedTrace={{
          label: "Analysis",
          traceId: "f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1",
          source: "agent",
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /analysis:\s*f1f1f1f1/i }));
    const url = new URL(push.mock.calls[0][0] as string, "http://localhost");
    expect(url.searchParams.get("source")).toBe("agent");
  });

  it("renders no chip row at all when the trace has no link, user, or session", () => {
    render(<SpanInfoPanel projectId="p1" trace={trace} selection={{ type: "trace" }} />);

    expect(screen.queryByText(/analyzed trace:/i)).toBeNull();
    expect(screen.queryByText(/analysis:/i)).toBeNull();
    expect(screen.queryByText(/user:/i)).toBeNull();
  });
});
