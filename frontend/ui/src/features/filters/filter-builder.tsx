"use client";

/**
 * The filter builder (the search-bar popup's content): one row —
 * [ field ▾ ] [ operator ▾ ] [ value ] [ Add filter ].
 *
 * Friendly operators lower to the backend `in`/`between` predicates: numeric
 * equals / greater-than-or-equal / less-than-or-equal all emit a `between` predicate with
 * the right (possibly null) bounds, and categorical `is` emits a one-element `in`. "Add
 * filter" emits one predicate (the parent appends it as a chip) and resets the row.
 *
 * The field/operator/value controls live in `filter-controls` and are shared
 * with the dashboard widget builder's filter rows.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { Predicate } from "@/types/api";
import { useFilterValues } from "./hooks";
import type { FilterFieldDef } from "./registry";
import { buildInPredicate, buildNumericPredicate, buildTextPredicate } from "./predicate-ui";
import {
  Dropdown,
  DropdownItem,
  FIELD_ICONS,
  FIELD_UNIT,
  FieldDropdown,
  NumberField,
  ParkedValueField,
  TextField,
  ValueDropdown,
} from "./filter-controls";

type UiOp = "is" | "eq" | "gt" | "gte" | "lt" | "lte" | "contains";
const OP_LABEL: Record<UiOp, string> = {
  is: "is",
  // Short symbols matching the chip labels and the backend comparison exactly.
  eq: "=",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  contains: "contains",
};
// The UI operators ARE the registry field's `operators` whitelist (the backend op names)
// mapped to their UI labels — categorical `in` reads as "is". Deriving from the registry
// (not branching on `f.type`) means adding a field with a new operator set is one entry
// in this map, no code branch to touch. An unrecognized op contributes nothing.
const REGISTRY_OP_TO_UI: Record<string, UiOp> = {
  in: "is",
  eq: "eq",
  gt: "gt",
  gte: "gte",
  lt: "lt",
  lte: "lte",
  contains: "contains",
};
const opsFor = (f: FilterFieldDef): UiOp[] =>
  f.operators.map((op) => REGISTRY_OP_TO_UI[op]).filter((o): o is UiOp => o !== undefined);

interface FilterBuilderProps {
  projectId: string;
  fields: FilterFieldDef[];
  startAfter?: string;
  endBefore?: string;
  onSubmit: (predicate: Predicate) => void;
}

export function FilterBuilder({
  projectId,
  fields,
  startAfter,
  endBefore,
  onSubmit,
}: FilterBuilderProps) {
  const [field, setField] = useState<FilterFieldDef | null>(null);
  const [op, setOp] = useState<UiOp>("is");
  const [value, setValue] = useState("");

  const reset = () => {
    setField(null);
    setOp("is");
    setValue("");
  };
  const pickField = (f: FilterFieldDef) => {
    setField(f);
    setOp(opsFor(f)[0]);
    setValue("");
  };

  const num = (s: string) => (s.trim() === "" ? null : Number(s));
  const predicate = (): Predicate | null => {
    if (!field) return null;
    if (field.type === "text") {
      // trace_id: a `contains` substring or an exact `=` — a string value, not a number.
      if (value === "") return null;
      return buildTextPredicate(field.field, op === "contains" ? "contains" : "eq", value);
    }
    if (op === "is") return value === "" ? null : buildInPredicate(field.field, [value]);
    // Numeric comparison (eq/gt/gte/lt/lte). Reject NaN/Infinity, and a fractional value
    // on an integer field (e.g. "1e-1" slips the input's decimal-point guard but can't
    // bind as Int64).
    const n = num(value);
    if (n === null || !Number.isFinite(n)) return null;
    if (field.integer && !Number.isInteger(n)) return null;
    if (op === "eq" || op === "gt" || op === "gte" || op === "lt" || op === "lte")
      return buildNumericPredicate(field.field, op, n);
    // No recognized operator (e.g. a field whose registry `operators` map to none) — build
    // nothing rather than silently falling through to a comparison.
    return null;
  };
  const built = predicate();
  // Immediate apply, then clear the row so another filter can be added without the
  // popover closing ("add another row").
  const submit = () => {
    if (!built) return;
    onSubmit(built);
    reset();
  };

  return (
    <div className="flex items-center gap-1 p-1.5">
      <FieldDropdown
        options={fields.map((f) => ({ key: f.field, label: f.label, icon: FIELD_ICONS[f.field] }))}
        valueKey={field?.field ?? null}
        onPick={(key) => {
          const f = fields.find((x) => x.field === key);
          if (f) pickField(f);
        }}
      />
      <Dropdown
        disabled={!field}
        trigger={<span className="whitespace-nowrap">{field ? OP_LABEL[op] : "is"}</span>}
        // Size to the operator label with a floor for the short symbols, so a wide label
        // (e.g. "contains") sits comfortably instead of truncating in a fixed cell.
        triggerClassName="min-w-[3.5rem] shrink-0"
        contentClassName="w-28"
      >
        {(close) =>
          (field ? opsFor(field) : []).map((o) => (
            <DropdownItem
              key={o}
              active={o === op}
              onClick={() => {
                setOp(o);
                close();
              }}
            >
              {OP_LABEL[o]}
            </DropdownItem>
          ))
        }
      </Dropdown>
      <ValueControl
        projectId={projectId}
        field={field}
        startAfter={startAfter}
        endBefore={endBefore}
        value={value}
        onValue={setValue}
        onEnter={submit}
      />
      <Button
        size="sm"
        className="h-7 shrink-0 rounded-md px-2.5 text-xs"
        disabled={!built}
        onClick={submit}
      >
        Add filter
      </Button>
    </div>
  );
}

function ValueControl({
  projectId,
  field,
  startAfter,
  endBefore,
  value,
  onValue,
  onEnter,
}: {
  projectId: string;
  field: FilterFieldDef | null;
  startAfter?: string;
  endBefore?: string;
  value: string;
  onValue: (v: string) => void;
  onEnter: () => void;
}) {
  if (!field) {
    return <ParkedValueField />;
  }
  if (field.type === "categorical") {
    return (
      <CategoricalValue
        projectId={projectId}
        field={field}
        startAfter={startAfter}
        endBefore={endBefore}
        value={value}
        onValue={onValue}
      />
    );
  }
  if (field.type === "text") {
    return (
      <TextField
        ariaLabel="value"
        placeholder="Enter value"
        value={value}
        onChange={onValue}
        onEnter={onEnter}
      />
    );
  }
  return (
    <NumberField
      ariaLabel="value"
      placeholder="Enter value"
      value={value}
      onChange={onValue}
      onEnter={onEnter}
      unit={FIELD_UNIT[field.field]}
      integer={Boolean(field.integer)}
    />
  );
}

function CategoricalValue({
  projectId,
  field,
  startAfter,
  endBefore,
  value,
  onValue,
}: {
  projectId: string;
  field: FilterFieldDef;
  startAfter?: string;
  endBefore?: string;
  value: string;
  onValue: (v: string) => void;
}) {
  const isStatic = field.value_source === "static_enum";
  const { values } = useFilterValues(projectId, field.field, startAfter, endBefore, !isStatic);
  const options: { value: string; count?: number }[] = isStatic
    ? field.enum_values.map((v) => ({ value: v }))
    : values.map((v) => ({ value: v.value, count: v.count }));

  return <ValueDropdown value={value} options={options} onValue={onValue} />;
}
