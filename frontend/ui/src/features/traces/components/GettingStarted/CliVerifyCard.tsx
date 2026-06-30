"use client";

import { CopyButton } from "@/components/ui/copy-button";
import { CLI_COMMANDS } from "./commands";

interface CliVerifyCardProps {
  /** Leading number so the heading stays consistent with the surrounding steps. */
  step: number;
}

/**
 * Optional onboarding step pointing at the read-only `traceroot-cli`. The CLI
 * verifies and lists traces from the terminal after the SDK is instrumented —
 * it does not add instrumentation itself.
 */
export function CliVerifyCard({ step }: CliVerifyCardProps) {
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-foreground">
        {step}. Verify your traces from the terminal (optional)
      </p>
      <p className="text-xs text-muted-foreground">
        Once your app is instrumented and sending traces, use the read-only CLI to list and inspect
        them from your terminal. The CLI doesn&apos;t add instrumentation — it&apos;s just for
        verifying your first trace.
      </p>
      <div className="border border-border">
        <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
          <span className="text-xs text-muted-foreground">bash</span>
          <CopyButton value={CLI_COMMANDS} className="h-6 w-6" />
        </div>
        <pre className="overflow-x-auto whitespace-pre-wrap bg-muted px-3 py-2.5 font-mono text-xs leading-relaxed text-foreground">
          {CLI_COMMANDS}
        </pre>
      </div>
      <p className="text-xs text-muted-foreground">
        <code className="font-mono">traceroot login</code> prompts for an API key — use the key from
        step 1 — and defaults to <code className="font-mono">https://app.traceroot.ai</code>.
      </p>
    </div>
  );
}
