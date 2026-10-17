"use client";

import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/features/traces/components/GettingStarted/CodeBlock";
import { setupCommand } from "@/features/traces/components/GettingStarted/commands";
import type { TraceWait } from "@/lib/hooks/use-trace-wait";
import { FirstTraceLine } from "@/components/first-trace-line";

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
  /**
   * How the watch for this project's first trace is going.
   *
   * Said above the command rather than under it. It is the only line on the
   * step that reports anything happening, and a user who has pasted the command
   * is watching their terminal — so when they look back at this tab it has to
   * be in the part they see first, not under the thing they have already run.
   */
  wait: TraceWait;
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
 * On a deployment whose own origin cannot be resolved there is no command to
 * run, and nothing runnable is drawn: `setupCommand` has no flags to put on the
 * line there, and the line without them is the TraceRoot Cloud one — so a
 * self-hosted operator who pasted it would sign this machine in against someone
 * else's deployment and send their first traces there, on the last page of
 * signing up. What is drawn instead names the variable and the value it holds,
 * since the person finishing a self-hosted first run is usually the person who
 * can correct it, and the value is already public: it is inlined into this
 * bundle. Both doors stay, because that is the half of this step which still
 * works.
 */
export function CliHandbackStep({
  projectId,
  projectName,
  handoff,
  onSetUpManually,
  onSkip,
  wait,
}: CliHandbackStepProps) {
  const setup = setupCommand({ projectId, handoff });

  return (
    <div className="flex flex-col gap-3">
      {setup.kind === "command" ? (
        <>
          <div>
            <p className="text-[13px] font-medium">Finish setting up in your terminal</p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {projectName} is ready. Run this where your application lives.
            </p>
          </div>

          <FirstTraceLine wait={wait} />

          <CodeBlock label="terminal" value={setup.command} />
        </>
      ) : (
        <>
          <div>
            <p className="text-[13px] font-medium">
              The setup command cannot be shown for this deployment
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {projectName} is ready, but <code className="font-mono">{setup.variable}</code> is set
              to <code className="font-mono">{setup.value}</code>, which is not an origin the
              command can be pointed at. Without it the command would send sign-in and your first
              traces to TraceRoot Cloud rather than here, so it is withheld rather than guessed.
              Correct that value for this deployment and the command appears here; until then,
              &quot;Set up manually&quot; walks through the rest in the browser.
            </p>
          </div>

          <FirstTraceLine wait={wait} />
        </>
      )}

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
