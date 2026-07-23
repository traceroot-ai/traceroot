"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { CodeBlock } from "./CodeBlock";
import { CLI_COMMANDS, INSTRUMENT_PROMPT, SKILLS_COMMAND } from "./commands";

type SetupTab = "cli" | "ai" | "skills";

const TABS: { id: SetupTab; label: string }[] = [
  { id: "cli", label: "CLI" },
  { id: "ai", label: "Prompt" },
  { id: "skills", label: "Skills" },
];

/**
 * Compact setup widget mirroring the marketing site's hero ReadmeBox: one set of
 * underline tabs (CLI · Prompt · Skills, fixed order) over a shared CodeBlock,
 * with the explanation always below. The CLI tab is the read-only verify/list
 * flow; it does not add instrumentation itself.
 */
export function SetupTabs() {
  const [tab, setTab] = useState<SetupTab>("cli");

  return (
    <div className="space-y-2">
      <div className="flex border-b border-border">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            aria-pressed={tab === id}
            className={cn(
              "-mb-px border-b-2 px-3 py-1.5 text-xs font-medium transition-colors",
              tab === id
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "cli" && (
        <>
          <CodeBlock label="bash" value={CLI_COMMANDS} />
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
          <CodeBlock label="prompt" value={INSTRUMENT_PROMPT} mono={false} />
          <p className="text-xs text-muted-foreground">
            Hand this to any AI coding agent — Claude Code, Codex, Cursor, etc.
          </p>
        </>
      )}

      {tab === "skills" && (
        <>
          <CodeBlock label="bash" value={SKILLS_COMMAND} />
          <p className="text-xs text-muted-foreground">
            Install the first-party TraceRoot skills into your coding agent, then ask it to add
            tracing.
          </p>
        </>
      )}
    </div>
  );
}
