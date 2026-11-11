"use client";

// The trace list table: one column per visible registry entry. Header and body rows map the
// same column list, so they cannot disagree about column order.
import type { ReactElement } from "react";
import Link from "next/link";
import { signalDeepLinkPath } from "@traceroot/core/signals";
import type { TraceListItem } from "@/types/api";
import {
  formatDuration,
  formatDate,
  formatCost,
  formatTokenFlow,
  formatExactTokens,
  cn,
} from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatContentPreview } from "../utils";
import { traceMetadataEntries } from "../utils/metadata";
import { TraceMetadataCell } from "./TraceMetadataCell";
import { fixedColumnLabel, isDefaultOnColumn, type FixedColumnId } from "@/features/traces/columns";

// Below this the default columns crush each other once any column is added, so the table
// scrolls horizontally in its container instead of squeezing Input/Output to nothing.
const ADDED_COLUMN_TABLE_MIN_WIDTH = "min-w-[72rem]";

// The right-hand divider, carried by every cell except the one that ends the row. Positional
// rather than pinned to Latency, so hiding the last column leaves no divider on the edge.
const CELL_BORDER = "border-r border-border";

const HEADER_CELL = "px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground";

const ADDED_COLUMN_WIDTH = "w-[130px] max-w-[130px]";

// Default-on columns only. An opted-in column always sizes with ADDED_COLUMN_WIDTH, so an
// entry here for one would never be read. Absent means unconstrained: the column takes what
// is left.
const HEADER_WIDTH: Partial<Record<FixedColumnId, string>> = {
  timestamp: "w-[140px]",
  trace_id: "min-w-[200px] max-w-[220px]",
  errors: "w-[60px] text-right",
  spans: "w-[60px] text-right",
  tokens: "w-[100px] text-right",
  cost: "w-[80px] text-right",
};

interface TraceListTableProps {
  projectId: string;
  traces: TraceListItem[];
  selectedTraceId: string | null;
  onSelectTrace: (traceId: string) => void;
  /** Fixed columns to show, already resolved and in registry order. */
  visibleColumns: FixedColumnId[];
  /** Each trace's signal ids for the Signal IDs column; undefined until read. */
  signalIdsByTrace?: Record<string, string[]>;
  /** Reading the signal ids failed: the column says so rather than staying blank. */
  signalIdsFailed?: boolean;
}

