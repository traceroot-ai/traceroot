import type { MessageKey } from "@/lib/i18n/messages/en";

// `user_id` and `session_id` must keep these spellings; earlier releases persisted them.
export type FixedColumnId =
  | "timestamp"
  | "name"
  | "trace_id"
  | "errors"
  | "spans"
  | "input"
  | "output"
  | "metadata"
  | "user_id"
  | "session_id"
  | "signal_ids"
  | "input_usage"
  | "output_usage"
  | "total_usage"
  | "tokens"
  | "cost"
  | "latency";

export interface FixedColumn {
  id: FixedColumnId;
  label: string;
  /** The label's translation key. `label` stays as the English text. */
  labelKey: MessageKey;
  isDefaultOn: boolean;
}

export const FIXED_COLUMNS: readonly FixedColumn[] = [
  { id: "timestamp", label: "Timestamp", labelKey: "tracesColumns.timestamp", isDefaultOn: true },
  { id: "name", label: "Name", labelKey: "tracesColumns.name", isDefaultOn: true },
  { id: "trace_id", label: "Trace ID", labelKey: "tracesColumns.traceId", isDefaultOn: true },
  { id: "errors", label: "Errors", labelKey: "tracesColumns.errors", isDefaultOn: true },
  { id: "spans", label: "Spans", labelKey: "tracesColumns.spans", isDefaultOn: true },
  { id: "input", label: "Input", labelKey: "tracesColumns.input", isDefaultOn: true },
  { id: "output", label: "Output", labelKey: "tracesColumns.output", isDefaultOn: true },
  { id: "metadata", label: "Metadata", labelKey: "tracesColumns.metadata", isDefaultOn: false },
  { id: "user_id", label: "User ID", labelKey: "tracesColumns.userId", isDefaultOn: false },
  {
    id: "session_id",
    label: "Session ID",
    labelKey: "tracesColumns.sessionId",
    isDefaultOn: false,
  },
  // A trace's signals, one per detector hit, so possibly several.
  {
    id: "signal_ids",
    label: "Signal IDs",
    labelKey: "tracesColumns.signalIds",
    isDefaultOn: false,
  },
  {
    id: "input_usage",
    label: "Input usage",
    labelKey: "tracesColumns.inputUsage",
    isDefaultOn: false,
  },
  {
    id: "output_usage",
    label: "Output usage",
    labelKey: "tracesColumns.outputUsage",
    isDefaultOn: false,
  },
  {
    id: "total_usage",
    label: "Total usage",
    labelKey: "tracesColumns.totalUsage",
    isDefaultOn: false,
  },
  { id: "tokens", label: "Tokens", labelKey: "tracesColumns.tokens", isDefaultOn: true },
  { id: "cost", label: "Cost", labelKey: "tracesColumns.cost", isDefaultOn: true },
  { id: "latency", label: "Latency", labelKey: "tracesColumns.latency", isDefaultOn: true },
];

const FIXED_COLUMN_IDS: readonly string[] = FIXED_COLUMNS.map((column) => column.id);

/**
 * The columns to render, in registry order, for a stored set of visibility FLIPS — deviations
 * from the defaults, not a set of shown ids, so a column added later needs no migration.
 */
export function visibleFixedColumns(flipped: readonly FixedColumnId[]): FixedColumnId[] {
  return FIXED_COLUMNS.filter((column) => column.isDefaultOn !== flipped.includes(column.id)).map(
    (column) => column.id,
  );
}

export function isFixedColumnId(value: unknown): value is FixedColumnId {
  return typeof value === "string" && FIXED_COLUMN_IDS.includes(value);
}

export function fixedColumnLabel(id: FixedColumnId): string {
  return FIXED_COLUMNS.find((column) => column.id === id)?.label ?? id;
}

/** The translation key of a column's label, for `t()`. */
export function fixedColumnLabelKey(id: FixedColumnId): MessageKey | undefined {
  return FIXED_COLUMNS.find((column) => column.id === id)?.labelKey;
}

export function isDefaultOnColumn(id: FixedColumnId): boolean {
  return FIXED_COLUMNS.find((column) => column.id === id)?.isDefaultOn ?? false;
}
