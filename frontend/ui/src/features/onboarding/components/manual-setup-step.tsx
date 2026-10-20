"use client";

import { Button } from "@/components/ui/button";
import { ManualTab } from "@/features/traces/components/GettingStarted/ManualTab";
import type { TraceWait } from "@/lib/hooks/use-trace-wait";
import { FirstTraceLine } from "@/components/first-trace-line";

interface ManualSetupStepProps {
  /** The project the key, the snippets and the integrations belong to. */
  projectId: string;
  /** Back to the terminal command, for someone who changed their mind. */
  onBack: () => void;
  /** Into the app, instrumented or not. */
  onDone: () => void;
  /**
   * How the watch for this project's first trace is going.
   *
   * The same watch the step before this one shows, still running: instrumenting
   * by hand ends in a trace exactly as the command does, and the moment it
   * arrives is the moment these steps are finished with. Stopping the watch
   * because the user chose the longer path would blind the page precisely where
   * the confirmation is worth the most.
   */
  wait: TraceWait;
}

/**
 * The optional last step of a first run: adding tracing by hand.
 *
 * The body is the getting-started panel's own manual walkthrough, rendered
 * here rather than copied: it is five numbered steps of prose, snippets per
 * language and per integration, and a key the user only ever sees once. A
 * second copy of that in onboarding would answer a different version of the
 * same question within a release or two, and the version a brand-new account
 * reads is the one that must not be the stale one.
 *
 * Only the manual half is shown, not both tabs. The other tab is the command
 * on the step before this one, which this user has just declined — so it is
 * offered as a way back instead, because deciding to do it by hand and then
 * changing your mind is ordinary.
 *
 * The way out leads into the app with the application possibly still
 * uninstrumented, which is the honest state: these steps end in the user's
 * editor, and nothing in the browser can tell how far they got. The page picks
 * the destination, and picks one that keeps showing these same steps until the
 * first trace arrives, so leaving part-way through loses nothing.
 */
export function ManualSetupStep({ projectId, onBack, onDone, wait }: ManualSetupStepProps) {
  return (
    <div className="flex flex-col gap-4">
      {/* A notch above the walkthrough's own numbered labels, which are 14px
          medium: a step title that reads as subordinate to the first item
          inside it is worse than no title at all. */}
      <p className="text-sm font-semibold">Set up tracing by hand</p>

      <ManualTab projectId={projectId} />

      <FirstTraceLine wait={wait} />

      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button size="sm" className="h-7 px-4 text-[12px]" onClick={onDone}>
          Go to my project
        </Button>
        <Button variant="ghost" size="sm" className="h-7 px-4 text-[12px]" onClick={onBack}>
          Back to the terminal command
        </Button>
      </div>
    </div>
  );
}
