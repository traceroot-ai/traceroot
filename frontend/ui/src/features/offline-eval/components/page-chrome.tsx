"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Page chrome.
 *
 * One heading, one plain sentence explaining the object, and at most one
 * primary action. The sentence is the point: every page names a concept
 * (Trace, Dataset, Experiment, Scorer) that a new reader has not met yet.
 */
export function EvalPageHeader({
  title,
  purpose,
  backHref,
  backLabel,
  action,
}: {
  title: string;
  /** One plain sentence. Not marketing copy — a definition. */
  purpose?: string;
  backHref?: string;
  backLabel?: string;
  /** At most one primary action per page. */
  action?: React.ReactNode;
}) {
  return (
    <div className="shrink-0 border-b border-border px-4 py-3">
      {backHref && (
        <Link
          href={backHref}
          className="mb-1.5 inline-flex items-center gap-1 rounded text-[12px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          {backLabel ?? "Back"}
        </Link>
      )}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[13px] font-medium">{title}</h1>
          {purpose && (
            <p className="mt-0.5 max-w-[70ch] text-[12px] leading-relaxed text-muted-foreground">
              {purpose}
            </p>
          )}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
    </div>
  );
}

/**
 * Standing marker that none of this is real. The prototype shows finished
 * experiments that never ran; without this the screens are indistinguishable
 * from a working product.
 */
export function PrototypeNotice({ className }: { className?: string }) {
  return (
    <p
      className={cn(
        "shrink-0 border-b border-border bg-muted/20 px-4 py-1.5 text-[11px] text-muted-foreground",
        className,
      )}
    >
      Design prototype — all data is hardcoded. Nothing runs, saves, or leaves the browser.
    </p>
  );
}

/** Body wrapper: consistent padding and scroll behaviour for every page. */
export function EvalBody({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={cn("min-h-0 flex-1 overflow-auto", className)}>{children}</div>;
}

/**
 * The single, consistent place advanced information hides.
 * Native <details> so it is keyboard-accessible for free.
 */
export function DetailsSection({
  label = "Details",
  children,
  className,
}: {
  label?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <details className={cn("group", className)}>
      <summary className="inline-flex cursor-pointer list-none items-center rounded text-[12px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
        {label}
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}

/** Label/value row used inside Details areas. */
export function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-1">
      <dt className="text-[12px] text-muted-foreground">{label}</dt>
      <dd className="text-[12px] tabular-nums">{value}</dd>
    </div>
  );
}

/** Quiet secondary action — used for "View SDK example" style links. */
export function QuietAction({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded text-[12px] text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      {children}
    </button>
  );
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-12 text-center text-[12px] text-muted-foreground">{children}</div>;
}
