"use client";

import Link from "next/link";
import { ArrowLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Page chrome.
 *
 * One heading, one plain sentence explaining the object, and at most one
 * primary action. The sentence is the point: every page names a concept
 * (Trace, Dataset, Evaluation run, Scorer) that a new reader has not met yet.
 */
export function EvalPageHeader({
  title,
  parent,
  purpose,
  backHref,
  backLabel,
  action,
}: {
  title: React.ReactNode;
  /** Parent section for a nested page: renders as a `Parent › title` breadcrumb
   *  bar (the parent is a link back to the list), matching the detectors detail. */
  parent?: { label: string; href: string };
  /** One plain sentence. Not marketing copy — a definition. */
  purpose?: React.ReactNode;
  backHref?: string;
  backLabel?: string;
  /** At most one primary action per page. */
  action?: React.ReactNode;
}) {
  return (
    <div className="shrink-0 border-b border-border px-4 py-3">
      {backHref && !parent && (
        <Link
          href={backHref}
          className="mb-1.5 inline-flex items-center gap-1 rounded text-[12px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          {backLabel ?? "Back"}
        </Link>
      )}
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {parent && (
              <>
                <Link
                  href={parent.href}
                  className="shrink-0 rounded text-[13px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {parent.label}
                </Link>
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
              </>
            )}
            <h1 className="min-w-0 text-[13px] font-medium">{title}</h1>
          </div>
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
