"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { createSampleTrace } from "@/lib/api/traces";

/**
 * The way to look around before instrumenting anything: adds a made-up trace to the
 * project. Nothing here opens it — the page is already watching for a first trace,
 * and opens this one like any other.
 */
export function SampleTrace({ projectId }: { projectId: string }) {
  const [state, setState] = useState<
    { kind: "idle" | "creating" | "created" } | { kind: "failed"; message: string }
  >({ kind: "idle" });

  const create = async () => {
    setState({ kind: "creating" });
    try {
      await createSampleTrace(projectId);
      setState({ kind: "created" });
    } catch (err) {
      setState({
        kind: "failed",
        message: err instanceof Error ? err.message : "Failed to create the sample trace",
      });
    }
  };

  const busy = state.kind === "creating" || state.kind === "created";

  return (
    <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-[2px] border border-border px-3 py-2.5">
      <div>
        <p className="text-[13px] font-medium">Not ready to instrument yet?</p>
        <p className="mt-0.5 text-[12px] text-muted-foreground">
          Add a sample agent trace to explore the trace view. It needs no API key, counts toward
          usage like any trace, and replaces this setup page.
        </p>
        {state.kind === "failed" && (
          <p role="alert" className="mt-1 text-[12px] text-destructive">
            {state.message}
          </p>
        )}
      </div>
      <Button
        variant="outline"
        size="sm"
        className="h-7 text-[12px]"
        disabled={busy}
        onClick={create}
      >
        {busy ? "Creating sample trace..." : "Create sample trace"}
      </Button>
    </div>
  );
}
