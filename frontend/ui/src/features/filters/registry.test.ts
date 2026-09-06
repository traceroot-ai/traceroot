import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { STATIC_FILTER_FIELDS, type FilterFieldDef } from "./registry";

describe("STATIC_FILTER_FIELDS fallback", () => {
  it("covers the trace + membership + aggregate tiers", () => {
    expect(STATIC_FILTER_FIELDS.map((f) => f.field).sort()).toEqual(
      [
        "cost",
        "duration_ms",
        "environment",
        "errors",
        "metadata",
        "model_name",
        "total_tokens",
        "trace_id",
      ].sort(),
    );
  });

  it("exposes metadata as ONE keyed field, not one field per key", () => {
    const keyed = STATIC_FILTER_FIELDS.filter((f) => f.requires_key);
    expect(keyed.map((f) => f.field)).toEqual(["metadata"]);
    // String operators only — values are stored stringified, so there is no per-key type
    // inference and no numeric/boolean comparison to offer.
    expect(keyed[0].operators).toEqual(["eq", "contains"]);
  });

  it("leaves every other field unkeyed", () => {
    for (const f of STATIC_FILTER_FIELDS.filter((f) => f.field !== "metadata")) {
      expect(f.requires_key).toBeFalsy();
    }
  });

  it("declares the right operator set per field type", () => {
    for (const f of STATIC_FILTER_FIELDS) {
      if (f.type === "categorical") expect(f.operators).toEqual(["in"]);
      else if (f.type === "numeric") expect(f.operators).toEqual(["eq", "gt", "gte", "lt", "lte"]);
      else if (f.type === "text") expect(f.operators).toEqual(["eq", "contains"]);
    }
  });

  it("distinct-query categorical fields carry no static values", () => {
    const model = STATIC_FILTER_FIELDS.find((f) => f.field === "model_name")!;
    expect(model.value_source).toBe("distinct_query");
    expect(model.enum_values).toEqual([]);
  });
});

/**
 * STATIC_FILTER_FIELDS is a hand-maintained copy of the backend `FILTER_COLUMNS` tuple, so
 * read the Python and compare rather than pin each side to its own hand-typed literals —
 * which is what let the client ship `level: "SPAN_MEMBERSHIP"` for metadata against the
 * server's `KEYED_MAP` with both suites green.
 */
const COLUMNS_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../backend/rest/services/filters/columns.py",
);

/** columns.py with docstrings and comment lines removed, so prose cannot read as code. */
const columnsSource = readFileSync(COLUMNS_PATH, "utf8")
  .replace(/"""[\s\S]*?"""/g, "")
  .replace(/^[ \t]*#.*$/gm, "");

/** Every `Class.MEMBER` -> serialized value the StrEnums in columns.py declare. */
const enumValues = new Map<string, string>(
  [...columnsSource.matchAll(/^class (\w+)\(StrEnum\):\n([\s\S]*?)(?=\n\S)/gm)].flatMap(
    ([, className, body]) =>
      [...body.matchAll(/^ {4}([A-Z_]+)\s*=\s*"([^"]*)"/gm)].map(
        ([, member, value]) => [`${className}.${member}`, value] as const,
      ),
  ),
);

/** Anything unrecoverable becomes a marker that fails the comparison instead of matching. */
const capture = (source: string, pattern: RegExp) => source.match(pattern)?.[1] ?? "<unparsed>";
const enumValue = (reference: string) => enumValues.get(reference) ?? `<unparsed ${reference}>`;

/** `operators=` is either a tuple literal or a module-level alias of one (`_NUMERIC_OPS`). */
function operatorValues(expression: string): string[] {
  const literal = expression.startsWith("(")
    ? expression
    : capture(columnsSource, new RegExp(`^${expression}\\s*=\\s*\\(([^)]*)\\)`, "m"));
  return [...literal.matchAll(/FilterOperator\.\w+/g)].map((m) => enumValue(m[0]));
}

const TUPLE_DECLARATION = "FILTER_COLUMNS: tuple[FilterColumn, ...] = (";
const tupleBody = columnsSource.slice(
  columnsSource.indexOf(TUPLE_DECLARATION) + TUPLE_DECLARATION.length,
);

/** Every `FilterColumn(...)` in the FILTER_COLUMNS tuple, in declaration order. */
const backendColumns = tupleBody
  .slice(0, tupleBody.indexOf("\n)"))
  // Split on the constructor, not on balanced parens (`countIf(status = 'ERROR')` nests
  // parens in a string), then cut at each entry's own closing paren so a kwarg only some
  // entries declare — `requires_key` — cannot be read across the seam from a neighbour.
  .split("FilterColumn(")
  .slice(1)
  .map((chunk) => chunk.slice(0, chunk.search(/\n\s*\)/)))
  .map((entry) => ({
    field: capture(entry, /\bname="([^"]*)"/),
    label: capture(entry, /\blabel="([^"]*)"/),
    level: enumValue(capture(entry, /\blevel=(FilterLevel\.\w+)/)),
    type: enumValue(capture(entry, /\btype=(FilterType\.\w+)/)),
    operators: operatorValues(capture(entry, /\boperators=(\([^)]*\)|\w+)/)),
    value_source: enumValue(capture(entry, /\bvalue_source=(ValueSource\.\w+)/)),
    // Declared, not derived from the level: the backend treats keyed-ness and lowering
    // scope as independent axes, so a keyed field at a new level must land here as a diff.
    requires_key: /\brequires_key=True/.test(entry),
  }));

/** The part of a client entry the backend also declares. */
const declaredOnBothSides = (field: FilterFieldDef) => ({
  field: field.field,
  label: field.label,
  level: field.level,
  type: field.type,
  operators: [...field.operators],
  value_source: field.value_source,
  requires_key: field.requires_key ?? false,
});

describe("STATIC_FILTER_FIELDS mirrors the backend FILTER_COLUMNS registry", () => {
  it("parses a non-empty registry that declares at least one keyed field", () => {
    // Guards the guard: a registry the parser can no longer read would leave the
    // comparison below with nothing to compare and pass silently.
    expect(
      backendColumns.length,
      `no FilterColumn entries parsed from ${COLUMNS_PATH} — the parity check compares nothing`,
    ).toBeGreaterThan(0);
    expect(
      backendColumns.filter((c) => c.requires_key).length,
      "no keyed field parsed from the backend registry — the requires_key half is vacuous",
    ).toBeGreaterThan(0);
  });

  it("declares every field exactly as the backend declares it, in the same order", () => {
    // Order is the field dropdown's render order, so it is part of the contract.
    expect(
      STATIC_FILTER_FIELDS.map(declaredOnBothSides),
      `STATIC_FILTER_FIELDS disagrees with ${COLUMNS_PATH} — the client is the copy, so update it (or the backend, if the client is right)`,
    ).toEqual(backendColumns);
  });
});
