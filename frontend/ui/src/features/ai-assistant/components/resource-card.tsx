"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { ChevronRight, ExternalLink, Eye, EyeOff } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { CHART_TILE_ASPECT, DashboardMiniature } from "./dashboard-miniature";
import type { DetectorPrompt, ResourceCardBody, ResourceCardModel } from "../lib/resource-card";

// Loaded dynamically because the preview pulls in the dashboards renderers —
// and with them recharts — while this card sits in the assistant panel, which
// every page's layout mounts. A static import would drag the charting library
// into the shared layout chunk; the dynamic edge keeps it in its own chunk,
// fetched only when a widget card actually has a chart to draw. The loading
// placeholder mirrors the preview's aspect frame so the transcript doesn't
// jump when the module arrives.
const WidgetChartPreview = dynamic(
  () => import("./widget-chart-preview").then((mod) => mod.WidgetChartPreview),
  {
    ssr: false,
    loading: () => <div className="min-w-0" style={{ aspectRatio: CHART_TILE_ASPECT }} />,
  },
);

/**
 * The card for a resource the agent created (or, marked proposed, one it
 * wants to create), shown in the transcript where the plain tool line would
 * otherwise be.
 *
 * The card IS the bubble: the resource itself — a widget's chart, a
 * dashboard's miniature, a detector's prompt — comes first, and one footer row
 * names it. The footer's title opens a definition panel with what the card
 * would otherwise have to say up front (the spec chips, a description), so
 * the picture is never pushed down by its own caption. Nothing here decides
 * anything: a proposal's create/skip lives in the composer, not the card. The
 * panel is also the narrowest surface in the app, so the footer truncates and
 * the body wraps — nothing is allowed to set the card's width.
 */

function Chips({ chips }: { chips: string[] }) {
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {chips.map((chip, index) => (
        // Keyed by index: chips are model-supplied text and can repeat (two
        // identical trigger conditions), and the list never reorders.
        // Badges are single-line by default; a spec value can be long enough
        // to need two, and wrapping beats widening the panel.
        <Badge key={index} variant="outline" className="whitespace-normal [overflow-wrap:anywhere]">
          {chip}
        </Badge>
      ))}
    </div>
  );
}

/**
 * A custom prompt long enough to need the clamp. Measured on the text rather
 * than the layout — a line-count/length heuristic agrees closely enough with
 * the rendered height for a "Show more" affordance, and it works before paint.
 */
const PROMPT_CLAMP_LINES = 6;
const PROMPT_CLAMP_CHARS = 400;

function promptNeedsClamp(text: string): boolean {
  return text.split("\n").length > PROMPT_CLAMP_LINES || text.length > PROMPT_CLAMP_CHARS;
}

/**
 * The prompt is what a detector IS, so the card shows it: the call's own
 * instructions in a monospace block — clamped to a few lines behind a
 * Show more toggle when long — or one line naming the standard template
 * prompt the call adopted by omitting its own.
 */
