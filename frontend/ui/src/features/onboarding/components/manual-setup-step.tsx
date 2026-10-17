"use client";

import { Button } from "@/components/ui/button";
import { ManualTab } from "@/features/traces/components/GettingStarted/ManualTab";
import {
  StackAndModelKey,
  useStackSelection,
} from "@/features/traces/components/GettingStarted/StackAndModelKey";

interface ManualSetupStepProps {
  /** The project the key, the snippets and the integrations belong to. */
  projectId: string;
  /** Back to the terminal command, for someone who changed their mind. */
  onBack: () => void;
  /** Into the app, instrumented or not. */
  onDone: () => void;
}

/**
 * The optional last step of a first run: adding tracing by hand.
 *
 * The body is the getting-started panel's own setup, rendered here rather than
 * copied: the two questions every route asks — which stack, whose model key —
 * and then that panel's manual walkthrough, which is the key, the install and
 * the one call that starts tracing. A second copy of any of that in onboarding
 * would answer a different version of the same question within a release or
 * two, and the version a brand-new account reads is the one that must not be
 * the stale one.
 *
 * The stack picker is the traces panel's, above the walkthrough, rather than
 * the one the walkthrough falls back to when it is rendered alone. That one is
 * grouped differently and asks for the model key as a numbered step after the
 * snippets, so an account that signed up here and later opened an empty
 * project would meet the same two questions asked two different ways.
 *
 * Only the manual half is shown, not both modes. The other mode is the command
 * on the step before this one, which this user has just declined — so it is
 * offered as a way back instead, because deciding to do it by hand and then
 * changing your mind is ordinary.
 *
 * The line about the first trace is not here either, for the same reason it is
 * not on the hand-back step: the page watches across both of them and says so
 * once, in the header above the card. The watch keeps running while this step is
 * open — instrumenting by hand ends in a trace exactly as the command does — but
 * the line that reports it belongs to the flow, not to the step, and a line that
 * each step rendered for itself was a line that moved whenever the step changed.
 * See app/onboarding/page.tsx.
 *
 * The way out leads into the app with the application possibly still
 * uninstrumented, which is the honest state: these steps end in the user's
 * editor, and nothing in the browser can tell how far they got. The page picks
 * the destination, and picks one that keeps showing these same steps until the
 * first trace arrives, so leaving part-way through loses nothing.
 */
export function ManualSetupStep({ projectId, onBack, onDone }: ManualSetupStepProps) {
  const { selected, select } = useStackSelection();

  return (
    <div className="flex flex-col gap-4">
      {/* A notch above the walkthrough's own numbered labels, which are 14px
          medium: a step title that reads as subordinate to the first item
          inside it is worse than no title at all. */}
      <p className="text-sm font-semibold">Set up tracing by hand</p>

      <StackAndModelKey projectId={projectId} selected={selected} onSelect={select} />

      <ManualTab projectId={projectId} integration={selected} />

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
