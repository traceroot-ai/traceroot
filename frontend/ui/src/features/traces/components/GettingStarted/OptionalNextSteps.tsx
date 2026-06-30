"use client";

import { CopyButton } from "@/components/ui/copy-button";
import { GitHubConnectButton } from "@/components/github/GitHubConnectButton";
import { SlackConnectButton } from "@/components/slack/SlackConnectButton";
import { CLI_COMMANDS } from "./commands";

interface OptionalNextStepsProps {
  workspaceId: string;
  /** Include the read-only CLI verify row. Omitted on the AI tab, where the CLI
   * already lives in the "Set up tracing" widget. */
  includeCli?: boolean;
}

/**
 * One card consolidating the optional onboarding extras (connect GitHub, connect
 * Slack, and — on the Manual tab — verify traces via the CLI) into divider-
 * separated rows, so they read as a single "Optional next steps" group instead
 * of trailing numbered steps.
 */
export function OptionalNextSteps({ workspaceId, includeCli }: OptionalNextStepsProps) {
  return (
    <div className="divide-y divide-border rounded-sm border border-border">
      <div className="flex items-start justify-between gap-3 px-4 py-3">
        <div className="space-y-0.5">
          <p className="text-sm font-medium text-foreground">Connect GitHub repositories</p>
          <p className="text-xs text-muted-foreground">
            Repository linking and code-level tracing during root cause analysis.
          </p>
        </div>
        <div className="shrink-0">
          <GitHubConnectButton workspaceId={workspaceId} />
        </div>
      </div>

      <div className="flex items-start justify-between gap-3 px-4 py-3">
        <div className="space-y-0.5">
          <p className="text-sm font-medium text-foreground">Connect Slack for alerts</p>
          <p className="text-xs text-muted-foreground">
            Get detector alerts posted to a channel so your team is notified about issues.
          </p>
        </div>
        <div className="shrink-0">
          <SlackConnectButton workspaceId={workspaceId} />
        </div>
      </div>

      {includeCli && (
        <div className="space-y-2 px-4 py-3">
          <div className="space-y-0.5">
            <p className="text-sm font-medium text-foreground">
              Verify your traces from the terminal
            </p>
            <p className="text-xs text-muted-foreground">
              Use the read-only CLI to list and inspect traces after your app is instrumented — it
              doesn&apos;t add instrumentation itself.
            </p>
          </div>
          <div className="flex items-start gap-2">
            <pre className="flex-1 overflow-x-auto whitespace-pre-wrap bg-muted px-3 py-2.5 font-mono text-xs leading-relaxed text-foreground">
              {CLI_COMMANDS}
            </pre>
            <CopyButton value={CLI_COMMANDS} className="h-6 w-6 shrink-0" />
          </div>
          <p className="text-xs text-muted-foreground">
            <code className="font-mono">traceroot login</code> prompts for the API key from step 1
            and defaults to <code className="font-mono">https://app.traceroot.ai</code>.
          </p>
        </div>
      )}
    </div>
  );
}
