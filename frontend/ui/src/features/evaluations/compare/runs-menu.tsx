"use client";

import * as React from "react";
import { Plus } from "lucide-react";
import { DOMAIN_ICONS } from "@/components/icons/domain-icons";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RunLegend } from "./run-legend";
import { RunPickerList } from "./run-picker";

// Each run compared is an evaluation run.
const RunsIcon = DOMAIN_ICONS.evaluation;

/** What the Runs menu shows: the runs compared, or the picker adding one. */
export type RunsMenuView = "runs" | "add";

/**
 * The toolbar's Runs menu. "Runs (N)" opens the runs compared, baseline first, each with
 * its own menu (`RunLegend`), then Add runs, which turns the same panel into the run
 * picker. The page can open it on the picker straight away (`open="add"`), as the empty
 * state of runs with nothing in common does. While the runs load there is nothing to
 * list, so the button stays in place, disabled.
 */
export function RunsMenu({
  count,
  open,
  onOpenChange,
  legend,
  picker,
}: {
  /** How many runs are compared. */
  count: number;
  open: RunsMenuView | null;
  onOpenChange: (open: RunsMenuView | null) => void;
  /** The runs, once loaded. */
  legend: Omit<React.ComponentProps<typeof RunLegend>, "trailing"> | null;
  /** The run picker, once the runs it suggests from are loaded. */
  picker: React.ComponentProps<typeof RunPickerList> | null;
}) {
  const adding = open === "add" && !!picker;
  return (
    <Popover open={open !== null && !!legend} onOpenChange={(o) => onOpenChange(o ? "runs" : null)}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-1 text-[12px]" disabled={!legend}>
          <RunsIcon className="h-3.5 w-3.5" aria-hidden />
          Runs ({count})
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label={adding ? "Add runs" : "Runs"}
        className={adding ? "w-[360px] p-0" : "w-[300px] p-1 text-[12px]"}
      >
        {adding ? (
          <RunPickerList {...picker} />
        ) : (
          legend && (
            <RunLegend
              {...legend}
              trailing={
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 justify-start gap-1 px-2 text-[12px]"
                  onClick={() => onOpenChange("add")}
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden />
                  Add runs
                </Button>
              }
            />
          )
        )}
      </PopoverContent>
    </Popover>
  );
}
