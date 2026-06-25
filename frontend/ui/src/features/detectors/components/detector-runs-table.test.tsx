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
    render(<DetectorRunsTable rows={[]} onTraceClick={vi.fn()} />);
    for (const header of [
      "Timestamp",
      "Run ID",
      "Trace ID",
      "Identified",
      "Finding ID",
      "Summary",
      "Status",
      "Agent analysis",
    ]) {
      expect(screen.getByRole("columnheader", { name: header })).toBeTruthy();
    }
  });

  it("shows N/A in the Agent analysis cell for a findingless run", () => {
    render(<DetectorRunsTable rows={[cleanRun]} onTraceClick={vi.fn()} />);
    // No finding -> RCA not applicable. The Identified cell reads "No".
    expect(screen.getByText("N/A")).toBeTruthy();
    expect(screen.getByText("No")).toBeTruthy();
  });

  it("shows the RCA label in the Agent analysis cell for a triggered run", () => {
    render(<DetectorRunsTable rows={[triggeredRun]} onTraceClick={vi.fn()} />);
    // describeRcaStatus("done") -> "Done"; the finding id and Yes also surface.
    expect(screen.getByText("Done")).toBeTruthy();
    expect(screen.getByText("finding-1")).toBeTruthy();
    expect(screen.getByText("Yes")).toBeTruthy();
    expect(screen.queryByText("N/A")).toBeNull();
  });

  it("fires onTraceClick with the run when its trace_id cell is clicked", () => {
    const onTraceClick = vi.fn();
    render(<DetectorRunsTable rows={[triggeredRun]} onTraceClick={onTraceClick} />);

    fireEvent.click(screen.getByRole("button", { name: "trace-triggered" }));

    expect(onTraceClick).toHaveBeenCalledTimes(1);
    expect(onTraceClick).toHaveBeenCalledWith(triggeredRun);
  });

  it("makes only the trace_id cell a click target, not the whole row", () => {
    const onTraceClick = vi.fn();
    render(<DetectorRunsTable rows={[triggeredRun]} onTraceClick={onTraceClick} />);

    // Clicking the summary cell (anywhere but the trace_id button) does nothing.
    fireEvent.click(screen.getByText("Something went wrong"));
    expect(onTraceClick).not.toHaveBeenCalled();

    // The only button in the row is the trace_id cell.
    const row = screen.getByText("Something went wrong").closest("tr")!;
    expect(within(row).getAllByRole("button")).toHaveLength(1);
  });
});