function DetectorPromptBlock({ prompt }: { prompt: DetectorPrompt }) {
  const [expanded, setExpanded] = useState(false);
  if (prompt.kind === "standard") {
    return (
      <p className="text-[11px] text-muted-foreground">
        Uses the standard {prompt.templateLabel} prompt
      </p>
    );
  }
  const clampable = promptNeedsClamp(prompt.text);
  const promptClasses = [
    "whitespace-pre-wrap break-words rounded-sm bg-muted/40 px-1.5 py-1 font-mono text-[10px] leading-relaxed text-foreground/80 [overflow-wrap:anywhere]",
    clampable && !expanded ? "line-clamp-6" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="space-y-0.5">
      <pre className={promptClasses}>{prompt.text}</pre>
      {clampable && (
        <button
          type="button"
          className="text-[10px] font-medium text-muted-foreground underline-offset-2 hover:underline"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

/**
 * The body: the resource itself, or null when there is nothing to picture —
 * a widget with no chart to draw, a detector with no prompt to show, a
 * dashboard with no tiles, an empty receipt. The chips that describe a
 * widget or detector are not body; they live in the definition panel.
 */
function cardBody(body: ResourceCardBody, resourceId: string): ReactNode | null {
  switch (body.kind) {
    case "widget":
      if (body.chart === null) return null;
      return (
        <WidgetChartPreview
          projectId={body.chart.projectId}
          widgetId={resourceId}
          spec={body.chart.spec}
          rangeId={body.chart.range.id}
        />
      );
    case "detector":
      return body.prompt === null ? null : <DetectorPromptBlock prompt={body.prompt} />;
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
      // With no tiles — the transcript created no widgets, or the dashboard
      // was reused and its placements are unknowable — there is nothing to
      // shrink, and the card stands on its footer (plus the description a
      // reused one carries, in the definition panel).
      return body.tiles.length === 0 ? null : <DashboardMiniature tiles={body.tiles} />;
  }
}

/** True when the body is a picture the footer can hide: a chart or a miniature. */
function hasPreview(body: ResourceCardBody): boolean {
  return (
    (body.kind === "widget" && body.chart !== null) ||
    (body.kind === "dashboard" && body.tiles.length > 0)
  );
}

/** The chips a widget or detector is defined by; a receipt or dashboard has none. */
function definitionChips(body: ResourceCardBody): string[] {
  return body.kind === "widget" || body.kind === "detector" ? body.chips : [];
}

const iconActionClasses =
  "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 hover:bg-accent hover:text-foreground";

export function ResourceCard({
  model,
  proposed = false,
}: {
  model: ResourceCardModel;
  /** True on the card of a write the agent has proposed but not run: the
   *  footer meta says so, since the card is otherwise the receipt's twin. */
  proposed?: boolean;
}) {
  const [definitionOpen, setDefinitionOpen] = useState(false);
  const [previewHidden, setPreviewHidden] = useState(false);

  const body = cardBody(model.body, model.resourceId);
  const previewable = hasPreview(model.body);
  const bodyShown = body !== null && !(previewable && previewHidden);

  const chips = definitionChips(model.body);
  const hasDefinition = chips.length > 0 || model.description !== undefined;

  const meta = (proposed ? ["Proposed", ...model.meta] : model.meta).join(" · ");
  const previewLabel = previewHidden ? "Show preview" : "Hide preview";

  return (
    <Card className="max-w-full overflow-hidden border-border bg-card">
      {bodyShown && <div className="px-2.5 py-2">{body}</div>}

      <div
        className={cn(
          "flex items-center gap-1.5 px-2.5 py-1",
          bodyShown && "border-t border-border",
        )}
      >
        {hasDefinition ? (
          <button
            type="button"
            aria-expanded={definitionOpen}
            onClick={() => setDefinitionOpen((open) => !open)}
            className="flex min-w-0 flex-1 items-center gap-1 text-left text-xs font-medium text-foreground hover:text-foreground/80"
          >
            <ChevronRight
              className={cn(
                "h-3 w-3 shrink-0 text-muted-foreground/60 transition-transform duration-200",
                definitionOpen && "rotate-90",
              )}
            />
            <span className="truncate">{model.title}</span>
          </button>
        ) : (
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
            {model.title}
          </span>
        )}
        {/* A fresh create needs no badge — the card itself is the receipt. A
            reused row is the one surprising outcome, so only that gets labeled. */}
        {!model.created && (
          <Badge variant="default" className="shrink-0">
            Reused
          </Badge>
        )}
        <span className="min-w-0 max-w-[45%] truncate text-[11px] text-muted-foreground/70">
          {meta}
        </span>
        {(model.href !== null || previewable) && (
          <TooltipProvider delayDuration={150}>
            <div className="flex shrink-0 items-center">
              {model.href !== null && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Link
                      href={model.href}
                      aria-label={`Open ${model.resourceType}`}
                      className={iconActionClasses}
                    >
                      <ExternalLink className="h-3 w-3" />
                    </Link>
                  </TooltipTrigger>
                  <TooltipContent side="top">Open</TooltipContent>
                </Tooltip>
              )}
              {previewable && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={previewLabel}
                      className={cn(iconActionClasses, "p-0")}
                      onClick={() => setPreviewHidden((hidden) => !hidden)}
                    >
                      {previewHidden ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top">{previewLabel}</TooltipContent>
                </Tooltip>
              )}
            </div>
          </TooltipProvider>
        )}
      </div>

      {hasDefinition && definitionOpen && (
        <div className="space-y-1.5 border-t border-border px-2.5 py-2">
          {model.description !== undefined && (
            <p className="break-words text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
              {model.description}
            </p>
          )}
          <Chips chips={chips} />
        </div>
      )}
    </Card>
  );
}
