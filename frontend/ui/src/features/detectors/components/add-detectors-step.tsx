"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  QUICK_ADD_TEMPLATES,
  buildTemplateDetectorInput,
  getTemplate,
} from "@/features/detectors/templates";
import { useCreateDetector } from "@/features/detectors/hooks/use-detectors";

interface AddDetectorsStepProps {
  projectId: string;
  projectName: string;
  /** Called when the step is finished: number of detectors created (0 on skip). */
  onDone: (createdCount: number) => void;
}

/**
 * Skippable multi-select template picker shown right after a project is
 * created. Creates one detector per selected template through the same
 * endpoint as the new-detector form; the project is never affected.
 */
export function AddDetectorsStep({ projectId, projectName, onDone }: AddDetectorsStepProps) {
  const [selected, setSelected] = useState<string[]>([]);
  const [lastToggledId, setLastToggledId] = useState(QUICK_ADD_TEMPLATES[0].id);
  const [failedLabels, setFailedLabels] = useState<string[]>([]);
  const [createdCount, setCreatedCount] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const createMutation = useCreateDetector(projectId);

  const toggle = (templateId: string) => {
    setLastToggledId(templateId);
    setSelected((prev) =>
      prev.includes(templateId) ? prev.filter((id) => id !== templateId) : [...prev, templateId],
    );
  };

  const handleContinue = async () => {
    if (selected.length === 0) {
      onDone(createdCount);
      return;
    }
    setSubmitting(true);
    setFailedLabels([]);
    const results = await Promise.allSettled(
      selected.map((id) =>
        createMutation.mutateAsync(buildTemplateDetectorInput(getTemplate(id)!)),
      ),
    );
    const failed = selected.filter((_, i) => results[i].status === "rejected");
    const total = createdCount + selected.length - failed.length;
    if (failed.length === 0) {
      onDone(total);
      return;
    }
    setCreatedCount(total);
    setSelected(failed);
    setFailedLabels(failed.map((id) => getTemplate(id)?.label ?? id));
    setSubmitting(false);
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-muted-foreground">
        Detectors automatically scan traces in{" "}
        <span className="font-medium text-foreground">{projectName}</span> for issues. Select any to
        start with.
      </p>
      <div className="border border-border">
        <div className="border-b border-border bg-muted/50 px-3 py-1.5">
          <span className="text-[12px] font-medium text-muted-foreground">Templates</span>
        </div>
        <div className="p-3">
          <div className="flex flex-wrap gap-1.5">
            {QUICK_ADD_TEMPLATES.map((t) => (
              <Button
                key={t.id}
                type="button"
                size="sm"
                variant={selected.includes(t.id) ? "default" : "outline"}
                onClick={() => toggle(t.id)}
                disabled={submitting}
                className="h-7 text-[12px]"
              >
                {t.label}
              </Button>
            ))}
          </div>
          <p className="mt-2 min-h-[1rem] text-[12px] text-muted-foreground">
            {getTemplate(lastToggledId)?.description ?? ""}
          </p>
        </div>
      </div>
      {failedLabels.length > 0 && (
        <p className="text-[12px] text-destructive">
          Couldn&apos;t create: {failedLabels.join(", ")}. Try again or skip.
        </p>
      )}
      <div className="flex items-center justify-between pt-1">
        <button
          type="button"
          onClick={() => onDone(createdCount)}
          disabled={submitting}
          className="text-[12px] text-muted-foreground underline-offset-2 hover:underline disabled:opacity-50"
        >
          Skip for now
        </button>
        <Button
          type="button"
          size="sm"
          className="h-7 text-[12px]"
          onClick={handleContinue}
          disabled={submitting}
        >
          {submitting ? "Adding..." : "Continue"}
        </Button>
      </div>
    </div>
  );
}
