import type { Prisma } from "@traceroot/core";
import { DEFAULT_DETECTOR_SAMPLE_RATE, getTemplate } from "@/features/detectors/templates";

type Detector = Prisma.DetectorGetPayload<{ include: { trigger: true } }>;

/** Demo visitors see published templates, never the working detector configuration. */
export function demoDetector(detector: Detector) {
  const template = getTemplate(detector.template);
  return {
    id: detector.id,
    projectId: detector.projectId,
    name: detector.name,
    template: detector.template,
    prompt: template?.prompt ?? "",
    outputSchema: template?.outputSchema ?? [],
    sampleRate: DEFAULT_DETECTOR_SAMPLE_RATE,
    enabled: detector.enabled,
    enableRca: detector.enableRca,
    enableSignals: detector.enableSignals,
    detectionModel: null,
    detectionProvider: null,
    detectionSource: null,
    trigger: null,
    createTime: detector.createTime,
    updateTime: detector.updateTime,
  };
}
