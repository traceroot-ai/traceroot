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
  available,
  showState = true,
}: {
  projectId: string;
  signalId: string;
  /** The current opening's analysis state; null when none was asked for. */
  state: string | null;
  /** False when the deployment runs no signal RCA (it has no OpenAI API key). */
  available: boolean;
  /** False when the caller already says whether it failed or is running. */
  showState?: boolean;
}) {
  const request = useRequestSignalRca(projectId, signalId);
  if (!available) {
    return (
      <p className="text-[12px] text-muted-foreground">
        No root cause analysis: this deployment has no OpenAI API key, which signals need.
      </p>
    );
  }
  const running = rcaInProgress(state) || request.isPending;
  return (
    <div className="space-y-3" aria-live="polite">
      {request.isError && (
        <p role="alert" className="text-[12px] text-destructive">
          Analysis could not start. Please try again.
        </p>
      )}
      {showState &&
        (running ? (
          <p className="text-[12px] text-muted-foreground">Analyzing affected traces…</p>
        ) : (
          state === "failed" && (
            <p className="text-[12px] text-muted-foreground">The last analysis failed.</p>
          )
        ))}
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
