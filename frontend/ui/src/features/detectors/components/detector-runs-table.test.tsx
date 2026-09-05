// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent, within } from "@testing-library/react";
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
  rca_status: "done",
};

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
        onFindingClick={vi.fn()}
      />,
    );
    for (const header of [
      "Timestamp",
      "Run ID",
      "Trace ID",
      "Finding ID",
      "Identified",
      "Summary",
      "Status",
      "Agent analysis",
    ]) {
      expect(screen.getByRole("columnheader", { name: header })).toBeTruthy();
    }
  });

  it("shows N/A in the Agent analysis cell for a findingless run", () => {
    render(
      <DetectorRunsTable
        rows={[cleanRun]}
        onTraceClick={vi.fn()}
        onRunClick={vi.fn()}
        onFindingClick={vi.fn()}
      />,
    );
    // No finding -> RCA not applicable. The Identified cell reads "No".
    expect(screen.getByText("N/A")).toBeTruthy();
    expect(screen.getByText("No")).toBeTruthy();
  });

  it("shows the RCA label in the Agent analysis cell for a triggered run", () => {
    render(
      <DetectorRunsTable
        rows={[triggeredRun]}
        onTraceClick={vi.fn()}
        onRunClick={vi.fn()}
        onFindingClick={vi.fn()}
      />,
    );
    // describeRcaStatus("done") -> "Done"; Yes surfaces.
    expect(screen.getByText("Done")).toBeTruthy();
    expect(screen.getByText("Yes")).toBeTruthy();
    expect(screen.queryByText("N/A")).toBeNull();
  });

  it("renders the finding_id in the Finding ID cell for a triggered run", () => {
    render(
      <DetectorRunsTable
        rows={[triggeredRun]}
        onTraceClick={vi.fn()}
        onRunClick={vi.fn()}
        onFindingClick={vi.fn()}
      />,
    );
    // The finding id shows as plain (non-clickable) muted mono text — no
    // execution_trace_status means the enrichment is unavailable or ran
    // before tracing was enabled, so there is no analysis trace to open.
    const cell = screen.getByText("finding1");
    expect(cell).toBeTruthy();
    expect(cell.getAttribute("title")).toBe(
      "finding1 — no analysis trace (analysis ran before tracing was enabled)",
    );
    // Unlike trace/run ids, the finding id is not a click target.
    expect(screen.queryByRole("button", { name: "finding1" })).toBeNull();
  });

  it("renders a stored hyphenated finding_id dashless, matching run/trace id shape", () => {
    const hyphenatedRun: BackendRun = {
      ...triggeredRun,
      finding_id: "b3977f86-c96d-f250-b7b5-dd9062a94dfd",
    };
    render(
      <DetectorRunsTable
        rows={[hyphenatedRun]}
        onTraceClick={vi.fn()}
        onRunClick={vi.fn()}
        onFindingClick={vi.fn()}
      />,
    );
    const cell = screen.getByText("b3977f86c96df250b7b5dd9062a94dfd");
    expect(cell).toBeTruthy();
    expect(cell.getAttribute("title")).toBe(
      "b3977f86c96df250b7b5dd9062a94dfd — no analysis trace (analysis ran before tracing was enabled)",
    );
    expect(screen.queryByText("b3977f86-c96d-f250-b7b5-dd9062a94dfd")).toBeNull();
  });

  it("renders an em dash in the Finding ID cell for a findingless run", () => {
    render(
      <DetectorRunsTable
        rows={[cleanRun]}
        onTraceClick={vi.fn()}
        onRunClick={vi.fn()}
        onFindingClick={vi.fn()}
      />,
    );
    // No finding -> muted em dash in the Finding ID cell (column index 3:
    // Timestamp, Run ID, Trace ID, Finding ID), and no finding id text.
    const row = screen.getByText("run-clean").closest("tr")!;
    const findingCell = row.querySelectorAll("td")[3];
    expect(findingCell.textContent).toBe("—");
    expect(screen.queryByText("finding1")).toBeNull();
  });

  it("fires onTraceClick with the run when its trace_id cell is clicked", () => {
    const onTraceClick = vi.fn();
    render(
      <DetectorRunsTable
        rows={[triggeredRun]}
        onTraceClick={onTraceClick}
        onRunClick={vi.fn()}
        onFindingClick={vi.fn()}
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
        onFindingClick={vi.fn()}
      />,
    );

    // Clicking the summary cell (anywhere but the trace_id button) does nothing.
    fireEvent.click(screen.getByText("Something went wrong"));
    expect(onTraceClick).not.toHaveBeenCalled();

    // The only button in the row is the trace_id cell.
    const row = screen.getByText("Something went wrong").closest("tr")!;
    // trace_id is the only link — run_id is plain text unless self_traced.
    expect(within(row).getAllByRole("button")).toHaveLength(1);
  });

  it("makes the id link the only click target — the cell's blank area does nothing", () => {
    const onRunClick = vi.fn();
    const onTraceClick = vi.fn();
    const onFindingClick = vi.fn();
    const run = {
      ...triggeredRun,
      self_traced: true,
      execution_trace_status: "available" as const,
    };
    render(
      <DetectorRunsTable
        rows={[run]}
        onTraceClick={onTraceClick}
        onRunClick={onRunClick}
        onFindingClick={onFindingClick}
      />,
    );

    // The padding around each id is inert.
    for (const id of ["finding1", "trace-triggered", "run-triggered"]) {
      fireEvent.click(screen.getByText(id).closest("td")!);
    }
    expect(onFindingClick).not.toHaveBeenCalled();
    expect(onTraceClick).not.toHaveBeenCalled();
    expect(onRunClick).not.toHaveBeenCalled();

    // The id itself opens its own destination, exactly once.
    fireEvent.click(screen.getByRole("button", { name: "finding1" }));
    fireEvent.click(screen.getByRole("button", { name: "trace-triggered" }));
    fireEvent.click(screen.getByRole("button", { name: "run-triggered" }));
    expect(onFindingClick).toHaveBeenCalledTimes(1);
    expect(onFindingClick).toHaveBeenCalledWith(run);
    expect(onTraceClick).toHaveBeenCalledTimes(1);
    expect(onRunClick).toHaveBeenCalledTimes(1);
  });

  it("row click does nothing even when the run is self_traced — the Run ID link is the way in", () => {
    const onRunClick = vi.fn();
    const onTraceClick = vi.fn();
    const selfRun: BackendRun = {
      ...triggeredRun,
      run_id: "run-self",
      self_traced: true,
    };
    render(
      <DetectorRunsTable
        rows={[selfRun]}
        onTraceClick={onTraceClick}
        onRunClick={onRunClick}
        onFindingClick={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("Something went wrong"));
    expect(onRunClick).not.toHaveBeenCalled();
    expect(onTraceClick).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "run-self" }));
    expect(onRunClick).toHaveBeenCalledTimes(1);
    expect(onRunClick).toHaveBeenCalledWith(selfRun);
  });

  it("row click does nothing when the run has no self-trace", () => {
    const onRunClick = vi.fn();
    render(
      <DetectorRunsTable
        rows={[triggeredRun]}
        onTraceClick={vi.fn()}
        onRunClick={onRunClick}
        onFindingClick={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("Something went wrong"));

    expect(onRunClick).not.toHaveBeenCalled();
  });

  it("trace_id cell still opens the scanned trace, not the self-trace", () => {
    const onRunClick = vi.fn();
    const onTraceClick = vi.fn();
    const selfRun: BackendRun = { ...triggeredRun, self_traced: true };
    render(
      <DetectorRunsTable
        rows={[selfRun]}
        onTraceClick={onTraceClick}
        onRunClick={onRunClick}
        onFindingClick={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "trace-triggered" }));

    expect(onTraceClick).toHaveBeenCalledTimes(1);
    expect(onRunClick).not.toHaveBeenCalled();
  });

  it("links the run_id cell to the self-trace only when self_traced", () => {
    const onRunClick = vi.fn();
    const selfRun: BackendRun = { ...cleanRun, run_id: "run-self", self_traced: true };
    render(
      <DetectorRunsTable
        rows={[selfRun]}
        onTraceClick={vi.fn()}
        onRunClick={onRunClick}
        onFindingClick={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "run-self" }));
    expect(onRunClick).toHaveBeenCalledWith(selfRun);
  });

  it("renders run_id as plain text when not self_traced", () => {
    const onRunClick = vi.fn();
    render(
      <DetectorRunsTable
        rows={[cleanRun]}
        onTraceClick={vi.fn()}
        onRunClick={onRunClick}
        onFindingClick={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "run-clean" })).toBeNull();
    expect(screen.getByText("run-clean")).toBeTruthy();
  });

  it("renders the Finding ID as a button only when the execution trace is available", () => {
    const onFindingClick = vi.fn();
    const available: BackendRun = {
      ...triggeredRun,
      execution_trace_id: "abc",
      execution_trace_status: "available",
    };
    render(
      <DetectorRunsTable
        rows={[available]}
        onTraceClick={vi.fn()}
        onRunClick={vi.fn()}
        onFindingClick={onFindingClick}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "finding1" }));
    expect(onFindingClick).toHaveBeenCalledWith(available);
  });

  it("keeps the Finding ID as plain text when the trace is pending, failed, disabled, or absent", () => {
    for (const status of ["pending", "failed", "disabled", null] as const) {
      cleanup();
      render(
        <DetectorRunsTable
          rows={[{ ...triggeredRun, execution_trace_status: status }]}
          onTraceClick={vi.fn()}
          onRunClick={vi.fn()}
          onFindingClick={vi.fn()}
        />,
      );
      expect(screen.queryByRole("button", { name: "finding1" })).toBeNull();
      expect(screen.getByText("finding1")).toBeTruthy();
    }
  });
});
