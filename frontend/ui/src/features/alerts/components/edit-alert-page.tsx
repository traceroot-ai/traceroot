"use client";

import { DEFAULT_ALERT_SEVERITY } from "@traceroot/core";
import { LoadingState } from "@/components/ui/loading-state";
import { ProjectBreadcrumb } from "@/features/projects/components";
import { PageBackHeader } from "@/features/dashboards/components/PageBackHeader";
import { AlertForm, type AlertDraft } from "./alert-form";
import { isAlertGone, useAlert, type AlertRecord } from "../hooks/use-alerts";

interface EditAlertPageProps {
  projectId: string;
  alertId: string;
}

function toDraft(alert: AlertRecord): AlertDraft {
  return {
    view: alert.view,
    measureId: alert.measure,
    aggregation: alert.aggregation,
    filters: alert.filters,
    operator: alert.thresholdOperator,
    threshold: String(alert.threshold),
    window: alert.window,
    renotify: alert.renotify,
    name: alert.name,
  };
}

/**
 * The Edit Alert page: the same form the New Alert page renders, seeded from
 * the stored rule. Render is gated on the load so the preview never queries a
 * metric the user is not editing.
 */
export function EditAlertPage({ projectId, alertId }: EditAlertPageProps) {
  const listHref = `/projects/${projectId}/alerts`;
  const { data: alert, isPending, error } = useAlert(projectId, alertId);

  return (
    <div className="relative flex h-full text-[13px]">
      <ProjectBreadcrumb projectId={projectId} />

      <div className="flex flex-1 flex-col overflow-hidden">
        <PageBackHeader
          backHref={listHref}
          backLabel="Alerts"
          title={alert ? `Edit Alert - ${alert.name}` : "Edit Alert"}
        />

        {alert && alert.severity !== DEFAULT_ALERT_SEVERITY && (
          <p className="shrink-0 border-b border-border px-4 py-2 text-[12px] text-muted-foreground">
            Changing the metric or threshold clears this alert&apos;s current state; it re-evaluates
            within a minute.
          </p>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto lg:overflow-hidden">
          {isPending ? (
            <div className="flex h-64 items-center justify-center">
              <LoadingState label="Loading alert..." />
            </div>
          ) : error ? (
            <div className="flex h-64 flex-col items-center justify-center gap-3">
              <p className="text-[13px] text-destructive">
                {isAlertGone(error) ? "Alert not found" : "Alert could not be edited"}
              </p>
              <p className="max-w-md text-center text-[12px] text-muted-foreground">
                {isAlertGone(error)
                  ? "This alert doesn't exist or has been deleted."
                  : error.message}
              </p>
            </div>
          ) : (
            <AlertForm
              key={alertId}
              projectId={projectId}
              alertId={alertId}
              initialDraft={toDraft(alert)}
            />
          )}
        </div>
      </div>
    </div>
  );
}
