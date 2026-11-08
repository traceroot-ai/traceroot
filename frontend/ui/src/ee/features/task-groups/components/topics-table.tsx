import Link from "next/link";
import { TASK_GROUP_LABEL } from "@traceroot/core/task-groups";
import { cn } from "@/lib/utils";
import { Sparkline } from "./topics-sparkline";
import { topicColor } from "./topic-colors";
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
    <div className="overflow-x-auto">
      <p className="border-b border-border px-4 py-2 text-[11px] text-muted-foreground">
        Counts and shares come from a sample of up to 300 traces a day, not from every trace.
      </p>
      <table className="w-full min-w-[320px]">
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
            <th className={cn(TH, "hidden w-[130px] md:table-cell")}>Trend</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rank) => (
            <tr
              key={row.groupId}
              className="border-b border-border/50 transition-colors hover:bg-muted/50"
            >
              <td className={cn(TD, "max-w-[520px]")}>
                <Link
                  href={hrefFor(row.groupId)}
                  className="-mx-1 inline-block rounded-sm px-1 text-[13px] font-medium text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span
                    className="mr-2 inline-block h-2 w-2 rounded-sm ring-1 ring-inset ring-black/10 dark:ring-white/10"
                    style={{ background: topicColor(rank) }}
                    aria-hidden
                  />
                  {row.name}
                </Link>
                {row.description && (
                  <span
                    className="hidden text-muted-foreground sm:line-clamp-2"
                    title={row.description}
                  >
                    {row.description}
                  </span>
                )}
              </td>
              <td className={cn(TD, "text-right tabular-nums")}>{row.count}</td>
              <td className={TD}>
                <div className="flex items-center gap-2">
                  <div className="h-1.5 w-20 shrink-0 overflow-hidden rounded bg-muted">
                    <div
                      className="h-full bg-foreground/70"
                      style={{ width: `${Math.min(100, row.share * 100)}%` }}
                    />
                  </div>
                  <span className="whitespace-nowrap tabular-nums text-muted-foreground">
                    ≈ {formatShare(row.share)}
                  </span>
                </div>
              </td>
              <td className={TD}>
                <Sparkline
                  values={perDay(row, days)}
                  label={`${row.name}: traces per day, ${perDay(row, days).join(", ")}`}
                />
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
              <td className={cn(TD, "hidden md:table-cell")} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
