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
 * Three ways out: run the command, do it by hand, or leave. The two
 * alternatives are deliberately quieter than the command — not hidden, because
 * a user who will not paste a CLI invocation into their shell needs a door, and
 * a dead end here is a dead end at the end of signing up.
 */
export function CliHandbackStep({
  projectId,
  projectName,
  onSetUpManually,
  onSkip,
}: CliHandbackStepProps) {
  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="text-[13px] font-medium">Finish setting up in your terminal</p>
        <p className="mt-1 text-[11px] text-muted-foreground">
          {projectName} is ready. Run this where your application lives — it signs this machine in,
          writes its API key, instruments your code with your coding agent and waits for the first
          trace.
        </p>
      </div>

      <CodeBlock label="terminal" value={setupCommand({ projectId })} />

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
