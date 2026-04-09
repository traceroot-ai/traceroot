"use client";

import { useState } from "react";
import { Sparkle, Code2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { GitHubConnectButton } from "@/components/github/GitHubConnectButton";
import { AITab } from "./AITab";
import { ManualTab } from "./ManualTab";

type Tab = "ai" | "manual";

interface GettingStartedProps {
  projectId: string;
}

export function GettingStarted({ projectId }: GettingStartedProps) {
  const [tab, setTab] = useState<Tab>("ai");

  return (
    <div className="w-full py-10">
      <div className="mx-auto w-full max-w-[600px] px-7 lg:max-w-3xl xl:max-w-4xl">
        <h2 className="text-xl font-semibold tracking-tight text-foreground">
          Get started with Tracing
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          You don&apos;t have any traces yet. Choose how you&apos;d like to set up.
        </p>

        <div className="mt-6 rounded-sm border border-border bg-muted/30 px-4 py-3">
          <p className="text-sm font-medium text-foreground">Connect GitHub</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Install the GitHub App so TraceRoot can link traces to your repositories and enable
            code-level analysis.
          </p>
          <div className="mt-3">
            <GitHubConnectButton />
          </div>
        </div>

        <div className="mt-6 inline-flex gap-0.5 rounded-sm border border-border bg-muted p-0.5">
          <button
            type="button"
            onClick={() => setTab("ai")}
            className={cn(
              "flex items-center gap-1.5 rounded-none px-3 py-1.5 text-xs font-medium transition-colors",
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
              "flex items-center gap-1.5 rounded-none px-3 py-1.5 text-xs font-medium transition-colors",
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
          {tab === "ai" ? <AITab projectId={projectId} /> : <ManualTab projectId={projectId} />}
        </div>
      </div>
    </div>
  );
}
