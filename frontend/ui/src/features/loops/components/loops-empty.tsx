"use client";

import Link from "next/link";
import { Plus } from "lucide-react";
import { Step } from "@/features/alerts/components/step";

/** The splash a project sees on /loops before it has any Loop. */
export function LoopsEmpty({ projectId }: { projectId: string }) {
  return (
    <div className="mx-auto w-full max-w-lg px-4 pt-12">
      <div className="text-center">
        <h1 className="text-[15px] font-medium">Get started with Loops</h1>
        <p className="mx-auto mt-2 max-w-md text-[13px] text-muted-foreground">
          A Loop is an agent that runs on a schedule, reads many of your traces and records the
          recurring problems it finds as signals.
        </p>
      </div>

      <div className="mt-8">
        <Step
          index={1}
          title="Choose what to look for"
          description="Start from a template, or write your own instructions."
        />
        <Step
          index={2}
          title="Choose when it runs"
          description="Every few hours, daily or weekly. A run is skipped when nothing new came in."
        />
        <Step
          index={3}
          isLast
          title="Create a Loop"
          description="Its findings show up under Signals, with the Loop that found them."
        >
          <Link
            href={`/projects/${projectId}/loops/new`}
            className="inline-flex h-7 items-center gap-1 rounded-md bg-primary px-3 text-[12px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            New Loop
          </Link>
        </Step>
      </div>
    </div>
  );
}
