/**
 * Minimal dependency-free table renderer for terminal output.
 *
 * Deliberately avoids cli-table3 / columnify to keep the dependency surface
 * small. Sufficient for listing traces in V1.
 */

export interface Column<T> {
  header: string;
  /** Extract the display string for a cell from a row object. */
  accessor: (row: T) => string;
  /** Minimum column width (characters). Defaults to header length. */
  minWidth?: number;
}

function pad(s: string, w: number): string {
  return s.padEnd(w, " ");
}

/**
 * Render an array of objects as a padded plain-text table.
 *
 * @returns A string ending with "\n", ready for process.stdout.write().
 */
export function renderTable<T>(rows: T[], columns: Column<T>[]): string {
  if (rows.length === 0) {
    return "(no results)\n";
  }

  // Compute column widths — maximum of header length, minWidth, and data lengths.
  const widths = columns.map((col) => {
    const base = Math.max(col.minWidth ?? 0, col.header.length);
    return rows.reduce((max, row) => Math.max(max, col.accessor(row).length), base);
  });

  const sep = widths.map((w) => "-".repeat(w)).join("  ");
  const header = columns.map((col, i) => pad(col.header, widths[i]!)).join("  ");
  const dataRows = rows.map((row) =>
    columns.map((col, i) => pad(col.accessor(row), widths[i]!)).join("  "),
  );

  return [header, sep, ...dataRows].join("\n") + "\n";
}
