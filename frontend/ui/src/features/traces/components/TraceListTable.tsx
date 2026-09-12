"use client";

// The trace list table: one column per visible registry entry. Header and body rows map the
// same column list, so they cannot disagree about column order.
import type { ReactElement } from "react";
import type { TraceListItem } from "@/types/api";
import { formatDuration, formatCost, formatTokenFlow, formatExactTokens } from "@/lib/utils";
import { formatContentPreview } from "../utils";
import { traceMetadataEntries } from "../utils/metadata";
import { TraceMetadataCell } from "./TraceMetadataCell";
import { fixedColumnLabel, isDefaultOnColumn, type FixedColumnId } from "@/features/traces/columns";
import { Table, TBody, Td, Th, THead, TR, TRHead } from "@/components/ui/table";
import { Timestamp } from "@/features/offline-eval/components";

// Below this the default columns crush each other once any column is added, so the table
// scrolls horizontally in its container instead of squeezing Input/Output to nothing.
const ADDED_COLUMN_TABLE_MIN_WIDTH = "min-w-[72rem]";

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
    <Table className={hasAddedColumns ? ADDED_COLUMN_TABLE_MIN_WIDTH : undefined}>
      {/* Every column can be hidden, so the header row is omitted rather than left empty. */}
      {hasColumns && (
        <THead>
          <TRHead>
            {visibleColumns.map((id) => (
              <ColumnHeader key={id} id={id} />
            ))}
          </TRHead>
        </THead>
      )}
      <TBody>
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
      </TBody>
    </Table>
  );
}

function ColumnHeader({ id }: { id: FixedColumnId }) {
  const label = fixedColumnLabel(id);
  const isDefaultOn = isDefaultOnColumn(id);
  const className = isDefaultOn ? HEADER_WIDTH[id] : ADDED_COLUMN_WIDTH;
  // An opted-in column is narrow enough for its label to outrun it, so that one truncates
  // and keeps the full text in a title; the defaults are sized to fit theirs.
  if (isDefaultOn) return <Th className={className}>{label}</Th>;
  return (
    <Th className={className} title={label}>
      <span className="block truncate">{label}</span>
    </Th>
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
    <TR interactive selected={isSelected} onClick={() => onSelect(trace.trace_id)}>
      {columns.map((id) => {
        const Cell = FIXED_CELLS[id];
        return <Cell key={id} trace={trace} />;
      })}
    </TR>
  );
}

interface FixedCellProps {
  trace: TraceListItem;
}

// One cell renderer per registry id, never keyed by a `TraceListItem` field name: `tokens`
// sums two fields and `latency` reads `duration_ms`, so no id can index the row. The total
// `Record` makes a new or renamed registry id a compile error rather than a missing column.
const FIXED_CELLS: Record<FixedColumnId, (props: FixedCellProps) => ReactElement> = {
  timestamp: ({ trace }) => (
    <Td className="whitespace-nowrap text-muted-foreground">
      <Timestamp iso={trace.trace_start_time} />
    </Td>
  ),
  name: ({ trace }) => <Td className="text-foreground">{trace.name}</Td>,
  trace_id: ({ trace }) => (
    <Td className="min-w-[280px] max-w-[400px] whitespace-nowrap font-mono text-[11px] text-muted-foreground">
      <span className="block truncate" title={trace.trace_id}>
        {trace.trace_id}
      </span>
    </Td>
  ),
  errors: ({ trace }) => (
    <Td className="text-center">
      {trace.error_count > 0 ? (
        <span className="inline-flex min-w-5 justify-center rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700 dark:bg-red-950 dark:text-red-400">
          {trace.error_count}
        </span>
      ) : (
        <span className="text-[12px] text-muted-foreground">0</span>
      )}
    </Td>
  ),
  spans: ({ trace }) => <Td className="text-center text-muted-foreground">{trace.span_count}</Td>,
  input: ({ trace }) => <PreviewCell value={formatContentPreview(trace.input)} />,
  output: ({ trace }) => <PreviewCell value={formatContentPreview(trace.output)} />,
  // The whole payload, shaped like Input and Output. Display-only: a blob is not a value the
  // filter registry can be handed, so a click here could only build a filter matching nothing.
  metadata: ({ trace }) => <TraceMetadataCell entries={traceMetadataEntries(trace)} />,
  user_id: ({ trace }) => <FixedFieldCell value={trace.user_id} />,
  session_id: ({ trace }) => <FixedFieldCell value={trace.session_id} />,
  // The three quantities the Tokens chip compresses into `in → out (total)`, each exact.
  input_usage: ({ trace }) => <UsageCell value={trace.total_input_tokens} />,
  output_usage: ({ trace }) => <UsageCell value={trace.total_output_tokens} />,
  total_usage: ({ trace }) => <UsageCell value={traceTotalTokens(trace)} />,
  tokens: ({ trace }) => {
    // The chip is a shape, not a value: a trace that reported nothing has none to draw.
    const totalTokens = traceTotalTokens(trace) ?? 0;
    return (
      <Td className="whitespace-nowrap text-muted-foreground">
        {totalTokens > 0 ? (
          <span
            title={`${formatExactTokens(trace.total_input_tokens)} → ${formatExactTokens(trace.total_output_tokens)} (${formatExactTokens(totalTokens)})`}
          >
            {formatTokenFlow(trace.total_input_tokens, trace.total_output_tokens)}
          </span>
        ) : (
          "-"
        )}
      </Td>
    );
  },
  cost: ({ trace }) => (
    <Td className="text-foreground">
      {trace.total_cost && trace.total_cost > 0 ? formatCost(trace.total_cost) : "-"}
    </Td>
  ),
  latency: ({ trace }) => (
    <Td className="whitespace-nowrap text-foreground">{formatDuration(trace.duration_ms)}</Td>
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

/** One truncated payload line, the shape Input and Output share. */
function PreviewCell({ value }: { value: string }) {
  return (
    <Td className="max-w-[180px]">
      <span className="block truncate font-mono text-[11px] text-muted-foreground">{value}</span>
    </Td>
  );
}

/**
 * One token count, exact. Absent renders "-" and a recorded zero renders "0"; the split has
 * to happen here because `formatExactTokens` folds null into "0".
 */
function UsageCell({ value }: { value: number | null | undefined }) {
  return (
    <Td className="whitespace-nowrap text-muted-foreground">
      {value == null ? "-" : formatExactTokens(value)}
    </Td>
  );
}

// A fixed field's cell. Never click-to-filter: the filter registry holds no entry for these
// fields, so a clickable value would offer a filter that cannot be built.
function FixedFieldCell({ value }: { value: string | null | undefined }) {
  if (value == null || value === "") {
    return <Td className="text-muted-foreground">-</Td>;
  }
  return (
    <Td className="max-w-[180px]">
      <span className="block truncate font-mono text-[11px] text-muted-foreground" title={value}>
        {value}
      </span>
    </Td>
  );
}
