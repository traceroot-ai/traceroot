import type { Detector, UpdateDetectorInput } from "../hooks/use-detectors";

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
  conditions: Array<{ field: string; op: string; value: unknown }>;
}

export function detectorToFormValues(d: Detector): DetectorFormValues {
  return {
    name: d.name,
    prompt: d.prompt,
    sampleRate: d.sampleRate,
    enableRca: d.enableRca ?? true,
    detectionModel: d.detectionModel ?? "",
    detectionProvider: d.detectionProvider ?? "",
    detectionSource: d.detectionSource === "byok" ? "byok" : "system",
    conditions: d.trigger?.conditions ?? [],
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
): UpdateDetectorInput {
  const patch: UpdateDetectorInput = {};
  if (form.name !== loaded.name) patch.name = form.name;
  if (form.prompt !== loaded.prompt) patch.prompt = form.prompt;
  if (form.sampleRate !== loaded.sampleRate) {
    patch.sampleRate = form.sampleRate;
    // The sampling rate is the only control on this form that governs whether
    // the judge runs, so bind it to the enabled flag: 0% disables the detector
    // (instead of leaving an "enabled but never fires" state on the list page),
    // and any positive rate re-enables it.
    patch.enabled = form.sampleRate > 0;
  }
  if (form.enableRca !== loaded.enableRca) patch.enableRca = form.enableRca;
  if (!conditionsEqual(form.conditions, loaded.conditions)) {
    patch.triggerConditions = form.conditions;
  }
  const touchedModelTuple =
    form.detectionModel !== loaded.detectionModel ||
    form.detectionProvider !== loaded.detectionProvider ||
    form.detectionSource !== loaded.detectionSource;
  if (touchedModelTuple && form.detectionModel !== "" && form.detectionProvider !== "") {
    // The PATCH API validates detector model selections as an atomic tuple, so
    // any selector edit sends all three fields rather than mixing an omitted
    // provider/source with stale server state.
    patch.detectionModel = form.detectionModel;
    patch.detectionProvider = form.detectionProvider;
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
      ? next.conditions
      : form.conditions,
  };
}
