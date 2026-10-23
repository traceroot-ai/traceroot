// The hover text comes from the widget registry snapshot, on the field each
// alert measure reads, so the alert form and the widget builder cannot drift.
// The two unique-id measures read from `traces`; see SOURCE_BY_ALERT_MEASURE in
// frontend/packages/core/src/alerts.ts for why that is the same number.

import registrySnapshot from "@/features/dashboards/widget-registry.generated.json";
import { measureDoc, type WidgetSchemaField } from "@/features/dashboards/types";
import type { MeasureDoc } from "@/lib/measure-doc";
import { ALERT_MEASURES_BY_VIEW, getAlertMeasureSource, type AlertView } from "./rule-model";

const REGISTRY = registrySnapshot as Record<string, { fields: Record<string, WidgetSchemaField> }>;

export function getMeasureDoc(view: AlertView, measureId: string): MeasureDoc | undefined {
  if (view !== "SPANS") return undefined;
  const source = getAlertMeasureSource(measureId);
  const fields = source ? REGISTRY[source.view]?.fields : undefined;
  if (!source || !fields || !Object.hasOwn(fields, source.field)) return undefined;
  return measureDoc(fields[source.field]);
}

// Exported so a test fails when a measure is added and the dropdown would show
// it unexplained.
export function undocumentedMeasureIds(view: AlertView): readonly string[] {
  return ALERT_MEASURES_BY_VIEW[view]
    .filter((m) => getMeasureDoc(view, m.id) === undefined)
    .map((m) => m.id);
}
