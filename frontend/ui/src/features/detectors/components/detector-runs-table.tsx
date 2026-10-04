"use client";

import Link from "next/link";
import { cn, formatDate } from "@/lib/utils";
import type { BackendRun } from "@/features/detectors/hooks/use-findings";
import { DETECTOR_TH, DETECTOR_TD, IdentifiedBadge, SummaryText } from "./detector-table-cells";

interface DetectorRunsTableProps {
  rows: BackendRun[];
  /** Fired when a row's trace_id cell is clicked — opens the run's trace. */
  onTraceClick: (run: BackendRun) => void;
  /** Fired when a self-traced run's run_id cell is clicked — opens its self-trace. */
  onRunClick: (run: BackendRun) => void;
  /** Fired when a run's Agent Run ID cell is clicked — opens the RCA agent trace of its trace. */
  onAgentRunClick: (run: BackendRun) => void;
  /** Where a Signal ID cell links: the Signals page with that signal open. */
  signalHref: (signalId: string) => string;
}

/**
 * One id column's cell. The id itself is the only click target: the inner
 * button opens that id's destination, and the cell's padding, like the rest of
 * the row, does nothing (team UX decision — a link looks like a link, and
 * nothing else in the table reacts to a click).
 *
 * `onOpen` undefined means this id has nothing to open (a run with no
 * self-trace): the cell renders as plain text.
 */
function IdCell({ id, title, onOpen }: { id: string; title: string; onOpen?: () => void }) {
  return (
    <td className={cn(DETECTOR_TD, "font-mono text-[11px]")}>
      {onOpen ? (
        <button
          type="button"
          title={title}
          onClick={onOpen}
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

/** A muted dash for an id cell with nothing to show. */
function EmptyIdCell() {
  return (
    <td className={cn(DETECTOR_TD, "font-mono text-[11px]")}>
      <span className="text-muted-foreground">—</span>
    </td>
  );
}

/**
 * A detector's runs; its findings are the same rows filtered to Identified.
 *
 * Each id cell opens its own id: Judge Run ID the run's self-trace, Trace ID the
 * scanned customer trace, Signal ID the signal the hit joined (on the Signals
 * page), Agent Run ID the agent trace of the RCA that analysed this run's own
 * judge output; a run that only joined a signal analysed on another trace
 * shows a dash. Historical or failed-emit runs have no self-trace, so
 * their run_id stays plain text.
 */
export function DetectorRunsTable({
  rows,
  onTraceClick,
  onRunClick,
  onAgentRunClick,
  signalHref,
}: DetectorRunsTableProps) {
  return (
    <table className="w-full">
      <thead className="sticky top-0 bg-background">
        <tr className="border-b border-border bg-muted/50">
          <th className={cn(DETECTOR_TH, "w-[160px]")}>Timestamp</th>
          <th className={cn(DETECTOR_TH, "w-[280px]")}>Judge Run ID</th>
          <th className={DETECTOR_TH}>Trace ID</th>
          <th className={DETECTOR_TH}>Signal ID</th>
          <th className={DETECTOR_TH}>Agent Run ID</th>
          <th className={cn(DETECTOR_TH, "w-[80px]")}>Identified</th>
          <th className={DETECTOR_TH}>Summary</th>
          <th className={cn(DETECTOR_TH, "w-[90px] border-r-0")}>Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((run) => (
          <tr
            key={run.run_id}
            className="border-b border-border/50 transition-colors last:border-0 hover:bg-muted/50"
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
            {run.signal_id ? (
              <td className={cn(DETECTOR_TD, "font-mono text-[11px]")}>
                <Link
                  href={signalHref(run.signal_id)}
                  title={`${run.signal_id} — open the signal`}
                  className="block max-w-full truncate text-muted-foreground transition-colors hover:text-foreground hover:underline"
                >
                  {run.signal_id}
                </Link>
              </td>
            ) : (
              <EmptyIdCell />
            )}
            {run.agent_trace_id ? (
              <IdCell
                id={run.agent_trace_id}
                title={`${run.agent_trace_id} — open the root cause analysis of this trace`}
                onOpen={() => onAgentRunClick(run)}
              />
            ) : (
              <EmptyIdCell />
            )}
            <td className={DETECTOR_TD}>
              {/* A failed run reached no verdict, so it is neither Yes nor No. */}
              {run.status === "failed" ? (
                <span className="text-muted-foreground">—</span>
              ) : (
                <IdentifiedBadge identified={run.finding_id != null} />
              )}
            </td>
            <td className={cn(DETECTOR_TD, "max-w-[400px] text-foreground")}>
              <SummaryText summary={run.summary} />
            </td>
            <td className={cn(DETECTOR_TD, "border-r-0 capitalize text-muted-foreground")}>
              {run.status}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
