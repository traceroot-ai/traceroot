"use client";

// The trace list table: one column per visible registry entry. Header and body rows map the
// same column list, so they cannot disagree about column order.
import type { ReactElement } from "react";
import type { TraceListItem } from "@/types/api";
import {
  formatDuration,
  formatDate,
  formatCost,
  formatTokenFlow,
  formatExactTokens,
  cn,
} from "@/lib/utils";
import { formatContentPreview } from "../utils";
import { traceMetadataEntries } from "../utils/metadata";
import { TraceMetadataCell } from "./TraceMetadataCell";
import { fixedColumnLabel, isDefaultOnColumn, type FixedColumnId } from "@/features/traces/columns";

// Below this the default columns crush each other once any column is added, so the table
// scrolls horizontally in its container instead of squeezing Input/Output to nothing.
const ADDED_COLUMN_TABLE_MIN_WIDTH = "min-w-[72rem]";

// The right-hand divider, carried by every cell except the one that ends the row. Positional
// rather than pinned to Latency, so hiding the last column leaves no divider on the edge.
const CELL_BORDER = "border-r border-border/50";

const HEADER_CELL = "px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground";

const ADDED_COLUMN_WIDTH = "w-[140px] max-w-[180px]";

// Default-on columns only. An opted-in column always sizes with ADDED_COLUMN_WIDTH, so an
// entry here for one would never be read. Absent means unconstrained: the column takes what
// is left.
const HEADER_WIDTH: Partial<Record<FixedColumnId, string>> = {
  timestamp: "w-[140px]",
  trace_id: "min-w-[280px] max-w-[400px]",
  errors: "w-[60px]",
  spans: "w-[60px]",
  tokens: "w-[100px]",
  cost: "w-[80px]",
};

interface TraceListTableProps {
  traces: TraceListItem[];
  selectedTraceId: string | null;
  onSelectTrace: (traceId: string) => void;
  /** Fixed columns to show, already resolved and in registry order. */
  visibleColumns: FixedColumnId[];
}

export function TraceListTable({
  traces,
  selectedTraceId,
  onSelectTrace,
  visibleColumns,
}: TraceListTableProps) {
  const hasAddedColumns = visibleColumns.some((id) => !isDefaultOnColumn(id));
  const hasColumns = visibleColumns.length > 0;

  return (
    <table className={cn("w-full", hasAddedColumns && ADDED_COLUMN_TABLE_MIN_WIDTH)}>
      {/* Every column can be hidden, so the header row is omitted rather than left empty. */}
      {hasColumns && (
        <thead className="sticky top-0 bg-background">
          <tr className="border-b border-border bg-muted/50">
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
              trace={trace}
              isSelected={selectedTraceId === trace.trace_id}
              onSelect={onSelectTrace}
              columns={visibleColumns}
            />
          ))
        ) : (
          <tr>
            <td className="px-3 py-6 text-center text-[12px] text-muted-foreground">
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
    isDefaultOn ? HEADER_WIDTH[id] : ADDED_COLUMN_WIDTH,
    !isLast && CELL_BORDER,
    HEADER_CELL,
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
  trace,
  isSelected,
  onSelect,
  columns,
}: {
  trace: TraceListItem;
  isSelected: boolean;
  onSelect: (traceId: string) => void;
  /** The same column list the header row walked, so the two cannot fall out of step. */
  columns: readonly FixedColumnId[];
}) {
  return (
    <tr
      onClick={() => onSelect(trace.trace_id)}
      className={cn(
        "cursor-pointer border-b border-border/50 transition-colors last:border-0",
        isSelected ? "bg-muted" : "hover:bg-muted/50",
      )}
    >
      {columns.map((id, position) => {
        const Cell = FIXED_CELLS[id];
        return (
          <Cell
            key={id}
            trace={trace}
            borderClassName={position === columns.length - 1 ? false : CELL_BORDER}
          />
        );
      })}
    </tr>
  );
}

interface FixedCellProps {
  trace: TraceListItem;
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
        "whitespace-nowrap",
        borderClassName,
        "px-3 py-1.5 text-[12px] text-muted-foreground",
      )}
    >
      {formatDate(trace.trace_start_time)}
    </td>
  ),
  name: ({ trace, borderClassName }) => (
    <td className={cn(borderClassName, "px-3 py-1.5 text-[12px] text-foreground")}>{trace.name}</td>
  ),
  trace_id: ({ trace, borderClassName }) => (
    <td
      className={cn(
        "min-w-[280px] max-w-[400px] whitespace-nowrap",
        borderClassName,
        "px-3 py-1.5 font-mono text-[11px] text-muted-foreground",
      )}
    >
      <span className="block truncate" title={trace.trace_id}>
        {trace.trace_id}
      </span>
    </td>
  ),
  errors: ({ trace, borderClassName }) => (
    <td className={cn(borderClassName, "px-3 py-1.5 text-center")}>
      {trace.error_count > 0 ? (
        <span className="inline-flex min-w-5 justify-center rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700 dark:bg-red-950 dark:text-red-400">
          {trace.error_count}
        </span>
      ) : (
        <span className="text-[12px] text-muted-foreground">0</span>
      )}
    </td>
  ),
  spans: ({ trace, borderClassName }) => (
    <td
      className={cn(borderClassName, "px-3 py-1.5 text-center text-[12px] text-muted-foreground")}
    >
      {trace.span_count}
    </td>
  ),
  input: ({ trace, borderClassName }) => (
    <td className={cn("max-w-[180px]", borderClassName, "px-3 py-1.5")}>
      <span className="block truncate font-mono text-[11px] text-muted-foreground">
        {formatContentPreview(trace.input)}
      </span>
    </td>
  ),
  output: ({ trace, borderClassName }) => (
    <td className={cn("max-w-[180px]", borderClassName, "px-3 py-1.5")}>
      <span className="block truncate font-mono text-[11px] text-muted-foreground">
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
          "px-3 py-1.5 text-[12px] text-muted-foreground",
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
    <td className={cn(borderClassName, "px-3 py-1.5 text-[12px] text-foreground")}>
      {trace.total_cost && trace.total_cost > 0 ? formatCost(trace.total_cost) : "-"}
    </td>
  ),
  latency: ({ trace, borderClassName }) => (
    <td
      className={cn(
        "whitespace-nowrap",
        borderClassName,
        "px-3 py-1.5 text-[12px] text-foreground",
      )}
    >
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
    <td
      className={cn(
        "whitespace-nowrap",
        borderClassName,
        "px-3 py-1.5 text-[12px] text-muted-foreground",
      )}
    >
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
    return (
      <td className={cn(borderClassName, "px-3 py-1.5 text-[12px] text-muted-foreground")}>-</td>
    );
  }
  return (
    <td className={cn("max-w-[180px]", borderClassName, "px-3 py-1.5")}>
      <span className="block truncate font-mono text-[11px] text-muted-foreground" title={value}>
        {value}
      </span>
    </td>
  );
}
