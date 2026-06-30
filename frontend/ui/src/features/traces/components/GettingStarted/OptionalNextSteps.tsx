"use client";

import { FaTerminal } from "react-icons/fa";
import { GitHubConnectButton } from "@/components/github/GitHubConnectButton";
import { SlackConnectButton } from "@/components/slack/SlackConnectButton";
import { CodeBlock } from "./CodeBlock";
import { CLI_COMMANDS } from "./commands";

interface OptionalNextStepsProps {
  workspaceId: string;
  /** Include the read-only CLI verify row. Omitted on the AI tab, where the CLI
   * already lives in the "Set up tracing" widget. */
  includeCli?: boolean;
}

/**
 * One card consolidating the optional onboarding extras into divider-separated
 * rows. GitHub and Slack render their self-contained connect rows (icon + text +
 * action); the Manual tab additionally gets a CLI verify row in the same shape.
 */
export function OptionalNextSteps({ workspaceId, includeCli }: OptionalNextStepsProps) {
  return (
    <div className="divide-y divide-border rounded-sm border border-border">
      <div className="px-4 py-3">
        <GitHubConnectButton workspaceId={workspaceId} />
      </div>

      <div className="px-4 py-3">
        <SlackConnectButton workspaceId={workspaceId} />
      </div>

      {includeCli && (
        <div className="space-y-2 px-4 py-3">
          <div className="flex items-center gap-3">
            <FaTerminal className="h-6 w-6 shrink-0 text-muted-foreground" />
            <div>
              <div className="text-sm font-medium text-foreground">CLI</div>
              <div className="text-sm text-muted-foreground">
                List and inspect traces from your terminal after instrumenting.
              </div>
            </div>
          </div>
          <CodeBlock label="bash" value={CLI_COMMANDS} />
          <p className="text-xs text-muted-foreground">
            <code className="font-mono">traceroot login</code> prompts for the API key from step 1
            and defaults to <code className="font-mono">https://app.traceroot.ai</code>.
          </p>
        </div>
      )}
    </div>
  );
}
