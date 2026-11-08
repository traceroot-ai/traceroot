import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { PixelMark } from "@/components/ui/pixel-mark";

interface EmptyStateProps {
  title: string;
  description?: string;
  /** The next step, usually a create button. */
  action?: ReactNode;
  className?: string;
}

/** The one empty state: pixel mark, what is missing, why it matters, the next step. */
export function EmptyState({ title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex min-h-64 flex-col items-center justify-center gap-2 px-4 py-10 text-center",
        className,
      )}
    >
      <PixelMark size={6} className="mb-2" />
      <p className="text-[13px] font-medium text-foreground">{title}</p>
      {description && <p className="max-w-sm text-[12px] text-muted-foreground">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
