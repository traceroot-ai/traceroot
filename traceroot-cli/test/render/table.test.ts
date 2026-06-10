import { describe, it, expect } from "vitest";
import { renderTable, type Column } from "../../src/render/table.js";

interface Row {
  id: string;
  name: string;
}

const COLUMNS: Column<Row>[] = [
  { header: "ID", accessor: (r) => r.id },
  { header: "NAME", accessor: (r) => r.name },
];

describe("renderTable", () => {
  it("returns a no-results message for an empty array", () => {
    expect(renderTable([], COLUMNS)).toBe("(no results)\n");
  });

  it("includes headers in the output", () => {
    const result = renderTable([{ id: "1", name: "span-a" }], COLUMNS);
    expect(result).toContain("ID");
    expect(result).toContain("NAME");
  });

  it("includes a separator row between header and data", () => {
    const result = renderTable([{ id: "1", name: "span-a" }], COLUMNS);
    expect(result).toMatch(/[-]+/);
  });

  it("includes row data in the output", () => {
    const result = renderTable([{ id: "abc123", name: "my-span" }], COLUMNS);
    expect(result).toContain("abc123");
    expect(result).toContain("my-span");
  });

  it("pads all lines to the same length", () => {
    const rows: Row[] = [
      { id: "short", name: "x" },
      { id: "much-longer-id", name: "y" },
    ];
    const result = renderTable(rows, COLUMNS);
    const lines = result.split("\n").filter(Boolean);
    const lengths = new Set(lines.map((l) => l.length));
    expect(lengths.size).toBe(1);
  });

  it("renders multiple rows", () => {
    const rows: Row[] = [
      { id: "1", name: "alpha" },
      { id: "2", name: "beta" },
      { id: "3", name: "gamma" },
    ];
    const result = renderTable(rows, COLUMNS);
    expect(result).toContain("alpha");
    expect(result).toContain("beta");
    expect(result).toContain("gamma");
  });
});
