import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export function PageBackHeader({
  backHref,
  backLabel,
  title,
  actions,
}: {
  backHref: string;
  backLabel: string;
  title: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-3 border-b border-border px-4">
      <Link
        href={backHref}
        className="inline-flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        {backLabel}
      </Link>
      <h1 className="min-w-0 flex-1 truncate text-[15px] font-medium">{title}</h1>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
