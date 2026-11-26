"use client";

import { useState } from "react";
import { FirstTraceLine } from "@/components/first-trace-line";
import type { TraceWait } from "@/lib/hooks/use-trace-wait";
import { SampleTrace } from "./SampleTrace";
import { SetupTabs, type SetupTab } from "./SetupTabs";

interface GettingStartedProps {
  projectId: string;
  /**
   * The watch for the project's first trace, kept by the traces page: waiting,
   * then the trace that arrived for the moment before the page opens it.
   */
  wait: TraceWait;
}

/**
 * The traces page of a project with no traces yet: the setup tabs under the
 * page's own heading, and the line that says the page is watching for the
 * first trace — the same line the end of sign-up shows.
 *
 * Nothing sits above the switch. The stack is picked inside the manual tab, as
 * one of its steps.
 */
export function GettingStarted({ projectId, wait }: GettingStartedProps) {
  const [tab, setTab] = useState<SetupTab>("ai");

  return (
    <div className="w-full p-4">
      <div className="w-full max-w-4xl">
        <h2 className="text-[15px] font-medium">Get started with tracing</h2>
        <p className="mt-1 text-[13px] text-muted-foreground">
          No traces in this project yet. Get started in a few minutes with the command below.
        </p>
        <div className="mt-2">
          <FirstTraceLine wait={wait} align="start" />
        </div>

        <div className="mt-4">
          <SetupTabs
            projectId={projectId}
            surface="project"
            tab={tab}
            onTabChange={setTab}
            commandCopy={{
              title: "Run this in your project",
              label: "bash",
              note: "It asks before editing your code. Needs Node.js 20.12 or later.",
            }}
          />
        </div>

        {wait.kind === "waiting" && <SampleTrace projectId={projectId} />}
      </div>
    </div>
  );
}
