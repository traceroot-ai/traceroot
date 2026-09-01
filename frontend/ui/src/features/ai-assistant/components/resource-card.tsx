"use client";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DashboardMiniature } from "./dashboard-miniature";
import { WidgetChartPreview } from "./widget-chart-preview";
import type { ResourceCardBody, ResourceCardModel } from "../lib/resource-card";

/**
 * The receipt for a resource the agent just created, shown in the transcript
 * where the plain tool line would otherwise be.
 *
 * It is a receipt, not a prompt: nothing here is actionable — no status badge
 * waiting on the user, no buttons. The panel is also the narrowest surface in
 * the app, so every string wraps and nothing is allowed to set the card's
 * width.
 */

function Chips({ chips }: { chips: string[] }) {
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {chips.map((chip) => (
        // Badges are single-line by default; a spec value can be long enough
        // to need two, and wrapping beats widening the panel.
        <Badge key={chip} variant="outline" className="whitespace-normal [overflow-wrap:anywhere]">
          {chip}
        </Badge>
      ))}
    </div>
  );
}

function CardBody({ body, resourceId }: { body: ResourceCardBody; resourceId: string }) {
  switch (body.kind) {
    case "widget":
      // The widget itself, under the chips that name its spec. A widget with
      // no chart to draw — a trace feed, or a spec the schema rejects — is the
      // chips alone, as before.
      return (
        <div className="space-y-1.5">
          <Chips chips={body.chips} />
          {body.chart !== null && (
            <WidgetChartPreview
              projectId={body.chart.projectId}
              widgetId={resourceId}
              spec={body.chart.spec}
            />
          )}
        </div>
      );
    case "detector":
      return <Chips chips={body.chips} />;
    case "receipt":
      if (body.rows.length === 0) return null;
      return (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-[11px]">
          {body.rows.map((row) => (
            <div key={row.label} className="contents">
              <dt className="text-muted-foreground/70">{row.label}</dt>
              <dd className="min-w-0 break-words font-mono text-[10px] text-foreground/70 [overflow-wrap:anywhere]">
                {row.value}
              </dd>
            </div>
          ))}
        </dl>
      );
    case "dashboard":
      // The dashboard itself, shrunk. When the transcript created no widgets
      // there is nothing to shrink, and the header-only card reads fine.
      if (body.tiles.length === 0) return null;
      return <DashboardMiniature tiles={body.tiles} />;
  }
}

export function ResourceCard({ model }: { model: ResourceCardModel }) {
  const body = <CardBody body={model.body} resourceId={model.resourceId} />;

  return (
    <Card className="max-w-full space-y-1.5 border-border/80 bg-muted/20 px-2.5 py-2">
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 break-words text-xs font-medium text-foreground [overflow-wrap:anywhere]">
          {model.title}
        </span>
        <Badge variant={model.created ? "success" : "default"} className="shrink-0">
          {model.created ? "Created" : "Reused"}
        </Badge>
      </div>
      <p className="break-words text-[11px] text-muted-foreground/70">{model.meta.join(" · ")}</p>
      {body}
    </Card>
  );
}
