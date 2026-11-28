import type { Prisma } from "@traceroot/core";
import { getTemplate } from "@/features/detectors/templates";

type Detector = Prisma.DetectorGetPayload<{ include: { trigger: true } }>;

/** Demo visitors see published templates, never the working detector configuration. */
export function demoDetector(detector: Detector) {
  const template = getTemplate(detector.template);
  return {
    id: detector.id,
    projectId: detector.projectId,
    name: detector.name,
    template: template?.id ?? "blank",
    prompt: template?.prompt ?? "",
    outputSchema: template?.outputSchema ?? [],
    sampleRate: null,
    enabled: detector.enabled,
    enableRca: false,
    enableSignals: false,
    detectionModel: null,
    detectionProvider: null,
    detectionSource: null,
    trigger: null,
    createTime: detector.createTime,
    updateTime: detector.updateTime,
  };
}
