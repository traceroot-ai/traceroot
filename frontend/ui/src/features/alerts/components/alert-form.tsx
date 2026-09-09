"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { DEFAULT_ALERT_WINDOW, type AlertWindow } from "@traceroot/core";
import {
  DEFAULT_ALERT_RENOTIFY,
  DEFAULT_ALERT_VIEW,
  getMeasure,
  isCompleteAlertFilter,
  type AlertAggregation,
  type AlertFilter,
  type AlertOperator,
  type AlertRenotify,
  type AlertView,
} from "../rule-model";
import { buildPreviewSpec, nextAggregationForMeasure, parseThreshold } from "../preview";
import { isAtAlertCapacity } from "../capacity";
import { useAlertCapacity, useCreateAlert, useUpdateAlert } from "../hooks/use-alerts";
import { AlertPreview } from "./alert-preview";
import { AlertsCapacityNotice } from "./alerts-capacity-notice";
import { ConditionSection } from "./condition-section";
import { MetricSection } from "./metric-section";
import { NotificationsSection } from "./notifications-section";

interface AlertFormProps {
  projectId: string;
  /** Present in edit mode; the rule the submit PATCHes. */
  alertId?: string;
  initialDraft?: AlertDraft;
}

// The draft rule the form edits. `view` is carried but never rendered: only
// SPANS exists. Threshold stays the raw input string, parsed on use.
export interface AlertDraft {
  view: AlertView;
  measureId: string;
  aggregation: AlertAggregation;
  filters: AlertFilter[];
  operator: AlertOperator;
  threshold: string;
  window: AlertWindow;
  renotify: AlertRenotify;
  name: string;
}

const INITIAL_DRAFT: AlertDraft = {
  view: DEFAULT_ALERT_VIEW,
  measureId: "count",
  aggregation: "count",
  filters: [],
  operator: ">",
  threshold: "",
  window: DEFAULT_ALERT_WINDOW,
  renotify: DEFAULT_ALERT_RENOTIFY,
  name: "",
};

/**
 * The alert form: configuration column on the left, live preview on the right,
 * following the widget builder's split. Serves both create and edit; the edit
 * route seeds `initialDraft` from the loaded rule, so the first render already
 * previews the right metric.
 */
export function AlertForm({ projectId, alertId, initialDraft }: AlertFormProps) {
  const router = useRouter();
  const [draft, setDraft] = useState<AlertDraft>(initialDraft ?? INITIAL_DRAFT);
  const createAlert = useCreateAlert(projectId);
  const updateAlert = useUpdateAlert(projectId);
  const { data: capacity } = useAlertCapacity(projectId);
  const isEdit = alertId !== undefined;
  // Only the create path spends a slot; a full project must still be able to
  // save edits to the rules already in it.
  const isBlockedByCapacity = !isEdit && isAtAlertCapacity(capacity);

  const handleMeasureChange = (measureId: string) => {
    const measure = getMeasure(draft.view, measureId);
    if (!measure) return;
    setDraft((d) => ({
      ...d,
      measureId,
      aggregation: nextAggregationForMeasure(d.view, measure, d.aggregation),
    }));
  };

  // Parsed, not coerced: Number("") is 0, and 0 is a threshold the schema
  // accepts, so a blank input would silently save a rule that fires above zero.
  const threshold = parseThreshold(draft.threshold);
  const isNameValid = draft.name.trim() !== "";
  // The same predicate the preview panel reports unavailable through, and the
  // one the API gates on.
  const isDraftEvaluable =
    buildPreviewSpec(draft.view, draft.measureId, draft.aggregation, draft.filters) !== null;
  const isPending = createAlert.isPending || updateAlert.isPending;
  const submitError = createAlert.error ?? updateAlert.error;
  const canSubmit =
    threshold !== null && isNameValid && isDraftEvaluable && !isPending && !isBlockedByCapacity;

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!canSubmit || threshold === null) return;
    const input = {
      name: draft.name,
      view: draft.view,
      measure: draft.measureId,
      aggregation: draft.aggregation,
      // Half-filled rows are dropped rather than sent: the schema takes a
      // metadata row with no key, but the engine needs one, so it would
      // store cleanly and then fail on every evaluation.
      filters: draft.filters.filter(isCompleteAlertFilter).map((f) => {
        // Key trimmed exactly as the preview trims it, or the chart and the
        // saved rule would filter on different keys.
        const key = f.key?.trim() || undefined;
        return key === undefined
          ? { field: f.field, op: f.op, value: f.value }
          : { field: f.field, key, op: f.op, value: f.value };
      }),
      window: draft.window,
      thresholdOperator: draft.operator,
      threshold,
      renotify: draft.renotify,
    };
    const options = { onSuccess: () => router.push(`/projects/${projectId}/alerts`) };
    // The whole rule goes on every edit, not a diff: the route's change
    // detection compares values, so unchanged fields stay unchanged.
    if (alertId !== undefined) updateAlert.mutate({ alertId, input }, options);
    else createAlert.mutate(input, options);
  };

  return (
    <div className="flex flex-col gap-4 p-4 lg:h-full lg:flex-row lg:overflow-hidden">
      <form
        onSubmit={handleSubmit}
        className="flex flex-col lg:w-1/3 lg:min-w-[340px] lg:max-w-[420px]"
      >
        {/* On wide viewports the sections scroll inside this wrapper so the
            action bar stays in reach. `min-h-0` is what lets a flex child
            shrink to scroll. */}
        <div className="flex flex-col gap-3 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
          <MetricSection
            projectId={projectId}
            view={draft.view}
            measureId={draft.measureId}
            aggregation={draft.aggregation}
            filters={draft.filters}
            onMeasureChange={handleMeasureChange}
            onAggregationChange={(aggregation) => setDraft((d) => ({ ...d, aggregation }))}
            onFiltersChange={(filters) => setDraft((d) => ({ ...d, filters }))}
          />

          <ConditionSection
            operator={draft.operator}
            threshold={draft.threshold}
            window={draft.window}
            renotify={draft.renotify}
            onOperatorChange={(operator) => setDraft((d) => ({ ...d, operator }))}
            onThresholdChange={(threshold) => setDraft((d) => ({ ...d, threshold }))}
            onWindowChange={(window) => setDraft((d) => ({ ...d, window }))}
            onRenotifyChange={(renotify) => setDraft((d) => ({ ...d, renotify }))}
          />

          <NotificationsSection
            projectId={projectId}
            name={draft.name}
            onNameChange={(name) => setDraft((d) => ({ ...d, name }))}
          />
        </div>

        <div className="shrink-0 bg-background pt-3">
          <div className="flex items-center justify-end gap-2">
            {!isEdit && (
              <AlertsCapacityNotice capacity={capacity} className="mr-auto text-muted-foreground" />
            )}
            {submitError && (
              <p className="mr-auto text-[12px] text-destructive">{submitError.message}</p>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => router.push(`/projects/${projectId}/alerts`)}
              className="h-7 text-[12px]"
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" className="h-7 text-[12px]" disabled={!canSubmit}>
              {isEdit ? "Save Alert" : "Create Alert"}
            </Button>
          </div>
        </div>
      </form>

      <AlertPreview
        projectId={projectId}
        view={draft.view}
        measureId={draft.measureId}
        aggregation={draft.aggregation}
        filters={draft.filters}
        operator={draft.operator}
        threshold={draft.threshold}
        window={draft.window}
      />
    </div>
  );
}
