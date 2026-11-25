"use client";

import Link from "next/link";
import { Check, Plus } from "lucide-react";
import { useProject } from "@/features/projects/hooks";
import { useSlackStatus } from "@/features/integrations/hooks/useSlackIntegration";
import { SlackIntegrationLink } from "./slack-integration-link";
import { Step } from "./step";
import { useT } from "@/lib/i18n/provider";

interface AlertsOnboardingProps {
  projectId: string;
}

/**
 * The splash a project sees on /alerts before it has any alerts. Slack is the
 * only destination offered: webhooks and GitHub Actions are deferred, and an
 * inert row for a channel that cannot be connected is worse than no row.
 */
export function AlertsOnboarding({ projectId }: AlertsOnboardingProps) {
  const t = useT();
  const { data: project } = useProject(projectId);
  const workspaceId = project?.workspace_id;
  const { data: slack } = useSlackStatus(workspaceId);

  const isSlackConnected = !!slack?.connected;
  const integrationsHref = workspaceId ? `/workspaces/${workspaceId}/settings/integrations` : null;

  return (
    <div className="mx-auto w-full max-w-lg px-4 pt-12">
      <div className="text-center">
        <h1 className="text-[15px] font-medium">{t("alertsOnboarding.title")}</h1>
        <p className="mx-auto mt-2 max-w-md text-[13px] text-muted-foreground">
          {t("alertsOnboarding.text")}
        </p>
      </div>

      {/* Here the numbering is a real dependency, not reading order: a
          destination has to exist before an alert has anywhere to fire. */}
      <div className="mt-8">
        <Step
          index={1}
          title={t("alertsOnboarding.step1Title")}
          description={t("alertsSlack.postsToChannel")}
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
            <p className="mt-2 flex items-center gap-1.5 text-[12px] text-muted-foreground">
              {t("alertsSlack.needChannel")}
            </p>
          )}
          {isSlackConnected && slack?.channel && (
            <p className="mt-2 flex items-center gap-1.5 text-[12px] text-muted-foreground">
              <Check className="h-3 w-3" aria-hidden="true" />
              {t("alertsOnboarding.ready")}
            </p>
          )}
        </Step>

        <Step
          index={2}
          isLast
          title={t("alertsOnboarding.step2Title")}
          description={t("alertsOnboarding.step2Text")}
        >
          <Link
            href={`/projects/${projectId}/alerts/new`}
            className="inline-flex h-7 items-center gap-1 rounded-md bg-primary px-3 text-[12px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            {t("alertsList.newAlert")}
          </Link>
        </Step>
      </div>
    </div>
  );
}
