"use client";

import { useState, useEffect, useCallback } from "react";
import { Eye, X, Copy, Check, ArrowUp, ArrowDown } from "lucide-react";
import { useDetector, useUpdateDetector } from "../hooks/use-detectors";
import { useProject } from "@/features/projects/hooks";
import { TriggerEditor } from "./trigger-editor";
import type { TriggerCondition } from "./trigger-editor";
import { AgentModelLink } from "./agent-model-link";
import {
  ModelSelector,
  type ModelSelection,
} from "@/features/ai-assistant/components/model-selector";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface DetectorPanelProps {
  detectorId: string;
  projectId: string;
  workspaceId?: string;
  onClose: () => void;
  onNavigate?: (direction: "up" | "down") => void;
  canNavigateUp?: boolean;
  canNavigateDown?: boolean;
}

export function DetectorPanel({
  detectorId,
  projectId,
  workspaceId,
  onClose,
  onNavigate,
  canNavigateUp,
  canNavigateDown,
}: DetectorPanelProps) {
  const { data: detector } = useDetector(projectId, detectorId);
  const { data: project } = useProject(projectId);

  const [editName, setEditName] = useState("");
  const [editPrompt, setEditPrompt] = useState("");
  const [editSampleRate, setEditSampleRate] = useState(100);
  const [editModelSelection, setEditModelSelection] = useState<ModelSelection>({
    model: "",
    provider: "",
    source: "system",
    adapter: "",
  });
  const [editConditions, setEditConditions] = useState<TriggerCondition[]>([]);

  const populate = (d: typeof detector) => {
    if (!d) return;
    setEditName(d.name);
    setEditPrompt(d.prompt);
    setEditSampleRate(d.sampleRate);
    setEditModelSelection({
      model: d.detectionModel ?? "",
      provider: d.detectionProvider ?? "",
      source: d.detectionSource ?? "system",
      adapter: "",
    });
    setEditConditions((d.trigger?.conditions ?? []) as TriggerCondition[]);
  };

  useEffect(() => {
    populate(detector);
  }, [detector]);
  useEffect(() => {
    populate(detector);
  }, [detectorId]); // eslint-disable-line react-hooks/exhaustive-deps

  const [copied, setCopied] = useState(false);
  const copyId = useCallback(() => {
    void navigator.clipboard.writeText(detectorId);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [detectorId]);

  const updateMutation = useUpdateDetector(projectId, detectorId);

  const handleSave = () => {
    updateMutation.mutate(
      {
        name: editName,
        prompt: editPrompt,
        sampleRate: editSampleRate,
        triggerConditions: editConditions,
        detectionModel: editModelSelection.model || undefined,
        detectionProvider: editModelSelection.provider || undefined,
        detectionSource: editModelSelection.source === "byok" ? "byok" : "system",
      },
      { onSuccess: () => onClose() },
    );
  };

  return (
    <div className="animate-slide-in-right fixed bottom-0 right-0 top-0 z-50 flex w-[70%] flex-col border-l border-border bg-background shadow-xl">
      {/* Header — same style as trace viewer */}
      <div className="flex h-10 flex-shrink-0 items-center justify-between border-b border-border bg-muted/30 px-4">
        <div className="flex min-w-0 items-center gap-2">
          <Eye className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="text-[13px] font-medium">Detector</span>
          <span className="truncate text-[13px] text-muted-foreground">
            {detector?.name ?? detectorId}
          </span>
          <button
            type="button"
            onClick={copyId}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground/60 transition-colors hover:bg-muted hover:text-muted-foreground"
            title="Copy detector ID"
          >
            {detectorId}
            {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
          </button>
        </div>
        <div className="flex items-center gap-1">
          {onNavigate && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onNavigate("up")}
                disabled={!canNavigateUp}
                className="h-7 w-7 p-0"
                title="Previous detector"
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onNavigate("down")}
                disabled={!canNavigateDown}
                className="h-7 w-7 p-0"
                title="Next detector"
              >
                <ArrowDown className="h-4 w-4" />
              </Button>
            </>
          )}
          <Button variant="ghost" size="sm" onClick={onClose} className="h-7 w-7 p-0">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Scrollable form body */}
      <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
        {/* Name */}
        <div className="border border-border">
          <div className="border-b border-border bg-muted/50 px-3 py-1.5">
            <span className="text-[12px] font-medium text-muted-foreground">Name</span>
          </div>
          <div className="p-3">
            <Input
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              className="h-7 text-[13px]"
            />
          </div>
        </div>

        {/* Models */}
        <div className="border border-border">
          <div className="border-b border-border bg-muted/50 px-3 py-1.5">
            <span className="text-[12px] font-medium text-muted-foreground">Model</span>
          </div>
          <div className="divide-y divide-border">
            {/* Detector Model — per-detector, editable */}
            <div className="p-3">
              <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">Detector Model</p>
              <ModelSelector
                value={editModelSelection}
                onChange={setEditModelSelection}
                workspaceId={workspaceId}
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                Used to evaluate each trace for this detector.
              </p>
            </div>
            {/* Agent Model — project-scoped, click to configure in settings */}
            <div className="p-3">
              <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">Agent Model</p>
              <AgentModelLink
                projectId={projectId}
                rcaModel={project?.rca_model}
                workspaceId={workspaceId}
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                Used for deep analysis when findings are triggered. Shared across all detectors.
              </p>
            </div>
          </div>
        </div>

        {/* Prompt */}
        <div className="border border-border">
          <div className="border-b border-border bg-muted/50 px-3 py-1.5">
            <span className="text-[12px] font-medium text-muted-foreground">Prompt</span>
          </div>
          <div className="p-3">
            <textarea
              value={editPrompt}
              onChange={(e) => setEditPrompt(e.target.value)}
              rows={10}
              className="resize-vertical w-full border border-input bg-background px-3 py-2 font-mono text-[12px] leading-relaxed focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
        </div>

        {/* Filter */}
        <div className="border border-border">
          <TriggerEditor conditions={editConditions} onChange={setEditConditions} asCard />
        </div>

        {/* Sampling */}
        <div className="border border-border">
          <div className="border-b border-border bg-muted/50 px-3 py-1.5">
            <span className="text-[12px] font-medium text-muted-foreground">Sampling</span>
          </div>
          <div className="flex items-center gap-3 p-3">
            <input
              type="range"
              min={1}
              max={100}
              value={editSampleRate}
              onChange={(e) => setEditSampleRate(Number(e.target.value))}
              className="flex-1 cursor-pointer accent-foreground"
            />
            <span className="w-12 shrink-0 text-right text-[13px] tabular-nums text-muted-foreground">
              {editSampleRate}%
            </span>
          </div>
        </div>

        {/* Save / Cancel */}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={onClose} className="h-7 text-[12px]">
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={updateMutation.isPending}
            className="h-7 text-[12px]"
          >
            {updateMutation.isPending ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}
