"use client";

import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ModelSelector,
  type ModelSelection,
} from "@/features/ai-assistant/components/model-selector";
import { DETECTOR_TEMPLATES } from "../templates";
import type { CreateDetectorInput } from "../hooks/use-detectors";
import { TriggerEditor } from "./trigger-editor";
import type { TriggerCondition } from "./trigger-editor";

interface CreateDetectorSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (input: CreateDetectorInput) => Promise<void>;
  isSubmitting?: boolean;
  workspaceId?: string;
}

export function CreateDetectorSheet({
  open,
  onOpenChange,
  onSubmit,
  isSubmitting,
  workspaceId,
}: CreateDetectorSheetProps) {
  const INITIAL_TEMPLATE = DETECTOR_TEMPLATES[0];

  const [selectedTemplate, setSelectedTemplate] = useState(INITIAL_TEMPLATE.id);
  const [name, setName] = useState(INITIAL_TEMPLATE.label + " Detector");
  const [nameEdited, setNameEdited] = useState(false);
  const [prompt, setPrompt] = useState(INITIAL_TEMPLATE.prompt);
  const [sampleRate, setSampleRate] = useState(100);
  const [triggerConditions, setTriggerConditions] = useState<TriggerCondition[]>([]);
  const [modelSelection, setModelSelection] = useState<ModelSelection>({
    model: "",
    provider: "",
    source: "system",
    adapter: "",
  });

  // Reset all form state when the dialog opens
  useEffect(() => {
    if (open) {
      setSelectedTemplate(INITIAL_TEMPLATE.id);
      setName(INITIAL_TEMPLATE.label + " Detector");
      setNameEdited(false);
      setPrompt(INITIAL_TEMPLATE.prompt);
      setSampleRate(100);
      setTriggerConditions([]);
      setModelSelection({ model: "", provider: "", source: "system", adapter: "" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleTemplateChange = (templateId: string) => {
    const template = DETECTOR_TEMPLATES.find((t) => t.id === templateId);
    if (template) {
      setSelectedTemplate(templateId);
      setPrompt(template.prompt);
      // Blank template gets no default name; others auto-fill unless user edited
      if (!nameEdited) setName(templateId === "blank" ? "" : template.label + " Detector");
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const template = DETECTOR_TEMPLATES.find((t) => t.id === selectedTemplate)!;
    await onSubmit({
      name,
      template: selectedTemplate,
      prompt,
      outputSchema: template.outputSchema,
      sampleRate,
      triggerConditions,
      detectionModel: modelSelection.model || undefined,
      detectionProvider: modelSelection.provider || undefined,
      detectionAdapter: modelSelection.adapter || undefined,
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[600px]">
        <DialogHeader>
          <DialogTitle className="text-[13px] font-semibold">New Detector</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="mt-2 space-y-5">
          {/* Template picker */}
          <div>
            <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Template
            </p>
            <div className="grid grid-cols-4 gap-1.5">
              {DETECTOR_TEMPLATES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => handleTemplateChange(t.id)}
                  className={`border px-2 py-2 text-center text-[11px] transition-colors ${
                    selectedTemplate === t.id
                      ? "border-foreground bg-foreground text-background"
                      : "border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            {selectedTemplate !== "blank" && (
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                {DETECTOR_TEMPLATES.find((t) => t.id === selectedTemplate)?.description}
              </p>
            )}
          </div>

          {/* Name */}
          <div>
            <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Name
            </label>
            <Input
              className="h-8 text-[12px]"
              placeholder="e.g. error detector"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameEdited(true);
              }}
              required
            />
          </div>

          {/* Prompt — model selector above label, left-aligned */}
          <div>
            <div className="mb-1">
              <p className="mb-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Model
              </p>
              <ModelSelector
                value={modelSelection}
                onChange={setModelSelection}
                workspaceId={workspaceId}
              />
            </div>
            <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Prompt
            </label>
            <textarea
              className="w-full border border-input bg-background px-3 py-2 font-mono text-[11px] leading-relaxed placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              style={{ minHeight: 160, resize: "vertical" }}
              placeholder="Describe what to detect..."
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              required
            />
          </div>

          {/* Filter (trigger conditions) */}
          <TriggerEditor conditions={triggerConditions} onChange={setTriggerConditions} />

          {/* Sampling */}
          <div className="flex items-center justify-between gap-3">
            <span className="shrink-0 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Sampling
            </span>
            <div className="flex flex-1 items-center gap-2">
              <input
                type="range"
                min={1}
                max={100}
                value={sampleRate}
                onChange={(e) => setSampleRate(Number(e.target.value))}
                className="flex-1 cursor-pointer accent-foreground"
              />
              <span className="w-8 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
                {sampleRate}%
              </span>
            </div>
          </div>

          {/* Footer */}
          <div className="flex justify-end gap-2 pt-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 text-[12px]"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              className="h-7 text-[12px]"
              disabled={isSubmitting || !name || !prompt}
            >
              {isSubmitting ? "Creating..." : "Create Detector"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
