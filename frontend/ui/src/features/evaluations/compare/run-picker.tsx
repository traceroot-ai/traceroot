"use client";

import * as React from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useKeywordSearch } from "@/lib/hooks/use-keyword-search";
import { useEvaluationRuns } from "../hooks";
import { EVAL_RUN_STATUS_LABEL, type RunRow } from "../types";
import { previousRun } from "./run-order";

// How many of the project's runs the list shows at once; search narrows it.
const LIST_LIMIT = 20;

type Anchor = Pick<RunRow, "id" | "runNumber" | "startedAt" | "datasetId">;

interface RunPickerProps {
  projectId: string;
  /** Runs already compared; never offered. */
  selectedIds: readonly string[];
  /** The suggestion is the newest run on this run's dataset that started before it. */
  anchor: Anchor;
  /** Runs on any other dataset line up by input, and say so. */
  datasetId: string;
  onPick: (run: RunRow) => void;
  /** Names the picker for assistive tech, e.g. "Add runs". */
  label: string;
  /** The button that opens the picker. */
  children: React.ReactNode;
  /** Open state, for opening the picker from elsewhere on the page; uncontrolled if unset. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/** A searchable list of the project's runs to compare with, led by the previous run on the
 *  same dataset. */
export function RunPicker({ label, children, open, onOpenChange, ...props }: RunPickerProps) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="end" aria-label={label} className="w-[360px] p-0">
        {/* Mounted only while open, so the runs are fetched only when asked for. */}
        <RunPickerList {...props} />
      </PopoverContent>
    </Popover>
  );
}

/** The picker's search and list, for a panel of its own (`RunPicker`) or one it shares
 *  (the comparison's Runs menu). Its search takes focus when it mounts. */
export function RunPickerList({
  projectId,
  selectedIds,
  anchor,
  datasetId,
  onPick,
}: Omit<RunPickerProps, "label" | "children" | "open" | "onOpenChange">) {
  const { keyword, setKeyword, searchQuery } = useKeywordSearch();
  const searchRef = React.useRef<HTMLInputElement>(null);
  // Opened in a panel that was showing something else, focus would stay on what left.
  React.useEffect(() => searchRef.current?.focus(), []);
  const selected = new Set(selectedIds);
  // The window before the anchor holds at most the other selected runs and the anchor
  // itself, so one more is enough to find a run that isn't selected.
  const before = useEvaluationRuns(projectId, {
    dataset_id: anchor.datasetId,
    started_before: anchor.startedAt,
    limit: selectedIds.length + 1,
  });
  const found = useEvaluationRuns(projectId, { search_query: searchQuery, limit: LIST_LIMIT });

  // The suggestion leads the list, so the list waits for it rather than shift under the
  // pointer when it arrives; a previous selection's window (placeholder data) can't give it.
  const loading = before.isLoading || before.isPlaceholderData || found.isLoading;
  const suggested = searchQuery ? null : previousRun(before.data?.data ?? [], anchor, selected);
  const others = (found.data?.data ?? []).filter(
    (r) => !selected.has(r.id) && r.id !== suggested?.id,
  );

  const option = (run: RunRow) => (
    <button
      key={run.id}
      type="button"
      onClick={() => {
        onPick(run);
        // A picked run leaves the list; keep focus in the picker, not on the page.
        searchRef.current?.focus();
      }}
      className="flex w-full items-center gap-2 rounded-[2px] px-2 py-1.5 text-left text-[12px] hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
    >
      {/* The run's name and the alignment note stay whole; its status and evaluation
          shorten first, and say in full on hover. */}
      <span className="max-w-full shrink-0 truncate">{`#${run.runNumber} ${run.candidateVersion}`}</span>
      {run.status !== "completed" && (
        <span
          title={EVAL_RUN_STATUS_LABEL[run.status]}
          className="min-w-0 truncate text-muted-foreground"
        >
          {EVAL_RUN_STATUS_LABEL[run.status]}
        </span>
      )}
      <span className="ml-auto flex min-w-0 items-center gap-1 text-muted-foreground">
        <span title={run.evaluationName} className="min-w-0 truncate">
          {run.evaluationName}
        </span>
        {run.datasetId !== datasetId && <span className="shrink-0">· aligned by input</span>}
      </span>
    </button>
  );

  return (
    <div className="flex flex-col text-[12px]">
      <div className="relative border-b border-border p-2">
        <Search className="absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={searchRef}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="Search runs..."
          aria-label="Search runs"
          className="h-8 pl-8 text-[13px]"
        />
      </div>
      <div className="max-h-[320px] overflow-y-auto p-1">
        {!loading && suggested && (
          <>
            <p className="px-2 pb-0.5 pt-1 text-muted-foreground">Suggested · previous run</p>
            {option(suggested)}
            {others.length > 0 && <div className="-mx-1 my-1 h-px bg-border" />}
          </>
        )}
        {!loading && others.map(option)}
        {(loading || (!suggested && others.length === 0)) && (
          <p className="px-2 py-1.5 text-muted-foreground">
            {loading
              ? "Loading runs…"
              : searchQuery
                ? "No runs match your search."
                : "No other runs to compare."}
          </p>
        )}
      </div>
    </div>
  );
}
