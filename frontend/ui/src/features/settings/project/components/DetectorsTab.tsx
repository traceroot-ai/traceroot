"use client";

import { useState, useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { Clock, Mail } from "lucide-react";
import { FaSlack } from "react-icons/fa";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ALERT_WINDOWS, DEFAULT_ALERT_WINDOW, type AlertWindow } from "@traceroot/core";
import { updateProject } from "@/lib/api";
import { useProject } from "@/features/projects/hooks";
import { useSlackStatus } from "@/features/integrations/hooks/useSlackIntegration";
import {
  ModelSelector,
  type ModelSelection,
} from "@/features/ai-assistant/components/model-selector";
import { AlertChannelsEditor } from "@/features/detectors/components/alert-channels-editor";

interface DetectorsTabProps {
  projectId: string;
}

export function DetectorsTab({ projectId }: DetectorsTabProps) {
  const queryClient = useQueryClient();
  const { data: project, isLoading } = useProject(projectId);
  const { data: slack } = useSlackStatus(project?.workspace_id);

  const [agentModelSelection, setAgentModelSelection] = useState<ModelSelection>({
    model: "",
    provider: "",
    source: "system",
    adapter: "",
  });
  const [emailAddresses, setEmailAddresses] = useState<string[]>([]);
  const [alertWindow, setAlertWindow] = useState<AlertWindow>(DEFAULT_ALERT_WINDOW);

  useEffect(() => {
    if (project) {
      setAgentModelSelection((prev) => ({
        ...prev,
        model: project.rca_model ?? "",
        provider: project.rca_provider ?? "",
        source: (project.rca_source as "system" | "byok") ?? "system",
      }));
      setEmailAddresses(project.alert_emails ?? []);
      setAlertWindow((project.alert_window as AlertWindow) ?? DEFAULT_ALERT_WINDOW);
    }
  }, [project]);

  const modelMutation = useMutation({
    mutationFn: (selection: ModelSelection) => {
      if (!project) throw new Error("Project not found");
      return updateProject(project.workspace_id!, projectId, {
        rca_model: selection.model || null,
        rca_provider: selection.provider || null,
        rca_source: selection.source === "byok" ? "byok" : "system",
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["project", projectId] });
    },
  });

  const emailsMutation = useMutation({
    mutationFn: (emails: string[]) => {
      if (!project) throw new Error("Project not found");
      return updateProject(project.workspace_id!, projectId, {
        alert_emails: emails.map((e) => e.trim()).filter((e) => e.length > 0),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["project", projectId] });
    },
  });

  const windowMutation = useMutation({
    mutationFn: (w: AlertWindow) => {
      if (!project) throw new Error("Project not found");
      return updateProject(project.workspace_id!, projectId, { alert_window: w });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["project", projectId] });
    },
  });

  const isModelDirty =
    agentModelSelection.model !== (project?.rca_model ?? "") ||
    agentModelSelection.provider !== (project?.rca_provider ?? "") ||
    agentModelSelection.source !== (project?.rca_source ?? "system");
  // A source-less Terra may still resolve through a legacy BYOK provider.
  const isLegacyTerra =
    project?.rca_model === "gpt-5.6-terra" && !project.rca_source && !project.rca_provider;
  const savedEmails = project?.alert_emails ?? [];
  const isEmailsDirty =
    emailAddresses.length !== savedEmails.length ||
    emailAddresses.some((e, i) => e !== savedEmails[i]);
  const isWindowDirty =
    alertWindow !== ((project?.alert_window as AlertWindow) ?? DEFAULT_ALERT_WINDOW);
  // Save is only meaningful once the project query has resolved.
  const canSave = !!project;

  if (isLoading) {
    return <div className="text-[13px] text-muted-foreground">Loading...</div>;
  }

  return (
    <div className="space-y-4">
      <div className="-mx-4 -mt-4 flex h-11 items-center gap-3 border-b border-border px-4">
        <h2 className="text-[15px] font-medium">Detectors</h2>
        <p className="text-[13px] text-muted-foreground">Settings shared across all detectors.</p>
      </div>

      <div className="border">
        <div className="flex h-9 items-center border-b border-border px-4">
          <h3 className="text-[13px] font-medium">Agent model</h3>
        </div>
        <div className="px-4 py-3">
          <div className="max-w-xs">
            <ModelSelector
              value={agentModelSelection}
              onChange={setAgentModelSelection}
              workspaceId={project?.workspace_id}
              allowModelOnlyMatch={!isLegacyTerra}
              field
            />
          </div>
          <p className="mt-2 text-[12px] text-muted-foreground">
            Used for deep analysis when a finding is triggered. Shared across all detectors.
          </p>
          <Button
            size="sm"
            className="mt-3 min-w-[5.5rem]"
            onClick={() => modelMutation.mutate(agentModelSelection)}
            disabled={!canSave || modelMutation.isPending || !isModelDirty}
          >
            {modelMutation.isPending ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>

      <div className="border">
        <div className="flex h-9 items-center border-b border-border px-4">
          <h3 className="text-[13px] font-medium">Notifications</h3>
        </div>

        {/* Email subsection */}
        <div className="px-4 py-3">
          <div className="flex items-center gap-1.5">
            <Mail className="h-3.5 w-3.5 text-muted-foreground" />
            <h4 className="text-[13px] font-medium">Email</h4>
          </div>
          <div className="mt-2">
            <AlertChannelsEditor emailAddresses={emailAddresses} onChange={setEmailAddresses} />
          </div>
          <p className="mt-2 text-[12px] text-muted-foreground">
            New and reopened signals are batched into one email per alert window.
          </p>
          <Button
            size="sm"
            className="mt-3 min-w-[5.5rem]"
            onClick={() => emailsMutation.mutate(emailAddresses)}
            disabled={!canSave || emailsMutation.isPending || !isEmailsDirty}
          >
            {emailsMutation.isPending ? "Saving..." : "Save"}
          </Button>
        </div>

        {/* Slack subsection — read-only mirror, configured at workspace settings */}
        <div className="border-t border-border px-4 py-3">
          <div className="flex items-center gap-1.5">
            <FaSlack className="h-3.5 w-3.5 text-muted-foreground" />
            <h4 className="text-[13px] font-medium">Slack</h4>
          </div>
          <p className="mt-2 text-[12px] text-muted-foreground">
            {slack?.connected ? (
              <>
                Connected to <span className="font-medium text-foreground">{slack.teamName}</span>
                {slack.channel ? <> · #{slack.channel.name}</> : <> · No channel selected</>}
              </>
            ) : (
              <>Not connected.</>
            )}
          </p>
          {project?.workspace_id && (
            <Link
              href={`/workspaces/${project.workspace_id}/settings/integrations`}
              className="mt-3 inline-flex h-7 min-w-[5.5rem] items-center justify-center gap-1 rounded-[2px] bg-primary px-3 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              {slack?.connected ? "Manage" : "Connect"}
            </Link>
          )}
        </div>

        {/* Alert window subsection */}
        <div className="border-t border-border px-4 py-3">
          <div className="flex items-center gap-1.5">
            <Clock className="h-3.5 w-3.5 text-muted-foreground" />
            <h4 className="text-[13px] font-medium">Alert window</h4>
          </div>
          <div className="mt-2 max-w-xs">
            <Select value={alertWindow} onValueChange={(v) => setAlertWindow(v as AlertWindow)}>
              <SelectTrigger aria-label="window">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(ALERT_WINDOWS) as AlertWindow[]).map((w) => (
                  <SelectItem key={w} value={w}>
                    {`Every ${w}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <p className="mt-2 text-[12px] text-muted-foreground">
            New and reopened signals in each window are sent as one notification.
          </p>
          <Button
            size="sm"
            className="mt-3 min-w-[5.5rem]"
            aria-label="Save alert window"
            onClick={() => windowMutation.mutate(alertWindow)}
            disabled={!canSave || windowMutation.isPending || !isWindowDirty}
          >
            {windowMutation.isPending ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}
