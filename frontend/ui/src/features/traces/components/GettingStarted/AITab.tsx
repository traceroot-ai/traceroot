"use client";

import { CopyButton } from "@/components/ui/copy-button";
import { GitHubConnectButton } from "@/components/github/GitHubConnectButton";
import { useProject } from "@/features/projects/hooks";
import { ApiKeyBlock } from "./ApiKeyBlock";

const INSTRUMENT_PROMPT =
  "Install the TraceRoot AI skill from https://github.com/traceroot-ai/traceroot-skills and use it to add tracing to this application with TraceRoot following best practices.";

interface AITabProps {
  projectId: string;
}

export function AITab({ projectId }: AITabProps) {
  const { data: project } = useProject(projectId);
  const workspaceId = project?.workspace_id ?? "";
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground">1. Create an API key</p>
        <ApiKeyBlock projectId={projectId} />
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground">
          2. Instrument your app with one prompt
        </p>
        <p className="text-xs text-muted-foreground">
          Hand this to any AI coding agent — Claude Code, Codex, Cursor, etc.
        </p>
        <div className="flex items-start gap-2 rounded-sm border border-border bg-muted/30 px-4 py-3">
          <p className="flex-1 text-sm text-foreground">{INSTRUMENT_PROMPT}</p>
          <CopyButton value={INSTRUMENT_PROMPT} className="h-6 w-6 shrink-0" />
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground">
          3. Optionally connect your GitHub repositories
        </p>
        <div className="rounded-sm border border-border bg-muted/30 px-4 py-3">
          <p className="text-xs text-muted-foreground">
            Install the GitHub App for repository linking and code-level tracing during root cause
            analysis.
          </p>
          <div className="mt-3">
            <GitHubConnectButton workspaceId={workspaceId} />
          </div>
        </div>
      </div>
    </div>
  );
}
