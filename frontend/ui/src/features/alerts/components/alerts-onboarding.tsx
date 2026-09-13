"use client";

import Link from "next/link";
import { Check, Plus } from "lucide-react";
import { useProject } from "@/features/projects/hooks";
import { useSlackStatus } from "@/features/integrations/hooks/useSlackIntegration";
import { SlackIntegrationLink } from "./slack-integration-link";
import { Step } from "./step";

interface AlertsOnboardingProps {
  projectId: string;
}

/**
 * The splash a project sees on /alerts before it has any alerts. Slack is the
 * only destination offered: webhooks and GitHub Actions are deferred, and an
 * inert row for a channel that cannot be connected is worse than no row.
 */
export function AlertsOnboarding({ projectId }: AlertsOnboardingProps) {
  const { data: project } = useProject(projectId);
  const workspaceId = project?.workspace_id;
  const { data: slack } = useSlackStatus(workspaceId);

  const isSlackConnected = !!slack?.connected;
  const integrationsHref = workspaceId ? `/workspaces/${workspaceId}/settings/integrations` : null;

  return (
    <div className="mx-auto w-full max-w-lg px-4 pt-12">
      <div className="text-center">
        <h1 className="text-lg font-semibold">Get started with Alerts</h1>
        <p className="mx-auto mt-2 max-w-md text-[13px] text-muted-foreground">
          You don&apos;t have any alerts yet. Set up where they go, then create your first one.
        </p>
      </div>

      {/* Here the numbering is a real dependency, not reading order: a
          destination has to exist before an alert has anywhere to fire. */}
      <div className="mt-8">
        <Step
          index={1}
          title="Set up notifications"
          description="Alerts post to the Slack channel connected to this workspace."
        >
          {integrationsHref ? (
            <SlackIntegrationLink
              href={integrationsHref}
              isConnected={isSlackConnected}
              teamName={slack?.teamName}
              channelName={slack?.channel?.name}
            />
          ) : null}
          {isSlackConnected && !slack?.channel && (
            <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              Alerts need a channel. Select one in workspace settings.
            </p>
          )}
          {isSlackConnected && slack?.channel && (
            <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Check className="h-3 w-3" aria-hidden="true" />
              Ready to receive alerts.
            </p>
          )}
        </Step>

        <Step
          index={2}
          isLast
          title="Create an alert"
          description="Choose a metric — latency, cost, or token usage — and the threshold that triggers the alert."
        >
          <Link
            href={`/projects/${projectId}/alerts/new`}
            className="inline-flex h-7 items-center gap-1 rounded-md bg-primary px-3 text-[12px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            New Alert
          </Link>
        </Step>
      </div>
    </div>
  );
}
