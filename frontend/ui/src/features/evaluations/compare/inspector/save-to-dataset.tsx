"use client";

import * as React from "react";
import { ChevronDown, Database } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ACTION_META,
  SaveResultToDatasetDrawer,
  type ResultDatasetAction,
} from "../../components/save-result-to-dataset-drawer";
import type { ResultRow, RunDetail } from "../../types";

// The drawer's three actions, each with the hint the menu adds under its title.
const ACTIONS: readonly { action: ResultDatasetAction; hint: string }[] = [
  {
    action: "update_existing_case",
    hint: "Publish a new version of this case",
  },
  // Its own dataset already holds the case, which refuses a copy of it as a new case.
  {
    action: "save_new_case",
    hint: "Add it to another dataset as a new case",
  },
  {
    action: "duplicate_as_variant",
    hint: "Branch this case without touching the original",
  },
];

/** A save under way: the action picked, with the result and run it was picked on. */
export interface DatasetSave {
  action: ResultDatasetAction;
  result: ResultRow;
  run: RunDetail;
}

/**
 * Keep what the trace panel shows: "Save to dataset" on the case's root, a menu of the ways
 * to save the candidate's result for the case (update its source case, or add it as a new
 * case or a variant). Picking one hands it to the trace panel, which opens the save drawer.
 */
export const SaveToDatasetMenu = React.forwardRef<
  HTMLButtonElement,
  {
    /** "#2", as the trace panel names the candidate run. */
    tag: string;
    onPick: (action: ResultDatasetAction) => void;
  }
>(function SaveToDatasetMenu({ tag, onPick }, ref) {
  // Picking an action hands focus to the drawer it opens, not back to the menu's button.
  const picked = React.useRef(false);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button ref={ref} variant="outline" className="h-7 shrink-0 gap-1 text-[12px]">
          <Database className="h-3.5 w-3.5" aria-hidden />
          Save to dataset
          <ChevronDown className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-64"
        onCloseAutoFocus={(e) => {
          if (!picked.current) return;
          picked.current = false;
          e.preventDefault();
        }}
      >
        <DropdownMenuLabel>{`Candidate · ${tag}`}</DropdownMenuLabel>
        {ACTIONS.map(({ action, hint }) => (
          <DropdownMenuItem
            key={action}
            className="h-auto flex-col items-start gap-0 py-1.5"
            onSelect={() => {
              picked.current = true;
              onPick(action);
            }}
          >
            <span className="text-[12px] font-medium">{ACTION_META[action].title}</span>
            <span className="text-[12px] text-muted-foreground">{hint}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

/**
 * The evaluations' save drawer for a save under way, starting from the candidate run's
 * dataset (a new case starts with none picked). It stays on the result it was opened for
 * while the trace panel moves to another case or pair, so what was typed into it isn't lost.
 * Closing it puts focus back on the menu's button, or on `fallback` when the case shown now
 * has none.
 */
export function SaveToDatasetDrawer({
  projectId,
  save,
  onClose,
  trigger,
  fallback,
}: {
  projectId: string;
  save: DatasetSave;
  onClose: () => void;
  trigger: React.RefObject<HTMLButtonElement | null>;
  fallback: React.RefObject<HTMLElement | null>;
}) {
  return (
    <SaveResultToDatasetDrawer
      projectId={projectId}
      open
      onOpenChange={(open) => !open && onClose()}
      action={save.action}
      result={save.result}
      sourceDatasetId={save.run.datasetId}
      sourceDatasetName={save.run.datasetName ?? "this run's dataset"}
      // Neither is there when the trace panel closed along with it.
      onCloseAutoFocus={(e) => {
        const back = trigger.current?.isConnected ? trigger.current : fallback.current;
        if (!back?.isConnected) return;
        e.preventDefault();
        back.focus();
      }}
    />
  );
}
