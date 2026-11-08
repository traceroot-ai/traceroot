import Link from "next/link";
import { TASK_GROUP_LABEL } from "@traceroot/core/task-groups";
import { cn } from "@/lib/utils";
import { Sparkline } from "./topics-sparkline";
import type { TaskGroupRow } from "../types";

const TH =
  "border-r border-border/50 px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground last:border-r-0";
const TD = "border-r border-border/50 px-3 py-1.5 text-[12px] last:border-r-0";

export function formatShare(share: number): string {
  if (share === 0) return "0%";
  const pct = share * 100;
  return pct < 1 ? "<1%" : `${Math.round(pct)}%`;
}

function perDay(row: TaskGroupRow, days: readonly string[]): number[] {
  const byDay = new Map(row.trend.map((p) => [p.day, p.count]));
  return days.map((d) => byDay.get(d) ?? 0);
}

/**
 * One row per group: name and description, sampled trace count, share (an estimate: only
 * sampled traces have a group), and the per-day trend. A row opens the group's traces.
 */
export function TopicsTable({
  rows,
  days,
  sampled,
  ungrouped,
  hrefFor,
}: {
  rows: readonly TaskGroupRow[];
  days: readonly string[];
  sampled: number;
  ungrouped: number;
  hrefFor: (groupId: string) => string;
}) {
  return (
    <table className="w-full">
      <thead className="sticky top-0 z-10 bg-background">
        <tr className="border-b border-border bg-muted/50">
          <th className={TH}>{TASK_GROUP_LABEL}</th>
          <th className={cn(TH, "w-[110px] text-right")}>Sampled traces</th>
          <th
            className={cn(TH, "w-[190px]")}
            title="An estimate: only a sample of traces is summarized and grouped"
          >
            Share (estimate)
          </th>
          <th className={cn(TH, "w-[130px]")}>Trend</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr
            key={row.groupId}
            className="border-b border-border/50 transition-colors hover:bg-muted/50"
          >
            <td className={cn(TD, "max-w-[520px]")}>
              <Link
                href={hrefFor(row.groupId)}
                className="block text-[13px] font-medium text-foreground hover:underline"
              >
                {row.name}
              </Link>
              {row.description && (
                <span className="block truncate text-muted-foreground" title={row.description}>
                  {row.description}
                </span>
              )}
            </td>
            <td className={cn(TD, "text-right tabular-nums")}>{row.count}</td>
            <td className={TD}>
              <div className="flex items-center gap-2">
                <div className="h-1.5 w-24 shrink-0 overflow-hidden rounded bg-muted">
                  <div
                    className="h-full bg-foreground/70"
                    style={{ width: `${Math.min(100, row.share * 100)}%` }}
                  />
                </div>
                <span className="tabular-nums text-muted-foreground">
                  ≈ {formatShare(row.share)}
                </span>
              </div>
            </td>
            <td className={TD}>
              <Sparkline values={perDay(row, days)} label={`${row.name}: traces per day`} />
            </td>
          </tr>
        ))}
        {ungrouped > 0 && (
          <tr className="border-b border-border/50 text-muted-foreground">
            <td className={TD}>No {TASK_GROUP_LABEL.toLowerCase()}</td>
            <td className={cn(TD, "text-right tabular-nums")}>{ungrouped}</td>
            <td className={TD}>
              <span className="tabular-nums">
                ≈ {formatShare(sampled > 0 ? ungrouped / sampled : 0)}
              </span>
            </td>
            <td className={TD} />
          </tr>
        )}
      </tbody>
    </table>
  );
}
