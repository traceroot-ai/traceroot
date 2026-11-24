"use client";

import * as React from "react";
import { Search, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { DisplayPrefs } from "./display";
import { DisplayMenu } from "./display-menu";
import { ExportMenu } from "./export-menu";
import { FilterMenu } from "./filter-menu";
import {
  addFilter,
  clearLabel,
  clearSearchAndFilters,
  describeFilter,
  sameFilter,
  type CaseAnalysis,
} from "./filters";
import type { CaseRow, CompareModel } from "./model";
import { SortSelect } from "./sort-select";

/**
 * Above the comparison table, one row under one rule: the search, the Filters menu, the
 * Sort control, the Display menu and `runs` (the Runs menu), left-aligned, with the Export
 * menu at its end. Active filters wrap onto a row of their own beneath it, each removable.
 */
export function CaseToolbar({
  projectId,
  model,
  searchRef,
  cases,
  casesAnalysis,
  exportOff,
  analysis,
  onChange,
  tagOf,
  disabled = false,
  filtersRef,
  display,
  onChangeDisplay,
  runs,
}: {
  projectId: string;
  model: CompareModel;
  /** The search box: the page sends focus here when the control that had it goes away. */
  searchRef: React.RefObject<HTMLInputElement | null>;
  /** The cases an export covers: the table's, in its order. */
  cases: readonly CaseRow[];
  /** The search, filters and sort that picked them, which trail `analysis` while the table
   *  catches up with typing, so an export's record of them matches its rows. */
  casesAnalysis: CaseAnalysis;
  /** Why there is no comparison to export, if there isn't one yet. */
  exportOff: string | null;
  analysis: CaseAnalysis;
  onChange: (next: CaseAnalysis) => void;
  tagOf: (runId: string) => string;
  /** Filters and Sort are off while there are no runs to read them from yet. */
  disabled?: boolean;
  /** The Filters button: a removed chip or Clear takes its focus with it, so it goes here. */
  filtersRef: React.RefObject<HTMLButtonElement | null>;
  /** The viewer's table layout. */
  display: DisplayPrefs;
  onChangeDisplay: (next: DisplayPrefs) => void;
  /** The Runs menu, after Display. */
  runs: React.ReactNode;
}) {
  const { filters } = analysis;
  const change = (next: CaseAnalysis) => {
    onChange(next);
    // Filters is disabled while runs load, and a disabled button can't take focus.
    const button = filtersRef.current;
    (button && !button.disabled ? button : searchRef.current)?.focus();
  };

  return (
    <div className="border-b border-border">
      <div data-toolbar="cases" className="flex min-h-11 flex-wrap items-center gap-3 px-4 py-1">
        <div className="relative min-w-[12rem] max-w-md flex-1">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={searchRef}
            value={analysis.q}
            onChange={(e) => onChange({ ...analysis, q: e.target.value })}
            placeholder="Search..."
            aria-label="Search cases"
            className="h-8 pl-8 text-[13px]"
          />
        </div>
        <FilterMenu
          triggerRef={filtersRef}
          model={model}
          tagOf={tagOf}
          disabled={disabled}
          onAdd={(filter) => onChange({ ...analysis, filters: addFilter(filters, filter) })}
        />
        <SortSelect
          model={model}
          sort={analysis.sort}
          tagOf={tagOf}
          disabled={disabled}
          onChange={(sort) => onChange({ ...analysis, sort })}
        />
        <DisplayMenu scorers={model.scorers} display={display} onChange={onChangeDisplay} />
        {runs}
        <div className="ml-auto">
          <ExportMenu
            projectId={projectId}
            model={model}
            cases={cases}
            analysis={casesAnalysis}
            off={exportOff}
          />
        </div>
      </div>
      {filters.length > 0 && (
        <div
          role="group"
          aria-label="Active filters"
          className="flex flex-wrap items-center gap-1.5 px-4 pb-1.5"
        >
          {filters.map((filter) => {
            const text = describeFilter(filter, tagOf);
            return (
              <Badge
                key={JSON.stringify(filter)}
                variant="foreground"
                className="h-6 gap-1 py-0 pr-0.5 font-normal"
              >
                {text}
                <button
                  type="button"
                  aria-label={`Remove filter: ${text}`}
                  onClick={() =>
                    change({ ...analysis, filters: filters.filter((f) => !sameFilter(f, filter)) })
                  }
                  className="rounded-[2px] p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
                >
                  <X className="h-3 w-3" aria-hidden />
                </button>
              </Badge>
            );
          })}
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[12px]"
            onClick={() => change(clearSearchAndFilters(analysis))}
          >
            {clearLabel(analysis)}
          </Button>
        </div>
      )}
    </div>
  );
}
