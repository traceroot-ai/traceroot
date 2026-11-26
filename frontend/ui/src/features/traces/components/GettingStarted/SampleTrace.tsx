"use client";

import { useState } from "react";
import { hasMinRole, Role } from "@traceroot/core";
import { Button } from "@/components/ui/button";
import { useProject } from "@/features/projects/hooks";
import { useWorkspace } from "@/features/workspaces/hooks";
import { createSampleTrace } from "@/lib/api/traces";

/**
 * The way to look around before instrumenting anything: adds a made-up trace to the
 * project. Nothing here opens it — the page is already watching for a first trace,
 * and opens this one like any other. Viewers cannot write, so they are not offered it.
 */
export function SampleTrace({ projectId }: { projectId: string }) {
  const { data: project } = useProject(projectId);
  const { data: workspace } = useWorkspace(project?.workspace_id ?? "");
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

  if (!workspace || !hasMinRole(workspace.role, Role.MEMBER)) return null;

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
