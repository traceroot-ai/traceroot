"use client";

import { LoadingState } from "@/components/ui/loading-state";
import { useProject } from "@/features/projects/hooks";
import { CodeBlock } from "./CodeBlock";
import { ExternalIntegrations } from "./ExternalIntegrations";
import { setupCommand } from "./commands";
import { SectionLink } from "./SectionLink";

interface AITabProps {
  projectId: string;
}

/**
 * The automatic route: one command, and what it will do.
 *
 * One command rather than a sequence of numbered steps, because someone with no
 * traces yet should not have to make decisions before they can act.
 * `traceroot setup` authenticates in the browser, creates the key, has a coding
 * agent instrument the service, runs the application, and waits for the first
 * trace to arrive.
 *
 * So the API-key step is gone rather than moved. "Create an API key" above a
 * command that creates one is asking for work the command exists to do, and the
 * two would drift the first time either changed.
 *
 * The description under the command is two sentences, not a bulleted account of
 * every stage. One line covers it, and the restraint is the point: someone on an empty traces page wants to know what to paste, and a
 * list of what will happen competes with the command for their attention.
 *
 * The second sentence survives the trim because it is consent rather than
 * description. The command edits a repository and launches an agent; a person
 * is entitled to know that before pasting, not after.
 *
 * The command itself is rendered rather than constant, because this page knows
 * the project the reader is looking at and the deployment that served them, and
 * the bare command would make them answer both again — see `./commands`.
 *
 * The docs link is the one thing added back. This section used to be the only
 * part of the panel with nothing to read: two sentences and a command to paste,
 * and no answer at all for the reader who wants to know what the agent will do
 * before they let it near their repository. It points at the tracing
 * get-started page rather than the CLI reference, because that page is the
 * whole of what the command automates — key, SDK, environment, the one call —
 * and the CLI page documents authenticating and reading traces instead.
 */
export function AITab({ projectId }: AITabProps) {
  const { data: project, isLoading: projectLoading } = useProject(projectId);
  const workspaceId = project?.workspace_id ?? "";

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[13px] font-medium text-foreground">Run this in your project</p>
          <SectionLink href="https://traceroot.ai/docs/tracing/get-started">
            View the tracing docs
          </SectionLink>
        </div>
        <CodeBlock label="bash" value={setupCommand({ projectId })} />
        <p className="text-[12px] text-muted-foreground">
          Instruments your repo with a coding agent and handles API key configuration. Asks before
          editing, and stops if you have uncommitted changes.
        </p>
      </div>

      <div className="space-y-2">
        <p className="text-[13px] font-medium text-foreground">External integrations</p>
        {projectLoading ? (
          <LoadingState label="Loading integrations..." />
        ) : (
          <ExternalIntegrations workspaceId={workspaceId} />
        )}
      </div>
    </div>
  );
}
