"use client";

import { useState } from "react";
import { Sparkle, Code2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { AITab } from "./AITab";
import { ManualTab } from "./ManualTab";

type Tab = "ai" | "manual";

interface GettingStartedProps {
  projectId: string;
}

/**
 * Two routes to the same outcome, named for what the reader gets.
 *
 * "Using AI" says what the automatic route actually is — a coding agent edits
 * the repository — which is the thing a reader weighs before choosing it. The
 * pairing with "Manual" is looser than a strict antonym, and that is the trade:
 * naming the mechanism costs a little symmetry and buys an informed choice.
 */
export function GettingStarted({ projectId }: GettingStartedProps) {
  const [tab, setTab] = useState<Tab>("ai");

  return (
    <div className="w-full p-6">
      <div className="mx-auto w-full max-w-2xl lg:max-w-3xl xl:max-w-4xl">
        <h2 className="text-xl font-semibold">Get started with tracing</h2>
        <p className="mt-1 text-[13px] text-muted-foreground">
          No traces in this project yet. Get started in a few minutes with the command below.
        </p>

        <div className="mt-6 flex items-center gap-1 border-b border-border">
          <button
            type="button"
            onClick={() => setTab("ai")}
            className={cn(
              "flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-[13px] font-medium transition-colors",
              tab === "ai"
                ? "border-foreground bg-muted text-foreground"
                : "border-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground",
            )}
          >
            <Sparkle className="h-3.5 w-3.5" />
            Using AI
          </button>
          <button
            type="button"
            onClick={() => setTab("manual")}
            className={cn(
              "flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-[13px] font-medium transition-colors",
              tab === "manual"
                ? "border-foreground bg-muted text-foreground"
                : "border-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground",
            )}
          >
            <Code2 className="h-3.5 w-3.5" />
            Manual
          </button>
        </div>

        <div className="mt-6">
          {tab === "ai" ? <AITab projectId={projectId} /> : <ManualTab projectId={projectId} />}
        </div>
      </div>
    </div>
  );
}
