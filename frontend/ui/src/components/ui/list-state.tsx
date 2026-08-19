import * as React from "react";
import { cn } from "@/lib/utils";
import { LoadingState } from "@/components/ui/loading-state";

export interface ListStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}

/**
 * Centered empty/error block for list pages: icon, title, optional guidance and
 * optional CTA (retry / new-item / clear-search). Owns the h-64 state area so
 * every list renders the same shape.
 */
export function ListState({ icon, title, description, action, className }: ListStateProps) {
  return (
    <div
      className={cn("flex h-64 flex-col items-center justify-center gap-3 text-center", className)}
    >
      {icon}
      <p className="text-[13px] text-muted-foreground">{title}</p>
      {description && <p className="text-[12px] text-muted-foreground">{description}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
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
