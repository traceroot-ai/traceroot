"use client";

import Link from "next/link";
import type { SignalSource } from "@traceroot/core/signals";
import { cn } from "@/lib/utils";
import { DOMAIN_ICONS } from "@/components/icons/domain-icons";
import { useLayout } from "@/components/layout/app-layout";
import { FoundInRuns } from "@/features/loops/components/found-in-runs";

/**
 * What a signal's hits are: the traces a detector found affected, or the example
 * traces a Loop's runs cited (never every trace that had the problem).
 */
export function hitNoun(source: SignalSource): "affected" | "example" {
  return source.kind === "detector" ? "affected" : "example";
}

/**
 * The Signals list's Detector name cell: the detector's name, the Loop that
 * recorded the signal (its hidden detector has no name to show), or that the
 * Loop was deleted.
 */
export function SignalSourceCell({
  projectId,
  source,
}: {
  projectId: string;
  source: SignalSource;
}) {
  switch (source.kind) {
    case "loop":
      return (
        <FoundByLoopLink
          projectId={projectId}
          loop={source}
          onClick={(e) => e.stopPropagation()}
          className="flex max-w-[12rem] items-center gap-1 hover:underline"
        />
      );
    case "deletedLoop":
      return <div className="max-w-[12rem] truncate text-muted-foreground">Deleted loop</div>;
    case "detector":
      return (
        <div className="max-w-[12rem] truncate" title={source.name ?? undefined}>
          {source.name ?? "—"}
        </div>
      );
  }
}

/**
 * The signal panel's provenance line: the Loop that recorded the signal and the
 * runs that found it, or that the Loop was deleted. A detector's signal has none.
 */
export function SignalSourceSummary({
  projectId,
  source,
  signalId,
}: {
  projectId: string;
  source: SignalSource;
  signalId: string;
}) {
  switch (source.kind) {
    case "loop":
      return (
        <div className="flex flex-wrap items-center gap-x-1.5 px-3 pb-2.5 text-[12px] text-muted-foreground">
          <FoundByLoopLink projectId={projectId} loop={source} />
          <FoundInRuns projectId={projectId} loop={source} signalId={signalId} />
        </div>
      );
    case "deletedLoop":
      return (
        <p className="px-3 pb-2.5 text-[12px] text-muted-foreground">Found by a deleted loop</p>
      );
    case "detector":
      return null;
  }
}

/**
 * "Found by loop <name>", linking to the Loop that recorded a signal; a long name truncates.
 * Where loops are switched off the Loop's page is not found, so the name is plain text.
 */
function FoundByLoopLink({
  projectId,
  loop,
  className,
  onClick,
}: {
  projectId: string;
  loop: { id: string; name: string };
  className?: string;
  onClick?: (e: React.MouseEvent) => void;
}) {
  const { loopsEnabled } = useLayout();
  const content = (
    <>
      <DOMAIN_ICONS.loop className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span className="min-w-0 truncate">Found by loop {loop.name}</span>
    </>
  );
  const title = `Found by loop ${loop.name}`;
  const classes = className ?? "inline-flex max-w-full items-center gap-1 hover:underline";
  if (!loopsEnabled) {
    return (
      <span title={title} className={cn(classes, "hover:no-underline")}>
        {content}
      </span>
    );
  }
  return (
    <Link
      href={`/projects/${projectId}/loops/${loop.id}`}
      onClick={onClick}
      title={title}
      className={classes}
    >
      {content}
    </Link>
  );
}
