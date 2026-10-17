"use client";

import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/features/traces/components/GettingStarted/CodeBlock";
import { setupCommand } from "@/features/traces/components/GettingStarted/commands";

interface CliHandbackStepProps {
  /** The project the command will point `setup` at. */
  projectId: string;
  /** Named so the user can see which project the command is about to fill. */
  projectName: string;
  /**
   * A one-time code that signs the pasted-into terminal in, or null when there
   * is none to print.
   *
   * Null is the ordinary case for the first render — the mint is a round trip —
   * and the standing case when it failed. Either way the command is rendered
   * without the flag and nothing is said about it: that command is what this
   * step printed before handoffs existed, and it works by sending the user
   * through a second browser page, which is a worse flow rather than a broken
   * one. The page owns the mint and its refresh; this step only prints what it
   * is handed, so a replacement arrives here as a new value on an ordinary
   * re-render.
   */
  handoff: string | null;
  /**
   * "Set up manually" — the walkthrough for someone who would rather not hand
   * their repository to a CLI.
   *
   * A prop rather than a route baked in here because this is the seam the
   * model-provider step is going to occupy: the manual path is provider keys
   * *and* instrumentation, and only the second half of that exists today. The
   * page decides where it goes, so adding the first half later changes one
   * caller rather than this component.
   */
  onSetUpManually: () => void;
  /** "Skip for now" — into the app with the application still uninstrumented. */
  onSkip: () => void;
}

/**
 * The last step of a first run: the command that continues setup in a terminal.
 *
 * Nothing further can usefully be asked in the browser. Everything left —
 * signing this machine in, writing the key into the project's env file,
 * instrumenting the application, running it, waiting for the first trace —
 * happens against a checkout the dashboard cannot see, and `traceroot setup`
 * is the one thing that does all of it. So the page stops asking and hands the
 * user back to where their code is.
 *
 * This is the browser-first half of the flow only. A run that *started* in a
 * terminal never reaches this step: the page hands straight back to the device
 * approval the CLI is already blocked on, because that terminal is mid-command
 * and does not need to be told to run one.
 *
 * Which is why the command carries a handoff code. The terminal it is pasted
 * into holds no credential, so without one `setup` would open a second browser
 * page to sign in — for the account that signed in in this one a minute ago —
 * and that page would wait for the same first trace this one is already
 * watching. The code is how the terminal authenticates with no page at all, and
 * so how this stays the only page in browser-first onboarding.
 *
 * Three ways out: run the command, do it by hand, or leave. The two
 * alternatives are deliberately quieter than the command — not hidden, because
 * a user who will not paste a CLI invocation into their shell needs a door, and
 * a dead end here is a dead end at the end of signing up.
 *
 * What is deliberately not here is the line about the first trace. The page
 * watches for it across both of these steps and says so once, in the header
 * above the card, so that it reads as the state of the run rather than as part
 * of whichever step happens to be on screen — and so that it stays in the same
 * place when the user switches to the manual step. See app/onboarding/page.tsx.
 */
export function CliHandbackStep({
  projectId,
  projectName,
  handoff,
  onSetUpManually,
  onSkip,
}: CliHandbackStepProps) {
  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="flex items-center justify-between gap-3">
          <p className="text-[13px] font-medium">Finish setting up in your terminal</p>
          {/* Beside the heading rather than under the command, which is where
              the traces panel puts the same link over the same command. */}
          <a
            href="https://traceroot.ai/docs/tracing/get-started"
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 text-[11px] text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
          >
            View the docs
          </a>
        </div>
        {/* What the command does, before it is pasted. It printed a command
            and nothing else: the one thing a reader weighs before handing a
            CLI their checkout is whether it is going to edit the checkout,
            and that was the one thing the step did not say. "{projectName} is
            ready" said nothing the header above had not already said, so this
            costs no line — it replaces one. */}
        <p className="mt-1 text-[11px] text-muted-foreground">
          Instruments your repository, writes the API key into it, and waits for the first trace.
          Run it where {projectName}&apos;s code lives.
        </p>
      </div>

      <CodeBlock label="terminal" value={setupCommand({ projectId, handoff })} />

      <div className="flex items-center justify-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-4 text-[12px]"
          onClick={onSetUpManually}
        >
          Set up manually
        </Button>
        <Button variant="ghost" size="sm" className="h-7 px-4 text-[12px]" onClick={onSkip}>
          Skip for now
        </Button>
      </div>
    </div>
  );
}
