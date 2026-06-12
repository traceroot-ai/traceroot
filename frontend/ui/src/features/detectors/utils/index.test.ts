import { describe, expect, it } from "vitest";
import {
  detectorToFormValues,
  buildDetectorPatch,
  mergeDetectorIntoForm,
  type DetectorFormValues,
} from "./index";
import type { Detector } from "../hooks/use-detectors";

const baseDetector: Detector = {
  id: "det-1",
  projectId: "proj-1",
  name: "Latency spikes",
  template: "custom",
  prompt: "Find slow spans",
  outputSchema: [],
  sampleRate: 50,
  enableRca: true,
  detectionModel: "model-a",
  detectionProvider: "provider-a",
  detectionSource: "system",
  createTime: "2026-06-01T00:00:00Z",
  updateTime: "2026-06-01T00:00:00Z",
  trigger: { conditions: [{ field: "duration", op: "gt", value: 1000 }] },
};

const baseForm: DetectorFormValues = detectorToFormValues(baseDetector);

describe("detectorToFormValues", () => {
  it("maps detector fields onto form values", () => {
    expect(baseForm).toEqual({
      name: "Latency spikes",
      prompt: "Find slow spans",
      sampleRate: 50,
      enableRca: true,
      detectionModel: "model-a",
      detectionProvider: "provider-a",
      detectionSource: "system",
      conditions: [{ field: "duration", op: "gt", value: 1000 }],
    });
  });

  it("defaults null model/provider/source and missing trigger", () => {
    const values = detectorToFormValues({
      ...baseDetector,
      detectionModel: null,
      detectionProvider: null,
      detectionSource: null,
      trigger: null,
    });
    expect(values.detectionModel).toBe("");
    expect(values.detectionProvider).toBe("");
    expect(values.detectionSource).toBe("system");
    expect(values.conditions).toEqual([]);
  });
});

describe("buildDetectorPatch", () => {
  it("returns an empty patch when nothing changed", () => {
    expect(buildDetectorPatch(baseForm, { ...baseForm })).toEqual({});
  });

  it("includes only the toggled field", () => {
    const patch = buildDetectorPatch(baseForm, { ...baseForm, enableRca: false });
    expect(patch).toEqual({ enableRca: false });
  });

  it("includes only the edited prompt, leaving enableRca untouched", () => {
    const patch = buildDetectorPatch(baseForm, { ...baseForm, prompt: "New prompt" });
    expect(patch).toEqual({ prompt: "New prompt" });
  });

  it("omits a model cleared to empty (omission means leave unchanged)", () => {
    const patch = buildDetectorPatch(baseForm, { ...baseForm, detectionModel: "" });
    expect(patch).toEqual({});
  });

  it("includes a changed detection model, provider, and source", () => {
    const patch = buildDetectorPatch(baseForm, {
      ...baseForm,
      detectionModel: "model-b",
      detectionProvider: "provider-b",
      detectionSource: "byok",
    });
    expect(patch).toEqual({
      detectionModel: "model-b",
      detectionProvider: "provider-b",
      detectionSource: "byok",
    });
  });

  it("sends changed trigger conditions as triggerConditions", () => {
    const conditions = [{ field: "status", op: "eq", value: "error" }];
    const patch = buildDetectorPatch(baseForm, { ...baseForm, conditions });
    expect(patch).toEqual({ triggerConditions: conditions });
  });
});

describe("mergeDetectorIntoForm", () => {
  const next: DetectorFormValues = { ...baseForm, enableRca: false, name: "Renamed" };

  it("takes all server values when the form is untouched", () => {
    expect(mergeDetectorIntoForm(baseForm, next, { ...baseForm })).toEqual(next);
  });

  it("keeps the user's prompt edit while applying the server's toggle", () => {
    const form = { ...baseForm, prompt: "user draft" };
    const merged = mergeDetectorIntoForm(baseForm, next, form);
    expect(merged.prompt).toBe("user draft");
    expect(merged.enableRca).toBe(false);
    expect(merged.name).toBe("Renamed");
  });

  it("keeps the user's edited conditions while applying server values elsewhere", () => {
    const userConditions = [{ field: "status", op: "eq", value: "error" }];
    const form = { ...baseForm, conditions: userConditions };
    const merged = mergeDetectorIntoForm(baseForm, next, form);
    expect(merged.conditions).toEqual(userConditions);
    expect(merged.enableRca).toBe(false);
  });

  it("takes the server's conditions when the form left them untouched", () => {
    const serverConditions = [{ field: "latency", op: "gt", value: 5000 }];
    const serverNext = { ...baseForm, conditions: serverConditions };
    const merged = mergeDetectorIntoForm(baseForm, serverNext, { ...baseForm });
    expect(merged.conditions).toEqual(serverConditions);
  });

  it("keeps all three detection fields when the user touched the model selector", () => {
    const form = { ...baseForm, detectionModel: "model-b" };
    const serverNext = {
      ...baseForm,
      detectionModel: "model-c",
      detectionProvider: "provider-c",
      detectionSource: "byok" as const,
    };
    const merged = mergeDetectorIntoForm(baseForm, serverNext, form);
    expect(merged.detectionModel).toBe("model-b");
    expect(merged.detectionProvider).toBe("provider-a");
    expect(merged.detectionSource).toBe("system");
  });
});
