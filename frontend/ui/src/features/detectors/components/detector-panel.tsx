"use client";

import { useState, useEffect, useRef } from "react";
import { Eye } from "lucide-react";
import { useDetector, useUpdateDetector } from "../hooks/use-detectors";
import { DEFAULT_DETECTOR_SAMPLE_RATE } from "../templates";
import { useProject } from "@/features/projects/hooks";
import { TriggerEditor } from "./trigger-editor";
import type { TriggerCondition } from "./trigger-editor";
import { AgentModelLink } from "./agent-model-link";
import { RcaToggle } from "./rca-toggle";
import {
  detectorToFormValues,
  buildDetectorPatch,
  mergeDetectorIntoForm,
  type DetectorFormValues,
} from "../utils";
import {
  ModelSelector,
  type ModelSelection,
} from "@/features/ai-assistant/components/model-selector";
import { Button } from "@/components/ui/button";
import { PanelHeader } from "@/components/ui/panel-header";
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
  const [editSampleRate, setEditSampleRate] = useState(DEFAULT_DETECTOR_SAMPLE_RATE);
  const [editModelSelection, setEditModelSelection] = useState<ModelSelection>({
    model: "",
    provider: "",
    source: "system",
    adapter: "",
  });
  const [editConditions, setEditConditions] = useState<TriggerCondition[]>([]);
  const [editEnableRca, setEditEnableRca] = useState(true);

  const emptyForm: DetectorFormValues = {
    name: "",
    prompt: "",
    sampleRate: DEFAULT_DETECTOR_SAMPLE_RATE,
    enableRca: true,
    detectionModel: "",
    detectionProvider: "",
    detectionSource: "system",
    conditions: [],
  };

  const readForm = (): DetectorFormValues => ({
    name: editName,
    prompt: editPrompt,
    sampleRate: editSampleRate,
    enableRca: editEnableRca,
    detectionModel: editModelSelection.model,
    detectionProvider: editModelSelection.provider,
    detectionSource: editModelSelection.source === "byok" ? "byok" : "system",
    conditions: editConditions as DetectorFormValues["conditions"],
  });

  const applyForm = (values: DetectorFormValues) => {
    setEditName(values.name);
    setEditPrompt(values.prompt);
    setEditSampleRate(values.sampleRate);
    setEditEnableRca(values.enableRca);
    setEditModelSelection({
      model: values.detectionModel,
      provider: values.detectionProvider,
      source: values.detectionSource,
      adapter: "",
    });
    setEditConditions(values.conditions as TriggerCondition[]);
  };

  // Snapshot of the server state the form was last populated from, tagged
  // with the detector id it belongs to. Save diffs against it so only
  // user-changed fields are PATCHed, and refetches merge against it so
  // untouched fields update live (e.g. another tab toggling RCA) without
  // clobbering in-progress edits.
  const loadedRef = useRef<{ id: string; values: DetectorFormValues } | null>(null);

  // When the loaded detector matches the requested id, populate or merge.
  // Otherwise clear: the panel's Next/Prev arrow can change `detectorId`
  // before `useDetector` resolves the new fetch, and without this clear the
  // form would briefly hold the previous detector's values — a Save during
  // that gap would write them to the new detector.
  useEffect(() => {
    if (detector && detector.id === detectorId) {
      const next = detectorToFormValues(detector);
      const previous = loadedRef.current;
      if (previous && previous.id === detector.id) {
        // Skip when the payload is unchanged. This also covers StrictMode's
        // dev double-invoke: the re-run sees identical data while the form
        // state from the first run hasn't committed yet, and merging then
        // would read empty initial values and blank the form.
        if (JSON.stringify(next) !== JSON.stringify(previous.values)) {
          applyForm(mergeDetectorIntoForm(previous.values, next, readForm()));
          loadedRef.current = { id: detector.id, values: next };
        }
      } else {
        // First load, or navigation to a different detector (possibly served
        // instantly from the query cache): populate fresh. Merging across
        // detectors would leak one detector's edits into another.
        applyForm(next);
        loadedRef.current = { id: detector.id, values: next };
      }
    } else {
      applyForm(emptyForm);
      loadedRef.current = null;
    }
  }, [detectorId, detector]); // eslint-disable-line react-hooks/exhaustive-deps

  const updateMutation = useUpdateDetector(projectId, detectorId);

  const handleSave = () => {
    // Guard against saving while the new detector's data is still loading.
    // Edit state would be the previous detector's, but the mutation targets
    // the current detectorId; without this guard, stale values would
    // overwrite the new detector. The Save button is also disabled for the
    // detector check — this is defense-in-depth. The snapshot check below
    // handles the one-frame window before the populate effect has run.
    if (!detector || detector.id !== detectorId) return;
    const loaded = loadedRef.current;
    if (!loaded || loaded.id !== detectorId) return;
    const patch = buildDetectorPatch(loaded.values, readForm());
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    updateMutation.mutate(patch, { onSuccess: () => onClose() });
  };

  return (
    <div className="animate-slide-in-right fixed bottom-0 right-0 top-0 z-50 flex w-[70%] flex-col border-l border-border bg-background shadow-xl">
      {/* Header — shared with trace viewer via PanelHeader */}
      <PanelHeader
        icon={<Eye className="h-4 w-4 shrink-0 text-muted-foreground" />}
        label="Detector"
        name={detector?.name}
        id={detectorId}
        copyTitle="Copy detector ID"
        nav={
          onNavigate
            ? {
                onNavigate,
                canUp: canNavigateUp ?? false,
                canDown: canNavigateDown ?? false,
                upTitle: "Previous detector",
                downTitle: "Next detector",
              }
            : undefined
        }
        close={{ onClose }}
      />

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
              <RcaToggle
                id="edit-enable-rca"
                checked={editEnableRca}
                onCheckedChange={setEditEnableRca}
              />
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
              min={0}
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
            disabled={updateMutation.isPending || !detector || detector.id !== detectorId}
            className="h-7 text-[12px]"
          >
            {updateMutation.isPending ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}
