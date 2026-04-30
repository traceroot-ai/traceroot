"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ModelSelector,
  type ModelSelection,
} from "@/features/ai-assistant/components/model-selector";
import { DETECTOR_TEMPLATES } from "@/features/detectors/templates";
import { useCreateDetector } from "@/features/detectors/hooks/use-detectors";
import type { CreateDetectorInput } from "@/features/detectors/hooks/use-detectors";
import { TriggerEditor } from "@/features/detectors/components/trigger-editor";
import type { TriggerCondition } from "@/features/detectors/components/trigger-editor";
import { AgentModelLink } from "@/features/detectors/components/agent-model-link";
import { useProject } from "@/features/projects/hooks";
import { ProjectBreadcrumb } from "@/features/projects/components";

export default function NewDetectorPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.projectId as string;

  const { data: project } = useProject(projectId);
  const createMutation = useCreateDetector(projectId);

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

  const handleTemplateChange = (templateId: string) => {
    const template = DETECTOR_TEMPLATES.find((t) => t.id === templateId);
    if (template) {
      setSelectedTemplate(templateId);
      setPrompt(template.prompt);
      if (!nameEdited) setName(templateId === "blank" ? "" : template.label + " Detector");
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const template = DETECTOR_TEMPLATES.find((t) => t.id === selectedTemplate)!;
    const input: CreateDetectorInput = {
      name,
      template: selectedTemplate,
      prompt,
      outputSchema: template.outputSchema,
      sampleRate,
      triggerConditions,
      detectionModel: modelSelection.model || undefined,
      detectionProvider: modelSelection.provider || undefined,
      detectionAdapter: modelSelection.adapter || undefined,
    };
    await createMutation.mutateAsync(input);
    router.push(`/projects/${projectId}/detectors`);
  };

  const selectedTemplateDef = DETECTOR_TEMPLATES.find((t) => t.id === selectedTemplate);

  return (
    <div className="relative flex h-full text-[13px]">
      <ProjectBreadcrumb projectId={projectId} />

      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Page header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h1 className="text-[13px] font-medium">New Detector</h1>
        </div>

        {/* Scrollable form */}
        <div className="flex-1 overflow-y-auto">
          <form onSubmit={handleSubmit} className="flex flex-col gap-3 p-4">
            {/* Template */}
            <div className="border border-border">
              <div className="border-b border-border bg-muted/50 px-3 py-1.5">
                <span className="text-[12px] font-medium text-muted-foreground">Template</span>
              </div>
              <div className="p-3">
                <div className="flex flex-wrap gap-1.5">
                  {DETECTOR_TEMPLATES.map((t) => (
                    <Button
                      key={t.id}
                      type="button"
                      size="sm"
                      variant={selectedTemplate === t.id ? "default" : "outline"}
                      onClick={() => handleTemplateChange(t.id)}
                      className="h-7 text-[12px]"
                    >
                      {t.label}
                    </Button>
                  ))}
                </div>
                <p className="mt-2 min-h-[1rem] text-[12px] text-muted-foreground">
                  {selectedTemplateDef?.description ?? ""}
                </p>
              </div>
            </div>

            {/* Name */}
            <div className="border border-border">
              <div className="border-b border-border bg-muted/50 px-3 py-1.5">
                <span className="text-[12px] font-medium text-muted-foreground">Name</span>
              </div>
              <div className="p-3">
                <Input
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setNameEdited(true);
                  }}
                  placeholder="e.g. error detector"
                  className="h-7 text-[13px]"
                  required
                />
              </div>
            </div>

            {/* Model */}
            <div className="border border-border">
              <div className="border-b border-border bg-muted/50 px-3 py-1.5">
                <span className="text-[12px] font-medium text-muted-foreground">Model</span>
              </div>
              <div className="divide-y divide-border">
                {/* Detector Model — per-detector, editable */}
                <div className="p-3">
                  <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">
                    Detector Model
                  </p>
                  <ModelSelector
                    value={modelSelection}
                    onChange={setModelSelection}
                    workspaceId={project?.workspace_id}
                  />
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Used to evaluate each trace for this detector.
                  </p>
                </div>
                {/* Agent Model — project-scoped, click to configure in settings */}
                <div className="p-3">
                  <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">
                    Agent Model
                  </p>
                  <AgentModelLink
                    projectId={projectId}
                    rcaModel={project?.rca_model}
                    workspaceId={project?.workspace_id}
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
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  rows={10}
                  placeholder="Describe what to detect..."
                  className="resize-vertical w-full border border-input bg-background px-3 py-2 font-mono text-[12px] leading-relaxed placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                  required
                />
              </div>
            </div>

            {/* Filter */}
            <div className="border border-border">
              <TriggerEditor
                conditions={triggerConditions}
                onChange={setTriggerConditions}
                asCard
              />
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
                  value={sampleRate}
                  onChange={(e) => setSampleRate(Number(e.target.value))}
                  className="flex-1 cursor-pointer accent-foreground"
                />
                <span className="w-12 shrink-0 text-right text-[13px] tabular-nums text-muted-foreground">
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
                onClick={() => router.push(`/projects/${projectId}/detectors`)}
                className="h-7 text-[12px]"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                className="h-7 text-[12px]"
                disabled={createMutation.isPending || !name || !prompt}
              >
                {createMutation.isPending ? "Creating..." : "Create Detector"}
              </Button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
