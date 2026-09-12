import * as React from "react";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";

export interface ListStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  /**
   * "error" reds the headline and announces the block through an alert live
   * region. Loading already announces via LoadingState's role="status"; without
   * this a failed list would announce to nothing and read as an ordinary empty
   * state.
   */
  tone?: "muted" | "error";
  className?: string;
}

/**
 * Centered empty/error block for list pages: icon, title, optional guidance and
 * optional CTA (retry / new-item / clear-search). Owns the h-64 state area so
 * every list renders the same shape.
 */
export function ListState({
  icon,
  title,
  description,
  action,
  tone = "muted",
  className,
}: ListStateProps) {
  const isError = tone === "error";
  return (
    <div
      role={isError ? "alert" : undefined}
      className={cn("flex h-64 flex-col items-center justify-center gap-3 text-center", className)}
    >
      {icon}
      <p className={cn("text-[13px]", isError ? "text-destructive" : "text-muted-foreground")}>
        {title}
      </p>
      {description && <p className="text-[12px] text-muted-foreground">{description}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

/** Guidance shown when a list fetch fails on an API-key-authenticated page. */
export const LIST_ERROR_API_HINT =
  "Make sure the API server is running and you have API keys configured.";

/**
 * The failed-fetch state every list shares: warning glyph, red headline and a
 * retry. Kept as a preset so the six lists cannot drift apart again on the
 * icon, the tone or the retry affordance.
 *
 * Gate it on `error && rows.length === 0`, the trigger every list uses: a
 * background refetch that fails while rows are already on screen should leave
 * those rows alone rather than replacing good data with an error.
 */
export function ListError({
  title,
  description = LIST_ERROR_API_HINT,
  onRetry,
}: {
  title: string;
  description?: React.ReactNode;
  onRetry: () => void;
}) {
  return (
    <ListState
      tone="error"
      icon={<AlertTriangle className="h-8 w-8 text-destructive/50" />}
      title={title}
      description={description}
      action={
        <Button variant="outline" size="sm" className="h-7 text-[12px]" onClick={onRetry}>
          Try again
        </Button>
      }
    />
  );
}

/** Centered spinner + label filling the same h-64 state area. */
export function ListLoading({ label }: { label: string }) {
  return (
    <div className="flex h-64 items-center justify-center">
      <LoadingState label={label} />
    </div>
  );
}

/** A full-width table row wrapping a list state (loading / empty / error). */
export function TableStateRow({
  colSpan,
  className,
  children,
}: {
  colSpan: number;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <tr>
      <td colSpan={colSpan} className={cn("px-3", className)}>
        {children}
      </td>
    </tr>
  );
}
