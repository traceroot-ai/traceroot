"use client";

/**
 * The shared filter controls: the field / operator / value pieces of a filter
 * row. The trace-list filter builder is the source of truth for how these look
 * and validate; the dashboard widget builder renders the same controls so the
 * two filter UIs stay identical.
 */
import { createContext, useContext, useState } from "react";
import { ChevronDown, type LucideIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { DOMAIN_ICONS } from "@/components/icons/domain-icons";

// Icons mirror the trace detail / list UI for consistency; the model and environment
// fields, which have no trace-detail icon, use a generic one. The dashboard widget
// builder extends this map with its registry's extra field names.
export const FIELD_ICONS: Record<string, LucideIcon> = {
  trace_id: DOMAIN_ICONS.id,
  cost: DOMAIN_ICONS.cost,
  total_tokens: DOMAIN_ICONS.tokens,
  duration_ms: DOMAIN_ICONS.latency,
  errors: DOMAIN_ICONS.error,
  model_name: DOMAIN_ICONS.model,
  environment: DOMAIN_ICONS.environment,
};

// Text sizing depends on where the filter lives: the trace-list search bar uses
// the app's 13px control size, the widget builder's config column runs at 12px.
// A context (set once by the host via FilterControlsSize) keeps the size out of
// every control and dropdown-item callsite.
export type FilterControlSize = "sm" | "md";
const TEXT_SIZE: Record<FilterControlSize, string> = { sm: "text-[12px]", md: "text-[13px]" };
const SizeContext = createContext<FilterControlSize>("md");
const useTextSize = () => TEXT_SIZE[useContext(SizeContext)];

export function FilterControlSizeProvider({
  size,
  children,
}: {
  size: FilterControlSize;
  children: React.ReactNode;
}) {
  return <SizeContext.Provider value={size}>{children}</SizeContext.Provider>;
}

/** The disabled value input a filter row parks in until a field is picked. */
export function ParkedValueField() {
  return (
    <Input
      disabled
      readOnly
      value=""
      placeholder="Enter value"
      className={cn("h-7 min-w-0 flex-1 rounded-md", useTextSize())}
    />
  );
}

export interface FieldUnit {
  prefix?: string;
  suffix?: string;
}

// Unit shown inside a numeric value input — and by every widget renderer
// (stat tile, chart tooltips and axes, table cells) — so it's clear what the
// number is measured in. Only the short units ($ and ms) are
// shown; a "tokens" suffix is long enough to crowd out the "Enter value"
// placeholder, and the Tokens field name already makes it clear. Moving these
// into the backend registry's schema is a tracked follow-up; until then this
// map is the frontend's single copy.
export const FIELD_UNIT: Record<string, FieldUnit> = {
  cost: { prefix: "$" },
  duration_ms: { suffix: "ms" },
};

export function TextField({
  ariaLabel,
  placeholder,
  value,
  onChange,
  onEnter,
}: {
  ariaLabel: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  onEnter?: () => void;
}) {
  const textSize = useTextSize();
  return (
    <Input
      aria-label={ariaLabel}
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onEnter?.();
      }}
      className={cn("h-7 min-w-0 flex-1 rounded-md", textSize)}
    />
  );
}

export function NumberField({
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
  onEnter?: () => void;
  unit?: FieldUnit;
  // Integer-typed fields (tokens/latency/errors) can't bind a fractional value in
  // ClickHouse, so restrict the input to whole numbers.
  integer?: boolean;
}) {
  const textSize = useTextSize();
  return (
    <div
      className={cn(
        "flex h-7 min-w-0 flex-1 items-center gap-1 rounded-md border border-input bg-transparent px-2 focus-within:ring-1 focus-within:ring-ring",
        textSize,
      )}
    >
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
          else if (e.key === "Enter") onEnter?.();
        }}
        className={cn(
          "min-w-0 flex-1 bg-transparent outline-none [appearance:textfield] placeholder:text-muted-foreground [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none",
          textSize,
        )}
      />
      {unit?.suffix && <span className="shrink-0 text-muted-foreground">{unit.suffix}</span>}
    </div>
  );
}

/**
 * The stored-values picker: a dropdown of a field's values with per-value
 * occurrence counts on the right.
 */
export function ValueDropdown({
  value,
  options,
  onValue,
  placeholder = "Enter value",
  triggerClassName,
}: {
  value: string;
  options: { value: string; count?: number }[];
  onValue: (v: string) => void;
  placeholder?: string;
  triggerClassName?: string;
}) {
  const textSize = useTextSize();
  return (
    <Dropdown
      trigger={
        <span className={cn("truncate", !value && "text-muted-foreground")}>
          {value || placeholder}
        </span>
      }
      triggerClassName={cn("min-w-0 flex-1", triggerClassName)}
      contentClassName="w-[12rem]"
    >
      {(close) =>
        options.length === 0 ? (
          <div className={cn("px-2 py-1.5 text-muted-foreground", textSize)}>No options</div>
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

export interface FieldOption {
  key: string;
  label: string;
  icon?: LucideIcon;
}

export function FieldDropdown({
  options,
  valueKey,
  onPick,
}: {
  options: FieldOption[];
  valueKey: string | null;
  onPick: (key: string) => void;
}) {
  const selected = valueKey ? (options.find((o) => o.key === valueKey) ?? null) : null;
  const Icon = selected ? (selected.icon ?? DOMAIN_ICONS.fallback) : null;
  return (
    <Dropdown
      trigger={
        <span className="flex min-w-0 items-center gap-1.5">
          {Icon && <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
          <span className="truncate">{selected ? selected.label : "Field"}</span>
        </span>
      }
      triggerClassName="w-[8.5rem] shrink-0"
      contentClassName="w-[13rem]"
    >
      {(close) =>
        options.map((o) => {
          const OIcon = o.icon ?? DOMAIN_ICONS.fallback;
          return (
            <DropdownItem
              key={o.key}
              active={o.key === valueKey}
              onClick={() => {
                onPick(o.key);
                close();
              }}
            >
              <OIcon className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="flex-1 truncate">{o.label}</span>
            </DropdownItem>
          );
        })
      }
    </Dropdown>
  );
}

export function Dropdown({
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
  const textSize = useTextSize();
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            "flex h-7 items-center justify-between gap-1 rounded-md border border-border bg-background px-2 font-normal transition-colors",
            "hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-50",
            textSize,
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

export function DropdownItem({
  active,
  onClick,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const textSize = useTextSize();
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded px-2 py-1 text-left transition-colors hover:bg-muted/50",
        textSize,
        active && "bg-muted/40",
      )}
    >
      {children}
    </button>
  );
}
