"use client";

import { MoreVertical } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useWidgetData } from "../hooks/use-widget-data";
import { FIELD_UNIT, parseSpec, type TimeRange, type Widget } from "../types";
import { QueryWidgetRenderer } from "./renderers";
import { TraceFeedWidget } from "./TraceFeedWidget";

function QueryWidgetBody({
  projectId,
  widget,
  range,
}: {
  projectId: string;
  widget: Widget;
  range: TimeRange;
}) {
  const spec = parseSpec(widget.spec);

  // Hooks cannot be conditional — pass a placeholder spec when invalid, but
  // gate the query with enabled=false so no request is actually sent.
  const { data, isPending, error } = useWidgetData(
    projectId,
    widget.id,
    spec ?? {
      view: "spans",
      filters: [],
      metric: { measure: "count", agg: "count" },
      breakdown: null,
      display: { type: "number" },
    },
    range,
    spec !== null,
  );

  if (!spec) {
    return <div className="p-2 text-[12px] text-red-600">Invalid widget spec — edit to fix</div>;
  }
  // isPending (no data yet), not isLoading (pending AND fetching): while the
  // auth session is still resolving the query is disabled — not fetching — and
  // isLoading would fall through to a blank body on every dashboard load.
  if (isPending) {
    return <div className="p-2 text-[12px] text-muted-foreground">Loading…</div>;
  }
  if (error) {
    return (
      <div className="p-2 text-[12px] text-red-600">
        Query failed{error instanceof Error ? `: ${error.message}` : ""}
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

export function WidgetCard({
  projectId,
  widget,
  range,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  projectId: string;
  widget: Widget;
  range: TimeRange;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex h-full flex-col rounded-md border bg-background p-3">
      {/* Header: drag handle + title + menu */}
      <div className="mb-2 flex items-center gap-1.5">
        <span className="drag-handle cursor-move select-none text-muted-foreground/50">⠿</span>
        <span className="flex-1 truncate text-[12px] font-medium" title={widget.title}>
          {widget.title}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className="shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:bg-muted focus:opacity-100 group-hover:opacity-100"
              aria-label="Widget options"
            >
              <MoreVertical className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {widget.type === "query" && <DropdownMenuItem onSelect={onEdit}>Edit</DropdownMenuItem>}
            <DropdownMenuItem onSelect={onDuplicate}>Duplicate</DropdownMenuItem>
            <DropdownMenuItem onSelect={onDelete} className="text-red-600 focus:text-red-600">
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1">
        {widget.type === "query" && (
          <QueryWidgetBody projectId={projectId} widget={widget} range={range} />
        )}
        {widget.type === "trace_feed" && (
          <TraceFeedWidget
            projectId={projectId}
            spec={widget.spec as { limit?: number }}
            range={range}
          />
        )}
      </div>
    </div>
  );
}
