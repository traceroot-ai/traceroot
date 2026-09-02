// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { TraceDetail } from "@/types/api";
import { SpanInfoPanel } from "../SpanInfoPanel";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("../../hooks", () => ({ useSpanIO: () => ({ data: undefined, isLoading: false }) }));

afterEach(() => {
  cleanup();
});

const trace = {
  trace_id: "t1",
  project_id: "p1",
  name: "support_agent",
  trace_start_time: "2026-09-01T00:00:00Z",
  user_id: null,
  session_id: null,
  spans: [],
} as unknown as TraceDetail;

describe("SpanInfoPanel analysis chips", () => {
  it("renders the Root cause analysis chip and fires the callback on click", () => {
    const onView = vi.fn();
    render(
      <SpanInfoPanel
        projectId="p1"
        trace={trace}
        selection={{ type: "trace" }}
        onViewAnalysisTrace={onView}
      />,
    );

    const chip = screen.getByRole("button", { name: /root cause analysis/i });
    fireEvent.click(chip);
    expect(onView).toHaveBeenCalledTimes(1);
  });

  it("renders the Analyzed trace return chip with the shortened id and fires its callback", () => {
    const onBack = vi.fn();
    render(
      <SpanInfoPanel
        projectId="p1"
        trace={trace}
        selection={{ type: "trace" }}
        analyzedTrace={{ traceId: "6fe16353eb854df6756b27b8b5a45dbb", onClick: onBack }}
      />,
    );

    const chip = screen.getByRole("button", { name: /analyzed trace:\s*6fe16353/i });
    fireEvent.click(chip);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("renders no chip row at all when the trace has no RCA, user, or session", () => {
    render(<SpanInfoPanel projectId="p1" trace={trace} selection={{ type: "trace" }} />);

    expect(screen.queryByText(/root cause analysis/i)).toBeNull();
    expect(screen.queryByText(/analyzed trace:/i)).toBeNull();
    expect(screen.queryByText(/user:/i)).toBeNull();
  });
});
