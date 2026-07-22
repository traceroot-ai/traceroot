"use client";

import { cn, formatDate } from "@/lib/utils";
import { describeRcaStatus, type BackendRun } from "@/features/detectors/hooks/use-findings";
import { DETECTOR_TH, DETECTOR_TD, IdentifiedBadge, SummaryText } from "./detector-table-cells";

interface DetectorRunsTableProps {
  rows: BackendRun[];
  /** Fired when a row's trace_id cell is clicked — opens the run's trace. */
  onTraceClick: (run: BackendRun) => void;
  /** Fired when a self-traced run's run_id cell is clicked — opens its self-trace. */
  onRunClick: (run: BackendRun) => void;
}

/**
 * One table for both the Runs and Findings tabs — Findings is just Runs filtered
 * to triggered rows, so the two differ only by the `rows` they receive.
 *
 * The Agent-analysis cell keys "N/A" on `finding_id` (not on `rca_status`): a
 * run with no finding has nothing to analyze, while a triggered run shows its
 * stored RCA state via `describeRcaStatus`. Clicking anywhere on a row opens
 * the run's own self-trace when one exists (`self_traced`); historical or
 * failed-emit runs have no self-trace, so their rows are inert and their
 * run_id stays plain text. The `trace_id` cell is the one cell that routes
 * elsewhere — the scanned trace — so it stops row-click propagation.
 */
export function DetectorRunsTable({ rows, onTraceClick, onRunClick }: DetectorRunsTableProps) {
  return (
    <table className="w-full">
      <thead className="sticky top-0 bg-background">
        <tr className="border-b border-border bg-muted/50">
          <th className={cn(DETECTOR_TH, "w-[160px]")}>Timestamp</th>
          <th className={cn(DETECTOR_TH, "w-[280px]")}>Run ID</th>
          <th className={DETECTOR_TH}>Trace ID</th>
          <th className={cn(DETECTOR_TH, "w-[80px]")}>Identified</th>
          <th className={DETECTOR_TH}>Summary</th>
          <th className={cn(DETECTOR_TH, "w-[90px]")}>Status</th>
          <th className={cn(DETECTOR_TH, "w-[110px] border-r-0")}>Agent analysis</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((run) => {
          const rca = describeRcaStatus(run.rca_status);
          return (
            <tr
              key={run.run_id}
              onClick={run.self_traced ? () => onRunClick(run) : undefined}
              className={cn(
                "border-b border-border/50 transition-colors last:border-0 hover:bg-muted/50",
                run.self_traced && "cursor-pointer",
              )}
            >
              <td className={cn(DETECTOR_TD, "whitespace-nowrap text-muted-foreground")}>
                {formatDate(run.timestamp)}
              </td>
              <td className={cn(DETECTOR_TD, "font-mono text-[11px]")}>
                {run.self_traced ? (
                  <button
                    type="button"
                    onClick={(e) => {
                      // Same destination as the row click; stop propagation so
                      // one click doesn't fire the navigation twice.
                      e.stopPropagation();
                      onRunClick(run);
                    }}
                    title={run.run_id}
                    className="block max-w-full truncate text-left text-muted-foreground transition-colors hover:text-foreground hover:underline"
                  >
                    {run.run_id}
                  </button>
                ) : (
                  <span className="text-muted-foreground">{run.run_id}</span>
                )}
              </td>
              <td className={cn(DETECTOR_TD, "font-mono text-[11px]")}>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onTraceClick(run);
                  }}
                  title={run.trace_id}
                  className="block max-w-full truncate text-left text-muted-foreground transition-colors hover:text-foreground hover:underline"
                >
                  {run.trace_id}
                </button>
              </td>
              <td className={DETECTOR_TD}>
                <IdentifiedBadge identified={run.finding_id != null} />
              </td>
              <td className={cn(DETECTOR_TD, "max-w-[400px] text-foreground")}>
                <SummaryText summary={run.summary} />
              </td>
              <td className={cn(DETECTOR_TD, "capitalize text-muted-foreground")}>{run.status}</td>
              <td className={cn(DETECTOR_TD, "whitespace-nowrap border-r-0")}>
                {run.finding_id == null ? (
                  <span
                    className="text-muted-foreground"
                    title="No finding — root cause analysis is not applicable"
                  >
                    N/A
                  </span>
                ) : (
                  <span className={rca.className} title={rca.title}>
                    {rca.label}
                  </span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
