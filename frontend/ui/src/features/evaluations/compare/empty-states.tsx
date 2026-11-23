"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/features/offline-eval/components";

/** Some of the runs couldn't be read: go on without them (when any others loaded), or
 *  read them again. */
export function RunsNotLoaded({
  count,
  onRemove,
  onRetry,
}: {
  count: number;
  onRemove?: () => void;
  onRetry: () => void;
}) {
  return (
    <EmptyState>
      <p>{count === 1 ? "1 run couldn’t be loaded." : `${count} runs couldn’t be loaded.`}</p>
      <div className="mt-3 flex justify-center gap-2">
        {onRemove && (
          <Button variant="outline" size="sm" className="text-[12px]" onClick={onRemove}>
            Remove missing runs
          </Button>
        )}
        <Button variant="outline" size="sm" className="text-[12px]" onClick={onRetry}>
          Retry
        </Button>
      </div>
    </EmptyState>
  );
}

/** The runs have no case in common, so there is nothing to compare until they change:
 *  a run goes (from its menu in the Runs menu) or one that shares inputs comes in. */
export function NoSharedInputs({
  detail,
  canRemove,
  onAddRuns,
}: {
  /** Why, e.g. which datasets the runs are on. */
  detail: string;
  /** Whether a run can leave; a comparison keeps at least two. */
  canRemove: boolean;
  onAddRuns: () => void;
}) {
  return (
    <EmptyState>
      <p className="text-[13px] text-foreground">These runs have no matching inputs</p>
      <p className="mt-1">{detail}</p>
      <p className="mt-1">
        {canRemove
          ? "Remove a run from the Runs menu above, or add one that shares their inputs."
          : "Add a run that shares inputs with one of these, then remove the other from the Runs menu above."}
      </p>
      <Button variant="outline" size="sm" className="mt-3 text-[12px]" onClick={onAddRuns}>
        Add runs
      </Button>
    </EmptyState>
  );
}

/** The runs share cases, but the search and filters leave none of them. Clearing is the
 *  toolbar's own action, under its name (`clearLabel`). */
export function NoMatchingCases({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <EmptyState>
      <p className="text-[13px] text-foreground">No cases match the search or filters</p>
      <Button variant="outline" size="sm" className="mt-3 text-[12px]" onClick={onClear}>
        {label}
      </Button>
    </EmptyState>
  );
}
