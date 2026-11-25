import { DETECTOR_SYSTEM_DEFAULT_MODEL_ID } from "@traceroot/core/llm-providers";
import { getTemplate } from "@/features/detectors/templates";
import { captureServerEvent } from "@/lib/posthog-server";

/** The settings of a newly created detector. */
export interface CreatedDetector {
  projectId: string;
  workspaceId: string;
  template: string;
  prompt: string;
  detectionSource: "system" | "byok" | null;
  detectionModel: string | null;
  triggerConditions: unknown;
  sampleRate: number;
  enabled: boolean;
  enableRca: boolean;
  enableSignals: boolean;
}

/** Sends `detector_created`; both creation paths call it after a new detector is saved. */
export function captureDetectorCreated(
  actorUserId: string,
  transport: "ui" | "public-api" | "agent",
  detector: CreatedDetector,
): void {
  // Only built-in template ids are sent.
  const template = getTemplate(detector.template);
  const source = detector.detectionSource ?? "system";
  captureServerEvent(actorUserId, "detector_created", {
    project_id: detector.projectId,
    workspace_id: detector.workspaceId,
    transport,
    template: template?.id ?? "other",
    // No source means system models.
    detection_source: source,
    // Unset, or the system default picked explicitly: the same model runs.
    default_model:
      source === "system" &&
      (!detector.detectionModel || detector.detectionModel === DETECTOR_SYSTEM_DEFAULT_MODEL_ID),
    prompt_customized: !template || detector.prompt.trim() !== template.prompt.trim(),
    trigger_count: Array.isArray(detector.triggerConditions)
      ? detector.triggerConditions.length
      : 0,
    sample_rate: detector.sampleRate,
    enabled: detector.enabled,
    rca_enabled: detector.enableRca,
    signals_enabled: detector.enableSignals,
  });
}
