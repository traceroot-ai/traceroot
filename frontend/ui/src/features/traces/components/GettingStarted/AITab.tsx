"use client";

import { LoadingState } from "@/components/ui/loading-state";
import { useProject } from "@/features/projects/hooks";
import { CodeBlock } from "./CodeBlock";
import { ExternalIntegrations } from "./ExternalIntegrations";
import { setupCommand } from "./commands";
import { SectionLink } from "./SectionLink";
import { WorkspaceUnavailable } from "./WorkspaceUnavailable";

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
 * The description under the command is two short sentences, not an account of
 * what setup does: someone on an empty traces page wants to know what to paste,
 * and anything more competes with the command for their attention. What the
 * command does is on the docs page the heading links to.
 *
 * The first sentence is consent rather than description. The command edits a
 * repository and can launch an agent; a person is entitled to know that before
 * pasting, not after. It says "your code" because the API key goes into the env
 * file without a question. It holds unattended too, where setup asks nothing:
 * under `--no-input`, `--json`, CI or a pipe, it writes the task rather than
 * launching an agent.
 *
 * The second is the Node floor. `setup` refuses a Node older than 20.12 while
 * the rest of the CLI runs on 20.3, so a reader whose CLI works can still be
 * stopped by this one command, and this is where they copy it from.
 *
 * The command itself is rendered rather than constant, because this page knows
 * the project the reader is looking at and the deployment that served them, and
 * the bare command would make them answer both again — see `./commands`.
 *
 * Which is also why there is a second state here. When `./commands` cannot tell
 * which deployment served the page, the line it would otherwise render is the
 * bare one, and that signs the reader in against TraceRoot Cloud — so on a
 * self-hosted install a command shown here with no flags is not a lesser
 * answer, it is the wrong one. Nothing runnable is drawn in that case: no code
 * block and no copy button, because a command in that frame reads as one to
 * paste however the surrounding text is worded.
 *
 * What is drawn instead names the variable and the value it holds, since the
 * person looking at an empty traces page on a self-hosted install is usually
 * the person who can correct it, and the value is already public — it is
 * inlined into this bundle. The manual tab is mentioned as a route that still
 * works, but not as one independent of this value: its steps need the same API
 * address, as `TRACEROOT_HOST_URL`, and say so when they cannot show it.
 * Nothing here offers to fix the configuration, because nothing here can.
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
  const workspaceId = project?.workspace_id;
  const setup = setupCommand({ projectId });

  return (
    <div className="space-y-6">
      {setup.kind === "command" ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[13px] font-medium text-foreground">Run this in your project</p>
            <SectionLink href="https://traceroot.ai/docs/tracing/get-started">
              View the tracing docs
            </SectionLink>
          </div>
          <CodeBlock label="bash" value={setup.command} />
          <p className="text-[12px] text-muted-foreground">
            It asks before editing your code. Needs Node.js 20.12 or later.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-[13px] font-medium text-foreground">
            The setup command cannot be shown for this deployment
          </p>
          <p className="text-[12px] text-muted-foreground">
            <code className="font-mono">{setup.variable}</code> is set to{" "}
            <code className="font-mono">{setup.value}</code>, which isn&apos;t a usable origin, so
            the command would sign you in and send traces to TraceRoot Cloud instead. Correct that
            value and rebuild the web app. Meanwhile, the manual tab works once you set{" "}
            <code className="font-mono">TRACEROOT_HOST_URL</code> to this deployment&apos;s API
            address.
          </p>
        </div>
      )}

      <div className="space-y-2">
        <p className="text-[13px] font-medium text-foreground">External integrations</p>
        {projectLoading ? (
          <LoadingState label="Loading integrations..." />
        ) : workspaceId ? (
          <ExternalIntegrations workspaceId={workspaceId} />
        ) : (
          <WorkspaceUnavailable />
        )}
      </div>
    </div>
  );
}
