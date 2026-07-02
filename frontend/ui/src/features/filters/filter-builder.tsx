"use client";

/**
 * The filter builder (the search-bar popup's content): one row —
 * [ field ▾ ] [ operator ▾ ] [ value ] [ Add filter ].
 *
 * Friendly operators lower to the backend `in`/`between` predicates: numeric
 * equals/greater-than/less-than all emit a `between` predicate with the right (possibly
 * null) bounds, and categorical `is` emits a one-element `in`. "Add filter" emits one
 * predicate (the parent appends it as a chip) and resets the row so another can be added.
 */
import { useState } from "react";
import {
  AlertCircle,
  Box,
  ChevronDown,
  CircleDollarSign,
  CircleStop,
  Clock,
  Globe,
  type LucideIcon,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { Predicate } from "@/types/api";
import { useFilterValues } from "./hooks";
import type { FilterFieldDef } from "./registry";
import { buildBetweenPredicate, buildInPredicate } from "./predicate-ui";

// Icons mirror the trace detail / list UI for consistency; the model and environment
// fields, which have no trace-detail icon, use a generic one.
const FIELD_ICONS: Record<string, LucideIcon> = {
  cost: CircleDollarSign,
  total_tokens: CircleStop,
  duration_ms: Clock,
  errors: AlertCircle,
  model_name: Box,
  environment: Globe,
};

// Unit shown inside the value input so it's clear what a numeric filter is measured in.
// Only the short units ($ and ms) are shown; a "tokens" suffix is long enough to crowd
// out the "Enter value" placeholder, and the Tokens field name already makes it clear.
const FIELD_UNIT: Record<string, { prefix?: string; suffix?: string }> = {
  cost: { prefix: "$" },
  duration_ms: { suffix: "ms" },
};

type UiOp = "is" | "equals" | "gt" | "lt";
const OP_LABEL: Record<UiOp, string> = {
  is: "is",
  equals: "equals",
  // "greater than" is an INCLUSIVE >= bound (lowered to >= in translate.py); "less
  // than" is a strict < bound. Labels are kept short; the semantics live in the comment.
  gt: "greater than",
  lt: "less than",
};
// "between" is intentionally not offered in the UI — a range is two filters
// ("greater than X" and "less than Y"). The backend still supports a two-bound
// predicate (and `equals` uses it as `[x, x]`).
const opsFor = (f: FilterFieldDef): UiOp[] =>
  f.type === "categorical" ? ["is"] : ["equals", "gt", "lt"];

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
    if (op === "is") return value === "" ? null : buildInPredicate(field.field, [value]);
    const lo = num(value);
    // Reject NaN/Infinity, and a fractional value on an integer field (e.g. "1e-1"
    // slips past the input's decimal-point guard but can't bind as Int64).
    if (lo === null || !Number.isFinite(lo)) return null;
    if (field.integer && !Number.isInteger(lo)) return null;
    if (op === "equals") return buildBetweenPredicate(field.field, lo, lo);
    if (op === "gt") return buildBetweenPredicate(field.field, lo, null);
    return buildBetweenPredicate(field.field, null, lo); // lt
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
    <div className="flex items-center gap-1.5 p-2">
      <FieldDropdown fields={fields} value={field} onPick={pickField} />
      <Dropdown
        disabled={!field}
        trigger={<span className="truncate">{field ? OP_LABEL[op] : "is"}</span>}
        triggerClassName="w-[7.5rem] shrink-0"
        contentClassName="w-[10rem]"
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
        className="h-8 shrink-0 rounded-md px-3 text-[13px]"
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
    return (
      <Input
        disabled
        readOnly
        value=""
        placeholder="Enter value"
        className="h-8 min-w-0 flex-1 rounded-md text-[13px]"
      />
    );
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

function NumberField({
  ariaLabel,
  placeholder,
  value,
  onChange,
  onEnter,
  unit,
  integer = false,
}: {
  ariaLabel: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  onEnter: () => void;
  unit?: { prefix?: string; suffix?: string };
  // Integer-typed fields (tokens/latency/errors) can't bind a fractional value in
  // ClickHouse, so restrict the input to whole numbers.
  integer?: boolean;
}) {
  return (
    <div className="flex h-8 min-w-0 flex-1 items-center gap-1 rounded-md border border-input bg-transparent px-2.5 text-[13px] focus-within:ring-1 focus-within:ring-ring">
      {unit?.prefix && <span className="shrink-0 text-muted-foreground">{unit.prefix}</span>}
      <input
        type="number"
        min={0}
        step={integer ? 1 : "any"}
        aria-label={ariaLabel}
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          // The filterable metrics are all non-negative — reject negative input; and for
          // integer fields, reject a fractional value (it can't bind as Int64/UInt64).
          const v = e.target.value;
          if (v.startsWith("-") || Number(v) < 0) return;
          if (integer && v.includes(".")) return;
          onChange(v);
        }}
        onKeyDown={(e) => {
          // Block a minus sign always, and a decimal point on integer fields.
          if (e.key === "-" || (integer && e.key === ".")) e.preventDefault();
          else if (e.key === "Enter") onEnter();
        }}
        className="min-w-0 flex-1 bg-transparent text-[13px] outline-none [appearance:textfield] placeholder:text-muted-foreground [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      {unit?.suffix && <span className="shrink-0 text-muted-foreground">{unit.suffix}</span>}
    </div>
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

  return (
    <Dropdown
      trigger={
        <span className={cn("truncate", !value && "text-muted-foreground")}>
          {value || "Enter value"}
        </span>
      }
      triggerClassName="min-w-0 flex-1"
      contentClassName="w-[12rem]"
    >
      {(close) =>
        options.length === 0 ? (
          <div className="px-2 py-1.5 text-[13px] text-muted-foreground">No options</div>
        ) : (
          options.map((opt) => (
            <DropdownItem
              key={opt.value}
              active={opt.value === value}
              onClick={() => {
                onValue(opt.value);
                close();
              }}
            >
              <span className="flex-1 truncate">{opt.value}</span>
              {opt.count !== undefined && (
                <span className="text-[11px] text-muted-foreground">{opt.count}</span>
              )}
            </DropdownItem>
          ))
        )
      }
    </Dropdown>
  );
}

