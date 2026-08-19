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
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { DOMAIN_ICONS } from "@/components/icons/domain-icons";
import { useMetadataKeys } from "./hooks";
import { MAX_KEY_LENGTH, MAX_VALUE_LENGTH } from "./predicate";

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
  metadata: DOMAIN_ICONS.metadata,
};

// Text sizing depends on where the filter lives: the trace-list search bar uses
// the app's 13px control size, the widget builder's config column runs at 12px.
// A context (set once by the host via FilterControlsSize) keeps the size out of
// every control and dropdown-item callsite.
export type FilterControlSize = "sm" | "md";
const TEXT_SIZE: Record<FilterControlSize, string> = { sm: "text-[12px]", md: "text-[13px]" };
const SizeContext = createContext<FilterControlSize>("md");
const useTextSize = () => TEXT_SIZE[useContext(SizeContext)];

// The dropped-down list panel and its empty line, shared by every control here so the
// field / value dropdowns and the metadata key combobox drop the same surface. Callers
// add only what differs (a width, the size-dependent text class).
const DROPDOWN_CONTENT_CLASS = "max-h-64 overflow-y-auto p-1";
const NO_OPTIONS_CLASS = "px-2 py-1.5 text-muted-foreground";

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
      // Clamps a typed or pasted value at the backend's cap, so the common path never builds
      // a predicate the list would 422. It is the affordance, not the guard: a programmatic
      // set or a hand-edited `?filters=` bypasses it, which is what isValidPredicate covers.
      maxLength={MAX_VALUE_LENGTH}
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
          <div className={cn(NO_OPTIONS_CLASS, textSize)}>No options</div>
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

/**
 * The metadata key control: a combobox that SUGGESTS the keys discovered in the active
 * window and ACCEPTS ANY KEY TYPED. The two are different things — the suggestion list
 * exists to save typing, never to restrict it, so there is no "custom key" mode, no
 * validation that rejects an unsuggested key, and nothing here can disable "Add filter".
 *
 * The text box IS the key: typing edits the predicate's key directly and doubles as the
 * suggestion search, so a key typed and never confirmed against the list is still the key
 * that gets filtered on. A separate search box would silently discard it.
 *
 * Suggestions come from the active window only, exactly like the Model and Environment
 * value dropdowns, so that picking one can never return zero rows for the sole reason
 * that it was observed outside the range the user is looking at.
 */
export function MetadataKeyCombobox({
  projectId,
  startAfter,
  endBefore,
  value,
  onValue,
  onEnter,
}: {
  projectId: string;
  startAfter?: string;
  endBefore?: string;
  value: string;
  onValue: (v: string) => void;
  // Optional: the trace-list builder submits its row on Enter; a row that applies
  // as it is edited has nothing to submit and passes none.
  onEnter?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const textSize = useTextSize();
  const { keys } = useMetadataKeys(projectId, startAfter, endBefore, true);

  const query = value.trim().toLowerCase();
  // A key already chosen is not a search term: reopening the list after picking
  // `session_id` should still offer the other keys rather than narrowing to the one that
  // is already in the box. `keys` arrives frequency-ordered from discovery and filtering
  // preserves that order, so there is no second ranking model here.
  const isExactKey = keys.some((k) => k.value.toLowerCase() === query);
  const suggestions =
    query === "" || isExactKey ? keys : keys.filter((k) => k.value.toLowerCase().includes(query));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div className="flex h-7 min-w-0 flex-1 items-center rounded-md border border-input bg-transparent px-2 focus-within:ring-1 focus-within:ring-ring">
          <input
            aria-label="metadata key"
            placeholder="Key"
            maxLength={MAX_KEY_LENGTH}
            value={value}
            onChange={(e) => {
              onValue(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onClick={() => setOpen(true)}
            onKeyDown={(e) => {
              // Enter dismisses the suggestion list and applies the filter if the row is
              // complete; the typed key needs no confirmation, it is already the key.
              if (e.key === "Enter") {
                setOpen(false);
                onEnter?.();
              }
            }}
            className={cn(
              "min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground",
              textSize,
            )}
          />
        </div>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        className={cn(DROPDOWN_CONTENT_CLASS, "w-[14rem]")}
        // Focus stays in the box while the list is open, and is not pulled back on close —
        // otherwise returning focus would refire onFocus and reopen the list immediately.
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        {suggestions.length > 0 ? (
          suggestions.map((k) => (
            <DropdownItem
              key={k.value}
              active={k.value === value}
              onClick={() => {
                onValue(k.value);
                setOpen(false);
              }}
            >
              <span className="flex-1 truncate">{k.value}</span>
              <span className="text-[11px] text-muted-foreground">{k.count}</span>
            </DropdownItem>
          ))
        ) : (
          // Same empty state the categorical value dropdown has always shown, deliberately:
          // a key list that is still loading and one that came back empty look alike there
          // too, and the metadata control should not read as a louder or more alarming
          // surface than the filter beside it. An empty list blocks nothing — suggestions
          // only save typing, and any key typed still filters.
          <div className={cn(NO_OPTIONS_CLASS, textSize)}>No options</div>
        )}
      </PopoverContent>
    </Popover>
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
      <PopoverContent align="start" className={cn(DROPDOWN_CONTENT_CLASS, contentClassName)}>
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
