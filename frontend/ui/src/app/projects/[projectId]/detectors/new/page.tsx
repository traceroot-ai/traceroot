"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ModelSelector,
  type ModelSelection,
} from "@/features/ai-assistant/components/model-selector";
import {
  DEFAULT_DETECTOR_SAMPLE_RATE,
  DETECTOR_TEMPLATES,
  buildTemplateDetectorInput,
} from "@/features/detectors/templates";
import { useCreateDetector } from "@/features/detectors/hooks/use-detectors";
import type { CreateDetectorInput } from "@/features/detectors/hooks/use-detectors";
import { TriggerEditor } from "@/features/detectors/components/trigger-editor";
import type { TriggerCondition } from "@/features/detectors/components/trigger-editor";
import { AgentModelLink } from "@/features/detectors/components/agent-model-link";
import { RcaToggle } from "@/features/detectors/components/rca-toggle";
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
  const [sampleRate, setSampleRate] = useState(DEFAULT_DETECTOR_SAMPLE_RATE);
  // Seeded from the template's defaultConditions so a user who picks
  // "Failure" and clicks Create gets the trigger filters the template
  // intends, not an unfiltered detector that fires on every trace.
  const [triggerConditions, setTriggerConditions] = useState<TriggerCondition[]>(
    INITIAL_TEMPLATE.defaultConditions as TriggerCondition[],
  );
  const [modelSelection, setModelSelection] = useState<ModelSelection>({
    model: "",
    provider: "",
    source: "system",
    adapter: "",
  });
  const [enableRca, setEnableRca] = useState(true);
  const [ruleConfigText, setRuleConfigText] = useState(
    INITIAL_TEMPLATE.ruleConfig ? JSON.stringify(INITIAL_TEMPLATE.ruleConfig, null, 2) : "",
  );
  const [ruleConfigError, setRuleConfigError] = useState<string | null>(null);

  const selectedTemplateDef = DETECTOR_TEMPLATES.find((t) => t.id === selectedTemplate);
  const isRuleType = selectedTemplateDef?.type === "rule";

  const handleTemplateChange = (templateId: string) => {
    const template = DETECTOR_TEMPLATES.find((t) => t.id === templateId);
    if (template) {
      setSelectedTemplate(templateId);
      setPrompt(template.prompt);
      setTriggerConditions(template.defaultConditions as TriggerCondition[]);
      setRuleConfigText(template.ruleConfig ? JSON.stringify(template.ruleConfig, null, 2) : "");
      setRuleConfigError(null);
      if (!nameEdited) setName(templateId === "blank" ? "" : template.label + " Detector");
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const template = DETECTOR_TEMPLATES.find((t) => t.id === selectedTemplate)!;

    let ruleConfig: CreateDetectorInput["ruleConfig"];
    if (isRuleType) {
      try {
        const parsed = JSON.parse(ruleConfigText);
        if (!parsed || !Array.isArray(parsed.conditions) || parsed.conditions.length === 0) {
          setRuleConfigError("ruleConfig must have a non-empty conditions array");
          return;
        }
        ruleConfig = parsed;
        setRuleConfigError(null);
      } catch {
        setRuleConfigError("Rule config must be valid JSON");
        return;
      }
    }

    const input: CreateDetectorInput = {
      ...buildTemplateDetectorInput(template),
      name,
      prompt: isRuleType ? "" : prompt,
      ruleConfig,
      sampleRate,
      enableRca,
      triggerConditions,
      ...(isRuleType
        ? {}
        : {
            detectionModel: modelSelection.model || undefined,
            detectionProvider: modelSelection.provider || undefined,
            detectionSource: modelSelection.source === "byok" ? "byok" : "system",
          }),
    };
    await createMutation.mutateAsync(input);
    router.push(`/projects/${projectId}/detectors`);
  };

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

            {/* Model — hidden for rule detectors (no LLM call, zero cost) */}
            {!isRuleType && (
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
                  <RcaToggle id="enable-rca" checked={enableRca} onCheckedChange={setEnableRca} />
                </div>
              </div>
            </div>
            )}

            {/* Prompt (LLM detectors) or Rule Config (rule detectors) */}
            {isRuleType ? (
              <div className="border border-border">
                <div className="border-b border-border bg-muted/50 px-3 py-1.5 flex items-center justify-between">
                  <span className="text-[12px] font-medium text-muted-foreground">Rule Config</span>
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                    deterministic · zero LLM cost
                  </span>
                </div>
                <div className="p-3">
                  <p className="mb-2 text-[11px] text-muted-foreground">
                    JSON object with a <code className="font-mono">conditions</code> array. Each
                    condition has a <code className="font-mono">field</code> (dot path into the span),
                    an <code className="font-mono">op</code> (
                    <code className="font-mono">
                      is_empty · is_missing · exists · equals · not_equals · contains · greater_than
                      · less_than
                    </code>
                    ), and an optional <code className="font-mono">value</code>. Set{" "}
                    <code className="font-mono">match</code> to{" "}
                    <code className="font-mono">"all"</code> to require every condition (AND); default
                    is <code className="font-mono">"any"</code> (OR).
                  </p>
                  <textarea
                    value={ruleConfigText}
                    onChange={(e) => {
                      setRuleConfigText(e.target.value);
                      setRuleConfigError(null);
                    }}
                    rows={12}
                    spellCheck={false}
                    placeholder='{"conditions": [{"field": "output", "op": "is_empty"}]}'
                    className="resize-vertical w-full border border-input bg-background px-3 py-2 font-mono text-[12px] leading-relaxed placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                  {ruleConfigError && (
                    <p className="mt-1 text-[11px] text-destructive">{ruleConfigError}</p>
                  )}
                </div>
              </div>
            ) : (
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
            )}

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
                disabled={
                  createMutation.isPending ||
                  !name.trim() ||
                  (!isRuleType && !prompt.trim()) ||
                  (isRuleType && !ruleConfigText.trim())
                }
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
