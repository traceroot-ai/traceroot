"use client";

import Link from "next/link";
import { ArrowLeft, FlaskConical } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

/**
 * Page header matching the existing product pages: a 13px title in a
 * border-b strip with actions on the right (see detectors/page.tsx).
 */
export function EvalPageHeader({
  title,
  description,
  backHref,
  backLabel,
  actions,
  meta,
}: {
  title: string;
  description?: string;
  backHref?: string;
  backLabel?: string;
  actions?: React.ReactNode;
  meta?: React.ReactNode;
}) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-2">
      <div className="flex min-w-0 items-center gap-2">
        {backHref && (
          <Link
            href={backHref}
            className="flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-[12px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
            {backLabel ?? "Back"}
          </Link>
        )}
        <div className="flex min-w-0 flex-col">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-[13px] font-medium">{title}</h1>
            {meta}
          </div>
          {description && (
            <p className="truncate text-[11px] text-muted-foreground">{description}</p>
          )}
        </div>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
    </div>
  );
}

/**
 * Marks the whole area as a non-functional draft. This prototype shows
 * completed experiments and passing gates that never ran; without a standing
 * marker the screens are indistinguishable from a working product.
 */
export function PrototypeNotice({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 border-b border-border bg-muted/20 px-4 py-1",
        className,
      )}
    >
      <FlaskConical className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
      <p className="text-[11px] text-muted-foreground">
        Design prototype — all data is hardcoded. Actions update this page only: nothing runs,
        persists, or leaves the browser.
      </p>
    </div>
  );
}

/** Section wrapper for the overview's stacked panels. */
export function EvalSection({
  title,
  description,
  action,
  children,
  className,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-md border border-border", className)}>
      <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
        <div className="min-w-0">
          <h2 className="text-[12px] font-medium">{title}</h2>
          {description && <p className="mt-0.5 text-[11px] text-muted-foreground">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Count tile for the overview. */
export function StatTile({
  label,
  value,
  hint,
  href,
  tone = "default",
}: {
  label: string;
  value: string | number;
  hint?: string;
  href?: string;
  tone?: "default" | "warning";
}) {
  const body = (
    <>
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p
        className={cn(
          "mt-0.5 text-[20px] font-semibold tabular-nums leading-none",
          tone === "warning" && "text-amber-600 dark:text-amber-400",
        )}
      >
        {value}
      </p>
      {hint && <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{hint}</p>}
    </>
  );

  const base = "flex flex-col rounded-md border border-border bg-background p-3";

  if (!href) return <div className={base}>{body}</div>;

  return (
    <Link
      href={href}
      className={cn(
        base,
        "transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
      )}
    >
      {body}
    </Link>
  );
}

/** Draft/experimental marker for surfaces that are not claimed to work. */
export function ExperimentalNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded border border-amber-300 bg-amber-50 px-2.5 py-2 dark:border-amber-900 dark:bg-amber-950/30">
      <div className="mb-1 flex items-center gap-1.5">
        <Badge variant="warning">Experimental</Badge>
      </div>
      <p className="text-[11px] leading-snug text-amber-900 dark:text-amber-200">{children}</p>
    </div>
  );
}
