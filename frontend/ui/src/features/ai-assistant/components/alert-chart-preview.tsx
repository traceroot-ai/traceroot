"use client";

/**
 * The chart an alert card is for, drawn the way the alert form previews it.
 *
 * Everything inside the frame is the alerts feature's own code — the same
 * spec builder, the same preview query at the rule's own bucket, the same
 * chart with the threshold drawn across it — so the card shows what the alert
 * page will show rather than a second rendering that drifts from it. Only
 * the frame and the visibility gate belong to the panel (see
 * WidgetChartPreview, whose discipline this mirrors).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { ALERT_WINDOWS } from "@traceroot/core";
import { AlertPreviewChart, MAX_PREVIEW_BUCKETS } from "@/features/alerts/components/alert-preview";
import { buildPreviewSpec } from "@/features/alerts/preview";
import { useWidgetPreview } from "@/features/dashboards/hooks/use-widget-data";
import { makeRange } from "@/features/dashboards/range-presets";
import type { AlertChart } from "../lib/resource-card";
import { CHART_TILE_ASPECT, SNAPSHOT_QUERY_OPTIONS } from "./preview-constants";

function Note({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <div className="p-2 text-[11px] text-muted-foreground" title={title}>
      {children}
    </div>
  );
}

function Plot({ chart }: { chart: AlertChart }) {
  const spec = useMemo(
    () => buildPreviewSpec(chart.view, chart.measure, chart.aggregation, chart.filters),
    [chart.view, chart.measure, chart.aggregation, chart.filters],
  );
  // Frozen at first visibility, like a widget card's: the card model's own
  // snapshot of the site's selection names this window in the footer.
  const range = useMemo(() => makeRange(chart.range.id), [chart.range.id]);
  const bucketMs = ALERT_WINDOWS[chart.window];
  // Past the cap the server picks the grain instead, which beats a 422.
  const fitsBucket = range.end.getTime() - range.start.getTime() <= bucketMs * MAX_PREVIEW_BUCKETS;
  const preview = useWidgetPreview(
    chart.projectId,
    spec,
    range,
    fitsBucket ? bucketMs / 1000 : undefined,
    SNAPSHOT_QUERY_OPTIONS,
  );

  // A combination the engine cannot run has no chart; the alert form says
  // the same. The write would refuse the rule, so the card says so too.
  if (spec === null) return <Note>No preview available for this metric.</Note>;
  if (preview.isPending) return <Note>Loading…</Note>;
  if (preview.error) {
    return (
      <Note title={preview.error instanceof Error ? preview.error.message : undefined}>
        Couldn&apos;t load this preview
      </Note>
    );
  }
  if (!preview.data) return null;
  return (
    <AlertPreviewChart
      data={preview.data}
      thresholdValue={chart.threshold}
      operator={chart.operator}
      bucketMs={bucketMs}
    />
  );
}

export function AlertChartPreview({ chart }: { chart: AlertChart }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);

  // The query only runs once the card has been on screen, and stays mounted
  // afterwards — the same gate the widget card keeps, for the same reason.
  useEffect(() => {
    const frame = frameRef.current;
    if (seen || frame === null || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setSeen(true);
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, [seen]);

  return (
    <div
      ref={frameRef}
      className="min-w-0 overflow-hidden"
      style={{ aspectRatio: CHART_TILE_ASPECT }}
    >
      {seen && <Plot chart={chart} />}
    </div>
  );
}
