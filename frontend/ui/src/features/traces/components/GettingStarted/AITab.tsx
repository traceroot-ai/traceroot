"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import { useProject } from "@/features/projects/hooks";
import { useWorkspaces } from "@/features/workspaces/hooks";
import { cn } from "@/lib/utils";
import { CodeBlock } from "./CodeBlock";
import { ExternalIntegrations } from "./ExternalIntegrations";
import { setupCommand } from "./commands";
import { SectionLink } from "./SectionLink";
import { useSetupCommandCopied, type SetupCommandSurface } from "./use-setup-command-copied";
import { WorkspaceUnavailable } from "./WorkspaceUnavailable";

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
 * Each place that shows this tab words the block around the command itself (see
 * `CommandCopy`): the traces page and the end of sign-up keep their own heading,
 * label and short note. The note is short, not an account of what setup does:
 * someone about to paste wants to know what to paste, and anything more competes
 * with the command for their attention. What the command does is on the docs
 * page the heading links to. One line under the command, the same in both
 * places, says what the first trace will show.
 *
 * The note's sentence about editing code is consent rather than description. The command edits a
 * repository and can launch an agent; a person is entitled to know that before
 * pasting, not after. It says "your code" because the API key goes into the env
 * file without a question. It holds unattended too, where setup asks nothing:
 * under `--no-input`, `--json`, CI or a pipe, it writes the task rather than
 * launching an agent.
 *
 * Its other sentence is the Node floor. `setup` refuses a Node older than 20.12 while
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
export interface CommandCopy {
  /** The heading over the command. */
  title: string;
  /** Under the heading, before the command; sign-up says where to run it here. */
  intro?: ReactNode;
  /** Under the command. */
  note?: ReactNode;
  /** The code block's label. */
  label: string;
}

interface AITabProps {
  projectId: string;
  /** Where the tab is shown, for the copy event. */
  surface: SetupCommandSurface;
  /** Each surface words the command block its own way. */
  copy: CommandCopy;
  /** The GitHub and Slack connections. Sign-up hides them; they move to their own step. */
  showExternalIntegrations?: boolean;
  /** More ways out, beside the demo project: sign-up's "Skip for now". */
  actions?: ReactNode;
}

export function AITab({
  projectId,
  surface,
  copy,
  showExternalIntegrations = true,
  actions,
}: AITabProps) {
  const { data: project, isLoading: projectLoading } = useProject(projectId);
  const workspaceId = project?.workspace_id;
  const setup = setupCommand({ projectId });
  const onCommandCopied = useSetupCommandCopied(projectId, surface);
  const demoWorkspace = useDemoWorkspace();
  const hasActions = !!demoWorkspace || !!actions;

  return (
    <div className="space-y-6">
      {setup.kind === "command" ? (
        <div className="space-y-2">
          <div>
            <div className="flex items-center justify-between gap-3">
              <p className="text-[13px] font-medium text-foreground">{copy.title}</p>
              <SectionLink href="https://traceroot.ai/docs/tracing/get-started">
                View the tracing docs
              </SectionLink>
            </div>
            {copy.intro && <p className="mt-1 text-[12px] text-muted-foreground">{copy.intro}</p>}
          </div>
          <CodeBlock label={copy.label} value={setup.command} onCopy={onCommandCopied} />
          {copy.note && <p className="text-[12px] text-muted-foreground">{copy.note}</p>}
          {/* What the person gets for running it. Copying shows nothing new: the
              page keeps waiting until the trace itself arrives. */}
          <p className="text-[12px] text-muted-foreground">
            When your first trace arrives, you can open it and see every step your agent took.
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
            the command would sign you in and send traces to traceroot Cloud instead. Correct that
            value and rebuild the web app. Meanwhile, the manual tab works once you set{" "}
            <code className="font-mono">TRACEROOT_HOST_URL</code> to this deployment&apos;s API
            address.
          </p>
        </div>
      )}

      {hasActions && (
        <div
          className={cn(
            "flex flex-wrap items-center gap-2",
            surface === "onboarding" && "justify-center",
          )}
        >
          {/* Only where a demo workspace is set up; it is in every account's list there. */}
          {demoWorkspace && (
            <Link
              href={`/workspaces/${demoWorkspace.id}/projects`}
              className={cn(
                buttonVariants({ variant: "outline", size: "sm" }),
                "h-7 px-4 text-[12px]",
              )}
            >
              See the demo project
            </Link>
          )}
          {actions}
        </div>
      )}

      {showExternalIntegrations && (
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
      )}
    </div>
  );
}

/** The demo workspace, when this deployment has one: it is in every account's list. */
function useDemoWorkspace() {
  const { data: workspaces } = useWorkspaces();
  return workspaces?.find((workspace) => workspace.is_demo);
}
