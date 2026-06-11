import { describe, expect, it } from "vitest";
import { DETECTOR_QUICK_ADD_TEMPLATES, buildTemplateDetectorInput, getTemplate } from "./templates";

describe("DETECTOR_QUICK_ADD_TEMPLATES", () => {
  it("excludes the blank template and keeps the rest in order", () => {
    expect(DETECTOR_QUICK_ADD_TEMPLATES.map((t) => t.id)).toEqual([
      "failure",
      "hallucination",
      "logic",
      "task",
      "safety",
    ]);
  });
});

describe("buildTemplateDetectorInput", () => {
  it("builds the defaults the new-detector form starts from", () => {
    const failure = getTemplate("failure")!;
    expect(buildTemplateDetectorInput(failure)).toEqual({
      name: "Failure Detector",
      template: "failure",
      prompt: failure.prompt,
      outputSchema: failure.outputSchema,
      triggerConditions: failure.defaultConditions,
      sampleRate: 100,
      enableRca: true,
      detectionSource: "system",
    });
  });

  it("derives the name from the template label", () => {
    const safety = getTemplate("safety")!;
    expect(buildTemplateDetectorInput(safety).name).toBe("Safety Detector");
  });
});
