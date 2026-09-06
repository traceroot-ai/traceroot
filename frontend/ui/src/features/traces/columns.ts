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
  | "input_usage"
  | "output_usage"
  | "total_usage"
  | "tokens"
  | "cost"
  | "latency";

export interface FixedColumn {
  id: FixedColumnId;
  label: string;
  isDefaultOn: boolean;
}

export const FIXED_COLUMNS: readonly FixedColumn[] = [
  { id: "timestamp", label: "Timestamp", isDefaultOn: true },
  { id: "name", label: "Name", isDefaultOn: true },
  { id: "trace_id", label: "Trace ID", isDefaultOn: true },
  { id: "errors", label: "Errors", isDefaultOn: true },
  { id: "spans", label: "Spans", isDefaultOn: true },
  { id: "input", label: "Input", isDefaultOn: true },
  { id: "output", label: "Output", isDefaultOn: true },
  { id: "metadata", label: "Metadata", isDefaultOn: false },
  { id: "user_id", label: "User ID", isDefaultOn: false },
  { id: "session_id", label: "Session ID", isDefaultOn: false },
  { id: "input_usage", label: "Input usage", isDefaultOn: false },
  { id: "output_usage", label: "Output usage", isDefaultOn: false },
  { id: "total_usage", label: "Total usage", isDefaultOn: false },
  { id: "tokens", label: "Tokens", isDefaultOn: true },
  { id: "cost", label: "Cost", isDefaultOn: true },
  { id: "latency", label: "Latency", isDefaultOn: true },
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

export function isDefaultOnColumn(id: FixedColumnId): boolean {
  return FIXED_COLUMNS.find((column) => column.id === id)?.isDefaultOn ?? false;
}
