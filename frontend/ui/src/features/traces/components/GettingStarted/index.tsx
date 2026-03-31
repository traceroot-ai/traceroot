"use client";

import { useState } from "react";
import { Sparkle, Code2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { AiTab } from "./AiTab";
import { ManualTab } from "./ManualTab";

type Tab = "ai" | "manual";

interface GettingStartedProps {
  projectId: string;
}

export function GettingStarted({ projectId }: GettingStartedProps) {
  const [tab, setTab] = useState<Tab>("ai");

  return (
    <div className="w-full py-10">
      <div className="mx-auto w-full max-w-[600px] px-7">
        <h2 className="text-xl font-semibold tracking-tight text-foreground">
          Get started with Tracing
        </h2>
        <p className="mt-1 text-[13px] text-muted-foreground">
          You don&apos;t have any traces yet. Choose how you&apos;d like to set up.
        </p>

        <div className="mt-6 inline-flex gap-0.5 rounded-md border border-border bg-muted p-0.5">
          <button
            type="button"
            onClick={() => setTab("ai")}
            className={cn(
              "flex items-center gap-1.5 rounded px-3 py-1.5 text-[12px] font-medium transition-colors",
              tab === "ai"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Sparkle className="h-3.5 w-3.5" />
            Using AI
          </button>
          <button
            type="button"
            onClick={() => setTab("manual")}
            className={cn(
              "flex items-center gap-1.5 rounded px-3 py-1.5 text-[12px] font-medium transition-colors",
              tab === "manual"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Code2 className="h-3.5 w-3.5" />
            Manual
          </button>
        </div>

        <div className="mt-6">
          {tab === "ai" ? <AiTab projectId={projectId} /> : <ManualTab projectId={projectId} />}
        </div>
      </div>
    </div>
  );
}
