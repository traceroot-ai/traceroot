import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface PageHeaderProps {
  title: string;
  /** One line on what the page is for; shown under the title. */
  description?: string;
  /** Primary actions (create buttons, counters), right aligned and wrapping on narrow screens. */
  actions?: ReactNode;
  className?: string;
}

/** The title row every project page starts with, so sections read as one product. */
export function PageHeader({ title, description, actions, className }: PageHeaderProps) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border px-4 py-2.5",
        className,
      )}
    >
      <div className="min-w-0">
        <h1 className="truncate text-sm font-medium">{title}</h1>
        {description && <p className="text-[12px] text-muted-foreground">{description}</p>}
      </div>
      {actions && (
        <div data-slot="actions" className="flex flex-wrap items-center gap-2">
          {actions}
        </div>
      )}
    </div>
  );
}
