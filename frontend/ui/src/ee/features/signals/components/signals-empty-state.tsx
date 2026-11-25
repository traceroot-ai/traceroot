"use client";

import Link from "next/link";
import { DOMAIN_ICONS } from "@/components/icons/domain-icons";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { SignalSetup } from "../hooks";
import { useT } from "@/lib/i18n/provider";

/**
 * What the Signals page shows for a project with no signals at all: the next
 * step its detectors need before a signal can appear.
 */
export function SignalsEmptyState({ projectId, setup }: { projectId: string; setup: SignalSetup }) {
  const t = useT();
  const needsDetector = setup.detectorCount === 0;
  const needsSignals = !needsDetector && setup.signalDetectorCount === 0;
  const needsSampling = setup.signalDetectorCount > 0 && setup.sampledSignalDetectorCount === 0;
  const needsAction = needsDetector || needsSignals || needsSampling;

  const title = needsSignals
    ? t("eeSignalsEmpty.enableTitle")
    : needsSampling
      ? t("eeSignalsEmpty.finishTitle")
      : t("eeSignalsEmpty.emptyTitle");
  const description = needsDetector
    ? t("eeSignalsEmpty.needsDetector")
    : needsSignals
      ? t("eeSignalsEmpty.needsSignals")
      : needsSampling
        ? t("eeSignalsEmpty.needsSampling")
        : setup.grouping
          ? t("eeSignalsEmpty.enabled")
          : t("eeSignalsEmpty.noKey");

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
          ? t("eeSignalsEmpty.createDetector")
          : needsSignals || needsSampling
            ? t("eeSignalsEmpty.configureDetectors")
            : t("eeSignalsEmpty.viewDetectors")}
      </Link>
    </div>
  );
}
