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
  trigger: { conditions: [{ field: "environment", op: "eq", value: "production" }] },
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
      conditions: [{ field: "environment", op: "=", value: "production" }],
      unsupportedTriggerConditions: false,
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
    expect(values.unsupportedTriggerConditions).toBe(false);
  });

  it("quarantines unsupported legacy trigger rows instead of hydrating them into the editor", () => {
    const values = detectorToFormValues({
      ...baseDetector,
      trigger: { conditions: [{ field: "duration", op: "gt", value: 1000 }] },
    });

    expect(values.conditions).toEqual([]);
    expect(values.unsupportedTriggerConditions).toBe(true);
  });

  it("keeps editable conditions while flagging unsupported rows in mixed trigger arrays", () => {
    const values = detectorToFormValues({
      ...baseDetector,
      trigger: {
        conditions: [
          { field: "environment", op: "eq", value: "production" },
          { field: "duration", op: "gt", value: 1000 },
          { field: "environment", op: "!=", value: "staging" },
        ],
      },
    });

    expect(values.conditions).toEqual([
      { field: "environment", op: "=", value: "production" },
      { field: "environment", op: "!=", value: "staging" },
    ]);
    expect(values.unsupportedTriggerConditions).toBe(true);
  });

  it("quarantines malformed trigger containers instead of hydrating them into the editor", () => {
    const values = detectorToFormValues({
      ...baseDetector,
      trigger: { conditions: { field: "environment", op: "=", value: "production" } },
    });

    expect(values.conditions).toEqual([]);
    expect(values.unsupportedTriggerConditions).toBe(true);
  });

  it("flags a trigger row with null conditions as unsupported", () => {
    const values = detectorToFormValues({
      ...baseDetector,
      trigger: { conditions: null },
    });

    expect(values.conditions).toEqual([]);
    expect(values.unsupportedTriggerConditions).toBe(true);
  });

  it("keeps nullable environment filters editable", () => {
    const values = detectorToFormValues({
      ...baseDetector,
      trigger: { conditions: [{ field: "environment", op: "=", value: null }] },
    });

    expect(values.conditions).toEqual([{ field: "environment", op: "=", value: null }]);
    expect(values.unsupportedTriggerConditions).toBe(false);
  });

  it("quarantines trigger rows whose editable fields are inherited properties", () => {
    const condition = Object.create({
      field: "environment",
      op: "=",
      value: "production",
    }) as { field: string; op: string; value: string };
    const values = detectorToFormValues({
      ...baseDetector,
      trigger: { conditions: [condition] },
    });

    expect(values.conditions).toEqual([]);
    expect(values.unsupportedTriggerConditions).toBe(true);
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
    const conditions = [{ field: "environment", op: "!=", value: "staging" }];
    const patch = buildDetectorPatch(baseForm, { ...baseForm, conditions });
    expect(patch).toEqual({ triggerConditions: conditions });
  });

  it("can force a trigger replacement when unsupported stored rows were edited away", () => {
    const loaded = { ...baseForm, unsupportedTriggerConditions: true };
    const patch = buildDetectorPatch(loaded, { ...loaded }, { forceTriggerConditions: true });
    expect(patch).toEqual({ triggerConditions: loaded.conditions });
  });

  it("disables the detector when the sample rate drops to 0%", () => {
    const patch = buildDetectorPatch(baseForm, { ...baseForm, sampleRate: 0 });
    expect(patch).toEqual({ sampleRate: 0, enabled: false });
  });

  it("enables the detector when the sample rate is positive", () => {
    const patch = buildDetectorPatch(baseForm, { ...baseForm, sampleRate: 10 });
    expect(patch).toEqual({ sampleRate: 10, enabled: true });
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
    const userConditions = [{ field: "environment", op: "!=", value: "staging" }];
    const form = { ...baseForm, conditions: userConditions };
    const merged = mergeDetectorIntoForm(baseForm, next, form);
    expect(merged.conditions).toEqual(userConditions);
    expect(merged.enableRca).toBe(false);
  });

  it("takes the server's conditions when the form left them untouched", () => {
    const serverConditions = [{ field: "environment", op: "=", value: "staging" }];
    const serverNext = { ...baseForm, conditions: serverConditions };
    const merged = mergeDetectorIntoForm(baseForm, serverNext, { ...baseForm });
    expect(merged.conditions).toEqual(serverConditions);
  });

  it("preserves the form condition reference when a refetch returns the same rows", () => {
    const formConditions = [{ field: "environment", op: "=", value: "production" }];
    const serverConditions = [{ field: "environment", op: "=", value: "production" }];
    const merged = mergeDetectorIntoForm(
      baseForm,
      { ...next, conditions: serverConditions },
      { ...baseForm, conditions: formConditions },
    );

    expect(merged.conditions).toBe(formConditions);
  });

  it("keeps hidden legacy trigger warnings from the latest server snapshot when conditions are edited", () => {
    const userConditions = [{ field: "environment", op: "!=", value: "staging" }];
    const serverNext = { ...baseForm, unsupportedTriggerConditions: true };
    const form = { ...baseForm, conditions: userConditions, unsupportedTriggerConditions: false };

    const merged = mergeDetectorIntoForm(baseForm, serverNext, form);

    expect(merged.conditions).toEqual(userConditions);
    expect(merged.unsupportedTriggerConditions).toBe(true);
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