function FieldDropdown({
  fields,
  value,
  onPick,
}: {
  fields: FilterFieldDef[];
  value: FilterFieldDef | null;
  onPick: (f: FilterFieldDef) => void;
}) {
  const Icon = value ? (FIELD_ICONS[value.field] ?? Box) : null;
  return (
    <Dropdown
      trigger={
        <span className="flex min-w-0 items-center gap-1.5">
          {Icon && <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
          <span className="truncate">{value ? value.label : "Field"}</span>
        </span>
      }
      triggerClassName="w-[8.5rem] shrink-0"
      contentClassName="w-[13rem]"
    >
      {(close) =>
        fields.map((f) => {
          const FIcon = FIELD_ICONS[f.field] ?? Box;
          return (
            <DropdownItem
              key={f.field}
              active={f.field === value?.field}
              onClick={() => {
                onPick(f);
                close();
              }}
            >
              <FIcon className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="flex-1 truncate">{f.label}</span>
            </DropdownItem>
          );
        })
      }
    </Dropdown>
  );
}

function Dropdown({
  trigger,
  children,
  triggerClassName,
  contentClassName,
  disabled,
}: {
  trigger: React.ReactNode;
  children: (close: () => void) => React.ReactNode;
  triggerClassName?: string;
  contentClassName?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            "flex h-8 items-center justify-between gap-1.5 rounded-md border border-border bg-background px-2.5 text-[13px] font-normal transition-colors",
            "hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-50",
            triggerClassName,
          )}
        >
          {trigger}
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className={cn("max-h-64 overflow-y-auto p-1", contentClassName)}
      >
        {children(() => setOpen(false))}
      </PopoverContent>
    </Popover>
  );
}

function DropdownItem({
  active,
  onClick,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-muted/50",
        active && "bg-muted/40",
      )}
    >
      {children}
    </button>
  );
}
