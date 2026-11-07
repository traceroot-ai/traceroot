"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useProject } from "@/features/projects/hooks";
import { useSlackStatus } from "@/features/integrations/hooks/useSlackIntegration";
import { FieldLabel, SectionBox } from "@/features/dashboards/components/SectionBox";
import {
  ALERT_NAME_MAX,
  ALERT_NO_DATA_MODES,
  ALERT_NO_DATA_MODE_HINTS,
  ALERT_NO_DATA_MODE_LABELS,
  ALERT_RENOTIFY_MAX_MINUTES,
  ALERT_RENOTIFY_MIN_MINUTES,
  DEFAULT_ALERT_RENOTIFY_INTERVAL_MINUTES,
  clampRenotifyInterval,
  type AlertNoDataMode,
  type AlertRenotify,
} from "../rule-model";
import { CONTROL_SIZE } from "./form-controls";
import { SlackIntegrationLink } from "./slack-integration-link";

interface RenotifyIntervalFieldProps {
  intervalMinutes: number;
  onIntervalChange: (intervalMinutes: number) => void;
}

/**
 * The raw input string is the state the user types into, as with threshold, and
 * only a value that survives the clamp unchanged is handed up. Clamping every
 * keystroke instead turns a cleared field into 1 and the next digit into 1x.
 *
 * The field owns the raw string for as long as it is mounted; a parent that
 * needs to reset it must remount it (key it by the rule's identity).
 */
function RenotifyIntervalField({ intervalMinutes, onIntervalChange }: RenotifyIntervalFieldProps) {
  const [draft, setDraft] = useState(String(intervalMinutes));

  const handleChange = (value: string) => {
    setDraft(value);
    const parsed = Number(value);
    if (clampRenotifyInterval(parsed) === parsed) onIntervalChange(parsed);
  };

  // Blank or unparseable leaves the last committed interval standing rather
  // than inventing one.
  const handleBlur = () => {
    const parsed = Number(draft);
    const next =
      draft.trim() === "" || !Number.isFinite(parsed)
        ? intervalMinutes
        : clampRenotifyInterval(parsed);
    setDraft(String(next));
    onIntervalChange(next);
  };

  return (
    <div>
      <FieldLabel>Re-alert every (minutes)</FieldLabel>
      <Input
        type="number"
        value={draft}
        onChange={(e) => handleChange(e.target.value)}
        onBlur={handleBlur}
        aria-label="renotify interval"
        required
        min={ALERT_RENOTIFY_MIN_MINUTES}
        max={ALERT_RENOTIFY_MAX_MINUTES}
        step="1"
        className={CONTROL_SIZE}
      />
    </div>
  );
}

interface NotificationsSectionProps {
  projectId: string;
  noDataMode: AlertNoDataMode;
  renotify: AlertRenotify;
  name: string;
  onNoDataModeChange: (noDataMode: AlertNoDataMode) => void;
  onRenotifyChange: (renotify: AlertRenotify) => void;
  onNameChange: (name: string) => void;
}

/**
 * When the alert speaks and where it goes. The no-data mode and renotify sit
 * here rather than with the condition because neither changes what is
 * measured: one decides whether silence pages, the other how often a standing
 * breach pages again. NOTIFY is the mode for sources whose silence is the
 * incident.
 *
 * Slack is the only channel, mirroring the onboarding splash: webhooks, GitHub
 * Actions and email are not shipped, so none of them get a row here.
 */
export function NotificationsSection({
  projectId,
  noDataMode,
  renotify,
  name,
  onNoDataModeChange,
  onRenotifyChange,
  onNameChange,
}: NotificationsSectionProps) {
  const { data: project, isError: isProjectError } = useProject(projectId);
  const workspaceId = project?.workspace_id;
  // isLoading, not isPending: this query is disabled until the workspace is
  // known, and a disabled query stays pending forever.
  const { data: slack, isLoading: isSlackStatusLoading } = useSlackStatus(workspaceId);

  const isSlackConnected = !!slack?.connected;
  const integrationsHref = workspaceId ? `/workspaces/${workspaceId}/settings/integrations` : null;

  return (
    <SectionBox label="Notify">
      <div className="p-3">
        <FieldLabel>When a window has no data</FieldLabel>
        <Select
          value={noDataMode}
          onValueChange={(mode) => onNoDataModeChange(mode as AlertNoDataMode)}
        >
          <SelectTrigger className={CONTROL_SIZE} aria-label="no data mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ALERT_NO_DATA_MODES.map((mode) => (
              <SelectItem key={mode} value={mode} className="text-[12px]">
                {ALERT_NO_DATA_MODE_LABELS[mode]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
          {ALERT_NO_DATA_MODE_HINTS[noDataMode]}
        </p>
      </div>
      <div className="p-3">
        <div className="flex flex-col gap-3">
          <div>
            <FieldLabel>Renotify</FieldLabel>
            <Select
              value={renotify.mode}
              // A mode change builds a new renotify rather than editing one,
              // so "off" can never carry a stale interval.
              onValueChange={(mode) =>
                onRenotifyChange(
                  mode === "EVERY"
                    ? {
                        mode: "EVERY",
                        intervalMinutes: DEFAULT_ALERT_RENOTIFY_INTERVAL_MINUTES,
                      }
                    : { mode: "OFF" },
                )
              }
            >
              <SelectTrigger className={CONTROL_SIZE} aria-label="renotify">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="OFF" className="text-[12px]">
                  Off (alert only on transitions)
                </SelectItem>
                <SelectItem value="EVERY" className="text-[12px]">
                  Re-alert at a regular interval
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          {renotify.mode === "EVERY" && (
            <RenotifyIntervalField
              intervalMinutes={renotify.intervalMinutes}
              onIntervalChange={(intervalMinutes) =>
                onRenotifyChange({ mode: "EVERY", intervalMinutes })
              }
            />
          )}
        </div>
      </div>
      {/* The name is how the alert identifies itself in the Slack message. */}
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
        {isProjectError ? (
          <p className="text-[12px] text-destructive">
            The workspace could not be loaded. Reload the page to try again.
          </p>
        ) : !integrationsHref || isSlackStatusLoading ? (
          <p className="text-[12px] text-muted-foreground">Loading workspace...</p>
        ) : (
          <SlackIntegrationLink
            href={integrationsHref}
            isConnected={isSlackConnected}
            teamName={slack?.teamName}
            channelName={slack?.channel?.name}
            className="max-w-md"
          />
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
