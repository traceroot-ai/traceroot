"use client";

import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { ArrowUpRight, Clock, Mail } from "lucide-react";
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
import { getAvailableLLMModels, updateProject } from "@/lib/api";
import { useProject } from "@/features/projects/hooks";
import { useSlackStatus } from "@/features/integrations/hooks/useSlackIntegration";
import {
  ModelSelector,
  type ModelSelection,
} from "@/features/ai-assistant/components/model-selector";
import {
  flattenAvailableModels,
  reconcileModelSelection,
} from "@/features/ai-assistant/lib/resolve-model";
import { AlertChannelsEditor } from "@/features/detectors/components/alert-channels-editor";

interface DetectorsTabProps {
  projectId: string;
}

export function DetectorsTab({ projectId }: DetectorsTabProps) {
  const queryClient = useQueryClient();
  const { data: project, isLoading } = useProject(projectId);
  const { data: slack } = useSlackStatus(project?.workspace_id);
  const { data: llmModelData } = useQuery({
    queryKey: ["llm-models", project?.workspace_id],
    queryFn: () => getAvailableLLMModels(project!.workspace_id!),
    enabled: !!project?.workspace_id,
  });

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

  const savedAgentModelSelection: ModelSelection = {
    model: project?.rca_model ?? "",
    provider: project?.rca_provider ?? "",
    source: (project?.rca_source as "system" | "byok") ?? "system",
    adapter: "",
  };
  const savedAgentModelBaseline = reconcileModelSelection(
    savedAgentModelSelection,
    flattenAvailableModels(llmModelData),
  );
  const isModelDirty =
    agentModelSelection.model !== savedAgentModelBaseline.model ||
    agentModelSelection.provider !== savedAgentModelBaseline.provider ||
    agentModelSelection.source !== savedAgentModelBaseline.source;
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
      <div>
        <h2 className="text-lg font-semibold">Detectors</h2>
        <p className="text-[13px] text-muted-foreground">Settings shared across all detectors.</p>
      </div>

      <div className="border">
        <div className="border-b border-border bg-muted/30 px-4 py-2">
          <h3 className="text-[13px] font-medium">Agent Model</h3>
        </div>
        <div className="px-4 py-3">
          <ModelSelector
            value={agentModelSelection}
            onChange={setAgentModelSelection}
            workspaceId={project?.workspace_id}
          />
          <p className="mt-2 text-[12px] text-muted-foreground">
            Used for deep analysis when a finding is triggered. Shared across all detectors.
          </p>
          <Button
            size="sm"
            className="mt-3 h-7 text-[12px]"
            onClick={() => modelMutation.mutate(agentModelSelection)}
            disabled={!canSave || modelMutation.isPending || !isModelDirty}
          >
            {modelMutation.isPending ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>

      <div className="border">
        <div className="border-b border-border bg-muted/30 px-4 py-2">
          <h3 className="text-[13px] font-medium">Notifications</h3>
        </div>

        {/* Email subsection */}
        <div className="px-4 py-3">
          <div className="flex items-center gap-1.5">
            <Mail className="h-3.5 w-3.5 text-muted-foreground" />
            <h4 className="text-[12px] font-medium">Email</h4>
          </div>
          <div className="mt-2">
            <AlertChannelsEditor emailAddresses={emailAddresses} onChange={setEmailAddresses} />
          </div>
          <p className="mt-2 text-[12px] text-muted-foreground">
            Sent once per trace, after Root Cause Analysis completes.
          </p>
          <Button
            size="sm"
            className="mt-3 h-7 text-[12px]"
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
            <h4 className="text-[12px] font-medium">Slack</h4>
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
              className="mt-3 inline-flex h-7 items-center gap-1 rounded-md bg-primary px-3 text-[12px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              {slack?.connected ? "Manage" : "Connect"}
              <ArrowUpRight className="h-3 w-3" />
            </Link>
          )}
        </div>

        {/* Alert window subsection */}
        <div className="border-t border-border px-4 py-3">
          <div className="flex items-center gap-1.5">
            <Clock className="h-3.5 w-3.5 text-muted-foreground" />
            <h4 className="text-[12px] font-medium">Alert window</h4>
          </div>
          <div className="mt-2">
            <Select value={alertWindow} onValueChange={(v) => setAlertWindow(v as AlertWindow)}>
              <SelectTrigger className="h-7 w-40 text-[12px]" aria-label="window">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(ALERT_WINDOWS) as AlertWindow[]).map((w) => (
                  <SelectItem key={w} value={w} className="text-[12px]">
                    {`Every ${w}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <p className="mt-2 text-[12px] text-muted-foreground">
            Detector findings in each window are batched into one digest.
          </p>
          <Button
            size="sm"
            className="mt-3 h-7 text-[12px]"
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
