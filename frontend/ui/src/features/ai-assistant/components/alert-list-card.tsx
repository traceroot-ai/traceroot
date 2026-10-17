"use client";

import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { AlertSeverityBadge } from "@/features/alerts/components/alert-severity-badge";
import type { AlertListCardModel, AlertListRow } from "../lib/resource-card";

/**
 * A list_alerts read as a card: one row per alert — its name and its rule in
 * a line with its evaluation state, which open the alert, beside the alerts
 * page's own severity badge, which stays its own control (it opens a popover,
 * so it sits outside the link) — then a footer with what the read covered and
 * the project's alerts page. A plain tool line would make the user read the
 * model's prose for what a glance at the alerts table tells them.
 */

const ROW = "flex items-center gap-2 px-2.5 py-1.5";
const ROW_TEXT = "flex min-w-0 flex-1 flex-col gap-0.5";

function RowText({ row }: { row: AlertListRow }) {
  return (
    <>
      <span className="truncate text-xs font-medium text-foreground">{row.name}</span>
      <span className="truncate text-[11px] text-muted-foreground">
        {row.summary === null ? row.state : `${row.summary} · ${row.state}`}
      </span>
    </>
  );
}

function pluralAlerts(count: number): string {
  return count === 1 ? "1 alert" : `${count} alerts`;
}

export function AlertListCard({ model }: { model: AlertListCardModel }) {
  const shown = model.rows.length;
  const summary =
    shown < model.total ? `${pluralAlerts(model.total)} · showing ${shown}` : pluralAlerts(shown);
  return (
    <Card className="max-w-full overflow-hidden border-border bg-card">
      {model.rows.length === 0 ? (
        <p className="px-2.5 py-2 text-[11px] text-muted-foreground">No alerts in this project.</p>
      ) : (
        <ul className="divide-y divide-border/60">
          {model.rows.map((row) => (
            <li key={row.id} className={ROW}>
              {row.href === null ? (
                <div className={ROW_TEXT}>
                  <RowText row={row} />
                </div>
              ) : (
                <Link href={row.href} className={`${ROW_TEXT} rounded-sm hover:bg-accent/50`}>
                  <RowText row={row} />
                </Link>
              )}
              {row.badge !== null && <AlertSeverityBadge {...row.badge} />}
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-1.5 border-t border-border px-2.5 py-1">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
          {summary}
        </span>
        {model.capacity !== null && (
          <span className="shrink-0 text-[11px] text-muted-foreground/70">
            {model.capacity.used} of {model.capacity.max} used
          </span>
        )}
        {model.href !== null && (
          <TooltipProvider delayDuration={150}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Link
                  href={model.href}
                  aria-label="Open alerts"
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 hover:bg-accent hover:text-foreground"
                >
                  <ExternalLink className="h-3 w-3" />
                </Link>
              </TooltipTrigger>
              <TooltipContent side="top">Open alerts</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>
    </Card>
  );
}
