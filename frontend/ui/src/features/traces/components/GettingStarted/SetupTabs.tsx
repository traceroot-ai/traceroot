"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { CopyButton } from "@/components/ui/copy-button";
import { CLI_COMMANDS, INSTRUMENT_PROMPT, SKILLS_COMMAND } from "./commands";

type SetupTab = "cli" | "ai" | "skills";

const TABS: { id: SetupTab; label: string }[] = [
  { id: "cli", label: "CLI" },
  { id: "ai", label: "Prompt" },
  { id: "skills", label: "Skills" },
];

/**
 * Compact, clickable-column setup widget mirroring the marketing site's hero
 * ReadmeBox: one card, three tabs (CLI · Prompt · Skills) in a fixed order so
 * the onboarding step stays uncluttered. The CLI tab is the read-only
 * verify/list flow; it does not add instrumentation itself.
 */
export function SetupTabs() {
  const [tab, setTab] = useState<SetupTab>("cli");

  return (
    <div className="border border-border">
      <div className="flex items-center gap-1.5 overflow-x-auto border-b border-border px-2 py-1.5">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            aria-pressed={tab === id}
            className={cn(
              "rounded-none px-3 py-1 text-xs font-medium transition-colors",
              tab === id
                ? "border border-border bg-background text-foreground shadow-sm"
                : "border border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="space-y-2 p-3">
        {tab === "cli" && (
          <>
            <div className="flex items-start gap-2">
              <pre className="flex-1 overflow-x-auto whitespace-pre-wrap bg-muted px-3 py-2.5 font-mono text-xs leading-relaxed text-foreground">
                {CLI_COMMANDS}
              </pre>
              <CopyButton value={CLI_COMMANDS} className="h-6 w-6 shrink-0" />
            </div>
            <p className="text-xs text-muted-foreground">
              Verify and list your traces from the terminal after your app is instrumented — the CLI
              doesn&apos;t add instrumentation itself.{" "}
              <code className="font-mono">traceroot login</code> prompts for the API key from step 1
              and defaults to <code className="font-mono">https://app.traceroot.ai</code>.
            </p>
          </>
        )}

        {tab === "ai" && (
          <>
            <p className="text-xs text-muted-foreground">
              Hand this to any AI coding agent — Claude Code, Codex, Cursor, etc.
            </p>
            <div className="flex items-start gap-2 rounded-sm bg-muted px-3 py-2.5">
              <p className="flex-1 text-sm text-foreground">{INSTRUMENT_PROMPT}</p>
              <CopyButton value={INSTRUMENT_PROMPT} className="h-6 w-6 shrink-0" />
            </div>
          </>
        )}

        {tab === "skills" && (
          <>
            <div className="flex items-start gap-2">
              <pre className="flex-1 overflow-x-auto whitespace-pre-wrap bg-muted px-3 py-2.5 font-mono text-xs leading-relaxed text-foreground">
                {SKILLS_COMMAND}
              </pre>
              <CopyButton value={SKILLS_COMMAND} className="h-6 w-6 shrink-0" />
            </div>
            <p className="text-xs text-muted-foreground">
              Install the first-party TraceRoot skills into your coding agent, then ask it to add
              tracing.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
