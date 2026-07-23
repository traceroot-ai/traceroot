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
  finding_id: "finding-1",
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
    render(<DetectorRunsTable rows={[]} onTraceClick={vi.fn()} onRunClick={vi.fn()} />);
    for (const header of [
      "Timestamp",
      "Run ID",
      "Trace ID",
      "Identified",
      "Summary",
      "Status",
      "Agent analysis",
    ]) {
      expect(screen.getByRole("columnheader", { name: header })).toBeTruthy();
    }
    // The finding id is an opaque internal correlation id — never displayed
    // (its hyphenated uuid also line-wrapped and doubled the row height).
    expect(screen.queryByRole("columnheader", { name: "Finding ID" })).toBeNull();
  });

  it("shows N/A in the Agent analysis cell for a findingless run", () => {
    render(<DetectorRunsTable rows={[cleanRun]} onTraceClick={vi.fn()} onRunClick={vi.fn()} />);
    // No finding -> RCA not applicable. The Identified cell reads "No".
    expect(screen.getByText("N/A")).toBeTruthy();
    expect(screen.getByText("No")).toBeTruthy();
  });

  it("shows the RCA label in the Agent analysis cell for a triggered run", () => {
    render(<DetectorRunsTable rows={[triggeredRun]} onTraceClick={vi.fn()} onRunClick={vi.fn()} />);
    // describeRcaStatus("done") -> "Done"; Yes surfaces, the raw finding id
    // itself is never rendered (it only keys the Identified/RCA cells).
    expect(screen.getByText("Done")).toBeTruthy();
    expect(screen.queryByText("finding-1")).toBeNull();
    expect(screen.getByText("Yes")).toBeTruthy();
    expect(screen.queryByText("N/A")).toBeNull();
  });

  it("fires onTraceClick with the run when its trace_id cell is clicked", () => {
    const onTraceClick = vi.fn();
    render(
      <DetectorRunsTable rows={[triggeredRun]} onTraceClick={onTraceClick} onRunClick={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "trace-triggered" }));

    expect(onTraceClick).toHaveBeenCalledTimes(1);
    expect(onTraceClick).toHaveBeenCalledWith(triggeredRun);
  });

  it("makes only the trace_id cell a click target, not the whole row", () => {
    const onTraceClick = vi.fn();
    render(
      <DetectorRunsTable rows={[triggeredRun]} onTraceClick={onTraceClick} onRunClick={vi.fn()} />,
    );

    // Clicking the summary cell (anywhere but the trace_id button) does nothing.
    fireEvent.click(screen.getByText("Something went wrong"));
    expect(onTraceClick).not.toHaveBeenCalled();

    // The only button in the row is the trace_id cell.
    const row = screen.getByText("Something went wrong").closest("tr")!;
    // trace_id is the only link — run_id is plain text unless self_traced.
    expect(within(row).getAllByRole("button")).toHaveLength(1);
  });

  it("opens the self-trace when a self_traced row is clicked anywhere", () => {
    const onRunClick = vi.fn();
    const onTraceClick = vi.fn();
    const selfRun: BackendRun = {
      ...triggeredRun,
      run_id: "run-self",
      self_traced: true,
    };
    render(
      <DetectorRunsTable rows={[selfRun]} onTraceClick={onTraceClick} onRunClick={onRunClick} />,
    );

    fireEvent.click(screen.getByText("Something went wrong"));

    expect(onRunClick).toHaveBeenCalledTimes(1);
    expect(onRunClick).toHaveBeenCalledWith(selfRun);
    expect(onTraceClick).not.toHaveBeenCalled();
  });

  it("row click does nothing when the run has no self-trace", () => {
    const onRunClick = vi.fn();
    render(
      <DetectorRunsTable rows={[triggeredRun]} onTraceClick={vi.fn()} onRunClick={onRunClick} />,
    );

    fireEvent.click(screen.getByText("Something went wrong"));

    expect(onRunClick).not.toHaveBeenCalled();
  });

  it("trace_id cell still opens the scanned trace, not the self-trace", () => {
    const onRunClick = vi.fn();
    const onTraceClick = vi.fn();
    const selfRun: BackendRun = { ...triggeredRun, self_traced: true };
    render(
      <DetectorRunsTable rows={[selfRun]} onTraceClick={onTraceClick} onRunClick={onRunClick} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "trace-triggered" }));

    expect(onTraceClick).toHaveBeenCalledTimes(1);
    expect(onRunClick).not.toHaveBeenCalled();
  });

  it("links the run_id cell to the self-trace only when self_traced", () => {
    const onRunClick = vi.fn();
    const selfRun: BackendRun = { ...cleanRun, run_id: "run-self", self_traced: true };
    render(<DetectorRunsTable rows={[selfRun]} onTraceClick={vi.fn()} onRunClick={onRunClick} />);

    fireEvent.click(screen.getByRole("button", { name: "run-self" }));
    expect(onRunClick).toHaveBeenCalledWith(selfRun);
  });

  it("renders run_id as plain text when not self_traced", () => {
    const onRunClick = vi.fn();
    render(<DetectorRunsTable rows={[cleanRun]} onTraceClick={vi.fn()} onRunClick={onRunClick} />);

    expect(screen.queryByRole("button", { name: "run-clean" })).toBeNull();
    expect(screen.getByText("run-clean")).toBeTruthy();
  });
});
