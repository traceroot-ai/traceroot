import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DETECTOR_SAMPLE_RATE,
  DETECTOR_QUICK_ADD_TEMPLATES,
  buildTemplateDetectorInput,
  getTemplate,
} from "./templates";

describe("DEFAULT_DETECTOR_SAMPLE_RATE", () => {
  it("matches the Prisma column default, which cannot import the constant", () => {
    const schemaPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../../packages/core/prisma/schema.prisma",
    );
    const match = readFileSync(schemaPath, "utf8").match(/sampleRate\s+Int\s+@default\((\d+)\)/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBe(DEFAULT_DETECTOR_SAMPLE_RATE);
  });
});

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
      sampleRate: 25,
      enableRca: true,
    });
  });

  it("derives the name from the template label", () => {
    const safety = getTemplate("safety")!;
    expect(buildTemplateDetectorInput(safety).name).toBe("Safety Detector");
  });
});
