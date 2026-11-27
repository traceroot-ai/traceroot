import type { ReactNode } from "react";

interface PageHeaderProps {
  title: string;
  /** Primary actions (create buttons, counters), right aligned. */
  actions?: ReactNode;
}

/** The one title row every project page starts with, so sections read as one product. */
export function PageHeader({ title, actions }: PageHeaderProps) {
  return (
    <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-border px-4">
      <h1 className="truncate text-[15px] font-medium">{title}</h1>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