export function TraceListTable({
  projectId,
  traces,
  selectedTraceId,
  onSelectTrace,
  visibleColumns,
  signalIdsByTrace,
  signalIdsFailed = false,
}: TraceListTableProps) {
  const hasAddedColumns = visibleColumns.some((id) => !isDefaultOnColumn(id));
  const hasColumns = visibleColumns.length > 0;

  return (
    <table className={cn("data-table w-full", hasAddedColumns && ADDED_COLUMN_TABLE_MIN_WIDTH)}>
      {/* Every column can be hidden, so the header row is omitted rather than left empty. */}
      {hasColumns && (
        <thead className="sticky top-0 bg-background">
          <tr className="border-b border-border">
            {visibleColumns.map((id, position) => (
              <ColumnHeader key={id} id={id} isLast={position === visibleColumns.length - 1} />
            ))}
          </tr>
        </thead>
      )}
      <tbody>
        {hasColumns ? (
          traces.map((trace) => (
            <TraceRow
              key={trace.trace_id}
              projectId={projectId}
              trace={trace}
              signalIds={signalIdsByTrace && (signalIdsByTrace[trace.trace_id] ?? [])}
              signalIdsFailed={signalIdsFailed}
              isSelected={selectedTraceId === trace.trace_id}
              onSelect={onSelectTrace}
              columns={visibleColumns}
            />
          ))
        ) : (
          <tr>
            <td className="px-3 py-6 text-center text-muted-foreground">
              No columns selected. Choose one from the Columns menu.
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function ColumnHeader({ id, isLast }: { id: FixedColumnId; isLast: boolean }) {
  const label = fixedColumnLabel(id);
  const isDefaultOn = isDefaultOnColumn(id);
  const className = cn(
    HEADER_CELL,
    isDefaultOn ? HEADER_WIDTH[id] : ADDED_COLUMN_WIDTH,
    !isLast && CELL_BORDER,
  );
  // An opted-in column is narrow enough for its label to outrun it, so that one truncates
  // and keeps the full text in a title; the defaults are sized to fit theirs.
  if (isDefaultOn) return <th className={className}>{label}</th>;
  return (
    <th className={className} title={label}>
      <span className="block truncate">{label}</span>
    </th>
  );
}

function TraceRow({
  projectId,
  trace,
  signalIds,
  signalIdsFailed,
  isSelected,
  onSelect,
  columns,
}: {
  projectId: string;
  trace: TraceListItem;
  signalIds: readonly string[] | undefined;
  signalIdsFailed: boolean;
  isSelected: boolean;
  onSelect: (traceId: string) => void;
  /** The same column list the header row walked, so the two cannot fall out of step. */
  columns: readonly FixedColumnId[];
}) {
  return (
    <tr
      onClick={() => onSelect(trace.trace_id)}
      className={cn(
        "cursor-pointer border-b border-border transition-colors",
        isSelected ? "bg-accent" : "hover:bg-muted",
      )}
    >
      {columns.map((id, position) => {
        const Cell = FIXED_CELLS[id];
        return (
          <Cell
            key={id}
            projectId={projectId}
            trace={trace}
            signalIds={signalIds}
            signalIdsFailed={signalIdsFailed}
            borderClassName={position === columns.length - 1 ? false : CELL_BORDER}
          />
        );
      })}
    </tr>
  );
}

interface FixedCellProps {
  projectId: string;
  trace: TraceListItem;
  /** The trace's signal ids; undefined until read. */
  signalIds: readonly string[] | undefined;
  signalIdsFailed: boolean;
  /** The row divider, or false on the column that ends the row. */
  borderClassName: string | false;
}

// One cell renderer per registry id, never keyed by a `TraceListItem` field name: `tokens`
// sums two fields and `latency` reads `duration_ms`, so no id can index the row. The total
// `Record` makes a new or renamed registry id a compile error rather than a missing column.
const FIXED_CELLS: Record<FixedColumnId, (props: FixedCellProps) => ReactElement> = {
  timestamp: ({ trace, borderClassName }) => (
    <td
      className={cn(
        borderClassName,
        "table-timestamp whitespace-nowrap px-3 py-1.5 text-muted-foreground",
      )}
    >
      {formatDate(trace.trace_start_time)}
    </td>
  ),
  name: ({ trace, borderClassName }) => (
    <td className={cn(borderClassName, "px-3 py-1.5 text-foreground")}>{trace.name}</td>
  ),
  trace_id: ({ trace, borderClassName }) => (
    <td
      className={cn(
        "min-w-[200px] max-w-[220px] whitespace-nowrap",
        borderClassName,
        "px-3 py-1.5 font-mono text-muted-foreground",
      )}
    >
      <span className="block truncate" title={trace.trace_id}>
        {trace.trace_id}
      </span>
    </td>
  ),
  errors: ({ trace, borderClassName }) => (
    <td className={cn(borderClassName, "px-3 py-1.5 text-right tabular-nums")}>
      {trace.error_count > 0 ? (
        <span className="inline-flex min-w-5 justify-center rounded bg-danger-soft px-1.5 py-0.5 text-[12px] font-medium text-danger">
          {trace.error_count}
        </span>
      ) : (
        <span className="text-[12px] text-muted-foreground">0</span>
      )}
    </td>
  ),
  spans: ({ trace, borderClassName }) => (
    <td
      className={cn(borderClassName, "px-3 py-1.5 text-right tabular-nums text-muted-foreground")}
    >
      {trace.span_count}
    </td>
  ),
  input: ({ trace, borderClassName }) => (
    <td className={cn("max-w-[130px]", borderClassName, "px-3 py-1.5")}>
      <span className="block truncate font-mono text-[12px] text-muted-foreground">
        {formatContentPreview(trace.input)}
      </span>
    </td>
  ),
  output: ({ trace, borderClassName }) => (
    <td className={cn("max-w-[130px]", borderClassName, "px-3 py-1.5")}>
      <span className="block truncate font-mono text-[12px] text-muted-foreground">
        {formatContentPreview(trace.output)}
      </span>
    </td>
  ),
  // The whole payload, shaped like Input and Output. Display-only: a blob is not a value the
  // filter registry can be handed, so a click here could only build a filter matching nothing.
  metadata: ({ trace, borderClassName }) => (
    <TraceMetadataCell entries={traceMetadataEntries(trace)} borderClassName={borderClassName} />
  ),
  user_id: ({ trace, borderClassName }) => (
    <FixedFieldCell value={trace.user_id} borderClassName={borderClassName} />
  ),
  session_id: ({ trace, borderClassName }) => (
    <FixedFieldCell value={trace.session_id} borderClassName={borderClassName} />
  ),
  signal_ids: ({ projectId, signalIds, signalIdsFailed, borderClassName }) =>
    signalIds?.length ? (
      <td className={cn("max-w-[130px]", borderClassName, "px-3 py-1.5")}>
        {/* One line per row, always: the first signal id, then a count that opens the rest. */}
        <span className="flex items-center gap-1.5 font-mono text-[12px] text-muted-foreground">
          <SignalLink projectId={projectId} signalId={signalIds[0]} />
          {signalIds.length > 1 && (
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  // The row opens the trace; the count opens the other signals instead.
                  onClick={(e) => e.stopPropagation()}
                  aria-label={`Show ${signalIds.length - 1} more signals`}
                  className="shrink-0 rounded-[2px] px-0.5 transition-colors hover:bg-muted hover:text-foreground"
                >
                  +{signalIds.length - 1}
                </button>
              </PopoverTrigger>
              {/* Portaled, but React events still bubble to the row, so stop them here. */}
              <PopoverContent
                align="start"
                aria-label="More signals"
                onClick={(e) => e.stopPropagation()}
                className="flex w-auto max-w-[20rem] flex-col gap-1 p-2 font-mono text-[12px] text-muted-foreground"
              >
                {signalIds.slice(1).map((signalId) => (
                  <SignalLink key={signalId} projectId={projectId} signalId={signalId} />
                ))}
              </PopoverContent>
            </Popover>
          )}
        </span>
      </td>
    ) : (
      // A dash once read with none, blank while loading, and a mark if the read failed.
      <td className={cn(borderClassName, "px-3 py-1.5 text-muted-foreground")}>
        {signalIds ? (
          "-"
        ) : signalIdsFailed ? (
          <span title="Signal IDs could not be loaded">?</span>
        ) : (
          ""
        )}
      </td>
    ),
  // The three quantities the Tokens chip compresses into `in → out (total)`, each exact.
  input_usage: ({ trace, borderClassName }) => (
    <UsageCell value={trace.total_input_tokens} borderClassName={borderClassName} />
  ),
  output_usage: ({ trace, borderClassName }) => (
    <UsageCell value={trace.total_output_tokens} borderClassName={borderClassName} />
  ),
  total_usage: ({ trace, borderClassName }) => (
    <UsageCell value={traceTotalTokens(trace)} borderClassName={borderClassName} />
  ),
  tokens: ({ trace, borderClassName }) => {
    // The chip is a shape, not a value: a trace that reported nothing has none to draw.
    const totalTokens = traceTotalTokens(trace) ?? 0;
    return (
      <td
        className={cn(
          "whitespace-nowrap",
          borderClassName,
          "px-3 py-1.5 text-right tabular-nums text-muted-foreground",
        )}
      >
        {totalTokens > 0 ? (
          <span
            title={`${formatExactTokens(trace.total_input_tokens)} → ${formatExactTokens(trace.total_output_tokens)} (${formatExactTokens(totalTokens)})`}
          >
            {formatTokenFlow(trace.total_input_tokens, trace.total_output_tokens)}
          </span>
        ) : (
          "-"
        )}
      </td>
    );
  },
  cost: ({ trace, borderClassName }) => (
    <td className={cn(borderClassName, "px-3 py-1.5 text-right tabular-nums text-foreground")}>
      {trace.total_cost && trace.total_cost > 0 ? formatCost(trace.total_cost) : "-"}
    </td>
  ),
  latency: ({ trace, borderClassName }) => (
    <td className={cn("whitespace-nowrap", borderClassName, "px-3 py-1.5 text-foreground")}>
      {formatDuration(trace.duration_ms)}
    </td>
  ),
};

/**
 * The row's total usage, or null when the trace reported neither side. One definition for the
 * Tokens chip and the Total usage column. An unreported side counts as zero; null renders "-".
 */
function traceTotalTokens(trace: TraceListItem): number | null {
  const { total_input_tokens: input, total_output_tokens: output } = trace;
  if (input == null && output == null) return null;
  return (input ?? 0) + (output ?? 0);
}

function SignalLink({ projectId, signalId }: { projectId: string; signalId: string }) {
  return (
    <Link
      href={signalDeepLinkPath(projectId, signalId)}
      // The row opens the trace; a signal id opens the signal instead.
      onClick={(e) => e.stopPropagation()}
      title={`${signalId} — open the signal`}
      className="block min-w-0 truncate transition-colors hover:text-foreground hover:underline"
    >
      {signalId}
    </Link>
  );
}

/**
 * One token count, exact. Absent renders "-" and a recorded zero renders "0"; the split has
 * to happen here because `formatExactTokens` folds null into "0".
 */
function UsageCell({
  value,
  borderClassName,
}: {
  value: number | null | undefined;
  borderClassName: string | false;
}) {
  return (
    <td className={cn("whitespace-nowrap", borderClassName, "px-3 py-1.5 text-muted-foreground")}>
      {value == null ? "-" : formatExactTokens(value)}
    </td>
  );
}

// A fixed field's cell. Never click-to-filter: the filter registry holds no entry for these
// fields, so a clickable value would offer a filter that cannot be built.
function FixedFieldCell({
  value,
  borderClassName,
}: {
  value: string | null | undefined;
  borderClassName: string | false;
}) {
  if (value == null || value === "") {
    return <td className={cn(borderClassName, "px-3 py-1.5 text-muted-foreground")}>-</td>;
  }
  return (
    <td className={cn("max-w-[130px]", borderClassName, "px-3 py-1.5")}>
      <span className="block truncate font-mono text-[12px] text-muted-foreground" title={value}>
        {value}
      </span>
    </td>
  );
}
