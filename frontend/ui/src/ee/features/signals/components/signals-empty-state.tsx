"use client";

import Link from "next/link";
import { DOMAIN_ICONS } from "@/components/icons/domain-icons";
import { buttonVariants } from "@/components/ui/button";
import { useLayout } from "@/components/layout/app-layout";
import { cn } from "@/lib/utils";
import type { SignalSetup } from "../hooks";

/**
 * What the Signals page shows for a project with no signals at all: the next
 * step its detectors need before a signal can appear.
 */
export function SignalsEmptyState({ projectId, setup }: { projectId: string; setup: SignalSetup }) {
  const { loopsEnabled } = useLayout();
  const needsDetector = setup.detectorCount === 0;
  const needsSignals = !needsDetector && setup.signalDetectorCount === 0;
  const needsSampling = setup.signalDetectorCount > 0 && setup.sampledSignalDetectorCount === 0;
  const needsAction = needsDetector || needsSignals || needsSampling;

  const title = needsSignals
    ? "Enable signal generation"
    : needsSampling
      ? "Finish detector setup"
      : "No signals yet";
  const description = needsDetector
    ? "Signals cluster related judge outputs into issues you can investigate to improve agent performance. Create a detector and turn on Generate signals in its Signals section."
    : needsSignals
      ? "Turn on Generate signals in a detector’s Signals section to group related findings into issues."
      : needsSampling
        ? "Signal generation is enabled. Make sure the detector is on and its sampling is above 0% so it can evaluate incoming traces."
        : setup.grouping
          ? "Signal generation is enabled. Signals appear here when a detector groups related findings from your traces."
          : "Signal generation is enabled, but this deployment has no OpenAI API key, which grouping needs.";

  return (
    <div className="flex min-h-64 flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      <DOMAIN_ICONS.signal className="h-8 w-8 text-muted-foreground/40" aria-hidden="true" />
      <h2 className="text-[13px] font-medium">{title}</h2>
      <p className="max-w-md text-[12px] leading-5 text-muted-foreground">{description}</p>
      <Link
        href={`/projects/${projectId}/detectors${needsDetector ? "/new" : ""}`}
        className={cn(
          buttonVariants({ variant: needsAction ? "default" : "outline", size: "sm" }),
          "mt-1 h-7 text-[12px]",
        )}
      >
        {needsDetector
          ? "Create detector"
          : needsSignals || needsSampling
            ? "Configure detectors"
            : "View detectors"}
      </Link>
      {loopsEnabled && (
        <Link
          href={`/projects/${projectId}/loops`}
          className="text-[12px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          Or start a loop
        </Link>
      )}
    </div>
  );
}
