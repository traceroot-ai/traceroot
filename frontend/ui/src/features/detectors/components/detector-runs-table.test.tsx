// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { DetectorRunsTable } from "./detector-runs-table";
import type { BackendRun } from "@/features/detectors/hooks/use-findings";

const triggeredRun: BackendRun = {
  run_id: "run-triggered",
  detector_id: "det-1",
  project_id: "proj-1",
  trace_id: "trace-triggered",
  finding_id: "finding1",
  status: "completed",
  timestamp: "2026-05-01T12:00:00Z",
  summary: "Something went wrong",
  signal_id: "sig-1",
  agent_trace_id: "agent-trace-1",
};

const signalHref = (signalId: string) => `/projects/proj-1/signals?signalId=${signalId}`;

const cleanRun: BackendRun = {
  run_id: "run-clean",
  detector_id: "det-1",
  project_id: "proj-1",
  trace_id: "trace-clean",
  finding_id: null,
  status: "completed",
  timestamp: "2026-05-01T12:05:00Z",
  summary: "",
};

afterEach(cleanup);

describe("DetectorRunsTable", () => {
  it("renders every column header", () => {
    render(
      <DetectorRunsTable
        rows={[]}
        onTraceClick={vi.fn()}
        onRunClick={vi.fn()}
        onAgentRunClick={vi.fn()}
        signalHref={signalHref}
      />,
    );
    for (const header of [
      "Timestamp",
      "Judge Run ID",
      "Trace ID",
      "Signal ID",
      "Agent Run ID",
      "Identified",
      "Summary",
      "Status",
    ]) {
      expect(screen.getByRole("columnheader", { name: header })).toBeTruthy();
    }
  });

  it("fires onTraceClick with the run when its trace_id cell is clicked", () => {
    const onTraceClick = vi.fn();
    render(
      <DetectorRunsTable
        rows={[triggeredRun]}
        onTraceClick={onTraceClick}
        onRunClick={vi.fn()}
        onAgentRunClick={vi.fn()}
        signalHref={signalHref}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "trace-triggered" }));

    expect(onTraceClick).toHaveBeenCalledTimes(1);
    expect(onTraceClick).toHaveBeenCalledWith(triggeredRun);
  });

  it("makes only the trace_id cell a click target, not the whole row", () => {
    const onTraceClick = vi.fn();
    render(
      <DetectorRunsTable
        rows={[triggeredRun]}
        onTraceClick={onTraceClick}
        onRunClick={vi.fn()}
        onAgentRunClick={vi.fn()}
        signalHref={signalHref}
      />,
    );

    // Clicking the summary cell (anywhere but the trace_id button) does nothing.
    fireEvent.click(screen.getByText("Something went wrong"));
    expect(onTraceClick).not.toHaveBeenCalled();

    // trace_id and agent_trace_id are navigating buttons; run_id is plain text unless
    // self_traced, and the copy buttons write to clipboard without routing.
    const row = screen.getByText("Something went wrong").closest("tr")!;
    expect(
      within(row)
        .getAllByRole("button")
        .map((b) => b.getAttribute("title")),
    ).toEqual([
      "Copy run ID",
      "trace-triggered",
      "Copy trace ID",
      "agent-trace-1 — open the root cause analysis of this trace",
      "Copy agent run ID",
    ]);
  });

  it("makes the id link the only click target — the cell's blank area does nothing", () => {
    const onRunClick = vi.fn();
    const onTraceClick = vi.fn();
    const onAgentRunClick = vi.fn();
    const run = { ...triggeredRun, self_traced: true };
    render(
      <DetectorRunsTable
        rows={[run]}
        onTraceClick={onTraceClick}
        onRunClick={onRunClick}
        onAgentRunClick={onAgentRunClick}
        signalHref={signalHref}
      />,
    );

    // The padding around each id is inert.
    for (const id of ["agent-trace-1", "trace-triggered", "run-triggered"]) {
      fireEvent.click(screen.getByText(id).closest("td")!);
    }
    expect(onAgentRunClick).not.toHaveBeenCalled();
    expect(onTraceClick).not.toHaveBeenCalled();
    expect(onRunClick).not.toHaveBeenCalled();

    // The id itself opens its own destination, exactly once.
    fireEvent.click(screen.getByRole("button", { name: "agent-trace-1" }));
    fireEvent.click(screen.getByRole("button", { name: "trace-triggered" }));
    fireEvent.click(screen.getByRole("button", { name: "run-triggered" }));
    expect(onAgentRunClick).toHaveBeenCalledTimes(1);
    expect(onAgentRunClick).toHaveBeenCalledWith(run);
    expect(onTraceClick).toHaveBeenCalledTimes(1);
    expect(onRunClick).toHaveBeenCalledTimes(1);
  });

  it("row click does nothing even when the run is self_traced — the Judge Run ID link is the way in", () => {
    const onRunClick = vi.fn();
    const onTraceClick = vi.fn();
    const selfRun: BackendRun = {
      ...triggeredRun,
      self_traced: true,
    };
    render(
      <DetectorRunsTable
        rows={[selfRun]}
        onTraceClick={onTraceClick}
        onRunClick={onRunClick}
        onAgentRunClick={vi.fn()}
        signalHref={signalHref}
      />,
    );

    // Clicking the row (not the button) does nothing.
    fireEvent.click(screen.getByText("Something went wrong"));
    expect(onRunClick).not.toHaveBeenCalled();

    // Clicking the Judge Run ID button opens the run.
    fireEvent.click(screen.getByRole("button", { name: "run-triggered" }));
    expect(onRunClick).toHaveBeenCalledTimes(1);
    expect(onRunClick).toHaveBeenCalledWith(selfRun);
  });

  it("fires onRunClick with the run when a self-traced run's run_id cell is clicked", () => {
    const onRunClick = vi.fn();
    const selfRun: BackendRun = {
      ...cleanRun,
      self_traced: true,
      run_id: "run-self",
    };
    render(
      <DetectorRunsTable
        rows={[selfRun]}
        onTraceClick={vi.fn()}
        onRunClick={onRunClick}
        onAgentRunClick={vi.fn()}
        signalHref={signalHref}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "run-self" }));

    expect(onRunClick).toHaveBeenCalledTimes(1);
    expect(onRunClick).toHaveBeenCalledWith(selfRun);
  });

  it("fires both handlers when both cells are clicked in turn", () => {
    const onRunClick = vi.fn();
    const onTraceClick = vi.fn();
    const selfRun: BackendRun = {
      ...triggeredRun,
      self_traced: true,
    };
    render(
      <DetectorRunsTable
        rows={[selfRun]}
        onTraceClick={onTraceClick}
        onRunClick={onRunClick}
        onAgentRunClick={vi.fn()}
        signalHref={signalHref}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "run-triggered" }));
    fireEvent.click(screen.getByRole("button", { name: "trace-triggered" }));

    expect(onRunClick).toHaveBeenCalledTimes(1);
    expect(onTraceClick).toHaveBeenCalledTimes(1);
  });

  it("does not render run_id as a button when self_traced is false", () => {
    render(
      <DetectorRunsTable
        rows={[cleanRun]}
        onTraceClick={vi.fn()}
        onRunClick={vi.fn()}
        onAgentRunClick={vi.fn()}
        signalHref={signalHref}
      />,
    );

    expect(screen.queryByRole("button", { name: "run-clean" })).toBeNull();
    expect(screen.getByText("run-clean")).toBeTruthy();
  });

  it("copies the run, trace, and agent run ids without navigating", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const onRunClick = vi.fn();
    const onTraceClick = vi.fn();
    const onAgentRunClick = vi.fn();
    const selfRun: BackendRun = { ...triggeredRun, self_traced: true };
    render(
      <DetectorRunsTable
        rows={[selfRun]}
        onTraceClick={onTraceClick}
        onRunClick={onRunClick}
        onAgentRunClick={onAgentRunClick}
        signalHref={signalHref}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy run ID" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("run-triggered"));

    fireEvent.click(screen.getByRole("button", { name: "Copy trace ID" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("trace-triggered"));

    fireEvent.click(screen.getByRole("button", { name: "Copy agent run ID" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("agent-trace-1"));

    // The row and cells are click targets; copying must not follow them.
    expect(onRunClick).not.toHaveBeenCalled();
    expect(onTraceClick).not.toHaveBeenCalled();
    expect(onAgentRunClick).not.toHaveBeenCalled();
  });

  it("offers a copy affordance for a run with no self-trace", () => {
    render(
      <DetectorRunsTable
        rows={[cleanRun]}
        onTraceClick={vi.fn()}
        onRunClick={vi.fn()}
        onAgentRunClick={vi.fn()}
        signalHref={signalHref}
      />,
    );

    expect(screen.getByRole("button", { name: "Copy run ID" })).toBeTruthy();
  });

  it("links the Signal ID to the signal, and shows a dash for a run with no signal", () => {
    render(
      <DetectorRunsTable
        rows={[triggeredRun, { ...cleanRun, signal_id: null }]}
        onTraceClick={vi.fn()}
        onRunClick={vi.fn()}
        onAgentRunClick={vi.fn()}
        signalHref={signalHref}
      />,
    );
    const link = screen.getByRole("link", { name: "sig-1" });
    expect(link.getAttribute("href")).toBe("/projects/proj-1/signals?signalId=sig-1");
    const cleanRow = screen.getByText("run-clean").closest("tr")!;
    // Signal ID and Agent Run ID are both dashes on a run that is not a hit.
    expect(within(cleanRow).queryByRole("link")).toBeNull();
    expect(within(cleanRow).getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });

  it("says a hit grouping gave up on is not grouped, apart from one not grouped yet", () => {
    render(
      <DetectorRunsTable
        rows={[{ ...triggeredRun, signal_id: null, agent_trace_id: null, signal_gave_up: true }]}
        onTraceClick={vi.fn()}
        onRunClick={vi.fn()}
        onAgentRunClick={vi.fn()}
        signalHref={signalHref}
      />,
    );
    const cell = screen.getByText("Not grouped");
    expect(cell.getAttribute("title")).toContain("gave up");
    expect(screen.queryByRole("link", { name: "sig-1" })).toBeNull();
  });

  it("shows a dash for Agent Run ID while the signal has no analysis trace", () => {
    render(
      <DetectorRunsTable
        rows={[{ ...triggeredRun, agent_trace_id: null }]}
        onTraceClick={vi.fn()}
        onRunClick={vi.fn()}
        onAgentRunClick={vi.fn()}
        signalHref={signalHref}
      />,
    );
    expect(screen.getByRole("link", { name: "sig-1" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "agent-trace-1" })).toBeNull();
  });

  it("shows a dash, not No, under Identified for a failed run", () => {
    render(
      <DetectorRunsTable
        rows={[{ ...cleanRun, status: "failed" }]}
        onTraceClick={vi.fn()}
        onRunClick={vi.fn()}
        onAgentRunClick={vi.fn()}
        signalHref={signalHref}
      />,
    );
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
    const row = screen.getByText("failed").closest("tr")!;
    expect(row.querySelectorAll("td")[headers.indexOf("Identified")].textContent).toBe("—");
  });
});
