"use client";

import { Input } from "@/components/ui/input";
import { useProject } from "@/features/projects/hooks";
import { useSlackStatus } from "@/features/integrations/hooks/useSlackIntegration";
import { FieldLabel, SectionBox } from "@/features/dashboards/components/SectionBox";
import { ALERT_NAME_MAX } from "../rule-model";
import { CONTROL_SIZE } from "./form-controls";
import { SlackIntegrationLink } from "./slack-integration-link";

interface NotificationsSectionProps {
  projectId: string;
  name: string;
  onNameChange: (name: string) => void;
}

/**
 * Where the alert goes. Slack is the only channel, mirroring the onboarding
 * splash: webhooks, GitHub Actions and email are not shipped, so none of them
 * get a row here.
 */
export function NotificationsSection({ projectId, name, onNameChange }: NotificationsSectionProps) {
  const { data: project } = useProject(projectId);
  const workspaceId = project?.workspace_id;
  const { data: slack } = useSlackStatus(workspaceId);

  const isSlackConnected = !!slack?.connected;
  const integrationsHref = workspaceId ? `/workspaces/${workspaceId}/settings/integrations` : null;

  return (
    <SectionBox label="Notifications">
      {/* The name heads this section because it is how the alert identifies
          itself in the Slack message the section is about. */}
      <div className="p-3">
        <FieldLabel>Name</FieldLabel>
        <Input
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="e.g. p95 latency"
          aria-label="name"
          required
          maxLength={ALERT_NAME_MAX}
          className={CONTROL_SIZE}
        />
      </div>
      <div className="p-3">
        <FieldLabel>Integration</FieldLabel>
        {integrationsHref ? (
          <SlackIntegrationLink
            href={integrationsHref}
            isConnected={isSlackConnected}
            teamName={slack?.teamName}
            channelName={slack?.channel?.name}
            className="max-w-md"
          />
        ) : (
          <p className="text-[12px] text-muted-foreground">Loading workspace...</p>
        )}
        <p className="mt-2 text-[12px] text-muted-foreground">
          Alerts post to the Slack channel connected to this workspace.
        </p>
        {isSlackConnected && !slack?.channel && (
          <p className="mt-1 text-[11px] text-muted-foreground">
            Alerts need a channel. Select one in workspace settings.
          </p>
        )}
      </div>
    </SectionBox>
  );
}
