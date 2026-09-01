"use client";

/**
 * The widget a card's receipt is for, drawn the way a dashboard draws it.
 *
 * Everything inside the frame is the dashboards feature's own code — the same
 * query hook against the same stateless spec endpoint, and the same renderer a
 * dashboard tile uses — so this preview shows what the widget will actually
 * look like rather than a second rendering that drifts from it. Only the frame
 * and the visibility gate belong to the panel.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { QueryWidgetRenderer } from "@/features/dashboards/components/renderers";
import { useWidgetData } from "@/features/dashboards/hooks/use-widget-data";
import { DEFAULT_RANGE_ID, makeRange } from "@/features/dashboards/range-presets";
import type { WidgetSpec } from "@/features/dashboards/types";
import { FIELD_UNIT } from "@/features/filters/filter-controls";

interface WidgetChartPreviewProps {
  projectId: string;
  /** The created widget's id: it keys the query, so the dashboard's own tile
   *  for this widget and this card share one cached result. */
  widgetId: string;
  spec: WidgetSpec;
}

function Plot({ projectId, widgetId, spec }: WidgetChartPreviewProps) {
  // The window is frozen at the moment the card first came into view: a
  // receipt for a past action should not quietly slide its own axis while the
  // transcript stays open.
  const range = useMemo(() => makeRange(DEFAULT_RANGE_ID), []);
  const { data, isPending, error } = useWidgetData(projectId, widgetId, spec, range);

  // isPending, not isLoading: while the auth session resolves the query is
  // disabled rather than fetching, and isLoading would leave the card blank.
  if (isPending) {
    return <div className="p-2 text-[11px] text-muted-foreground">Loading…</div>;
  }
  // A failed preview costs the user nothing — the widget itself was created —
  // so it says so in one line and leaves the transcript intact.
  if (error) {
    return (
      <div
        className="p-2 text-[11px] text-muted-foreground"
        title={error instanceof Error ? error.message : undefined}
      >
        Couldn&apos;t load this preview
      </div>
    );
  }
  if (!data) return null;
  return (
    <QueryWidgetRenderer
      display={spec.display.type}
      result={data}
      unit={FIELD_UNIT[spec.metric.measure]}
      seriesLabel={spec.metric.measure}
      agg={spec.metric.agg}
    />
  );
}

export function WidgetChartPreview(props: WidgetChartPreviewProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);

  // Every query here is a real scan, and cards pile up in a transcript the user
  // scrolls past — so the plot (and with it the query hook) only mounts once
  // the card has actually been on screen. It stays mounted afterwards: the
  // result is already cached, and remounting on every scroll would flicker.
  // Without an IntersectionObserver nothing is ever known to be visible, and
  // the frame stays empty rather than querying for every card blind.
  useEffect(() => {
    const frame = frameRef.current;
    if (seen || frame === null || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setSeen(true);
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, [seen]);

  // A fixed height, because the renderer sizes itself to its parent — on a
  // dashboard that parent is the tile; here it is this frame. Tall enough to
  // read a shape in the app's narrowest column, and reserved before the plot
  // arrives so the transcript doesn't jump as previews fill in.
  return (
    <div ref={frameRef} className="h-36 min-w-0">
      {seen && <Plot {...props} />}
    </div>
  );
}
