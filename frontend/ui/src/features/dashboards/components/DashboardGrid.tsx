"use client";

import { useEffect, useMemo, useRef } from "react";
import { GridLayout } from "react-grid-layout";
import type { Layout, LayoutItem as RGLLayoutItem } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import type { LayoutItem, TimeRange, Widget } from "../types";
import { WidgetCard } from "./WidgetCard";

const COLS = 12;
const ROW_HEIGHT = 56;
// Floor for widget resizing: below 2x2 grid units a tile's title and body get
// clipped into illegibility, so react-grid-layout refuses to shrink past it.
const MIN_W = 2;
const MIN_H = 2;

export function DashboardGrid({
  projectId,
  widgets,
  layout,
  range,
  width,
  onLayoutChange,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  projectId: string;
  widgets: Widget[];
  layout: LayoutItem[];
  range: TimeRange;
  width: number;
  onLayoutChange: (layout: LayoutItem[]) => void;
  onEdit: (w: Widget) => void;
  onDuplicate: (w: Widget) => void;
  onDelete: (w: Widget) => void;
}) {
  // Widgets missing from layout (e.g. just created) get appended at the bottom.
  // Stale layout entries for deleted widgets are tolerated: fullLayout maps
  // from widgets, so extras in the stored layout are simply ignored.
  const fullLayout: RGLLayoutItem[] = useMemo(() => {
    const known = new Map(layout.map((l) => [l.i, l]));
    let maxY = Math.max(0, ...layout.map((l) => l.y + l.h));
    return widgets.map((w) => {
      const item = known.get(w.id);
      if (item) return { ...item, minW: MIN_W, minH: MIN_H };
      const fresh: RGLLayoutItem = { i: w.id, x: 0, y: maxY, w: 4, h: 4, minW: MIN_W, minH: MIN_H };
      maxY += 4;
      return fresh;
    });
  }, [widgets, layout]);

  // Snapshot of the last layout sent upstream, used to skip no-op PATCH calls.
  // react-grid-layout fires onLayoutChange on mount with the initial layout, so
  // we lazy-init lastSentRef on the first handleChange call to the incoming
  // layout's JSON — that way the mount-fire only triggers an upstream call if
  // the layout genuinely differs (e.g. real compaction), not unconditionally.
  const lastSentRef = useRef<string | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Holds the most-recently-computed mapped layout so the unmount cleanup can
  // flush it synchronously if a debounce timer is still pending.
  const pendingMappedRef = useRef<LayoutItem[] | null>(null);

  // On unmount: if a debounce is still pending, cancel the timer and flush the
  // pending layout change synchronously so the last drag is never silently lost.
  useEffect(
    () => () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
        if (pendingMappedRef.current) {
          onLayoutChange(pendingMappedRef.current);
        }
      }
    },
    [],
  );

  const handleChange = (next: Layout) => {
    const mapped: LayoutItem[] = next.map(({ i, x, y, w, h }) => ({ i, x, y, w, h }));

    // Lazy-init: on the first call (mount-fire from react-grid-layout) treat the
    // incoming layout as already-sent so we don't PATCH unless it truly changed.
    if (lastSentRef.current === null) {
      lastSentRef.current = JSON.stringify(mapped);
    }

    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    pendingMappedRef.current = mapped;
    debounceTimer.current = setTimeout(() => {
      const json = JSON.stringify(mapped);
      if (json === lastSentRef.current) return;
      lastSentRef.current = json;
      pendingMappedRef.current = null;
      onLayoutChange(mapped);
    }, 600);
  };

  return (
    <GridLayout
      className="layout"
      layout={fullLayout}
      gridConfig={{ cols: COLS, rowHeight: ROW_HEIGHT }}
      dragConfig={{ handle: ".drag-handle" }}
      width={width}
      onLayoutChange={handleChange}
    >
      {widgets.map((w) => (
        <div key={w.id} className="group">
          <WidgetCard
            projectId={projectId}
            widget={w}
            range={range}
            onEdit={() => onEdit(w)}
            onDuplicate={() => onDuplicate(w)}
            onDelete={() => onDelete(w)}
          />
        </div>
      ))}
    </GridLayout>
  );
}
