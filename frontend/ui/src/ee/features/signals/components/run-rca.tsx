"use client";

import { Button } from "@/components/ui/button";
import { rcaInProgress, useRequestSignalRca } from "../hooks";

/**
 * A signal without an analysis: run it by hand (its detector's RCA is Manual,
 * or the last attempt failed), or see that it is running.
 */
export function RunRca({
  projectId,
  signalId,
  state,
}: {
  projectId: string;
  signalId: string;
  /** The current opening's analysis state; null when none was asked for. */
  state: string | null;
}) {
  const request = useRequestSignalRca(projectId, signalId);
  const running = rcaInProgress(state) || request.isPending;
  return (
    <div className="space-y-3" aria-live="polite">
      {request.isError && (
        <p role="alert" className="text-[12px] text-destructive">
          Analysis could not start. Please try again.
        </p>
      )}
      {running ? (
        <p className="text-[12px] text-muted-foreground">Analyzing affected traces…</p>
      ) : (
        state === "failed" && (
          <p className="text-[12px] text-muted-foreground">The last analysis failed.</p>
        )
      )}
      <Button
        size="sm"
        className="h-7 text-[12px]"
        disabled={running}
        onClick={() => request.mutate()}
      >
        {running ? "Running…" : "Run root cause analysis"}
      </Button>
    </div>
  );
}
