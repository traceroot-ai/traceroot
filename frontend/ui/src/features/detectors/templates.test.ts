import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DETECTOR_SAMPLE_RATE,
  DETECTOR_TEMPLATES,
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

describe("buildTemplateDetectorInput", () => {
  it("builds the defaults the new-detector form starts from", () => {
    const failure = getTemplate("failure")!;
    expect(buildTemplateDetectorInput(failure)).toEqual({
      name: "Failure detector",
      template: "failure",
      prompt: failure.prompt,
      outputSchema: failure.outputSchema,
      triggerConditions: failure.defaultConditions,
      sampleRate: 25,
      enableRca: true,
      detectionSource: "system",
    });
  });

  it("derives the name from the template label", () => {
    const safety = getTemplate("safety")!;
    expect(buildTemplateDetectorInput(safety).name).toBe("Safety detector");
  });
});

describe("coding agent templates", () => {
  const ids = ["coding-agent-task", "coding-agent-failure", "coding-agent-context-debt"];

  it("ships the three templates, each with a prompt and a typed output schema", () => {
    for (const id of ids) {
      const t = getTemplate(id)!;
      expect(t, id).toBeDefined();
      expect(t.prompt.length).toBeGreaterThan(200);
      expect(t.outputSchema.length).toBeGreaterThan(0);
      for (const f of t.outputSchema) expect(["string", "number", "boolean"]).toContain(f.type);
    }
    expect(new Set(DETECTOR_TEMPLATES.map((t) => t.id)).size).toBe(DETECTOR_TEMPLATES.length);
  });

  it("judges every turn, and every prompt names the summary prefix it reads back by", () => {
    const prefixes: Record<string, string> = {
      "coding-agent-task": "task=",
      "coding-agent-failure": "failure=",
      "coding-agent-context-debt": "context_debt=",
    };
    for (const id of ids) {
      const t = getTemplate(id)!;
      expect(t.sampleRate).toBe(100);
      expect(t.prompt).toContain(prefixes[id]);
      expect(t.prompt).toMatch(/identified=false/);
      expect(t.prompt).toMatch(/secrets/);
    }
  });

  it("keeps the always-firing labeler out of Signals, the other two in", () => {
    expect(getTemplate("coding-agent-task")!.enableSignals).toBe(false);
    expect(getTemplate("coding-agent-failure")!.enableSignals).toBeUndefined();
    expect(getTemplate("coding-agent-context-debt")!.enableSignals).toBeUndefined();
  });

  it("feeds the new-detector form the template's own defaults", () => {
    const input = buildTemplateDetectorInput(getTemplate("coding-agent-task")!);
    expect(input).toMatchObject({ sampleRate: 100, enableRca: false, enableSignals: false });
  });
});
