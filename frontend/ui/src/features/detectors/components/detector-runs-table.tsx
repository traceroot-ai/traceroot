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
  /** Fired when a triggered run's Finding ID cell is clicked — opens the RCA agent trace. */
  onFindingClick: (run: BackendRun) => void;
}

/**
 * One id column's cell. The click handler sits on the `<td>`, not on the inner
 * button, so the whole cell — padding included — routes to that id's own
 * destination. With the handler on the button only, the gap beside a short id
 * fell through to the row, and clicking just off a Finding ID opened the
 * scanned trace instead of the analysis. The inner button stays for keyboard
 * users; its click bubbles to the same handler.
 *
 * `onOpen` undefined means this id has nothing to open (a run with no
 * self-trace, a finding whose analysis trace was never recorded): the cell
 * renders as plain text and clicks fall through to the row, as before.
 */
function IdCell({ id, title, onOpen }: { id: string; title: string; onOpen?: () => void }) {
  return (
    <td
      className={cn(DETECTOR_TD, "font-mono text-[11px]", onOpen && "cursor-pointer")}
      onClick={
        onOpen
          ? (e) => {
              e.stopPropagation();
              onOpen();
            }
          : undefined
      }
    >
      {onOpen ? (
        <button
          type="button"
          title={title}
          className="block max-w-full truncate text-left text-muted-foreground transition-colors hover:text-foreground hover:underline"
        >
          {id}
        </button>
      ) : (
        <span title={title} className="block max-w-full truncate text-muted-foreground">
          {id}
        </span>
      )}
    </td>
  );
}

/**
 * One table for both the Runs and Findings tabs — Findings is just Runs filtered
 * to triggered rows, so the two differ only by the `rows` they receive.
 *
 * The Agent-analysis cell keys "N/A" on `finding_id` (not on `rca_status`): a
 * run with no finding has nothing to analyze, while a triggered run shows its
 * stored RCA state via `describeRcaStatus`.
 *
 * Each of the three id cells opens its own id: Run ID the run's self-trace,
 * Trace ID the scanned customer trace, Finding ID the RCA's analysis trace.
 * Every other cell falls through to the row, which opens the run's self-trace
 * when one exists (`self_traced`); historical or failed-emit runs have none, so
 * their rows are inert and their run_id stays plain text.
 */
export function DetectorRunsTable({
  rows,
  onTraceClick,
  onRunClick,
  onFindingClick,
}: DetectorRunsTableProps) {
  return (
    <table className="w-full">
      <thead className="sticky top-0 bg-background">
        <tr className="border-b border-border bg-muted/50">
          <th className={cn(DETECTOR_TH, "w-[160px]")}>Timestamp</th>
          <th className={cn(DETECTOR_TH, "w-[280px]")}>Run ID</th>
          <th className={DETECTOR_TH}>Trace ID</th>
          <th className={DETECTOR_TH}>Finding ID</th>
          <th className={cn(DETECTOR_TH, "w-[80px]")}>Identified</th>
          <th className={DETECTOR_TH}>Summary</th>
          <th className={cn(DETECTOR_TH, "w-[90px]")}>Status</th>
          <th className={cn(DETECTOR_TH, "w-[110px] border-r-0")}>Agent analysis</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((run) => {
          const rca = describeRcaStatus(run.rca_status);
          // Stored finding ids are uuid-hyphenated while run and trace ids are
          // dashless 32-hex; strip at render so the three id columns share one
          // shape. The finding-detail API compares ids hyphen-insensitively,
          // so a copied display id still resolves.
          const findingId = run.finding_id?.replaceAll("-", "") ?? null;
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
              <IdCell
                id={run.run_id}
                title={run.run_id}
                onOpen={run.self_traced ? () => onRunClick(run) : undefined}
              />
              <IdCell id={run.trace_id} title={run.trace_id} onOpen={() => onTraceClick(run)} />
              {findingId == null ? (
                <td className={cn(DETECTOR_TD, "font-mono text-[11px]")}>
                  <span className="text-muted-foreground">—</span>
                </td>
              ) : (
                <IdCell
                  id={findingId}
                  title={
                    run.execution_trace_status === "available"
                      ? `${findingId} — open the analysis trace`
                      : run.execution_trace_status === "pending"
                        ? `${findingId} — analysis trace is being recorded`
                        : run.execution_trace_status != null
                          ? `${findingId} — analysis trace unavailable`
                          : // No execution trace status. Absent means different
                            // things depending on whether an analysis ran at
                            // all, and saying "before tracing was enabled" for
                            // a finding that was never analysed is simply
                            // wrong — rca_status is what distinguishes them.
                            run.rca_status == null
                            ? `${findingId} — not analyzed`
                            : run.rca_status === "done"
                              ? `${findingId} — no analysis trace (analysis ran before tracing was enabled)`
                              : `${findingId} — analysis ${run.rca_status}; no trace`
                  }
                  onOpen={
                    run.execution_trace_status === "available"
                      ? () => onFindingClick(run)
                      : undefined
                  }
                />
              )}
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
