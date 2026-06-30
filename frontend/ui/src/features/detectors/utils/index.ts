import type { Detector, UpdateDetectorInput } from "../hooks/use-detectors";

type EditableTriggerCondition = { field: string; op: string; value: unknown };

/**
 * The detector edit panel's form as plain data, so dirty-checking and merge
 * logic stay pure and unit-testable. Empty string means "unset" for the
 * detection model/provider; conditions mirror the trigger editor's rows.
 */
export interface DetectorFormValues {
  name: string;
  prompt: string;
  sampleRate: number;
  enableRca: boolean;
  detectionModel: string;
  detectionProvider: string;
  detectionSource: "system" | "byok";
  conditions: EditableTriggerCondition[];
  unsupportedTriggerConditions: boolean;
}

const LEGACY_TRIGGER_OPERATORS = new Map([
  ["eq", "="],
  ["ne", "!="],
  ["neq", "!="],
]);

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isEditableEnvironmentValue(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function normalizeEditableTriggerConditions(
  conditions: unknown,
  hasTrigger: boolean,
): {
  conditions: EditableTriggerCondition[];
  unsupported: boolean;
} {
  if (conditions == null) {
    return { conditions: [], unsupported: hasTrigger };
  }
  if (!Array.isArray(conditions)) {
    return { conditions: [], unsupported: true };
  }

  const normalized: EditableTriggerCondition[] = [];
  let unsupported = false;
  for (const condition of conditions) {
    if (condition === null || typeof condition !== "object" || Array.isArray(condition)) {
      unsupported = true;
      continue;
    }

    const record = condition as Record<string, unknown>;
    if (!hasOwn(record, "field") || !hasOwn(record, "op") || !hasOwn(record, "value")) {
      unsupported = true;
      continue;
    }
    const field = record.field;
    const rawOp = record.op;
    const value = record.value;
    const op = typeof rawOp === "string" ? (LEGACY_TRIGGER_OPERATORS.get(rawOp) ?? rawOp) : rawOp;
    if (
      field !== "environment" ||
      (op !== "=" && op !== "!=") ||
      !isEditableEnvironmentValue(value)
    ) {
      unsupported = true;
      continue;
    }
    normalized.push({ field, op, value });
  }

  return { conditions: normalized, unsupported };
}

export function detectorToFormValues(d: Detector): DetectorFormValues {
  const trigger = normalizeEditableTriggerConditions(d.trigger?.conditions, d.trigger != null);

  return {
    name: d.name,
    prompt: d.prompt,
    sampleRate: d.sampleRate,
    enableRca: d.enableRca ?? true,
    detectionModel: d.detectionModel ?? "",
    detectionProvider: d.detectionProvider ?? "",
    detectionSource: d.detectionSource === "byok" ? "byok" : "system",
    conditions: trigger.conditions,
    unsupportedTriggerConditions: trigger.unsupported,
  };
}

function conditionsEqual(
  a: DetectorFormValues["conditions"],
  b: DetectorFormValues["conditions"],
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Diff the form against the last-loaded server snapshot and return only the
 * fields the user actually changed. Saving a partial body means a stale tab
 * can no longer silently revert fields it never touched (the PATCH route
 * leaves omitted fields unchanged). A model/provider cleared to "" is omitted
 * rather than sent, matching the previous save behavior.
 */
export function buildDetectorPatch(
  loaded: DetectorFormValues,
  form: DetectorFormValues,
  options: { forceTriggerConditions?: boolean } = {},
): UpdateDetectorInput {
  const patch: UpdateDetectorInput = {};
  if (form.name !== loaded.name) patch.name = form.name;
  if (form.prompt !== loaded.prompt) patch.prompt = form.prompt;
  if (form.sampleRate !== loaded.sampleRate) patch.sampleRate = form.sampleRate;
  if (form.enableRca !== loaded.enableRca) patch.enableRca = form.enableRca;
  if (options.forceTriggerConditions || !conditionsEqual(form.conditions, loaded.conditions)) {
    patch.triggerConditions = form.conditions;
  }
  if (form.detectionModel !== loaded.detectionModel && form.detectionModel !== "") {
    patch.detectionModel = form.detectionModel;
  }
  if (form.detectionProvider !== loaded.detectionProvider && form.detectionProvider !== "") {
    patch.detectionProvider = form.detectionProvider;
  }
  if (form.detectionSource !== loaded.detectionSource) {
    patch.detectionSource = form.detectionSource;
  }
  return patch;
}

/**
 * Fold freshly fetched detector values into the form without clobbering
 * in-progress edits: a field the user hasn't touched (form === previous
 * snapshot) takes the server's new value; a touched field keeps the user's.
 * The three detection fields move as a group because the model selector sets
 * them together — merging them independently could pair a model with a
 * provider nobody chose. Known tradeoff: a field edited back to its original
 * value is indistinguishable from untouched, so a concurrent remote change
 * to that field will be adopted rather than preserved as-was.
 */
export function mergeDetectorIntoForm(
  previous: DetectorFormValues,
  next: DetectorFormValues,
  form: DetectorFormValues,
): DetectorFormValues {
  const touchedSelector =
    form.detectionModel !== previous.detectionModel ||
    form.detectionProvider !== previous.detectionProvider ||
    form.detectionSource !== previous.detectionSource;
  return {
    name: form.name === previous.name ? next.name : form.name,
    prompt: form.prompt === previous.prompt ? next.prompt : form.prompt,
    sampleRate: form.sampleRate === previous.sampleRate ? next.sampleRate : form.sampleRate,
    enableRca: form.enableRca === previous.enableRca ? next.enableRca : form.enableRca,
    detectionModel: touchedSelector ? form.detectionModel : next.detectionModel,
    detectionProvider: touchedSelector ? form.detectionProvider : next.detectionProvider,
    detectionSource: touchedSelector ? form.detectionSource : next.detectionSource,
    conditions: conditionsEqual(form.conditions, previous.conditions)
      ? conditionsEqual(form.conditions, next.conditions)
        ? form.conditions
        : next.conditions
      : form.conditions,
    unsupportedTriggerConditions: next.unsupportedTriggerConditions,
  };
}
