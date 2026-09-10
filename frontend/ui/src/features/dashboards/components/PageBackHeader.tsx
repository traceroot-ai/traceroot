import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export function PageBackHeader({
  backHref,
  backLabel,
  title,
}: {
  backHref: string;
  backLabel: string;
  title: string;
}) {
  return (
    <div className="flex items-center gap-3 border-b border-border px-4 py-3">
      <Link
        href={backHref}
        className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        {backLabel}
      </Link>
      <h1 className="text-[13px] font-medium">{title}</h1>
    </div>
  );
}
