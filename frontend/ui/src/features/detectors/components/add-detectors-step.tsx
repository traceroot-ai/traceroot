"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  DETECTOR_QUICK_ADD_TEMPLATES,
  buildTemplateDetectorInput,
  getTemplate,
} from "@/features/detectors/templates";
import { useCreateDetector } from "@/features/detectors/hooks/use-detectors";

interface AddDetectorsStepProps {
  projectId: string;
  projectName: string;
  workspaceId?: string;
  /** Called when the step is finished, whether detectors were created or it was skipped. */
  onDone: () => void;
}

/**
 * Skippable multi-select template picker shown right after a project is
 * created. Creates one detector per selected template through the same
 * endpoint as the new-detector form; the project is never affected.
 */
export function AddDetectorsStep({
  projectId,
  projectName,
  workspaceId,
  onDone,
}: AddDetectorsStepProps) {
  const [selected, setSelected] = useState<string[]>([]);
  const [previewedId, setPreviewedId] = useState(DETECTOR_QUICK_ADD_TEMPLATES[0].id);
  const [failedLabels, setFailedLabels] = useState<string[]>([]);
  const [failureDetails, setFailureDetails] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const createMutation = useCreateDetector(projectId);
  const modelProviderSettingsLink = workspaceId ? (
    <Link
      href={`/workspaces/${workspaceId}/settings/model-providers`}
      className="font-medium underline underline-offset-2"
    >
      Configure BYOK providers
    </Link>
  ) : null;

  const toggle = (templateId: string) => {
    setSelected((prev) =>
      prev.includes(templateId) ? prev.filter((id) => id !== templateId) : [...prev, templateId],
    );
  };

  const handleContinue = async () => {
    if (selected.length === 0) {
      onDone();
      return;
    }
    setSubmitting(true);
    setFailedLabels([]);
    setFailureDetails(null);
    const results = await Promise.allSettled(
      selected.map((id) =>
        createMutation.mutateAsync(buildTemplateDetectorInput(getTemplate(id)!)),
      ),
    );
    const failed = selected.filter((_, i) => results[i].status === "rejected");
    if (failed.length === 0) {
      onDone();
      return;
    }
    setSelected(failed);
    setFailedLabels(failed.map((id) => getTemplate(id)?.label ?? id));
    const firstFailure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    setFailureDetails(
      firstFailure?.reason instanceof Error
        ? firstFailure.reason.message
        : "Detector creation failed",
    );
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
            {DETECTOR_QUICK_ADD_TEMPLATES.map((t) => (
              <Button
                key={t.id}
                type="button"
                size="sm"
                variant={selected.includes(t.id) ? "default" : "outline"}
                onClick={() => toggle(t.id)}
                onMouseEnter={() => setPreviewedId(t.id)}
                onFocus={() => setPreviewedId(t.id)}
                disabled={submitting}
                className="h-7 text-[12px]"
              >
                {t.label}
              </Button>
            ))}
          </div>
          <p className="mt-2 min-h-[1rem] text-[12px] text-muted-foreground">
            {getTemplate(previewedId)?.description ?? ""}
          </p>
        </div>
      </div>
      {failedLabels.length > 0 && (
        <div role="alert" className="space-y-1 text-[12px] text-destructive">
          <p>Couldn&apos;t create: {failedLabels.join(", ")}. Try again or skip.</p>
          {failureDetails && <p>{failureDetails}</p>}
          {failureDetails && /model|provider|byok|system/i.test(failureDetails) && (
            <p>
              No supported detector model is configured yet. Self-hosted deployments need an admin
              to set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in the server environment. To use a
              workspace-scoped key instead, add a BYOK provider. {modelProviderSettingsLink}
            </p>
          )}
        </div>
      )}
      <div className="flex items-center justify-between pt-1">
        <button
          type="button"
          onClick={onDone}
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
