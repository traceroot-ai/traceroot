"use client";

import * as React from "react";
import { SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  columnChoices,
  isShown,
  toggleColumn,
  type Density,
  type DiffReference,
  type DisplayPrefs,
  type TextMode,
} from "./display";

const DENSITIES: readonly [Density, string][] = [
  ["compact", "Compact"],
  ["comfortable", "Comfortable"],
];
const TEXT_MODES: readonly [TextMode, string][] = [
  ["clip", "Clip"],
  ["wrap", "Wrap"],
];
const DIFF_REFERENCES: readonly [DiffReference, string][] = [
  ["baseline", "Baseline"],
  ["expected", "Expected"],
  ["off", "Off"],
];

/** One setting's choices, side by side; the one in use is pressed. Toggle buttons, as in
 *  the trace viewer's diff boxes, not radios: each is its own tab stop, so no arrow keys
 *  are promised. */
function Choice<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly [T, string][];
  value: T;
  onChange: (next: T) => void;
}) {
  const id = React.useId();
  return (
    <>
      <span id={id} className="text-muted-foreground">
        {label}
      </span>
      <div role="group" aria-labelledby={id} className="btn-group justify-self-start">
        {options.map(([option, text]) => (
          <button
            key={option}
            type="button"
            aria-pressed={value === option}
            onClick={() => onChange(option)}
            className={cn(
              "h-6 px-2 text-[12px] transition-colors",
              value === option
                ? "!bg-accent text-foreground"
                : "text-muted-foreground hover:!bg-muted hover:text-foreground",
            )}
          >
            {text}
          </button>
        ))}
      </div>
    </>
  );
}

const COLUMN_ROW = "flex h-7 items-center gap-2 rounded-[2px] px-2";

// The columns that name a case and its lines, always shown.
const ALWAYS_SHOWN = ["Input", "Run"] as const;

/** Which columns show. Input and Run always do, so their boxes are checked and can't be
 *  cleared. */
function ColumnList({
  scorers,
  display,
  onChange,
}: {
  scorers: readonly { name: string }[];
  display: DisplayPrefs;
  onChange: (next: DisplayPrefs) => void;
}) {
  const id = React.useId();
  return (
    <div className="border-t border-border p-1">
      <p id={`${id}-title`} className="px-2 pb-0.5 pt-1 text-muted-foreground">
        Columns
      </p>
      <div role="group" aria-labelledby={`${id}-title`} className="max-h-[280px] overflow-y-auto">
        {ALWAYS_SHOWN.map((name) => (
          <label key={name} className={cn(COLUMN_ROW, "cursor-not-allowed")}>
            <Checkbox checked disabled aria-label={name} aria-describedby={`${id}-${name}`} />
            <span className="flex-1">{name}</span>
            <span id={`${id}-${name}`} className="text-muted-foreground">
              Always shown
            </span>
          </label>
        ))}
        {columnChoices(scorers).map((column) => (
          <label key={column.id} className={cn(COLUMN_ROW, "cursor-pointer hover:bg-muted")}>
            <Checkbox
              checked={isShown(display, column.id)}
              onCheckedChange={() => onChange(toggleColumn(display, column.id))}
            />
            <span className="min-w-0 truncate" title={column.label}>
              {column.label}
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

/**
 * The toolbar's Display menu: how the table is laid out for this viewer. Density spaces
 * the lines out; Text wraps long inputs and outputs in full instead of clipping them to one
 * line; Diff against marks the words of each candidate's output that differ from the
 * baseline's output or the expected one, or marks none; Columns hides the ones the viewer
 * doesn't need. A hidden metric's filters and sort still apply.
 */
export function DisplayMenu({
  scorers,
  display,
  onChange,
}: {
  /** The comparison's metrics, each a column that can be hidden. */
  scorers: readonly { name: string }[];
  display: DisplayPrefs;
  onChange: (next: DisplayPrefs) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-1 text-[12px]">
          <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden />
          Display
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" aria-label="Display" className="w-[280px] p-0 text-[12px]">
        <div className="grid grid-cols-[5rem_1fr] items-center gap-2 p-2">
          <Choice
            label="Density"
            options={DENSITIES}
            value={display.density}
            onChange={(density) => onChange({ ...display, density })}
          />
          <Choice
            label="Text"
            options={TEXT_MODES}
            value={display.text}
            onChange={(text) => onChange({ ...display, text })}
          />
          <Choice
            label="Diff against"
            options={DIFF_REFERENCES}
            value={display.diff}
            onChange={(diff) => onChange({ ...display, diff })}
          />
        </div>
        <ColumnList scorers={scorers} display={display} onChange={onChange} />
      </PopoverContent>
    </Popover>
  );
}
